# kata-ingest

Standalone CLI that turns a book into a Kata course folder.

## Install

```bash
cd ingest
npm install
```

## Run

```bash
export ANTHROPIC_API_KEY=sk-...
tsx cli.ts ~/Downloads/my-book.epub \
  --out ../courses \
  --lang rust \
  --id my-book \
  --title "My Book" \
  --author "Author Name" \
  --pack
```

Outputs:
- `<out>/<course-id>/course.json` — the course folder
- `<out>/<course-id>.kata` — the zipped archive (if `--pack` is set)

Without `ANTHROPIC_API_KEY`, the CLI uses a deterministic fallback: one
reading lesson per top-level heading. Useful for bootstrapping before
prompt-tuning.

## Status

V1 is a **skeleton**. The EPUB parser and the LLM prompt chain are stubbed —
they'll be fleshed out against a real book so we can tune against its exact
structure and formatting conventions.

Markdown input already works:
```bash
tsx cli.ts ~/Downloads/book.md --out ../courses --lang rust --pack
```
