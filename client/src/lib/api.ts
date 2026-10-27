import type { RemoteNote, RemoteSummary, User } from './types';

const API_BASE = (import.meta.env.VITE_API_URL || '').replace(/\/$/, '');
const PAGE_SIZE = 200;

export class ApiError extends Error {
  constructor(
    message: string,
    public readonly status = 0,
    public readonly code = 'API_ERROR',
    public readonly details?: { current?: RemoteNote },
  ) {
    super(message);
    this.name = 'ApiError';
  }

  /** True when the server could not be reached at all. */
  get isNetwork() {
    return this.status === 0;
  }
}

let unauthorizedHandler: (() => void) | null = null;

/** Called when a request that needed a session gets a 401, e.g. the session expired. */
export function setUnauthorizedHandler(handler: (() => void) | null) {
  unauthorizedHandler = handler;
}

interface RequestOptions extends Omit<RequestInit, 'body'> {
  json?: unknown;
  skipUnauthorizedHandler?: boolean;
}

async function request<T>(path: string, { json, skipUnauthorizedHandler, ...init }: RequestOptions = {}): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${API_BASE}${path}`, {
      credentials: 'include',
      ...init,
      headers: {
        Accept: 'application/json',
        ...(json !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...init.headers,
      },
      body: json !== undefined ? JSON.stringify(json) : undefined,
    });
  } catch {
    throw new ApiError('The server is unreachable. Your changes are saved on this device.', 0, 'NETWORK_ERROR');
  }

  if (response.status === 204) return null as T;
  const isJson = (response.headers.get('content-type') || '').includes('application/json');
  const payload = isJson ? await response.json().catch(() => ({})) : {};

  if (!response.ok) {
    if (response.status === 401 && !skipUnauthorizedHandler) unauthorizedHandler?.();
    throw new ApiError(
      payload.error?.message || `Request failed with status ${response.status}.`,
      response.status,
      payload.error?.code || 'HTTP_ERROR',
      payload.error?.details,
    );
  }
  return payload as T;
}

/** Note summaries (no content), following the server's cursor to the end. */
export async function listNotes(): Promise<RemoteSummary[]> {
  const notes: RemoteSummary[] = [];
  let cursor: string | null = null;
  do {
    const query = new URLSearchParams({ limit: String(PAGE_SIZE) });
    if (cursor) query.set('cursor', cursor);
    const page: { documents?: RemoteSummary[]; nextCursor?: string | null } = await request(`/api/documents?${query}`);
    if (Array.isArray(page.documents)) notes.push(...page.documents);
    cursor = page.nextCursor || null;
  } while (cursor);
  return notes;
}

export const getNote = async (id: string) => (await request<{ document: RemoteNote }>(`/api/documents/${encodeURIComponent(id)}`)).document;

export const createNote = async (note: Record<string, unknown>) =>
  (await request<{ document: RemoteNote }>('/api/documents', { method: 'POST', json: note })).document;

export const updateNote = async (id: string, changes: Record<string, unknown>) =>
  (await request<{ document: RemoteNote }>(`/api/documents/${encodeURIComponent(id)}`, { method: 'PUT', json: changes })).document;

export const deleteNote = (id: string) => request<null>(`/api/documents/${encodeURIComponent(id)}`, { method: 'DELETE' });

export const getCurrentUser = async () => (await request<{ user: User }>('/api/auth/me', { skipUnauthorizedHandler: true })).user;

export const signIn = async (email: string, password: string) =>
  (await request<{ user: User }>('/api/auth/login', { method: 'POST', json: { email, password }, skipUnauthorizedHandler: true })).user;

export const register = async (email: string, password: string) =>
  (await request<{ user: User }>('/api/auth/register', { method: 'POST', json: { email, password }, skipUnauthorizedHandler: true })).user;

export const signOut = () => request<null>('/api/auth/logout', { method: 'POST', skipUnauthorizedHandler: true });

/** The surface the sync engine needs; tests substitute an in-memory fake. */
export interface NotesApi {
  list: typeof listNotes;
  get: typeof getNote;
  create: typeof createNote;
  update: typeof updateNote;
  remove: typeof deleteNote;
}

export const notesApi: NotesApi = {
  list: listNotes,
  get: getNote,
  create: createNote,
  update: updateNote,
  remove: deleteNote,
};
