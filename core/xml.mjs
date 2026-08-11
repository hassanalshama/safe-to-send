// @ts-check

import { compact } from './util.mjs';

const namedEntities = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'",
};

/** @param {string} value */
export function decodeXml(value) {
  return value.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (whole, entity) => {
    if (entity[0] === '#') {
      const hex = entity[1]?.toLowerCase() === 'x';
      const code = Number.parseInt(entity.slice(hex ? 2 : 1), hex ? 16 : 10);
      if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return whole;
      try { return String.fromCodePoint(code); } catch { return whole; }
    }
    return namedEntities[entity.toLowerCase()] ?? whole;
  });
}

/** @param {string} value */
export function stripXml(value) {
  return decodeXml(
    value
      .replace(/<\?xml[\s\S]*?\?>/gi, '')
      .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
      .replace(/<(?:a:)?br\s*\/?>/gi, '\n')
      .replace(/<\/(?:a:)?p\s*>/gi, '\n')
      .replace(/<[^>]+>/g, ' '),
  ).replace(/[\t ]+/g, ' ').replace(/\s*\n\s*/g, '\n').trim();
}

/** @param {string} raw */
export function parseAttributes(raw) {
  const attributes = {};
  for (const match of raw.matchAll(/([A-Za-z_][\w:.-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) {
    attributes[match[1]] = decodeXml(match[2] ?? match[3] ?? '');
  }
  return attributes;
}

/**
 * @param {string} xml
 * @param {string} localName
 */
export function tags(xml, localName) {
  const escaped = localName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const result = [];
  const expression = new RegExp(`<(?:(?:[A-Za-z_][\\w.-]*):)?${escaped}\\b([^>]*)\\/?>(?:([\\s\\S]*?)<\\/(?:(?:[A-Za-z_][\\w.-]*):)?${escaped}\\s*>)?`, 'gi');
  for (const match of xml.matchAll(expression)) {
    result.push({ attributes: parseAttributes(match[1] || ''), inner: match[2] || '', raw: match[0] });
  }
  return result;
}

/** @param {string} xml @param {string} localName */
export function firstText(xml, localName) {
  const found = tags(xml, localName)[0];
  return found ? compact(stripXml(found.inner), 500) : '';
}

/** @param {string} xml */
export function extractTextRuns(xml) {
  const values = [];
  const expression = /<(?:[A-Za-z_][\w.-]*:)?t\b[^>]*>([\s\S]*?)<\/(?:[A-Za-z_][\w.-]*:)?t\s*>/gi;
  for (const match of xml.matchAll(expression)) values.push(decodeXml(match[1] || ''));
  return values.join(' ').replace(/\s+/g, ' ').trim();
}

/** @param {string} xml */
export function parseRelationships(xml) {
  return tags(xml, 'Relationship').map(({ attributes }) => ({
    id: attributes.Id || attributes.id || '',
    type: attributes.Type || '',
    target: attributes.Target || '',
    external: String(attributes.TargetMode || '').toLowerCase() === 'external',
  })).filter((item) => item.id || item.target);
}

/** @param {string} basePart @param {string} target */
export function resolvePart(basePart, target) {
  if (!target) return '';
  if (target.startsWith('/')) return target.slice(1);
  const base = basePart.split('/');
  base.pop();
  for (const segment of target.replaceAll('\\', '/').split('/')) {
    if (!segment || segment === '.') continue;
    if (segment === '..') base.pop();
    else base.push(segment);
  }
  return base.join('/');
}

/** @param {string} part */
export function relationshipsPart(part) {
  const pieces = part.split('/');
  const name = pieces.pop();
  return [...pieces, '_rels', `${name}.rels`].join('/');
}
