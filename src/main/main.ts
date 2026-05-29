// main.ts — The Electron "main process"
// Think of this like the main() entry point of a Java/C++ program.
// It runs in Node.js (has full filesystem access), creates the app window,
// and handles communication with the UI (renderer process).

import { app, BrowserWindow, ipcMain } from 'electron';
import * as path from 'path';
import { MediaDatabase } from './database';

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
    const dbPath = path.join(app.getPath('userData'), 'library.db');
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
    ipcMain.handle('add-media', (_event, title: string, type: string, status: string, notes: string) => {
        return db.addMedia(title, type, status, notes);
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

    ipcMain.handle('update-media', (_event, id: number, title: string, type: string, status: string, notes: string) => {
        return db.updateMedia(id, title, type, status, notes);
    });

    ipcMain.handle('clear-media-tags', (_event, id: number) => {
        return db.clearMediaTags(id);
    });

    ipcMain.handle('clear-media-fields', (_event, id: number) => {
        return db.clearMediaFields(id);
    });
}
