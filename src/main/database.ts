// database.ts — All SQLite database logic lives here.
// This is the "data layer" — nothing in this file touches the UI.
// Think of MediaDatabase like a Java class that wraps a JDBC connection.

import Sqlite from 'better-sqlite3';

// TypeScript interfaces define the shape of data objects —
// similar to structs in C++ or POJOs in Java.
export interface MediaEntry {
    id: number;
    title: string;
    type: string;        // 'movie' | 'show' | 'anime' | 'book' | 'manga'
    status: string;      // 'planning' | 'in_progress' | 'completed' | 'dropped' | 'on_hold'
    rating: number | null;
    date_added: string;
    notes: string | null;
    tags?: string[];                    // ? means optional — may or may not be present
    fields?: Record<string, string>;    // type-specific extras e.g. { episodes: "26" }
}

export interface Tag {
    id: number;
    name: string;
    count: number;
}

export class MediaDatabase {
    // private: only methods inside this class can access db directly
    private db: Sqlite.Database;

    constructor(filePath: string) {
        // Opens the database file, or creates it if it doesn't exist yet
        this.db = new Sqlite(filePath);

        // SQLite doesn't enforce foreign keys by default — this turns that on.
        // Foreign keys are links between tables (e.g. media_tags.media_id → media.id).
        this.db.pragma('foreign_keys = ON');

        this.createTables();
    }

    private createTables(): void {
        // db.exec() runs raw SQL — like executing a .sql file.
        // CREATE TABLE IF NOT EXISTS means "only create if it doesn't already exist"
        // so running this on startup is always safe.
        this.db.exec(`
            -- media: one row per item in your library
            CREATE TABLE IF NOT EXISTS media (
                id         INTEGER PRIMARY KEY AUTOINCREMENT,
                title      TEXT    NOT NULL,
                type       TEXT    NOT NULL,
                status     TEXT    NOT NULL DEFAULT 'planning',
                rating     INTEGER,
                date_added TEXT    DEFAULT (datetime('now')),
                notes      TEXT
            );

            -- tags: a list of unique tag/genre names (e.g. "romance", "sci-fi")
            CREATE TABLE IF NOT EXISTS tags (
                id   INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT NOT NULL UNIQUE
            );

            -- media_tags: the join table that links media entries to tags.
            -- One media item can have many tags; one tag can belong to many items.
            -- This is a "many-to-many" relationship.
            CREATE TABLE IF NOT EXISTS media_tags (
                media_id INTEGER NOT NULL REFERENCES media(id) ON DELETE CASCADE,
                tag_id   INTEGER NOT NULL REFERENCES tags(id)  ON DELETE CASCADE,
                PRIMARY KEY (media_id, tag_id)
            );

            -- media_fields: flexible key-value extras per entry.
            -- Stores type-specific data like "author" for books or "episodes" for anime
            -- without needing extra columns on the main media table.
            CREATE TABLE IF NOT EXISTS media_fields (
                id          INTEGER PRIMARY KEY AUTOINCREMENT,
                media_id    INTEGER NOT NULL REFERENCES media(id) ON DELETE CASCADE,
                field_name  TEXT    NOT NULL,
                field_value TEXT
            );
        `);
    }

    // ─── Media CRUD ──────────────────────────────────────────────────────────

    // "prepare" compiles a SQL statement once so it can run many times efficiently.
    // The ? placeholders are filled in safely when you call .run() or .get().
    // This prevents SQL injection attacks.

    addMedia(title: string, type: string, status: string, notes: string = ''): MediaEntry {
        const stmt = this.db.prepare(`
            INSERT INTO media (title, type, status, notes)
            VALUES (?, ?, ?, ?)
        `);
        const result = stmt.run(title, type, status, notes);
        // lastInsertRowid is the auto-assigned id of the new row
        return this.getMediaById(result.lastInsertRowid as number)!;
    }

    getMediaById(id: number): MediaEntry | undefined {
        const row = this.db.prepare('SELECT * FROM media WHERE id = ?').get(id) as MediaEntry | undefined;
        if (!row) return undefined;
        row.tags   = this.getTagsForMedia(id);
        row.fields = this.getFieldsForMedia(id);
        return row;
    }

    getAllMedia(): MediaEntry[] {
        const rows = this.db.prepare(
            'SELECT * FROM media ORDER BY date_added DESC'
        ).all() as MediaEntry[];

        // Array.map() transforms each element — like a for-loop that builds a new array.
        // Here we attach tags and extra fields to each entry.
        return rows.map(row => ({
            ...row,
            tags:   this.getTagsForMedia(row.id),
            fields: this.getFieldsForMedia(row.id),
        }));
    }

    searchMedia(query: string): MediaEntry[] {
        const rows = this.db.prepare(
            'SELECT * FROM media WHERE title LIKE ? ORDER BY date_added DESC'
        ).all(`%${query}%`) as MediaEntry[];
        return rows.map(row => ({
            ...row,
            tags:   this.getTagsForMedia(row.id),
            fields: this.getFieldsForMedia(row.id),
        }));
    }

