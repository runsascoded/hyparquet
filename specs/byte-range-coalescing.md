# Spec: format-agnostic byte-range coalescing across row groups

Status: **open** (2026-09-23). Author: pyrmts session (`$c/pyrmts`, `js/packages/pyrmts/src/walkdiff.ts`); originating workload: the index-free diff walk over cw's 10M-row path-index parquets on R2.

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

`columnChunkAggregation` (the fork's existing opt-in, a byte threshold on a run) keeps working: treat it as `maxRunBytes` with `maxOverfetchRatio = 1` for back-compat, and document it as superseded.

Index ranges (offset/column index blocks, bloom filters) go through the same merge — they sit just before the footer and are often adjacent to each other.

## Non-goals

- Page-level pruning via the ColumnIndex (separate spec; would feed *narrower* ranges into this same coalescer).
- Changing what is decoded: coalescing only changes the fetch plan; `readColumn` still decodes exactly the selected chunks from the fetched run.

## Acceptance

- Unit tests on `parquetPlan`: (a) two adjacent row groups, all columns → one fetch; (b) with `columns` and ratio 0 → adjacent selected chunks merge across the group boundary, unselected gaps split; (c) ratio 0.7 over the walk's shape (11 columns, 4 selected, ~25 KB each) → one fetch per run of groups; (d) `maxRunBytes` splits a run that would exceed it; (e) `columnChunkAggregation` back-compat.
- The walk (`pyrmts` `SnapshotReader.readRun`) can drop its memory-backed `AsyncBuffer` and call `parquetReadObjects({ columns, maxOverfetchRatio: 0.7, maxRunBytes: Infinity })` with the same 48 GETs for the fleet-root view.
