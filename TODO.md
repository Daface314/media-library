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
- [x] Add media entries (title, type, status, tags, notes)
- [x] Browse all entries in a grid
- [x] Filter by media type (All / Movie / Show / Anime / Book / Manga)
- [x] Filter by watch status in "My List"
- [x] Filter by genre/tag in "Genres"
- [x] Search by title
- [x] Delete entries

---

## Up Next
- [ ] Edit an existing entry (change title, status, rating, tags)
- [ ] Rating field (1–10 stars) on each entry
- [ ] Sort options: by title (A–Z), date added, rating
- [ ] Click a card to open a detail view / side panel
- [ ] Cover image / poster support (drag and drop an image onto a card)

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

---

## Questions / Notes

<!-- Scratch pad — anything you want to remember or come back to -->

## Plan/TODO

<!-- Scratch pad — anything you want to remember or come back to -->
1. Fix main display of entries
2. Edit Entries
3. Ratings
4. Delete confirmation (change delete button look)
5. Sort alphabetically
6. add keyboard shortcuts

later
1. Potential web scraping for images, descriptions

Simple UI/UX fixes
1. make delete genre button bigger (check other buttons)
