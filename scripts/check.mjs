#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { readdir, readFile, stat } from 'node:fs/promises';
import { dirname, extname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { VERSION } from '../core/model.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ignoredDirectories = new Set(['.git', 'dist', 'node_modules']);
const textExtensions = new Set(['.css', '.html', '.js', '.json', '.md', '.mjs', '.svg', '.txt', '.webmanifest', '.xml', '.yml', '.yaml']);
const syntaxExtensions = new Set(['.js', '.mjs']);
const errors = [];

async function walk(directory) {
  const output = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.isDirectory() && ignoredDirectories.has(entry.name)) continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) output.push(...await walk(path));
    else output.push(path);
  }
  return output;
}

function fail(message) {
  errors.push(message);
}

const files = await walk(root);
for (const path of files) {
  const rel = relative(root, path);
  const extension = extname(path).toLowerCase();
  if (syntaxExtensions.has(extension)) {
    try {
      execFileSync(process.execPath, ['--check', path], { stdio: 'pipe' });
    } catch (error) {
      fail(`${rel}: JavaScript syntax check failed.\n${String(error.stderr || error.message)}`);
    }
  }

  if (!textExtensions.has(extension) && !['LICENSE', 'NOTICE', 'DISCLOSURE'].includes(rel)) continue;
  const text = await readFile(path, 'utf8');
  if (text.includes('\r\n')) fail(`${rel}: CRLF line endings found.`);
  const lines = text.split('\n');
  lines.forEach((line, index) => {
    if (/[ \t]+$/.test(line)) fail(`${rel}:${index + 1}: trailing whitespace.`);
  });
}

for (const path of files.filter((item) => ['.json', '.webmanifest'].includes(extname(item)))) {
  try {
    JSON.parse(await readFile(path, 'utf8'));
  } catch (error) {
    fail(`${relative(root, path)}: invalid JSON (${error.message}).`);
  }
}

const packageJson = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
if (packageJson.version !== VERSION) fail(`package.json version ${packageJson.version} does not match scanner version ${VERSION}.`);

const citation = await readFile(join(root, 'CITATION.cff'), 'utf8');
if (!citation.includes(`version: ${VERSION}`) && !citation.includes(`version: "${VERSION}"`)) {
  fail(`CITATION.cff does not contain version ${VERSION}.`);
}

const schema = JSON.parse(await readFile(join(root, 'docs/report-schema.json'), 'utf8'));
if (schema?.properties?.scanner?.properties?.version?.const !== VERSION) {
  fail(`docs/report-schema.json does not pin scanner.version to ${VERSION}.`);
}

const htmlFiles = files.filter((path) => extname(path) === '.html');
for (const path of htmlFiles) {
  const rel = relative(root, path);
  const text = await readFile(path, 'utf8');
  if (!/^<!doctype html>/i.test(text.trimStart())) fail(`${rel}: missing HTML doctype.`);
  if (!/<meta\s+charset=/i.test(text)) fail(`${rel}: missing charset declaration.`);
  if (!/<meta\s+name=["']viewport["']/i.test(text)) fail(`${rel}: missing viewport declaration.`);
  if (!/<title>[^<]+<\/title>/i.test(text)) fail(`${rel}: missing non-empty title.`);
  if (!/<meta\s+http-equiv=["']Content-Security-Policy["']/i.test(text)) fail(`${rel}: missing Content Security Policy.`);
  if (!/connect-src\s+'none'/.test(text)) fail(`${rel}: CSP must block network connections with connect-src 'none'.`);

  for (const match of text.matchAll(/(?:href|src)=["']([^"']+)["']/g)) {
    const value = match[1];
    if (/^(?:https?:|mailto:|#|data:|blob:|javascript:)/i.test(value)) continue;
    const clean = value.split(/[?#]/)[0];
    if (!clean) continue;
    const target = clean.startsWith('/') ? join(root, clean.slice(1)) : resolve(dirname(path), clean);
    try {
      const targetStat = await stat(target);
      if (targetStat.isDirectory()) {
        await stat(join(target, 'index.html'));
      }
    } catch {
      fail(`${rel}: broken local reference ${value}.`);
    }
  }
}

const rootHtml = await readFile(join(root, 'index.html'), 'utf8');
for (const required of ['id="file-input"', 'id="drop-zone"', 'id="queue-template"', 'id="report-template"']) {
  if (!rootHtml.includes(required)) fail(`index.html: required scanner hook missing: ${required}.`);
}
const appSource = await readFile(join(root, 'app.mjs'), 'utf8');
if (!appSource.includes('scanner-worker.mjs')) fail('app.mjs: scanner worker hook is missing.');

if (errors.length) {
  console.error(`Check failed with ${errors.length} issue${errors.length === 1 ? '' : 's'}:\n`);
  for (const error of errors) console.error(`- ${error}`);
  process.exit(1);
}

console.log(`Checked ${files.length} files: syntax, JSON, versions, HTML policy, and local links are valid.`);
