# 07 · Highlight → Note Attachment (Marginalia)

## Why
A highlight says *this mattered*; a note on the highlight says *why*. The
classic marginalia model — the thought lives on the passage, not the page.

## UX
- The highlight toolbar (both create & edit modes) gains a **Note** action.
  - Create mode: the highlight is created first (amber default if no color
    chosen), then the note editor opens for it.
  - Edit mode: opens the editor with the existing note.
- Editor: a small bottom sheet titled with the quoted text (truncated),
  textarea, auto-save like page notes (debounce + Saved ✓).
- Highlights that carry notes render a small notch (corner dot) on their
  first rect. The combined notes-&-highlights list shows the note under the
  quote; export includes it (spec 08).

## Technical design
- `highlights.note TEXT NOT NULL DEFAULT ''` (migration).
- `PATCH /api/books/:id/highlights/:hid` now accepts `{ color? , note? }` —
  either or both; note capped at 5000 chars.
- Client: reuse the sheet pattern; `paintHighlights()` adds a `.hl-notch`
  child div on the first rect when `hl.note` is non-empty.

## Test plan
- Add note to highlight → PATCH persists; notch appears; list shows note.
- Clear note → notch disappears.
- Recolor still works alone (note untouched).
