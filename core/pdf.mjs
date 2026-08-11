// @ts-check

import { inflateRaw, inflateZlib } from './deflate.mjs';
import { finding } from './model.mjs';
import { detectSensitiveText } from './patterns.mjs';
import { bytesToAscii, compact } from './util.mjs';

const MAX_STREAMS = 10_000;
const MAX_DECODED_STREAM_BYTES = 64 * 1024 * 1024;
const MAX_TOTAL_DECODED_BYTES = 256 * 1024 * 1024;

/** @param {string} value */
function decodePdfHex(value) {
  const clean = value.replace(/\s+/g, '');
  const padded = clean.length % 2 ? `${clean}0` : clean;
  const bytes = new Uint8Array(padded.length / 2);
  for (let index = 0; index < padded.length; index += 2) {
    const parsed = Number.parseInt(padded.slice(index, index + 2), 16);
    if (!Number.isFinite(parsed)) return '';
    bytes[index / 2] = parsed;
  }
  return decodePdfBytes(bytes);
}

/** @param {Uint8Array} bytes */
function decodePdfBytes(bytes) {
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    let output = '';
    for (let index = 2; index + 1 < bytes.length; index += 2) {
      output += String.fromCharCode((bytes[index] << 8) | bytes[index + 1]);
    }
    return output;
  }
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
    let output = '';
    for (let index = 2; index + 1 < bytes.length; index += 2) {
      output += String.fromCharCode(bytes[index] | (bytes[index + 1] << 8));
    }
    return output;
  }
  return [...bytes].map((byte) => String.fromCharCode(byte)).join('');
}

/** @param {string} value */
function pdfStringFromLiteral(value) {
  const bytes = [];
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index) & 0xff;
    if (code !== 0x5c) {
      bytes.push(code);
      continue;
    }
    if (index + 1 >= value.length) break;
    const next = value.charCodeAt(++index) & 0xff;
    if (next === 0x6e) bytes.push(0x0a);
    else if (next === 0x72) bytes.push(0x0d);
    else if (next === 0x74) bytes.push(0x09);
    else if (next === 0x62) bytes.push(0x08);
    else if (next === 0x66) bytes.push(0x0c);
    else if (next === 0x0d) {
      if (value.charCodeAt(index + 1) === 0x0a) index += 1;
    } else if (next === 0x0a) {
      // Escaped line continuation.
    } else if (next >= 0x30 && next <= 0x37) {
      let octal = String.fromCharCode(next);
      for (let count = 0; count < 2; count += 1) {
        const candidate = value.charCodeAt(index + 1) & 0xff;
        if (candidate < 0x30 || candidate > 0x37) break;
        octal += value[++index];
      }
      bytes.push(Number.parseInt(octal, 8) & 0xff);
    } else bytes.push(next);
  }
  return decodePdfBytes(Uint8Array.from(bytes));
}

/** @param {string} source @param {number} start */
function parseLiteralAt(source, start) {
  let depth = 1;
  let escaped = false;
  let body = '';
  for (let index = start + 1; index < source.length; index += 1) {
    const char = source[index];
    if (escaped) {
      body += `\\${char}`;
      escaped = false;
      if (char === '\r' && source[index + 1] === '\n') index += 1;
      continue;
    }
    if (char === '\\') {
      escaped = true;
      continue;
    }
    if (char === '(') {
      depth += 1;
      body += char;
      continue;
    }
    if (char === ')') {
      depth -= 1;
      if (depth === 0) return { value: pdfStringFromLiteral(body), end: index + 1 };
      body += char;
      continue;
    }
    body += char;
  }
  return { value: pdfStringFromLiteral(body), end: source.length, unterminated: true };
}

/** @param {string} source @param {number} start */
function parseHexAt(source, start) {
  const end = source.indexOf('>', start + 1);
  if (end < 0) return { value: '', end: source.length, unterminated: true };
  return { value: decodePdfHex(source.slice(start + 1, end)), end: end + 1 };
}

/** @param {string} raw */
function asciiHexDecode(raw) {
  const clean = raw.replace(/\s+/g, '').replace(/>.*$/s, '');
  const padded = clean.length % 2 ? `${clean}0` : clean;
  const output = new Uint8Array(padded.length / 2);
  for (let index = 0; index < padded.length; index += 2) {
    const value = Number.parseInt(padded.slice(index, index + 2), 16);
    if (!Number.isFinite(value)) throw new Error('Invalid ASCIIHex data.');
    output[index / 2] = value;
  }
  return output;
}

