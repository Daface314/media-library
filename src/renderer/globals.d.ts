// globals.d.ts — Declares the shape of window.api for TypeScript.
// A .d.ts file is a "declaration file" — it only contains type information,
// no actual code. TypeScript reads it automatically.
// Declaring an interface here at the top level merges it into the global
// Window type, so TypeScript knows what window.api looks like everywhere.

interface Window {
    api: {
        addMedia:      (title: string, type: string, status: string, notes: string) => Promise<any>;
        getAllMedia:   () => Promise<any[]>;
        searchMedia:  (query: string) => Promise<any[]>;
        getByStatus:  (status: string) => Promise<any[]>;
        getByTag:     (tagName: string) => Promise<any[]>;
        getAllTags:    () => Promise<{ id: number; name: string; count: number }[]>;
        addTagToMedia: (mediaId: number, tagName: string) => Promise<void>;
        deleteMedia:  (id: number) => Promise<void>;
        deleteTag:      (id: number) => Promise<void>;
        addMediaField:  (mediaId: number, fieldName: string, fieldValue: string) => Promise<void>;
        updateMedia:    (id: number, title: string, type: string, status: string, notes: string) => Promise<void>;
        clearMediaTags: (id: number) => Promise<void>;
        clearMediaFields: (id: number) => Promise<void>;
    };
}
