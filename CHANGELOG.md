# Changelog

All notable changes are recorded here. Versions follow semantic versioning.

## 0.1.0 — 2026-08-10

Initial public release.

### Added

- Local-only browser scanner for PDF and PowerPoint files.
- PDF checks for opaque-overlay redaction failures, invisible and off-page text, annotations, forms, attachments, actions, optional content, metadata, and incremental revisions.
- PowerPoint checks for notes, hidden slides and objects, off-slide objects, comments, custom properties and XML, embedded files, macros, external relationships, cropped images, image metadata, and package-integrity failures.
- Sensitive-value detection limited to concealed or recoverable content contexts.
- Text, JSON, Markdown, standalone HTML, and SARIF reports.
- Recursive CLI, standard-input support, configurable limits, severity thresholds, and defined exit codes.
- ZIP64-aware archive reader with CRC verification and decompression limits.
- Dependency-free DEFLATE decoder for stored, fixed-Huffman, and dynamic-Huffman streams.
- Deterministic clean and unsafe PDF/PPTX fixtures.
- Static GitHub Pages site, composite GitHub Action, CI, release checks, and security documentation.
