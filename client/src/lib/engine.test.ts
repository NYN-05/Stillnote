import { describe, expect, it, vi } from 'vitest';
import { ApiError, type NotesApi } from './api';
import type { LocalMeta, LocalSnapshot, LocalStore } from './db';
import { SyncEngine, makeNote, mergeNotes } from './engine';
import type { Note, RemoteNote, RemoteSummary } from './model';

/** An in-memory server with the real API's versioning and error behaviour. */
function fakeServer(initial: RemoteNote[] = []) {
  const notes = new Map(initial.map((note) => [note.id, { ...note }]));
  const deleted = new Set<string>();
  const calls: string[] = [];
  let offline = false;

  const guard = () => {
    if (offline) throw new ApiError('offline', 0, 'NETWORK_ERROR');
  };
  const api: NotesApi = {
    async list() {
      guard();
      calls.push('list');
      return [...notes.values()].map(({ content, ...summary }): RemoteSummary => ({ ...summary, snippet: content.slice(0, 200) }));
    },
    async get(id) {
      guard();
      const note = notes.get(id);
      if (!note) throw new ApiError('missing', 404, 'DOCUMENT_NOT_FOUND');
      return { ...note };
    },
    async create(body) {
      guard();
      calls.push(`create:${body.id}`);
      const id = body.id as string;
      if (notes.has(id) || deleted.has(id)) throw new ApiError('exists', 409, 'DOCUMENT_EXISTS');
      const note: RemoteNote = {
        id,
        title: body.title as string,
        content: (body.content as string) ?? '',
        pinned: Boolean(body.pinned),
        version: 1,
        createdAt: body.createdAt as string,
        updatedAt: body.updatedAt as string,
      };
      notes.set(id, note);
      return { ...note };
    },
    async update(id, body) {
      guard();
      calls.push(`update:${id}:v${body.version ?? '-'}`);
      const note = notes.get(id);
      if (!note) throw new ApiError('missing', 404, 'DOCUMENT_NOT_FOUND');
      if (body.version !== undefined && body.version !== note.version) {
        throw new ApiError('conflict', 409, 'VERSION_CONFLICT', { current: { ...note } });
      }
      Object.assign(note, {
        ...(body.title !== undefined && { title: body.title }),
        ...(body.content !== undefined && { content: body.content }),
        ...(body.pinned !== undefined && { pinned: body.pinned }),
        updatedAt: body.updatedAt as string,
        version: note.version + 1,
      });
      return { ...note };
    },
    async remove(id) {
      guard();
      calls.push(`remove:${id}`);
      if (!notes.delete(id)) throw new ApiError('missing', 404, 'DOCUMENT_NOT_FOUND');
      deleted.add(id);
      return null;
    },
  };
  return {
    api,
    notes,
    calls,
    setOffline: (value: boolean) => {
      offline = value;
    },
  };
}

