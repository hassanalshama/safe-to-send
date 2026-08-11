// @ts-check

import { deflateRawSync } from 'node:zlib';
import { crc32 } from '../../core/zip.mjs';

/** @param {Buffer} buffer @param {number} offset @param {number} value */
function u16(buffer, offset, value) { buffer.writeUInt16LE(value & 0xffff, offset); }
/** @param {Buffer} buffer @param {number} offset @param {number} value */
function u32(buffer, offset, value) { buffer.writeUInt32LE(value >>> 0, offset); }

const FIXED_DOS_TIME = (12 << 11); // 12:00:00
const FIXED_DOS_DATE = ((2026 - 1980) << 9) | (8 << 5) | 10;

/**
 * Deterministic ZIP writer for test fixtures and static assets.
 * @param {{name:string, data:string | Uint8Array | Buffer, compress?:boolean}[]} inputs
 */
export function createZip(inputs) {
  const localParts = [];
  const centralParts = [];
  let offset = 0;
  for (const input of inputs) {
    const name = Buffer.from(input.name.replaceAll('\\', '/'), 'utf8');
    const data = Buffer.isBuffer(input.data) ? input.data : Buffer.from(input.data);
    const compressed = input.compress === false ? data : deflateRawSync(data, { level: 9 });
    const method = input.compress === false ? 0 : 8;
    const checksum = crc32(data);

    const local = Buffer.alloc(30 + name.length);
    u32(local, 0, 0x04034b50);
    u16(local, 4, 20);
    u16(local, 6, 0x0800);
    u16(local, 8, method);
    u16(local, 10, FIXED_DOS_TIME);
    u16(local, 12, FIXED_DOS_DATE);
    u32(local, 14, checksum);
    u32(local, 18, compressed.length);
    u32(local, 22, data.length);
    u16(local, 26, name.length);
    u16(local, 28, 0);
    name.copy(local, 30);
    localParts.push(local, compressed);

    const central = Buffer.alloc(46 + name.length);
    u32(central, 0, 0x02014b50);
    u16(central, 4, 0x031e);
    u16(central, 6, 20);
    u16(central, 8, 0x0800);
    u16(central, 10, method);
    u16(central, 12, FIXED_DOS_TIME);
    u16(central, 14, FIXED_DOS_DATE);
    u32(central, 16, checksum);
    u32(central, 20, compressed.length);
    u32(central, 24, data.length);
    u16(central, 28, name.length);
    u16(central, 30, 0);
    u16(central, 32, 0);
    u16(central, 34, 0);
    u16(central, 36, 0);
    u32(central, 38, 0);
    u32(central, 42, offset);
    name.copy(central, 46);
    centralParts.push(central);
    offset += local.length + compressed.length;
  }

  const central = Buffer.concat(centralParts);
  const eocd = Buffer.alloc(22);
  u32(eocd, 0, 0x06054b50);
  u16(eocd, 4, 0);
  u16(eocd, 6, 0);
  u16(eocd, 8, inputs.length);
  u16(eocd, 10, inputs.length);
  u32(eocd, 12, central.length);
  u32(eocd, 16, offset);
  u16(eocd, 20, 0);
  return Buffer.concat([...localParts, central, eocd]);
}
