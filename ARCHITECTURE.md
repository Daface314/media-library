# Media Library — Architecture Reference

A reference document for how the project is structured and why.
Update this as the project grows.

---

## Technology Stack

| Layer        | Technology                      | Why                                              |
|--------------|---------------------------------|--------------------------------------------------|
| App shell    | **Electron**                    | Desktop app using web tech (HTML/CSS/JS)         |
| Language     | **TypeScript**                  | JavaScript + type safety (catches bugs early)    |
| UI           | **HTML + CSS**                  | Fully customizable, sprite-friendly              |
| Database     | **SQLite** via `better-sqlite3` | Single file, no server, fast, offline            |
| Auto-fill    | **AniList** (anime/manga), **TMDB** (movies/shows) | Covers, synopsis, year, genres, episode counts |
| Packaging    | **electron-builder** + GitHub Actions | NSIS installer + portable `.exe` on tagged releases |

---

## Electron's Two-Process Model

Electron apps always have **two separate processes** running at the same time.
This is the most important concept to understand about Electron.

```
┌─────────────────────────────────────────────────────────────┐
│  MAIN PROCESS  (Node.js)                                    │
│  src/main/main.ts                                           │
│  ─ Creates the app window                                   │
│  ─ Accesses the filesystem                                  │
│  ─ Reads/writes the SQLite database                         │
│  ─ Has full system access                                   │
└─────────────────────────────────────────────────────────────┘
            ▲                  │
            │   IPC messages   │
            │  (named events)  ▼
┌─────────────────────────────────────────────────────────────┐
│  RENDERER PROCESS  (Chromium browser)                       │
│  src/renderer/renderer.ts  +  public/index.html             │
│  ─ Renders the HTML/CSS UI                                  │
│  ─ Responds to user clicks                                  │
│  ─ NO direct filesystem/database access (sandboxed)         │
└─────────────────────────────────────────────────────────────┘
```

**Why separate?** Security. If a webpage runs in your app and tries to read your files,
the renderer's sandbox stops it. Only the explicitly exposed API (via preload) gets through.

---

## IPC — How the Processes Talk

IPC stands for **Inter-Process Communication**. It's how the renderer asks the main process
to do things (like "add this entry to the database").

```
Renderer                     Preload Bridge               Main Process
──────────                   ─────────────                ────────────
window.api.addMedia(...)  →  ipcRenderer.invoke(...)  →  ipcMain.handle(...)
                                                               │
                          ←  Promise resolves           ←  return db.addMedia(...)
```

1. Renderer calls `window.api.addMedia(title, type, status, rating, notes)`
2. Preload sends it as a named IPC message `'add-media'` to the main process
3. Main process receives it, calls `db.addMedia(...)`, returns the result
4. Renderer gets the result back as a resolved Promise

---

## Preload Script

`src/main/preload.ts` is the **security bridge**. It runs with elevated privileges
(Node.js access) but explicitly chooses what to expose to the renderer via `contextBridge`.

The renderer can only call what's listed in `contextBridge.exposeInMainWorld('api', { ... })`.
Nothing more. This is a security boundary.

---

## File Structure

```
media-library/
├── public/                   Static assets (no compilation needed)
│   ├── index.html            Main window layout (HTML structure) + Content-Security-Policy
│   └── styles.css            All visual styling (colors, layout, animations)
│
├── src/
│   ├── main/                 Main process code (Node.js / system access)
│   │   ├── main.ts           App entry point — creates window, registers IPC handlers,
│   │   │                     AniList/TMDB requests (incl. the AniList rate-limit queue)
│   │   ├── database.ts       All database logic — the MediaDatabase class
│   │   └── preload.ts        IPC bridge — exposes window.api to the renderer
│   │
│   └── renderer/             Renderer process code (browser context)
│       ├── renderer.ts       All UI logic — rendering cards, dialogs, filters, auto-fill,
│       │                     and the keyboard layer
│       └── globals.d.ts      Type declaration for window.api
│
├── dist/                     Compiled JavaScript output (auto-generated, don't edit)
│   ├── main/
│   │   ├── main.js
│   │   ├── database.js
│   │   └── preload.js
│   └── renderer/
│       └── renderer.js
│
├── package.json              Project metadata + npm scripts + dependency list
├── tsconfig.json             TypeScript compiler settings
├── .github/workflows/        CI: release.yml builds and publishes on v* tags
├── handoff.json              Detailed context dump for picking the project back up
├── TODO.md                   Your personal task notes
└── ARCHITECTURE.md           This file
```

