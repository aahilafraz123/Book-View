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
};

const textLayerDiv = $('text-layer');
const highlightLayer = $('highlight-layer');
const HL_COLORS = { amber: '#f2c14e', green: '#8fd07f', blue: '#7fb8e6', pink: '#f0a1c0' };
let textLayerInstance = null;

/* ---------------- API ---------------- */

async function api(path, options = {}) {
  const res = await fetch(path, options);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `Request failed (${res.status})`);
  return body;
}

/* ---------------- Toasts ---------------- */

function toast(message, { error = false, duration = 2800 } = {}) {
  const el = document.createElement('div');
  el.className = `toast${error ? ' error' : ''}`;
  el.textContent = message;
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

    const [notes, highlights] = await Promise.all([
      api(`/api/books/${bookId}/notes`).catch(() => []),
      api(`/api/books/${bookId}/highlights`).catch(() => []),
    ]);
    if (token !== reader.loadToken) return;
    reader.notes = new Map(notes.map((n) => [n.page, n.content]));
    reader.highlights = new Map();
    for (const hl of highlights) {
      if (!reader.highlights.has(hl.page)) reader.highlights.set(hl.page, []);
      reader.highlights.get(hl.page).push(hl);
    }

    const pdf = await pdfjsLib.getDocument(`/api/books/${bookId}/file`).promise;
    if (token !== reader.loadToken) {
      pdf.destroy();
      return;
    }
    reader.pdf = pdf;
    readerLoading.hidden = true;
    await renderPage(reader.page);
  } catch (err) {
    if (token !== reader.loadToken) return;
    readerLoading.hidden = false;
    readerLoading.querySelector('p').textContent = err.message;
  }
}