/** An in-memory LocalStore, so engine tests do not need IndexedDB. */
function createMemoryStore(initial: Partial<LocalSnapshot> = {}): LocalStore & { snapshot(): LocalSnapshot } {
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

const remoteNote = (id: string, content: string, updatedAt: string, extra: Partial<RemoteNote> = {}): RemoteNote => ({
  id,
  title: id,
  content,
  pinned: false,
  version: 1,
  createdAt: updatedAt,
  updatedAt,
  ...extra,
});

const localNote = (id: string, content: string | null, updatedAt: string, extra: Partial<Note> = {}): Note => ({
  id,
  title: id,
  content,
  pinned: false,
  createdAt: updatedAt,
  updatedAt,
  ...extra,
});

interface Timing {
  saveDelayMs?: number;
  maxSaveDelayMs?: number;
  persistDelayMs?: number;
  maxPersistDelayMs?: number;
}

async function startEngine(
  server: ReturnType<typeof fakeServer>,
  local: Partial<Parameters<typeof createMemoryStore>[0]> = {},
  timing: Timing = {},
) {
  const store = createMemoryStore(local);
  const notify = vi.fn();
  const engine = new SyncEngine({
    api: server.api,
    store,
    notify,
    saveDelayMs: timing.saveDelayMs ?? 5,
    maxSaveDelayMs: timing.maxSaveDelayMs ?? 5_000,
    persistDelayMs: timing.persistDelayMs ?? 5,
    maxPersistDelayMs: timing.maxPersistDelayMs ?? 1_000,
    retryIntervalMs: 1_000_000,
  });
  await engine.start();
  return { engine, store, notify };
}

const T1 = '2026-01-01T00:00:00.000Z';
const T2 = '2026-02-01T00:00:00.000Z';
const T3 = '2026-03-01T00:00:00.000Z';

describe('mergeNotes', () => {
  it('shows server notes as not-yet-downloaded placeholders', () => {
    const summary: RemoteSummary = { id: 'a', title: 'A', snippet: 'hi', pinned: false, version: 3, createdAt: T1, updatedAt: T1 };
    const { notes, needsSync } = mergeNotes([], [summary], new Set());
    expect(notes).toEqual([{ ...summary, content: null }]);
    expect(needsSync).toEqual([]);
  });

  it('keeps a newer local edit, adopts the server version, and queues an upload', () => {
    const summary: RemoteSummary = { id: 'a', title: 'A', snippet: '', pinned: false, version: 4, createdAt: T1, updatedAt: T1 };
    const { notes, needsSync } = mergeNotes([localNote('a', 'mine', T2, { version: 2 })], [summary], new Set());
    expect(notes[0]).toMatchObject({ content: 'mine', version: 4 });
    expect(needsSync).toHaveLength(1);
  });

  it('replaces an older local copy and keeps an identical one', () => {
    const newer: RemoteSummary = { id: 'a', title: 'A2', snippet: 's', pinned: false, version: 5, createdAt: T1, updatedAt: T3 };
    expect(mergeNotes([localNote('a', 'old', T1, { version: 1 })], [newer], new Set()).notes[0]).toMatchObject({
      content: null,
      title: 'A2',
    });
    const same: RemoteSummary = { ...newer, version: 1, updatedAt: T1 };
    expect(mergeNotes([localNote('a', 'text', T1, { version: 1 })], [same], new Set()).notes[0].content).toBe('text');
  });

  it('drops placeholders the server no longer has, but uploads real local notes', () => {
    const { notes, needsSync } = mergeNotes([localNote('gone', null, T1), localNote('new', 'text', T1)], [], new Set());
    expect(notes.map((note) => note.id)).toEqual(['new']);
    expect(needsSync.map((note) => note.id)).toEqual(['new']);
  });

  it('never resurrects tombstoned notes from either side', () => {
    const summary: RemoteSummary = { id: 'x', title: 'X', snippet: '', pinned: false, version: 1, createdAt: T1, updatedAt: T1 };
    const { notes } = mergeNotes([localNote('x', 'text', T2)], [summary], new Set(['x']));
    expect(notes).toEqual([]);
  });

  it('never lets legacy Markdown overwrite converted server HTML, even when its timestamp is newer', () => {
    const summary: RemoteSummary = {
      id: 'a',
      title: 'A',
      snippet: '',
      contentFormat: 'html',
      contentSchemaVersion: 1,
      pinned: false,
      version: 4,
      createdAt: T1,
      updatedAt: T1,
    };
    const local = localNote('a', '# Old', T3, { version: 3, contentFormat: 'markdown', contentSchemaVersion: 1 });
    const { notes, needsSync, conflicts } = mergeNotes([local], [summary], new Set());
    expect(notes[0]).toMatchObject({ content: null, version: 4, contentFormat: 'html' });
    expect(needsSync).toEqual([]);
    expect(conflicts).toEqual([]);
  });

  it('keeps the open note’s legacy text on screen and reports a conflict instead of replacing it', () => {
    const summary: RemoteSummary = {
      id: 'a',
      title: 'A',
      snippet: '',
      contentFormat: 'html',
      contentSchemaVersion: 1,
      pinned: false,
      version: 4,
      createdAt: T1,
      updatedAt: T1,
    };
    const local = localNote('a', '# Old', T3, { version: 3, contentFormat: 'markdown', contentSchemaVersion: 1 });
    const { notes, conflicts } = mergeNotes([local], [summary], new Set(), 'a');
    expect(notes[0]).toMatchObject({ content: '# Old', version: 3 });
    expect(conflicts).toEqual([{ id: 'a', remote: summary }]);
  });
});

describe('SyncEngine', () => {
  it('reports the first server sync as done so a deep link can wait for it', async () => {
    const server = fakeServer([remoteNote('linked', 'only on the server', T2)]);
    const store = createMemoryStore({ notes: [localNote('a', 'here already', T1)] });
    const engine = new SyncEngine({ api: server.api, store, saveDelayMs: 5, persistDelayMs: 5, retryIntervalMs: 1_000_000 });
    expect(engine.getState().reconciled).toBe(false);
    await engine.start();
    expect(engine.getState().reconciled).toBe(true);
    expect(engine.getState().notes.map((note) => note.id)).toContain('linked');

    const offline = fakeServer();
    offline.setOffline(true);
    const { engine: offlineEngine } = await startEngine(offline, { notes: [localNote('b', 'x', T1)] });
    expect(offlineEngine.getState().reconciled).toBe(true);
  });

  it('opens immediately from local notes even when the server is down', async () => {
    const server = fakeServer();
    server.setOffline(true);
    const { engine } = await startEngine(server, { notes: [localNote('a', 'saved offline', T1)] });
    const state = engine.getState();
    expect(state.ready).toBe(true);
    expect(state.status).toBe('offline');
    expect(state.connected).toBe(false);
    expect(state.notes[0].content).toBe('saved offline');
  });

  it('creates a first note when both the device and the server are empty', async () => {
    const server = fakeServer();
    const { engine } = await startEngine(server);
    const state = engine.getState();
    expect(state.notes).toHaveLength(1);
    expect(state.activeId).toBe(state.notes[0].id);
    expect(server.notes.size).toBe(1);
  });

  it('uploads an edit, records the version, and persists locally', async () => {
    const server = fakeServer([remoteNote('a', 'one', T1)]);
    const { engine, store } = await startEngine(server);
    await engine.loadContent('a');
    engine.edit('a', { content: 'two' });
    expect(engine.getState().status).toBe('saving');
    await engine.flush();
    expect(server.notes.get('a')?.content).toBe('two');
    expect(engine.getState().notes[0]).toMatchObject({ content: 'two', version: 2 });
    expect(engine.getState().status).toBe('saved');
    expect(store.snapshot().notes[0].content).toBe('two');
  });

  it('sends saves for one note in order while typing continues, each with the previous version', async () => {
    const server = fakeServer([remoteNote('a', 'one', T1)]);
    const { engine } = await startEngine(server);
    await engine.loadContent('a');

    const originalUpdate = server.api.update;
    let releaseFirst!: () => void;
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    let requests = 0;
    server.api.update = async (id, body) => {
      requests += 1;
      if (requests === 1) {
        markStarted();
        await new Promise<void>((resolve) => {
          releaseFirst = resolve;
        });
      }
      return originalUpdate(id, body);
    };

    engine.edit('a', { content: 'two' });
    const first = engine.saveNow('a');
    await started;
    engine.edit('a', { content: 'three' });
    const second = engine.saveNow('a');
    releaseFirst();
    await Promise.all([first, second]);
    expect(server.notes.get('a')).toMatchObject({ content: 'three', version: 3 });
    expect(server.calls.filter((call) => call.startsWith('update'))).toEqual(['update:a:v1', 'update:a:v2']);
  });

  it('does not upload the same unchanged note twice', async () => {
    const server = fakeServer([remoteNote('a', 'one', T1)]);
    const { engine } = await startEngine(server);
    await engine.loadContent('a');
    engine.edit('a', { content: 'two' });
    await Promise.all([engine.saveNow('a'), engine.saveNow('a')]);
    expect(server.calls.filter((call) => call.startsWith('update'))).toEqual(['update:a:v1']);
    expect(server.notes.get('a')).toMatchObject({ content: 'two', version: 2 });
  });

  it('uploads periodically while typing continues instead of waiting for a pause', async () => {
    vi.useFakeTimers();
    try {
      const server = fakeServer([remoteNote('a', 'one', T1)]);
      const { engine } = await startEngine(server, {}, { saveDelayMs: 100, maxSaveDelayMs: 250 });
      await engine.loadContent('a');
      let draft = 0;
      for (let elapsed = 0; elapsed < 400; elapsed += 40) {
        engine.edit('a', { content: `draft ${++draft}` });
        await vi.advanceTimersByTimeAsync(40);
      }
      expect(server.calls.some((call) => call.startsWith('update'))).toBe(true);
      await engine.flush();
      expect(server.notes.get('a')?.content).toBe(`draft ${draft}`);
      engine.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('writes continuous edits to local storage without waiting for a pause', async () => {
    vi.useFakeTimers();
    try {
      const server = fakeServer([remoteNote('a', 'one', T1)]);
      const { engine, store } = await startEngine(server, {}, { persistDelayMs: 100, maxPersistDelayMs: 250 });
      await engine.loadContent('a');
      let draft = 0;
      for (let elapsed = 0; elapsed < 300; elapsed += 40) {
        engine.edit('a', { content: `draft ${++draft}` });
        await vi.advanceTimersByTimeAsync(40);
      }
      expect(store.snapshot().notes.find((note) => note.id === 'a')?.content).toBe(`draft ${draft}`);
      engine.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('persists and uploads immediately when switching notes', async () => {
    const server = fakeServer([remoteNote('a', 'one', T1), remoteNote('b', 'two', T2)]);
    const { engine, store } = await startEngine(
      server,
      {},
      { saveDelayMs: 5_000, maxSaveDelayMs: 5_000, persistDelayMs: 5_000, maxPersistDelayMs: 5_000 },
    );
    await engine.loadContent('a');
    engine.edit('a', { content: 'edited before switching' });
    engine.select('b');
    await engine.flush();
    expect(server.notes.get('a')?.content).toBe('edited before switching');
    expect(store.snapshot().notes.find((note) => note.id === 'a')?.content).toBe('edited before switching');
  });

  it('creates a never-uploaded note directly, without a failing update first', async () => {
    const server = fakeServer();
    const { engine } = await startEngine(server);
    const note = engine.create();
    await engine.flush();
    expect(server.calls.filter((call) => call.includes(note.id))).toEqual([`create:${note.id}`]);
    expect(engine.getState().notes.find((item) => item.id === note.id)?.version).toBe(1);
  });

  it('falls back to updating when the create finds the note already exists', async () => {
    const server = fakeServer([remoteNote('a', 'on server', T1)]);
    const { engine } = await startEngine(server, { notes: [localNote('a', 'local', T2)] });
    await engine.flush();
    expect(server.notes.get('a')?.content).toBe('local');
  });

  it('creates the note on the server when an update finds nothing (404)', async () => {
    const server = fakeServer();
    const { engine } = await startEngine(server, { notes: [localNote('a', 'offline draft', T1)] });
    await engine.flush();
    expect(server.notes.get('a')?.content).toBe('offline draft');
  });

  it('on a version conflict in a background note, a newer local edit wins and is re-sent', async () => {
    const server = fakeServer([remoteNote('a', 'one', T1), remoteNote('b', 'two', T1)]);
    const { engine } = await startEngine(server);
    await engine.loadContent('a');
    engine.select('b'); // `a` is no longer the open note
    server.notes.get('a')!.version = 7; // another session saved in between
    server.notes.get('a')!.updatedAt = T1;
    engine.edit('a', { content: 'mine' });
    await engine.flush();
    expect(server.notes.get('a')).toMatchObject({ content: 'mine', version: 8 });
  });

  it('pauses an open note’s conflict even when the local timestamp is newer', async () => {
    const server = fakeServer([remoteNote('a', 'one', T1)]);
    const { engine } = await startEngine(server);
    await engine.loadContent('a');
    Object.assign(server.notes.get('a')!, { content: 'theirs', version: 9, updatedAt: T1 });
    engine.edit('a', { content: 'mine' });
    await engine.flush();
    expect(engine.getState().conflict).toMatchObject({ noteId: 'a', remoteVersion: 9 });
    expect(server.notes.get('a')).toMatchObject({ content: 'theirs', version: 9 });
  });

  it('on a version conflict in the open note, keeps the local text and pauses autosave until the user chooses', async () => {
    const server = fakeServer([remoteNote('a', 'one', T1)]);
    const { engine, notify } = await startEngine(server);
    await engine.loadContent('a');
    engine.edit('a', { content: 'mine' });
    Object.assign(server.notes.get('a')!, { content: 'theirs', version: 9, updatedAt: '2999-01-01T00:00:00.000Z' });
    await engine.flush();

    const state = engine.getState();
    expect(state.notes[0]).toMatchObject({ content: 'mine' });
    expect(state.conflict).toMatchObject({
      noteId: 'a',
      remoteVersion: 9,
      remote: { content: 'theirs', version: 9 },
    });
    expect(notify).toHaveBeenCalledWith('This note was updated in another session');

    // Further edits stay local: autosave must not overwrite the other version.
    engine.edit('a', { content: 'mine again' });
    await engine.saveNow('a');
    expect(server.notes.get('a')).toMatchObject({ content: 'theirs', version: 9 });

    await engine.reloadConflict('a');
    expect(engine.getState().notes[0]).toMatchObject({ content: 'theirs', version: 9 });
    expect(engine.getState().conflict).toBeNull();
  });

  it('can keep the local text after a conflict, replacing the other version explicitly', async () => {
    const server = fakeServer([remoteNote('a', 'one', T1)]);
    const { engine } = await startEngine(server);
    await engine.loadContent('a');
    engine.edit('a', { content: 'mine' });
    Object.assign(server.notes.get('a')!, { content: 'theirs', version: 9, updatedAt: '2999-01-01T00:00:00.000Z' });
    await engine.flush();
    expect(engine.getState().conflict).not.toBeNull();

    await engine.keepLocalConflict('a');
    expect(server.notes.get('a')).toMatchObject({ content: 'mine', version: 10 });
    expect(engine.getState().conflict).toBeNull();
    expect(engine.getState().notes[0]).toMatchObject({ content: 'mine', version: 10 });
  });

  it('refuses to edit the text of a note that has not been downloaded, but allows pinning', async () => {
    const server = fakeServer([remoteNote('a', 'remote text', T1)]);
    const { engine } = await startEngine(server);
    expect(engine.getState().notes[0].content).toBeNull();
    engine.edit('a', { content: 'clobber' });
    expect(engine.getState().notes[0].content).toBeNull();
    engine.edit('a', { pinned: true });
    await engine.flush();
    expect(server.notes.get('a')).toMatchObject({ pinned: true, content: 'remote text' });
  });

  it('downloads text on demand and reports failures without losing the placeholder', async () => {
    const server = fakeServer([remoteNote('a', 'remote text', T1)]);
    const { engine } = await startEngine(server);
    server.setOffline(true);
    await engine.loadContent('a');
    expect(engine.getState().contentErrorId).toBe('a');
    expect(engine.getState().notes[0].content).toBeNull();
    server.setOffline(false);
    await engine.loadContent('a');
    expect(engine.getState()).toMatchObject({ contentErrorId: null });
    expect(engine.getState().notes[0].content).toBe('remote text');
  });

  it('deletes remotely, and keeps a tombstone while offline so the note cannot come back', async () => {
    const server = fakeServer([remoteNote('a', 'one', T1), remoteNote('b', 'two', T2)]);
    const { engine, store } = await startEngine(server);
    server.setOffline(true);
    const next = await engine.remove('a');
    expect(next).toBe('b');
    expect(Object.keys(store.snapshot().tombstones)).toEqual(['a']);
    expect(server.notes.has('a')).toBe(true);

    server.setOffline(false);
    await engine.reconcile();
    expect(server.notes.has('a')).toBe(false);
    expect(engine.getState().notes.map((note) => note.id)).toEqual(['b']);
    expect(store.snapshot().tombstones).toEqual({});
  });

  it('does not recreate a note whose save was still pending when it was deleted', async () => {
    const server = fakeServer([remoteNote('a', 'one', T1), remoteNote('b', 'two', T2)]);
    const { engine } = await startEngine(server);
    await engine.loadContent('a');
    engine.edit('a', { content: 'edited then deleted' });
    await engine.remove('a');
    await engine.flush();
    expect(server.notes.has('a')).toBe(false);
    expect(server.calls.some((call) => call === 'create:a')).toBe(false);
  });

  it('replaces the last deleted note with a fresh blank one', async () => {
    const server = fakeServer([remoteNote('a', 'one', T1)]);
    const { engine } = await startEngine(server);
    const next = await engine.remove('a');
    const state = engine.getState();
    expect(state.notes).toHaveLength(1);
    expect(next).toBe(state.notes[0].id);
    expect(state.notes[0].id).not.toBe('a');
  });

  it('uploads offline edits when the connection returns', async () => {
    const server = fakeServer([remoteNote('a', 'one', T1)]);
    const { engine, store } = await startEngine(server);
    await engine.loadContent('a');
    server.setOffline(true);
    engine.edit('a', { content: 'written offline' });
    await engine.flush();
    expect(engine.getState().status).toBe('offline');
    expect(store.snapshot().notes.find((note) => note.id === 'a')?.content).toBe('written offline');
    server.setOffline(false);
    await engine.reconcile();
    expect(server.notes.get('a')?.content).toBe('written offline');
    expect(engine.getState().status).toBe('saved');
  });

  it('makeNote produces unique ids', () => {
    expect(makeNote().id).not.toBe(makeNote().id);
  });
});
