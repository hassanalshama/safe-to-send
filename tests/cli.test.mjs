import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const cli = resolve(root, 'cli/safe-to-send.mjs');

function run(args, input) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, [cli, ...args], { cwd: root, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = ''; let stderr = '';
    child.stdout.on('data', (data) => { stdout += data; });
    child.stderr.on('data', (data) => { stderr += data; });
    child.on('error', reject);
    child.on('close', (code) => resolvePromise({ code, stdout, stderr }));
    if (input) child.stdin.end(input); else child.stdin.end();
  });
}

test('CLI exits zero for clean fixture', async () => {
  const result = await run(['--quiet', 'tests/fixtures/clean-sample.pdf']);
  assert.equal(result.code, 0);
  assert.match(result.stdout, /NO OBVIOUS/);
});

test('CLI exits two for high finding', async () => {
  const result = await run(['--quiet', 'tests/fixtures/unsafe-sample.pdf']);
  assert.equal(result.code, 2);
  assert.match(result.stdout, /DO NOT SEND/);
});

test('CLI emits parseable JSON and SARIF without finding-based failure', async () => {
  const json = await run(['--fail-on', 'never', '--format', 'json', 'tests/fixtures/unsafe-sample.pptx']);
  assert.equal(json.code, 0);
  assert.equal(JSON.parse(json.stdout).verdict.code, 'DO_NOT_SEND');
  const sarif = await run(['--fail-on', 'never', '--format', 'sarif', 'tests/fixtures/unsafe-sample.pdf']);
  assert.equal(sarif.code, 0);
  assert.equal(JSON.parse(sarif.stdout).version, '2.1.0');
});

test('CLI reads standard input', async () => {
  const { readFile } = await import('node:fs/promises');
  const bytes = await readFile(resolve(root, 'tests/fixtures/clean-sample.pdf'));
  const result = await run(['--quiet', '--stdin-name', 'stdin.pdf', '-'], bytes);
  assert.equal(result.code, 0);
  assert.match(result.stdout, /stdin\.pdf/);
});