    getMediaByStatus(status: string): MediaEntry[] {
        const rows = this.db.prepare(
            'SELECT * FROM media WHERE status = ? ORDER BY date_added DESC'
        ).all(status) as MediaEntry[];
        return rows.map(row => ({
            ...row,
            tags:   this.getTagsForMedia(row.id),
            fields: this.getFieldsForMedia(row.id),
        }));
    }

    getMediaByTag(tagName: string): MediaEntry[] {
        const rows = this.db.prepare(`
            SELECT m.*
            FROM media m
            JOIN media_tags mt ON m.id   = mt.media_id
            JOIN tags       t  ON t.id   = mt.tag_id
            WHERE t.name = ?
            ORDER BY m.date_added DESC
        `).all(tagName) as MediaEntry[];
        return rows.map(row => ({
            ...row,
            tags:   this.getTagsForMedia(row.id),
            fields: this.getFieldsForMedia(row.id),
        }));
    }

    updateMedia(id: number, title: string, type: string, status: string, notes: string): void {
        this.db.prepare(`
            UPDATE media SET title = ?, type = ?, status = ?, notes = ?
            WHERE id = ?
        `).run(title, type, status, notes, id);
    }

    deleteMedia(id: number): void {
        // ON DELETE CASCADE in the schema automatically deletes related rows
        // in media_tags and media_fields when a media row is deleted.
        this.db.prepare('DELETE FROM media WHERE id = ?').run(id);
    }

    // Used when editing an entry — wipe all existing tags/fields so we can re-add the new set
    clearMediaTags(id: number): void {
        this.db.prepare('DELETE FROM media_tags WHERE media_id = ?').run(id);
    }

    clearMediaFields(id: number): void {
        this.db.prepare('DELETE FROM media_fields WHERE media_id = ?').run(id);
    }

    // ─── Tags ─────────────────────────────────────────────────────────────────

    getAllTags(): Tag[] {
        // COUNT() counts how many media items use each tag (for display in the sidebar)
        // LEFT JOIN keeps tags that have zero media items (count = 0)
        return this.db.prepare(`
            SELECT t.id, t.name, COUNT(mt.media_id) as count
            FROM tags t
            LEFT JOIN media_tags mt ON t.id = mt.tag_id
            GROUP BY t.id
            ORDER BY t.name ASC
        `).all() as Tag[];
    }

    deleteTag(id: number): void {
        // ON DELETE CASCADE removes all media_tags rows that reference this tag,
        // so every entry that used this genre is automatically cleaned up.
        this.db.prepare('DELETE FROM tags WHERE id = ?').run(id);
    }

    addTagToMedia(mediaId: number, tagName: string): void {
        // INSERT OR IGNORE: insert the tag, but skip silently if it already exists
        this.db.prepare('INSERT OR IGNORE INTO tags (name) VALUES (?)').run(tagName);

        const tag = this.db.prepare('SELECT id FROM tags WHERE name = ?').get(tagName) as { id: number };

        // Same idea: link the tag to the media entry, skip if already linked
        this.db.prepare(
            'INSERT OR IGNORE INTO media_tags (media_id, tag_id) VALUES (?, ?)'
        ).run(mediaId, tag.id);
    }

    // ─── Extra Fields ─────────────────────────────────────────────────────────

    addMediaField(mediaId: number, fieldName: string, fieldValue: string): void {
        // INSERT OR REPLACE updates an existing field if it already exists,
        // so re-saving an entry won't create duplicate rows.
        this.db.prepare(`
            INSERT INTO media_fields (media_id, field_name, field_value)
            VALUES (?, ?, ?)
        `).run(mediaId, fieldName, fieldValue);
    }

    // private: converts the media_fields rows into a plain key→value object
    // e.g. [{ field_name: "episodes", field_value: "26" }]  →  { episodes: "26" }
    private getFieldsForMedia(mediaId: number): Record<string, string> {
        const rows = this.db.prepare(
            'SELECT field_name, field_value FROM media_fields WHERE media_id = ?'
        ).all(mediaId) as { field_name: string; field_value: string }[];

        // Object.fromEntries() builds an object from an array of [key, value] pairs —
        // like Map::insert() in C++ or Map.put() in Java, but produces a plain object.
        return Object.fromEntries(rows.map(r => [r.field_name, r.field_value]));
    }

    // ─── Private tag helper ───────────────────────────────────────────────────

    private getTagsForMedia(mediaId: number): string[] {
        const rows = this.db.prepare(`
            SELECT t.name
            FROM tags t
            JOIN media_tags mt ON t.id = mt.tag_id
            WHERE mt.media_id = ?
        `).all(mediaId) as { name: string }[];

        return rows.map(r => r.name);
    }
}
