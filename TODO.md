# Media Library — TODO & Notes

Personal notes file. Add anything you want to track here.

---

## First-Time Setup

1. Install [Node.js](https://nodejs.org/) — download the LTS version
2. Install Windows Build Tools (needed for the SQLite native module):
   - Open PowerShell as Administrator and run:
     ```
     npm install --global windows-build-tools
     ```
   - Or install "Desktop development with C++" from the Visual Studio installer
3. Open a terminal in this folder (`media-library/`) and run:
   ```
   npm install
   ```
4. Rebuild SQLite for Electron:
   ```
   npm run rebuild-sqlite
   ```
5. Launch the app:
   ```
   npm run dev
   ```

> **Note:** Steps 2 and 4 are one-time only. After that, just `npm run dev` to launch.

---

## Current Features
- [x] Add media entries (title, type, status, rating, genres, notes)
- [x] Browse all entries in a grid with cover images
- [x] Filter by media type (All / Movie / Show / Anime / Book / Manga)
- [x] Filter by watch status in "My List"
- [x] Filter by genre (header panel, multi-select with ALL/ANY matching, type-to-filter box)
- [x] Search by title (also matches the English title)
- [x] Edit and delete entries
- [x] Star rating (1–5), also clickable on the cards
- [x] Sort: A–Z, Z–A, rating high→low, rating low→high
- [x] Detail view (click a card) with synopsis, genres, notes, date added
- [x] Auto-fill from AniList (anime/manga) and TMDB (movies/shows, needs a free key in Settings)
- [x] Background metadata refresh on startup (slow for big libraries: AniList allows 30 requests/min)
- [x] Full keyboard navigation, with rebindable keys (Settings) — press `?` or `Ctrl+S` in the app for the list

---

## Up Next
- [ ] Mouse delete confirmation (keyboard delete already needs two presses; the ✕ button deletes instantly)
- [ ] Refresh option that skips entries that already have a cover/description/year (faster startup)
- [ ] Keyboard way to browse the *whole* genre list in the Add/Edit dialog without typing (e.g. Alt+↓)
- [ ] Bump the version in `package.json` (still `0.1.0`, but tags `v1.0.1`/`v1.0.2` exist) before the next release
- [ ] Cut a new release — lots of changes since `v1.0.2` (AniList, keyboard navigation, rebinding)
- [ ] Cover image from a local file (drag and drop an image onto a card)

---

## Future Ideas
- [ ] Custom icons / sprites for each media type
- [ ] Statistics page — charts for "completed by type", "total hours watched", etc.
- [ ] Dark/light theme toggle (the CSS variables in styles.css make this easy)
- [ ] Export library to JSON (for backup)
- [ ] Import from JSON (to restore a backup)
- [ ] Notes / journal per entry (log episode thoughts, etc.)
- [ ] Franchise grouping (e.g. link "Dune" book to "Dune" movie)

---

## Bugs / Issues

<!-- Add any bugs you notice below with a brief description -->
- Seeing `AniList request failed: HTTP 429` in the terminal? That's AniList's rate limit (30/min). The app now queues and retries automatically — see `anilistFetch` in `src/main/main.ts`.
- Covers not showing for some entries? Check the `img-src` list in the Content-Security-Policy tag in `public/index.html`.

---

## Questions / Notes

<!-- Scratch pad — anything you want to remember or come back to -->

## Plan/TODO

<!-- Scratch pad — anything you want to remember or come back to -->
1. Fix main display of entries
2. ~~Edit Entries~~ (done)
3. ~~Ratings~~ (done)
4. Delete confirmation (change delete button look) — keyboard delete is done (press twice); the mouse ✕ button still deletes immediately
5. ~~Sort alphabetically~~ (done — plus Z–A and by rating)
6. ~~add keyboard shortcuts~~ (done — press ? or Ctrl+S in the app for the list)

later
1. Potential web scraping for images, descriptions

Simple UI/UX fixes
1. make delete genre button bigger (check other buttons)
