import { useState } from 'react';
import { Link } from 'react-router-dom';
import { toast } from 'sonner';
import { ArrowLeft, Download, LogOut, Monitor, Moon, Sun } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Kbd, modKey } from '@/components/ui/kbd';
import { useSession, useSignOut } from '@/hooks/session';
import { useEngineState } from '@/hooks/engine';
import { notesApi } from '@/lib/api';
import { useUi, type Theme } from '@/lib/ui-store';
import { cn, downloadText } from '@/lib/utils';

const themes: { value: Theme; label: string; icon: typeof Sun }[] = [
  { value: 'light', label: 'Light', icon: Sun },
  { value: 'dark', label: 'Dark', icon: Moon },
  { value: 'system', label: 'System', icon: Monitor },
];

const shortcuts: [string, string[]][] = [
  ['Command palette', [modKey, 'K']],
  ['New note', ['Alt', 'N']],
  ['Save now', [modKey, 'S']],
  ['Bold', [modKey, 'B']],
  ['Italic', [modKey, 'I']],
  ['Toggle sidebar', [modKey, '\\']],
];

function Section({ title, description, children }: { title: string; description?: string; children: React.ReactNode }) {
  return (
    <section className="rounded-2xl border border-border bg-card p-5 sm:p-6">
      <h2 className="text-base font-semibold tracking-tight">{title}</h2>
      {description && <p className="mt-1 text-sm text-muted-foreground">{description}</p>}
      <div className="mt-5">{children}</div>
    </section>
  );
}

export default function SettingsPage() {
  const { data: user } = useSession();
  const signOut = useSignOut();
  const { theme, setTheme, monospace, setMonospace } = useUi();
  const noteCount = useEngineState((state) => state.notes.length);
  const [exporting, setExporting] = useState(false);

  // Notes are listed without their text, so each one is fetched for the export.
  const exportAll = async () => {
    setExporting(true);
    try {
      const summaries = await notesApi.list();
      const notes = [];
      for (const summary of summaries) notes.push(await notesApi.get(summary.id));
      downloadText(
        `stillnote-export-${new Date().toISOString().slice(0, 10)}.json`,
        JSON.stringify({ exportedAt: new Date().toISOString(), notes }, null, 2),
        'application/json',
      );
      toast(`Exported ${notes.length} ${notes.length === 1 ? 'note' : 'notes'}`);
    } catch {
      toast.error('Export needs a connection to the server. Try again when you are online.');
    } finally {
      setExporting(false);
    }
  };

  return (
    <div className="min-w-0 flex-1 overflow-y-auto">
      <div className="mx-auto max-w-2xl space-y-5 px-5 py-8 sm:px-8">
        <div>
          <Link to="/notes" className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground">
            <ArrowLeft className="size-4" /> Back to notes
          </Link>
          <h1 className="mt-3 text-2xl font-semibold tracking-tight">Settings</h1>
        </div>

        <Section title="Appearance">
          <div role="radiogroup" aria-label="Theme" className="grid grid-cols-3 gap-2">
            {themes.map(({ value, label, icon: Icon }) => (
              <button
                key={value}
                type="button"
                role="radio"
                aria-checked={theme === value}
                onClick={() => setTheme(value)}
                className={cn(
                  'flex flex-col items-center gap-2 rounded-xl border px-3 py-4 text-sm transition-colors',
                  theme === value ? 'border-primary bg-accent text-accent-foreground' : 'border-border hover:bg-muted',
                )}
              >
                <Icon className="size-5" aria-hidden="true" /> {label}
              </button>
            ))}
          </div>
          <label className="mt-5 flex cursor-pointer items-center justify-between gap-4">
            <span>
              <span className="block text-sm font-medium">Monospace editor font</span>
              <span className="block text-xs text-muted-foreground">Use a fixed-width font while writing and in the preview.</span>
            </span>
            <input
              type="checkbox"
              role="switch"
              checked={monospace}
              onChange={(event) => setMonospace(event.target.checked)}
              className="size-5 accent-primary"
            />
          </label>
        </Section>

        <Section title="Account" description={user?.email}>
          <div className="flex flex-wrap gap-2">
            <Button onClick={exportAll} disabled={exporting}>
              <Download className="size-4" /> {exporting ? 'Exporting…' : `Download all notes (${noteCount})`}
            </Button>
            <Button variant="outline" onClick={() => signOut.mutate()}>
              <LogOut className="size-4" /> Sign out
            </Button>
          </div>
          <p className="mt-3 text-xs text-muted-foreground">
            The export is a JSON file with every note in full. Signing out keeps your offline copy on this device.
          </p>
        </Section>

        <Section title="Keyboard shortcuts">
          <dl className="divide-y divide-border">
            {shortcuts.map(([label, keys]) => (
              <div key={label} className="flex items-center justify-between py-2.5 text-sm">
                <dt>{label}</dt>
                <dd className="flex gap-1">
                  {keys.map((key) => (
                    <Kbd key={key}>{key}</Kbd>
                  ))}
                </dd>
              </div>
            ))}
          </dl>
        </Section>
      </div>
    </div>
  );
}
