import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { scan, renderMarkdown, renderStandaloneHtml, renderText } from '../core/index.mjs';
import { renderSarif } from '../core/sarif.mjs';

const bytes = await readFile(new URL('./fixtures/unsafe-sample.pdf', import.meta.url));
const report = await scan(bytes, { name: 'unsafe-sample.pdf', scannedAt: '2026-08-10T00:00:00.000Z' });

test('report counts equal finding count', () => {
  assert.equal(report.counts.total, report.findings.length);
  assert.equal(report.counts.high + report.counts.medium + report.counts.low + report.counts.info, report.counts.total);
});

test('finding identifiers are deterministic and unique', async () => {
  const second = await scan(bytes, { name: 'unsafe-sample.pdf', scannedAt: '2026-08-11T00:00:00.000Z' });
  assert.deepEqual(report.findings.map((item) => item.id), second.findings.map((item) => item.id));
  assert.equal(new Set(report.findings.map((item) => item.id)).size, report.findings.length);
});

test('text, Markdown, HTML, and SARIF renderers produce valid envelopes', () => {
  assert.match(renderText(report), /DO NOT SEND YET/);
  assert.match(renderMarkdown(report), /^# Safe to Send report/);
  assert.match(renderStandaloneHtml(report), /^<!doctype html>/);
  const sarif = renderSarif([report]);
  assert.equal(sarif.version, '2.1.0');
  assert.equal(sarif.runs[0].results.length, report.findings.length);
});
