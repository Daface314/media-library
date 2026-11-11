// main.ts — The Electron "main process"
// Think of this like the main() entry point of a Java/C++ program.
// It runs in Node.js (has full filesystem access), creates the app window,
// and handles communication with the UI (renderer process).

import { app, BrowserWindow, ipcMain } from 'electron';
import * as path from 'path';
import * as fs from 'fs';
import { MediaDatabase } from './database';

// ─── Config file helpers ──────────────────────────────────────────────────
// Stores user settings (e.g. API keys) in a JSON file next to the database.
// Like a simple key-value properties file in Java.
let configPath: string;

function readConfig(): Record<string, string> {
    try {
        return JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    } catch {
        return {};  // file doesn't exist yet — return empty object
    }
}

function writeConfig(data: Record<string, string>): void {
    fs.writeFileSync(configPath, JSON.stringify(data, null, 2), 'utf-8');
}

// Single database instance shared across the app's lifetime
// (like a static singleton in Java)
let db: MediaDatabase;

function createWindow(): void {
    const win = new BrowserWindow({
        width: 1200,
        height: 800,
        minWidth: 900,
        minHeight: 600,
        autoHideMenuBar: true,   // hide the default Electron menu bar
        backgroundColor: '#0f0f1a',
        webPreferences: {
            // preload.js runs before the renderer and safely bridges the two processes
            preload: path.join(__dirname, 'preload.js'),
            contextIsolation: true,  // renderer cannot directly access Node.js APIs
            nodeIntegration: false   // security best practice for Electron apps
        }
    });

    // Load the HTML file that defines our UI
    // __dirname = dist/main/, so ../../public/ = project root /public/
    win.loadFile(path.join(__dirname, '../../public/index.html'));
}

// app.whenReady() is like an async "on application start" callback
app.whenReady().then(() => {
    // Store the database file in the OS-appropriate user data folder
    // e.g. C:\Users\you\AppData\Roaming\media-library\library.db
    const dbPath  = path.join(app.getPath('userData'), 'library.db');
    configPath    = path.join(app.getPath('userData'), 'config.json');
    db = new MediaDatabase(dbPath);

    registerIpcHandlers();
    createWindow();

    // macOS: re-open window when clicking the dock icon if all windows are closed
    app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
});

// Quit the app when all windows are closed (except on macOS)
app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
});

