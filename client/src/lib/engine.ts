import { ApiError, type NotesApi } from './api';
import type { LocalStore } from './db';
import { mergeNotes } from './merge';
import type { Note, NoteChanges, SyncStatus } from './types';

export interface EngineState {
  /** False until there is something to show: local notes, or the first server answer. */
  ready: boolean;
  /** True once the first attempt to reach the server has finished, whether it succeeded or the device is offline. */
  reconciled: boolean;
  notes: Note[];
  activeId: string | null;
  status: SyncStatus;
  lastSavedAt: string | null;
  connected: boolean;
  /** ID of a note whose text could not be downloaded. */
  contentErrorId: string | null;
}

export interface EngineOptions {
  api: NotesApi;
  store: LocalStore;
  notify?: (message: string) => void;
  saveDelayMs?: number;
  persistDelayMs?: number;
  retryIntervalMs?: number;
}

const MAX_TITLE_LENGTH = 120;

export function makeNote(partial: Partial<Note> = {}): Note {
  const now = new Date().toISOString();
  return {
    id: crypto.randomUUID(),
    title: 'Untitled note',
    content: '',
    pinned: false,
    createdAt: now,
    updatedAt: now,
    ...partial,
  };
}

/**
 * Offline-first note state. Every change is applied and saved on this device at once,
 * then uploaded in the background. The server is reconciled on start, whenever the
 * browser comes back online, and periodically while disconnected.
 */
export class SyncEngine {
  private state: EngineState = {
    ready: false,
    reconciled: false,
    notes: [],
    activeId: null,
    status: 'saving',
    lastSavedAt: null,
    connected: false,
    contentErrorId: null,
  };

  private readonly listeners = new Set<() => void>();
  private readonly api: NotesApi;
  private readonly store: LocalStore;
  private readonly notify: (message: string) => void;
  private readonly saveDelayMs: number;
  private readonly persistDelayMs: number;
  private readonly retryIntervalMs: number;

  private tombstones: Record<string, string> = {};
  private deletedThisSession = new Set<string>();
  private saveTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private persistTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private chains = new Map<string, Promise<void>>();
  private contentLoads = new Set<string>();
  private editCount = 0;
  private reconciling: Promise<void> | null = null;
  private retryTimer: ReturnType<typeof setInterval> | null = null;
  private started = false;

  constructor(options: EngineOptions) {
    this.api = options.api;
    this.store = options.store;
    this.notify = options.notify ?? (() => undefined);
    this.saveDelayMs = options.saveDelayMs ?? 650;
    this.persistDelayMs = options.persistDelayMs ?? 300;
    this.retryIntervalMs = options.retryIntervalMs ?? 20_000;
  }

  // ---- subscription (useSyncExternalStore) --------------------------------
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  getState = () => this.state;

  private setState(patch: Partial<EngineState>) {
    this.state = { ...this.state, ...patch };
    this.listeners.forEach((listener) => listener());
  }

  // ---- lifecycle ----------------------------------------------------------
  async start() {
    if (this.started) return;
    this.started = true;

    const local = await this.store.load();
    this.tombstones = { ...local.tombstones };
    const notes = sortNotes(local.notes.filter((note) => !(note.id in this.tombstones)));
    const activeId = local.activeId && notes.some((note) => note.id === local.activeId) ? local.activeId : (notes[0]?.id ?? null);
    // With notes on this device the editor opens at once; otherwise wait for the server.
    this.setState({ notes, activeId, ready: notes.length > 0, status: 'saving' });

    if (typeof window !== 'undefined') {
      window.addEventListener('online', this.handleOnline);
      window.addEventListener('pagehide', this.handlePageHide);
    }
    await this.reconcile();
    if (!this.started) return;
    this.retryTimer = setInterval(() => {
      if (!this.state.connected) void this.reconcile();
    }, this.retryIntervalMs);
  }

  stop() {
    this.started = false;
    if (this.retryTimer) clearInterval(this.retryTimer);
    this.retryTimer = null;
    if (typeof window !== 'undefined') {
      window.removeEventListener('online', this.handleOnline);
      window.removeEventListener('pagehide', this.handlePageHide);
    }
    this.saveTimers.forEach(clearTimeout);
    this.saveTimers.clear();
    void this.flushPersistence().finally(() => this.store.close());
  }

