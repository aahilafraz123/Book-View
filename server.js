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
  CREATE TABLE IF NOT EXISTS bookmarks (
    book_id    TEXT NOT NULL,
    page       INTEGER NOT NULL,
    label      TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    PRIMARY KEY (book_id, page)
  );
  CREATE TABLE IF NOT EXISTS reading_sessions (
    id           TEXT PRIMARY KEY,
    book_id      TEXT NOT NULL,
    started_at   TEXT NOT NULL,
    ended_at     TEXT NOT NULL,
    pages_turned INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX IF NOT EXISTS idx_sessions_book ON reading_sessions (book_id, ended_at);
  CREATE TABLE IF NOT EXISTS book_pages (
    book_id TEXT NOT NULL,
    page    INTEGER NOT NULL,
    text    TEXT NOT NULL,
    PRIMARY KEY (book_id, page)
  );
  CREATE VIRTUAL TABLE IF NOT EXISTS book_pages_fts
    USING fts5(book_id UNINDEXED, page UNINDEXED, text);
`);

// Additive migrations for databases created before these columns existed.
function ensureColumn(table, col, ddl) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all();
  if (!cols.some((c) => c.name === col)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${ddl}`);
}
ensureColumn('books', 'view_mode', "TEXT NOT NULL DEFAULT 'paged'");
ensureColumn('books', 'text_extracted', 'INTEGER NOT NULL DEFAULT 0');
ensureColumn('books', 'finished_at', 'TEXT');
ensureColumn('highlights', 'note', "TEXT NOT NULL DEFAULT ''");

const HIGHLIGHT_COLORS = new Set(['amber', 'green', 'blue', 'pink']);
const VIEW_MODES = new Set(['paged', 'scroll', 'reflow']);

/* ---------------- Text extraction (powers search) ---------------- */

// One book at a time to bound memory; pdf.js legacy build works in Node.
const extractQueue = [];
let extracting = false;

function queueExtraction(bookId) {
  if (!extractQueue.includes(bookId)) extractQueue.push(bookId);
  if (!extracting) drainExtractQueue();
}

async function drainExtractQueue() {
  extracting = true;
  while (extractQueue.length) {
    const bookId = extractQueue.shift();
    try {
      await extractBookText(bookId);
    } catch (err) {
      console.error(`text extraction failed for ${bookId}:`, err.message);
    }
  }
  extracting = false;
}

async function extractBookText(bookId) {
  const row = db.prepare('SELECT * FROM books WHERE id = ?').get(bookId);
  if (!row || row.text_extracted) return;
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const data = new Uint8Array(fs.readFileSync(path.join(UPLOADS_DIR, row.filename)));
  const doc = await pdfjs.getDocument({ data, useSystemFonts: true, isEvalSupported: false }).promise;
  const insertPage = db.prepare(
    'INSERT OR REPLACE INTO book_pages (book_id, page, text) VALUES (?, ?, ?)'
  );
  const insertFts = db.prepare('INSERT INTO book_pages_fts (book_id, page, text) VALUES (?, ?, ?)');
  db.prepare('DELETE FROM book_pages_fts WHERE book_id = ?').run(bookId);
  try {
    for (let p = 1; p <= doc.numPages; p++) {
      const page = await doc.getPage(p);
      const tc = await page.getTextContent();
      let text = '';
      for (const item of tc.items) {
        if (item.str) text += item.str;
        if (item.hasEOL) text += '\n';
        else if (item.str && !item.str.endsWith(' ')) text += ' ';
      }
      text = text.replace(/\s+/g, ' ').trim();
      insertPage.run(bookId, p, text);
      insertFts.run(bookId, p, text);
      page.cleanup();
    }
    db.prepare('UPDATE books SET text_extracted = 1 WHERE id = ?').run(bookId);
  } finally {
    doc.destroy();
  }
}

// FTS5 treats quotes/parens/NEAR as syntax — quote each token instead.
function ftsQuery(q) {
  const tokens = String(q).replace(/"/g, ' ').split(/\s+/).filter(Boolean).slice(0, 12);
  if (!tokens.length) return null;
  return tokens.map((t) => `"${t}"`).join(' ');
}

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
    viewMode: row.view_mode || 'paged',
    finishedAt: row.finished_at || null,
  };
}

