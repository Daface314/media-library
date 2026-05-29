// preload.ts — The security bridge between main process and renderer process.
//
// The renderer (UI) runs in a sandboxed browser context and cannot call Node.js
// or database code directly. This preload script runs with elevated privileges
// and uses contextBridge to expose a safe, controlled API to the renderer.
//
// Think of it like a public interface in Java — the renderer only sees what
// we explicitly choose to expose here, nothing more.

import { contextBridge, ipcRenderer } from 'electron';

// contextBridge.exposeInMainWorld('api', { ... }) makes window.api available
// in the renderer. The renderer calls window.api.addMedia(...) etc.
contextBridge.exposeInMainWorld('api', {

    // Each method sends a named message to the main process via IPC
    // and returns a Promise that resolves with the result.
    // ipcRenderer.invoke() is the async "ask and wait for answer" call.

    addMedia: (title: string, type: string, status: string, notes: string) =>
        ipcRenderer.invoke('add-media', title, type, status, notes),

    getAllMedia: () =>
        ipcRenderer.invoke('get-all-media'),

    searchMedia: (query: string) =>
        ipcRenderer.invoke('search-media', query),

    getByStatus: (status: string) =>
        ipcRenderer.invoke('get-media-by-status', status),

    getByTag: (tagName: string) =>
        ipcRenderer.invoke('get-media-by-tag', tagName),

    getAllTags: () =>
        ipcRenderer.invoke('get-all-tags'),

    addTagToMedia: (mediaId: number, tagName: string) =>
        ipcRenderer.invoke('add-tag-to-media', mediaId, tagName),

    deleteMedia: (id: number) =>
        ipcRenderer.invoke('delete-media', id),

    deleteTag: (id: number) =>
        ipcRenderer.invoke('delete-tag', id),

    addMediaField: (mediaId: number, fieldName: string, fieldValue: string) =>
        ipcRenderer.invoke('add-media-field', mediaId, fieldName, fieldValue),

    updateMedia: (id: number, title: string, type: string, status: string, notes: string) =>
        ipcRenderer.invoke('update-media', id, title, type, status, notes),

    clearMediaTags: (id: number) =>
        ipcRenderer.invoke('clear-media-tags', id),

    clearMediaFields: (id: number) =>
        ipcRenderer.invoke('clear-media-fields', id),
});
