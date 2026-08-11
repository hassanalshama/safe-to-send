// @ts-check

import { inflateRaw } from './deflate.mjs';
import { bytesToUtf8, toUint8Array } from './util.mjs';

const EOCD_SIGNATURE = 0x06054b50;
const ZIP64_EOCD_SIGNATURE = 0x06064b50;
const ZIP64_LOCATOR_SIGNATURE = 0x07064b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const LOCAL_SIGNATURE = 0x04034b50;

const crcTable = new Uint32Array(256);
for (let index = 0; index < 256; index += 1) {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) {
    value = (value >>> 1) ^ ((value & 1) ? 0xedb88320 : 0);
  }
  crcTable[index] = value >>> 0;
}

/** @param {Uint8Array} bytes */
export function crc32(bytes) {
  let value = 0xffffffff;
  for (const byte of bytes) value = crcTable[(value ^ byte) & 0xff] ^ (value >>> 8);
  return (value ^ 0xffffffff) >>> 0;
}

/** @param {DataView} view @param {number} offset */
function u16(view, offset) {
  return view.getUint16(offset, true);
}

/** @param {DataView} view @param {number} offset */
function u32(view, offset) {
  return view.getUint32(offset, true);
}

/** @param {DataView} view @param {number} offset */
function u64(view, offset) {
  const low = BigInt(u32(view, offset));
  const high = BigInt(u32(view, offset + 4));
  const value = low | (high << 32n);
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new ZipError('ZIP64 value exceeds JavaScript\'s safe integer range.', 'ZIP64_RANGE');
  }
  return Number(value);
}

/** @param {Uint8Array} bytes */
function decodeName(bytes) {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return [...bytes].map((byte) => String.fromCharCode(byte)).join('');
  }
}

