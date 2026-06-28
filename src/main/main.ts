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

    // Searches the Jikan v4 API (MyAnimeList data) for anime or manga.
    // Running this in main keeps the renderer sandboxed — no outbound fetch from the UI.
    ipcMain.handle('search-jikan', async (_event, mediaType: string, query: string) => {
        const endpoint = mediaType === 'manga' ? 'manga' : 'anime';
        const url = `https://api.jikan.moe/v4/${endpoint}?q=${encodeURIComponent(query)}&limit=12&sfw=true`;
        try {
            const response = await fetch(url);
            if (!response.ok) return [];
            const json = await response.json() as { data?: unknown[] };
            return json.data ?? [];
        } catch {
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
