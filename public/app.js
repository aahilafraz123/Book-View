import * as pdfjsLib from '/pdfjs/pdf.min.mjs';

pdfjsLib.GlobalWorkerOptions.workerSrc = '/pdfjs/pdf.worker.min.mjs';

const $ = (id) => document.getElementById(id);

const libraryView = $('library-view');
const readerView = $('reader-view');
const bookGrid = $('book-grid');
const emptyState = $('empty-state');
const fileInput = $('file-input');
const uploadStatus = $('upload-status');
const uploadStatusText = $('upload-status-text');

const pageContainer = $('page-container');
const pageWrap = $('page-wrap');
const canvas = $('page-canvas');
const ctx = canvas.getContext('2d');
const readerLoading = $('reader-loading');
const pageSlider = $('page-slider');
const sliderBubble = $('slider-bubble');

const REDUCED_MOTION = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

const reader = {
  book: null,
  pdf: null,
  page: 1,
  zoom: 1,
  rendering: false,
  pendingPage: null,
  pendingDir: 0,
  loadToken: 0,
  notes: new Map(),
  highlights: new Map(),
  bookmarks: new Set(),
  outline: [],
  viewMode: 'paged',
};

const textLayerDiv = $('text-layer');
const highlightLayer = $('highlight-layer');
const scrollStack = $('scroll-stack');
const reflowView = $('reflow-view');
const thumbStrip = $('thumb-strip');
const HL_COLORS = { amber: '#f2c14e', green: '#8fd07f', blue: '#7fb8e6', pink: '#f0a1c0' };
let textLayerInstance = null;

// Device display preferences (theme + reflow text size live per device).
const prefs = {
  theme: localStorage.getItem('bv-theme') || 'light',
  fontSize: parseInt(localStorage.getItem('bv-fontsize'), 10) || 17,
};

/* ---------------- Generic bottom-sheet manager ---------------- */

const sheetBackdropEl = $('note-backdrop');
const READER_SHEET_IDS = [
  'note-sheet', 'notes-list-sheet', 'display-sheet', 'search-sheet',
  'contents-sheet', 'hl-note-sheet', 'stats-sheet',
];
const readerSheetEls = () => READER_SHEET_IDS.map($);

function openReaderSheet(el) {
  flushNoteSave();
  flushHlNoteSave();
  for (const s of readerSheetEls()) if (s !== el) s.hidden = true;
  sheetBackdropEl.hidden = false;
  el.hidden = false;
  sheetBackdropEl.classList.remove('leaving');
  el.classList.remove('leaving');
}

function closeReaderSheets() {
  flushNoteSave();
  flushHlNoteSave();
  const open = readerSheetEls().filter((s) => !s.hidden);
  if (!open.length) return;
  for (const el of open) {
    el.classList.add('leaving');
    el.addEventListener('animationend', () => (el.hidden = true), { once: true });
  }
  sheetBackdropEl.classList.add('leaving');
  sheetBackdropEl.addEventListener('animationend', () => (sheetBackdropEl.hidden = true), {
    once: true,
  });
}

/* ---------------- API ---------------- */

async function api(path, options = {}) {
  const res = await fetch(path, options);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `Request failed (${res.status})`);
  return body;
}

/* ---------------- Toasts ---------------- */

function toast(message, { error = false, duration = 2800, action = null } = {}) {
  const el = document.createElement('div');
  el.className = `toast${error ? ' error' : ''}${action ? ' actionable' : ''}`;
  el.textContent = message;
  if (action) {
    el.addEventListener('click', () => {
      action();
      el.remove();
    });
  }
  $('toast-container').appendChild(el);
  setTimeout(() => {
    el.classList.add('leaving');
    el.addEventListener('animationend', () => el.remove(), { once: true });
  }, duration);
}

/* ---------------- Confirm sheet ---------------- */

function confirmSheet(message) {
  return new Promise((resolve) => {
    const backdrop = $('sheet-backdrop');
    const sheet = $('confirm-sheet');
    $('sheet-message').textContent = message;
    backdrop.hidden = false;
    sheet.hidden = false;
    backdrop.classList.remove('leaving');
    sheet.classList.remove('leaving');

    const close = (answer) => {
      sheet.classList.add('leaving');
      backdrop.classList.add('leaving');
      sheet.addEventListener(
        'animationend',
        () => {
          sheet.hidden = true;
          backdrop.hidden = true;
        },
        { once: true }
      );
      cleanup();
      resolve(answer);
    };
    const onConfirm = () => close(true);
    const onCancel = () => close(false);
    const cleanup = () => {
      $('sheet-confirm').removeEventListener('click', onConfirm);
      $('sheet-cancel').removeEventListener('click', onCancel);
      backdrop.removeEventListener('click', onCancel);
    };
    $('sheet-confirm').addEventListener('click', onConfirm);
    $('sheet-cancel').addEventListener('click', onCancel);
    backdrop.addEventListener('click', onCancel);
  });
}

/* ---------------- Library ---------------- */

async function loadLibrary() {
  const books = await api('/api/books');
  bookGrid.innerHTML = '';
  emptyState.hidden = books.length > 0;

  books.forEach((book, i) => {
    bookGrid.appendChild(renderCard(book, i));
  });
}

function renderCard(book, index) {
  const card = document.createElement('div');
  card.className = 'book-card';
  card.style.setProperty('--i', Math.min(index, 10));

  const pct = book.lastReadAt
    ? Math.round((book.currentPage / book.pageCount) * 100)
    : 0;

  const cover = document.createElement('div');
  cover.className = 'book-cover';
  if (book.hasCover) {
    const img = document.createElement('img');
    img.src = `/api/books/${book.id}/cover`;
    img.alt = '';
    img.loading = 'lazy';
    cover.appendChild(img);
  } else {
    const ph = document.createElement('div');
    ph.className = 'placeholder';
    ph.textContent = book.title;
    cover.appendChild(ph);
  }

  const shine = document.createElement('div');
  shine.className = 'cover-shine';
  cover.appendChild(shine);

  const track = document.createElement('div');
  track.className = 'progress-track';
  const fill = document.createElement('div');
  fill.className = 'progress-fill';
  track.appendChild(fill);
  cover.appendChild(track);
  // set after insertion so the width animates up from zero
  requestAnimationFrame(() => requestAnimationFrame(() => (fill.style.width = `${pct}%`)));

  const meta = document.createElement('div');
  meta.className = 'book-meta';
  const title = document.createElement('div');
  title.className = 'book-title';
  title.textContent = book.title;
  const sub = document.createElement('div');
  sub.className = 'book-sub';
  let progressLabel = book.lastReadAt
    ? `p. ${book.currentPage} / ${book.pageCount}`
    : `${book.pageCount} pages`;
  if (book.noteCount > 0) progressLabel += ` · ✎ ${book.noteCount}`;
  if (book.highlightCount > 0) progressLabel += ` · 🖍 ${book.highlightCount}`;
  const labelSpan = document.createElement('span');
  labelSpan.textContent = progressLabel;
  sub.appendChild(labelSpan);
  const del = document.createElement('button');
  del.className = 'delete-btn';
  del.textContent = '🗑';
  del.setAttribute('aria-label', `Delete ${book.title}`);
  del.addEventListener('click', async (e) => {
    e.stopPropagation();
    const yes = await confirmSheet(`Remove “${book.title}” from your library?`);
    if (!yes) return;
    card.classList.add('removing');
    await new Promise((r) => setTimeout(r, REDUCED_MOTION ? 0 : 320));
    try {
      await api(`/api/books/${book.id}`, { method: 'DELETE' });
      toast(`Deleted “${book.title}”`);
    } catch (err) {
      toast(err.message, { error: true });
    }
    loadLibrary();
  });
  sub.appendChild(del);
  meta.append(title, sub);

  card.append(cover, meta);
  card.addEventListener('click', () => {
    location.hash = `#/read/${book.id}`;
  });
  return card;
}

