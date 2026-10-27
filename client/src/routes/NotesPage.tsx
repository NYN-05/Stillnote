import { useEffect } from 'react';
import { Navigate, useNavigate, useParams } from 'react-router-dom';
import { FilePlus2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { NoteEditor } from '@/components/NoteEditor';
import { useEngine, useEngineState } from '@/hooks/engine';

/** The URL decides which note is open; this keeps the engine's selection in step with it. */
export default function NotesPage() {
  const { id } = useParams();
  const engine = useEngine();
  const navigate = useNavigate();
  const ready = useEngineState((state) => state.ready);
  const notes = useEngineState((state) => state.notes);
  const activeId = useEngineState((state) => state.activeId);
  const exists = Boolean(id) && notes.some((note) => note.id === id);

  useEffect(() => {
    if (ready && id && exists) engine.select(id);
  }, [engine, exists, id, ready]);

  if (!ready) {
    return (
      <div className="mx-auto w-full max-w-3xl space-y-4 px-8 pt-10" aria-busy="true" aria-label="Loading your notes">
        <Skeleton className="h-8 w-1/2" />
        <Skeleton className="h-4 w-full" />
        <Skeleton className="h-4 w-5/6" />
        <Skeleton className="h-4 w-2/3" />
      </div>
    );
  }
  if (!id) {
    const target = activeId ?? notes[0]?.id;
    if (target) return <Navigate to={`/notes/${target}`} replace />;
    return (
      <div className="m-auto text-center">
        <p className="text-sm text-muted-foreground">No notes yet.</p>
        <Button variant="primary" className="mt-3" onClick={() => navigate(`/notes/${engine.create().id}`)}>
          <FilePlus2 className="size-4" /> New note
        </Button>
      </div>
    );
  }
  if (!exists) return <Navigate to="/notes" replace />;
  // Wait for the engine to select the note from the URL before rendering it.
  if (activeId !== id) return null;
  return <NoteEditor />;
}
