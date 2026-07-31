# 01 · Reflowed Text Mode

## Why
Fixed PDF pages are hostile on phones: text is either too small or requires
panning. Reflow turns any text-based PDF page into flowing, resizable HTML —
the difference between "PDF viewer" and "book reader."

## UX
- Reflow is one of three **view modes** (Paged / Scroll / Reflow) selected in
  the **Aa display sheet**. The choice is per book and persists server-side.
- In reflow the canvas is replaced by a typeset text column (Fraunces serif,
  comfortable measure, generous line height). Text size is adjustable
  (14–24px) from the Aa sheet and persists per device (localStorage).
- Navigation is unchanged and page-synced: prev/next buttons, slider, swipe,
  and tap zones move one *PDF page* at a time, so reading progress, notes,
  and bookmarks stay anchored to real page numbers.
- Page text is natively selectable/copyable. Theme (Light/Sepia/Dark) applies
  as background/ink colors rather than canvas filters.

## Technical design
- Client-side only. For page N: `pdf.getPage(N).getTextContent()` returns
  positioned text items.
- Reconstruction pipeline (`reflowPage()`):
  1. Group items into lines by baseline Y (tolerance = 30% of item height).
  2. Sort lines top→bottom, items within a line left→right; join with spaces.
  3. Merge lines into paragraphs: new paragraph when the vertical gap between
     lines exceeds 1.6× the median line gap, or on a leading indent jump.
     Trailing hyphens merge without a space.
  4. Render as `<p>` elements inside `#reflow-view`.
- Result cached per page in an in-memory Map for the open book.

## Limitations (documented, accepted)
- Multi-column/tabular PDFs reflow in reading-order-by-Y and may interleave;
  reflow is a per-book opt-in, not a default.
- Scanned/image PDFs produce no text → show "No extractable text on this
  page" with a one-tap switch back to Paged.
- Highlight painting (canvas rects) is unavailable in reflow; existing
  highlights remain visible in Paged/Scroll and in the notes list.

## Schema/API
- `books.view_mode TEXT NOT NULL DEFAULT 'paged'` (migration).
- `PUT /api/books/:id/view-mode { mode: 'paged'|'scroll'|'reflow' }`.

## Test plan
- Toggle to reflow → paragraphs render, page count and slider unchanged.
- Next/prev updates reflowed content and saves progress.
- Text size slider changes rendered size; persists across reload.
- View mode persists across reload (server-side).