/** @param {string} name */
function isSafePath(name) {
  const normalized = name.replaceAll('\\', '/');
  if (normalized.includes('\u0000')) return false;
  if (normalized.startsWith('/') || /^[A-Za-z]:\//.test(normalized)) return false;
  return !normalized.split('/').some((part) => part === '..');
}

/** @param {Uint8Array} extra */
function parseExtra(extra) {
  const fields = new Map();
  const view = new DataView(extra.buffer, extra.byteOffset, extra.byteLength);
  let offset = 0;
  while (offset + 4 <= extra.length) {
    const id = u16(view, offset);
    const length = u16(view, offset + 2);
    offset += 4;
    if (offset + length > extra.length) break;
    fields.set(id, extra.subarray(offset, offset + length));
    offset += length;
  }
  return fields;
}

/**
 * @param {Uint8Array | undefined} bytes
 * @param {{uncompressed: boolean, compressed: boolean, offset: boolean, disk: boolean}} needed
 */
function parseZip64Values(bytes, needed) {
  if (!bytes) throw new ZipError('ZIP64 entry is missing its ZIP64 extra field.', 'ZIP64_EXTRA');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let cursor = 0;
  const take = () => {
    if (cursor + 8 > bytes.length) throw new ZipError('Truncated ZIP64 extra field.', 'ZIP64_EXTRA');
    const value = u64(view, cursor);
    cursor += 8;
    return value;
  };
  const values = {};
  if (needed.uncompressed) values.uncompressedSize = take();
  if (needed.compressed) values.compressedSize = take();
  if (needed.offset) values.localHeaderOffset = take();
  if (needed.disk) {
    if (cursor + 4 > bytes.length) throw new ZipError('Truncated ZIP64 disk field.', 'ZIP64_EXTRA');
    values.disk = u32(view, cursor);
  }
  return values;
}

export class ZipError extends Error {
  /** @param {string} message @param {string} code */
  constructor(message, code = 'ZIP_INVALID') {
    super(message);
    this.name = 'ZipError';
    this.code = code;
  }
}

/**
 * @typedef {{
 *   name: string,
 *   compressedSize: number,
 *   uncompressedSize: number,
 *   compressionMethod: number,
 *   crc32: number,
 *   flags: number,
 *   localHeaderOffset: number,
 *   directory: boolean,
 *   encrypted: boolean,
 *   safePath: boolean,
 *   read: () => Uint8Array,
 *   text: () => string
 * }} ZipEntry
 */

/**
 * Parse a ZIP archive with explicit resource limits. Entries are inflated lazily.
 * @param {ArrayBuffer | Uint8Array | DataView} input
 * @param {{
 *   maxEntries?: number,
 *   maxEntryBytes?: number,
 *   maxTotalBytes?: number,
 *   maxCompressionRatio?: number,
 *   verifyCrc?: boolean
 * }} [options]
 */
export function openZip(input, options = {}) {
  const bytes = toUint8Array(input);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const limits = {
    maxEntries: options.maxEntries ?? 20_000,
    maxEntryBytes: options.maxEntryBytes ?? 128 * 1024 * 1024,
    maxTotalBytes: options.maxTotalBytes ?? 512 * 1024 * 1024,
    maxCompressionRatio: options.maxCompressionRatio ?? 2_000,
    verifyCrc: options.verifyCrc ?? true,
  };

  if (bytes.length < 22) throw new ZipError('File is too small to be a ZIP archive.', 'ZIP_TOO_SMALL');
  const searchStart = Math.max(0, bytes.length - 22 - 65_535);
  let eocdOffset = -1;
  for (let offset = bytes.length - 22; offset >= searchStart; offset -= 1) {
    if (u32(view, offset) === EOCD_SIGNATURE) {
      const commentLength = u16(view, offset + 20);
      if (offset + 22 + commentLength <= bytes.length) {
        eocdOffset = offset;
        break;
      }
    }
  }
  if (eocdOffset < 0) throw new ZipError('ZIP end-of-central-directory record was not found.', 'ZIP_EOCD');

  const diskNumber = u16(view, eocdOffset + 4);
  const centralDisk = u16(view, eocdOffset + 6);
  let entryCount = u16(view, eocdOffset + 10);
  let centralSize = u32(view, eocdOffset + 12);
  let centralOffset = u32(view, eocdOffset + 16);
  let zip64 = false;

  if (diskNumber !== 0 || centralDisk !== 0) {
    throw new ZipError('Multi-disk ZIP archives are not supported.', 'ZIP_MULTIDISK');
  }

  if (entryCount === 0xffff || centralSize === 0xffffffff || centralOffset === 0xffffffff) {
    zip64 = true;
    const locatorOffset = eocdOffset - 20;
    if (locatorOffset < 0 || u32(view, locatorOffset) !== ZIP64_LOCATOR_SIGNATURE) {
      throw new ZipError('ZIP64 locator was not found.', 'ZIP64_LOCATOR');
    }
    const zip64Offset = u64(view, locatorOffset + 8);
    if (zip64Offset + 56 > bytes.length || u32(view, zip64Offset) !== ZIP64_EOCD_SIGNATURE) {
      throw new ZipError('ZIP64 end-of-central-directory record is invalid.', 'ZIP64_EOCD');
    }
    const zip64Disk = u32(view, zip64Offset + 16);
    const zip64CentralDisk = u32(view, zip64Offset + 20);
    if (zip64Disk !== 0 || zip64CentralDisk !== 0) {
      throw new ZipError('Multi-disk ZIP64 archives are not supported.', 'ZIP_MULTIDISK');
    }
    entryCount = u64(view, zip64Offset + 32);
    centralSize = u64(view, zip64Offset + 40);
    centralOffset = u64(view, zip64Offset + 48);
  }

  if (entryCount > limits.maxEntries) {
    throw new ZipError(`Archive has ${entryCount} entries; the safety limit is ${limits.maxEntries}.`, 'ZIP_ENTRY_LIMIT');
  }
  if (centralOffset + centralSize > bytes.length) {
    throw new ZipError('ZIP central directory extends past the end of the file.', 'ZIP_CENTRAL_RANGE');
  }

  /** @type {ZipEntry[]} */
  const entries = [];
  /** @type {{code: string, message: string, entry?: string}[]} */
  const diagnostics = [];
  const names = new Map();
  let cursor = centralOffset;
  let totalRead = 0;

  for (let index = 0; index < entryCount; index += 1) {
    if (cursor + 46 > bytes.length || u32(view, cursor) !== CENTRAL_SIGNATURE) {
      throw new ZipError(`Invalid central-directory entry at index ${index}.`, 'ZIP_CENTRAL_ENTRY');
    }
    const flags = u16(view, cursor + 8);
    const compressionMethod = u16(view, cursor + 10);
    const expectedCrc = u32(view, cursor + 16);
    let compressedSize = u32(view, cursor + 20);
    let uncompressedSize = u32(view, cursor + 24);
    const nameLength = u16(view, cursor + 28);
    const extraLength = u16(view, cursor + 30);
    const commentLength = u16(view, cursor + 32);
    let diskStart = u16(view, cursor + 34);
    let localHeaderOffset = u32(view, cursor + 42);
    const recordEnd = cursor + 46 + nameLength + extraLength + commentLength;
    if (recordEnd > bytes.length) throw new ZipError('Truncated central-directory entry.', 'ZIP_CENTRAL_ENTRY');

    const rawName = bytes.subarray(cursor + 46, cursor + 46 + nameLength);
    const extra = bytes.subarray(cursor + 46 + nameLength, cursor + 46 + nameLength + extraLength);
    const name = decodeName(rawName);
    const extras = parseExtra(extra);
    const needed = {
      uncompressed: uncompressedSize === 0xffffffff,
      compressed: compressedSize === 0xffffffff,
      offset: localHeaderOffset === 0xffffffff,
      disk: diskStart === 0xffff,
    };
    if (Object.values(needed).some(Boolean)) {
      const values = parseZip64Values(extras.get(0x0001), needed);
      if (needed.uncompressed) uncompressedSize = values.uncompressedSize;
      if (needed.compressed) compressedSize = values.compressedSize;
      if (needed.offset) localHeaderOffset = values.localHeaderOffset;
      if (needed.disk) diskStart = values.disk;
    }
    if (diskStart !== 0) throw new ZipError('Multi-disk ZIP entry found.', 'ZIP_MULTIDISK');

    const directory = name.endsWith('/');
    const encrypted = Boolean(flags & 0x0001) || Boolean(flags & 0x0040);
    const safePath = isSafePath(name);
    if (!safePath) diagnostics.push({ code: 'UNSAFE_PATH', message: 'Entry name is unsafe.', entry: name });
    const key = name.toLowerCase();
    if (names.has(key)) {
      diagnostics.push({ code: 'DUPLICATE_NAME', message: `Duplicate or case-colliding entry name: ${name}`, entry: name });
    } else {
      names.set(key, name);
    }
    if (uncompressedSize > limits.maxEntryBytes) {
      diagnostics.push({ code: 'LARGE_ENTRY', message: `Entry exceeds the per-entry safety limit.`, entry: name });
    }
    const ratio = compressedSize === 0 ? (uncompressedSize ? Infinity : 1) : uncompressedSize / compressedSize;
    if (ratio > limits.maxCompressionRatio) {
      diagnostics.push({ code: 'HIGH_COMPRESSION_RATIO', message: `Entry compression ratio is ${Math.round(ratio)}:1.`, entry: name });
    }

    /** @type {Uint8Array | null} */
    let cache = null;
    const entry = {
      name,
      compressedSize,
      uncompressedSize,
      compressionMethod,
      crc32: expectedCrc,
      flags,
      localHeaderOffset,
      directory,
      encrypted,
      safePath,
      read() {
        if (cache) return cache;
        if (directory) return new Uint8Array();
        if (encrypted) throw new ZipError(`Encrypted ZIP entry cannot be inspected: ${name}`, 'ZIP_ENCRYPTED');
        if (!safePath) throw new ZipError(`Unsafe ZIP entry path cannot be inspected: ${name}`, 'ZIP_UNSAFE_PATH');
        if (uncompressedSize > limits.maxEntryBytes) {
          throw new ZipError(`Entry exceeds the ${limits.maxEntryBytes}-byte safety limit: ${name}`, 'ZIP_ENTRY_LIMIT');
        }
        if (totalRead + uncompressedSize > limits.maxTotalBytes) {
          throw new ZipError('Inflated archive data exceeds the total safety limit.', 'ZIP_TOTAL_LIMIT');
        }
        if (localHeaderOffset + 30 > bytes.length || u32(view, localHeaderOffset) !== LOCAL_SIGNATURE) {
          throw new ZipError(`Local ZIP header is invalid for ${name}.`, 'ZIP_LOCAL_HEADER');
        }
        const localNameLength = u16(view, localHeaderOffset + 26);
        const localExtraLength = u16(view, localHeaderOffset + 28);
        const dataOffset = localHeaderOffset + 30 + localNameLength + localExtraLength;
        if (dataOffset + compressedSize > bytes.length) {
          throw new ZipError(`Compressed data extends past the end of the file: ${name}.`, 'ZIP_DATA_RANGE');
        }
        const compressed = bytes.subarray(dataOffset, dataOffset + compressedSize);
        if (compressionMethod === 0) cache = compressed.slice();
        else if (compressionMethod === 8) cache = inflateRaw(compressed, { maxOutputBytes: limits.maxEntryBytes });
        else throw new ZipError(`Unsupported ZIP compression method ${compressionMethod} for ${name}.`, 'ZIP_COMPRESSION');
        if (cache.length !== uncompressedSize) {
          throw new ZipError(`Uncompressed size mismatch for ${name}.`, 'ZIP_SIZE_MISMATCH');
        }
        if (limits.verifyCrc && crc32(cache) !== expectedCrc) {
          throw new ZipError(`CRC-32 mismatch for ${name}.`, 'ZIP_CRC');
        }
        totalRead += cache.length;
        return cache;
      },
      text() {
        return bytesToUtf8(this.read());
      },
    };
    entries.push(entry);
    cursor = recordEnd;
  }

  const byName = new Map(entries.map((entry) => [entry.name, entry]));
  return {
    bytes,
    entries,
    diagnostics,
    zip64,
    get size() { return entries.length; },
    /** @param {string} name */
    has(name) { return byName.has(name); },
    /** @param {string} name */
    get(name) { return byName.get(name) || null; },
    /** @param {string} name */
    read(name) {
      const entry = byName.get(name);
      if (!entry) throw new ZipError(`ZIP entry not found: ${name}`, 'ZIP_NOT_FOUND');
      return entry.read();
    },
    /** @param {string} name */
    text(name) {
      const entry = byName.get(name);
      if (!entry) throw new ZipError(`ZIP entry not found: ${name}`, 'ZIP_NOT_FOUND');
      return entry.text();
    },
    /** @param {string} prefix */
    list(prefix = '') { return entries.filter((entry) => entry.name.startsWith(prefix)); },
  };
}

/** @param {Uint8Array} bytes */
export function looksLikeZip(bytes) {
  if (bytes.length < 4) return false;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const signature = u32(view, 0);
  return signature === LOCAL_SIGNATURE || signature === EOCD_SIGNATURE;
}
