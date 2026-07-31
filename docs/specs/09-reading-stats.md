# 09 · Reading Stats & Streaks

## Why
Streaks are the single most retention-driving mechanic in habit apps, and
the data (progress pings) is already flowing — we're just not keeping it.

## UX
- 📊 button in the library header opens a stats sheet:
  - **Streak**: "🔥 N-day streak" (consecutive calendar days with reading).
  - **Last 14 days**: bar chart of minutes read per day (CSS bars in the
    app's amber-on-dark language, today highlighted).
  - **Totals**: minutes read, pages turned, books started/finished
    (finished = progress reached the last page at least once).

## Technical design
- `reading_sessions(id, book_id, started_at, ended_at, pages_turned)`.
- **Session stitching (server, zero client changes):** every
  `PUT /progress` looks for a session on that book whose `ended_at` is
  within the last 5 minutes → extends it (`ended_at = now`,
  `pages_turned += 1`); otherwise inserts a new session. Reading time =
  Σ(ended_at − started_at), which undercounts a lone page-turn but is
  honest and simple.
- `books.finished_at TEXT` set the first time progress hits `page_count`.
- `GET /api/stats` → `{ streak, days: [{date, minutes, pages}] × 14,
  totals: { minutes, pages, booksStarted, booksFinished } }`. Streak is
  computed over distinct session dates (server local time), counting today
  or yesterday as the anchor so an unread *today* doesn't zero it before
  bedtime.

## Test plan
- Simulated progress pings create/extend sessions correctly across the
  5-minute boundary.
- Stats endpoint returns coherent aggregates; streak handles gap days.
- Sheet renders bars proportional to minutes.
