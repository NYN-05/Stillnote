import { useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { toast } from 'sonner';
import { Pin, PinOff, Plus, Search, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/alert-dialog';
import { Kbd } from '@/components/ui/kbd';
import { Skeleton } from '@/components/ui/skeleton';
import { Tip } from '@/components/ui/tooltip';
import { useEngine, useEngineState } from '@/hooks/engine';
import type { Note } from '@/lib/types';
import { useUi } from '@/lib/ui-store';
import { cn, formatNoteDate, previewText } from '@/lib/utils';

const PAGE = 100;

export function Sidebar() {
  const engine = useEngine();
  const navigate = useNavigate();
  const notes = useEngineState((state) => state.notes);
  const activeId = useEngineState((state) => state.activeId);
  const setSidebarOpen = useUi((state) => state.setSidebarOpen);
  const [query, setQuery] = useState('');
  const [limit, setLimit] = useState(PAGE);
  const [toDelete, setToDelete] = useState<Note | null>(null);

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return notes;
    return notes.filter(
      (note) => note.title.toLowerCase().includes(needle) || (note.content ?? note.snippet ?? '').toLowerCase().includes(needle),
    );
  }, [notes, query]);

  const visible = filtered.slice(0, limit);
  const pinned = visible.filter((note) => note.pinned);
  const others = visible.filter((note) => !note.pinned);

  const closeOnMobile = () => {
    if (window.innerWidth < 768) setSidebarOpen(false);
  };
  const createNote = () => {
    const note = engine.create();
    setQuery('');
    navigate(`/notes/${note.id}`);
    closeOnMobile();
  };
  const deleteNote = async (note: Note) => {
    setToDelete(null);
    const next = await engine.remove(note.id);
    if (note.id === activeId) navigate(next ? `/notes/${next}` : '/notes', { replace: true });
    toast('Note deleted');
  };

  const renderRow = (note: Note) => (
    <li key={note.id} className="group relative">
      <Link
        to={`/notes/${note.id}`}
        onClick={closeOnMobile}
        aria-current={note.id === activeId ? 'page' : undefined}
        className={cn(
          'block rounded-xl border border-transparent px-3 py-2.5 pr-14 transition-colors',
          note.id === activeId ? 'border-primary/20 bg-accent' : 'hover:bg-muted',
        )}
      >
        <span className={cn('block truncate text-[13px] font-medium', note.id === activeId ? 'text-accent-foreground' : 'text-foreground')}>
          {note.title || 'Untitled note'}
        </span>
        <span className="mt-0.5 block truncate text-xs text-muted-foreground">
          {previewText(note.content, note.snippet) || 'No text yet'}
        </span>
        <span className="mt-1 block text-[11px] text-muted-foreground">{formatNoteDate(note.updatedAt)}</span>
      </Link>
      <div className="absolute right-1.5 top-1.5 flex opacity-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100">
        <Tip label={note.pinned ? 'Unpin' : 'Pin'} side="top">
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={`${note.pinned ? 'Unpin' : 'Pin'} ${note.title}`}
            onClick={() => engine.edit(note.id, { pinned: !note.pinned })}
          >
            {note.pinned ? <PinOff className="size-3.5" /> : <Pin className="size-3.5" />}
          </Button>
        </Tip>
        <Tip label="Delete" side="top">
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={`Delete ${note.title}`}
            className="hover:text-destructive"
            onClick={() => setToDelete(note)}
          >
            <Trash2 className="size-3.5" />
          </Button>
        </Tip>
      </div>
      {note.pinned && (
        <Pin
          aria-hidden="true"
          className="pointer-events-none absolute right-3 top-3 size-3 text-primary group-focus-within:hidden group-hover:hidden"
        />
      )}
    </li>
  );

  return (
    <aside className="flex h-full w-full flex-col bg-sidebar" aria-label="Notes">
      <div className="space-y-3 p-3">
        <Button variant="primary" className="w-full justify-start" onClick={createNote}>
          <Plus className="size-4" /> New note <Kbd className="ml-auto border-white/25 bg-white/15 text-primary-foreground">Alt N</Kbd>
        </Button>
        <label className="relative block">
          <span className="sr-only">Filter notes</span>
          <Search
            aria-hidden="true"
            className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
          />
          <input
            type="search"
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              setLimit(PAGE);
            }}
            placeholder="Filter notes"
            className="h-9 w-full rounded-lg border border-input bg-card pl-9 pr-3 text-sm placeholder:text-muted-foreground focus-visible:border-ring focus-visible:outline-2 focus-visible:outline-offset-0 focus-visible:outline-ring/30"
          />
        </label>
      </div>

      <nav className="min-h-0 flex-1 overflow-y-auto px-2 pb-4" aria-label="Note list">
        {pinned.length > 0 && (
          <section aria-labelledby="pinned-heading" className="mb-3">
            <h2 id="pinned-heading" className="px-3 pb-1 pt-2 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
              Pinned
            </h2>
            <ul className="space-y-0.5">{pinned.map(renderRow)}</ul>
          </section>
        )}
        <section aria-labelledby="notes-heading">
          <h2
            id="notes-heading"
            className="flex items-center justify-between px-3 pb-1 pt-2 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground"
          >
            <span>Notes</span>
            <span className="tabular-nums normal-case tracking-normal">{filtered.length}</span>
          </h2>
          <ul className="space-y-0.5">{others.map(renderRow)}</ul>
        </section>
        {filtered.length === 0 && (
          <div className="px-4 py-10 text-center">
            <div className="mx-auto flex size-10 items-center justify-center rounded-2xl bg-muted text-muted-foreground">
              <Search className="size-4" />
            </div>
            <p className="mt-3 text-sm font-medium">No notes found</p>
            <p className="mt-1 text-xs text-muted-foreground">Try another title or keyword.</p>
          </div>
        )}
        {filtered.length > limit && (
          <Button variant="ghost" size="sm" className="mt-2 w-full" onClick={() => setLimit((current) => current + PAGE)}>
            Show more ({filtered.length - limit} left)
          </Button>
        )}
      </nav>

      <ConfirmDialog
        open={Boolean(toDelete)}
        title="Delete this note?"
        description={<>“{toDelete?.title || 'Untitled note'}” will be removed from your library. This cannot be undone.</>}
        confirmLabel="Delete note"
        onCancel={() => setToDelete(null)}
        onConfirm={() => toDelete && void deleteNote(toDelete)}
      />
    </aside>
  );
}

export function SidebarSkeleton() {
  return (
    <div className="space-y-3 p-3" aria-hidden="true">
      <Skeleton className="h-9 w-full" />
      <Skeleton className="h-9 w-full" />
      {Array.from({ length: 6 }, (_, index) => (
        <Skeleton key={index} className="h-14 w-full" />
      ))}
    </div>
  );
}
