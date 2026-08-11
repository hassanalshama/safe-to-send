// @ts-check

import { inflateZlib } from './deflate.mjs';
import { bytesToUtf8, compact } from './util.mjs';

/** @param {Uint8Array} bytes @param {number} offset */
function readAscii(bytes, offset, length) {
  return [...bytes.subarray(offset, offset + length)].map((byte) => String.fromCharCode(byte)).join('');
}

/** @param {Uint8Array} bytes */
function parseTiff(bytes) {
  if (bytes.length < 8) return null;
  const byteOrder = readAscii(bytes, 0, 2);
  const little = byteOrder === 'II';
  if (!little && byteOrder !== 'MM') return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const get16 = (offset) => {
    if (offset < 0 || offset + 2 > bytes.length) throw new RangeError('TIFF range');
    return view.getUint16(offset, little);
  };
  const get32 = (offset) => {
    if (offset < 0 || offset + 4 > bytes.length) throw new RangeError('TIFF range');
    return view.getUint32(offset, little);
  };
  const getS32 = (offset) => {
    if (offset < 0 || offset + 4 > bytes.length) throw new RangeError('TIFF range');
    return view.getInt32(offset, little);
  };
  if (get16(2) !== 42) return null;
  const typeSize = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 7: 1, 9: 4, 10: 8 };

  /** @param {number} type @param {number} count @param {number} valueOffset */
  const readValue = (type, count, valueOffset) => {
    const size = (typeSize[type] || 1) * count;
    const offset = size <= 4 ? valueOffset : get32(valueOffset);
    if (offset < 0 || offset + size > bytes.length || count > 10_000) return null;
    if (type === 2) return readAscii(bytes, offset, count).replace(/\0+$/, '').trim();
    if (type === 1 || type === 7) return count === 1 ? bytes[offset] : [...bytes.subarray(offset, offset + count)];
    const values = [];
    for (let index = 0; index < count; index += 1) {
      const position = offset + index * (typeSize[type] || 1);
      if (type === 3) values.push(get16(position));
      else if (type === 4) values.push(get32(position));
      else if (type === 9) values.push(getS32(position));
      else if (type === 5 || type === 10) {
        const numerator = type === 10 ? getS32(position) : get32(position);
        const denominator = type === 10 ? getS32(position + 4) : get32(position + 4);
        values.push(denominator ? numerator / denominator : null);
      }
    }
    return count === 1 ? values[0] : values;
  };

  /** @param {number} offset */
  const readIfd = (offset) => {
    const result = new Map();
    if (!Number.isFinite(offset) || offset < 0 || offset + 2 > bytes.length) return result;
    const count = Math.min(get16(offset), 4096);
    for (let index = 0; index < count; index += 1) {
      const entry = offset + 2 + index * 12;
      if (entry + 12 > bytes.length) break;
      const tag = get16(entry);
      const type = get16(entry + 2);
      const valueCount = get32(entry + 4);
      try { result.set(tag, readValue(type, valueCount, entry + 8)); } catch { /* malformed metadata */ }
    }
    return result;
  };

  try {
    const ifd0 = readIfd(get32(4));
    const exif = typeof ifd0.get(0x8769) === 'number' ? readIfd(ifd0.get(0x8769)) : new Map();
    const gps = typeof ifd0.get(0x8825) === 'number' ? readIfd(ifd0.get(0x8825)) : new Map();
    const named = {
      description: ifd0.get(0x010e),
      make: ifd0.get(0x010f),
      model: ifd0.get(0x0110),
      software: ifd0.get(0x0131),
      dateTime: ifd0.get(0x0132),
      artist: ifd0.get(0x013b),
      copyright: ifd0.get(0x8298),
      dateTimeOriginal: exif.get(0x9003),
      ownerName: exif.get(0xa430),
      cameraSerial: exif.get(0xa431),
      lensModel: exif.get(0xa434),
    };
    const lat = gps.get(0x0002);
    const lon = gps.get(0x0004);
    const latitudeRef = gps.get(0x0001);
    const longitudeRef = gps.get(0x0003);
    let coordinates = null;
    if (Array.isArray(lat) && lat.length >= 3 && Array.isArray(lon) && lon.length >= 3) {
      const toDegrees = (value) => Number(value[0]) + Number(value[1]) / 60 + Number(value[2]) / 3600;
      let latitude = toDegrees(lat);
      let longitude = toDegrees(lon);
      if (String(latitudeRef).toUpperCase().startsWith('S')) latitude *= -1;
      if (String(longitudeRef).toUpperCase().startsWith('W')) longitude *= -1;
      if (Number.isFinite(latitude) && Number.isFinite(longitude)) coordinates = { latitude, longitude };
    }
    return {
      fields: Object.fromEntries(Object.entries(named).filter(([, value]) => value !== undefined && value !== null && String(value).trim())),
      coordinates,
    };
  } catch {
    return null;
  }
}

