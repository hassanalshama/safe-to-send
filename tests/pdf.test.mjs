import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { scan } from '../core/index.mjs';

const fixture = (name) => readFile(new URL(`./fixtures/${name}`, import.meta.url));

test('clean PDF completes without findings', async () => {
  const report = await scan(await fixture('clean-sample.pdf'), { name: 'clean-sample.pdf', scannedAt: '2026-08-10T00:00:00.000Z' });
  assert.equal(report.verdict.code, 'NO_OBVIOUS_RISKS');
  assert.equal(report.findings.length, 0);
  assert.equal(report.coverage.complete, true);
  assert.match(report.file.sha256, /^[a-f0-9]{64}$/);
});

test('unsafe PDF identifies false redaction and hidden content', async () => {
  const report = await scan(await fixture('unsafe-sample.pdf'), { name: 'unsafe-sample.pdf' });
  const rules = new Set(report.findings.map((item) => item.ruleId));
  for (const expected of ['pdf.redaction.overlay', 'pdf.text.invisible', 'pdf.annotations', 'pdf.metadata.personal', 'pdf.revisions.incremental']) {
    assert.ok(rules.has(expected), `missing ${expected}`);
  }
  assert.equal(report.verdict.code, 'DO_NOT_SEND');
  assert.equal(report.coverage.complete, true);
});

test('invalid PDF signature produces incomplete high finding', async () => {
  const report = await scan(Buffer.from('not a pdf'), { name: 'fake.pdf' });
  assert.equal(report.coverage.complete, false);
  assert.equal(report.counts.high, 1);
});
