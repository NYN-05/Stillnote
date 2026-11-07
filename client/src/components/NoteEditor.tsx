import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { toast } from 'sonner';
import type { Editor } from '@tiptap/core';
import { AlertTriangle, Copy, Eraser, FileCode2, FileText, MoreHorizontal, Pin, PinOff, Printer, RefreshCw, Trash2 } from 'lucide-react';
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
import { RichTextEditor } from '@/components/RichTextEditor';
import { useActiveNote, useEngine, useEngineState } from '@/hooks/engine';
import { DEFAULT_NOTE_TITLE, MAX_TITLE_LENGTH } from '@/lib/model';
import { copyRichText, downloadHtml, htmlToPlainText, printRichText } from '@/lib/richText';
import { countWords, downloadText, sanitizeFilename } from '@/lib/utils';

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
  const conflict = useEngineState((state) => state.conflict);
  const [editor, setEditor] = useState<Editor | null>(null);
  const [confirm, setConfirm] = useState<'clear' | 'delete' | null>(null);

  const content = note?.content ?? '';
  const plainText = useMemo(() => htmlToPlainText(content), [content]);
  const words = useMemo(() => countWords(plainText), [plainText]);
  const characters = useMemo(() => Array.from(plainText).length, [plainText]);
  const minutes = words === 0 ? 0 : Math.max(1, Math.ceil(words / 200));

  const noteId = note?.id;
  const handleChange = useCallback(
    (value: string) => {
      if (noteId) engine.edit(noteId, { content: value });
    },
    [engine, noteId],
  );

  // Leaving the editor (settings, sign-out, route change) ends the edit burst.
  useEffect(() => () => void engine.flush(), [engine]);

  if (!note) return null;
  const pending = note.content === null;
  const loadFailed = pending && contentErrorId === note.id;
  const isConflict = conflict?.noteId === note.id;

  const filename = sanitizeFilename(note.title);
  const exportAs = (kind: 'html' | 'txt') => {
    if (kind === 'html') {
      downloadHtml(`${filename}.html`, note.title, content);
      toast(`Downloaded ${filename}.html`);
    } else {
      downloadText(`${filename}.txt`, plainText, 'text/plain');
      toast(`Downloaded ${filename}.txt`);
    }
  };
  const copyNote = async () => toast((await copyRichText(content)) ? 'Copied to clipboard' : 'Clipboard access was blocked');

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
          maxLength={MAX_TITLE_LENGTH}
          placeholder={DEFAULT_NOTE_TITLE}
          onChange={(event) => engine.edit(note.id, { title: event.target.value })}
          onBlur={() => {
            if (!note.title.trim()) engine.edit(note.id, { title: DEFAULT_NOTE_TITLE });
          }}
          className="min-w-0 flex-1 truncate bg-transparent text-base font-semibold tracking-tight text-foreground outline-none placeholder:text-muted-foreground focus-visible:outline-none"
        />

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
              <Copy /> Copy formatted text
            </DropdownMenuItem>
            <DropdownMenuItem disabled={pending} onSelect={() => exportAs('html')}>
              <FileCode2 /> Download .html
            </DropdownMenuItem>
            <DropdownMenuItem disabled={pending} onSelect={() => exportAs('txt')}>
              <FileText /> Download .txt
            </DropdownMenuItem>
            <DropdownMenuItem disabled={pending || !plainText.trim()} onSelect={() => printRichText(note.title, content)}>
              <Printer /> Print…
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem disabled={pending || !plainText.trim()} onSelect={() => setConfirm('clear')}>
              <Eraser /> Clear text…
            </DropdownMenuItem>
            <DropdownMenuItem destructive onSelect={() => setConfirm('delete')}>
              <Trash2 /> Delete note…
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      {editor && !pending && <EditorToolbar editor={editor} />}

      <div id="note-body" className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-3xl px-5 pb-10 pt-6 sm:px-8">
          {isConflict && (
            <div
              role="alert"
              className="mb-6 flex flex-col gap-3 rounded-xl border border-warning/40 bg-warning/10 px-4 py-3 text-sm sm:flex-row sm:items-center"
            >
              <AlertTriangle className="size-4 shrink-0 text-warning" aria-hidden="true" />
              <div className="min-w-0 flex-1">
                <p className="font-medium text-foreground">This note changed in another session.</p>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  Your text on this screen is safe, and autosave is paused. Reload the other version, or keep yours and replace it.
                </p>
              </div>
              <div className="flex shrink-0 gap-2">
                <Button variant="outline" size="sm" onClick={() => void engine.reloadConflict(note.id)}>
                  Reload latest
                </Button>
                <Button variant="primary" size="sm" onClick={() => void engine.keepLocalConflict(note.id)}>
                  Keep my text
                </Button>
              </div>
            </div>
          )}

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
            <RichTextEditor
              key={note.id}
              value={content}
              onChange={handleChange}
              onEditor={setEditor}
              label="Note text"
              placeholder="Start with a thought…"
            />
          )}
        </div>
      </div>

      <footer className="flex h-10 shrink-0 items-center gap-4 border-t border-border bg-card/60 px-4 text-xs tabular-nums text-muted-foreground sm:px-8">
        <span>
          {words.toLocaleString()} {words === 1 ? 'word' : 'words'}
        </span>
        <span className="hidden sm:inline">{characters.toLocaleString()} characters</span>
        <span className="hidden sm:inline">{minutes === 0 ? '0 min read' : `${minutes} min read`}</span>
        {isConflict && <span className="ml-auto text-warning">Autosave paused</span>}
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
        description={<>“{note.title || DEFAULT_NOTE_TITLE}” will be removed from your library. This cannot be undone.</>}
        confirmLabel="Delete note"
        onCancel={() => setConfirm(null)}
        onConfirm={() => void removeNote()}
      />
    </section>
  );
}