/* ---------------- Upload ---------------- */

fileInput.addEventListener('change', async () => {
  const files = [...fileInput.files];
  fileInput.value = '';
  if (!files.length) return;

  uploadStatus.hidden = false;
  let done = 0;
  for (const file of files) {
    uploadStatusText.textContent =
      files.length > 1
        ? `Adding ${file.name} (${done + 1} of ${files.length})…`
        : `Adding ${file.name}…`;
    try {
      const form = new FormData();
      form.append('file', file);
      const book = await api('/api/books', { method: 'POST', body: form });
      await generateCover(file, book.id).catch(() => {});
      done++;
    } catch (err) {
      toast(`${file.name}: ${err.message}`, { error: true, duration: 4000 });
    }
  }
  uploadStatus.hidden = true;
  if (done > 0) toast(done > 1 ? `${done} books shelved ✦` : 'Book shelved ✦');
  loadLibrary();
});

// Render page 1 locally (we already have the bytes) and store it as the
// library thumbnail so browsing never downloads full PDFs.
async function generateCover(file, bookId) {
  const data = new Uint8Array(await file.arrayBuffer());
  const pdf = await pdfjsLib.getDocument({ data }).promise;
  const page = await pdf.getPage(1);
  const viewport = page.getViewport({ scale: 1 });
  const scale = 320 / viewport.width;
  const scaled = page.getViewport({ scale });

  const c = document.createElement('canvas');
  c.width = Math.round(scaled.width);
  c.height = Math.round(scaled.height);
  await page.render({ canvasContext: c.getContext('2d'), viewport: scaled }).promise;
  pdf.destroy();

  const blob = await new Promise((resolve) => c.toBlob(resolve, 'image/png'));
  if (!blob) return;
  await fetch(`/api/books/${bookId}/cover`, {
    method: 'PUT',
    headers: { 'Content-Type': 'image/png' },
    body: blob,
  });
}

/* ---------------- Reader ---------------- */

async function openReader(bookId) {
  const token = ++reader.loadToken;
  libraryView.hidden = true;
  readerView.hidden = false;
  readerLoading.hidden = false;
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  try {
    const books = await api('/api/books');
    const book = books.find((b) => b.id === bookId);
    if (!book) throw new Error('Book not found');
    if (token !== reader.loadToken) return;

    reader.book = book;
    reader.page = book.currentPage;
    reader.zoom = 1;
    $('reader-title').textContent = book.title;
    pageSlider.max = book.pageCount;
    pageSlider.value = book.currentPage;

    const [notes, highlights, bookmarks] = await Promise.all([
      api(`/api/books/${bookId}/notes`).catch(() => []),
      api(`/api/books/${bookId}/highlights`).catch(() => []),
      api(`/api/books/${bookId}/bookmarks`).catch(() => []),
    ]);
    if (token !== reader.loadToken) return;
    reader.notes = new Map(notes.map((n) => [n.page, n.content]));
    reader.highlights = new Map();
    for (const hl of highlights) {
      if (!reader.highlights.has(hl.page)) reader.highlights.set(hl.page, []);
      reader.highlights.get(hl.page).push(hl);
    }
    reader.bookmarks = new Set(bookmarks.map((b) => b.page));
    reader.viewMode = book.viewMode || 'paged';

    const pdf = await pdfjsLib.getDocument(`/api/books/${bookId}/file`).promise;
    if (token !== reader.loadToken) {
      pdf.destroy();
      return;
    }
    reader.pdf = pdf;
    readerLoading.hidden = true;
    applyTheme();
    buildThumbStrip();
    loadOutline(pdf, token); // async; reveals the contents button when done
    await enterViewMode(reader.viewMode);

    // Bookmark-as-anchor (spec 10 follow-up): resume where you left off, but
    // if the latest bookmark is on another page, offer a one-tap jump to it.
    const latest = bookmarks
      .slice()
      .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))[0];
    if (latest && latest.page !== reader.page && token === reader.loadToken) {
      toast(`🔖 Bookmark on page ${latest.page} — tap to open`, {
        duration: 6000,
        action: () => goToPage(latest.page, { instantSave: true }),
      });
    }
  } catch (err) {
    if (token !== reader.loadToken) return;
    readerLoading.hidden = false;
    readerLoading.querySelector('p').textContent = err.message;
  }
}

function closeReader() {
  reader.loadToken++;
  closeReaderSheets();
  hideHlToolbar();
  saveProgress(true);
  reader.notes = new Map();
  reader.highlights = new Map();
  reader.bookmarks = new Set();
  reader.outline = [];
  if (textLayerInstance) {
    try { textLayerInstance.cancel(); } catch {}
    textLayerInstance = null;
  }
  textLayerDiv.innerHTML = '';
  highlightLayer.innerHTML = '';
  teardownScrollMode();
  reflowCache.clear();
  reflowView.innerHTML = '';
  teardownThumbStrip();
  $('contents-btn').hidden = true;
  pageWrap.hidden = false;
  scrollStack.hidden = true;
  reflowView.hidden = true;
  if (reader.pdf) reader.pdf.destroy();
  reader.pdf = null;
  reader.book = null;
  reader.rendering = false;
  reader.pendingPage = null;
  reader.pendingDir = 0;
  canvas.width = 0;
  canvas.height = 0;
  canvas.style.width = '';
  canvas.style.height = '';
  $('reader-pageinfo').textContent = '';
  readerView.hidden = true;
  libraryView.hidden = false;
  readerLoading.querySelector('p').textContent = 'Opening book…';
  loadLibrary();
}

async function renderPage(num, dir = 0) {
  if (!reader.pdf || reader.viewMode !== 'paged') return;
  if (reader.rendering) {
    reader.pendingPage = num;
    reader.pendingDir = dir;
    return;
  }
  reader.rendering = true;
  reader.page = num;

  // Snapshot the outgoing page so we can flip it away over the incoming one.
  let snap = null;
  if (dir !== 0 && canvas.width > 0 && !REDUCED_MOTION) {
    snap = document.createElement('canvas');
    snap.width = canvas.width;
    snap.height = canvas.height;
    snap.getContext('2d').drawImage(canvas, 0, 0);
    snap.className = 'page-snapshot';
    snap.style.width = canvas.style.width;
    snap.style.height = canvas.style.height;
  }

  let page, viewport;
  try {
    page = await reader.pdf.getPage(num);
    const base = page.getViewport({ scale: 1 });
    const fitScale = pageContainer.clientWidth / base.width;
    const scale = fitScale * reader.zoom;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    viewport = page.getViewport({ scale });

    canvas.width = Math.round(viewport.width * dpr);
    canvas.height = Math.round(viewport.height * dpr);
    canvas.style.width = `${Math.round(viewport.width)}px`;
    canvas.style.height = `${Math.round(viewport.height)}px`;

    await page.render({
      canvasContext: ctx,
      viewport,
      transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : null,
    }).promise;
  } catch (err) {
    reader.rendering = false;
    throw err;
  }

  // Size the annotation layers to the rendered page and rebuild them.
  highlightLayer.style.width = canvas.style.width;
  highlightLayer.style.height = canvas.style.height;
  textLayerDiv.style.width = canvas.style.width;
  textLayerDiv.style.height = canvas.style.height;
  hideHlToolbar();
  paintHighlights();
  renderTextLayer(page, viewport);

  if (snap) {
    pageWrap.appendChild(snap);
    canvas.classList.remove('page-enter-next', 'page-enter-prev');
    void canvas.offsetWidth; // restart the entrance animation
    canvas.classList.add(dir > 0 ? 'page-enter-next' : 'page-enter-prev');
    requestAnimationFrame(() =>
      snap.classList.add(dir > 0 ? 'flip-out-next' : 'flip-out-prev')
    );
    setTimeout(() => snap.remove(), 500);
  }

  reader.rendering = false;
  updatePageUI();

  if (reader.pendingPage !== null) {
    const next = reader.pendingPage;
    const nextDir = reader.pendingDir;
    reader.pendingPage = null;
    reader.pendingDir = 0;
    renderPage(next, nextDir);
  }
}

