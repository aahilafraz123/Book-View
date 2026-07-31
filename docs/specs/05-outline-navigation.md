# 05 · Chapter / Outline Navigation

## Why
Real books have chapters; many PDFs embed a table of contents. Jumping by
chapter beats scrubbing a slider through 400 pages. Near-free via pdf.js.

## UX
- A ≡ button in the reader bottom bar opens a "Contents" sheet listing the
  book's outline, indented by nesting level (max 3 shown), current chapter
  implied by page numbers shown on the right.
- Tap an entry → jump to its page. Button hidden entirely when the PDF has
  no outline.

## Technical design
- On book open: `pdf.getOutline()` → for each item resolve its destination
  to a page number: explicit array dests via `pdf.getPageIndex(dest[0])`,
  named dests via `pdf.getDestination(name)` first. Resolution is async and
  cached; failures skip the entry.
- Flattened to `[{ title, page, depth }]`, rendered into the shared sheet
  component. No server involvement.

## Test plan
- Book with outline: entries listed with page numbers; tap jumps.
- Book without outline: button hidden, no errors.
  (Our pdf-lib test books have no outline — automated test covers the
  hidden-button path; outline path verified with a real outlined PDF.)