// IPC (Inter-Process Communication) handlers
// These are like RPC endpoints — the renderer calls them by name
// and gets back a result asynchronously (like async methods in Java).
function registerIpcHandlers(): void {

    // _event is the IPC event object (we don't need it, but it's always the first arg)
    ipcMain.handle('add-media', (_event, title: string, type: string, status: string, rating: number | null, notes: string) => {
        try {
            return db.addMedia(title, type, status, rating, notes);
        } catch (err: any) {
            return { error: err.message };
        }
    });

    ipcMain.handle('get-all-media', () => {
        return db.getAllMedia();
    });

    ipcMain.handle('search-media', (_event, query: string) => {
        return db.searchMedia(query);
    });

    ipcMain.handle('get-media-by-status', (_event, status: string) => {
        return db.getMediaByStatus(status);
    });

    ipcMain.handle('get-media-by-tag', (_event, tagName: string) => {
        return db.getMediaByTag(tagName);
    });

    ipcMain.handle('get-all-tags', () => {
        return db.getAllTags();
    });

    ipcMain.handle('add-tag-to-media', (_event, mediaId: number, tagName: string) => {
        return db.addTagToMedia(mediaId, tagName);
    });

    ipcMain.handle('delete-media', (_event, id: number) => {
        return db.deleteMedia(id);
    });

    ipcMain.handle('delete-tag', (_event, id: number) => {
        return db.deleteTag(id);
    });

    ipcMain.handle('add-media-field', (_event, mediaId: number, fieldName: string, fieldValue: string) => {
        return db.addMediaField(mediaId, fieldName, fieldValue);
    });

    ipcMain.handle('update-media', (_event, id: number, title: string, type: string, status: string, rating: number | null, notes: string) => {
        try {
            return db.updateMedia(id, title, type, status, rating, notes);
        } catch (err: any) {
            return { error: err.message };
        }
    });

    ipcMain.handle('update-rating', (_event, id: number, rating: number | null) => {
        return db.updateRating(id, rating);
    });

    ipcMain.handle('clear-media-tags', (_event, id: number) => {
        return db.clearMediaTags(id);
    });

    ipcMain.handle('clear-media-fields', (_event, id: number) => {
        return db.clearMediaFields(id);
    });

    // Searches the AniList GraphQL API for anime or manga (replaces Jikan, whose public API was shut down).
    // Running this in main keeps the renderer sandboxed — no outbound fetch from the UI.
    // Results are mapped into the field names the renderer reads (the shape Jikan used to return).
    // GraphQL = one POST endpoint where the query string lists exactly which fields you want.
    const ANILIST_QUERY = `
        query ($search: String, $type: MediaType) {
            Page(perPage: 12) {
                media(search: $search, type: $type, isAdult: false) {
                    title { romaji english }
                    description(asHtml: false)
                    seasonYear
                    startDate { year }
                    episodes
                    volumes
                    genres
                    coverImage { medium large }
                }
            }
        }`;

    // AniList currently allows 30 requests per minute (it reports this in the X-RateLimit-Limit
    // header), so every request goes through one queue that spaces them ~2.2s apart. Without this,
    // the startup refresh (one request per entry) and a manual search can overlap and get HTTP 429.
    const ANILIST_MIN_INTERVAL_MS = 2200;
    const ANILIST_MAX_RETRIES     = 2;
    let anilistQueue: Promise<unknown> = Promise.resolve();  // tail of the chain; each call waits for the previous
    let anilistLastSent = 0;                                 // timestamp of the last request (ms)

    const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

    const anilistFetch = (body: string): Promise<Response> => {
        const run = anilistQueue.then(async () => {
            for (let attempt = 0; ; attempt++) {
                const wait = anilistLastSent + ANILIST_MIN_INTERVAL_MS - Date.now();
                if (wait > 0) await sleep(wait);
                anilistLastSent = Date.now();

                const response = await fetch('https://graphql.anilist.co', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
                    body,
                    signal: AbortSignal.timeout(10000)  // don't hang the UI on a dead connection
                });
                if (response.status !== 429 || attempt >= ANILIST_MAX_RETRIES) return response;

                // Rate limited: AniList says how long to wait in the Retry-After header (seconds)
                const retryAfterMs = Math.min((Number(response.headers.get('Retry-After')) || 60) * 1000, 90000);
                console.warn(`AniList rate limit hit; retrying in ${Math.round(retryAfterMs / 1000)}s`);
                anilistLastSent = Date.now() + retryAfterMs - ANILIST_MIN_INTERVAL_MS;  // delays the next send
            }
        });
        anilistQueue = run.catch(() => undefined);  // a failed request must not break the chain
        return run;
    };

    ipcMain.handle('search-anilist', async (_event, mediaType: string, query: string) => {
        try {
            const response = await anilistFetch(JSON.stringify({
                query: ANILIST_QUERY,
                variables: { search: query, type: mediaType === 'manga' ? 'MANGA' : 'ANIME' }
            }));
            if (!response.ok) {
                console.error(`AniList request failed: HTTP ${response.status}`);
                return [];
            }
            const json = await response.json() as { data?: { Page?: { media?: any[] } } };
            return (json.data?.Page?.media ?? []).map((m: any) => ({
                title: m.title?.romaji ?? m.title?.english ?? '',
                title_english: m.title?.english ?? null,
                // AniList synopses can still contain <br> tags; strip them to plain text
                synopsis: m.description
                    ? String(m.description).replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, '').trim()
                    : null,
                year: m.seasonYear ?? m.startDate?.year ?? null,
                episodes: m.episodes ?? null,
                volumes: m.volumes ?? null,
                genres: (m.genres ?? []).map((name: string) => ({ name })),
                images: { jpg: { image_url: m.coverImage?.medium, large_image_url: m.coverImage?.large } }
            }));
        } catch (err) {
            console.error('AniList request failed:', err);
            return [];
        }
    });

    // ─── Settings (API key storage) ───────────────────────────────────────
    ipcMain.handle('get-api-key', (_event, keyName: string) => {
        return readConfig()[keyName] ?? null;
    });

    ipcMain.handle('set-api-key', (_event, keyName: string, value: string) => {
        const config = readConfig();
        config[keyName] = value;
        writeConfig(config);
    });

    // ─── TMDB (The Movie Database) ────────────────────────────────────────
    // Searches TMDB for movies or TV shows using the user's stored API key.
    // Also fetches the genre list in parallel so genre IDs can be resolved to names.
    ipcMain.handle('search-tmdb', async (_event, mediaType: string, query: string) => {
        const apiKey = readConfig()['tmdb_api_key'];
        if (!apiKey) return { error: 'no_key' };

        // TMDB uses 'tv' for shows, 'movie' for movies
        const endpoint  = mediaType === 'show' ? 'tv' : 'movie';
        const searchUrl = `https://api.themoviedb.org/3/search/${endpoint}?api_key=${encodeURIComponent(apiKey)}&query=${encodeURIComponent(query)}&language=en-US&page=1`;
        const genreUrl  = `https://api.themoviedb.org/3/genre/${endpoint}/list?api_key=${encodeURIComponent(apiKey)}&language=en-US`;

        try {
            // Fetch search results and genre list at the same time — Promise.all runs both in parallel
            const [searchRes, genreRes] = await Promise.all([fetch(searchUrl), fetch(genreUrl)]);

            if (searchRes.status === 401) return { error: 'invalid_key' };
            if (!searchRes.ok)            return { error: 'request_failed' };

            const searchJson = await searchRes.json() as { results?: any[] };
            const genreJson  = await genreRes.json()  as { genres?: { id: number; name: string }[] };

            // Build a Map of id → name so we can convert genre IDs to readable strings
            const genreMap = new Map((genreJson.genres ?? []).map(g => [g.id, g.name]));

            // Attach resolved genre names to each result before returning
            const results = (searchJson.results ?? []).slice(0, 12).map((r: any) => ({
                ...r,
                genre_names: (r.genre_ids ?? [])
                    .map((id: number) => genreMap.get(id))
                    .filter(Boolean) as string[],
            }));

            return { results };
        } catch {
            return { error: 'network_error' };
        }
    });

    // Fetches full details for a single TV show — needed for episode count,
    // which the search endpoint doesn't include.
    ipcMain.handle('get-tmdb-tv-details', async (_event, showId: number) => {
        const apiKey = readConfig()['tmdb_api_key'];
        if (!apiKey) return null;
        try {
            const url = `https://api.themoviedb.org/3/tv/${showId}?api_key=${encodeURIComponent(apiKey)}&language=en-US`;
            const res = await fetch(url);
            if (!res.ok) return null;
            return await res.json();
        } catch {
            return null;
        }
    });
}
