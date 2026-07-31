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
  )
`);

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
  };
}

app.get('/api/books', (req, res) => {
  const rows = db
    .prepare(
      `SELECT * FROM books
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

app.delete('/api/books/:id', (req, res) => {
  const row = getBookOr404(req, res);
  if (!row) return;
  db.prepare('DELETE FROM books WHERE id = ?').run(row.id);
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
