// @ts-check

import { renderMarkdown, renderStandaloneHtml, renderText, scan, VERSION } from './core/index.mjs';

const MAX_BYTES = 200 * 1024 * 1024;
const SUPPORTED = new Set(['pdf', 'pptx', 'pptm', 'ppsx', 'ppsm', 'potx', 'potm']);

const fileInput = /** @type {HTMLInputElement} */ (document.querySelector('#file-input'));
const dropZone = /** @type {HTMLElement} */ (document.querySelector('#drop-zone'));
const queue = /** @type {HTMLElement} */ (document.querySelector('#queue'));
const results = /** @type {HTMLElement} */ (document.querySelector('#results'));
const queueTemplate = /** @type {HTMLTemplateElement} */ (document.querySelector('#queue-template'));
const reportTemplate = /** @type {HTMLTemplateElement} */ (document.querySelector('#report-template'));
const chooseBottom = /** @type {HTMLButtonElement} */ (document.querySelector('#choose-bottom'));
const copyCommand = /** @type {HTMLButtonElement} */ (document.querySelector('#copy-command'));
const versionElement = document.querySelector('#version');
if (versionElement) versionElement.textContent = VERSION;

/** @type {Worker | null} */
let worker = null;
/** @type {Map<string, {resolve:(value:any)=>void,reject:(reason:Error)=>void}>} */
const jobs = new Map();
let sequence = 0;

try {
  worker = new Worker(new URL('./scanner-worker.mjs', import.meta.url), { type: 'module', name: 'safe-to-send-scanner' });
  worker.addEventListener('message', (event) => {
    const { id, report, error } = event.data;
    const job = jobs.get(id);
    if (!job) return;
    jobs.delete(id);
    if (error) job.reject(new Error(error));
    else job.resolve(report);
  });
  worker.addEventListener('error', (event) => {
    for (const job of jobs.values()) job.reject(new Error(event.message || 'Scanner worker failed.'));
    jobs.clear();
    worker?.terminate();
    worker = null;
  });
} catch {
  worker = null;
}

/** @param {File} file */
async function scanInWorker(file) {
  const buffer = await file.arrayBuffer();
  if (!worker) return scan(buffer, { name: file.name, type: file.type, maxBytes: MAX_BYTES });
  const id = `scan-${Date.now()}-${sequence++}`;
  return new Promise((resolve, reject) => {
    jobs.set(id, { resolve, reject });
    worker.postMessage({ id, buffer, name: file.name, type: file.type, maxBytes: MAX_BYTES }, [buffer]);
  });
}

/** @param {number} bytes */
function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB'];
  let value = bytes / 1024;
  let unit = units[0];
  for (let index = 1; index < units.length && value >= 1024; index += 1) { value /= 1024; unit = units[index]; }
  return `${value >= 10 ? value.toFixed(1) : value.toFixed(2)} ${unit}`;
}

/** @param {string} name */
function extension(name) {
  return name.includes('.') ? name.split('.').pop().toLowerCase() : '';
}

/** @param {string} message */
function toast(message) {
  document.querySelector('.toast')?.remove();
  const element = document.createElement('div');
  element.className = 'toast';
  element.setAttribute('role', 'status');
  element.textContent = message;
  document.body.append(element);
  window.setTimeout(() => element.remove(), 2600);
}

/** @param {string} text */
async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const area = document.createElement('textarea');
    area.value = text;
    area.style.position = 'fixed';
    area.style.opacity = '0';
    document.body.append(area);
    area.select();
    document.execCommand('copy');
    area.remove();
  }
}

