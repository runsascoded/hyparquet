/**
 * Match a record against a query filter
 *
 * @param {Record<string, any>} record
 * @param {ParquetQueryFilter} filter
 * @returns {boolean}
 * @example matchQuery({ id: 1 }, { id: {$gte: 1} }) // true
 */
export function matchFilter(record: Record<string, any>, filter?: ParquetQueryFilter): boolean;
/**
 * Check if a row group can be skipped based on filter and column statistics.
 *
 * @import {ParquetQueryFilter, RowGroup} from '../src/types.js'
 * @param {ParquetQueryFilter | undefined} filter
 * @param {RowGroup} group
 * @param {string[]} physicalColumns
 * @returns {boolean} true if the row group can be skipped
 */
export function canSkipRowGroup(filter: ParquetQueryFilter | undefined, group: RowGroup, physicalColumns: string[]): boolean;
import type { ParquetQueryFilter } from '../src/types.js';
import type { RowGroup } from '../src/types.js';
//# sourceMappingURL=filter.d.ts.map