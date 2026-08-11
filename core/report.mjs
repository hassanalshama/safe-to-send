// @ts-check

import { escapeHtml, escapeMarkdown, formatBytes } from './util.mjs';

/** @param {any} report */
export function renderText(report) {
  const lines = [
    'SAFE TO SEND',
    '',
    `${report.verdict.title.toUpperCase()}`,
    report.verdict.summary,
    '',
    `File: ${report.file.name}`,
    `Size: ${formatBytes(report.file.size)}`,
    `SHA-256: ${report.file.sha256 || 'unavailable'}`,
    `Scanned: ${report.scannedAt}`,
    `Scanner: ${report.scanner.name} ${report.scanner.version}`,
    '',
    `Findings: ${report.counts.high} high · ${report.counts.medium} medium · ${report.counts.low} low · ${report.counts.info} info`,
  ];
  if (!report.findings.length) lines.push('', 'No findings.');
  for (const severity of ['high', 'medium', 'low', 'info']) {
    const findings = report.findings.filter((item) => item.severity === severity);
    if (!findings.length) continue;
    lines.push('', severity.toUpperCase());
    for (const item of findings) {
      lines.push(`- ${item.title}`);
      lines.push(`  ${item.summary}`);
      if (item.location) lines.push(`  Location: ${item.location}`);
      if (item.evidence) lines.push(`  Evidence: ${item.evidence}`);
      if (item.remediation) lines.push(`  Fix: ${item.remediation}`);
      lines.push(`  Rule: ${item.ruleId} · Confidence: ${item.confidence}`);
    }
  }
  lines.push('', 'COVERAGE');
  lines.push(`Complete: ${report.coverage.complete ? 'yes' : 'no'}`);
  for (const check of report.coverage.checks) lines.push(`- Checked: ${check}`);
  for (const limitation of report.coverage.limitations) lines.push(`- Limitation: ${limitation}`);
  lines.push('', 'This report identifies known indicators. It does not prove that a file is safe.');
  return `${lines.join('\n')}\n`;
}

/** @param {any} report */
export function renderMarkdown(report) {
  const verdict = escapeMarkdown(report.verdict.title);
  const lines = [
    '# Safe to Send report',
    '',
    `## ${verdict}`,
    '',
    escapeMarkdown(report.verdict.summary),
    '',
    '| Field | Value |',
    '|---|---|',
    `| File | \`${escapeMarkdown(report.file.name)}\` |`,
    `| Size | ${escapeMarkdown(formatBytes(report.file.size))} |`,
    `| SHA-256 | \`${report.file.sha256 || 'unavailable'}\` |`,
    `| Scanned | ${escapeMarkdown(report.scannedAt)} |`,
    `| Scanner | ${escapeMarkdown(`${report.scanner.name} ${report.scanner.version}`)} |`,
    `| Findings | ${report.counts.high} high · ${report.counts.medium} medium · ${report.counts.low} low · ${report.counts.info} info |`,
    '',
    '## Findings',
  ];
  if (!report.findings.length) lines.push('', 'No findings.');
  for (const severity of ['high', 'medium', 'low', 'info']) {
    const findings = report.findings.filter((item) => item.severity === severity);
    if (!findings.length) continue;
    lines.push('', `### ${severity[0].toUpperCase()}${severity.slice(1)}`);
    for (const item of findings) {
      lines.push('', `#### ${escapeMarkdown(item.title)}`);
      lines.push('', escapeMarkdown(item.summary));
      if (item.location) lines.push('', `**Location:** ${escapeMarkdown(item.location)}`);
      if (item.evidence) lines.push('', `**Evidence:** ${escapeMarkdown(item.evidence)}`);
      if (item.remediation) lines.push('', `**Fix:** ${escapeMarkdown(item.remediation)}`);
      lines.push('', `**Rule:** \`${item.ruleId}\` · **Confidence:** ${item.confidence}`);
    }
  }
  lines.push('', '## Coverage', '');
  lines.push(`**Complete:** ${report.coverage.complete ? 'Yes' : 'No'}`, '');
  for (const check of report.coverage.checks) lines.push(`- Checked: ${escapeMarkdown(check)}`);
  for (const limitation of report.coverage.limitations) lines.push(`- Limitation: ${escapeMarkdown(limitation)}`);
  lines.push('', '> This report identifies known indicators. It does not prove that a file is safe.', '');
  return lines.join('\n');
}