  private handleOnline = () => {
    void this.reconcile();
  };
  private handlePageHide = () => {
    void this.flushPersistence();
  };

  // ---- reading ------------------------------------------------------------
  get activeNote(): Note | null {
    return this.state.notes.find((note) => note.id === this.state.activeId) ?? null;
  }

  // ---- user actions -------------------------------------------------------
  edit(id: string, changes: NoteChanges) {
    const note = this.state.notes.find((item) => item.id === id);
    if (!note) return;
    // Text that has not been downloaded cannot be edited; title and pin can.
    if (note.content === null && 'content' in changes) return;
    const next: Note = {
      ...note,
      ...changes,
      title: changes.title === undefined ? note.title : changes.title.slice(0, MAX_TITLE_LENGTH),
      updatedAt: new Date().toISOString(),
    };
    this.editCount += 1;
    this.commit(
      this.state.notes.map((item) => (item.id === id ? next : item)),
      { deferPersist: 'content' in changes },
    );
    this.scheduleSync(id);
  }

  create(): Note {
    const note = makeNote();
    this.commit([note, ...this.state.notes], { activeId: note.id });
    this.scheduleSync(note.id);
    return note;
  }

  /** Deletes a note and returns the ID that should be shown next. */
  async remove(id: string): Promise<string | null> {
    this.deletedThisSession.add(id);
    this.clearTimer(this.saveTimers, id);
    const tombstones = { ...this.tombstones, [id]: new Date().toISOString() };
    let notes = this.state.notes.filter((note) => note.id !== id);
    let activeId = this.state.activeId === id ? null : this.state.activeId;
    let replacement: Note | null = null;
    if (notes.length === 0) {
      replacement = makeNote();
      notes = [replacement];
      activeId = replacement.id;
    } else if (!notes.some((note) => note.id === activeId)) {
      activeId = notes[0].id;
    }
    this.commit(notes, { activeId, tombstones });
    if (replacement) this.scheduleSync(replacement.id);

    try {
      await this.api.remove(id);
      this.dropTombstone(id);
      this.setState({ connected: true });
    } catch (error) {
      if (error instanceof ApiError && error.status === 404) this.dropTombstone(id);
      else this.setState({ connected: false, status: 'offline' });
    }
    return this.state.activeId;
  }

  select(id: string) {
    if (!this.state.notes.some((note) => note.id === id)) return;
    if (this.state.activeId !== id) this.commit(this.state.notes, { activeId: id });
    void this.loadContent(id);
  }

  async loadContent(id: string) {
    const target = this.state.notes.find((note) => note.id === id);
    if (!target || target.content !== null || this.contentLoads.has(id)) return;
    this.contentLoads.add(id);
    if (this.state.contentErrorId === id) this.setState({ contentErrorId: null });
    try {
      const full = await this.api.get(id);
      const current = this.state.notes.find((note) => note.id === id);
      if (current && current.content === null) {
        this.commit(this.state.notes.map((note) => (note.id === id ? { ...full } : note)));
      }
      this.setState({ connected: true });
    } catch (error) {
      if (error instanceof ApiError && error.status === 404) {
        // Deleted from another session: drop the placeholder.
        let notes = this.state.notes.filter((note) => note.id !== id);
        if (notes.length === 0) notes = [makeNote()];
        const activeId = notes.some((note) => note.id === this.state.activeId) ? this.state.activeId : notes[0].id;
        this.commit(notes, { activeId });
      } else {
        this.setState({ contentErrorId: id });
        if (error instanceof ApiError && error.isNetwork) this.setState({ connected: false });
      }
    } finally {
      this.contentLoads.delete(id);
    }
  }

  /** Uploads everything pending right now (Ctrl+S, tests). */
  async flush() {
    const ids = [...this.saveTimers.keys()];
    ids.forEach((id) => this.clearTimer(this.saveTimers, id));
    await Promise.all(ids.map((id) => this.runSync(id)));
    await this.flushPersistence();
  }

  /** Saves the open note's changes to the server immediately. */
  saveNow(id: string) {
    this.clearTimer(this.saveTimers, id);
    this.setState({ status: 'saving' });
    return this.runSync(id);
  }