---

## Database Schema

Four tables. The key design choice is the **many-to-many tag system**
instead of storing tags as plain text.

```
media                          tags
─────────────────────────      ───────────
id       INTEGER  PK           id     INTEGER  PK
title    TEXT                  name   TEXT UNIQUE
type     TEXT                  
status   TEXT                  
rating   INTEGER (nullable)    media_tags  (join table)
date_added TEXT                ───────────────────────
notes    TEXT (nullable)       media_id  → media.id
                               tag_id    → tags.id
media_fields
─────────────────────────
id          INTEGER  PK
media_id    → media.id         (for type-specific extras
field_name  TEXT                like "author", "episodes")
field_value TEXT
```

### Why a join table for tags?

If tags were stored as plain text (`genres = "romance, sci-fi"`), you couldn't
efficiently query "show me all romance items." You'd have to scan every row and
search inside a string — slow and fragile.

With the join table, "all romance items" is a fast, indexed SQL JOIN.
The Genres sidebar tab is built entirely on this pattern.

### ON DELETE CASCADE

When you delete a media entry, SQLite automatically deletes all of its
`media_tags` and `media_fields` rows too. This is declared in the schema
as `REFERENCES media(id) ON DELETE CASCADE`. No manual cleanup needed.

---

## Data Flow: Adding a New Entry

Example: user fills in the "Add Entry" modal and clicks Save.

```
1. renderer.ts: saveNewEntry()
   ├── reads form values (title, type, status, notes, tags)
   ├── calls window.api.addMedia(title, type, status, rating, notes)
   │
2. preload.ts: ipcRenderer.invoke('add-media', ...)
   │   ↓ crosses the process boundary
3. main.ts: ipcMain.handle('add-media', ...) → db.addMedia(...)
   │
4. database.ts: addMedia()
   ├── INSERT INTO media (title, type, status, rating, notes)
   └── returns the newly created MediaEntry (with auto-assigned id)
   │   ↓ result travels back up the chain
5. renderer.ts: receives the new entry object
   ├── for each tag: calls window.api.addTagToMedia(entry.id, tagName)
   ├── for cover/description/year/episodes: calls window.api.addMediaField(...)
   └── calls loadMedia() + loadGenres() to refresh the UI
```

---

## Auto-Fill APIs

The Add/Edit dialog and a background refresh at startup fill in cover, synopsis, year,
genres and episode/volume counts. These requests run in the **main process** (the renderer
stays sandboxed), reached through IPC.

| Type          | Source  | Key needed | IPC call                         |
|---------------|---------|------------|----------------------------------|
| Anime / manga | AniList (GraphQL, `graphql.anilist.co`) | No | `searchAnilist` (channel `search-anilist`) |
| Movie / show  | TMDB    | Yes (Settings) | `searchTmdb`, `getTmdbTvDetails` |
| Book          | —       | —          | none (no source)                 |

Things worth knowing:

- **AniList replaced Jikan** (a MyAnimeList wrapper) after Jikan's public API shut down in
  Oct 2026. `search-anilist` returns objects shaped like Jikan's old results, so the renderer's
  fill and refresh code didn't change.
- **Rate limit: 30 requests/minute.** All AniList calls go through one queue in `main.ts`
  (`anilistFetch`) that spaces them ~2.2s apart and retries HTTP 429 using the `Retry-After`
  header. The startup refresh of a large library is therefore slow (about 2s per anime/manga
  entry) but runs in the background.
