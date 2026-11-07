import { openDB, type DBSchema, type IDBPDatabase } from 'idb';
import { CURRENT_SCHEMA_VERSION, type Note } from './model';

export interface LocalMeta {
  activeId: string | null;
  /** IDs deleted on this device whose server-side delete has not been confirmed yet. */
  tombstones: Record<string, string>;
}

export interface LocalSnapshot extends LocalMeta {
  notes: Note[];
}

/** Where the sync engine keeps its offline copy. */
export interface LocalStore {
  load(): Promise<LocalSnapshot>;
  putNote(note: Note): Promise<void>;
  deleteNote(id: string): Promise<void>;
  saveMeta(meta: LocalMeta): Promise<void>;
  close(): void;
}

interface StillnoteDB extends DBSchema {
  notes: { key: string; value: Note };
  meta: { key: string; value: unknown };
}

const DB_VERSION = 2;

// One database per account, so signing in as someone else never shows their notes.
export async function openLocalStore(userId: string): Promise<LocalStore> {
  const db = await openDB<StillnoteDB>(`stillnote-${userId}`, DB_VERSION, {
    upgrade(database, oldVersion) {
      // Version 2 only migrates note content, which happens after the database opens.
      if (oldVersion < 1) {
        database.createObjectStore('notes', { keyPath: 'id' });
        database.createObjectStore('meta');
      }
    },
  });
  await importFromLocalStorage(db, userId);
  try {
    await migrateLocalNotes(db);
  } catch (error) {
    // Never make the app unusable because a one-time local upgrade failed. Notes stay
    // intact and the server converts any Markdown they are uploaded with.
    console.warn('Stillnote could not upgrade its local notes yet:', error);
  }

  return {
    async load() {
      const [notes, activeId, tombstones] = await Promise.all([
        db.getAll('notes'),
        db.get('meta', 'activeId'),
        db.get('meta', 'tombstones'),
      ]);
      return {
        notes: notes.filter(isNote),
        activeId: typeof activeId === 'string' ? activeId : null,
        tombstones: isRecord(tombstones) ? (tombstones as Record<string, string>) : {},
      };
    },
    async putNote(note) {
      await db.put('notes', note);
    },
    async deleteNote(id) {
      await db.delete('notes', id);
    },
    async saveMeta(meta) {
      const tx = db.transaction('meta', 'readwrite');
      await Promise.all([tx.store.put(meta.activeId, 'activeId'), tx.store.put(meta.tombstones, 'tombstones'), tx.done]);
    },
    close: () => db.close(),
  };
}

// Earlier versions kept everything in one localStorage entry. Move it across once.
async function importFromLocalStorage(db: IDBPDatabase<StillnoteDB>, userId: string) {
  if (typeof localStorage === 'undefined') return;
  if (await db.get('meta', 'importedFromLocalStorage')) return;
  const scopedKey = `stillnote.v1.${userId}`;
  try {
    const raw = localStorage.getItem(scopedKey) ?? localStorage.getItem('stillnote.v1');
    if (raw) {
      const parsed = JSON.parse(raw) as { documents?: unknown[]; deletedIds?: unknown; activeId?: unknown };
      const tx = db.transaction(['notes', 'meta'], 'readwrite');
      for (const item of parsed.documents ?? []) {
        if (isNote(item)) tx.objectStore('notes').put({ ...item, pinned: Boolean((item as Note).pinned) });
      }
      if (isRecord(parsed.deletedIds)) tx.objectStore('meta').put(parsed.deletedIds, 'tombstones');
      if (typeof parsed.activeId === 'string') tx.objectStore('meta').put(parsed.activeId, 'activeId');
      await tx.done;
    }
    await db.put('meta', true, 'importedFromLocalStorage');
    localStorage.removeItem(scopedKey);
    localStorage.removeItem('stillnote.v1');
  } catch (error) {
    console.warn('Stillnote could not import its old local cache:', error);
  }
}

/**
 * Upgrades notes written by the old Markdown editor in place, without clearing
 * the database or changing IDs, timestamps or versions. The marker is written
 * only after every convertible note has been saved, so an interrupted upgrade
 * is retried on the next start.
 */
async function migrateLocalNotes(db: IDBPDatabase<StillnoteDB>) {
  const marker = await db.get('meta', 'contentMigrationVersion');
  if (typeof marker === 'number' && marker >= CURRENT_SCHEMA_VERSION) return;

  const notes = await db.getAll('notes');
  const needsUpgrade = notes.filter(
    (note) => note.content !== null && !(note.contentFormat === 'html' && note.contentSchemaVersion === CURRENT_SCHEMA_VERSION),
  );

  if (needsUpgrade.length > 0) {
    // Loaded only when an old note is actually present, keeping the normal bundle small.
    const { markdownToHtml, sanitizeRichHtml, htmlToPlainText, escapeHtml } = await import('./richText');
    const tx = db.transaction(['notes', 'meta'], 'readwrite');
    for (const note of needsUpgrade) {
      const source = note.content ?? '';
      let html: string;
      try {
        html = note.contentFormat === 'html' ? sanitizeRichHtml(source) : markdownToHtml(source);
      } catch {
        // Last resort: keep every character, even if formatting cannot be parsed.
        html = source ? `<p>${escapeHtml(source).replace(/\n/g, '<br />')}</p>` : '';
      }
      tx.objectStore('notes').put({
        ...note,
        content: html,
        contentFormat: 'html',
        contentSchemaVersion: CURRENT_SCHEMA_VERSION,
        snippet: htmlToPlainText(html).slice(0, 200),
      });
    }
    await tx.done;
  }

  await db.put('meta', CURRENT_SCHEMA_VERSION, 'contentMigrationVersion');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isNote(value: unknown): value is Note {
  if (!isRecord(value)) return false;
  return typeof value.id === 'string' && typeof value.title === 'string' && (typeof value.content === 'string' || value.content === null);
}