function closeReader() {
  reader.loadToken++;
  closeNoteSheets();
  hideHlToolbar();
  saveProgress(true);
  reader.notes = new Map();
  reader.highlights = new Map();
  if (textLayerInstance) {
    try { textLayerInstance.cancel(); } catch {}
    textLayerInstance = null;
  }
  textLayerDiv.innerHTML = '';
  highlightLayer.innerHTML = '';
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
  if (!reader.pdf) return;
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
  if (clamped === reader.page && !reader.rendering) return;
  const dir = clamped > reader.page ? 1 : -1;
  pageContainer.scrollTop = 0;
  renderPage(clamped, dir);
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

function paintHighlights() {
  highlightLayer.innerHTML = '';
  const list = reader.highlights.get(reader.page) || [];
  const w = parseFloat(canvas.style.width) || 0;
  const h = parseFloat(canvas.style.height) || 0;
  if (!w || !h) return;
  for (const hl of list) {
    for (const [x, y, rw, rh] of hl.rects) {
      const d = document.createElement('div');
      d.className = 'hl-rect';
      d.style.background = HL_COLORS[hl.color] || HL_COLORS.amber;
      d.style.left = `${x * w}px`;
      d.style.top = `${y * h}px`;
      d.style.width = `${rw * w}px`;
      d.style.height = `${rh * h}px`;
      highlightLayer.appendChild(d);
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
// events, so highlight taps are resolved by coordinates instead.
function hitTestHighlight(cx, cy) {
  const c = canvas.getBoundingClientRect();
  if (!c.width || !c.height) return null;
  const fx = (cx - c.left) / c.width;
  const fy = (cy - c.top) / c.height;
  const list = reader.highlights.get(reader.page) || [];
  for (const hl of list) {
    for (const [x, y, w, h] of hl.rects) {
      if (fx >= x && fx <= x + w && fy >= y && fy <= y + h) {
        return {
          hl,
          rect: new DOMRect(c.left + x * c.width, c.top + y * c.height, w * c.width, h * c.height),
        };
      }
    }
  }
  return null;
}

function selectionInTextLayer() {
  const sel = window.getSelection();
  return sel &&
    !sel.isCollapsed &&
    sel.rangeCount > 0 &&
    textLayerDiv.contains(sel.anchorNode) &&
    textLayerDiv.contains(sel.focusNode)
    ? sel
    : null;
}

// Convert selection client rects to page-box fractions, dropping the
// duplicate/contained rects browsers emit for multi-span selections.
function normalizeSelectionRects(clientRects) {
  const c = canvas.getBoundingClientRect();
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
  if (!sel || !reader.book) return hideHlToolbar();
  const rects = normalizeSelectionRects([...sel.getRangeAt(0).getClientRects()]);
  const text = sel.toString().replace(/\s+/g, ' ').trim().slice(0, 1000);
  if (!rects.length || !text) return hideHlToolbar();

  const page = reader.page;
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
    if (page === reader.page) paintHighlights();
  } catch (err) {
    toast(err.message, { error: true });
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
  notesListSheet.hidden = true;
  noteBackdrop.hidden = false;
  noteSheet.hidden = false;
  noteBackdrop.classList.remove('leaving');
  noteSheet.classList.remove('leaving');
  noteText.focus();
}

function openNotesList() {
  const list = $('notes-list');
  list.innerHTML = '';
  const entries = [
    ...[...reader.notes.entries()].map(([page, content]) => ({ type: 'note', page, content })),
    ...[...reader.highlights.values()].flat().map((hl) => ({
      type: 'highlight',
      page: hl.page,
      content: hl.text,
      color: hl.color,
    })),
  ].sort((a, b) => a.page - b.page || (a.type === 'note' ? -1 : 1));
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
    } else {
      np.textContent = `Page ${entry.page}`;
    }
    const nc = document.createElement('div');
    nc.className = 'note-item-content';
    if (entry.type === 'highlight') nc.classList.add('quote');
    nc.textContent = entry.type === 'highlight' ? `“${entry.content}”` : entry.content;
    item.append(np, nc);
    item.addEventListener('click', () => {
      closeNoteSheets();
      goToPage(entry.page, { instantSave: true });
    });
    list.appendChild(item);
  }
  noteSheet.hidden = true;
  noteBackdrop.hidden = false;
  notesListSheet.hidden = false;
  noteBackdrop.classList.remove('leaving');
  notesListSheet.classList.remove('leaving');
}

function closeNoteSheets() {
  flushNoteSave();
  const open = [noteSheet, notesListSheet].filter((el) => !el.hidden);
  if (!open.length) return;
  for (const el of open) {
    el.classList.add('leaving');
    el.addEventListener('animationend', () => (el.hidden = true), { once: true });
  }
  noteBackdrop.classList.add('leaving');
  noteBackdrop.addEventListener('animationend', () => (noteBackdrop.hidden = true), {
    once: true,
  });
}

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

/* Reader controls */

$('back-btn').addEventListener('click', () => {
  location.hash = '';
});
$('prev-btn').addEventListener('click', () => goToPage(reader.page - 1));
$('next-btn').addEventListener('click', () => goToPage(reader.page + 1));

$('zoom-in-btn').addEventListener('click', () => {
  reader.zoom = Math.min(reader.zoom + 0.25, 3);
  renderPage(reader.page);
});
$('zoom-out-btn').addEventListener('click', () => {
  reader.zoom = Math.max(reader.zoom - 0.25, 1);
  renderPage(reader.page);
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
});
pageSlider.addEventListener('change', () => {
  sliderBubble.hidden = true;
  goToPage(parseInt(pageSlider.value, 10));
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
    if (!touchStart || reader.zoom > 1) return;
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
  if (readerView.hidden) return;
  if (e.target.tagName === 'TEXTAREA' || e.target.tagName === 'INPUT') {
    if (e.key === 'Escape') closeNoteSheets();
    return;
  }
  if (!noteSheet.hidden || !notesListSheet.hidden) {
    if (e.key === 'Escape') closeNoteSheets();
    return;
  }
  if (e.key === 'ArrowRight' || e.key === ' ') goToPage(reader.page + 1);
  else if (e.key === 'ArrowLeft') goToPage(reader.page - 1);
  else if (e.key === 'n') openNoteSheet();
  else if (e.key === 'Escape') location.hash = '';
});

// Flush progress and any pending note if the tab is backgrounded or closed.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') {
    saveProgress(true);
    flushNoteSave();
  }
});

let resizeTimer = null;
window.addEventListener('resize', () => {
  if (readerView.hidden || !reader.pdf) return;
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => renderPage(reader.page), 200);
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
