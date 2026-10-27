export interface User {
  id: string;
  email: string;
}

/** A note as the client holds it. `content` is null until the text has been downloaded. */
export interface Note {
  id: string;
  title: string;
  content: string | null;
  /** Server-provided preview, used while `content` is null. */
  snippet?: string;
  pinned: boolean;
  /** Last version the server confirmed; undefined for a note never uploaded. */
  version?: number;
  createdAt: string;
  updatedAt: string;
}

/** What `GET /api/documents` returns for each note. */
export interface RemoteSummary {
  id: string;
  title: string;
  snippet: string;
  pinned: boolean;
  version: number;
  createdAt: string;
  updatedAt: string;
}

export interface RemoteNote {
  id: string;
  title: string;
  content: string;
  pinned: boolean;
  version: number;
  createdAt: string;
  updatedAt: string;
}

export type NoteChanges = Partial<Pick<Note, 'title' | 'content' | 'pinned'>>;

export type SyncStatus = 'saving' | 'saved' | 'offline' | 'error';
