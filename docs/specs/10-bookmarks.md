# 10 · Bookmarks

## Why
"Where I am" (progress) and "places I want back" are different things.
Bookmarks complete the annotation triad (notes, highlights, bookmarks).

## UX
- 🔖 button in the reader top bar toggles a bookmark on the current page —
  filled/amber when the page is bookmarked, with a pop animation.
- Bookmarked pages appear in the combined notes-&-highlights list
  (`🔖 Page N`) and jump on tap; included in Markdown export.
- V1 has no labels in the UI (API supports them for later).

## Technical design
- `bookmarks(book_id, page, label, created_at, PRIMARY KEY(book_id, page))`.
- Endpoints:
  - `GET /api/books/:id/bookmarks` → `[{ page, label, createdAt }]`
  - `PUT /api/books/:id/bookmarks/:page { label? }` (upsert)
  - `DELETE /api/books/:id/bookmarks/:page`
  - Deleted with their book.
- Client: bookmarks load with notes/highlights on book open into a Set;
  `updatePageUI()` styles the button; toggle is optimistic with rollback
  toast on failure.

## Test plan
- Toggle on/off persists across reload; button state follows current page.
- Entry appears in list and in export; removed cleanly on un-bookmark.
