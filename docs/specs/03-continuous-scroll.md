# 03 · Continuous Scroll Mode

## Why
Many phone readers strongly prefer a vertical scroll over discrete page
flips. Scroll is the second of the three view modes.

## UX
- Selected in the Aa sheet; per-book, persists server-side (`view_mode`).
- Pages render as a vertical stack, fit to width, small gaps between pages.
- Reading progress = topmost mostly-visible page; the slider and page info
  stay live while scrolling, and progress saves (debounced) as it changes.
- Slider / outline / search / notes-list jumps scroll to that page.
- Tap-to-turn zones and swipe are disabled (they'd fight scrolling); center
  tap still toggles the bars. Zoom controls hide (fit-width only).
- Text selection & highlighting work on rendered pages; existing highlights
  paint on every rendered page.

## Technical design
- `#scroll-stack` replaces the single page wrap: one `.scroll-page` div per
  page, each holding placeholder → (canvas + highlight layer + text layer)
  when near the viewport.
- **Virtualization:** an `IntersectionObserver` (root = page container,
  margin ≈ 150% viewport) renders pages entering the window and tears down
  canvases (width=0) for pages far outside it. At most ~7 pages hold pixels.
- Placeholder heights come from each page's own viewport ratio, fetched
  lazily (page 1's ratio used until known) so scroll length stabilizes.
- A second observer with thresholds tracks the topmost visible page for
  progress; entering a page also lazily paints its highlights + text layer.
- Highlight hit-testing generalizes: the tap handler resolves the tapped
  `.scroll-page` first, then does fraction hit-testing inside it.

## Schema/API
Shares `books.view_mode` and `PUT /api/books/:id/view-mode` (spec 01).

## Test plan
- Toggle to scroll → stack renders, current page ≈ where you were.
- Scrolling several pages updates page info; progress persists on reload.
- Slider jump scrolls to the right page; highlights paint on it.
