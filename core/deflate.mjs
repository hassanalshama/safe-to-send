// @ts-check

class BitReader {
  /** @param {Uint8Array} bytes */
  constructor(bytes) {
    this.bytes = bytes;
    this.offset = 0;
    this.buffer = 0;
    this.bits = 0;
  }

  /** @param {number} count */
  readBits(count) {
    while (this.bits < count) {
      if (this.offset >= this.bytes.length) {
        throw new Error('Unexpected end of deflate stream.');
      }
      this.buffer |= this.bytes[this.offset] << this.bits;
      this.offset += 1;
      this.bits += 8;
    }
    const mask = count === 32 ? 0xffffffff : (1 << count) - 1;
    const value = this.buffer & mask;
    this.buffer >>>= count;
    this.bits -= count;
    return value;
  }

  alignToByte() {
    this.buffer = 0;
    this.bits = 0;
  }
}

class OutputBuffer {
  /** @param {number} limit */
  constructor(limit) {
    this.limit = limit;
    this.bytes = new Uint8Array(Math.min(65536, limit));
    this.length = 0;
  }

  /** @param {number} value */
  push(value) {
    this.ensure(1);
    this.bytes[this.length] = value & 0xff;
    this.length += 1;
  }

  /** @param {Uint8Array} values */
  append(values) {
    this.ensure(values.length);
    this.bytes.set(values, this.length);
    this.length += values.length;
  }

  /** @param {number} distance @param {number} count */
  copy(distance, count) {
    if (distance <= 0 || distance > this.length) {
      throw new Error(`Invalid deflate distance: ${distance}.`);
    }
    this.ensure(count);
    for (let index = 0; index < count; index += 1) {
      this.bytes[this.length] = this.bytes[this.length - distance];
      this.length += 1;
    }
  }

  /** @param {number} extra */
  ensure(extra) {
    const required = this.length + extra;
    if (required > this.limit) {
      throw new Error(`Inflated data exceeds the ${this.limit}-byte safety limit.`);
    }
    if (required <= this.bytes.length) return;
    let size = Math.max(1, this.bytes.length);
    while (size < required) size = Math.min(this.limit, size * 2);
    const next = new Uint8Array(size);
    next.set(this.bytes.subarray(0, this.length));
    this.bytes = next;
  }

  finish() {
    return this.bytes.slice(0, this.length);
  }
}

/** @param {number} value @param {number} width */
function reverseBits(value, width) {
  let output = 0;
  for (let index = 0; index < width; index += 1) {
    output = (output << 1) | (value & 1);
    value >>>= 1;
  }
  return output;
}

/** @param {number[]} lengths */
function buildHuffman(lengths) {
  const maxLength = Math.max(...lengths, 0);
  if (maxLength === 0) throw new Error('Invalid empty Huffman tree.');
  const counts = new Array(maxLength + 1).fill(0);
  for (const length of lengths) {
    if (length < 0 || length > 15) throw new Error('Invalid Huffman code length.');
    if (length > 0) counts[length] += 1;
  }

  let code = 0;
  const nextCode = new Array(maxLength + 1).fill(0);
  for (let bits = 1; bits <= maxLength; bits += 1) {
    code = (code + counts[bits - 1]) << 1;
    nextCode[bits] = code;
  }

  const tables = Array.from({ length: maxLength + 1 }, () => new Map());
  for (let symbol = 0; symbol < lengths.length; symbol += 1) {
    const length = lengths[symbol];
    if (!length) continue;
    const canonical = nextCode[length];
    nextCode[length] += 1;
    tables[length].set(reverseBits(canonical, length), symbol);
  }
  return { maxLength, tables };
}

/** @param {BitReader} reader @param {ReturnType<typeof buildHuffman>} tree */
function decodeSymbol(reader, tree) {
  let code = 0;
  for (let length = 1; length <= tree.maxLength; length += 1) {
    code |= reader.readBits(1) << (length - 1);
    const symbol = tree.tables[length].get(code);
    if (symbol !== undefined) return symbol;
  }
  throw new Error('Invalid Huffman symbol.');
}

const lengthBase = [
  3, 4, 5, 6, 7, 8, 9, 10,
  11, 13, 15, 17,
  19, 23, 27, 31,
  35, 43, 51, 59,
  67, 83, 99, 115,
  131, 163, 195, 227,
  258,
];
const lengthExtra = [
  0, 0, 0, 0, 0, 0, 0, 0,
  1, 1, 1, 1,
  2, 2, 2, 2,
  3, 3, 3, 3,
  4, 4, 4, 4,
  5, 5, 5, 5,
  0,
];
const distanceBase = [
  1, 2, 3, 4,
  5, 7,
  9, 13,
  17, 25,
  33, 49,
  65, 97,
  129, 193,
  257, 385,
  513, 769,
  1025, 1537,
  2049, 3073,
  4097, 6145,
  8193, 12289,
  16385, 24577,
];
const distanceExtra = [
  0, 0, 0, 0,
  1, 1,
  2, 2,
  3, 3,
  4, 4,
  5, 5,
  6, 6,
  7, 7,
  8, 8,
  9, 9,
  10, 10,
  11, 11,
  12, 12,
  13, 13,
];

