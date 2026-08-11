// @ts-check

import { compact, redactLikelySecret } from './util.mjs';

/** @param {string} value */
function luhn(value) {
  const digits = value.replace(/\D/g, '');
  if (digits.length < 13 || digits.length > 19 || /^(\d)\1+$/.test(digits)) return false;
  let sum = 0;
  let double = false;
  for (let index = digits.length - 1; index >= 0; index -= 1) {
    let digit = Number(digits[index]);
    if (double) { digit *= 2; if (digit > 9) digit -= 9; }
    sum += digit;
    double = !double;
  }
  return sum % 10 === 0;
}

/** @param {string} value */
function validIban(value) {
  const normalized = value.replace(/\s+/g, '').toUpperCase();
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]{11,30}$/.test(normalized)) return false;
  const rearranged = normalized.slice(4) + normalized.slice(0, 4);
  let remainder = 0;
  for (const char of rearranged) {
    const digits = /[A-Z]/.test(char) ? String(char.charCodeAt(0) - 55) : char;
    for (const digit of digits) remainder = (remainder * 10 + Number(digit)) % 97;
  }
  return remainder === 1;
}

const rules = [
  {
    id: 'private-key', label: 'Private key material', severity: 'high',
    expression: /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/gi,
  },
  {
    id: 'aws-access-key', label: 'AWS access key identifier', severity: 'high',
    expression: /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g,
  },
  {
    id: 'google-api-key', label: 'Google API key', severity: 'high',
    expression: /\bAIza[0-9A-Za-z_-]{35}\b/g,
  },
  {
    id: 'github-token', label: 'GitHub token', severity: 'high',
    expression: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{30,255}\b/g,
  },
  {
    id: 'npm-token', label: 'npm access token', severity: 'high',
    expression: /\bnpm_[A-Za-z0-9]{30,255}\b/g,
  },
  {
    id: 'slack-token', label: 'Slack token', severity: 'high',
    expression: /\bxox[baprs]-[A-Za-z0-9-]{10,200}\b/g,
  },
  {
    id: 'stripe-secret', label: 'Stripe secret key', severity: 'high',
    expression: /\bsk_(?:live|test)_[A-Za-z0-9]{16,}\b/g,
  },
  {
    id: 'sendgrid-key', label: 'SendGrid API key', severity: 'high',
    expression: /\bSG\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}\b/g,
  },
  {
    id: 'jwt', label: 'JSON Web Token', severity: 'high',
    expression: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g,
  },
  {
    id: 'bearer-token', label: 'Bearer token', severity: 'high',
    expression: /\bBearer\s+[A-Za-z0-9._~+\/-]{20,}={0,2}\b/gi,
  },
  {
    id: 'credential-assignment', label: 'Credential-like assignment', severity: 'medium',
    expression: /\b(?:api[_ -]?key|client[_ -]?secret|secret|password|passwd|token)\s*[:=]\s*["']?[^\s"'<>]{8,}/gi,
  },
  {
    id: 'connection-string', label: 'Database connection string', severity: 'high',
    expression: /\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis):\/\/[^\s<>"']+/gi,
  },
  {
    id: 'internal-url', label: 'Private or internal URL', severity: 'medium',
    expression: /\bhttps?:\/\/(?:localhost|127\.0\.0\.1|10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|172\.(?:1[6-9]|2\d|3[01])\.\d+\.\d+|[^\s/]+\.(?:internal|local|corp))(?::\d+)?[^\s<>"']*/gi,
  },
  {
    id: 'email-address', label: 'Email address', severity: 'medium',
    expression: /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,63}\b/gi,
  },
  {
    id: 'us-ssn', label: 'US Social Security number pattern', severity: 'medium',
    expression: /\b(?!000|666|9\d\d)\d{3}[- ](?!00)\d{2}[- ](?!0000)\d{4}\b/g,
  },
  {
    id: 'iban', label: 'IBAN', severity: 'medium',
    expression: /\b[A-Z]{2}\d{2}(?:[ ]?[A-Z0-9]){11,30}\b/g,
    validate: validIban,
  },
  {
    id: 'payment-card', label: 'Payment-card number', severity: 'medium',
    expression: /\b(?:\d[ -]?){12,18}\d\b/g,
    validate: luhn,
  },
];

/**
 * Scan text that is already hidden or recoverable. It should not be used to
 * classify ordinary visible document text.
 * @param {string} text
 */
export function detectSensitiveText(text) {
  const matches = [];
  for (const rule of rules) {
    rule.expression.lastIndex = 0;
    for (const match of text.matchAll(rule.expression)) {
      const raw = match[0] || '';
      if (rule.validate && !rule.validate(raw)) continue;
      matches.push({
        ruleId: rule.id,
        label: rule.label,
        severity: rule.severity,
        evidence: redactLikelySecret(raw),
        context: compact(text.slice(Math.max(0, (match.index || 0) - 40), (match.index || 0) + raw.length + 40)),
      });
      if (matches.length >= 50) return matches;
    }
  }
  return matches;
}
