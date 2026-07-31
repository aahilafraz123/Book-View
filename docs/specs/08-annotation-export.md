# 08 · Annotation Export (Markdown)

## Why
Annotations locked in an app die there. Readers want their notes in
Obsidian/Notion/email. Trivial to build on existing data; outsized
perceived value.

## UX
- "Export as Markdown" button at the bottom of the notes-&-highlights
  sheet → downloads `<book-title>-notes.md`.
- Document shape:
  ```
  # <Title> — notes & highlights
  _Exported <date> · X notes · Y highlights · Z bookmarks_

  ## Page 12
  - 🔖 Bookmark: <label>
  - > "quoted highlight text" (amber)
    - <attached highlight note>
  - ✎ <page note>
  ```
  Grouped by page, ascending; empty books export a friendly stub.

## Technical design
- `GET /api/books/:id/export.md` — server joins notes + highlights (+ their
  notes) + bookmarks, groups by page, renders Markdown, responds with
  `Content-Type: text/markdown` and
  `Content-Disposition: attachment; filename="<slug>-notes.md"`.
- Client: plain `<a href>` — the browser handles the download; on mobile
  Safari it opens in-tab where the share sheet takes over (acceptable).

## Test plan
- Export contains the expected sections for a book with all three types.
- Markdown special characters in note text don't break structure (angle
  brackets escaped in quotes/notes).
