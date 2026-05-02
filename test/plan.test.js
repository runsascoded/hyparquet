import { describe, expect, it } from 'vitest'
import { parquetMetadataAsync } from '../src/index.js'
import { asyncBufferFromFile } from '../src/node.js'
import { parquetPlan } from '../src/plan.js'

describe('parquetPlan', () => {
  it('generates a query plan', async () => {
    const file = await asyncBufferFromFile('test/files/offset_indexed.parquet')
    const metadata = await parquetMetadataAsync(file)
    const plan = parquetPlan({ file, metadata })
    expect(plan).toMatchObject({
      metadata,
      rowStart: 0,
      rowEnd: 200,
      fetches: [
        { startByte: 4, endByte: 14772 },
        { startByte: 14772, endByte: 29507 },
      ],
      groups: [
        {
          groupRows: 100,
          groupStart: 0,
          chunks: [
            { range: { startByte: 4, endByte: 438 } },
            { range: { startByte: 438, endByte: 14772 } },
          ],
        },
        {
          groupRows: 100,
          groupStart: 100,
          chunks: [
            { range: { startByte: 14772, endByte: 15208 } },
            { range: { startByte: 15208, endByte: 29507 } },
          ],
        },
      ],
    })
  })

  it('skips offset index when reading entire row group', async () => {
    const file = await asyncBufferFromFile('test/files/offset_indexed.parquet')
    const metadata = await parquetMetadataAsync(file)
    const plan = parquetPlan({ file, metadata, useOffsetIndex: true })
    // reading all rows, so offset index should not be used
    for (const group of plan.groups) {
      for (const chunk of group.chunks) {
        expect(chunk).toHaveProperty('range')
        expect(chunk).not.toHaveProperty('offsetIndex')
      }
    }
  })

  it('uses offset index when reading a row subset', async () => {
    const file = await asyncBufferFromFile('test/files/offset_indexed.parquet')
    const metadata = await parquetMetadataAsync(file)
    const plan = parquetPlan({ file, metadata, useOffsetIndex: true, rowStart: 50, rowEnd: 150 })
    // partial read should use offset index
    const hasOffsetIndex = plan.groups.some(g =>
      g.chunks.some(c => 'offsetIndex' in c)
    )
    expect(hasOffsetIndex).toBe(true)
  })

  // offset_indexed.parquet: 2 row groups, cols [id, content].
  //   rg0: id {4,438}, content {438,14772}          (span 14768)
  //   rg1: id {14772,15208}, content {15208,29507}  (span 14735)
  describe('columnChunkAggregation option', () => {
    it('default behavior: columns set → no coalescing (one fetch per chunk)', async () => {
      const file = await asyncBufferFromFile('test/files/offset_indexed.parquet')
      const metadata = await parquetMetadataAsync(file)
      const plan = parquetPlan({ file, metadata, columns: ['id', 'content'] })
      // Both chunks of each row group emitted as separate fetches.
      expect(plan.fetches).toEqual([
        { startByte: 4, endByte: 438 },
        { startByte: 438, endByte: 14772 },
        { startByte: 14772, endByte: 15208 },
        { startByte: 15208, endByte: 29507 },
      ])
    })

    it('columns + columnChunkAggregation ≥ group span → coalesces within each rg', async () => {
      const file = await asyncBufferFromFile('test/files/offset_indexed.parquet')
      const metadata = await parquetMetadataAsync(file)
      const plan = parquetPlan({
        file, metadata, columns: ['id', 'content'], columnChunkAggregation: 1 << 25,
      })
      // Same shape as default no-columns case: one fetch per row group.
      expect(plan.fetches).toEqual([
        { startByte: 4, endByte: 14772 },
        { startByte: 14772, endByte: 29507 },
      ])
    })

    it('columns + columnChunkAggregation smaller than the chunk gap → no coalescing', async () => {
      const file = await asyncBufferFromFile('test/files/offset_indexed.parquet')
      const metadata = await parquetMetadataAsync(file)
      // content chunk sits ~14.7kb past the run start; threshold of 1000 never extends.
      const plan = parquetPlan({
        file, metadata, columns: ['id', 'content'], columnChunkAggregation: 1000,
      })
      expect(plan.fetches).toEqual([
        { startByte: 4, endByte: 438 },
        { startByte: 438, endByte: 14772 },
        { startByte: 14772, endByte: 15208 },
        { startByte: 15208, endByte: 29507 },
      ])
    })

    it('no columns + columnChunkAggregation: 0 → disables default coalescing', async () => {
      const file = await asyncBufferFromFile('test/files/offset_indexed.parquet')
      const metadata = await parquetMetadataAsync(file)
      const plan = parquetPlan({ file, metadata, columnChunkAggregation: 0 })
      expect(plan.fetches).toEqual([
        { startByte: 4, endByte: 438 },
        { startByte: 438, endByte: 14772 },
        { startByte: 14772, endByte: 15208 },
        { startByte: 15208, endByte: 29507 },
      ])
    })

    it('columns subset + coalesce: one fetch per rg covering the subset span', async () => {
      const file = await asyncBufferFromFile('test/files/offset_indexed.parquet')
      const metadata = await parquetMetadataAsync(file)
      const plan = parquetPlan({
        file, metadata, columns: ['content'], columnChunkAggregation: 1 << 25,
      })
      // Only the content chunk of each rg is selected; a run of one chunk is
      // just that chunk's range.
      expect(plan.fetches).toEqual([
        { startByte: 438, endByte: 14772 },
        { startByte: 15208, endByte: 29507 },
      ])
    })
  })
})