/** @param {any} report */
export function renderStandaloneHtml(report) {
  const findings = report.findings.map((item) => `
    <article class="finding ${escapeHtml(item.severity)}">
      <div class="finding-head"><span>${escapeHtml(item.severity)}</span><strong>${escapeHtml(item.title)}</strong></div>
      <p>${escapeHtml(item.summary)}</p>
      ${item.location ? `<dl><dt>Location</dt><dd>${escapeHtml(item.location)}</dd></dl>` : ''}
      ${item.evidence ? `<dl><dt>Evidence</dt><dd>${escapeHtml(item.evidence)}</dd></dl>` : ''}
      ${item.remediation ? `<dl><dt>Fix</dt><dd>${escapeHtml(item.remediation)}</dd></dl>` : ''}
      <small>${escapeHtml(item.ruleId)} · ${escapeHtml(item.confidence)} confidence</small>
    </article>`).join('');
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Safe to Send report — ${escapeHtml(report.file.name)}</title>
<style>
:root{font-family:Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:#171717;background:#f5f5f3}body{max-width:880px;margin:0 auto;padding:40px 20px 80px}header,.finding,.coverage{background:#fff;border:1px solid #deded9;border-radius:16px;padding:24px;margin:16px 0;box-shadow:0 4px 24px #0000000a}h1{margin:0 0 8px;font-size:36px}h2{font-size:22px;margin-top:36px}.meta{display:grid;grid-template-columns:140px 1fr;gap:8px;font-size:14px}.meta dt,dt{color:#666}.meta dd,dd{margin:0;overflow-wrap:anywhere}.counts{font-weight:650}.finding{border-left-width:6px}.finding.high{border-left-color:#a3291f}.finding.medium{border-left-color:#b35c00}.finding.low{border-left-color:#3d658c}.finding.info{border-left-color:#777}.finding-head{display:flex;gap:12px;align-items:center}.finding-head span{text-transform:uppercase;font-size:11px;font-weight:800;letter-spacing:.08em}.finding p{line-height:1.55}.finding dl{display:grid;grid-template-columns:90px 1fr;gap:8px;font-size:14px}.finding small{display:block;color:#666;margin-top:16px}.disclaimer{color:#666;font-size:13px;margin-top:32px}@media print{body{background:#fff;padding:0}header,.finding,.coverage{box-shadow:none;break-inside:avoid}}
</style></head><body>
<header><p>SAFE TO SEND</p><h1>${escapeHtml(report.verdict.title)}</h1><p>${escapeHtml(report.verdict.summary)}</p>
<dl class="meta"><dt>File</dt><dd>${escapeHtml(report.file.name)}</dd><dt>Size</dt><dd>${escapeHtml(formatBytes(report.file.size))}</dd><dt>SHA-256</dt><dd>${escapeHtml(report.file.sha256 || 'unavailable')}</dd><dt>Scanned</dt><dd>${escapeHtml(report.scannedAt)}</dd><dt>Scanner</dt><dd>${escapeHtml(`${report.scanner.name} ${report.scanner.version}`)}</dd></dl>
<p class="counts">${report.counts.high} high · ${report.counts.medium} medium · ${report.counts.low} low · ${report.counts.info} info</p></header>
<h2>Findings</h2>${findings || '<p>No findings.</p>'}
<section class="coverage"><h2>Coverage</h2><p>Complete: <strong>${report.coverage.complete ? 'Yes' : 'No'}</strong></p><ul>${report.coverage.checks.map((item) => `<li>Checked: ${escapeHtml(item)}</li>`).join('')}${report.coverage.limitations.map((item) => `<li>Limitation: ${escapeHtml(item)}</li>`).join('')}</ul></section>
<p class="disclaimer">This report identifies known indicators. It does not prove that a file is safe.</p>
</body></html>`;
}
