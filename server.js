const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const Database = require('better-sqlite3');
const { PDFDocument } = require('pdf-lib');

const PORT = process.env.PORT || 3000;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const UPLOADS_DIR = path.join(DATA_DIR, 'uploads');
const COVERS_DIR = path.join(DATA_DIR, 'covers');
const MAX_UPLOAD_MB = parseInt(process.env.MAX_UPLOAD_MB || '100', 10);

fs.mkdirSync(UPLOADS_DIR, { recursive: true });
fs.mkdirSync(COVERS_DIR, { recursive: true });

const db = new Database(path.join(DATA_DIR, 'bookview.db'));
db.pragma('journal_mode = WAL');
db.exec(`
  CREATE TABLE IF NOT EXISTS books (
    id           TEXT PRIMARY KEY,
    title        TEXT NOT NULL,
    filename     TEXT NOT NULL,
    size_bytes   INTEGER NOT NULL,
    page_count   INTEGER NOT NULL,
    current_page INTEGER NOT NULL DEFAULT 1,
    has_cover    INTEGER NOT NULL DEFAULT 0,
    added_at     TEXT NOT NULL,
    last_read_at TEXT
  );
  CREATE TABLE IF NOT EXISTS notes (
    book_id    TEXT NOT NULL,
    page       INTEGER NOT NULL,
    content    TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (book_id, page)
  );
  CREATE TABLE IF NOT EXISTS highlights (
    id         TEXT PRIMARY KEY,
    book_id    TEXT NOT NULL,
    page       INTEGER NOT NULL,
    color      TEXT NOT NULL,
    text       TEXT NOT NULL,
    rects      TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_highlights_book ON highlights (book_id, page);
`);

const HIGHLIGHT_COLORS = new Set(['amber', 'green', 'blue', 'pink']);

const app = express();
app.use(express.json());

const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, UPLOADS_DIR),
    filename: (req, file, cb) => cb(null, `${crypto.randomUUID()}.pdf`),
  }),
  limits: { fileSize: MAX_UPLOAD_MB * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const isPdf =
      file.mimetype === 'application/pdf' ||
      file.originalname.toLowerCase().endsWith('.pdf');
    cb(isPdf ? null : new Error('Only PDF files are accepted'), isPdf);
  },
});

function bookRow(row) {
  return {
    id: row.id,
    title: row.title,
    sizeBytes: row.size_bytes,
    pageCount: row.page_count,
    currentPage: row.current_page,
    hasCover: !!row.has_cover,
    addedAt: row.added_at,
    lastReadAt: row.last_read_at,
    noteCount: row.note_count ?? 0,
    highlightCount: row.highlight_count ?? 0,
  };
}

function highlightRow(row) {
  return {
    id: row.id,
    page: row.page,
    color: row.color,
    text: row.text,
    rects: JSON.parse(row.rects),
    createdAt: row.created_at,
  };
}

// rects come in as fractions of the page box: [[x, y, w, h], ...] each 0..1
function sanitizeRects(rects) {
  if (!Array.isArray(rects)) return null;
  const clamp = (v) => Math.min(Math.max(Number(v) || 0, 0), 1);
  const out = [];
  for (const r of rects.slice(0, 40)) {
    if (!Array.isArray(r) || r.length !== 4) return null;
    const [x, y, w, h] = r.map(clamp);
    if (w <= 0 || h <= 0) continue;
    out.push([x, y, Math.min(w, 1 - x), Math.min(h, 1 - y)]);
  }
  return out.length ? out : null;
}

app.get('/api/books', (req, res) => {
  const rows = db
    .prepare(
      `SELECT b.*,
         (SELECT COUNT(*) FROM notes n WHERE n.book_id = b.id) AS note_count,
         (SELECT COUNT(*) FROM highlights h WHERE h.book_id = b.id) AS highlight_count
       FROM books b
       ORDER BY last_read_at IS NULL, last_read_at DESC, added_at DESC`
    )
    .all();
  res.json(rows.map(bookRow));
});

