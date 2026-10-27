import { Suspense, lazy, useCallback, useDeferredValue, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { toast } from 'sonner';
import { Columns2, Copy, Download, Eye, FileText, MoreHorizontal, Pencil, Pin, PinOff, RefreshCw, Trash2, Eraser } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/alert-dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Skeleton } from '@/components/ui/skeleton';
import { Tip } from '@/components/ui/tooltip';
import { EditorToolbar } from '@/components/EditorToolbar';
import type { EditorHandle } from '@/components/MarkdownEditor';
import { useActiveNote, useEngine, useEngineState } from '@/hooks/engine';
import { useUi, type ViewMode } from '@/lib/ui-store';
import { cn, copyText, countWords, downloadText, sanitizeFilename } from '@/lib/utils';

// CodeMirror and the Markdown renderer are large; load them only when a note is opened.
const MarkdownEditor = lazy(() => import('@/components/MarkdownEditor'));
const MarkdownPreview = lazy(() => import('@/components/MarkdownPreview'));

const modes: { mode: ViewMode; label: string; icon: typeof Pencil; narrowHidden?: boolean }[] = [
  { mode: 'write', label: 'Write', icon: Pencil },
  { mode: 'split', label: 'Split', icon: Columns2, narrowHidden: true },
  { mode: 'preview', label: 'Preview', icon: Eye },
];

const EditorFallback = () => (
  <div className="space-y-3 pt-2" aria-hidden="true">
    <Skeleton className="h-4 w-3/4" />
    <Skeleton className="h-4 w-full" />
    <Skeleton className="h-4 w-5/6" />
    <Skeleton className="h-4 w-2/3" />
  </div>
);