/** @param {string} raw */
function ascii85Decode(raw) {
  const clean = raw.replace(/^\s*<~/, '').replace(/~>\s*$/, '').replace(/\s+/g, '');
  const output = [];
  let group = [];
  for (const char of clean) {
    if (char === 'z') {
      if (group.length) throw new Error('Invalid ASCII85 z inside a group.');
      output.push(0, 0, 0, 0);
      continue;
    }
    const value = char.charCodeAt(0) - 33;
    if (value < 0 || value > 84) throw new Error('Invalid ASCII85 character.');
    group.push(value);
    if (group.length === 5) {
      let combined = 0;
      for (const item of group) combined = combined * 85 + item;
      output.push((combined >>> 24) & 0xff, (combined >>> 16) & 0xff, (combined >>> 8) & 0xff, combined & 0xff);
      group = [];
    }
  }
  if (group.length === 1) throw new Error('Invalid ASCII85 tail.');
  if (group.length > 1) {
    const originalLength = group.length;
    while (group.length < 5) group.push(84);
    let combined = 0;
    for (const item of group) combined = combined * 85 + item;
    const tail = [(combined >>> 24) & 0xff, (combined >>> 16) & 0xff, (combined >>> 8) & 0xff, combined & 0xff];
    output.push(...tail.slice(0, originalLength - 1));
  }
  return Uint8Array.from(output);
}