app.post('/api/books', upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

  const filePath = req.file.path;
  let pageCount;
  try {
    const bytes = fs.readFileSync(filePath);
    const doc = await PDFDocument.load(bytes, { ignoreEncryption: true });
    pageCount = doc.getPageCount();
    if (!pageCount) throw new Error('PDF has no pages');
  } catch (err) {
    fs.unlink(filePath, () => {});
    return res.status(400).json({ error: `Could not read PDF: ${err.message}` });
  }

  // multer decodes originalname as latin1; recover UTF-8 titles.
  const originalName = Buffer.from(req.file.originalname, 'latin1').toString('utf8');
  const title = (req.body.title || originalName.replace(/\.pdf$/i, ''))
    .replace(/[_]+/g, ' ')
    .trim()
    .slice(0, 200) || 'Untitled';

  const id = crypto.randomUUID();
  db.prepare(
    `INSERT INTO books (id, title, filename, size_bytes, page_count, added_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(id, title, path.basename(filePath), req.file.size, pageCount, new Date().toISOString());

  res.status(201).json(bookRow(db.prepare('SELECT * FROM books WHERE id = ?').get(id)));
});

function getBookOr404(req, res) {
  const row = db.prepare('SELECT * FROM books WHERE id = ?').get(req.params.id);
  if (!row) res.status(404).json({ error: 'Book not found' });
  return row;
}

app.get('/api/books/:id/file', (req, res) => {
  const row = getBookOr404(req, res);
  if (!row) return;
  res.sendFile(path.join(UPLOADS_DIR, row.filename), {
    headers: { 'Content-Type': 'application/pdf' },
  });
});

app.put('/api/books/:id/progress', (req, res) => {
  const row = getBookOr404(req, res);
  if (!row) return;
  const page = Math.min(Math.max(parseInt(req.body.page, 10) || 1, 1), row.page_count);
  db.prepare('UPDATE books SET current_page = ?, last_read_at = ? WHERE id = ?').run(
    page,
    new Date().toISOString(),
    row.id
  );
  res.json({ currentPage: page });
});

app.patch('/api/books/:id', (req, res) => {
  const row = getBookOr404(req, res);
  if (!row) return;
  const title = String(req.body.title || '').trim().slice(0, 200);
  if (!title) return res.status(400).json({ error: 'Title is required' });
  db.prepare('UPDATE books SET title = ? WHERE id = ?').run(title, row.id);
  res.json(bookRow(db.prepare('SELECT * FROM books WHERE id = ?').get(row.id)));
});

app.get('/api/books/:id/notes', (req, res) => {
  const row = getBookOr404(req, res);
  if (!row) return;
  const notes = db
    .prepare('SELECT page, content, updated_at FROM notes WHERE book_id = ? ORDER BY page')
    .all(row.id);
  res.json(notes.map((n) => ({ page: n.page, content: n.content, updatedAt: n.updated_at })));
});

// Upsert the note for a page; empty content deletes it.
app.put('/api/books/:id/notes/:page', (req, res) => {
  const row = getBookOr404(req, res);
  if (!row) return;
  const page = parseInt(req.params.page, 10);
  if (!Number.isInteger(page) || page < 1 || page > row.page_count) {
    return res.status(400).json({ error: 'Page out of range' });
  }
  const content = String(req.body.content ?? '').slice(0, 20000);
  if (!content.trim()) {
    db.prepare('DELETE FROM notes WHERE book_id = ? AND page = ?').run(row.id, page);
    return res.json({ page, deleted: true });
  }
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO notes (book_id, page, content, updated_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(book_id, page) DO UPDATE SET content = excluded.content, updated_at = excluded.updated_at`
  ).run(row.id, page, content, now);
  res.json({ page, content, updatedAt: now });
});

app.get('/api/books/:id/highlights', (req, res) => {
  const row = getBookOr404(req, res);
  if (!row) return;
  const rows = db
    .prepare('SELECT * FROM highlights WHERE book_id = ? ORDER BY page, created_at')
    .all(row.id);
  res.json(rows.map(highlightRow));
});