function updatePageUI() {
  $('reader-pageinfo').textContent = `${reader.page} / ${reader.book.pageCount}`;
  pageSlider.value = reader.page;
  updateSliderFill();
  $('note-btn').classList.toggle('has-note', reader.notes.has(reader.page));
  $('bookmark-btn').classList.toggle('active', reader.bookmarks.has(reader.page));
  updateThumbActive();
}

function updateSliderFill() {
  const max = parseInt(pageSlider.max, 10) || 1;
  const val = parseInt(pageSlider.value, 10) || 1;
  const pct = max > 1 ? ((val - 1) / (max - 1)) * 100 : 100;
  pageSlider.style.setProperty('--fill', `${pct}%`);
}

function goToPage(num, { instantSave = false } = {}) {
  if (!reader.book) return;
  const clamped = Math.min(Math.max(num, 1), reader.book.pageCount);
  if (reader.viewMode === 'scroll') {
    scrollToPage(clamped);
    saveProgress(instantSave);
    return;
  }
  if (clamped === reader.page && !reader.rendering) return;
  const dir = clamped > reader.page ? 1 : -1;
  pageContainer.scrollTop = 0;
  if (reader.viewMode === 'reflow') renderReflow(clamped);
  else renderPage(clamped, dir);
  saveProgress(instantSave);
}

let saveTimer = null;
function saveProgress(instant = false) {
  if (!reader.book) return;
  clearTimeout(saveTimer);
  const send = () => {
    if (!reader.book) return;
    fetch(`/api/books/${reader.book.id}/progress`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ page: reader.page }),
      keepalive: true,
    }).catch(() => {});
  };
  if (instant) send();
  else saveTimer = setTimeout(send, 800);
}

/* ---------------- Highlights ---------------- */

const hlToolbar = $('hl-toolbar');
const hlMenu = { mode: 'create', target: null };

async function renderTextLayer(page, viewport) {
  if (textLayerInstance) {
    try { textLayerInstance.cancel(); } catch {}
    textLayerInstance = null;
  }
  textLayerDiv.innerHTML = '';
  textLayerDiv.style.setProperty('--scale-factor', viewport.scale);
  try {
    const tl = new pdfjsLib.TextLayer({
      textContentSource: page.streamTextContent(),
      container: textLayerDiv,
      viewport,
    });
    textLayerInstance = tl;
    await tl.render();
  } catch {
    /* cancelled mid-render — the next page's layer takes over */
  }
}

function paintHighlightsInto(layer, pageNum, w, h) {
  layer.innerHTML = '';
  if (!w || !h) return;
  for (const hl of reader.highlights.get(pageNum) || []) {
    hl.rects.forEach(([x, y, rw, rh], i) => {
      const d = document.createElement('div');
      d.className = 'hl-rect';
      d.style.background = HL_COLORS[hl.color] || HL_COLORS.amber;
      d.style.left = `${x * w}px`;
      d.style.top = `${y * h}px`;
      d.style.width = `${rw * w}px`;
      d.style.height = `${rh * h}px`;
      layer.appendChild(d);
      if (i === 0 && hl.note) {
        const notch = document.createElement('div');
        notch.className = 'hl-notch';
        notch.style.left = `${(x + rw) * w - 5}px`;
        notch.style.top = `${y * h - 4}px`;
        layer.appendChild(notch);
      }
    });
  }
}

function paintHighlights() {
  if (reader.viewMode === 'paged') {
    paintHighlightsInto(
      highlightLayer,
      reader.page,
      parseFloat(canvas.style.width) || 0,
      parseFloat(canvas.style.height) || 0
    );
  } else if (reader.viewMode === 'scroll' && scrollState) {
    for (const el of scrollState.els) {
      if (!el.dataset.rendered) continue;
      const layer = el.querySelector('.highlight-layer');
      if (layer) {
        paintHighlightsInto(layer, parseInt(el.dataset.page, 10), el.clientWidth, el.clientHeight);
      }
    }
  }
}

function showHlToolbar(mode, anchorRect, target = null) {
  hlMenu.mode = mode;
  hlMenu.target = target;
  $('hl-delete').hidden = mode !== 'edit';
  hlToolbar.hidden = false;

  const tbRect = hlToolbar.getBoundingClientRect();
  let left = anchorRect.left + anchorRect.width / 2 - tbRect.width / 2;
  left = Math.min(Math.max(left, 10), window.innerWidth - tbRect.width - 10);
  let top = anchorRect.bottom + 12;
  if (top + tbRect.height > window.innerHeight - 90) top = anchorRect.top - tbRect.height - 12;
  hlToolbar.style.left = `${left}px`;
  hlToolbar.style.top = `${Math.max(top, 10)}px`;
}

function hideHlToolbar() {
  hlToolbar.hidden = true;
  hlMenu.target = null;
  hlMenu.mode = 'create';
}

// The text layer sits above the highlight rects and swallows their pointer
// events, so highlight taps are resolved by coordinates instead. In scroll
// mode every rendered page is a candidate surface.
function hitSurfaces() {
  if (reader.viewMode === 'paged') return [{ el: canvas, page: reader.page }];
  if (reader.viewMode === 'scroll' && scrollState) {
    return scrollState.els
      .filter((el) => el.dataset.rendered)
      .map((el) => ({ el: el.querySelector('canvas'), page: parseInt(el.dataset.page, 10) }))
      .filter((s) => s.el);
  }
  return [];
}

function hitTestHighlight(cx, cy) {
  for (const { el, page } of hitSurfaces()) {
    const c = el.getBoundingClientRect();
    if (!c.width || cx < c.left || cx > c.right || cy < c.top || cy > c.bottom) continue;
    const fx = (cx - c.left) / c.width;
    const fy = (cy - c.top) / c.height;
    for (const hl of reader.highlights.get(page) || []) {
      for (const [x, y, w, h] of hl.rects) {
        if (fx >= x && fx <= x + w && fy >= y && fy <= y + h) {
          return {
            hl,
            rect: new DOMRect(c.left + x * c.width, c.top + y * c.height, w * c.width, h * c.height),
          };
        }
      }
    }
  }
  return null;
}

const closestLayer = (node) =>
  (node?.nodeType === 3 ? node.parentElement : node)?.closest?.('.textLayer') || null;

function selectionInTextLayer() {
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed || !sel.rangeCount) return null;
  const a = closestLayer(sel.anchorNode);
  return a && a === closestLayer(sel.focusNode) ? sel : null;
}

// Which page/canvas does the current selection live on?
function getSelectionContext(sel) {
  const layer = closestLayer(sel.anchorNode);
  if (!layer) return null;
  if (layer === textLayerDiv) return { page: reader.page, canvasEl: canvas };
  const sp = layer.closest('.scroll-page');
  if (sp) return { page: parseInt(sp.dataset.page, 10), canvasEl: sp.querySelector('canvas') };
  return null;
}

