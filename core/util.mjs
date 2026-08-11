// @ts-check

/** @param {ArrayBuffer | Uint8Array | DataView} value */
export function toUint8Array(value) {
  if (value instanceof Uint8Array) return value;
  if (value instanceof DataView) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  }
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  throw new TypeError('Expected ArrayBuffer, DataView, or Uint8Array.');
}

/** @param {Uint8Array} bytes */
export function bytesToAscii(bytes) {
  const chunk = 0x8000;
  let output = '';
  for (let offset = 0; offset < bytes.length; offset += chunk) {
    const slice = bytes.subarray(offset, Math.min(offset + chunk, bytes.length));
    output += String.fromCharCode(...slice);
  }
  return output;
}

const utf8Decoder = new TextDecoder('utf-8', { fatal: false });

/** @param {Uint8Array} bytes */
export function bytesToUtf8(bytes) {
  return utf8Decoder.decode(bytes);
}

/** @param {string} value */
export function utf8ToBytes(value) {
  return new TextEncoder().encode(value);
}

/** @param {number} value @param {number} min @param {number} max */
export function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

/** @param {unknown} value */
export function isPlainObject(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

/** @param {string} input @param {number} max */
export function compact(input, max = 180) {
  const normalized = input.replace(/\s+/g, ' ').trim();
  if (normalized.length <= max) return normalized;
  return `${normalized.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
}

/** @param {string} input */
export function redactLikelySecret(input) {
  const clean = compact(input, 240);
  if (clean.length <= 12) return clean;
  return `${clean.slice(0, 6)}…${clean.slice(-4)}`;
}

/** @param {string} filename */
export function extensionOf(filename) {
  const dot = filename.lastIndexOf('.');
  return dot >= 0 ? filename.slice(dot + 1).toLowerCase() : '';
}

/** @param {Uint8Array} bytes */
export async function sha256Hex(bytes) {
  if (!globalThis.crypto?.subtle) return null;
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * Small deterministic hash for finding identifiers. Not cryptographic.
 * @param {string} value
 */
export function fnv1a(value) {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

/** @param {number} byteLength */
export function formatBytes(byteLength) {
  if (!Number.isFinite(byteLength) || byteLength < 0) return 'unknown size';
  if (byteLength < 1024) return `${byteLength} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = byteLength / 1024;
  let unit = units[0];
  for (let index = 1; index < units.length && value >= 1024; index += 1) {
    value /= 1024;
    unit = units[index];
  }
  return `${value >= 10 ? value.toFixed(1) : value.toFixed(2)} ${unit}`;
}

/** @param {string} value */
export function basename(value) {
  return value.replace(/\\/g, '/').split('/').pop() || value;
}

/** @param {unknown} value */
export function jsonSafe(value) {
  return JSON.parse(
    JSON.stringify(value, (_key, item) => {
      if (typeof item === 'bigint') return item.toString();
      if (item instanceof Map) return Object.fromEntries(item);
      if (item instanceof Set) return [...item];
      if (item instanceof Uint8Array) return `[${item.byteLength} bytes]`;
      return item;
    }),
  );
}

/** @param {string} value */
export function escapeMarkdown(value) {
  return value.replace(/([\\`*_{}[\]()#+\-.!|>])/g, '\\$1');
}

/** @param {string} value */
export function escapeHtml(value) {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}
