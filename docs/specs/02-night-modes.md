# 02 · Night Reading Modes

## Why
Reading white PDF pages in the dark is eye-searing. Every serious reading
app offers warm/dark page rendering; this is the cheapest large comfort win.

## UX
- Three page themes in the **Aa display sheet**: **Light** (as rendered),
  **Sepia** (warm paper), **Dark** (inverted ink).
- Theme is a device preference (localStorage), applies to all books, and
  takes effect instantly — no re-render.
- Applies to all three view modes: canvas modes via CSS filter, reflow via
  background/ink colors.

## Technical design
- A `theme-light | theme-sepia | theme-dark` class on `#reader-view`.
- Canvas (paged & scroll):
  - Sepia: `filter: sepia(0.42) brightness(0.94) contrast(0.98)` + warm
    container background.
  - Dark: `filter: invert(0.93) hue-rotate(180deg)` — white paper becomes
    near-black, ink becomes light; images invert (accepted trade-off).
- Highlights: multiply blending goes muddy on inverted pages, so
  `.theme-dark .hl-rect { mix-blend-mode: screen; opacity: 0.35 }`.
- Reflow: theme sets `--page-bg` / `--page-ink` custom properties.

## Schema/API
None.

## Test plan
- Cycling themes adds the right class and visibly changes canvas rendering.
- Choice survives reload (localStorage).
- Highlights remain visible in dark mode.
