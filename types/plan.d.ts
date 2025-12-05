/**
 * @import {AsyncBuffer, ByteRange, ColumnMetaData, GroupPlan, ParquetReadOptions, QueryPlan} from '../src/types.js'
 */
/**
 * Plan which byte ranges to read to satisfy a read request.
 * Metadata must be non-null.
 *
 * @param {ParquetReadOptions} options
 * @returns {QueryPlan}
 */
export function parquetPlan({ metadata, rowStart, rowEnd, columns, filter }: ParquetReadOptions): QueryPlan;
/**
 * @param {ColumnMetaData} columnMetadata
 * @returns {ByteRange}
 */
export function getColumnRange({ dictionary_page_offset, data_page_offset, total_compressed_size }: ColumnMetaData): ByteRange;
/**
 * Prefetch byte ranges from an AsyncBuffer.
 *
 * @param {AsyncBuffer} file
 * @param {QueryPlan} plan
 * @returns {AsyncBuffer}
 */
export function prefetchAsyncBuffer(file: AsyncBuffer, { fetches }: QueryPlan): AsyncBuffer;
import type { ParquetReadOptions } from '../src/types.js';
import type { QueryPlan } from '../src/types.js';
import type { ColumnMetaData } from '../src/types.js';
import type { ByteRange } from '../src/types.js';
import type { AsyncBuffer } from '../src/types.js';
//# sourceMappingURL=plan.d.ts.map