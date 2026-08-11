# Threat model

## Asset

The protected asset is information a sender did not intend to disclose with a PDF or PowerPoint file.

Examples include speaker notes, deleted-looking text, hidden slides, comments, embedded documents, local paths, author identity, credentials, financial values, and prior revisions.

## Adversary

The recipient is assumed to have the complete file and may:

- Rename or unzip an Office package.
- Inspect XML and relationships.
- Extract embedded files.
- Read PDF objects and decoded content streams.
- Search raw bytes and metadata.
- Toggle layers, annotations, and hidden slides.
- Use ordinary forensic and document-inspection tools.

The scanner does not assume the recipient is limited to the default visual view.

## Security goals

1. Detect supported concealed or recoverable content before sharing.
2. Show enough evidence for the sender to verify the finding.
3. Never upload the inspected file.
4. Fail closed when meaningful content cannot be inspected.
5. Bound CPU and memory use on hostile files.
6. Keep results deterministic and reproducible.

## Non-goals

Safe to Send does not:

- Prove that a document contains no sensitive information.
- Understand whether visible text is commercially or legally confidential.
- Replace a human disclosure review.
- Bypass encryption.
- Render every application-specific visual effect.
- Sanitize or rewrite source documents.
- Detect arbitrary steganography.
- Validate digital signatures or certify legal redaction compliance.
- Protect a compromised browser, operating system, extension, or Node.js runtime.

## Input threats

Documents are attacker-controlled binary input. Relevant risks include:

- ZIP bombs and extreme compression ratios.
- Huge entry counts and expanded sizes.
- Duplicate or traversal-like paths.
- CRC corruption.
- Unsupported compression or PDF filters.
- Truncated and malformed structures.
- Recursive or cyclic relationships.
- Very large XML and content streams.
- Parser confusion caused by extension/content mismatch.

Mitigations include explicit size and count limits, path validation, CRC checks, bounded decompression, non-recursive parsers, deterministic scanning, and an incomplete verdict when coverage fails.

## Browser boundary

The browser app is static and executes the scanner in a dedicated worker. Its Content Security Policy blocks network connections and remote code. It does not register analytics or a service worker, persist files, or send reports.

The hosting provider can receive ordinary requests for public site assets. It does not receive the selected document through application code.

## False reassurance

The most damaging failure is a clean-looking verdict after incomplete inspection. The report model therefore separates findings from coverage. Unsupported encryption, decoding errors, malformed packages, and enforced limits set coverage to incomplete and prevent the `NO_OBVIOUS_RISKS` verdict.

A complete scan still means only that enabled checks found no obvious risk.
