// @ts-check

import { fnv1a } from './util.mjs';

export const SCHEMA_VERSION = '1.0';
export const VERSION = '0.1.0';
export const SEVERITIES = /** @type {const} */ (['high', 'medium', 'low', 'info']);
export const CONFIDENCES = /** @type {const} */ (['high', 'medium', 'low']);

const severityRank = { high: 0, medium: 1, low: 2, info: 3 };
const severityWeight = { high: 28, medium: 10, low: 3, info: 0 };
const confidenceWeight = { high: 1, medium: 0.78, low: 0.5 };

/**
 * @typedef {'high' | 'medium' | 'low' | 'info'} Severity
 * @typedef {'high' | 'medium' | 'low'} Confidence
 * @typedef {{
 *   ruleId: string,
 *   severity: Severity,
 *   confidence?: Confidence,
 *   title: string,
 *   summary: string,
 *   evidence?: string,
 *   location?: string,
 *   remediation?: string,
 *   tags?: string[],
 *   data?: Record<string, unknown>
 * }} FindingInput
 */

/** @param {FindingInput} input */
export function finding(input) {
  if (!SEVERITIES.includes(input.severity)) {
    throw new TypeError(`Invalid severity: ${input.severity}`);
  }
  const confidence = input.confidence || 'high';
  if (!CONFIDENCES.includes(confidence)) {
    throw new TypeError(`Invalid confidence: ${confidence}`);
  }
  const location = input.location || 'Document';
  const evidence = input.evidence || '';
  return {
    id: `${input.ruleId}-${fnv1a(`${location}\u0000${evidence}\u0000${input.summary}`)}`,
    ruleId: input.ruleId,
    severity: input.severity,
    confidence,
    title: input.title,
    summary: input.summary,
    evidence: evidence || undefined,
    location,
    remediation: input.remediation || undefined,
    tags: [...new Set(input.tags || [])].sort(),
    data: input.data || undefined,
  };
}

/** @param {ReturnType<typeof finding>[]} findings */
export function deduplicateFindings(findings) {
  const byId = new Map();
  for (const item of findings) {
    if (!byId.has(item.id)) byId.set(item.id, item);
  }
  return [...byId.values()].sort((left, right) => {
    const severityDifference = severityRank[left.severity] - severityRank[right.severity];
    if (severityDifference !== 0) return severityDifference;
    const ruleDifference = left.ruleId.localeCompare(right.ruleId);
    if (ruleDifference !== 0) return ruleDifference;
    return (left.location || '').localeCompare(right.location || '');
  });
}

/** @param {ReturnType<typeof finding>[]} findings */
export function summarizeFindings(findings) {
  const counts = { high: 0, medium: 0, low: 0, info: 0, total: findings.length };
  let score = 0;
  for (const item of findings) {
    counts[item.severity] += 1;
    score += severityWeight[item.severity] * confidenceWeight[item.confidence];
  }
  return { counts, score: Math.min(100, Math.round(score)) };
}

/**
 * @param {ReturnType<typeof finding>[]} findings
 * @param {{ complete: boolean, limitations?: string[] }} coverage
 */
export function deriveVerdict(findings, coverage) {
  const { counts, score } = summarizeFindings(findings);
  if (counts.high > 0) {
    return {
      code: 'DO_NOT_SEND',
      title: 'Do not send yet',
      summary: `${counts.high} high-risk finding${counts.high === 1 ? '' : 's'} need attention before this file is shared.`,
      score,
    };
  }
  if (!coverage.complete) {
    return {
      code: 'INCOMPLETE',
      title: 'Scan incomplete',
      summary: 'Part of the file could not be inspected. Treat the absence of high-risk findings as inconclusive.',
      score,
    };
  }
  if (counts.medium > 0) {
    return {
      code: 'REVIEW',
      title: 'Review before sending',
      summary: `${counts.medium} finding${counts.medium === 1 ? '' : 's'} may expose information the normal document view does not make obvious.`,
      score,
    };
  }
  return {
    code: 'NO_OBVIOUS_RISKS',
    title: 'No obvious hidden content found',
    summary: 'The enabled checks did not find a clear sharing risk. This is not a guarantee that the file is safe.',
    score,
  };
}

/**
 * @param {{
 *   file: {name: string, size: number, type: string, sha256: string | null},
 *   findings: ReturnType<typeof finding>[],
 *   coverage: {complete: boolean, checks: string[], limitations: string[], details?: Record<string, unknown>},
 *   durationMs: number,
 *   scannedAt?: string
 * }} input
 */
export function createReport(input) {
  const findings = deduplicateFindings(input.findings);
  const summary = summarizeFindings(findings);
  return {
    schemaVersion: SCHEMA_VERSION,
    scanner: { name: 'Safe to Send', version: VERSION },
    scannedAt: input.scannedAt || new Date().toISOString(),
    durationMs: Math.max(0, Math.round(input.durationMs)),
    file: input.file,
    verdict: deriveVerdict(findings, input.coverage),
    findings,
    counts: summary.counts,
    coverage: {
      complete: input.coverage.complete,
      checks: [...new Set(input.coverage.checks)],
      limitations: [...new Set(input.coverage.limitations)],
      details: input.coverage.details || {},
    },
  };
}