- Any failure returns an empty list and is logged to the terminal (`console.error`).
- The refresh only overwrites auto-fill fields (`image_url`, `description`, `title_english`,
  `year`, `episodes`, `volumes`); user data (rating, status, notes, `current_episode`) is kept,
  and genres are only ever added.

---

## Content Security Policy

`public/index.html` has a CSP `<meta>` tag that limits what the page can load. The important
line for images is `img-src`, which must list every host that serves covers:

```
img-src 'self' https://*.anilist.co https://cdn.myanimelist.net https://image.tmdb.org
```

If a new cover source is added (or a CDN host changes), add it here. A missing host fails
silently: the URL is saved correctly but the image never loads.

---

## Keyboard Navigation

The whole app can be driven from the keyboard. It lives in one section of `renderer.ts`:
a single document-level `keydown` listener (`handleKeydown`) decides what each key means from
where focus is and which dialog is open.

```
key press
  ├─ Settings waiting for a new binding?  → capture it
  ├─ Ctrl+S → toggle the shortcut list      Ctrl+Enter → save the open dialog
  ├─ Esc → handleEscape (closes dialogs, leaves text boxes, closes the genre filter)
  ├─ a dialog is open → Tab trap / detail-view keys / Add-Edit keys
  ├─ typing in a text box → left alone (a few keys move out of it)
  ├─ genre filter focused → genre filter keys
  ├─ a bound shortcut key → run the action (clicks the same button a mouse user would)
  └─ otherwise → grid keys (arrows between cards, Enter/E/0-5/Delete on the selected card)
```

- **Rebindable keys:** the `KEY_ACTIONS` table lists every rebindable action with its default
  key. Overrides are saved in `localStorage` (`media-library.keybinds`) and edited in the
  Settings dialog. The `?` / Ctrl+S help list is generated from the current bindings.
- **Fixed keys:** Esc, Tab, Space, Backspace, the arrows, Home/End/PgUp/PgDn, 0–5 (rating),
  Ctrl+Enter and Ctrl+S.
- **Add/Edit dialog:** ↑/↓ only ever move between fields; ←/→ step through lists (drop-down
  value, stars, auto-fill results, genre dropdown); drop-downs open only on Enter.
- **Focus bookkeeping:** `rememberFocus()` / `restoreFocus()` send focus back to the selected
  card after any dialog closes, and `renderMediaGrid` re-focuses the same grid position after
  the grid is rebuilt. Cards use a roving `tabindex` so Tab enters the grid once.
- **Gotcha:** while the details view is open, focus stays on the card behind it, so scrolling
  is done in JS (`handleDetailKeys`); otherwise the browser would scroll the grid behind it.

---

## CSS Theming

All colors are defined as CSS custom properties (variables) at the top of `styles.css`:

```css
:root {
    --bg-primary:   #0f0f1a;
    --accent:       #e94560;
    /* ... */
}
```

To retheme the app, only change values in `:root`. Every element references
these variables, so a single change propagates everywhere instantly.
This is also how you'd implement a light/dark mode toggle in the future.

---

## How to Add a New Media Type

1. **`public/index.html`** — add a new `<option>` in `#input-type` and a new `.filter-btn`
2. **`public/styles.css`** — add a `.media-card.type-yourtype { border-left: 3px solid #color; }` rule
3. That's it. The database schema is type-agnostic — no SQL changes needed.

---

## npm Scripts

| Command                | What it does                                        |
|------------------------|-----------------------------------------------------|
| `npm run dev`          | Compile TypeScript → launch the app                 |
| `npm run build`        | Compile TypeScript only (no launch)                 |
| `npm run start`        | Launch without recompiling (use after `build`)      |
| `npm run rebuild-sqlite` | Rebuild the SQLite native module for Electron     |