/** @param {string} name @param {string} content @param {string} type */
function download(name, content, type) {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  document.body.append(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** @param {string} name */
function reportBaseName(name) {
  const leaf = name.replaceAll('\\', '/').split('/').pop() || 'document';
  return leaf.replace(/\.[^.]+$/, '').replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'document';
}

/** @param {string} label @param {string} value */
function definition(label, value) {
  const fragment = document.createDocumentFragment();
  const dt = document.createElement('dt'); dt.textContent = label;
  const dd = document.createElement('dd'); dd.textContent = value;
  fragment.append(dt, dd);
  return fragment;
}

/** @param {any} item */
function renderFinding(item) {
  const article = document.createElement('article');
  article.className = `finding ${item.severity}`;
  const top = document.createElement('div'); top.className = 'finding-top';
  const title = document.createElement('h4'); title.textContent = item.title;
  const confidence = document.createElement('span'); confidence.className = 'confidence'; confidence.textContent = `${item.confidence} confidence`;
  top.append(title, confidence);
  const summary = document.createElement('p'); summary.textContent = item.summary;
  article.append(top, summary);

  const list = document.createElement('dl');
  if (item.location) list.append(definition('Location', item.location));
  if (item.evidence) list.append(definition('Evidence', item.evidence));
  if (item.remediation) {
    const fragment = definition('Fix', item.remediation);
    fragment.lastChild.classList.add('fix');
    list.append(fragment);
  }
  if (list.children.length) article.append(list);
  const rule = document.createElement('code'); rule.className = 'rule-id'; rule.textContent = item.ruleId;
  article.append(rule);
  return article;
}

/** @param {any} report */
function renderReport(report) {
  const card = /** @type {HTMLElement} */ (reportTemplate.content.firstElementChild.cloneNode(true));
  card.dataset.verdict = report.verdict.code;
  card.querySelector('.report-file').textContent = `${report.file.name} · ${formatBytes(report.file.size)}`;
  card.querySelector('.report-verdict').textContent = report.verdict.title;
  card.querySelector('.report-summary').textContent = report.verdict.summary;

  const counts = card.querySelector('.report-counts');
  for (const severity of ['high', 'medium', 'low', 'info']) {
    const pill = document.createElement('div'); pill.className = `count-pill ${severity}`;
    const strong = document.createElement('strong'); strong.textContent = String(report.counts[severity]);
    const label = document.createElement('span'); label.textContent = severity;
    pill.append(strong, label); counts.append(pill);
  }

  const alert = /** @type {HTMLElement} */ (card.querySelector('.coverage-alert'));
  if (!report.coverage.complete) {
    alert.hidden = false;
    alert.textContent = report.coverage.limitations.length
      ? `Scan coverage is incomplete: ${report.coverage.limitations.join(' ')}`
      : 'Scan coverage is incomplete. Do not treat the absence of findings as clearance.';
  }

  const groups = card.querySelector('.finding-groups');
  if (!report.findings.length) {
    const empty = document.createElement('div');
    empty.className = 'empty-findings';
    empty.textContent = 'No findings from the enabled checks.';
    groups.append(empty);
  } else {
    for (const severity of ['high', 'medium', 'low', 'info']) {
      const items = report.findings.filter((item) => item.severity === severity);
      if (!items.length) continue;
      const details = document.createElement('details');
      details.className = 'finding-group';
      if (severity === 'high' || severity === 'medium') details.open = true;
      const summary = document.createElement('summary');
      const dot = document.createElement('span'); dot.className = `severity-dot ${severity}`;
      const label = document.createElement('span'); label.textContent = severity[0].toUpperCase() + severity.slice(1);
      const groupCount = document.createElement('span'); groupCount.className = 'group-count'; groupCount.textContent = `${items.length} finding${items.length === 1 ? '' : 's'}`;
      summary.append(dot, label, groupCount);
      const list = document.createElement('div'); list.className = 'findings-list';
      for (const item of items) list.append(renderFinding(item));
      details.append(summary, list); groups.append(details);
    }
  }

  const coverage = card.querySelector('.coverage-content');
  const dl = document.createElement('dl');
  dl.append(
    definition('Complete', report.coverage.complete ? 'Yes' : 'No'),
    definition('SHA-256', report.file.sha256 || 'Unavailable'),
    definition('Scanned', new Date(report.scannedAt).toLocaleString()),
    definition('Duration', `${report.durationMs} ms`),
    definition('Scanner', `${report.scanner.name} ${report.scanner.version}`),
  );
  coverage.append(dl);
  const checksTitle = document.createElement('strong'); checksTitle.textContent = 'Checks completed';
  const checks = document.createElement('ul');
  for (const item of report.coverage.checks) { const li = document.createElement('li'); li.textContent = item; checks.append(li); }
  coverage.append(checksTitle, checks);
  if (report.coverage.limitations.length) {
    const limitTitle = document.createElement('strong'); limitTitle.textContent = 'Limitations';
    const limits = document.createElement('ul');
    for (const item of report.coverage.limitations) { const li = document.createElement('li'); li.textContent = item; limits.append(li); }
    coverage.append(limitTitle, limits);
  }

  const base = `${reportBaseName(report.file.name)}.safe-to-send`;
  card.querySelector('.action-copy').addEventListener('click', async () => {
    await copyText(renderText(report));
    toast('Report summary copied.');
  });
  card.querySelector('.action-json').addEventListener('click', () => download(`${base}.json`, `${JSON.stringify(report, null, 2)}\n`, 'application/json'));
  card.querySelector('.action-markdown').addEventListener('click', () => download(`${base}.md`, renderMarkdown(report), 'text/markdown'));
  card.querySelector('.action-html').addEventListener('click', () => download(`${base}.html`, renderStandaloneHtml(report), 'text/html'));
  return card;
}

/** @param {File} file */
function addQueueItem(file) {
  const item = /** @type {HTMLElement} */ (queueTemplate.content.firstElementChild.cloneNode(true));
  item.querySelector('.file-mark').textContent = extension(file.name).toUpperCase().slice(0, 4) || 'FILE';
  item.querySelector('.queue-name').textContent = file.name;
  item.querySelector('.queue-meta').textContent = `${formatBytes(file.size)} · scanning locally`;
  queue.append(item);
  queue.hidden = false;
  return item;
}

/** @param {FileList | File[]} input */
async function processFiles(input) {
  const files = [...input];
  if (!files.length) return;
  const accepted = [];
  for (const file of files) {
    const ext = extension(file.name);
    if (!SUPPORTED.has(ext)) { toast(`${file.name}: unsupported file type.`); continue; }
    if (file.size > MAX_BYTES) { toast(`${file.name}: larger than the 200 MB browser limit.`); continue; }
    accepted.push(file);
  }
  if (!accepted.length) return;
  results.hidden = false;
  for (const file of accepted) {
    const queueItem = addQueueItem(file);
    try {
      const report = await scanInWorker(file);
      results.append(renderReport(report));
    } catch (error) {
      const failed = document.createElement('article');
      failed.className = 'report-card';
      failed.dataset.verdict = 'INCOMPLETE';
      const header = document.createElement('div');
      header.className = 'coverage-alert';
      header.textContent = `${file.name}: ${error instanceof Error ? error.message : String(error)}`;
      failed.append(header); results.append(failed);
    } finally {
      queueItem.remove();
      if (!queue.children.length) queue.hidden = true;
    }
  }
  results.scrollIntoView({ behavior: 'smooth', block: 'start' });
  fileInput.value = '';
}

fileInput.addEventListener('change', () => processFiles(fileInput.files || []));
dropZone.addEventListener('click', () => fileInput.click());
dropZone.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); fileInput.click(); }
});
for (const eventName of ['dragenter', 'dragover']) {
  dropZone.addEventListener(eventName, (event) => { event.preventDefault(); dropZone.classList.add('is-dragging'); });
}
for (const eventName of ['dragleave', 'drop']) {
  dropZone.addEventListener(eventName, (event) => { event.preventDefault(); dropZone.classList.remove('is-dragging'); });
}
dropZone.addEventListener('drop', (event) => processFiles(event.dataTransfer?.files || []));
chooseBottom.addEventListener('click', () => fileInput.click());
copyCommand.addEventListener('click', async () => {
  await copyText(copyCommand.dataset.command || 'npx safe-to-send proposal.pptx');
  const previous = copyCommand.textContent;
  copyCommand.textContent = 'Copied';
  window.setTimeout(() => { copyCommand.textContent = previous; }, 1400);
});
