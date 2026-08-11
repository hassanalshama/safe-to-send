import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { scan } from '../core/index.mjs';

const fixture = (name) => readFile(new URL(`./fixtures/${name}`, import.meta.url));

test('clean PowerPoint package completes without findings', async () => {
  const report = await scan(await fixture('clean-sample.pptx'), { name: 'clean-sample.pptx' });
  assert.equal(report.verdict.code, 'NO_OBVIOUS_RISKS');
  assert.equal(report.findings.length, 0);
  assert.equal(report.coverage.complete, true);
});

test('unsafe PowerPoint package exposes hidden and recoverable material', async () => {
  const report = await scan(await fixture('unsafe-sample.pptx'), { name: 'unsafe-sample.pptx' });
  const rules = new Set(report.findings.map((item) => item.ruleId));
  for (const expected of [
    'pptx.notes', 'pptx.slide.hidden', 'pptx.object.hidden', 'pptx.object.off-slide', 'pptx.image.cropped',
    'pptx.comments', 'pptx.embedded-files', 'pptx.custom-xml', 'pptx.external.local-path',
    'pptx.metadata.personal', 'pptx.image.metadata',
  ]) assert.ok(rules.has(expected), `missing ${expected}`);
  assert.equal(report.verdict.code, 'DO_NOT_SEND');
  assert.equal(report.coverage.complete, true);
});

test('wrong PowerPoint extension is reported', async () => {
  const report = await scan(await fixture('clean-sample.pptx'), { name: 'presentation.bin' });
  assert.ok(report.findings.some((item) => item.ruleId === 'file.extension-mismatch'));
});
