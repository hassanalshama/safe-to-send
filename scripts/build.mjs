#!/usr/bin/env node

import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dist = join(root, 'dist');

const files = [
  'index.html',
  'methodology.html',
  'cli.html',
  'privacy.html',
  'styles.css',
  'app.mjs',
  'scanner-worker.mjs',
  'manifest.webmanifest',
  'robots.txt',
  'sitemap.xml',
];
const directories = ['assets', 'core', 'examples', 'guides'];

await rm(dist, { recursive: true, force: true });
await mkdir(dist, { recursive: true });
for (const file of files) await cp(join(root, file), join(dist, file));
for (const directory of directories) await cp(join(root, directory), join(dist, directory), { recursive: true });
await cp(join(root, 'docs/report-schema.json'), join(dist, 'report-schema.json'));
await writeFile(join(dist, '.nojekyll'), '');

const notFound = (await readFile(join(root, 'index.html'), 'utf8'))
  .replace(/<title>[^<]*<\/title>/i, '<title>Safe to Send</title>');
await writeFile(join(dist, '404.html'), notFound);

console.log(`Built static site in ${dist}.`);
