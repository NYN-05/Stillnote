import type { Note, RemoteSummary } from './types';

const time = (value: string | undefined) => Date.parse(value ?? '') || 0;

export interface MergeResult {
  notes: Note[];
  /** Local notes the server is missing or has an older copy of. */
  needsSync: Note[];
}

/**
 * Merges the server's note summaries into the local notes.
 *
 * Summaries carry no text, so a note whose content is `null` is "known but not
 * downloaded". A local copy survives only if it is newer than the server's, or is the
 * same version with its text already here. Otherwise the server's summary replaces it
 * and the text is fetched again on demand. Newer local edits inherit the server's
 * version so the conditional upload can succeed.
 */
export function mergeNotes(local: Note[], remote: RemoteSummary[], tombstones: ReadonlySet<string>): MergeResult {
  const remoteById = new Map(remote.filter((summary) => !tombstones.has(summary.id)).map((summary) => [summary.id, summary]));
  const merged = new Map<string, Note>();
  const needsSync: Note[] = [];

  for (const summary of remoteById.values()) {
    merged.set(summary.id, { ...summary, content: null });
  }

  for (const note of local) {
    if (tombstones.has(note.id)) continue;
    const summary = remoteById.get(note.id);

    if (!summary) {
      // A placeholder the server no longer has was deleted elsewhere; real text is uploaded.
      if (note.content !== null) {
        merged.set(note.id, note);
        needsSync.push(note);
      }
    } else if (time(note.updatedAt) > time(summary.updatedAt)) {
      const next = { ...note, version: summary.version };
      merged.set(note.id, next);
      needsSync.push(next);
    } else if (note.content !== null && note.version === summary.version) {
      merged.set(note.id, note);
    }
  }

  const notes = [...merged.values()].sort((a, b) => time(b.updatedAt) - time(a.updatedAt));
  return { notes, needsSync };
}