/** @param {string} dictionary */
function filtersFromDictionary(dictionary) {
  const arrayMatch = dictionary.match(/\/Filter\s*\[([\s\S]*?)\]/);
  const source = arrayMatch ? arrayMatch[1] : (dictionary.match(/\/Filter\s*\/([A-Za-z0-9]+)/)?.[1] || '');
  if (!source) return [];
  if (arrayMatch) return [...source.matchAll(/\/([A-Za-z0-9]+)/g)].map((match) => match[1]);
  return [source.replace(/^\//, '')];
}

/** @param {Uint8Array} input @param {string[]} filters */
function decodeStream(input, filters) {
  let bytes = input;
  for (const rawFilter of filters) {
    const filter = rawFilter.replace(/^\//, '');
    if (filter === 'FlateDecode' || filter === 'Fl') {
      try { bytes = inflateZlib(bytes, { maxOutputBytes: MAX_DECODED_STREAM_BYTES }); }
      catch { bytes = inflateRaw(bytes, { maxOutputBytes: MAX_DECODED_STREAM_BYTES }); }
    } else if (filter === 'ASCIIHexDecode' || filter === 'AHx') {
      bytes = asciiHexDecode(bytesToAscii(bytes));
    } else if (filter === 'ASCII85Decode' || filter === 'A85') {
      bytes = ascii85Decode(bytesToAscii(bytes));
    } else {
      const error = new Error(`Unsupported PDF stream filter: ${filter}`);
      // @ts-ignore custom diagnostic field
      error.filter = filter;
      throw error;
    }
  }
  return bytes;
}

/** @param {string} ascii */
function extractStreams(ascii) {
  const streams = [];
  let cursor = 0;
  while (streams.length < MAX_STREAMS) {
    const marker = ascii.indexOf('stream', cursor);
    if (marker < 0) break;
    const before = ascii[marker - 1] || '';
    const after = ascii[marker + 6] || '';
    if ((before && /[A-Za-z0-9]/.test(before)) || (after && !/[\r\n\s]/.test(after))) {
      cursor = marker + 6;
      continue;
    }
    let start = marker + 6;
    if (ascii[start] === '\r' && ascii[start + 1] === '\n') start += 2;
    else if (ascii[start] === '\r' || ascii[start] === '\n') start += 1;
    else {
      cursor = marker + 6;
      continue;
    }
    const dictStart = ascii.lastIndexOf('<<', marker);
    const dictionary = dictStart >= Math.max(0, marker - 64 * 1024) ? ascii.slice(dictStart, marker) : '';
    const declaredLength = Number.parseInt(dictionary.match(/\/Length\s+(\d+)\b/)?.[1] || '', 10);
    let end = -1;
    if (Number.isFinite(declaredLength) && declaredLength >= 0 && start + declaredLength <= ascii.length) {
      const candidate = start + declaredLength;
      const afterData = ascii.slice(candidate, candidate + 32);
      if (/^\s*endstream\b/.test(afterData)) end = candidate;
    }
    if (end < 0) {
      const endMarker = ascii.indexOf('endstream', start);
      if (endMarker < 0) break;
      end = endMarker;
      while (end > start && (ascii[end - 1] === '\r' || ascii[end - 1] === '\n')) end -= 1;
    }
    streams.push({ index: streams.length + 1, dictionary, start, end, filters: filtersFromDictionary(dictionary) });
    cursor = Math.max(end + 9, marker + 6);
  }
  return streams;
}

/** @param {number[]} left @param {number[]} right */
function multiplyMatrix(left, right) {
  const [a, b, c, d, e, f] = left;
  const [g, h, i, j, k, l] = right;
  return [a * g + c * h, b * g + d * h, a * i + c * j, b * i + d * j, a * k + c * l + e, b * k + d * l + f];
}

/** @param {number[]} matrix @param {number} x @param {number} y */
function transform(matrix, x, y) {
  return { x: matrix[0] * x + matrix[2] * y + matrix[4], y: matrix[1] * x + matrix[3] * y + matrix[5] };
}

/** @param {number[]} matrix @param {number} x @param {number} y @param {number} width @param {number} height */
function transformedBox(matrix, x, y, width, height) {
  const points = [transform(matrix, x, y), transform(matrix, x + width, y), transform(matrix, x, y + height), transform(matrix, x + width, y + height)];
  return {
    left: Math.min(...points.map((point) => point.x)),
    right: Math.max(...points.map((point) => point.x)),
    bottom: Math.min(...points.map((point) => point.y)),
    top: Math.max(...points.map((point) => point.y)),
  };
}

/** @param {{left:number,right:number,bottom:number,top:number}} left @param {{left:number,right:number,bottom:number,top:number}} right */
function overlapRatio(left, right) {
  const width = Math.max(0, Math.min(left.right, right.right) - Math.max(left.left, right.left));
  const height = Math.max(0, Math.min(left.top, right.top) - Math.max(left.bottom, right.bottom));
  const overlap = width * height;
  const area = Math.max(1, (left.right - left.left) * (left.top - left.bottom));
  return overlap / area;
}

/** @param {string} source */
function tokenizeContent(source) {
  const tokens = [];
  let index = 0;
  const whitespace = /[\x00\x09\x0a\x0c\x0d\x20]/;
  const delimiter = /[\s()<>\[\]{}\/%]/;

  const readArray = () => {
    const values = [];
    index += 1;
    while (index < source.length) {
      while (index < source.length && whitespace.test(source[index])) index += 1;
      if (source[index] === ']') { index += 1; break; }
      if (source[index] === '(') {
        const parsed = parseLiteralAt(source, index);
        values.push({ type: 'string', value: parsed.value });
        index = parsed.end;
      } else if (source[index] === '<' && source[index + 1] !== '<') {
        const parsed = parseHexAt(source, index);
        values.push({ type: 'string', value: parsed.value });
        index = parsed.end;
      } else {
        const start = index;
        while (index < source.length && !whitespace.test(source[index]) && source[index] !== ']') index += 1;
        const raw = source.slice(start, index);
        const number = Number(raw);
        values.push(Number.isFinite(number) ? { type: 'number', value: number } : { type: 'word', value: raw });
      }
    }
    return { type: 'array', value: values };
  };

  while (index < source.length && tokens.length < 300_000) {
    const char = source[index];
    if (whitespace.test(char)) { index += 1; continue; }
    if (char === '%') {
      while (index < source.length && source[index] !== '\n' && source[index] !== '\r') index += 1;
      continue;
    }
    if (char === '(') {
      const parsed = parseLiteralAt(source, index);
      tokens.push({ type: 'string', value: parsed.value });
      index = parsed.end;
      continue;
    }
    if (char === '<' && source[index + 1] !== '<') {
      const parsed = parseHexAt(source, index);
      tokens.push({ type: 'string', value: parsed.value });
      index = parsed.end;
      continue;
    }
    if (char === '[') { tokens.push(readArray()); continue; }
    if (char === '/') {
      const start = index;
      index += 1;
      while (index < source.length && !delimiter.test(source[index])) index += 1;
      tokens.push({ type: 'name', value: source.slice(start, index) });
      continue;
    }
    if (char === '<' && source[index + 1] === '<') { tokens.push({ type: 'dict-start', value: '<<' }); index += 2; continue; }
    if (char === '>' && source[index + 1] === '>') { tokens.push({ type: 'dict-end', value: '>>' }); index += 2; continue; }
    const start = index;
    while (index < source.length && !whitespace.test(source[index]) && !/[()<>\[\]{}\/]/.test(source[index])) index += 1;
    if (start === index) { index += 1; continue; }
    const raw = source.slice(start, index);
    const number = Number(raw);
    tokens.push(Number.isFinite(number) ? { type: 'number', value: number } : { type: 'word', value: raw });
  }
  return tokens;
}

/** @param {string} source */
function analyzeContent(source) {
  const tokens = tokenizeContent(source);
  const texts = [];
  const rectangles = [];
  const invisible = [];
  const pale = [];
  const offPage = [];
  let operands = [];
  let ctm = [1, 0, 0, 1, 0, 0];
  let stack = [];
  let fill = { r: 0, g: 0, b: 0 };
  let pathRectangles = [];
  let textMatrix = [1, 0, 0, 1, 0, 0];
  let lineMatrix = [1, 0, 0, 1, 0, 0];
  let fontSize = 12;
  let renderMode = 0;
  let horizontalScale = 100;
  let leading = 0;
  let pageBox = { left: 0, bottom: 0, right: 612, top: 792 };

  const numbers = (count) => {
    const slice = operands.slice(-count);
    if (slice.length !== count || slice.some((item) => item.type !== 'number')) return null;
    return slice.map((item) => item.value);
  };
  const darkFill = () => fill.r <= 0.15 && fill.g <= 0.15 && fill.b <= 0.15;
  const paleFill = () => fill.r >= 0.94 && fill.g >= 0.94 && fill.b >= 0.94;
  const showText = (text) => {
    const clean = compact(String(text || ''), 300);
    if (!clean) return;
    const count = Math.max(1, [...clean].length);
    const width = Math.max(fontSize * 0.35, count * Math.abs(fontSize) * 0.5 * Math.abs(horizontalScale / 100));
    const height = Math.max(1, Math.abs(fontSize));
    const combined = multiplyMatrix(ctm, textMatrix);
    const box = transformedBox(combined, 0, -height * 0.2, width, height);
    const item = { text: clean, box, renderMode, fill: { ...fill } };
    texts.push(item);
    if (renderMode === 3 || renderMode === 7) invisible.push(item);
    else if (paleFill()) pale.push(item);
    if (box.right < pageBox.left || box.left > pageBox.right || box.top < pageBox.bottom || box.bottom > pageBox.top) offPage.push(item);
    const advance = width / Math.max(0.01, Math.abs(ctm[0] || 1));
    textMatrix = multiplyMatrix(textMatrix, [1, 0, 0, 1, advance, 0]);
  };

  for (const token of tokens) {
    if (token.type !== 'word') { operands.push(token); continue; }
    const operator = token.value;
    if (operator === 'q') stack.push({ ctm: [...ctm], fill: { ...fill } });
    else if (operator === 'Q') {
      const state = stack.pop();
      if (state) { ctm = state.ctm; fill = state.fill; }
    } else if (operator === 'cm') {
      const values = numbers(6);
      if (values) ctm = multiplyMatrix(ctm, values);
    } else if (operator === 'g') {
      const values = numbers(1); if (values) fill = { r: values[0], g: values[0], b: values[0] };
    } else if (operator === 'rg') {
      const values = numbers(3); if (values) fill = { r: values[0], g: values[1], b: values[2] };
    } else if (operator === 'k') {
      const values = numbers(4);
      if (values) {
        const [c, m, y, k] = values;
        fill = { r: 1 - Math.min(1, c + k), g: 1 - Math.min(1, m + k), b: 1 - Math.min(1, y + k) };
      }
    } else if (operator === 're') {
      const values = numbers(4);
      if (values) pathRectangles.push(transformedBox(ctm, values[0], values[1], values[2], values[3]));
    } else if (['f', 'F', 'f*', 'B', 'B*', 'b', 'b*'].includes(operator)) {
      if (darkFill()) rectangles.push(...pathRectangles.map((box) => ({ box, fill: { ...fill } })));
      pathRectangles = [];
    } else if (['n', 'S', 's'].includes(operator)) pathRectangles = [];
    else if (operator === 'BT') {
      textMatrix = [1, 0, 0, 1, 0, 0];
      lineMatrix = [1, 0, 0, 1, 0, 0];
    } else if (operator === 'Tf') {
      const values = numbers(1); if (values) fontSize = values[0];
    } else if (operator === 'Tr') {
      const values = numbers(1); if (values) renderMode = values[0];
    } else if (operator === 'Tz') {
      const values = numbers(1); if (values) horizontalScale = values[0];
    } else if (operator === 'TL') {
      const values = numbers(1); if (values) leading = values[0];
    } else if (operator === 'Tm') {
      const values = numbers(6); if (values) { textMatrix = values; lineMatrix = [...values]; }
    } else if (operator === 'Td' || operator === 'TD') {
      const values = numbers(2);
      if (values) {
        if (operator === 'TD') leading = -values[1];
        lineMatrix = multiplyMatrix(lineMatrix, [1, 0, 0, 1, values[0], values[1]]);
        textMatrix = [...lineMatrix];
      }
    } else if (operator === 'T*') {
      lineMatrix = multiplyMatrix(lineMatrix, [1, 0, 0, 1, 0, -leading]);
      textMatrix = [...lineMatrix];
    } else if (operator === 'Tj' || operator === "'") {
      if (operator === "'") {
        lineMatrix = multiplyMatrix(lineMatrix, [1, 0, 0, 1, 0, -leading]);
        textMatrix = [...lineMatrix];
      }
      const item = operands.at(-1);
      if (item?.type === 'string') showText(item.value);
    } else if (operator === '"') {
      const item = operands.at(-1);
      if (item?.type === 'string') showText(item.value);
    } else if (operator === 'TJ') {
      const array = operands.at(-1);
      if (array?.type === 'array') {
        for (const item of array.value) if (item.type === 'string') showText(item.value);
      }
    }
    operands = [];
  }

  const covered = [];
  for (const text of texts) {
    if (!text.text || text.renderMode === 3 || text.renderMode === 7) continue;
    for (const rectangle of rectangles) {
      const ratio = overlapRatio(text.box, rectangle.box);
      if (ratio >= 0.55) {
        covered.push({ ...text, ratio });
        break;
      }
    }
  }
  return { texts, rectangles, covered, invisible, pale, offPage };
}

/** @param {string} source @param {string} key */
function extractStringValues(source, key) {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const expression = new RegExp(`\\/${escaped}\\s*`, 'g');
  const values = [];
  for (const match of source.matchAll(expression)) {
    let cursor = (match.index || 0) + match[0].length;
    while (/\s/.test(source[cursor] || '')) cursor += 1;
    if (source[cursor] === '(') {
      const parsed = parseLiteralAt(source, cursor);
      if (parsed.value) values.push(parsed.value);
    } else if (source[cursor] === '<' && source[cursor + 1] !== '<') {
      const parsed = parseHexAt(source, cursor);
      if (parsed.value) values.push(parsed.value);
    }
    if (values.length >= 30) break;
  }
  return values;
}

/** @param {string} value */
function safeEvidence(value) {
  return compact(value.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, ' '), 220);
}

/** @param {string} text @param {string} location @param {ReturnType<typeof finding>[]} findings */
function addSensitiveFindings(text, location, findings) {
  for (const match of detectSensitiveText(text)) {
    findings.push(finding({
      ruleId: `content.${match.ruleId}`,
      severity: match.severity,
      confidence: 'high',
      title: `${match.label} found in concealed content`,
      summary: 'A potentially sensitive value appears in content that may not be obvious in the normal document view.',
      evidence: match.evidence,
      location,
      remediation: match.severity === 'high'
        ? 'If this is an active credential, revoke or rotate it. Remove the concealed content, create a fresh copy, and scan again.'
        : 'Confirm the value is intended for the recipient. If not, remove the concealed content, create a fresh copy, and scan again.',
      tags: ['sensitive-content', 'hidden-content'],
    }));
  }
}

/**
 * @param {Uint8Array} bytes
 * @returns {{findings: ReturnType<typeof finding>[], coverage: {complete:boolean, checks:string[], limitations:string[], details:Record<string,unknown>}}}
 */
export function scanPdf(bytes) {
  const findings = [];
  const checks = [];
  const limitations = [];
  const details = {};
  const ascii = bytesToAscii(bytes);

  checks.push('PDF signature and structural markers');
  if (!ascii.startsWith('%PDF-')) {
    findings.push(finding({
      ruleId: 'pdf.signature.mismatch', severity: 'high', title: 'File does not have a valid PDF signature',
      summary: 'The filename indicates PDF, but the file does not begin with the PDF signature.',
      remediation: 'Do not share the file until its source and true format are verified.', tags: ['format'],
    }));
    return { findings, coverage: { complete: false, checks, limitations: ['PDF content was not inspected because the signature is invalid.'], details } };
  }
  details.pdfVersion = ascii.slice(5, 8);

  const encrypted = /\/Encrypt\b/.test(ascii);
  if (encrypted) {
    findings.push(finding({
      ruleId: 'pdf.encryption', severity: 'info', title: 'Encrypted PDF detected',
      summary: 'Encrypted content cannot be fully inspected without decrypting the document first.',
      remediation: 'Scan a decrypted copy in a controlled environment before relying on this report.', tags: ['coverage'],
    }));
    limitations.push('Encrypted PDF content may not be readable by the scanner.');
  }

  checks.push('Metadata and document properties');
  const metadataFields = [
    ['Author', 'Author'], ['Creator', 'Creator application'], ['Producer', 'PDF producer'],
    ['Subject', 'Subject'], ['Keywords', 'Keywords'], ['Title', 'Title'],
  ];
  const metadata = [];
  for (const [key, label] of metadataFields) {
    for (const value of extractStringValues(ascii, key)) {
      const clean = safeEvidence(value);
      if (clean) metadata.push({ key, label, value: clean });
    }
  }
  const personalMetadata = metadata.filter((item) => ['Author', 'Creator', 'Producer'].includes(item.key));
  if (personalMetadata.length) {
    findings.push(finding({
      ruleId: 'pdf.metadata.personal', severity: 'medium', title: 'Authoring metadata remains in the PDF',
      summary: 'The file contains author or software-identifying properties that recipients can inspect.',
      evidence: personalMetadata.slice(0, 5).map((item) => `${item.label}: ${item.value}`).join('; '),
      remediation: 'Remove document properties in the source application, export a fresh PDF, and scan the exported file again.',
      tags: ['metadata', 'identity'], data: { fields: personalMetadata.slice(0, 10) },
    }));
  }

  const eofCount = (ascii.match(/%%EOF/g) || []).length;
  const startXrefCount = (ascii.match(/startxref/g) || []).length;
  details.revisions = Math.max(eofCount, startXrefCount);
  checks.push('Incremental revisions and prior-save markers');
  if (eofCount > 1 || startXrefCount > 1 || /\/Prev\s+\d+/.test(ascii)) {
    findings.push(finding({
      ruleId: 'pdf.revisions.incremental', severity: 'medium', confidence: 'high', title: 'Earlier PDF revisions may remain recoverable',
      summary: 'The file contains multiple end-of-file or cross-reference revision markers, consistent with incremental saves.',
      evidence: `${eofCount} EOF marker${eofCount === 1 ? '' : 's'}; ${startXrefCount} startxref marker${startXrefCount === 1 ? '' : 's'}`,
      remediation: 'Rewrite the PDF into a new file using a trusted full-save or sanitization workflow, then rescan it.',
      tags: ['revision-history', 'recoverable-content'],
    }));
  }

  checks.push('Embedded files, actions, forms, annotations, and optional content');
  if (/\/EmbeddedFiles\b|\/Subtype\s*\/FileAttachment\b|\/Type\s*\/Filespec\b/.test(ascii)) {
    const names = [...new Set([...extractStringValues(ascii, 'F'), ...extractStringValues(ascii, 'UF')])].slice(0, 10);
    findings.push(finding({
      ruleId: 'pdf.attachments', severity: 'high', title: 'Embedded file or file attachment detected',
      summary: 'The PDF package appears to contain another file that may be accessible to the recipient.',
      evidence: names.length ? names.map(safeEvidence).join(', ') : 'EmbeddedFiles, FileAttachment, or Filespec structure found',
      remediation: 'Remove attachments unless they are intentional. Re-export or sanitize the PDF and verify the result.',
      tags: ['attachment', 'hidden-content'],
    }));
  }
  if (/\/JavaScript\b|\/JS\s*(?:\(|<)|\/OpenAction\b|\/AA\b|\/Launch\b|\/SubmitForm\b/.test(ascii)) {
    const actionTypes = ['JavaScript', 'OpenAction', 'AA', 'Launch', 'SubmitForm'].filter((name) => new RegExp(`\\/${name}\\b`).test(ascii));
    findings.push(finding({
      ruleId: 'pdf.active-content', severity: /\/JavaScript\b|\/Launch\b/.test(ascii) ? 'high' : 'medium',
      title: 'Active PDF behavior detected',
      summary: 'The document contains an action that can run, launch, submit, or execute when the PDF is opened or used.',
      evidence: actionTypes.join(', '), remediation: 'Remove active actions and export a static copy before sharing.',
      tags: ['active-content', 'security'],
    }));
  }
  if (/\/AcroForm\b|\/XFA\b/.test(ascii)) {
    const values = [...new Set([...extractStringValues(ascii, 'V'), ...extractStringValues(ascii, 'DV')].map(safeEvidence).filter(Boolean))].slice(0, 8);
    findings.push(finding({
      ruleId: 'pdf.forms', severity: values.length ? 'medium' : 'low', title: 'Interactive form data detected',
      summary: values.length ? 'The PDF contains form fields with saved or default values.' : 'The PDF contains an interactive form structure.',
      evidence: values.length ? values.join('; ') : 'AcroForm or XFA structure found',
      remediation: 'Flatten or clear form fields when the values or interactivity are not intended for the recipient.',
      tags: ['form', 'hidden-content'],
    }));
    if (values.length) addSensitiveFindings(values.join('\n'), 'PDF form values', findings);
  }
  if (/\/Annots\b|\/Subtype\s*\/(?:Text|FreeText|Popup|Stamp|Ink|Highlight|Squiggly|Underline|StrikeOut)\b/.test(ascii)) {
    const comments = extractStringValues(ascii, 'Contents').map(safeEvidence).filter(Boolean).slice(0, 12);
    findings.push(finding({
      ruleId: 'pdf.annotations', severity: comments.length ? 'medium' : 'low', title: 'Comments or annotations detected',
      summary: comments.length ? 'Annotation text may be visible through a PDF reader even when it is not prominent on the page.' : 'The PDF contains annotation structures.',
      evidence: comments.length ? comments.join(' | ') : 'Annotation markers found',
      remediation: 'Delete comments and annotations or flatten a reviewed copy before sharing.', tags: ['comments', 'hidden-content'],
    }));
    if (comments.length) addSensitiveFindings(comments.join('\n'), 'PDF annotations', findings);
  }
  if (/\/OCProperties\b|\/Type\s*\/OCG\b/.test(ascii)) {
    findings.push(finding({
      ruleId: 'pdf.layers', severity: 'medium', title: 'Optional content layers detected',
      summary: 'The PDF includes content groups that a recipient may be able to show or hide.',
      remediation: 'Flatten optional-content layers into a reviewed static output before sharing.', tags: ['layer', 'hidden-content'],
    }));
  }

  checks.push('Decoded content streams');
  const streamRecords = extractStreams(ascii);
  details.streams = streamRecords.length;
  if (streamRecords.length >= MAX_STREAMS) limitations.push(`Only the first ${MAX_STREAMS} PDF streams were considered.`);
  let decodedTotal = 0;
  let decodedCount = 0;
  let unsupportedCount = 0;
  let failedCount = 0;
  let coveredCount = 0;
  let invisibleCount = 0;
  let paleCount = 0;
  let offPageCount = 0;

  for (const record of streamRecords) {
    if (decodedTotal >= MAX_TOTAL_DECODED_BYTES) {
      limitations.push(`Decoded stream data reached the ${MAX_TOTAL_DECODED_BYTES}-byte aggregate safety limit.`);
      break;
    }
    const raw = Uint8Array.from(ascii.slice(record.start, record.end), (char) => char.charCodeAt(0) & 0xff);
    let decoded;
    try {
      decoded = decodeStream(raw, record.filters);
      decodedCount += 1;
      decodedTotal += decoded.length;
    } catch (error) {
      if (String(error?.message || '').startsWith('Unsupported PDF stream filter')) unsupportedCount += 1;
      else failedCount += 1;
      continue;
    }
    const source = bytesToAscii(decoded);
    if (!source || source.length > MAX_DECODED_STREAM_BYTES) continue;
    const analysis = analyzeContent(source);
    for (const item of analysis.covered.slice(0, 20)) {
      coveredCount += 1;
      const location = `PDF stream ${record.index}`;
      findings.push(finding({
        ruleId: 'pdf.redaction.overlay', severity: 'high', confidence: 'medium', title: 'Recoverable text appears beneath an opaque rectangle',
        summary: 'Text remains in the content stream and appears geometrically covered rather than removed.',
        evidence: safeEvidence(item.text), location,
        remediation: 'Use a true redaction tool that removes the underlying content, apply the redactions, save a new file, and rescan it.',
        tags: ['redaction', 'recoverable-content'], data: { overlapRatio: Number(item.ratio.toFixed(2)) },
      }));
      addSensitiveFindings(item.text, location, findings);
    }
    for (const item of analysis.invisible.slice(0, 20)) {
      invisibleCount += 1;
      const location = `PDF stream ${record.index}`;
      findings.push(finding({
        ruleId: 'pdf.text.invisible', severity: 'medium', confidence: 'high', title: 'Invisible text remains in the PDF',
        summary: 'The content stream uses a non-painting text-rendering mode, so text can remain selectable or extractable without being visibly drawn.',
        evidence: safeEvidence(item.text), location,
        remediation: 'Remove the hidden text from the source document and produce a new PDF. Do not rely on visual inspection alone.',
        tags: ['hidden-text', 'recoverable-content'],
      }));
      addSensitiveFindings(item.text, location, findings);
    }
    for (const item of analysis.offPage.slice(0, 10)) {
      offPageCount += 1;
      findings.push(finding({
        ruleId: 'pdf.text.off-page', severity: 'medium', confidence: 'low', title: 'Text may be positioned outside the visible page',
        summary: 'Text coordinates appear to fall outside a standard page boundary. Complex page transforms can cause false positives.',
        evidence: safeEvidence(item.text), location: `PDF stream ${record.index}`,
        remediation: 'Inspect extracted text and the source document. Re-export a clean copy if the content is not intended.',
        tags: ['hidden-text'],
      }));
    }
    for (const item of analysis.pale.slice(0, 5)) {
      paleCount += 1;
      findings.push(finding({
        ruleId: 'pdf.text.pale', severity: 'low', confidence: 'low', title: 'Very light text detected',
        summary: 'Text is drawn in a near-white fill and may be difficult to see on a light page, although it can be legitimate on a dark background.',
        evidence: safeEvidence(item.text), location: `PDF stream ${record.index}`,
        remediation: 'Confirm the text is intentionally visible in context or remove it from the source document.', tags: ['hidden-text'],
      }));
    }
    const streamMetadata = [
      ...extractStringValues(source, 'Author'), ...extractStringValues(source, 'Creator'), ...extractStringValues(source, 'Producer'),
    ].map(safeEvidence).filter(Boolean);
    if (streamMetadata.length) {
      findings.push(finding({
        ruleId: 'pdf.metadata.stream', severity: 'medium', confidence: 'medium', title: 'Metadata found inside a decoded PDF stream',
        summary: 'A decoded metadata or object stream contains authoring information.',
        evidence: streamMetadata.slice(0, 5).join('; '), location: `PDF stream ${record.index}`,
        remediation: 'Sanitize document metadata and create a new PDF before sharing.', tags: ['metadata'],
      }));
    }
  }
  details.decodedStreams = decodedCount;
  details.decodedBytes = decodedTotal;
  details.coveredTextItems = coveredCount;
  details.invisibleTextItems = invisibleCount;
  details.offPageTextItems = offPageCount;
  details.paleTextItems = paleCount;
  if (unsupportedCount) limitations.push(`${unsupportedCount} PDF stream${unsupportedCount === 1 ? '' : 's'} used unsupported filters and could not be decoded.`);
  if (failedCount) limitations.push(`${failedCount} PDF stream${failedCount === 1 ? '' : 's'} could not be decoded because the data was malformed or exceeded a safety limit.`);

  const complete = !encrypted && limitations.length === 0;
  return { findings, coverage: { complete, checks, limitations, details } };
}
