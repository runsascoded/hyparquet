/**
 * Parse column data from a buffer.
 *
 * @param {DataReader} reader
 * @param {RowGroupSelect} rowGroupSelect row group selection
 * @param {ColumnDecoder} columnDecoder column decoder params
 * @param {(chunk: ColumnData) => void} [onPage] callback for each page
 * @returns {DecodedArray[]}
 */
export function readColumn(reader: DataReader, { groupStart, selectStart, selectEnd }: RowGroupSelect, columnDecoder: ColumnDecoder, onPage?: (chunk: ColumnData) => void): DecodedArray[];
/**
 * Read a page (data or dictionary) from a buffer.
 *
 * @param {DataReader} reader
 * @param {PageHeader} header
 * @param {ColumnDecoder} columnDecoder
 * @param {DecodedArray | undefined} dictionary
 * @param {DecodedArray | undefined} previousChunk
 * @param {number} pageStart skip this many rows in the page
 * @returns {DecodedArray}
 */
export function readPage(reader: DataReader, header: PageHeader, columnDecoder: ColumnDecoder, dictionary: DecodedArray | undefined, previousChunk: DecodedArray | undefined, pageStart: number): DecodedArray;
import type { DataReader } from '../src/types.d.ts';
import type { RowGroupSelect } from '../src/types.d.ts';
import type { ColumnDecoder } from '../src/types.d.ts';
import type { ColumnData } from '../src/types.d.ts';
import type { DecodedArray } from '../src/types.d.ts';
import type { PageHeader } from '../src/types.d.ts';
//# sourceMappingURL=column.d.ts.map