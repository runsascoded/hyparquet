import type { AsyncBuffer, ColumnChunk, FileMetaData, MetadataOptions, MinMaxType, ParquetParsers, SchemaElement, SchemaTree } from '../src/types.js';
/**
 * @import {AsyncBuffer, ColumnChunk, FileMetaData, KeyValue, LogicalType, MetadataOptions, MinMaxType, ParquetParsers, SchemaElement, SchemaTree, Statistics, TimeUnit} from '../src/types.js'
 */
export declare const defaultInitialFetchSize: number;
/**
 * Shared placeholder for column chunks not listed in `metadataColumns`: it keeps
 * the chunk's slot (chunks are indexed by physical position) without retaining
 * any per-chunk objects.
 *
 * @type {Readonly<ColumnChunk>}
 */
export declare const skippedColumnChunk: Readonly<ColumnChunk>;
/**
 * Read parquet metadata from an async buffer.
 *
 * An AsyncBuffer is like an ArrayBuffer, but the slices are loaded
 * asynchronously, possibly over the network.
 *
 * You must provide the byteLength of the buffer, typically from a HEAD request.
 *
 * In theory, you could use suffix-range requests to fetch the end of the file,
 * and save a round trip. But in practice, this doesn't work because chrome
 * deems suffix-range requests as a not-safe-listed header, and will require
 * a pre-flight. So the byteLength is required.
 *
 * To make this efficient, we initially request the last 512kb of the file,
 * which is likely to contain the metadata. If the metadata length exceeds the
 * initial fetch, 512kb, we request the rest of the metadata from the AsyncBuffer.
 *
 * This ensures that we either make one 512kb initial request for the metadata,
 * or a second request for up to the metadata size.
 *
 * @param {AsyncBuffer} asyncBuffer parquet file contents
 * @param {import('../src/types.d.ts').MetadataAsyncOptions} options
 * @returns {Promise<FileMetaData>} parquet metadata object
 */
export declare function parquetMetadataAsync(asyncBuffer: AsyncBuffer, { parsers, initialFetchSize, suffixStart, geoparquet, metadataColumns }?: import('../src/types.d.ts').MetadataAsyncOptions): Promise<FileMetaData>;
/**
 * Read parquet metadata from a buffer synchronously.
 *
 * @param {ArrayBuffer} arrayBuffer parquet file footer
 * @param {MetadataOptions} options metadata parsing options
 * @returns {FileMetaData} parquet metadata object
 */
export declare function parquetMetadata(arrayBuffer: ArrayBuffer, { parsers, geoparquet, metadataColumns }?: MetadataOptions): FileMetaData;
/**
 * Return a tree of schema elements from parquet metadata.
 *
 * @param {{schema: SchemaElement[]}} metadata parquet metadata object
 * @returns {SchemaTree} tree of schema elements
 */
export declare function parquetSchema({ schema }: {
    schema: SchemaElement[];
}): SchemaTree;
/**
 * @param {Uint8Array | undefined} value
 * @param {SchemaElement} schema
 * @param {ParquetParsers} parsers
 * @returns {MinMaxType | undefined}
 */
export declare function convertMetadata(value: Uint8Array | undefined, schema: SchemaElement, parsers: ParquetParsers): MinMaxType | undefined;
//# sourceMappingURL=metadata.d.ts.map