// Convert selection client rects to page-box fractions, dropping the
// duplicate/contained rects browsers emit for multi-span selections.
function normalizeSelectionRects(clientRects, canvasEl) {
  const c = canvasEl.getBoundingClientRect();
  if (!c.width || !c.height) return [];
  const clamp01 = (v) => Math.min(Math.max(v, 0), 1);
  const frs = [];
  for (const r of clientRects) {
    if (r.width < 2 || r.height < 2) continue;
    const x = clamp01((r.left - c.left) / c.width);
    const y = clamp01((r.top - c.top) / c.height);
    const w = clamp01(r.width / c.width);
    const h = clamp01(r.height / c.height);
    if (w <= 0.002 || h <= 0.002) continue;
    frs.push([x, y, Math.min(w, 1 - x), Math.min(h, 1 - y)]);
  }
  const eps = 0.006;
  const contained = (a, b) =>
    a[0] >= b[0] - eps && a[1] >= b[1] - eps &&
    a[0] + a[2] <= b[0] + b[2] + eps && a[1] + a[3] <= b[1] + b[3] + eps;
  const out = [];
  for (const r of frs) {
    if (out.some((o) => contained(r, o))) continue;
    for (let i = out.length - 1; i >= 0; i--) if (contained(out[i], r)) out.splice(i, 1);
    out.push(r);
  }
  return out.slice(0, 40);
}

async function createHighlightFromSelection(color) {
  const sel = selectionInTextLayer();
  if (!sel || !reader.book) return hideHlToolbar(), null;
  const ctx = getSelectionContext(sel);
  if (!ctx?.canvasEl) return hideHlToolbar(), null;
  const rects = normalizeSelectionRects([...sel.getRangeAt(0).getClientRects()], ctx.canvasEl);
  const text = sel.toString().replace(/\s+/g, ' ').trim().slice(0, 1000);
  if (!rects.length || !text) return hideHlToolbar(), null;

  const page = ctx.page;
  sel.removeAllRanges();
  hideHlToolbar();
  try {
    const hl = await api(`/api/books/${reader.book.id}/highlights`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ page, color, text, rects }),
    });
    if (!reader.highlights.has(page)) reader.highlights.set(page, []);
    reader.highlights.get(page).push(hl);
    paintHighlights();
    return hl;
  } catch (err) {
    toast(err.message, { error: true });
    return null;
  }
}

async function recolorHighlight(hl, color) {
  hideHlToolbar();
  try {
    await api(`/api/books/${reader.book.id}/highlights/${hl.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ color }),
    });
    hl.color = color;
    paintHighlights();
  } catch (err) {
    toast(err.message, { error: true });
  }
}

async function deleteHighlight(hl) {
  hideHlToolbar();
  try {
    await api(`/api/books/${reader.book.id}/highlights/${hl.id}`, { method: 'DELETE' });
    const list = reader.highlights.get(hl.page) || [];
    reader.highlights.set(hl.page, list.filter((h) => h.id !== hl.id));
    paintHighlights();
  } catch (err) {
    toast(err.message, { error: true });
  }
}

for (const dot of hlToolbar.querySelectorAll('.hl-dot')) {
  dot.addEventListener('click', (e) => {
    e.stopPropagation();
    const color = dot.dataset.color;
    if (hlMenu.mode === 'edit' && hlMenu.target) recolorHighlight(hlMenu.target, color);
    else createHighlightFromSelection(color);
  });
}

$('hl-copy').addEventListener('click', (e) => {
  e.stopPropagation();
  const text =
    hlMenu.mode === 'edit' && hlMenu.target
      ? hlMenu.target.text
      : window.getSelection()?.toString() || '';
  if (text) {
    navigator.clipboard?.writeText(text).then(
      () => toast('Copied'),
      () => toast('Couldn’t copy', { error: true })
    );
  }
  window.getSelection()?.removeAllRanges();
  hideHlToolbar();
});

$('hl-delete').addEventListener('click', (e) => {
  e.stopPropagation();
  if (hlMenu.target) deleteHighlight(hlMenu.target);
});

let selDebounce = null;
document.addEventListener('selectionchange', () => {
  if (readerView.hidden) return;
  clearTimeout(selDebounce);
  selDebounce = setTimeout(() => {
    const sel = selectionInTextLayer();
    if (sel) {
      showHlToolbar('create', sel.getRangeAt(0).getBoundingClientRect());
    } else if (hlMenu.mode === 'create' && !hlToolbar.hidden) {
      hideHlToolbar();
    }
  }, 180);
});

pageContainer.addEventListener('scroll', hideHlToolbar, { passive: true });

/* ---------------- Page notes ---------------- */

const noteBackdrop = $('note-backdrop');
const noteSheet = $('note-sheet');
const noteText = $('note-text');
const noteStatus = $('note-status');
const notesListSheet = $('notes-list-sheet');

const note = { page: null, dirty: false, saveTimer: null, statusTimer: null };

function openNoteSheet() {
  if (!reader.book) return;
  note.page = reader.page;
  note.dirty = false;
  $('note-title').textContent = `Note · page ${note.page}`;
  noteText.value = reader.notes.get(note.page) || '';
  noteStatus.textContent = '';
  openReaderSheet(noteSheet);
  noteText.focus();
}

function openNotesList() {
  const list = $('notes-list');
  list.innerHTML = '';
  const typeOrder = { bookmark: 0, note: 1, highlight: 2 };
  const entries = [
    ...[...reader.bookmarks].map((page) => ({ type: 'bookmark', page, content: 'Bookmarked page' })),
    ...[...reader.notes.entries()].map(([page, content]) => ({ type: 'note', page, content })),
    ...[...reader.highlights.values()].flat().map((hl) => ({
      type: 'highlight',
      page: hl.page,
      content: hl.text,
      color: hl.color,
      note: hl.note,
    })),
  ].sort((a, b) => a.page - b.page || typeOrder[a.type] - typeOrder[b.type]);
  $('notes-list-title').textContent = entries.length
    ? `Notes & highlights in “${reader.book.title}”`
    : 'Nothing marked in this book yet';
  for (const entry of entries) {
    const item = document.createElement('div');
    item.className = 'note-item';
    const np = document.createElement('div');
    np.className = 'note-item-page';
    if (entry.type === 'highlight') {
      const chip = document.createElement('span');
      chip.className = 'hl-chip';
      chip.style.background = HL_COLORS[entry.color] || HL_COLORS.amber;
      np.append(chip, `Page ${entry.page}`);
    } else if (entry.type === 'bookmark') {
      np.textContent = `🔖 Page ${entry.page}`;
    } else {
      np.textContent = `Page ${entry.page}`;
    }
    const nc = document.createElement('div');
    nc.className = 'note-item-content';
    if (entry.type === 'highlight') nc.classList.add('quote');
    nc.textContent = entry.type === 'highlight' ? `“${entry.content}”` : entry.content;
    item.append(np, nc);
    if (entry.type === 'highlight' && entry.note) {
      const under = document.createElement('div');
      under.className = 'note-under';
      under.textContent = entry.note;
      item.appendChild(under);
    }
    item.addEventListener('click', () => {
      closeNoteSheets();
      goToPage(entry.page, { instantSave: true });
    });
    list.appendChild(item);
  }

  const exportBtn = document.createElement('a');
  exportBtn.className = 'btn btn-ghost';
  exportBtn.style.textAlign = 'center';
  exportBtn.style.textDecoration = 'none';
  exportBtn.textContent = 'Export as Markdown';
  exportBtn.href = `/api/books/${reader.book.id}/export.md`;
  exportBtn.download = '';
  list.appendChild(exportBtn);

  openReaderSheet(notesListSheet);
}

const closeNoteSheets = closeReaderSheets;

function saveNote() {
  if (note.page === null || !reader.book) return;
  const page = note.page;
  const content = noteText.value;
  note.dirty = false;
  fetch(`/api/books/${reader.book.id}/notes/${page}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content }),
    keepalive: true,
  })
    .then((res) => {
      if (!res.ok) throw new Error('save failed');
      if (content.trim()) reader.notes.set(page, content);
      else reader.notes.delete(page);
      if (reader.book && page === reader.page) {
        $('note-btn').classList.toggle('has-note', reader.notes.has(page));
      }
      noteStatus.textContent = 'Saved ✓';
      clearTimeout(note.statusTimer);
      note.statusTimer = setTimeout(() => (noteStatus.textContent = ''), 1600);
    })
    .catch(() => {
      noteStatus.textContent = 'Couldn’t save — retrying…';
      note.dirty = true;
      clearTimeout(note.saveTimer);
      note.saveTimer = setTimeout(saveNote, 2000);
    });
}

