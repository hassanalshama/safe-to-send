# Security policy

## Reporting a vulnerability

Use GitHub's private vulnerability reporting feature for defects that could:

- Execute code while parsing a document
- Escape decompression or memory limits
- Read files other than the selected input
- Cause the browser version to transmit document data
- Produce a materially false reassuring result through a reproducible parser flaw
- Expose sensitive report evidence without an explicit user action

Do not open a public issue containing an exploit, a real confidential document, recovered private information, credentials, or personal data.

Include:

1. A precise description of the impact.
2. The affected scanner version and runtime.
3. A minimal synthetic file or deterministic generator when safe to provide.
4. Reproduction steps.
5. The expected and actual result.
6. Any proposed fix.

Reports will be acknowledged through the advisory thread. A fix may include a code change, a coverage downgrade, a rule change, or documentation when the behavior cannot be safely detected.

## Supported versions

Security fixes are applied to the latest released version. Older versions are not maintained.

## Scope and trust boundary

The browser scanner is a static application. It has no backend and its page policy blocks network connections. The CLI performs local file reads and writes only. Both process attacker-controlled document bytes, so parsing logic is treated as untrusted-input code.

The project uses explicit limits for input size, archive entries, expanded archive size, XML part size, decoded PDF stream size, and compression ratio. A limit can make a scan incomplete; incomplete coverage must not produce a reassuring verdict.

## Safe test material

Use generated fixtures. Never submit customer files, internal presentations, contracts, identification documents, financial records, or unredacted production examples.
