import * as pdfjsLib from '/pdfjs/pdf.min.mjs';

pdfjsLib.GlobalWorkerOptions.workerSrc = '/pdfjs/pdf.worker.min.mjs';

const $ = (id) => document.getElementById(id);

const libraryView = $('library-view');
const readerView = $('reader-view');
const bookGrid = $('book-grid');
const emptyState = $('empty-state');
const fileInput = $('file-input');
const uploadStatus = $('upload-status');

const pageContainer = $('page-container');
const canvas = $('page-canvas');
const ctx = canvas.getContext('2d');
const readerLoading = $('reader-loading');
const pageSlider = $('page-slider');

const reader = {
  book: null,
  pdf: null,
  page: 1,
  zoom: 1,
  rendering: false,
  pendingPage: null,
  loadToken: 0,
};

/* ---------------- API ---------------- */

async function api(path, options = {}) {
  const res = await fetch(path, options);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `Request failed (${res.status})`);
  return body;
}

/* ---------------- Library ---------------- */

async function loadLibrary() {
  const books = await api('/api/books');
  bookGrid.innerHTML = '';
  emptyState.hidden = books.length > 0;

  for (const book of books) {
    bookGrid.appendChild(renderCard(book));
  }
}

function renderCard(book) {
  const card = document.createElement('div');
  card.className = 'book-card';

  const pct = Math.round((book.currentPage / book.pageCount) * 100);
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
  const track = document.createElement('div');
  track.className = 'progress-track';
  track.innerHTML = `<div class="progress-fill" style="width:${pct}%"></div>`;
  cover.appendChild(track);

  const meta = document.createElement('div');
  meta.className = 'book-meta';
  const title = document.createElement('div');
  title.className = 'book-title';
  title.textContent = book.title;
  const sub = document.createElement('div');
  sub.className = 'book-sub';
  const progressLabel = book.lastReadAt
    ? `p. ${book.currentPage} / ${book.pageCount}`
    : `${book.pageCount} pages`;
  sub.innerHTML = `<span>${progressLabel}</span>`;
  const del = document.createElement('button');
  del.className = 'delete-btn';
  del.textContent = '🗑';
  del.setAttribute('aria-label', `Delete ${book.title}`);
  del.addEventListener('click', async (e) => {
    e.stopPropagation();
    if (!confirm(`Delete "${book.title}"?`)) return;
    await api(`/api/books/${book.id}`, { method: 'DELETE' });
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
    uploadStatus.textContent = `Uploading ${file.name} (${done + 1}/${files.length})…`;
    try {
      const form = new FormData();
      form.append('file', file);
      const book = await api('/api/books', { method: 'POST', body: form });
      await generateCover(file, book.id).catch(() => {});
      done++;
    } catch (err) {
      alert(`${file.name}: ${err.message}`);
    }
  }
  uploadStatus.hidden = true;
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
    readerLoading.textContent = err.message;
  }
}

function closeReader() {
  reader.loadToken++;
  saveProgress(true);
  if (reader.pdf) reader.pdf.destroy();
  reader.pdf = null;
  reader.book = null;
  reader.rendering = false;
  reader.pendingPage = null;
  canvas.width = 0;
  canvas.height = 0;
  $('reader-pageinfo').textContent = '';
  readerView.hidden = true;
  libraryView.hidden = false;
  readerLoading.textContent = 'Loading…';
  loadLibrary();
}

async function renderPage(num) {
  if (!reader.pdf) return;
  if (reader.rendering) {
    reader.pendingPage = num;
    return;
  }
  reader.rendering = true;
  reader.page = num;

  const page = await reader.pdf.getPage(num);
  const base = page.getViewport({ scale: 1 });
  const fitScale = pageContainer.clientWidth / base.width;
  const scale = fitScale * reader.zoom;
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const viewport = page.getViewport({ scale });

  canvas.width = Math.round(viewport.width * dpr);
  canvas.height = Math.round(viewport.height * dpr);
  canvas.style.width = `${Math.round(viewport.width)}px`;
  canvas.style.height = `${Math.round(viewport.height)}px`;

  await page.render({
    canvasContext: ctx,
    viewport,
    transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : null,
  }).promise;

  reader.rendering = false;
  updatePageUI();

  if (reader.pendingPage !== null) {
    const next = reader.pendingPage;
    reader.pendingPage = null;
    renderPage(next);
  }
}

function updatePageUI() {
  $('reader-pageinfo').textContent = `${reader.page} / ${reader.book.pageCount}`;
  pageSlider.value = reader.page;
}

function goToPage(num, { instantSave = false } = {}) {
  if (!reader.book) return;
  const clamped = Math.min(Math.max(num, 1), reader.book.pageCount);
  if (clamped === reader.page && !reader.rendering) return;
  pageContainer.scrollTop = 0;
  renderPage(clamped);
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

pageSlider.addEventListener('input', () => {
  $('reader-pageinfo').textContent = `${pageSlider.value} / ${reader.book?.pageCount ?? '?'}`;
});
pageSlider.addEventListener('change', () => goToPage(parseInt(pageSlider.value, 10)));

// Tap zones: left/right third turns pages, center toggles the bars.
pageContainer.addEventListener('click', (e) => {
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
  if (e.key === 'ArrowRight' || e.key === ' ') goToPage(reader.page + 1);
  else if (e.key === 'ArrowLeft') goToPage(reader.page - 1);
  else if (e.key === 'Escape') location.hash = '';
});

// Flush progress if the tab is backgrounded or closed mid-read.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') saveProgress(true);
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