function flushNoteSave() {
  clearTimeout(note.saveTimer);
  if (note.dirty) saveNote();
}

noteText.addEventListener('input', () => {
  note.dirty = true;
  noteStatus.textContent = 'Saving…';
  clearTimeout(note.saveTimer);
  note.saveTimer = setTimeout(saveNote, 700);
});

$('note-btn').addEventListener('click', openNoteSheet);
$('all-notes-btn').addEventListener('click', openNotesList);
noteBackdrop.addEventListener('click', closeNoteSheets);

/* ---------------- View modes: paged / scroll / reflow (specs 01, 03) ---------------- */

async function enterViewMode(mode) {
  reader.viewMode = mode;
  hideHlToolbar();
  pageWrap.hidden = mode !== 'paged';
  scrollStack.hidden = mode !== 'scroll';
  reflowView.hidden = mode !== 'reflow';
  if (mode !== 'scroll') teardownScrollMode();
  pageContainer.scrollTop = 0;
  applyFontSize();
  if (mode === 'paged') {
    reader.zoom = 1;
    await renderPage(reader.page);
  } else if (mode === 'scroll') {
    await buildScrollStack();
    scrollToPage(reader.page, true);
  } else {
    await renderReflow(reader.page);
  }
  updateDisplaySheetUI();
  updatePageUI();
}

function setViewMode(mode) {
  if (mode === reader.viewMode || !reader.book) return;
  enterViewMode(mode);
  fetch(`/api/books/${reader.book.id}/view-mode`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ mode }),
  }).catch(() => {});
}

/* Scroll mode */

let scrollState = null;

async function buildScrollStack() {
  teardownScrollMode();
  if (!reader.pdf) return;
  const token = reader.loadToken;
  const p1 = await reader.pdf.getPage(1);
  const v1 = p1.getViewport({ scale: 1 });
  const baseRatio = v1.height / v1.width;
  const width = pageContainer.clientWidth;
  scrollStack.innerHTML = '';
  const els = [];
  for (let p = 1; p <= reader.book.pageCount; p++) {
    const el = document.createElement('div');
    el.className = 'scroll-page';
    el.dataset.page = p;
    el.style.height = `${Math.round(width * baseRatio)}px`;
    scrollStack.appendChild(el);
    els.push(el);
  }
  const renderObs = new IntersectionObserver(
    (entries) => {
      for (const en of entries) {
        const p = parseInt(en.target.dataset.page, 10);
        if (en.isIntersecting) renderScrollPage(p, en.target);
        else if (en.target.dataset.rendered) teardownScrollPage(en.target);
      }
    },
    { root: pageContainer, rootMargin: '150% 0px' }
  );
  els.forEach((el) => renderObs.observe(el));
  scrollState = { els, renderObs, token };
  pageContainer.addEventListener('scroll', onScrollProgress, { passive: true });
}

async function renderScrollPage(p, el) {
  if (el.dataset.rendered || !reader.pdf || !scrollState) return;
  el.dataset.rendered = '1';
  const token = scrollState.token;
  try {
    const page = await reader.pdf.getPage(p);
    if (!scrollState || scrollState.token !== token) return;
    const width = pageContainer.clientWidth;
    const scale = width / page.getViewport({ scale: 1 }).width;
    const viewport = page.getViewport({ scale });
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    el.style.height = `${Math.round(viewport.height)}px`;

    const c = document.createElement('canvas');
    c.width = Math.round(viewport.width * dpr);
    c.height = Math.round(viewport.height * dpr);
    const hlLayer = document.createElement('div');
    hlLayer.className = 'highlight-layer';
    const tl = document.createElement('div');
    tl.className = 'textLayer';
    tl.style.setProperty('--scale-factor', viewport.scale);
    el.replaceChildren(c, hlLayer, tl);

    await page.render({
      canvasContext: c.getContext('2d'),
      viewport,
      transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : null,
    }).promise;
    paintHighlightsInto(hlLayer, p, el.clientWidth, el.clientHeight);
    try {
      await new pdfjsLib.TextLayer({
        textContentSource: page.streamTextContent(),
        container: tl,
        viewport,
      }).render();
    } catch {}
  } catch {
    el.dataset.rendered = '';
  }
}

function teardownScrollPage(el) {
  el.replaceChildren();
  el.dataset.rendered = '';
}

function teardownScrollMode() {
  if (!scrollState) return;
  scrollState.renderObs.disconnect();
  pageContainer.removeEventListener('scroll', onScrollProgress);
  scrollStack.innerHTML = '';
  scrollState = null;
}

function scrollToPage(p, instant = false) {
  if (!scrollState) return;
  const el = scrollState.els[p - 1];
  if (!el) return;
  reader.page = p;
  updatePageUI();
  pageContainer.scrollTo({ top: Math.max(el.offsetTop - 8, 0), behavior: instant ? 'auto' : 'smooth' });
}

let scrollProgressTimer = null;
function onScrollProgress() {
  if (scrollProgressTimer) return;
  scrollProgressTimer = setTimeout(() => {
    scrollProgressTimer = null;
    if (!scrollState) return;
    const anchor = pageContainer.scrollTop + pageContainer.clientHeight * 0.35;
    let current = 1;
    for (const el of scrollState.els) {
      if (el.offsetTop + el.offsetHeight >= anchor) {
        current = parseInt(el.dataset.page, 10);
        break;
      }
    }
    if (current !== reader.page) {
      reader.page = current;
      updatePageUI();
      saveProgress();
    }
  }, 180);
}

/* Reflow mode */

const reflowCache = new Map();

async function renderReflow(num) {
  if (!reader.pdf) return;
  reader.page = num;
  updatePageUI();
  let html = reflowCache.get(num);
  if (html === undefined) {
    try {
      const page = await reader.pdf.getPage(num);
      const tc = await page.getTextContent();
      html = buildReflowHTML(tc);
    } catch {
      html = null;
    }
    reflowCache.set(num, html);
  }
  if (reader.viewMode !== 'reflow' || num !== reader.page) return;
  if (!html) {
    reflowView.innerHTML =
      '<div class="reflow-empty">No extractable text on this page.<br /><br />' +
      '<button class="btn btn-ghost" id="reflow-back-paged">Switch to paged view</button></div>';
    $('reflow-back-paged').addEventListener('click', () => setViewMode('paged'));
  } else {
    reflowView.innerHTML = `<div class="reflow-inner">${html}</div>`;
  }
  pageContainer.scrollTop = 0;
}

