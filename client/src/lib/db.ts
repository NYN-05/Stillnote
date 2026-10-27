import { openDB, type DBSchema, type IDBPDatabase } from 'idb';
import type { Note } from './types';

export interface LocalMeta {
  activeId: string | null;
  /** IDs deleted on this device whose server-side delete has not been confirmed yet. */
  tombstones: Record<string, string>;
}

export interface LocalSnapshot extends LocalMeta {
  notes: Note[];
}

/** Where the sync engine keeps its offline copy. Implemented by IndexedDB and, in tests, by memory. */
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

const DB_VERSION = 1;

// One database per account, so signing in as someone else never shows their notes.
export async function openLocalStore(userId: string): Promise<LocalStore> {
  const db = await openDB<StillnoteDB>(`stillnote-${userId}`, DB_VERSION, {
    upgrade(database) {
      database.createObjectStore('notes', { keyPath: 'id' });
      database.createObjectStore('meta');
    },
  });
  await importFromLocalStorage(db, userId);

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

export function createMemoryStore(initial: Partial<LocalSnapshot> = {}): LocalStore & { snapshot(): LocalSnapshot } {
  const notes = new Map((initial.notes ?? []).map((note) => [note.id, note]));
  let meta: LocalMeta = { activeId: initial.activeId ?? null, tombstones: initial.tombstones ?? {} };
  return {
    async load() {
      return { notes: [...notes.values()], ...meta };
    },
    async putNote(note) {
      notes.set(note.id, note);
    },
    async deleteNote(id) {
      notes.delete(id);
    },
    async saveMeta(next) {
      meta = { activeId: next.activeId, tombstones: { ...next.tombstones } };
    },
    close() {},
    snapshot: () => ({ notes: [...notes.values()], ...meta }),
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isNote(value: unknown): value is Note {
  if (!isRecord(value)) return false;
  return typeof value.id === 'string' && typeof value.title === 'string' && (typeof value.content === 'string' || value.content === null);
}