  // ---- reconcile with the server -------------------------------------------
  reconcile(): Promise<void> {
    this.reconciling ??= this.doReconcile().finally(() => {
      this.reconciling = null;
    });
    return this.reconciling;
  }

  private async doReconcile() {
    this.setState({ status: 'saving' });
    let remote;
    try {
      remote = await this.api.list();
    } catch {
      this.setState({ connected: false, status: 'offline', ready: true, reconciled: true });
      if (this.state.notes.length === 0) this.commit([makeNote()], { activeId: null, autoActive: true });
      return;
    }

    const tombstones = { ...this.tombstones };
    const tombstoneIds = new Set(Object.keys(tombstones));
    tombstoneIds.forEach((id) => this.deletedThisSession.add(id));
    let failed = false;
    for (const id of tombstoneIds) {
      try {
        await this.api.remove(id);
        delete tombstones[id];
      } catch (error) {
        if (error instanceof ApiError && error.status === 404) delete tombstones[id];
        else failed = true;
      }
    }

    const { notes: merged, needsSync } = mergeNotes(this.state.notes, remote, tombstoneIds);
    let notes = merged;
    if (notes.length === 0) {
      const blank = makeNote();
      notes = [blank];
      needsSync.push(blank);
    }
    const activeId = notes.some((note) => note.id === this.state.activeId) ? this.state.activeId : notes[0].id;
    this.commit(notes, { activeId, tombstones });
    this.setState({ ready: true, reconciled: true });

    const editsAtStart = this.editCount;
    const results = await Promise.allSettled(needsSync.map((note) => this.synchronize(note.id)));
    if (results.some((result) => result.status === 'rejected')) failed = true;

    this.setState({ connected: !failed });
    if (failed) this.setState({ status: 'offline' });
    else if (this.editCount === editsAtStart) this.setState({ status: 'saved', lastSavedAt: new Date().toISOString() });
  }

  // ---- uploading ----------------------------------------------------------
  private scheduleSync(id: string) {
    this.clearTimer(this.saveTimers, id);
    this.setState({ status: 'saving' });
    this.saveTimers.set(
      id,
      setTimeout(() => {
        this.saveTimers.delete(id);
        void this.runSync(id);
      }, this.saveDelayMs),
    );
  }

  private async runSync(id: string) {
    try {
      await this.synchronize(id);
      if (this.saveTimers.size === 0 && this.chains.size === 0) {
        this.setState({ status: 'saved', connected: true, lastSavedAt: new Date().toISOString() });
      }
    } catch (error) {
      this.setState({ status: error instanceof ApiError && error.status > 0 ? 'error' : 'offline', connected: false });
    }
  }

  // Uploads for one note run strictly in turn, so each sees the version the previous returned.
  private synchronize(id: string): Promise<void> {
    const previous = this.chains.get(id) ?? Promise.resolve();
    const run = previous.catch(() => undefined).then(() => this.push(id));
    this.chains.set(id, run);
    const release = () => {
      if (this.chains.get(id) === run) this.chains.delete(id);
    };
    run.then(release, release);
    return run;
  }

  private async push(id: string) {
    // Always send the newest local state, so queued saves collapse into one request.
    const note = this.state.notes.find((item) => item.id === id);
    if (!note) return;
    const body: Record<string, unknown> = {
      title: note.title,
      pinned: note.pinned,
      updatedAt: note.updatedAt,
      ...(note.content !== null ? { content: note.content } : {}),
      ...(Number.isInteger(note.version) ? { version: note.version } : {}),
    };

    // A note the server has never seen is created directly, saving a request that would 404.
    if (note.version === undefined && note.content !== null) {
      try {
        this.recordVersion(id, (await this.api.create(note as unknown as Record<string, unknown>)).version);
        return;
      } catch (error) {
        if (!(error instanceof ApiError && error.status === 409 && error.code === 'DOCUMENT_EXISTS')) throw error;
        // It exists after all (e.g. an earlier create whose reply was lost): update it instead.
      }
    }

    try {
      this.recordVersion(id, (await this.api.update(id, body)).version);
    } catch (error) {
      if (!(error instanceof ApiError)) throw error;
      if (error.status === 404) {
        // A pending save must never recreate a note the user has deleted.
        if (this.deletedThisSession.has(id) || id in this.tombstones) return;
        if (note.content === null) return;
        this.recordVersion(id, (await this.api.create(note as unknown as Record<string, unknown>)).version);
      } else if (error.status === 409 && error.code === 'VERSION_CONFLICT' && error.details?.current) {
        const remote = error.details.current;
        // Another session saved first. The newer edit wins by timestamp, but never silently.
        if ((Date.parse(note.updatedAt) || 0) > (Date.parse(remote.updatedAt) || 0)) {
          this.recordVersion(id, (await this.api.update(id, { ...body, version: remote.version })).version);
        } else {
          this.commit(this.state.notes.map((item) => (item.id === id ? { ...remote } : item)));
          this.notify('This note was updated from another session');
        }
      } else {
        throw error;
      }
    }
  }