// Rebuild paragraphs from positioned text items (spec 01).
function buildReflowHTML(tc) {
  const items = tc.items.filter((i) => i.str && i.str.trim());
  if (!items.length) return null;

  const lines = [];
  for (const it of items) {
    const y = it.transform[5];
    const x = it.transform[4];
    const h = it.height || Math.abs(it.transform[3]) || 10;
    let line = lines.find((l) => Math.abs(l.y - y) < Math.max(2, h * 0.4));
    if (!line) {
      line = { y, x, parts: [] };
      lines.push(line);
    }
    line.parts.push({ x, str: it.str });
    line.x = Math.min(line.x, x);
  }
  lines.sort((a, b) => b.y - a.y);
  const texts = lines.map((l) =>
    l.parts.sort((a, b) => a.x - b.x).map((p) => p.str).join(' ').replace(/\s+/g, ' ').trim()
  );

  const gaps = [];
  for (let i = 1; i < lines.length; i++) gaps.push(Math.abs(lines[i - 1].y - lines[i].y));
  const median = gaps.slice().sort((a, b) => a - b)[Math.floor(gaps.length / 2)] || 0;
  const minX = Math.min(...lines.map((l) => l.x));

  const paras = [];
  let cur = '';
  for (let i = 0; i < texts.length; i++) {
    const breaks =
      i > 0 && ((median > 0 && gaps[i - 1] > median * 1.6) || lines[i].x > minX + 12);
    if (breaks && cur) {
      paras.push(cur);
      cur = '';
    }
    if (cur.endsWith('-')) cur = cur.slice(0, -1) + texts[i];
    else cur = cur ? `${cur} ${texts[i]}` : texts[i];
  }
  if (cur) paras.push(cur);
  return paras.map((p) => `<p>${escapeHtml(p)}</p>`).join('');
}

function escapeHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/* ---------------- Display sheet & themes (spec 02) ---------------- */

function applyTheme() {
  readerView.classList.remove('theme-light', 'theme-sepia', 'theme-dark');
  readerView.classList.add(`theme-${prefs.theme}`);
}

function applyFontSize() {
  reflowView.style.setProperty('--reflow-size', `${prefs.fontSize}px`);
}

function updateDisplaySheetUI() {
  for (const b of $('seg-view').querySelectorAll('button')) {
    b.classList.toggle('active', b.dataset.mode === reader.viewMode);
  }
  for (const b of $('seg-theme').querySelectorAll('button')) {
    b.classList.toggle('active', b.dataset.theme === prefs.theme);
  }
  $('row-fontsize').hidden = reader.viewMode !== 'reflow';
  $('row-zoom').hidden = reader.viewMode !== 'paged';
  $('zoom-label').textContent = `${Math.round(reader.zoom * 100)}%`;
  $('font-size-slider').value = prefs.fontSize;
}

$('display-btn').addEventListener('click', () => {
  updateDisplaySheetUI();
  openReaderSheet($('display-sheet'));
});

for (const b of $('seg-view').querySelectorAll('button')) {
  b.addEventListener('click', () => setViewMode(b.dataset.mode));
}
for (const b of $('seg-theme').querySelectorAll('button')) {
  b.addEventListener('click', () => {
    prefs.theme = b.dataset.theme;
    localStorage.setItem('bv-theme', prefs.theme);
    applyTheme();
    updateDisplaySheetUI();
  });
}
$('font-size-slider').addEventListener('input', () => {
  prefs.fontSize = parseInt($('font-size-slider').value, 10);
  localStorage.setItem('bv-fontsize', prefs.fontSize);
  applyFontSize();
});

/* ---------------- Outline / contents (spec 05) ---------------- */

async function loadOutline(pdf, token) {
  try {
    const outline = await pdf.getOutline();
    if (!outline?.length || token !== reader.loadToken) return;
    const flat = [];
    const walk = async (items, depth) => {
      for (const item of items || []) {
        try {
          let dest = item.dest;
          if (typeof dest === 'string') dest = await pdf.getDestination(dest);
          if (Array.isArray(dest) && dest[0]) {
            const idx = await pdf.getPageIndex(dest[0]);
            flat.push({ title: item.title || 'Untitled', page: idx + 1, depth });
          }
        } catch {}
        if (item.items?.length && depth < 2) await walk(item.items, depth + 1);
      }
    };
    await walk(outline, 0);
    if (token !== reader.loadToken) return;
    reader.outline = flat;
    $('contents-btn').hidden = flat.length === 0;
  } catch {}
}

$('contents-btn').addEventListener('click', () => {
  const list = $('contents-list');
  list.innerHTML = '';
  for (const item of reader.outline) {
    const el = document.createElement('div');
    el.className = 'note-item';
    el.style.paddingLeft = `${14 + item.depth * 18}px`;
    el.style.display = 'flex';
    el.style.justifyContent = 'space-between';
    el.style.gap = '10px';
    const t = document.createElement('span');
    t.textContent = item.title;
    const p = document.createElement('span');
    p.style.color = 'var(--muted)';
    p.style.flexShrink = '0';
    p.textContent = item.page;
    el.append(t, p);
    el.addEventListener('click', () => {
      closeReaderSheets();
      goToPage(item.page, { instantSave: true });
    });
    list.appendChild(el);
  }
  openReaderSheet($('contents-sheet'));
});

/* ---------------- Thumbnail strip (spec 06) ---------------- */

let thumbState = null;

function buildThumbStrip() {
  teardownThumbStrip();
  thumbStrip.innerHTML = '';
  const cells = [];
  for (let p = 1; p <= reader.book.pageCount; p++) {
    const cell = document.createElement('div');
    cell.className = 'thumb-cell';
    cell.dataset.page = p;
    cell.style.height = '74px';
    const num = document.createElement('span');
    num.className = 'thumb-num';
    num.textContent = p;
    cell.appendChild(num);
    cell.addEventListener('click', () => goToPage(p));
    thumbStrip.appendChild(cell);
    cells.push(cell);
  }
  const obs = new IntersectionObserver(
    (entries) => {
      for (const en of entries) {
        if (en.isIntersecting) renderThumb(parseInt(en.target.dataset.page, 10), en.target);
      }
    },
    { root: thumbStrip, rootMargin: '0px 250px' }
  );
  cells.forEach((c) => obs.observe(c));
  thumbState = { cells, obs, rendered: new Map(), pinned: false, hideTimer: null };
}

async function renderThumb(p, cell) {
  if (!thumbState || thumbState.rendered.has(p) || !reader.pdf) return;
  thumbState.rendered.set(p, true);
  try {
    const page = await reader.pdf.getPage(p);
    if (!thumbState) return;
    const scale = 56 / page.getViewport({ scale: 1 }).width;
    const viewport = page.getViewport({ scale });
    const c = document.createElement('canvas');
    c.width = Math.round(viewport.width * 2);
    c.height = Math.round(viewport.height * 2);
    await page.render({
      canvasContext: c.getContext('2d'),
      viewport,
      transform: [2, 0, 0, 2, 0, 0],
    }).promise;
    if (!thumbState) return;
    cell.style.height = '';
    cell.insertBefore(c, cell.firstChild);
    if (thumbState.rendered.size > 60) {
      const oldest = thumbState.rendered.keys().next().value;
      if (oldest !== p) {
        thumbState.rendered.delete(oldest);
        const oldCell = thumbState.cells[oldest - 1];
        oldCell.querySelector('canvas')?.remove();
        oldCell.style.height = '74px';
      }
    }
  } catch {
    thumbState?.rendered.delete(p);
  }
}

function teardownThumbStrip() {
  if (!thumbState) return;
  thumbState.obs.disconnect();
  clearTimeout(thumbState.hideTimer);
  thumbStrip.innerHTML = '';
  thumbStrip.hidden = true;
  thumbState = null;
}

function showThumbStrip() {
  if (!thumbState) return;
  clearTimeout(thumbState.hideTimer);
  thumbStrip.hidden = false;
}

