import test from 'node:test';
import assert from 'node:assert/strict';
import { createZip } from '../scripts/lib/zip-writer.mjs';
import { openZip, ZipError } from '../core/zip.mjs';

const archiveBytes = createZip([
  { name: 'hello.txt', data: 'hello world' },
  { name: 'nested/value.xml', data: '<value>42</value>', compress: false },
]);

test('ZIP parser reads stored and deflated entries', () => {
  const archive = openZip(archiveBytes);
  assert.equal(archive.size, 2);
  assert.equal(archive.text('hello.txt'), 'hello world');
  assert.equal(archive.text('nested/value.xml'), '<value>42</value>');
});

test('ZIP parser reports unsafe paths', () => {
  const archive = openZip(createZip([{ name: '../escape.txt', data: 'x' }]));
  assert.equal(archive.diagnostics[0].code, 'UNSAFE_PATH');
  assert.throws(() => archive.read('../escape.txt'), ZipError);
});

test('ZIP parser detects CRC corruption', () => {
  const corrupted = Buffer.from(archiveBytes);
  const index = corrupted.indexOf(Buffer.from('hello world'));
  if (index >= 0) corrupted[index] ^= 1;
  else {
    // Compressed data: change the expected CRC in the central record instead.
    const central = corrupted.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
    corrupted[central + 16] ^= 1;
  }
  const archive = openZip(corrupted);
  assert.throws(() => archive.read('hello.txt'), /CRC|deflate|size/i);
});

test('ZIP parser enforces entry count limit', () => {
  assert.throws(() => openZip(archiveBytes, { maxEntries: 1 }), /entry|entries/i);
});
