# 📚 Book View

A personal PDF book reader you can host anywhere and use from your phone.
Upload PDF books, read them in a clean mobile-friendly book view, and it
remembers exactly which page you were on — per book.

## Features

- **Upload PDFs** from any device (multiple at once, 100 MB/file default limit)
- **Library view** with cover thumbnails and reading-progress bars
- **Reader** built on Mozilla's pdf.js:
  - swipe left/right or tap the screen edges to turn pages
  - tap the center to hide/show the controls
  - page slider to scrub through the book, zoom in/out with panning
  - keyboard arrows / space on desktop
- **Progress auto-saves** as you read and each book reopens where you left off
- **Per-page notes**: tap ✎ (or press `n`) to jot a note on the page you're
  reading — it auto-saves as you type, pages with notes get an amber badge,
  and an "all notes" list lets you jump straight to any annotated page
- **Text highlighting**: select any text in a book (long-press on mobile) and
  a floating toolbar offers four highlighter colors plus copy. Tap an existing
  highlight to recolor, remove, or **attach a note to the passage** (marginalia
  with auto-save; annotated highlights get a notch). Highlights live in the
  combined notes-&-highlights list alongside your notes, quoted and
  color-chipped, and tapping one jumps to its page
- **Three view modes** per book (Aa sheet): classic **Paged**, virtualized
  **Continuous scroll**, and **Reflow** — the page's text re-typeset as
  flowing, resizable serif text (EPUB-feel for text PDFs)
- **Night reading**: Light / Sepia / Dark page themes
- **In-book & library-wide search** backed by a server-side FTS5 index of
  extracted text, with snippet results and match flashes on jump
- **Chapter navigation** from the PDF's embedded outline, when present
- **Thumbnail filmstrip** while scrubbing the page slider
- **Bookmarks** (🔖) alongside notes and highlights
- **Markdown export** of all notes, highlights, and bookmarks per book
- **Reading stats**: daily streak, minutes-per-day chart, totals — stitched
  server-side from progress pings (see `docs/specs/` for design docs)
- Installable as a home-screen app on iOS/Android (PWA manifest included)

## Running locally

```bash
npm install
npm start
# open http://localhost:3000
```

To read from your phone on the same Wi-Fi, open `http://<your-computer-ip>:3000`.

## Deploying

The app is a single Node process. Books and the SQLite database live under
`DATA_DIR` (defaults to `./data`), so the only hosting requirement is a
**persistent disk/volume** mounted there.

### Docker (works on Fly.io, Railway, Render, a VPS, etc.)

```bash
docker build -t book-view .
docker run -p 3000:3000 -v bookview-data:/data book-view
```

- **Railway**: create a project from this repo, add a Volume mounted at `/data`,
  set `DATA_DIR=/data`. Done.
- **Fly.io**: `fly launch`, then `fly volumes create bookview_data` and mount it
  at `/data` in `fly.toml` with `DATA_DIR=/data`.
- **Render**: create a Web Service from the Dockerfile and attach a Persistent
  Disk at `/data` (disks require a paid instance; the free tier is ephemeral).

### Configuration

| Env var         | Default  | Meaning                                        |
| --------------- | -------- | ---------------------------------------------- |
| `PORT`          | `3000`   | HTTP port                                      |
| `DATA_DIR`      | `./data` | Where PDFs + the SQLite DB live                |
| `MAX_UPLOAD_MB` | `100`    | Per-file upload size limit                     |
| `AUTH_PASSWORD` | _(unset)_ | Set to require login before any API access    |

### Locking it down for public deployment

Set `AUTH_PASSWORD` to any strong passphrase and the whole app goes behind a
login gate:

- Every `/api` route returns 401 without a valid session — books, files,
  covers, notes, everything.
- Login sets a 90-day `HttpOnly` `SameSite=Lax` session cookie (`Secure` when
  served over HTTPS); session tokens are stored hashed in SQLite, so they
  survive restarts and can be revoked ("Sign out" lives in the stats sheet).
- Password comparison is constant-time and login is rate-limited to 10
  attempts per IP per 15 minutes.

Leave `AUTH_PASSWORD` unset for open local use. Multi-user accounts,
per-user libraries, and storage limits remain the planned next step.

## Architecture

```
server.js        Express API + static hosting
  /api/books     CRUD, upload (multer), progress tracking
  SQLite (better-sqlite3) for metadata; PDFs stored on disk
public/
  index.html     library + reader shells
  app.js         pdf.js rendering, swipe/zoom, hash routing
  styles.css     mobile-first dark UI
```

Cover thumbnails are rendered client-side (pdf.js) right after upload and
stored server-side as PNGs, so the library view never downloads full PDFs.
