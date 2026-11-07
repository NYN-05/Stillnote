// The shared policy file is the single source of truth for the server sanitizer,
// the client paste guard, exports and tests.
import policy from '../../../shared/rich-text-policy.json';

export { policy };

export const CURRENT_SCHEMA_VERSION: number = policy.schemaVersion;
export const MAX_TITLE_LENGTH: number = policy.maxTitleLength;
export const DEFAULT_NOTE_TITLE: string = policy.defaultNoteTitle;

export type ContentFormat = 'html' | 'markdown';

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
  /**
   * How `content` is encoded. Older local records omit it, which is legacy
   * Markdown; the IndexedDB migration upgrades them in place.
   */
  contentFormat?: ContentFormat;
  contentSchemaVersion?: number;
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
  contentFormat?: ContentFormat;
  contentSchemaVersion?: number;
  pinned: boolean;
  version: number;
  createdAt: string;
  updatedAt: string;
}

export interface RemoteNote {
  id: string;
  title: string;
  content: string;
  contentFormat?: ContentFormat;
  contentSchemaVersion?: number;
  pinned: boolean;
  version: number;
  createdAt: string;
  updatedAt: string;
}

export type NoteChanges = Partial<Pick<Note, 'title' | 'content' | 'pinned'>>;

export type SyncStatus = 'saving' | 'saved' | 'offline' | 'error';
