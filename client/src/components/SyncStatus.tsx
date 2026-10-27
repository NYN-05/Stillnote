import { AlertCircle, Check, CloudOff, LoaderCircle } from 'lucide-react';
import { useEngineState } from '@/hooks/engine';
import { cn } from '@/lib/utils';

const copy = {
  saving: { label: 'Saving…', icon: LoaderCircle, tone: 'text-muted-foreground', spin: true },
  saved: { label: 'Saved', icon: Check, tone: 'text-success', spin: false },
  offline: { label: 'Offline · saved on this device', icon: CloudOff, tone: 'text-warning', spin: false },
  error: { label: 'Could not sync', icon: AlertCircle, tone: 'text-destructive', spin: false },
} as const;

export function SyncStatus({ className }: { className?: string }) {
  const status = useEngineState((state) => state.status);
  const { label, icon: Icon, tone, spin } = copy[status];
  return (
    <div role="status" aria-live="polite" className={cn('flex items-center gap-1.5 text-xs', tone, className)}>
      <Icon className={cn('size-3.5', spin && 'animate-spin')} aria-hidden="true" />
      <span className="hidden sm:inline">{label}</span>
      <span className="sr-only sm:hidden">{label}</span>
    </div>
  );
}
