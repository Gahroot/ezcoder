# Changelog

All notable changes to `ez_agent-rails` are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

While the gem is pre-1.0, MINOR releases (`0.x`) may contain breaking changes.

## [Unreleased]

## [0.2.0] - 2026-06-20

### Added
- `EZAgentRails::DocumentText` — extracts plain text from uploaded PDF, DOCX,
  XLSX, and PPTX attachments so their contents can be inlined into the LLM
  prompt (`RunJob#build_user_content`). PDFs decode via `pdf-reader`; the OOXML
  formats decode via `rubyzip` + `nokogiri`. Extraction libraries are required
  lazily and any failure degrades safely to a filename placeholder (never
  raises), so a bad upload can't abort a run.
- Bounded streaming inflation for the OOXML ZIP container (`read_bounded`,
  `ZipBombError`): each entry is inflated in fixed `INFLATE_CHUNK_BYTES` chunks
  and aborted the moment it crosses the per-entry / total byte ceiling. This
  guards against a decompression (zip) bomb that under-declares its
  uncompressed size in the ZIP header — the declared `entry.size` is
  attacker-controlled, so the ceiling is enforced during inflation rather than
  by trusting the header.

### Changed
- `RunJob#build_user_content` now inlines decoded document text for extractable
  attachments, falling back to the existing binary placeholder when extraction
  yields nothing.

### Dependencies
- Added `nokogiri (>= 1.11)`, `pdf-reader (~> 2.0)`, and `rubyzip (>= 2.0)` as
  runtime dependencies for `DocumentText`.

## [0.1.0]

### Added
- Initial release: mountable Rails engine wrapping the `ez_agent` loop with
  ActiveRecord persistence (conversations, messages, runs), a per-tenant
  credentials resolver, an install generator, an off-request `RunJob`, and a
  Turbo/Hotwire broadcaster plus Action Cable channel.
