import { describe, expect, it } from 'vitest'
import { parquetMetadataAsync } from '../src/index.js'
import { asyncBufferFromFile } from '../src/node.js'
import { coalesceByteRanges, parquetPlan, prefetchPageIndexes } from '../src/plan.js'

/**
 * @import {PageLocation, PageRanges} from '../src/types.js'
 */

describe('parquetPlan', () => {
  it('generates a query plan', async () => {
    const file = await asyncBufferFromFile('test/files/offset_indexed.parquet')
    const metadata = await parquetMetadataAsync(file)
    const plan = parquetPlan({ file, metadata })
    expect(plan).toMatchObject({
      metadata,
      rowStart: 0,
      rowEnd: 200,
      // adjacent row groups coalesce into one fetch
      fetches: [
        { startByte: 4, endByte: 29507 },
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

  it('does not fetch page indexes for top-level $nor filters', async () => {
    const source = await asyncBufferFromFile('test/files/offset_indexed.parquet')
    const metadata = await parquetMetadataAsync(source)
    const contentChunk = metadata.row_groups[0].columns[1]
    contentChunk.column_index_offset = 1n
    contentChunk.column_index_length = 1
    let slices = 0
    const file = {
      byteLength: source.byteLength,
      slice() {
        slices++
        throw new Error('unexpected page index fetch')
      },
    }

    const indexes = await prefetchPageIndexes({
      file,
      metadata,
      filter: { $nor: [{ content: { $eq: 'x' } }] },
    })

    expect(slices).toBe(0)
    expect(indexes.pageRangesByGroup).toEqual([undefined, undefined])
    expect(indexes.pageLocationsByGroup).toEqual([{}, {}])
  })

  it('coalesces candidate ranges that select the same coarse output page', async () => {
    const file = await asyncBufferFromFile('test/files/offset_indexed.parquet')
    const metadata = await parquetMetadataAsync(file)
    /** @type {(PageRanges | undefined)[]} */
    const pageRangesByGroup = [
      [[0, 10], [20, 30]],
      undefined,
    ]
    /** @type {Record<string, PageLocation[]>[]} */
    const pageLocationsByGroup = [
      {
        content: [{
          offset: 438n,
          compressed_page_size: 14334,
          first_row_index: 0n,
        }],
      },
      {},
    ]

    const plan = parquetPlan({
      file,
      metadata,
      rowEnd: 100,
      columns: ['content'],
      filter: { id: { $in: [0, 20] } },
      pageRangesByGroup,
      pageLocationsByGroup,
    })

    expect(plan.groups).toHaveLength(1)
    expect(plan.groups[0]).toMatchObject({ selectStart: 0, selectEnd: 30 })
  })

  it('reuses chunk plans across disjoint candidate ranges', async () => {
    const file = await asyncBufferFromFile('test/files/offset_indexed.parquet')
    const metadata = await parquetMetadataAsync(file)
    const plan = parquetPlan({
      file,
      metadata,
      rowEnd: 100,
      columns: ['content'],
      filter: { id: { $in: [0, 60] } },
      pageRangesByGroup: [[[0, 10], [60, 70]], undefined],
      pageLocationsByGroup: [{
        content: [
          { offset: 438n, compressed_page_size: 100, first_row_index: 0n },
          { offset: 538n, compressed_page_size: 100, first_row_index: 50n },
        ],
      }, {}],
    })

    expect(plan.groups).toHaveLength(2)
    expect(plan.groups[0].chunks).toBe(plan.groups[1].chunks)
  })
})

// offset_indexed.parquet: 2 row groups, cols [id, content], laid out back to back:
//   rg0: id {4,438}, content {438,14772}
//   rg1: id {14772,15208}, content {15208,29507}
describe('parquetPlan coalescing', () => {
  /**
   * @param {{ columns?: string[], maxOverfetchRatio?: number, maxRunBytes?: number }} options
   * @returns {Promise<import('../src/types.js').ByteRange[]>}
   */
  async function planFetches(options) {
    const file = await asyncBufferFromFile('test/files/offset_indexed.parquet')
    const metadata = await parquetMetadataAsync(file)
    return parquetPlan({ file, metadata, ...options }).fetches
  }

  it('merges adjacent selected chunks across the row-group boundary', async () => {
    expect(await planFetches({ columns: ['id', 'content'] })).toEqual([
      { startByte: 4, endByte: 29507 },
    ])
  })

  it('splits on unselected gaps by default when columns are projected', async () => {
    expect(await planFetches({ columns: ['id'] })).toEqual([
      { startByte: 4, endByte: 438 },
      { startByte: 14772, endByte: 15208 },
    ])
  })

  it('bridges unselected gaps up to maxOverfetchRatio', async () => {
    // merged run: 15204 bytes, 870 wanted => 14334/15204 = 0.943 untargeted
    const merged = [{ startByte: 4, endByte: 15208 }]
    expect(await planFetches({ columns: ['id'], maxOverfetchRatio: 0.95 })).toEqual(merged)
    expect(await planFetches({ columns: ['id'], maxOverfetchRatio: 0.94 })).toEqual([
      { startByte: 4, endByte: 438 },
      { startByte: 14772, endByte: 15208 },
    ])
  })

  it('splits a run that would exceed maxRunBytes', async () => {
    expect(await planFetches({ maxRunBytes: 15000 })).toEqual([
      { startByte: 4, endByte: 14772 },
      { startByte: 14772, endByte: 29507 },
    ])
  })

  it('issues one fetch per chunk with maxRunBytes 0', async () => {
    expect(await planFetches({ maxRunBytes: 0 })).toEqual([
      { startByte: 4, endByte: 438 },
      { startByte: 438, endByte: 14772 },
      { startByte: 14772, endByte: 15208 },
      { startByte: 15208, endByte: 29507 },
    ])
  })
})

describe('coalesceByteRanges', () => {
  it('merges only overlapping or touching ranges by default', () => {
    expect(coalesceByteRanges([
      { startByte: 30, endByte: 40 },
      { startByte: 0, endByte: 10 },
      { startByte: 10, endByte: 20 },
      { startByte: 15, endByte: 25 },
    ])).toEqual([
      { startByte: 0, endByte: 25 },
      { startByte: 30, endByte: 40 },
    ])
  })

  it('merges overlapping ranges even past maxRunBytes', () => {
    expect(coalesceByteRanges([
      { startByte: 0, endByte: 10 },
      { startByte: 5, endByte: 20 },
      { startByte: 20, endByte: 30 },
    ], { maxRunBytes: 5 })).toEqual([
      { startByte: 0, endByte: 20 },
      { startByte: 20, endByte: 30 },
    ])
  })

  it('does not count overlapping bytes twice toward the covered share', () => {
    // covered = [0,20) = 20 of 40 bytes, so 0.25 untargeted; summing range
    // lengths would count 40 covered bytes and merge even at ratio 0
    const ranges = [
      { startByte: 0, endByte: 20 },
      { startByte: 0, endByte: 10 },
      { startByte: 30, endByte: 40 },
    ]
    expect(coalesceByteRanges(ranges, { maxOverfetchRatio: 0.24 })).toEqual([
      { startByte: 0, endByte: 20 },
      { startByte: 30, endByte: 40 },
    ])
    expect(coalesceByteRanges(ranges, { maxOverfetchRatio: 0.25 })).toEqual([
      { startByte: 0, endByte: 40 },
    ])
  })

  // walk shape: 3 row groups x 11 columns x 25kb, columns [0, 3, 5, 9] selected
  const chunk = 25_000
  const group = 11 * chunk
  const walk = [0, 1, 2].flatMap(g => [0, 3, 5, 9].map(c => ({
    startByte: g * group + c * chunk,
    endByte: g * group + (c + 1) * chunk,
  })))

  it('coalesces a projected run of row groups into one fetch at ratio 0.7', () => {
    // 300kb wanted of an 800kb span: 0.625 untargeted
    expect(coalesceByteRanges(walk, { maxOverfetchRatio: 0.7 })).toEqual([
      { startByte: 0, endByte: 800_000 },
    ])
  })

  it('splits where the greedy run would exceed the ratio', () => {
    // run 1 stops before rg1 col 9: [0, 525000) would be 325000/525000 = 0.62 untargeted
    expect(coalesceByteRanges(walk, { maxOverfetchRatio: 0.6 })).toEqual([
      { startByte: 0, endByte: 425_000 },
      { startByte: 500_000, endByte: 800_000 },
    ])
  })

  it('bounds runs with maxRunBytes', () => {
    expect(coalesceByteRanges(walk, { maxOverfetchRatio: 1, maxRunBytes: group })).toEqual([
      { startByte: 0, endByte: 250_000 },
      { startByte: 275_000, endByte: 525_000 },
      { startByte: 550_000, endByte: 800_000 },
    ])
  })
})
