import test from 'node:test';
import assert from 'node:assert/strict';
import { deflateRawSync, deflateSync } from 'node:zlib';
import { inflateRaw, inflateZlib } from '../core/deflate.mjs';

const samples = [
  Buffer.alloc(0),
  Buffer.from('Safe to Send '.repeat(2000)),
  Buffer.from(Array.from({ length: 131072 }, (_, index) => (index * 31) % 251)),
];

for (const level of [0, 1, 6, 9]) {
  test(`inflate raw DEFLATE at level ${level}`, () => {
    for (const sample of samples) assert.deepEqual(Buffer.from(inflateRaw(deflateRawSync(sample, { level }))), sample);
  });
  test(`inflate zlib-wrapped DEFLATE at level ${level}`, () => {
    for (const sample of samples) assert.deepEqual(Buffer.from(inflateZlib(deflateSync(sample, { level }))), sample);
  });
}

test('inflate enforces output limit', () => {
  const compressed = deflateRawSync(Buffer.alloc(100_000, 65));
  assert.throws(() => inflateRaw(compressed, { maxOutputBytes: 1000 }), /safety limit/);
});
