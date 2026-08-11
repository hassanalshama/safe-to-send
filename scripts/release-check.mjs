#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { access, readFile, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { scan } from '../core/index.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const mustExist = [
  'dist/index.html',
  'dist/.nojekyll',
  'dist/core/index.mjs',
  'dist/examples/unsafe-sample.pdf',
  'dist/examples/unsafe-sample.pptx',
  'dist/guides/check-pdf-redaction.html',
  'dist/report-schema.json',
];
for (const item of mustExist) await access(join(root, item));

const cleanFiles = ['clean-sample.pdf', 'clean-sample.pptx'];
for (const name of cleanFiles) {
  const bytes = await readFile(join(root, 'tests/fixtures', name));
  const report = await scan(bytes, { name, scannedAt: '2026-08-10T00:00:00.000Z' });
  if (report.verdict.code !== 'NO_OBVIOUS_RISKS' || report.findings.length !== 0 || !report.coverage.complete) {
    throw new Error(`${name} did not pass the release baseline.`);
  }
}

const unsafeExpectations = {
  'unsafe-sample.pdf': ['pdf.redaction.overlay', 'pdf.text.invisible'],
  'unsafe-sample.pptx': ['pptx.notes', 'pptx.slide.hidden', 'pptx.embedded-files'],
};
for (const [name, expectedRules] of Object.entries(unsafeExpectations)) {
  const bytes = await readFile(join(root, 'tests/fixtures', name));
  const report = await scan(bytes, { name, scannedAt: '2026-08-10T00:00:00.000Z' });
  const rules = new Set(report.findings.map((item) => item.ruleId));
  if (report.verdict.code !== 'DO_NOT_SEND') throw new Error(`${name} did not produce a blocking verdict.`);
  for (const rule of expectedRules) if (!rules.has(rule)) throw new Error(`${name} is missing release rule ${rule}.`);
}

const packOutput = JSON.parse(execFileSync('npm', ['pack', '--dry-run', '--json'], { cwd: root, encoding: 'utf8' }));
const packageFiles = new Set(packOutput[0].files.map((item) => item.path));
for (const required of ['cli/safe-to-send.mjs', 'core/index.mjs', 'README.md', 'LICENSE', 'DISCLOSURE', 'docs/report-schema.json']) {
  if (!packageFiles.has(required)) throw new Error(`npm package is missing ${required}.`);
}
for (const forbidden of ['tests/fixtures/unsafe-sample.pptx', 'site.config.json', 'app.mjs']) {
  if (packageFiles.has(forbidden)) throw new Error(`npm package unexpectedly contains ${forbidden}.`);
}

for (const file of ['safe-to-send-0.1.0.tgz']) await rm(join(root, file), { force: true });
console.log(`Release check passed: ${packOutput[0].entryCount} npm files, ${packOutput[0].unpackedSize} unpacked bytes.`);
