// @ts-check

import { createReport, finding, VERSION } from './model.mjs';
import { scanPdf } from './pdf.mjs';
import { scanPptx } from './pptx.mjs';
import { extensionOf, sha256Hex, toUint8Array } from './util.mjs';
import { looksLikeZip } from './zip.mjs';

export { renderMarkdown, renderStandaloneHtml, renderText } from './report.mjs';
export { VERSION } from './model.mjs';
export { openZip, ZipError } from './zip.mjs';

const OLE_SIGNATURE = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];

/** @param {Uint8Array} bytes @param {number[]} signature */
function startsWith(bytes, signature) {
  return bytes.length >= signature.length && signature.every((value, index) => bytes[index] === value);
}

/** @param {Uint8Array} bytes */
function detectType(bytes) {
  if (bytes.length >= 5 && String.fromCharCode(...bytes.subarray(0, 5)) === '%PDF-') return 'pdf';
  if (looksLikeZip(bytes)) return 'zip';
  if (startsWith(bytes, OLE_SIGNATURE)) return 'ole';
  return 'unknown';
}

/**
 * Scan an in-memory file. The scanner performs no network access.
 * @param {ArrayBuffer | Uint8Array | DataView} input
 * @param {{name?: string, type?: string, maxBytes?: number, scannedAt?: string}} [options]
 */
export async function scan(input, options = {}) {
  const started = performance.now();
  const bytes = toUint8Array(input);
  const name = options.name || 'document';
  const extension = extensionOf(name);
  const declaredType = options.type || '';
  const maxBytes = options.maxBytes ?? 512 * 1024 * 1024;
  const sha256 = await sha256Hex(bytes);
  const file = { name, size: bytes.byteLength, type: declaredType, sha256 };

  if (bytes.byteLength > maxBytes) {
    const findings = [finding({
      ruleId: 'file.size-limit', severity: 'high', title: 'File exceeds the scan safety limit',
      summary: `The file is ${bytes.byteLength} bytes; this scan permits at most ${maxBytes} bytes.`,
      remediation: 'Scan a smaller reviewed copy or raise the limit only in a controlled local environment.', tags: ['coverage'],
    })];
    return createReport({
      file, findings, durationMs: performance.now() - started, scannedAt: options.scannedAt,
      coverage: { complete: false, checks: ['File size'], limitations: ['File content was not inspected.'] },
    });
  }

  const detected = detectType(bytes);
  let result;
  try {
    if (detected === 'pdf') {
      result = scanPdf(bytes);
      if (extension && extension !== 'pdf') {
        result.findings.push(finding({
          ruleId: 'file.extension-mismatch', severity: 'medium', title: 'Filename extension does not match the PDF content',
          summary: `The file contains PDF data but is named .${extension}.`,
          remediation: 'Verify the source and use the correct extension before sharing.', tags: ['format'],
        }));
      }
    } else if (detected === 'zip' && ['pptx', 'pptm', 'ppsx', 'ppsm', 'potx', 'potm'].includes(extension)) {
      result = scanPptx(bytes, name);
    } else if (detected === 'zip') {
      // Try PresentationML even when the filename is missing or wrong.
      result = scanPptx(bytes, name);
      if (!['pptx', 'pptm', 'ppsx', 'ppsm', 'potx', 'potm'].includes(extension)) {
        result.findings.push(finding({
          ruleId: 'file.extension-mismatch', severity: 'medium', title: 'Filename extension does not identify a PowerPoint file',
          summary: extension ? `The file contains a PowerPoint package but is named .${extension}.` : 'The file contains a PowerPoint package but has no PowerPoint extension.',
          remediation: 'Verify the source and use the correct PowerPoint extension before sharing.', tags: ['format'],
        }));
      }
    } else if (detected === 'ole' && ['pptx', 'pptm', 'ppsx', 'ppsm', 'potx', 'potm'].includes(extension)) {
      result = {
        findings: [finding({
          ruleId: 'pptx.encrypted-package', severity: 'high', title: 'Encrypted or legacy Office container detected',
          summary: 'Modern password-protected Office files are stored in an encrypted compound container that cannot be inspected without decryption.',
          remediation: 'Create a decrypted copy in a controlled environment, scan it, then securely delete the temporary copy.', tags: ['encryption', 'coverage'],
        })],
        coverage: { complete: false, checks: ['File container'], limitations: ['Encrypted or legacy compound-file content was not inspected.'], details: { detected: 'ole' } },
      };
    } else {
      result = {
        findings: [finding({
          ruleId: 'file.unsupported', severity: 'high', title: 'Unsupported or unrecognized file format',
          summary: extension ? `Safe to Send cannot inspect .${extension} files in this release.` : 'Safe to Send could not identify this file format.',
          remediation: 'Use a PDF, PPTX, PPTM, PPSX, PPSM, POTX, or POTM file, or inspect the file manually before sharing.', tags: ['coverage'],
        })],
        coverage: { complete: false, checks: ['File signature'], limitations: ['File content was not inspected.'], details: { detected } },
      };
    }
  } catch (error) {
    result = {
      findings: [finding({
        ruleId: 'scanner.failure', severity: 'high', title: 'Scan could not be completed',
        summary: 'The scanner encountered malformed data or an internal safety limit.',
        evidence: error instanceof Error ? error.message : String(error),
        remediation: 'Do not treat this file as cleared. Verify it manually or create a fresh copy and scan again.', tags: ['coverage'],
      })],
      coverage: { complete: false, checks: ['File signature'], limitations: ['The scan stopped before all checks completed.'], details: { detected } },
    };
  }

  result.coverage.details = { detected, declaredType, extension, ...result.coverage.details };
  return createReport({
    file,
    findings: result.findings,
    coverage: result.coverage,
    durationMs: performance.now() - started,
    scannedAt: options.scannedAt,
  });
}

/** @param {File} file @param {{maxBytes?: number}} [options] */
export async function scanFile(file, options = {}) {
  return scan(await file.arrayBuffer(), { name: file.name, type: file.type, maxBytes: options.maxBytes });
}

/** @returns {string} */
export function version() { return VERSION; }