function scheduleThumbHide() {
  if (!thumbState || thumbState.pinned) return;
  clearTimeout(thumbState.hideTimer);
  thumbState.hideTimer = setTimeout(() => {
    thumbStrip.hidden = true;
  }, 1500);
}

function centerThumb(p, instant = false) {
  const cell = thumbState?.cells[p - 1];
  if (!cell || thumbStrip.hidden) return;
  thumbStrip.scrollTo({
    left: cell.offsetLeft - thumbStrip.clientWidth / 2 + 28,
    behavior: instant ? 'auto' : 'smooth',
  });
}

function updateThumbActive() {
  if (!thumbState) return;
  for (const c of thumbState.cells) {
    c.classList.toggle('active', parseInt(c.dataset.page, 10) === reader.page);
  }
}

$('reader-pageinfo').addEventListener('click', () => {
  if (!thumbState) return;
  if (!thumbStrip.hidden) {
    thumbStrip.hidden = true;
    thumbState.pinned = false;
  } else {
    thumbState.pinned = true;
    showThumbStrip();
    updateThumbActive();
    centerThumb(reader.page, true);
  }
});

/* ---------------- Bookmarks (spec 10) ---------------- */

$('bookmark-btn').addEventListener('click', async () => {
  if (!reader.book) return;
  const page = reader.page;
  const had = reader.bookmarks.has(page);
  if (had) reader.bookmarks.delete(page);
  else reader.bookmarks.add(page);
  updatePageUI();
  try {
    if (had) {
      await api(`/api/books/${reader.book.id}/bookmarks/${page}`, { method: 'DELETE' });
    } else {
      await api(`/api/books/${reader.book.id}/bookmarks/${page}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      });
    }
  } catch (err) {
    if (had) reader.bookmarks.add(page);
    else reader.bookmarks.delete(page);
    updatePageUI();
    toast(err.message, { error: true });
  }
});

/* ---------------- In-book search (spec 04) ---------------- */

$('search-btn').addEventListener('click', () => {
  $('search-results').innerHTML = '';
  openReaderSheet($('search-sheet'));
  $('search-input').focus();
});

async function runSearch() {
  const q = $('search-input').value.trim();
  const results = $('search-results');
  if (!q || !reader.book) return;
  results.innerHTML = '<div class="search-status">Searching…</div>';
  try {
    const rows = await api(`/api/books/${reader.book.id}/search?q=${encodeURIComponent(q)}`);
    if (!rows.length) {
      results.innerHTML = `<div class="search-status">No matches for “${escapeHtml(q)}”</div>`;
      return;
    }
    results.innerHTML = '';
    for (const r of rows) {
      const item = document.createElement('div');
      item.className = 'note-item';
      const np = document.createElement('div');
      np.className = 'note-item-page';
      np.textContent = `Page ${r.page}`;
      const nc = document.createElement('div');
      nc.className = 'note-item-content';
      nc.innerHTML = escapeHtml(r.snippet)
        .replace(/&lt;b&gt;/g, '<b>')
        .replace(/&lt;\/b&gt;/g, '</b>');
      item.append(np, nc);
      item.addEventListener('click', () => {
        closeReaderSheets();
        jumpToMatch(r.page, q);
      });
      results.appendChild(item);
    }
  } catch (err) {
    results.innerHTML = `<div class="search-status">${escapeHtml(err.message)}</div>`;
  }
}

$('search-go').addEventListener('click', runSearch);
$('search-input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') runSearch();
});

function jumpToMatch(page, q) {
  goToPage(page, { instantSave: true });
  if (reader.viewMode === 'paged') {
    setTimeout(() => {
      if (!flashPagedMatches(q)) setTimeout(() => flashPagedMatches(q), 900);
    }, 500);
  } else if (reader.viewMode === 'reflow') {
    setTimeout(() => flashReflowMatch(q), 400);
  }
}

function flashPagedMatches(q) {
  const needle = q.toLowerCase();
  const wrapRect = pageWrap.getBoundingClientRect();
  let painted = 0;
  for (const span of textLayerDiv.querySelectorAll('span')) {
    if (painted >= 20) break;
    const node = span.firstChild;
    if (!node || node.nodeType !== 3) continue;
    const text = node.textContent.toLowerCase();
    let idx = text.indexOf(needle);
    while (idx !== -1 && painted < 20) {
      try {
        const range = document.createRange();
        range.setStart(node, idx);
        range.setEnd(node, idx + needle.length);
        for (const r of range.getClientRects()) {
          const d = document.createElement('div');
          d.className = 'search-flash';
          d.style.left = `${r.left - wrapRect.left}px`;
          d.style.top = `${r.top - wrapRect.top}px`;
          d.style.width = `${r.width}px`;
          d.style.height = `${r.height}px`;
          pageWrap.appendChild(d);
          setTimeout(() => d.remove(), 2500);
          painted++;
        }
      } catch {}
      idx = text.indexOf(needle, idx + 1);
    }
  }
  return painted > 0;
}

function flashReflowMatch(q) {
  const needle = q.toLowerCase();
  for (const p of reflowView.querySelectorAll('p')) {
    if (p.textContent.toLowerCase().includes(needle)) {
      p.scrollIntoView({ block: 'center' });
      p.classList.add('flash');
      setTimeout(() => p.classList.remove('flash'), 2100);
      return;
    }
  }
}

/* ---------------- Highlight notes (spec 07) ---------------- */

const hlNote = { target: null, dirty: false, saveTimer: null, statusTimer: null };
const hlNoteText = $('hl-note-text');
const hlNoteStatus = $('hl-note-status');

function openHlNoteSheet(hl) {
  flushHlNoteSave();
  hlNote.target = hl;
  hlNote.dirty = false;
  const preview = hl.text.length > 46 ? `${hl.text.slice(0, 46)}…` : hl.text;
  $('hl-note-title').textContent = `“${preview}”`;
  hlNoteText.value = hl.note || '';
  hlNoteStatus.textContent = '';
  openReaderSheet($('hl-note-sheet'));
  hlNoteText.focus();
}

function saveHlNote() {
  const hl = hlNote.target;
  if (!hl || !reader.book) return;
  const value = hlNoteText.value;
  hlNote.dirty = false;
  fetch(`/api/books/${reader.book.id}/highlights/${hl.id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ note: value }),
    keepalive: true,
  })
    .then((res) => {
      if (!res.ok) throw new Error('save failed');
      hl.note = value;
      paintHighlights();
      hlNoteStatus.textContent = 'Saved ✓';
      clearTimeout(hlNote.statusTimer);
      hlNote.statusTimer = setTimeout(() => (hlNoteStatus.textContent = ''), 1600);
    })
    .catch(() => {
      hlNoteStatus.textContent = 'Couldn’t save — retrying…';
      hlNote.dirty = true;
      clearTimeout(hlNote.saveTimer);
      hlNote.saveTimer = setTimeout(saveHlNote, 2000);
    });
}

function flushHlNoteSave() {
  clearTimeout(hlNote.saveTimer);
  if (hlNote.dirty) saveHlNote();
}

hlNoteText.addEventListener('input', () => {
  hlNote.dirty = true;
  hlNoteStatus.textContent = 'Saving…';
  clearTimeout(hlNote.saveTimer);
  hlNote.saveTimer = setTimeout(saveHlNote, 700);
});

$('hl-note-btn').addEventListener('click', async (e) => {
  e.stopPropagation();
  if (hlMenu.mode === 'edit' && hlMenu.target) {
    const target = hlMenu.target;
    hideHlToolbar();
    openHlNoteSheet(target);
  } else {
    const created = await createHighlightFromSelection('amber');
    if (created) openHlNoteSheet(created);
  }
});

/* ---------------- Reading stats (spec 09) ---------------- */

$('stats-btn').addEventListener('click', async () => {
  const body = $('stats-body');
  body.innerHTML = '<div class="search-status">Loading…</div>';
  openReaderSheet($('stats-sheet'));
  try {
    const s = await api('/api/stats');
    body.innerHTML = '';

    const streak = document.createElement('div');
    streak.className = 'streak-line';
    streak.textContent = s.streak > 0 ? `🔥 ${s.streak}-day streak` : 'No streak yet — read a page!';
    body.appendChild(streak);

    const maxMin = Math.max(...s.days.map((d) => d.minutes), 1);
    const chart = document.createElement('div');
    chart.className = 'stats-chart';
    for (const d of s.days) {
      const wrap = document.createElement('div');
      wrap.className = 'stats-bar';
      if (d.date === s.days[s.days.length - 1].date) wrap.classList.add('today');
      const bar = document.createElement('div');
      bar.className = 'bar';
      bar.style.height = `${Math.max((d.minutes / maxMin) * 100, 2)}%`;
      bar.title = `${d.date}: ${d.minutes} min · ${d.pages} pages`;
      wrap.appendChild(bar);
      chart.appendChild(wrap);
    }
    body.appendChild(chart);

    const labels = document.createElement('div');
    labels.className = 'stats-chart-labels';
    const fmt = (iso) => new Date(`${iso}T12:00:00`).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
    labels.innerHTML = `<span>${fmt(s.days[0].date)}</span><span>minutes read · last 14 days</span><span>Today</span>`;
    body.appendChild(labels);

    const totals = document.createElement('div');
    totals.className = 'stats-totals';
    const mins = s.totals.minutes;
    const tiles = [
      [mins >= 60 ? `${Math.floor(mins / 60)}h ${mins % 60}m` : `${mins}m`, 'time reading'],
      [s.totals.pages, 'pages turned'],
      [s.totals.booksStarted, 'books started'],
      [s.totals.booksFinished, 'books finished'],
    ];
    for (const [v, k] of tiles) {
      const tile = document.createElement('div');
      tile.className = 'stat-tile';
      tile.innerHTML = `<div class="v">${v}</div><div class="k">${k}</div>`;
      totals.appendChild(tile);
    }
    body.appendChild(totals);
  } catch (err) {
    body.innerHTML = `<div class="search-status">${escapeHtml(err.message)}</div>`;
  }
});

/* Reader controls */

$('back-btn').addEventListener('click', () => {
  location.hash = '';
});
$('prev-btn').addEventListener('click', () => goToPage(reader.page - 1));
$('next-btn').addEventListener('click', () => goToPage(reader.page + 1));

$('zoom-in-btn').addEventListener('click', () => {
  if (reader.viewMode !== 'paged') return;
  reader.zoom = Math.min(reader.zoom + 0.25, 3);
  renderPage(reader.page);
  updateDisplaySheetUI();
});
$('zoom-out-btn').addEventListener('click', () => {
  if (reader.viewMode !== 'paged') return;
  reader.zoom = Math.max(reader.zoom - 0.25, 1);
  renderPage(reader.page);
  updateDisplaySheetUI();
});

function positionBubble() {
  const max = parseInt(pageSlider.max, 10) || 1;
  const val = parseInt(pageSlider.value, 10) || 1;
  const pct = max > 1 ? (val - 1) / (max - 1) : 1;
  const rect = pageSlider.getBoundingClientRect();
  const thumbHalf = 9;
  const x = thumbHalf + pct * (rect.width - thumbHalf * 2);
  sliderBubble.style.left = `${x}px`;
  sliderBubble.textContent = `p. ${val}`;
}

pageSlider.addEventListener('input', () => {
  $('reader-pageinfo').textContent = `${pageSlider.value} / ${reader.book?.pageCount ?? '?'}`;
  updateSliderFill();
  sliderBubble.hidden = false;
  positionBubble();
  showThumbStrip();
  centerThumb(parseInt(pageSlider.value, 10) || 1, true);
});
pageSlider.addEventListener('change', () => {
  sliderBubble.hidden = true;
  goToPage(parseInt(pageSlider.value, 10));
  scheduleThumbHide();
});
pageSlider.addEventListener('blur', () => (sliderBubble.hidden = true));

// Tap zones: left/right third turns pages, center toggles the bars.
pageContainer.addEventListener('click', (e) => {
  const sel = window.getSelection();
  if (sel && !sel.isCollapsed) return; // mid-selection, not a navigation tap
  if (!hlToolbar.hidden) {
    hideHlToolbar();
    return;
  }
  const hit = hitTestHighlight(e.clientX, e.clientY);
  if (hit) {
    showHlToolbar('edit', hit.rect, hit.hl);
    return;
  }
  if (reader.viewMode === 'scroll') {
    toggleBars(); // scrolling is navigation; taps only toggle chrome
    return;
  }
  if (reader.zoom > 1) return;
  const x = e.clientX / window.innerWidth;
  if (x < 0.33) goToPage(reader.page - 1);
  else if (x > 0.67) goToPage(reader.page + 1);
  else toggleBars();
});

function toggleBars() {
  $('reader-topbar').classList.toggle('hidden-bar');
  $('reader-bottombar').classList.toggle('hidden-bar');
}

// Horizontal swipe to turn pages (only when not zoomed, so panning still works).
let touchStart = null;
pageContainer.addEventListener(
  'touchstart',
  (e) => {
    if (e.touches.length === 1) {
      touchStart = { x: e.touches[0].clientX, y: e.touches[0].clientY, t: Date.now() };
    }
  },
  { passive: true }
);
pageContainer.addEventListener(
  'touchend',
  (e) => {
    if (!touchStart || reader.zoom > 1 || reader.viewMode === 'scroll') return;
    const dx = e.changedTouches[0].clientX - touchStart.x;
    const dy = e.changedTouches[0].clientY - touchStart.y;
    const dt = Date.now() - touchStart.t;
    touchStart = null;
    if (dt < 600 && Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy) * 1.5) {
      goToPage(reader.page + (dx < 0 ? 1 : -1));
    }
  },
  { passive: true }
);