  // Records the server's version without touching text or timestamp, so it cannot
  // overwrite anything typed while the request was in flight.
  private recordVersion(id: string, version: number | undefined) {
    if (!Number.isInteger(version)) return;
    const note = this.state.notes.find((item) => item.id === id);
    if (!note || note.version === version) return;
    this.commit(this.state.notes.map((item) => (item.id === id ? { ...item, version } : item)));
  }

  // ---- state + persistence ------------------------------------------------
  private commit(
    next: Note[],
    options: { activeId?: string | null; tombstones?: Record<string, string>; deferPersist?: boolean; autoActive?: boolean } = {},
  ) {
    const previous = new Map(this.state.notes.map((note) => [note.id, note]));
    const nextIds = new Set(next.map((note) => note.id));
    const activeId = options.autoActive ? (next[0]?.id ?? null) : options.activeId === undefined ? this.state.activeId : options.activeId;
    const metaChanged = activeId !== this.state.activeId || options.tombstones !== undefined;
    if (options.tombstones) this.tombstones = options.tombstones;

    this.setState({ notes: sortNotes(next), activeId });

    for (const note of next) {
      if (previous.get(note.id) === note) continue;
      if (options.deferPersist) this.persistLater(note.id);
      else this.persistNow(note);
    }
    for (const id of previous.keys()) {
      if (!nextIds.has(id)) {
        this.clearTimer(this.persistTimers, id);
        void this.store.deleteNote(id).catch(warn);
      }
    }
    if (metaChanged) this.persistMeta();
  }

  private persistNow(note: Note) {
    this.clearTimer(this.persistTimers, note.id);
    void this.store.putNote(note).catch(warn);
  }

  // Typing rewrites the whole note on every keystroke; batch those writes.
  private persistLater(id: string) {
    this.clearTimer(this.persistTimers, id);
    this.persistTimers.set(
      id,
      setTimeout(() => {
        this.persistTimers.delete(id);
        const note = this.state.notes.find((item) => item.id === id);
        if (note) void this.store.putNote(note).catch(warn);
      }, this.persistDelayMs),
    );
  }

  private persistMeta() {
    void this.store.saveMeta({ activeId: this.state.activeId, tombstones: this.tombstones }).catch(warn);
  }

  private async flushPersistence() {
    const ids = [...this.persistTimers.keys()];
    ids.forEach((id) => this.clearTimer(this.persistTimers, id));
    await Promise.all(
      ids.map((id) => {
        const note = this.state.notes.find((item) => item.id === id);
        return note ? this.store.putNote(note).catch(warn) : undefined;
      }),
    );
  }

  private dropTombstone(id: string) {
    const { [id]: _removed, ...rest } = this.tombstones;
    this.tombstones = rest;
    this.persistMeta();
  }

  private clearTimer(timers: Map<string, ReturnType<typeof setTimeout>>, id: string) {
    const timer = timers.get(id);
    if (timer) clearTimeout(timer);
    timers.delete(id);
  }
}

function sortNotes(notes: Note[]): Note[] {
  return [...notes].sort((a, b) => (Date.parse(b.updatedAt) || 0) - (Date.parse(a.updatedAt) || 0));
}

function warn(error: unknown) {
  console.warn('Stillnote could not save to this device:', error);
}
