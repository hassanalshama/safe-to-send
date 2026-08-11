#!/usr/bin/env node
// @ts-check

import { readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { basename, extname, resolve } from 'node:path';
import process from 'node:process';
import { scan, renderMarkdown, renderStandaloneHtml, renderText, VERSION } from '../core/index.mjs';
import { renderSarif } from '../core/sarif.mjs';

const SUPPORTED = new Set(['.pdf', '.pptx', '.pptm', '.ppsx', '.ppsm', '.potx', '.potm']);
const severityRank = { high: 0, medium: 1, low: 2, info: 3, never: -1 };

const HELP = `Safe to Send ${VERSION}

Inspect PDFs and PowerPoint files for hidden, recoverable, or private content.
Files are processed locally. No network request is made.

Usage:
  safe-to-send [options] <file-or-directory> [...]
  cat document.pdf | safe-to-send --stdin-name document.pdf -

Options:
  -f, --format <name>       text, json, markdown, html, or sarif (default: text)
  -o, --output <path>       Write output to a file instead of stdout
  -r, --recursive           Scan supported files inside directories recursively
      --fail-on <severity>  high, medium, low, info, or never (default: high)
      --max-size <value>    Per-file limit, such as 100MB or 1GB (default: 512MB)
      --stdin-name <name>   Filename used when reading bytes from stdin
      --no-color            Disable terminal colors
  -q, --quiet               Print only the verdict line in text mode
  -v, --version             Print the version
  -h, --help                Print this help

Exit codes:
  0  Scan completed and no finding met --fail-on
  1  Input, argument, or scanner execution error
  2  A finding met --fail-on
  3  A scan was incomplete and no finding met --fail-on
`;

/** @param {string} value */
function parseSize(value) {
  const match = String(value).trim().match(/^(\d+(?:\.\d+)?)\s*(b|kb|kib|mb|mib|gb|gib)?$/i);
  if (!match) throw new Error(`Invalid size: ${value}`);
  const number = Number(match[1]);
  const unit = (match[2] || 'b').toLowerCase();
  const factors = { b: 1, kb: 1000, kib: 1024, mb: 1_000_000, mib: 1_048_576, gb: 1_000_000_000, gib: 1_073_741_824 };
  return Math.floor(number * factors[unit]);
}

/** @param {string[]} argv */
function parseArgs(argv) {
  const options = {
    format: 'text', output: '', recursive: false, failOn: 'high', maxBytes: 512 * 1024 * 1024,
    stdinName: 'stdin.pdf', quiet: false, color: process.stdout.isTTY, inputs: [],
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const take = (label) => {
      const value = argv[++index];
      if (value === undefined) throw new Error(`${label} requires a value.`);
      return value;
    };
    if (argument === '--') options.inputs.push(...argv.slice(index + 1));
    else if (argument === '-h' || argument === '--help') options.help = true;
    else if (argument === '-v' || argument === '--version') options.version = true;
    else if (argument === '-f' || argument === '--format') options.format = take(argument).toLowerCase();
    else if (argument.startsWith('--format=')) options.format = argument.slice(9).toLowerCase();
    else if (argument === '-o' || argument === '--output') options.output = take(argument);
    else if (argument.startsWith('--output=')) options.output = argument.slice(9);
    else if (argument === '-r' || argument === '--recursive') options.recursive = true;
    else if (argument === '--fail-on') options.failOn = take(argument).toLowerCase();
    else if (argument.startsWith('--fail-on=')) options.failOn = argument.slice(10).toLowerCase();
    else if (argument === '--max-size') options.maxBytes = parseSize(take(argument));
    else if (argument.startsWith('--max-size=')) options.maxBytes = parseSize(argument.slice(11));
    else if (argument === '--stdin-name') options.stdinName = take(argument);
    else if (argument.startsWith('--stdin-name=')) options.stdinName = argument.slice(13);
    else if (argument === '--no-color') options.color = false;
    else if (argument === '-q' || argument === '--quiet') options.quiet = true;
    else if (argument === '-') options.inputs.push(argument);
    else if (argument.startsWith('-')) throw new Error(`Unknown option: ${argument}`);
    else options.inputs.push(argument);
  }
  if (!['text', 'json', 'markdown', 'html', 'sarif'].includes(options.format)) throw new Error(`Unsupported format: ${options.format}`);
  if (!(options.failOn in severityRank)) throw new Error(`Invalid --fail-on value: ${options.failOn}`);
  if (options.output && options.format === 'html' && options.inputs.length > 1) throw new Error('HTML output supports one input file at a time.');
  return options;
}

/** @param {string} path @param {boolean} recursive */
async function collect(path, recursive) {
  const info = await stat(path);
  if (info.isFile()) return [path];
  if (!info.isDirectory()) return [];
  const output = [];
  for (const entry of await readdir(path, { withFileTypes: true })) {
    const child = resolve(path, entry.name);
    if (entry.isDirectory() && recursive) output.push(...await collect(child, true));
    else if (entry.isFile() && SUPPORTED.has(extname(entry.name).toLowerCase())) output.push(child);
  }
  return output;
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

/** @param {string} value @param {string} color @param {boolean} enabled */
function paint(value, color, enabled) {
  if (!enabled) return value;
  const code = { red: 31, yellow: 33, blue: 34, green: 32, bold: 1 }[color];
  return `\u001b[${code}m${value}\u001b[0m`;
}

/** @param {any} report @param {boolean} color */
function verdictLine(report, color) {
  const tone = report.verdict.code === 'DO_NOT_SEND' ? 'red' : report.verdict.code === 'REVIEW' || report.verdict.code === 'INCOMPLETE' ? 'yellow' : 'green';
  return `${paint(report.verdict.title.toUpperCase(), tone, color)}  ${report.file.name}  ${report.counts.high}H ${report.counts.medium}M ${report.counts.low}L`;
}

async function main() {
  let options;
  try { options = parseArgs(process.argv.slice(2)); }
  catch (error) { console.error(`safe-to-send: ${error.message}\n\n${HELP}`); process.exitCode = 1; return; }
  if (options.help) { process.stdout.write(HELP); return; }
  if (options.version) { process.stdout.write(`${VERSION}\n`); return; }
  if (!options.inputs.length) { console.error(`safe-to-send: no input files\n\n${HELP}`); process.exitCode = 1; return; }

  const work = [];
  let stdinSeen = false;
  try {
    for (const input of options.inputs) {
      if (input === '-') {
        if (stdinSeen) throw new Error('Standard input can only be specified once.');
        stdinSeen = true;
        work.push({ path: '-', name: options.stdinName, bytes: await readStdin() });
      } else {
        for (const path of await collect(resolve(input), options.recursive)) work.push({ path, name: path, bytes: null });
      }
    }
  } catch (error) {
    console.error(`safe-to-send: ${error.message}`);
    process.exitCode = 1;
    return;
  }
  if (!work.length) { console.error('safe-to-send: no supported files found'); process.exitCode = 1; return; }

  const reports = [];
  let executionError = false;
  for (const item of work) {
    try {
      const bytes = item.bytes || await readFile(item.path);
      reports.push(await scan(bytes, { name: item.path === '-' ? item.name : item.path, maxBytes: options.maxBytes }));
    } catch (error) {
      executionError = true;
      console.error(`safe-to-send: ${item.name}: ${error.message}`);
    }
  }
  if (!reports.length) { process.exitCode = 1; return; }

  let output;
  if (options.format === 'json') output = `${JSON.stringify(reports.length === 1 ? reports[0] : reports, null, 2)}\n`;
  else if (options.format === 'sarif') output = `${JSON.stringify(renderSarif(reports), null, 2)}\n`;
  else if (options.format === 'markdown') output = reports.map(renderMarkdown).join('\n\n---\n\n');
  else if (options.format === 'html') output = renderStandaloneHtml(reports[0]);
  else if (options.quiet) output = `${reports.map((report) => verdictLine(report, options.color && !options.output)).join('\n')}\n`;
  else output = reports.map(renderText).join('\n' + '='.repeat(72) + '\n\n');

  if (options.output) await writeFile(resolve(options.output), output);
  else process.stdout.write(output);

  const threshold = severityRank[options.failOn];
  const meetsThreshold = reports.some((report) => report.findings.some((item) => severityRank[item.severity] <= threshold));
  const incomplete = reports.some((report) => !report.coverage.complete);
  if (executionError) process.exitCode = 1;
  else if (meetsThreshold) process.exitCode = 2;
  else if (incomplete) process.exitCode = 3;
}

await main();
