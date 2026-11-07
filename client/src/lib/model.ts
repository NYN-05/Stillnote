// The shared policy file is the single source of truth for the server sanitizer,
// the client paste guard, exports and tests.
import policy from '../../../shared/rich-text-policy.json';

export { policy };

export const CURRENT_SCHEMA_VERSION: number = policy.schemaVersion;
export const MAX_TITLE_LENGTH: number = policy.maxTitleLength;
export const DEFAULT_NOTE_TITLE: string = policy.defaultNoteTitle;

/** Generates note IDs in both secure and non-secure local development contexts. */
export function createId(): string {
  const browserCrypto = globalThis.crypto;
  if (typeof browserCrypto?.randomUUID === 'function') return browserCrypto.randomUUID();
  if (typeof browserCrypto?.getRandomValues === 'function') {
    const bytes = browserCrypto.getRandomValues(new Uint8Array(16));
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  }
  throw new Error('Secure browser randomness is unavailable. Use a modern browser to create notes.');
}

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