function highlightRow(row) {
  return {
    id: row.id,
    page: row.page,
    color: row.color,
    text: row.text,
    note: row.note || '',
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

  queueExtraction(id); // index text for search in the background
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

const SESSION_GAP_MS = 5 * 60 * 1000;

app.put('/api/books/:id/progress', (req, res) => {
  const row = getBookOr404(req, res);
  if (!row) return;
  const page = Math.min(Math.max(parseInt(req.body.page, 10) || 1, 1), row.page_count);
  const now = new Date().toISOString();
  db.prepare('UPDATE books SET current_page = ?, last_read_at = ? WHERE id = ?').run(
    page,
    now,
    row.id
  );
  if (page >= row.page_count && !row.finished_at) {
    db.prepare('UPDATE books SET finished_at = ? WHERE id = ?').run(now, row.id);
  }

  // Stitch progress pings into reading sessions (spec 09).
  const cutoff = new Date(Date.now() - SESSION_GAP_MS).toISOString();
  const open = db
    .prepare(
      'SELECT id FROM reading_sessions WHERE book_id = ? AND ended_at >= ? ORDER BY ended_at DESC LIMIT 1'
    )
    .get(row.id, cutoff);
  if (open) {
    db.prepare(
      'UPDATE reading_sessions SET ended_at = ?, pages_turned = pages_turned + 1 WHERE id = ?'
    ).run(now, open.id);
  } else {
    db.prepare(
      'INSERT INTO reading_sessions (id, book_id, started_at, ended_at, pages_turned) VALUES (?, ?, ?, ?, 1)'
    ).run(crypto.randomUUID(), row.id, now, now);
  }

  res.json({ currentPage: page });
});

app.put('/api/books/:id/view-mode', (req, res) => {
  const row = getBookOr404(req, res);
  if (!row) return;
  if (!VIEW_MODES.has(req.body.mode)) return res.status(400).json({ error: 'Unknown view mode' });
  db.prepare('UPDATE books SET view_mode = ? WHERE id = ?').run(req.body.mode, row.id);
  res.json({ viewMode: req.body.mode });
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
  const sets = [];
  const args = [];
  if (req.body.color !== undefined) {
    if (!HIGHLIGHT_COLORS.has(req.body.color)) {
      return res.status(400).json({ error: 'Unknown color' });
    }
    sets.push('color = ?');
    args.push(req.body.color);
  }
  if (req.body.note !== undefined) {
    sets.push('note = ?');
    args.push(String(req.body.note).slice(0, 5000));
  }
  if (!sets.length) return res.status(400).json({ error: 'Nothing to update' });
  db.prepare(`UPDATE highlights SET ${sets.join(', ')} WHERE id = ?`).run(...args, hl.id);
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

/* ---------------- Search (spec 04) ---------------- */

async function ensureExtracted(row) {
  if (row.text_extracted) return;
  await extractBookText(row.id);
}

app.get('/api/books/:id/search', async (req, res) => {
  const row = getBookOr404(req, res);
  if (!row) return;
  const match = ftsQuery(req.query.q);
  if (!match) return res.status(400).json({ error: 'Empty query' });
  try {
    await ensureExtracted(row);
  } catch (err) {
    return res.status(500).json({ error: `Could not index book: ${err.message}` });
  }
  try {
    const rows = db
      .prepare(
        `SELECT page, snippet(book_pages_fts, 2, '<b>', '</b>', '…', 10) AS snippet
         FROM book_pages_fts WHERE book_id = ? AND book_pages_fts MATCH ?
         ORDER BY page LIMIT 50`
      )
      .all(row.id, match);
    res.json(rows);
  } catch {
    res.json([]);
  }
});

app.get('/api/search', (req, res) => {
  const match = ftsQuery(req.query.q);
  if (!match) return res.status(400).json({ error: 'Empty query' });
  try {
    const rows = db
      .prepare(
        `SELECT f.book_id AS bookId, b.title, f.page,
                snippet(book_pages_fts, 2, '<b>', '</b>', '…', 10) AS snippet
         FROM book_pages_fts f JOIN books b ON b.id = f.book_id
         WHERE book_pages_fts MATCH ? ORDER BY b.title, f.page LIMIT 50`
      )
      .all(match);
    res.json(rows);
  } catch {
    res.json([]);
  }
});

/* ---------------- Bookmarks (spec 10) ---------------- */

app.get('/api/books/:id/bookmarks', (req, res) => {
  const row = getBookOr404(req, res);
  if (!row) return;
  const rows = db
    .prepare('SELECT page, label, created_at FROM bookmarks WHERE book_id = ? ORDER BY page')
    .all(row.id);
  res.json(rows.map((b) => ({ page: b.page, label: b.label, createdAt: b.created_at })));
});

app.put('/api/books/:id/bookmarks/:page', (req, res) => {
  const row = getBookOr404(req, res);
  if (!row) return;
  const page = parseInt(req.params.page, 10);
  if (!Number.isInteger(page) || page < 1 || page > row.page_count) {
    return res.status(400).json({ error: 'Page out of range' });
  }
  const label = String(req.body?.label ?? '').slice(0, 200);
  db.prepare(
    `INSERT INTO bookmarks (book_id, page, label, created_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(book_id, page) DO UPDATE SET label = excluded.label`
  ).run(row.id, page, label, new Date().toISOString());
  res.json({ page, label });
});

app.delete('/api/books/:id/bookmarks/:page', (req, res) => {
  const row = getBookOr404(req, res);
  if (!row) return;
  const info = db
    .prepare('DELETE FROM bookmarks WHERE book_id = ? AND page = ?')
    .run(row.id, parseInt(req.params.page, 10));
  if (!info.changes) return res.status(404).json({ error: 'No bookmark on that page' });
  res.json({ ok: true });
});

/* ---------------- Annotation export (spec 08) ---------------- */

const mdEscape = (s) => String(s).replace(/</g, '\\<').replace(/>/g, '\\>');

app.get('/api/books/:id/export.md', (req, res) => {
  const row = getBookOr404(req, res);
  if (!row) return;
  const notes = db.prepare('SELECT page, content FROM notes WHERE book_id = ?').all(row.id);
  const highlights = db
    .prepare('SELECT page, color, text, note FROM highlights WHERE book_id = ? ORDER BY created_at')
    .all(row.id);
  const bookmarks = db.prepare('SELECT page, label FROM bookmarks WHERE book_id = ?').all(row.id);

  const byPage = new Map();
  const on = (page) => {
    if (!byPage.has(page)) byPage.set(page, []);
    return byPage.get(page);
  };
  for (const b of bookmarks) on(b.page).push(`- 🔖 Bookmark${b.label ? `: ${mdEscape(b.label)}` : ''}`);
  for (const h of highlights) {
    on(h.page).push(`- > "${mdEscape(h.text)}" *(${h.color})*`);
    if (h.note) on(h.page).push(`  - ${mdEscape(h.note)}`);
  }
  for (const n of notes) on(n.page).push(`- ✎ ${mdEscape(n.content).replace(/\n/g, '\n  ')}`);

  const date = new Date().toISOString().slice(0, 10);
  let md = `# ${mdEscape(row.title)} — notes & highlights\n\n`;
  md += `_Exported ${date} · ${notes.length} note${notes.length === 1 ? '' : 's'} · `;
  md += `${highlights.length} highlight${highlights.length === 1 ? '' : 's'} · `;
  md += `${bookmarks.length} bookmark${bookmarks.length === 1 ? '' : 's'}_\n`;
  const pages = [...byPage.keys()].sort((a, b) => a - b);
  if (!pages.length) md += '\nNothing marked in this book yet.\n';
  for (const p of pages) md += `\n## Page ${p}\n\n${byPage.get(p).join('\n')}\n`;

  const slug = row.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'book';
  res.setHeader('Content-Type', 'text/markdown; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${slug}-notes.md"`);
  res.send(md);
});

/* ---------------- Reading stats (spec 09) ---------------- */

app.get('/api/stats', (req, res) => {
  const sessions = db
    .prepare("SELECT book_id, started_at, ended_at, pages_turned FROM reading_sessions WHERE ended_at >= datetime('now', '-40 days')")
    .all();

  const dayKey = (iso) => iso.slice(0, 10);
  const byDay = new Map();
  for (const s of sessions) {
    const key = dayKey(s.ended_at);
    const cur = byDay.get(key) || { minutes: 0, pages: 0 };
    cur.minutes += Math.max((new Date(s.ended_at) - new Date(s.started_at)) / 60000, 0.5);
    cur.pages += s.pages_turned;
    byDay.set(key, cur);
  }

  const days = [];
  for (let i = 13; i >= 0; i--) {
    const d = new Date(Date.now() - i * 86400000).toISOString().slice(0, 10);
    const v = byDay.get(d) || { minutes: 0, pages: 0 };
    days.push({ date: d, minutes: Math.round(v.minutes), pages: v.pages });
  }

  // Streak anchored on today-or-yesterday so an unread today doesn't zero it.
  let streak = 0;
  const today = new Date().toISOString().slice(0, 10);
  const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
  let cursor = byDay.has(today) ? today : byDay.has(yesterday) ? yesterday : null;
  while (cursor && byDay.has(cursor)) {
    streak++;
    cursor = new Date(new Date(cursor + 'T12:00:00Z') - 86400000).toISOString().slice(0, 10);
  }

  const totals = db
    .prepare(
      `SELECT
        (SELECT COALESCE(SUM((julianday(ended_at) - julianday(started_at)) * 1440), 0) FROM reading_sessions) AS minutes,
        (SELECT COALESCE(SUM(pages_turned), 0) FROM reading_sessions) AS pages,
        (SELECT COUNT(*) FROM books WHERE last_read_at IS NOT NULL) AS booksStarted,
        (SELECT COUNT(*) FROM books WHERE finished_at IS NOT NULL) AS booksFinished`
    )
    .get();

  res.json({
    streak,
    days,
    totals: {
      minutes: Math.round(totals.minutes),
      pages: totals.pages,
      booksStarted: totals.booksStarted,
      booksFinished: totals.booksFinished,
    },
  });
});

app.delete('/api/books/:id', (req, res) => {
  const row = getBookOr404(req, res);
  if (!row) return;
  db.prepare('DELETE FROM books WHERE id = ?').run(row.id);
  db.prepare('DELETE FROM notes WHERE book_id = ?').run(row.id);
  db.prepare('DELETE FROM highlights WHERE book_id = ?').run(row.id);
  db.prepare('DELETE FROM bookmarks WHERE book_id = ?').run(row.id);
  db.prepare('DELETE FROM reading_sessions WHERE book_id = ?').run(row.id);
  db.prepare('DELETE FROM book_pages WHERE book_id = ?').run(row.id);
  db.prepare('DELETE FROM book_pages_fts WHERE book_id = ?').run(row.id);
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
