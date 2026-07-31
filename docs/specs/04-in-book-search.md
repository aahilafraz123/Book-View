# 04 · In-Book Search (+ FTS foundation)

## Why
"Where was that passage?" is a top-3 reader need, and the text index built
here also powers reflow-quality checks, stats, and future AI features.
Library-wide search becomes possible for free.

## UX
- 🔍 in the reader top bar opens a search sheet: query field, result list of
  `page · snippet` with the match bolded; tapping a result closes the sheet,
  jumps to the page, and briefly flashes the match location(s).
- Empty state: "No matches for …". First search on an older book may take a
  few seconds ("Indexing book…") while extraction backfills.

## Technical design
- **Extraction (server):** pdf.js legacy build in Node
  (`import('pdfjs-dist/legacy/build/pdf.mjs')`) → per-page
  `getTextContent()` → plain text rows in `book_pages`, mirrored into an
  FTS5 table. Runs fire-and-forget after upload; `books.text_extracted`
  flags completion; the search endpoint backfills lazily for pre-existing
  books. Serialized with a simple in-process queue to bound memory.
- **Index:** `book_pages(book_id, page, text)` +
  `book_pages_fts USING fts5(book_id UNINDEXED, page UNINDEXED, text)`.
  Rows are deleted with their book.
- **Query:** user input is tokenized and each token double-quoted before
  `MATCH` (prevents FTS syntax injection); snippets via `snippet()`.
- **Endpoints:**
  - `GET /api/books/:id/search?q=` → `[{ page, snippet }]` (max 50)
  - `GET /api/search?q=` → `[{ bookId, title, page, snippet }]` (max 50)
- **Match flash (client):** on arrival, walk `#text-layer` spans for the
  query (case-insensitive), build DOM Ranges for matches, convert
  `getClientRects()` to page fractions, paint temporary `.search-flash`
  rects that fade out after ~2.5s. Reflow mode scrolls to and flashes the
  matching paragraph instead.

## Test plan
- API: search returns expected pages/snippets; FTS rows removed on book
  delete; malicious query strings (`"`, `NEAR(`, parens) don't 500.
- UI: search → results listed; tap → correct page + flash rect appears.
