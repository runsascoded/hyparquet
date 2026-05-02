import { describe, expect, it } from 'vitest'
import { parquetMetadataAsync } from '../src/index.js'
import { asyncBufferFromFile } from '../src/node.js'
import { parquetPlan } from '../src/plan.js'

describe('parquetPlan', () => {
  it('generates a query plan', async () => {
    const file = await asyncBufferFromFile('test/files/page_indexed.parquet')
    const metadata = await parquetMetadataAsync(file)
    const plan = parquetPlan({ file, metadata })
    expect(plan).toMatchObject({
      metadata,
      rowStart: 0,
      rowEnd: 200,
      fetches: [
        { startByte: 4, endByte: 1166 },
        { startByte: 1166, endByte: 2326 },
      ],
      groups: [
        {
          groupRows: 100,
          groupStart: 0,
          ranges: [
            { startByte: 4, endByte: 832 },
            { startByte: 832, endByte: 1166 },
          ],
        },
        {
          groupRows: 100,
          groupStart: 100,
          ranges: [
            { startByte: 1166, endByte: 1998 },
            { startByte: 1998, endByte: 2326 },
          ],
        },
      ],
    })
  })

  describe('columnChunkAggregation option', () => {
    it('default behavior: columns set → no coalescing (one fetch per chunk)', async () => {
      const file = await asyncBufferFromFile('test/files/page_indexed.parquet')
      const metadata = await parquetMetadataAsync(file)
      const plan = parquetPlan({ file, metadata, columns: ['row', 'quality'] })
      // Both chunks of each row group emitted as separate fetches.
      expect(plan.fetches).toEqual([
        { startByte: 4, endByte: 832 },
        { startByte: 832, endByte: 1166 },
        { startByte: 1166, endByte: 1998 },
        { startByte: 1998, endByte: 2326 },
      ])
    })

    it('columns + columnChunkAggregation > groupSize → coalesces within each rg', async () => {
      const file = await asyncBufferFromFile('test/files/page_indexed.parquet')
      const metadata = await parquetMetadataAsync(file)
      const plan = parquetPlan({
        file, metadata, columns: ['row', 'quality'], columnChunkAggregation: 1 << 25,
      })
      // Same shape as default no-columns case: one fetch per row group.
      expect(plan.fetches).toEqual([
        { startByte: 4, endByte: 1166 },
        { startByte: 1166, endByte: 2326 },
      ])
    })

    it('columns + columnChunkAggregation < groupSize → no coalescing', async () => {
      const file = await asyncBufferFromFile('test/files/page_indexed.parquet')
      const metadata = await parquetMetadataAsync(file)
      // groupSize per rg is 1162 bytes; threshold of 1000 disables coalescing.
      const plan = parquetPlan({
        file, metadata, columns: ['row', 'quality'], columnChunkAggregation: 1000,
      })
      expect(plan.fetches).toEqual([
        { startByte: 4, endByte: 832 },
        { startByte: 832, endByte: 1166 },
        { startByte: 1166, endByte: 1998 },
        { startByte: 1998, endByte: 2326 },
      ])
    })

    it('no columns + columnChunkAggregation: 0 → disables default coalescing', async () => {
      const file = await asyncBufferFromFile('test/files/page_indexed.parquet')
      const metadata = await parquetMetadataAsync(file)
      const plan = parquetPlan({ file, metadata, columnChunkAggregation: 0 })
      expect(plan.fetches).toEqual([
        { startByte: 4, endByte: 832 },
        { startByte: 832, endByte: 1166 },
        { startByte: 1166, endByte: 1998 },
        { startByte: 1998, endByte: 2326 },
      ])
    })

    it('columns subset + coalesce: still one fetch per rg covering subset span', async () => {
      const file = await asyncBufferFromFile('test/files/page_indexed.parquet')
      const metadata = await parquetMetadataAsync(file)
      const plan = parquetPlan({
        file, metadata, columns: ['quality'], columnChunkAggregation: 1 << 25,
      })
      // Only the second chunk of each rg is selected; "coalesce" with one
      // chunk just returns that chunk's range.
      expect(plan.fetches).toEqual([
        { startByte: 832, endByte: 1166 },
        { startByte: 1998, endByte: 2326 },
      ])
    })
  })
})