/** @param {Uint8Array} bytes */
function scanJpeg(bytes) {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
  let offset = 2;
  while (offset + 4 <= bytes.length) {
    if (bytes[offset] !== 0xff) { offset += 1; continue; }
    while (bytes[offset] === 0xff) offset += 1;
    const marker = bytes[offset++];
    if (marker === 0xd9 || marker === 0xda) break;
    if (marker >= 0xd0 && marker <= 0xd7) continue;
    if (offset + 2 > bytes.length) break;
    const length = (bytes[offset] << 8) | bytes[offset + 1];
    if (length < 2 || offset + length > bytes.length) break;
    if (marker === 0xe1 && length >= 8 && readAscii(bytes, offset + 2, 6) === 'Exif\0\0') {
      return parseTiff(bytes.subarray(offset + 8, offset + length));
    }
    offset += length;
  }
  return { fields: {}, coordinates: null };
}

/** @param {Uint8Array} bytes */
function scanPng(bytes) {
  const signature = [137, 80, 78, 71, 13, 10, 26, 10];
  if (bytes.length < 8 || signature.some((value, index) => bytes[index] !== value)) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const text = {};
  let exif = null;
  let offset = 8;
  while (offset + 12 <= bytes.length) {
    const length = view.getUint32(offset, false);
    const type = readAscii(bytes, offset + 4, 4);
    const start = offset + 8;
    const end = start + length;
    if (end + 4 > bytes.length) break;
    const data = bytes.subarray(start, end);
    try {
      if (type === 'tEXt') {
        const separator = data.indexOf(0);
        if (separator > 0) text[readAscii(data, 0, separator)] = readAscii(data, separator + 1, data.length - separator - 1);
      } else if (type === 'zTXt') {
        const separator = data.indexOf(0);
        if (separator > 0 && data[separator + 1] === 0) {
          text[readAscii(data, 0, separator)] = bytesToUtf8(inflateZlib(data.subarray(separator + 2), { maxOutputBytes: 2 * 1024 * 1024 }));
        }
      } else if (type === 'iTXt') {
        const first = data.indexOf(0);
        if (first > 0 && first + 2 < data.length) {
          const keyword = readAscii(data, 0, first);
          const compressed = data[first + 1] === 1;
          let cursor = first + 3;
          const languageEnd = data.indexOf(0, cursor); cursor = languageEnd < 0 ? data.length : languageEnd + 1;
          const translatedEnd = data.indexOf(0, cursor); cursor = translatedEnd < 0 ? data.length : translatedEnd + 1;
          const payload = data.subarray(cursor);
          text[keyword] = compressed ? bytesToUtf8(inflateZlib(payload, { maxOutputBytes: 2 * 1024 * 1024 })) : bytesToUtf8(payload);
        }
      } else if (type === 'eXIf') exif = parseTiff(data);
    } catch { /* ignore malformed optional metadata */ }
    offset = end + 4;
    if (type === 'IEND') break;
  }
  const fields = { ...(exif?.fields || {}) };
  for (const [key, value] of Object.entries(text)) {
    if (/^(author|artist|copyright|comment|description|software|source|creation time)$/i.test(key)) fields[`png:${key}`] = compact(value, 500);
  }
  return { fields, coordinates: exif?.coordinates || null };
}

/** @param {Uint8Array} bytes */
function scanWebp(bytes) {
  if (bytes.length < 16 || readAscii(bytes, 0, 4) !== 'RIFF' || readAscii(bytes, 8, 4) !== 'WEBP') return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 12;
  while (offset + 8 <= bytes.length) {
    const type = readAscii(bytes, offset, 4);
    const length = view.getUint32(offset + 4, true);
    const start = offset + 8;
    if (start + length > bytes.length) break;
    if (type === 'EXIF') return parseTiff(bytes.subarray(start, start + length));
    offset = start + length + (length % 2);
  }
  return { fields: {}, coordinates: null };
}

/**
 * Extract privacy-relevant metadata from common embedded image formats.
 * @param {Uint8Array} bytes
 */
export function inspectImageMetadata(bytes) {
  return scanJpeg(bytes) || scanPng(bytes) || scanWebp(bytes);
}
