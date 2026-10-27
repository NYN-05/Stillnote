import { createContext, useContext, useEffect, useState, useSyncExternalStore, type ReactNode } from 'react';
import { toast } from 'sonner';
import { notesApi } from '@/lib/api';
import { openLocalStore } from '@/lib/db';
import { SyncEngine, type EngineState } from '@/lib/engine';
import type { Note } from '@/lib/types';

const EngineContext = createContext<SyncEngine | null>(null);

/** Opens the signed-in user's offline database and runs a sync engine for as long as they stay. */
export function EngineProvider({ userId, fallback, children }: { userId: string; fallback: ReactNode; children: ReactNode }) {
  const [engine, setEngine] = useState<SyncEngine | null>(null);

  useEffect(() => {
    let cancelled = false;
    let created: SyncEngine | null = null;
    openLocalStore(userId)
      .then((store) => {
        if (cancelled) return store.close();
        created = new SyncEngine({ api: notesApi, store, notify: (message) => toast(message) });
        setEngine(created);
        void created.start();
      })
      .catch((error) => {
        console.error('Stillnote could not open its offline storage:', error);
        toast.error('Offline storage is unavailable in this browser. Notes will not be kept on this device.');
      });
    return () => {
      cancelled = true;
      created?.stop();
      setEngine(null);
    };
  }, [userId]);

  if (!engine) return <>{fallback}</>;
  return <EngineContext.Provider value={engine}>{children}</EngineContext.Provider>;
}

export function useEngine(): SyncEngine {
  const engine = useContext(EngineContext);
  if (!engine) throw new Error('useEngine must be used inside EngineProvider');
  return engine;
}

/** Subscribes to one slice of the engine state. The selector must return a stable value. */
export function useEngineState<T>(selector: (state: EngineState) => T): T {
  const engine = useEngine();
  return useSyncExternalStore(engine.subscribe, () => selector(engine.getState()));
}

export const useActiveNote = (): Note | null => useEngineState((state) => state.notes.find((note) => note.id === state.activeId) ?? null);