app.post('/api/books/:id/highlights', (req, res) => {
  const row = getBookOr404(req, res);
  if (!row) return;
  const page = parseInt(req.body.page, 10);
  if (!Number.isInteger(page) || page < 1 || page > row.page_count) {
    return res.status(400).json({ error: 'Page out of range' });
  }
  const color = HIGHLIGHT_COLORS.has(req.body.color) ? req.body.color : 'amber';
  const rects = sanitizeRects(req.body.rects);
  if (!rects) return res.status(400).json({ error: 'Invalid highlight rects' });
  const text = String(req.body.text ?? '').slice(0, 1000);

  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO highlights (id, book_id, page, color, text, rects, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(id, row.id, page, color, text, JSON.stringify(rects), now);
  res.status(201).json(highlightRow(db.prepare('SELECT * FROM highlights WHERE id = ?').get(id)));
});

app.patch('/api/books/:id/highlights/:hid', (req, res) => {
  const row = getBookOr404(req, res);
  if (!row) return;
  const hl = db
    .prepare('SELECT * FROM highlights WHERE id = ? AND book_id = ?')
    .get(req.params.hid, row.id);
  if (!hl) return res.status(404).json({ error: 'Highlight not found' });
  if (!HIGHLIGHT_COLORS.has(req.body.color)) {
    return res.status(400).json({ error: 'Unknown color' });
  }
  db.prepare('UPDATE highlights SET color = ? WHERE id = ?').run(req.body.color, hl.id);
  res.json(highlightRow(db.prepare('SELECT * FROM highlights WHERE id = ?').get(hl.id)));
});

app.delete('/api/books/:id/highlights/:hid', (req, res) => {
  const row = getBookOr404(req, res);
  if (!row) return;
  const info = db
    .prepare('DELETE FROM highlights WHERE id = ? AND book_id = ?')
    .run(req.params.hid, row.id);
  if (!info.changes) return res.status(404).json({ error: 'Highlight not found' });
  res.json({ ok: true });
});

app.delete('/api/books/:id', (req, res) => {
  const row = getBookOr404(req, res);
  if (!row) return;
  db.prepare('DELETE FROM books WHERE id = ?').run(row.id);
  db.prepare('DELETE FROM notes WHERE book_id = ?').run(row.id);
  db.prepare('DELETE FROM highlights WHERE book_id = ?').run(row.id);
  fs.unlink(path.join(UPLOADS_DIR, row.filename), () => {});
  fs.unlink(path.join(COVERS_DIR, `${row.id}.png`), () => {});
  res.json({ ok: true });
});

// Cover thumbnails are rendered client-side (pdf.js) right after upload and
// stored here so the library view never has to download whole PDFs.
app.put(
  '/api/books/:id/cover',
  express.raw({ type: 'image/png', limit: '4mb' }),
  (req, res) => {
    const row = getBookOr404(req, res);
    if (!row) return;
    if (!req.body || !req.body.length) {
      return res.status(400).json({ error: 'Empty cover image' });
    }
    fs.writeFileSync(path.join(COVERS_DIR, `${row.id}.png`), req.body);
    db.prepare('UPDATE books SET has_cover = 1 WHERE id = ?').run(row.id);
    res.json({ ok: true });
  }
);

app.get('/api/books/:id/cover', (req, res) => {
  const row = getBookOr404(req, res);
  if (!row) return;
  const coverPath = path.join(COVERS_DIR, `${row.id}.png`);
  if (!fs.existsSync(coverPath)) return res.status(404).json({ error: 'No cover' });
  res.sendFile(coverPath, { headers: { 'Content-Type': 'image/png' } });
});

app.use('/pdfjs', express.static(path.join(__dirname, 'node_modules/pdfjs-dist/build')));
app.use(express.static(path.join(__dirname, 'public')));

// Multer / body-parser errors -> JSON instead of an HTML stack trace.
app.use((err, req, res, next) => {
  if (err.code === 'LIMIT_FILE_SIZE') {
    return res.status(413).json({ error: `File exceeds the ${MAX_UPLOAD_MB} MB upload limit` });
  }
  res.status(400).json({ error: err.message || 'Bad request' });
});

app.listen(PORT, () => {
  console.log(`Book View running on http://localhost:${PORT} (data dir: ${DATA_DIR})`);
});
