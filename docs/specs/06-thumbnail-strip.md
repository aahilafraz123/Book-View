# 06 · Page Thumbnail Strip

## Why
Scrubbing the slider blind is guesswork; a filmstrip gives visual position
sense ("the chapter break was around *there*").

## UX
- While dragging the page slider, a horizontal filmstrip of page thumbnails
  fades in above the bottom bar, auto-centering on the scrub target; it
  fades out ~1.5s after release. Tapping the page-info chip in the top bar
  pins it open / closes it.
- Current page thumb gets an amber border. Tapping any thumb jumps there.

## Technical design
- `#thumb-strip`: horizontally scrollable row of fixed-width (56px) cells,
  one per page, each a placeholder div until visible.
- Lazy render: `IntersectionObserver` (root = strip) renders visible thumbs
  via `pdf.getPage(n)` at `scale = 56/base.width` into small canvases.
- Cache: rendered thumb canvases kept in a Map with LRU eviction above 60
  entries (≈ a few MB max); cache cleared on book close.
- Scrub sync: slider `input` events scroll the strip so the target thumb is
  centered (no smooth-scroll during drag; smooth on pin-open).

## Schema/API
None.

## Test plan
- Dragging slider shows strip; thumbs render for the visible window.
- Tap a thumb → page jumps, strip highlights it.
- 500-page book: only visible thumbs hold canvases (spot-check count).
