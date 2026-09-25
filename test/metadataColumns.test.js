import { describe, expect, it } from 'vitest'
import { parquetMetadata, parquetMetadataAsync, parquetReadObjects, skippedColumnChunk } from '../src/index.js'
import { asyncBufferFromFile } from '../src/node.js'
import { parquetPlan } from '../src/plan.js'

// offset_indexed.parquet: 2 row groups x cols [id, content], id = row + 1
const path = 'test/files/offset_indexed.parquet'

describe('metadataColumns', () => {
  it('parses listed columns and leaves positional placeholders for the rest', async () => {
    const file = await asyncBufferFromFile(path)
    const full = await parquetMetadataAsync(file)
    const projected = await parquetMetadataAsync(file, { metadataColumns: ['content'] })

    expect(projected.row_groups.map(rg => rg.columns)).toEqual([
      [skippedColumnChunk, full.row_groups[0].columns[1]],
      [skippedColumnChunk, full.row_groups[1].columns[1]],
    ])
    // one shared, empty, frozen object: no per-chunk allocation
    expect(projected.row_groups[0].columns[0]).toBe(skippedColumnChunk)
    expect(projected.row_groups[1].columns[0]).toBe(skippedColumnChunk)
    expect(skippedColumnChunk).toEqual({})
    expect(Object.isFrozen(skippedColumnChunk)).toBe(true)
    expect({ ...projected, row_groups: [] }).toEqual({ ...full, row_groups: [] })
  })

  it('matches the sync parser', async () => {
    const file = await asyncBufferFromFile(path)
    const footer = await file.slice(0)
    expect(parquetMetadata(footer, { metadataColumns: ['id'] }))
      .toEqual(await parquetMetadataAsync(file, { metadataColumns: ['id'] }))
  })

  it('reads projected columns the same as with full metadata', async () => {
    const file = await asyncBufferFromFile(path)
    const metadata = await parquetMetadataAsync(file, { metadataColumns: ['content'] })
    expect(await parquetReadObjects({ file, metadata, columns: ['content'] }))
      .toEqual(await parquetReadObjects({ file, columns: ['content'] }))
  })

  it('is accepted as a read option when the read parses metadata', async () => {
    const file = await asyncBufferFromFile(path)
    expect(await parquetReadObjects({ file, columns: ['id'], metadataColumns: ['id'], rowEnd: 3 }))
      .toEqual([{ id: 1n }, { id: 2n }, { id: 3n }])
  })

  it('prunes row groups on stats of a parsed filter column', async () => {
    const file = await asyncBufferFromFile(path)
    const metadata = await parquetMetadataAsync(file, { metadataColumns: ['id'] })
    const filter = { id: { $gt: 197n } }
    expect(parquetPlan({ file, metadata, columns: ['id'], filter }).groups.map(g => g.groupStart)).toEqual([100])
    expect(await parquetReadObjects({ file, metadata, columns: ['id'], filter }))
      .toEqual([{ id: 198n }, { id: 199n }, { id: 200n }])
  })

  it('rejects reading a column whose metadata was not parsed', async () => {
    const file = await asyncBufferFromFile(path)
    const metadata = await parquetMetadataAsync(file, { metadataColumns: ['content'] })
    await expect(parquetReadObjects({ file, metadata, columns: ['id'] }))
      .rejects.toThrow('parquet column metadata is undefined: id (not in metadataColumns?)')
  })

  it('rejects reading all columns with partial metadata', async () => {
    const file = await asyncBufferFromFile(path)
    const metadata = await parquetMetadataAsync(file, { metadataColumns: ['content'] })
    await expect(parquetReadObjects({ file, metadata }))
      .rejects.toThrow('parquet column metadata is undefined: (all columns) (not in metadataColumns?)')
  })

  it('rejects filtering on a column whose metadata was not parsed', async () => {
    const file = await asyncBufferFromFile(path)
    const metadata = await parquetMetadataAsync(file, { metadataColumns: ['content'] })
    await expect(parquetReadObjects({ file, metadata, columns: ['content'], filter: { id: { $eq: 1n } } }))
      .rejects.toThrow('parquet column metadata is undefined: id (not in metadataColumns?)')
  })
})