document.addEventListener('keydown', (e) => {
  if (readerView.hidden) {
    if (e.key === 'Escape') closeReaderSheets(); // stats sheet opens from the library
    return;
  }
  if (e.target.tagName === 'TEXTAREA' || e.target.tagName === 'INPUT') {
    if (e.key === 'Escape') closeReaderSheets();
    return;
  }
  if (readerSheetEls().some((s) => !s.hidden)) {
    if (e.key === 'Escape') closeReaderSheets();
    return;
  }
  if (e.key === 'ArrowRight' || e.key === ' ') goToPage(reader.page + 1);
  else if (e.key === 'ArrowLeft') goToPage(reader.page - 1);
  else if (e.key === 'n') openNoteSheet();
  else if (e.key === 'Escape') location.hash = '';
});

// Flush progress and any pending notes if the tab is backgrounded or closed.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') {
    saveProgress(true);
    flushNoteSave();
    flushHlNoteSave();
  }
});

let resizeTimer = null;
window.addEventListener('resize', () => {
  if (readerView.hidden || !reader.pdf) return;
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(async () => {
    if (reader.viewMode === 'paged') renderPage(reader.page);
    else if (reader.viewMode === 'scroll') {
      await buildScrollStack();
      scrollToPage(reader.page, true);
    }
  }, 250);
});

/* ---------------- Routing ---------------- */

function route() {
  const match = location.hash.match(/^#\/read\/([\w-]+)$/);
  if (match) {
    openReader(match[1]);
  } else {
    if (!readerView.hidden) closeReader();
    else loadLibrary();
  }
}

window.addEventListener('hashchange', route);
route();
