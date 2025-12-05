/**
 * Parse TCompactProtocol
 *
 * @param {DataReader} reader
 * @returns {{ [key: `field_${number}`]: any }}
 */
export function deserializeTCompactProtocol(reader: DataReader): {
    [key: `field_${number}`]: any;
};
/**
 * Var int aka Unsigned LEB128.
 * Reads groups of 7 low bits until high bit is 0.
 *
 * @param {DataReader} reader
 * @returns {number}
 */
export function readVarInt(reader: DataReader): number;
/**
 * Values of type int32 and int64 are transformed to a zigzag int.
 * A zigzag int folds positive and negative numbers into the positive number space.
 *
 * @param {DataReader} reader
 * @returns {number}
 */
export function readZigZag(reader: DataReader): number;
/**
 * A zigzag int folds positive and negative numbers into the positive number space.
 * This version returns a BigInt.
 *
 * @param {DataReader} reader
 * @returns {bigint}
 */
export function readZigZagBigInt(reader: DataReader): bigint;
export namespace CompactType {
    let STOP: number;
    let TRUE: number;
    let FALSE: number;
    let BYTE: number;
    let I16: number;
    let I32: number;
    let I64: number;
    let DOUBLE: number;
    let BINARY: number;
    let LIST: number;
    let SET: number;
    let MAP: number;
    let STRUCT: number;
    let UUID: number;
}
import type { DataReader } from '../src/types.d.ts';
//# sourceMappingURL=thrift.d.ts.map