# Spec: lazy footer parsing for high-rg-count shards

Status: **open** (2026-05-02). Author: ryan@runsascoded.com (originating
workload: ctbk.dev `gbfs/api` Cloudflare Worker).

## Problem

Footer parse memory scales with `rg-count × col-count`. For
high-rg-count shards (small files with one rg per pruning unit), a
caller that opens many shards concurrently inside a 128 MB CFW can OOM
even though the on-disk footer bytes are small.

Concrete repro from ctbk: ~24 shards × ~2400 rgs × 12 cols ≈ **691,200
`ColumnChunkMetaData` JS objects** in flight, with `Statistics`
containing decoded string `min_value`/`max_value`. Worker hits "Exceeded
Memory Limit" reliably.

ctbk's workaround was to bump the writer's `rowGroupSize` 60 → 600
(~241 rgs/shard). Sufficient for our scale but loses pruning
granularity; doesn't fix the underlying parser behavior.

## Root cause

`parquetMetadata`'s Thrift parse materializes a JS object for every
field of every `ColumnChunkMetaData`, including:

- `meta_data.statistics.min_value` / `max_value` — decoded into JS
  string/number eagerly. For our `station_id` columns this is a ~20-char
  string per rg per shard.
- `meta_data.encodings`, `meta_data.encoding_stats`, `meta_data.path_in_schema`,
  `meta_data.key_value_metadata` — all eagerly materialized regardless
  of whether the caller needs them.
- Per-column `OffsetIndex` / `ColumnIndex` references — small but
  multiplied by rg-count × col-count.

Range-reading the footer (`suffixStart`-style partial download) does
**not** help: footer bytes are small in absolute terms; it's the
*decoded JS representation* that's heavy.

## Options (rough order: smallest API impact first)

### 1. Lazy stats decode

Smallest change, fully backward-compatible. Keep `min_value` /
`max_value` as `Uint8Array` views over the original footer buffer;
decode to string/number on access via getter. Most callers that don't
filter never read most stats.

Implementation sketch: in the `Statistics` parser, replace the eager
decode with a `get min_value() { return this._minBytes ? decode(this._minBytes, type) : undefined }` pattern. Tricky bit: TypeScript types
need to keep advertising `string | number | undefined` for the public
shape — the laziness is invisible to consumers.

Estimated win for ctbk's workload: 60-80% of the per-rg memory (stats
strings dominate at our col-types).

### 2. `metadataColumns` projection

Analogous to the existing `columns` data projection: a parser option
saying "only materialize `ColumnChunkMetaData` for these columns;
return placeholder/skip-bytes objects for the rest." Big win for query
planners that filter on 1-2 columns and never inspect the rest.

API:

```ts
parquetMetadataAsync(file, { metadataColumns: ['station_id'] })
```

Caveats: `parquetPlan` currently iterates *all* columns of each rg to
build byte ranges, so `metadataColumns` only helps when paired with
`columns` (which already restricts what `parquetPlan` examines). Worth
verifying the interaction.

### 3. Lazy `row_groups` array

Biggest change, biggest payoff. Parse the outer footer once recording
per-rg byte offsets; return a `Proxy`/Array-like that materializes each
rg on indexing. Trades memory for re-parse CPU on multi-pass reads.
Lets callers go back to fine-grained rgs (1 station/rg) without OOM.

Tricky: many existing call sites assume `meta.row_groups` is a plain
array (loops, `.length`, `.map`, etc.). Proxy mostly works but spread
copies (`[...meta.row_groups]`) re-materialize everything. Probably
needs a flag to opt in.

## Out of scope

- **Range-reading footer** (`suffixStart`-style). Already supported via
  `parquetMetadataAsync` options; doesn't address parsed-memory cost.
- **Streaming Thrift parse**. CompactProtocol is sequential; no
  meaningful intra-footer streaming win.

## Acceptance

For (1), at minimum: a benchmark in `test/` that constructs a fake
metadata with K rgs × 12 cols × stats and asserts post-parse retained
heap is < (constant + small × K), comparable to the same shape today.
Measured via `process.memoryUsage().heapUsed` deltas.

For (2)/(3): API design + tests + a doc note in README. ctbk would be a
willing real-world consumer.

## References

- ctbk workload: `gbfs/api/src/index.ts` `executeAvailTotalsQuery` /
  `readH1ShardForStation` / `readR2ParquetStationPruned`.
- Workaround in ctbk: `gbfs/compactor/src/index.ts` `rowGroupSize: 600`
  (commit `85b03615` in ctbk).
- Related ctbk spec: `specs/done/h1-stats-fix.md` (full diagnosis +
  measurements for the OOM repro).
