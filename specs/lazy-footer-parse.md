# Spec: lazy footer parsing for high-rg-count shards

Status: **open** (2026-05-02; measured and re-ranked 2026-09-23 on hyparquet 1.31.1; confirmed on real ctbk shards 2026-09-25). Author: ryan@runsascoded.com (originating workload: ctbk.dev `gbfs/api` Cloudflare Worker).

## Problem

Footer parse memory scales with `rg-count × col-count`. For high-rg-count shards (small files with one rg per pruning unit), a caller that opens many shards concurrently inside a 128 MB CFW can OOM even though the on-disk footer bytes are small.

Concrete repro from ctbk: ~24 shards × ~2400 rgs × 12 cols ≈ **691,200 `ColumnChunkMetaData` JS objects** in flight. Worker hits "Exceeded Memory Limit" reliably.

ctbk's workaround was to bump the writer's `rowGroupSize` 60 → 600 (~241 rgs/shard). Sufficient for its scale but loses pruning granularity; doesn't fix the underlying parser behavior.

The same cost shows up as CPU for pyrmts: cw's path-index parquets have 1,262 row groups × 11 columns (~14K column-chunk objects per file), a 7–15 ms parse that pyrmts caches around.

## Root cause

`parquetMetadata`'s Thrift parse materializes a JS object for every field of every `ColumnChunkMetaData`: nested `meta_data` and `statistics` objects, `encodings` / `path_in_schema` / `encoding_stats` arrays, several BigInt offsets and sizes, and the decoded `min_value` / `max_value`.

The original draft assumed the decoded stat strings dominate (est. 60–80% of per-rg memory). **Measurement says otherwise: the per-chunk object skeleton dominates.** See below.

## Measurements (2026-09-23, hyparquet 1.31.1)

Synthetic files modelled on ctbk's avail-v3 aggregate schema (`s2_cell` STRING, `dt` INT64, five JSON-histogram STRING columns with ~80-char values), 2,400 row groups, written by `hyparquet-writer` (which writes stats by default, as ctbk's shards have). Retained heap is the `heapUsed` delta across `parquetMetadata()` with the result held live, after forced GC; parse time is the median of 7 parses. The "2 cols" rows are files that only contain 2 of the columns, i.e. what `metadataColumns` projection would retain.

| file | footer | retained / rg | parse | ×24 shards retained |
|---|---|---|---|---|
| 7 cols, stats | 1322 KB | 5662 B | 32.3 ms | 311 MB |
| 7 cols, no stats | 555 KB | 3814 B | 18.1 ms | 210 MB |
| 2 cols, stats | 403 KB | 1753 B | 9.2 ms | 96 MB |
| 2 cols, no stats | 173 KB | 1222 B | 6.3 ms | 67 MB |

- Stats are **33%** of retained heap, not 60–80%. Even removing *all* stat memory (the ceiling for option 1) leaves 24 fine-grained shards at 210 MB, over a 128 MB Worker.
- Projecting to the 2 columns a query needs gets to 96 MB with stats, 67 MB without. Column projection is the lever that reaches fine-grained rgs.
- Stats are 44% of parse time, but that is an upper bound for option 1's CPU win: stat bytes also make the footer 2.4× larger, and lazy decoding still walks them (it skips only the string decode and allocation).

### Real shards (2026-09-25, from `data.ctbk.dev`)

Parsed real ctbk footers, then simulated each option on the parsed metadata: option 1 by setting every `statistics` to `undefined`, option 2 by nulling non-projected column-chunk entries, measuring retained heap after each. (`delete`-ing the properties instead pushes V8 objects into dictionary mode and *raises* heap, which reads as a negative stat share; avoid it.)

| shard | shape | footer | parse | retained / rg | stat share | projected + no stats |
|---|---|---|---|---|---|---|
| `avail/agg/h1/2026-09-20` | 211 rgs × 5 cols | 117 KB | 3.0 ms | 5197 B | 13% | 4 of 5 cols: 757 KB total |
| `gbfs/avail/h1/2026-09-24/12` | 248 rgs × 12 cols | 242 KB | 7–11 ms | 9839 B | 14–16% | `station_id` + 1 metric: 367 KB total |

