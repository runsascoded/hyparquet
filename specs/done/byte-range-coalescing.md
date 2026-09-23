# Spec: format-agnostic byte-range coalescing across row groups

Status: **done** (2026-09-23), on top of upstream 1.31.1. Author: pyrmts session (`$c/pyrmts`, `js/packages/pyrmts/src/walkdiff.ts`); originating workload: the index-free diff walk over cw's 10M-row path-index parquets on R2.

## Problem

`parquetPlan` decides which byte ranges to fetch for a read. Today it coalesces only **within one row group**: the `run` accumulator is declared inside the per-row-group loop, so adjacent column chunks of one group merge (up to `runLimit` = 2 MB when no `columns` projection is set, or up to `columnChunkAggregation` bytes when it is), but the last chunk of group *i* and the first chunk of group *i+1* never merge, even when they are byte-adjacent (they always are: parquet lays row groups out back to back).

For a caller that reads a contiguous run of row groups with a column projection this costs at least one GET per row group. Measured on the walk: a fleet-root diff view reads 94 row groups of 8,192 rows (~280 KB each, 11 columns, 4 projected) in 48 contiguous runs. With cross-group coalescing that is 48 GETs; with today's planner it is ≥ 94 (all columns) or ≥ 376 (4 projected columns, no aggregation). The walk currently works around it by fetching each run's whole byte span itself and handing hyparquet a memory-backed `AsyncBuffer` — logic that belongs in the planner.

## Proposal

Replace the per-group `run` with a single pass over **all** planned ranges (every selected column chunk of every selected row group, in file order), merging neighbours under a caller-configurable **over-fetch budget** that is agnostic to what the ranges are:

- Sort candidate ranges by `startByte`.
- Greedy left to right: extend the current run to include the next range iff, after extension, `untargeted / total ≤ maxOverfetchRatio` **and** `total ≤ maxRunBytes`, where `targeted` is the sum of the wanted ranges inside the run, `total = run.endByte − run.startByte`, `untargeted = total − targeted`. Otherwise start a new run.
- Byte-adjacent ranges (gap 0) always merge (ratio unchanged), subject only to `maxRunBytes`.

Defaults that reproduce today's behaviour: `maxOverfetchRatio = 0` when `columns` is set (no gap tolerated, but adjacent chunks *do* merge now — including across groups), `maxRunBytes = runLimit` (2 MB) otherwise. Callers on high-latency stores raise the ratio (the walk wants ~`0.7`: 4 of 11 columns targeted, one GET per run) and the run cap (`Infinity` for a bounded run of groups it already decided to read).

Options (all per call, on `parquetRead` / `parquetReadObjects` / `parquetPlan`):

```ts
/** Max share of a fetched run that may be bytes no selected chunk needs (0..1). */
maxOverfetchRatio?: number
/** Max bytes per coalesced fetch (bounds memory). */
maxRunBytes?: number
```

`columnChunkAggregation` (the fork's earlier opt-in, a per-row-group byte threshold on a run) is **removed**, not aliased: `{ maxRunBytes: N, maxOverfetchRatio: 1 }` expresses it exactly, and additionally lets runs span row groups. ctbk's `gbfs/api` passes it in three `parquetReadObjects` calls (pinned to fork dist `0f355ea`); it ports to the new options on its next dist-SHA bump. An unported call is silently ignored (reverting to one GET per chunk), so the port is required, not optional.

Index ranges (offset/column index blocks, bloom filters) go through the same merge — they sit just before the footer and are often adjacent to each other.

## As built

- `coalesceByteRanges(ranges, { maxOverfetchRatio = 0, maxRunBytes = Infinity })` in `src/plan.js`, exported. It generalizes upstream's existing coalescer for page-index fetches (whose behavior is these defaults: merge only overlapping or touching ranges). Covered bytes are counted as the union of input ranges, so overlapping ranges are not double-counted. Overlapping ranges always merge, even past `maxRunBytes`: splitting them would fetch the shared bytes twice.
- `parquetPlanGroup` now returns raw chunk ranges; `parquetPlan` runs one pass over every group's chunk ranges plus index ranges. Re-coalescing already-merged per-group runs would count their gap bytes as wanted and understate the ratio.
- Resolved defaults (`coalesceBudget`): `maxOverfetchRatio = columns ? 0 : 1`, `maxRunBytes = 2 MB` in both cases. Ratio 1 without a projection matches the old span-limited behavior; with a projection the spec left `maxRunBytes` open, and 2 MB keeps single GETs bounded (the walk passes `Infinity`).
- Behavior changes vs. upstream: all-column reads merge adjacent row groups (up to 2 MB); projected reads merge byte-adjacent selected chunks, within and across groups (same bytes, fewer GETs). Two upstream tests encoded the old boundaries and were updated; a failure-injection helper now fails any slice overlapping the target chunk rather than only an exact-match slice.

## Non-goals

- Page-level pruning via the ColumnIndex (separate spec; would feed *narrower* ranges into this same coalescer).
- Changing what is decoded: coalescing only changes the fetch plan; `readColumn` still decodes exactly the selected chunks from the fetched run.

## Acceptance

- Unit tests on `parquetPlan` (`test/plan.test.js`, `offset_indexed.parquet`): (a) two adjacent row groups, all columns → one fetch; (b) with `columns` and ratio 0 → adjacent selected chunks merge across the group boundary, unselected gaps split; ratio 0.95 bridges the gap, 0.94 does not (0.943 untargeted); (d) `maxRunBytes` splits a run, and `0` gives one fetch per chunk. (e) dropped with `columnChunkAggregation`.
- (c) as literal-range tests on `coalesceByteRanges` over the walk's shape (3 groups × 11 columns × 25 KB, 4 selected): ratio 0.7 → one 800 KB fetch; ratio 0.6 → split before rg1's last column; `maxRunBytes` = one group → one fetch per group. Plus overlap and union-accounting cases.
- End to end (`test/read.test.js`): `parquetReadObjects({ columns: ['id'] })` takes 2 GETs / 870 B by default and 1 GET / 15,204 B at `maxOverfetchRatio: 0.95`, confirming the options thread through `prepareParquetRead`.
- The walk (`pyrmts` `SnapshotReader.readRun`) can drop its memory-backed `AsyncBuffer` and call `parquetReadObjects({ columns, maxOverfetchRatio: 0.7, maxRunBytes: Infinity })` with the same 48 GETs for the fleet-root view.