let fixedTrees;
function getFixedTrees() {
  if (fixedTrees) return fixedTrees;
  const literalLengths = new Array(288).fill(0);
  for (let index = 0; index <= 143; index += 1) literalLengths[index] = 8;
  for (let index = 144; index <= 255; index += 1) literalLengths[index] = 9;
  for (let index = 256; index <= 279; index += 1) literalLengths[index] = 7;
  for (let index = 280; index <= 287; index += 1) literalLengths[index] = 8;
  fixedTrees = {
    literal: buildHuffman(literalLengths),
    distance: buildHuffman(new Array(32).fill(5)),
  };
  return fixedTrees;
}

/** @param {BitReader} reader */
function readDynamicTrees(reader) {
  const literalCount = reader.readBits(5) + 257;
  const distanceCount = reader.readBits(5) + 1;
  const codeLengthCount = reader.readBits(4) + 4;
  const order = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];
  const codeLengths = new Array(19).fill(0);
  for (let index = 0; index < codeLengthCount; index += 1) {
    codeLengths[order[index]] = reader.readBits(3);
  }
  const codeTree = buildHuffman(codeLengths);
  const lengths = [];
  const total = literalCount + distanceCount;
  while (lengths.length < total) {
    const symbol = decodeSymbol(reader, codeTree);
    if (symbol <= 15) {
      lengths.push(symbol);
      continue;
    }
    if (symbol === 16) {
      if (lengths.length === 0) throw new Error('Invalid repeat code in dynamic Huffman tree.');
      const count = reader.readBits(2) + 3;
      const previous = lengths[lengths.length - 1];
      for (let index = 0; index < count; index += 1) lengths.push(previous);
      continue;
    }
    if (symbol === 17) {
      const count = reader.readBits(3) + 3;
      for (let index = 0; index < count; index += 1) lengths.push(0);
      continue;
    }
    if (symbol === 18) {
      const count = reader.readBits(7) + 11;
      for (let index = 0; index < count; index += 1) lengths.push(0);
      continue;
    }
    throw new Error('Invalid dynamic Huffman code.');
  }
  if (lengths.length !== total) throw new Error('Dynamic Huffman tree overrun.');
  const literalLengths = lengths.slice(0, literalCount);
  const distanceLengths = lengths.slice(literalCount);
  if (!literalLengths[256]) throw new Error('Dynamic Huffman tree is missing the end-of-block symbol.');
  if (distanceLengths.every((length) => length === 0)) distanceLengths[0] = 1;
  return {
    literal: buildHuffman(literalLengths),
    distance: buildHuffman(distanceLengths),
  };
}

/**
 * Inflate a raw DEFLATE stream without third-party code.
 * @param {Uint8Array} input
 * @param {{maxOutputBytes?: number}} [options]
 */
export function inflateRaw(input, options = {}) {
  const limit = options.maxOutputBytes ?? 256 * 1024 * 1024;
  const reader = new BitReader(input);
  const output = new OutputBuffer(limit);
  let finalBlock = false;

  while (!finalBlock) {
    finalBlock = Boolean(reader.readBits(1));
    const blockType = reader.readBits(2);
    if (blockType === 0) {
      reader.alignToByte();
      if (reader.offset + 4 > input.length) throw new Error('Truncated stored deflate block.');
      const length = input[reader.offset] | (input[reader.offset + 1] << 8);
      const inverse = input[reader.offset + 2] | (input[reader.offset + 3] << 8);
      reader.offset += 4;
      if ((length ^ 0xffff) !== inverse) throw new Error('Invalid stored deflate block length.');
      if (reader.offset + length > input.length) throw new Error('Truncated stored deflate block data.');
      output.append(input.subarray(reader.offset, reader.offset + length));
      reader.offset += length;
      continue;
    }
    if (blockType === 3) throw new Error('Reserved deflate block type.');
    const trees = blockType === 1 ? getFixedTrees() : readDynamicTrees(reader);
    while (true) {
      const symbol = decodeSymbol(reader, trees.literal);
      if (symbol < 256) {
        output.push(symbol);
        continue;
      }
      if (symbol === 256) break;
      if (symbol < 257 || symbol > 285) throw new Error(`Invalid deflate length symbol: ${symbol}.`);
      const lengthIndex = symbol - 257;
      const length = lengthBase[lengthIndex] + reader.readBits(lengthExtra[lengthIndex]);
      const distanceSymbol = decodeSymbol(reader, trees.distance);
      if (distanceSymbol > 29) throw new Error(`Invalid deflate distance symbol: ${distanceSymbol}.`);
      const distance = distanceBase[distanceSymbol] + reader.readBits(distanceExtra[distanceSymbol]);
      output.copy(distance, length);
    }
  }
  return output.finish();
}

/**
 * Inflate a zlib-wrapped DEFLATE stream, as commonly used by PDF FlateDecode.
 * @param {Uint8Array} input
 * @param {{maxOutputBytes?: number}} [options]
 */
export function inflateZlib(input, options = {}) {
  if (input.length < 6) throw new Error('Truncated zlib stream.');
  const cmf = input[0];
  const flg = input[1];
  if ((cmf & 0x0f) !== 8) throw new Error('Unsupported zlib compression method.');
  if (((cmf << 8) + flg) % 31 !== 0) throw new Error('Invalid zlib header checksum.');
  if (flg & 0x20) throw new Error('Preset zlib dictionaries are not supported.');
  return inflateRaw(input.subarray(2, input.length - 4), options);
}