- Real stat strings are short (avg 1.3–7.7 chars per stat), so stats matter *less* than in the synthetic run.
- Per column chunk, real and synthetic agree: ~820 B (12-col shard) and ~1040 B (5-col shard) of retained heap.
- Today's shards are at the coarse workaround grain (211–248 rgs): 24 of them retain 25–57 MB, fine.
- Scaled to the spec's fine-grained repro (2400 rgs × 24 shards) using the 12-col shard's per-rg costs: **540 MB** as is, **467 MB** with no stats at all (option 1's ceiling), **83 MB** with metadata for `station_id` + one metric and no stats (option 2). Option 2 is required; option 1 alone does not come close.
- Parse CPU scales the same way: 7–11 ms for 248 rgs suggests ~70–100 ms per fine-grained 12-col footer, ~2 s across 24 shards. Unmeasured how much of that `metadataColumns` saves, since the parser must still walk the skipped chunks' bytes.

Probes (untracked, in the hyparquet working copy): `tmp/heap-footer.mjs` (synthetic; needs `hyparquet-writer`, which is not a devDep) and `tmp/heap-real2.mjs` (real files, option simulation). One should land as a bench script alongside whichever option is implemented.

## Options, re-ranked by measured payoff

### 2. `metadataColumns` projection (do first)

Analogous to the existing `columns` data projection: a parser option saying "only materialize `ColumnChunkMetaData` for these columns; skip over the rest." Cuts the object *count*, which is what dominates.

```ts
parquetMetadataAsync(file, { metadataColumns: ['s2_cell', 'bikes'] })
```

Constraints found in 1.31.1's planner:

- `rowGroup.columns` must keep one entry per physical column: `filter.js` (`canSkipRowGroup`) indexes it by physical position. Skipped columns need placeholders, not removal.
- `parquetPlanGroup` throws `parquet column metadata is undefined` on a missing `meta_data` *before* its `columns` check (`src/plan.js`), so placeholders need a `path_in_schema`, or that check must move after the projection filter.
- `metadataColumns` must cover `columns` plus every filter column (stats pruning, bloom and page-index lookups read those chunks' metadata). Deriving it from `columns` + `filter` when unset is worth considering.

### 1. Lazy stats decode (minor add-on)

Keep `min_value` / `max_value` as `Uint8Array` views over the footer buffer and decode on access via getter; TypeScript types keep advertising the decoded shape. Backward-compatible. Measured ceiling: 13–16% of retained heap on real shards (33% on the synthetic long-string shape), at most 44% of parse time. Worth doing on top of option 2 (96 → 67 MB in the table), not instead of it.

### 3. Lazy `row_groups` array

Parse the outer footer once recording per-rg byte offsets; return an Array-like that materializes each rg on indexing. Biggest payoff, biggest change: call sites assume a plain array, and spread copies re-materialize everything, so it would need an opt-in flag.

A caller-side equivalent already exists in pyrmts: `SnapshotReader`'s `RowGroupIndex` hook takes per-rg row ranges and stats from D1 or a manifest, fetches no footer, and decodes through a synthetic footer holding only the row groups a read touches. Callers with an external rg index can use that pattern today; option 3 is for callers without one.

## Out of scope

- **Range-reading footer** (`suffixStart`-style). Already supported via `parquetMetadataAsync` options; doesn't address parsed cost.
- **Streaming Thrift parse**. CompactProtocol is sequential; no meaningful intra-footer streaming win.
- **Row assembly cost.** pyrmts measured ~3.4 ms to decode an 8,192-row × 4-column group via `parquetReadObjects` (vs ~0.02 ms in pyarrow), mostly per-row object assembly. That is data decoding, not footer parsing; pyrmts is trying a columnar `onChunk` consumer first.

## Acceptance

- Option 2: API + tests (placeholder layout, filter-column interaction, `parquetPlan` with projected metadata) + README note, and the probe rerun showing the "2 cols" retained-heap row for a 7-column file parsed with `metadataColumns` of 2.
- Option 1: the probe showing retained heap per rg down by the stat share (13–16% on real shards) for the same shape.
- ctbk is a willing real-world consumer for both.

## References

- ctbk workload: `gbfs/api/src/index.ts` `executeAvailTotalsQuery` / `readH1ShardForStation` / `readR2ParquetStationPruned`.
- Workaround in ctbk: `gbfs/compactor/src/index.ts` `rowGroupSize: 600` (commit `85b03615` in ctbk).
- Related ctbk spec: `specs/done/h1-stats-fix.md` (full diagnosis + measurements for the OOM repro).
- pyrmts `RowGroupIndex` hook: `js/packages/pyrmts/src/walkdiff.ts` (`SnapshotReader({ rowGroups })`), pyrmts commit `b4df01d`.