export function NoteEditor() {
  const engine = useEngine();
  const navigate = useNavigate();
  const note = useActiveNote();
  const contentErrorId = useEngineState((state) => state.contentErrorId);
  const { viewMode, setViewMode, monospace } = useUi();
  const editor = useRef<EditorHandle>(null);
  const [confirm, setConfirm] = useState<'clear' | 'delete' | null>(null);

  const content = note?.content ?? '';
  const deferredContent = useDeferredValue(content);
  const words = useMemo(() => countWords(content), [content]);
  const characters = useMemo(() => Array.from(content).length, [content]);
  const minutes = words === 0 ? 0 : Math.max(1, Math.ceil(words / 200));

  const noteId = note?.id;
  const handleChange = useCallback(
    (value: string) => {
      if (noteId) engine.edit(noteId, { content: value });
    },
    [engine, noteId],
  );

  if (!note) return null;
  const pending = note.content === null;
  const loadFailed = pending && contentErrorId === note.id;
  const showEditor = viewMode !== 'preview';
  const showPreview = viewMode !== 'write';

  const filename = sanitizeFilename(note.title);
  const exportAs = (extension: 'md' | 'txt') => {
    downloadText(`${filename}.${extension}`, content, extension === 'md' ? 'text/markdown' : 'text/plain');
    toast(`Downloaded ${filename}.${extension}`);
  };
  const copyNote = async () => toast((await copyText(content)) ? 'Copied to clipboard' : 'Clipboard access was blocked');

  const removeNote = async () => {
    setConfirm(null);
    const next = await engine.remove(note.id);
    navigate(next ? `/notes/${next}` : '/notes', { replace: true });
    toast('Note deleted');
  };

  return (
    <section className="flex min-w-0 flex-1 flex-col bg-background" aria-label="Note editor">
      <div className="flex h-14 shrink-0 items-center gap-2 border-b border-border px-4 sm:px-8">
        <input
          aria-label="Note title"
          value={note.title}
          maxLength={120}
          placeholder="Untitled note"
          onChange={(event) => engine.edit(note.id, { title: event.target.value })}
          onBlur={() => {
            if (!note.title.trim()) engine.edit(note.id, { title: 'Untitled note' });
          }}
          className="min-w-0 flex-1 truncate bg-transparent text-base font-semibold tracking-tight text-foreground outline-none placeholder:text-muted-foreground focus-visible:outline-none"
        />

        <div role="group" aria-label="View mode" className="flex shrink-0 items-center rounded-lg border border-border bg-muted p-0.5">
          {modes.map(({ mode, label, icon: Icon, narrowHidden }) => (
            <button
              key={mode}
              type="button"
              aria-pressed={viewMode === mode}
              onClick={() => setViewMode(mode)}
              className={cn(
                'flex h-7 items-center gap-1.5 rounded-md px-2 text-xs font-medium transition-colors',
                narrowHidden && 'hidden md:flex',
                viewMode === mode ? 'bg-card text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground',
              )}
            >
              <Icon className="size-3.5" aria-hidden="true" />
              <span className="hidden sm:inline">{label}</span>
              <span className="sr-only sm:hidden">{label}</span>
            </button>
          ))}
        </div>

        <Tip label={note.pinned ? 'Unpin note' : 'Pin note'}>
          <Button
            variant="ghost"
            size="icon"
            aria-label={note.pinned ? 'Unpin note' : 'Pin note'}
            aria-pressed={note.pinned}
            onClick={() => engine.edit(note.id, { pinned: !note.pinned })}
          >
            {note.pinned ? <PinOff className="size-4 text-primary" /> : <Pin className="size-4" />}
          </Button>
        </Tip>

        <DropdownMenu>
          <Tip label="More actions">
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon" aria-label="More actions">
                <MoreHorizontal className="size-4" />
              </Button>
            </DropdownMenuTrigger>
          </Tip>
          <DropdownMenuContent>
            <DropdownMenuItem disabled={pending} onSelect={copyNote}>
              <Copy /> Copy text
            </DropdownMenuItem>
            <DropdownMenuItem disabled={pending} onSelect={() => exportAs('md')}>
              <Download /> Download .md
            </DropdownMenuItem>
            <DropdownMenuItem disabled={pending} onSelect={() => exportAs('txt')}>
              <FileText /> Download .txt
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem disabled={pending || !content} onSelect={() => setConfirm('clear')}>
              <Eraser /> Clear text…
            </DropdownMenuItem>
            <DropdownMenuItem destructive onSelect={() => setConfirm('delete')}>
              <Trash2 /> Delete note…
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      {showEditor && <EditorToolbar disabled={pending} onFormat={(command) => editor.current?.format(command)} />}

      <div id="note-body" className="min-h-0 flex-1 overflow-y-auto">
        <div
          className={cn(
            'mx-auto grid w-full gap-x-10 px-5 pb-10 pt-6 sm:px-8',
            viewMode === 'split' ? 'max-w-6xl md:grid-cols-2' : 'max-w-3xl',
          )}
        >
          {showEditor && (
            <div className="min-w-0">
              {loadFailed ? (
                <div role="alert" className="flex flex-wrap items-center gap-3 rounded-xl border border-border bg-muted px-4 py-3 text-sm">
                  <span className="text-muted-foreground">This note could not be downloaded.</span>
                  <Button size="sm" onClick={() => void engine.loadContent(note.id)}>
                    <RefreshCw className="size-3.5" /> Try again
                  </Button>
                </div>
              ) : pending ? (
                <EditorFallback />
              ) : (
                <Suspense fallback={<EditorFallback />}>
                  <MarkdownEditor
                    key={note.id}
                    ref={editor}
                    value={content}
                    onChange={handleChange}
                    monospace={monospace}
                    label="Note text"
                    placeholder="Start with a thought…  Use Markdown when it helps, or just write."
                  />
                </Suspense>
              )}
            </div>
          )}

          {showPreview && (
            <div className={cn('min-w-0', viewMode === 'split' && 'hidden md:block md:border-l md:border-border md:pl-10')}>
              {pending ? (
                <EditorFallback />
              ) : content.trim() ? (
                <Suspense fallback={<EditorFallback />}>
                  <MarkdownPreview content={deferredContent} monospace={monospace} />
                </Suspense>
              ) : (
                <div className="flex min-h-64 flex-col items-center justify-center gap-2 text-center">
                  <div className="flex size-11 items-center justify-center rounded-2xl bg-muted text-muted-foreground">
                    <Eye className="size-5" />
                  </div>
                  <h2 className="text-sm font-medium">Nothing to preview yet</h2>
                  <p className="text-xs text-muted-foreground">Write something and it will appear here, formatted.</p>
                  {viewMode === 'preview' && (
                    <Button size="sm" className="mt-2" onClick={() => setViewMode('write')}>
                      <Pencil className="size-3.5" /> Start writing
                    </Button>
                  )}
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      <footer className="flex h-10 shrink-0 items-center gap-4 border-t border-border bg-card/60 px-4 text-xs tabular-nums text-muted-foreground sm:px-8">
        <span>
          {words.toLocaleString()} {words === 1 ? 'word' : 'words'}
        </span>
        <span className="hidden sm:inline">{characters.toLocaleString()} characters</span>
        <span className="hidden sm:inline">{minutes === 0 ? '0 min read' : `${minutes} min read`}</span>
      </footer>

      <ConfirmDialog
        open={confirm === 'clear'}
        title="Clear this note?"
        description="This removes all text from the note. The empty note stays in your library."
        confirmLabel="Clear text"
        onCancel={() => setConfirm(null)}
        onConfirm={() => {
          engine.edit(note.id, { content: '' });
          setConfirm(null);
          toast('Text cleared');
        }}
      />
      <ConfirmDialog
        open={confirm === 'delete'}
        title="Delete this note?"
        description={<>“{note.title || 'Untitled note'}” will be removed from your library. This cannot be undone.</>}
        confirmLabel="Delete note"
        onCancel={() => setConfirm(null)}
        onConfirm={() => void removeNote()}
      />
    </section>
  );
}
