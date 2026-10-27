import type { ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { Command } from 'cmdk';
import { toast } from 'sonner';
import { Columns2, Download, Eye, FilePlus2, FileText, LogOut, Monitor, Moon, PanelLeft, Pencil, Settings, Sun, Type } from 'lucide-react';
import { useEngine, useEngineState } from '@/hooks/engine';
import { useSignOut } from '@/hooks/session';
import { useUi } from '@/lib/ui-store';
import { downloadText, previewText, sanitizeFilename } from '@/lib/utils';

const itemClass =
  'flex cursor-pointer items-center gap-3 rounded-lg px-3 py-2.5 text-sm text-foreground outline-none data-[selected=true]:bg-accent data-[selected=true]:text-accent-foreground [&_svg]:size-4 [&_svg]:shrink-0 [&_svg]:text-muted-foreground';
const groupClass =
  '[&_[cmdk-group-heading]]:px-3 [&_[cmdk-group-heading]]:pb-1 [&_[cmdk-group-heading]]:pt-3 [&_[cmdk-group-heading]]:text-[11px] [&_[cmdk-group-heading]]:font-semibold [&_[cmdk-group-heading]]:uppercase [&_[cmdk-group-heading]]:tracking-wider [&_[cmdk-group-heading]]:text-muted-foreground';

export default function CommandPalette() {
  const engine = useEngine();
  const navigate = useNavigate();
  const signOut = useSignOut();
  const notes = useEngineState((state) => state.notes);
  const ui = useUi();

  const run = (action: () => void) => () => {
    ui.setPaletteOpen(false);
    action();
  };
  const Action = ({ icon, label, onSelect, keywords }: { icon: ReactNode; label: string; onSelect: () => void; keywords?: string[] }) => (
    <Command.Item value={`action:${label}`} keywords={keywords ?? [label]} onSelect={run(onSelect)} className={itemClass}>
      {icon}
      {label}
    </Command.Item>
  );

  const exportActive = () => {
    const note = engine.activeNote;
    if (!note || note.content === null) return toast('Open the note first so its text is available');
    downloadText(`${sanitizeFilename(note.title)}.md`, note.content, 'text/markdown');
  };

  return (
    <Command.Dialog
      open={ui.paletteOpen}
      onOpenChange={ui.setPaletteOpen}
      label="Command palette"
      overlayClassName="fixed inset-0 z-[60] animate-fade-in bg-black/50 backdrop-blur-[2px]"
      contentClassName="fixed left-1/2 top-[14vh] z-[61] w-[calc(100vw-2rem)] max-w-xl -translate-x-1/2 animate-pop-in overflow-hidden rounded-2xl border border-border bg-card text-card-foreground shadow-pop"
      // Notes match on title and preview; actions on their label.
      filter={(value, search, keywords) =>
        (keywords?.length ? keywords.join(' ') : value).toLowerCase().includes(search.trim().toLowerCase()) ? 1 : 0
      }
    >
      <Command.Input
        placeholder="Search notes or run a command…"
        className="h-12 w-full border-b border-border bg-transparent px-4 text-sm outline-none placeholder:text-muted-foreground"
      />
      <Command.List className="max-h-[min(60vh,420px)] overflow-y-auto p-2">
        <Command.Empty className="px-3 py-8 text-center text-sm text-muted-foreground">Nothing matches.</Command.Empty>

        <Command.Group heading="Actions" className={groupClass}>
          <Action
            icon={<FilePlus2 />}
            label="New note"
            keywords={['new note', 'create']}
            onSelect={() => {
              const note = engine.create();
              navigate(`/notes/${note.id}`);
            }}
          />
          <Action icon={<Pencil />} label="Write mode" onSelect={() => ui.setViewMode('write')} />
          <Action icon={<Columns2 />} label="Split view" onSelect={() => ui.setViewMode('split')} />
          <Action icon={<Eye />} label="Preview mode" onSelect={() => ui.setViewMode('preview')} />
          <Action icon={<Type />} label="Toggle monospace font" onSelect={() => ui.setMonospace(!ui.monospace)} />
          <Action icon={<PanelLeft />} label="Toggle sidebar" onSelect={() => ui.setSidebarOpen(!ui.sidebarOpen)} />
          <Action
            icon={<Download />}
            label="Download current note as Markdown"
            keywords={['export', 'download', 'markdown']}
            onSelect={exportActive}
          />
          <Action icon={<Sun />} label="Light theme" onSelect={() => ui.setTheme('light')} />
          <Action icon={<Moon />} label="Dark theme" onSelect={() => ui.setTheme('dark')} />
          <Action icon={<Monitor />} label="System theme" onSelect={() => ui.setTheme('system')} />
          <Action icon={<Settings />} label="Settings" onSelect={() => navigate('/settings')} />
          <Action icon={<LogOut />} label="Sign out" onSelect={() => signOut.mutate()} />
        </Command.Group>

        <Command.Group heading="Notes" className={groupClass}>
          {notes.slice(0, 200).map((note) => {
            const preview = previewText(note.content, note.snippet, 12);
            return (
              <Command.Item
                key={note.id}
                value={`note:${note.id}`}
                keywords={[note.title, preview]}
                onSelect={run(() => navigate(`/notes/${note.id}`))}
                className={itemClass}
              >
                <FileText />
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-medium">{note.title || 'Untitled note'}</span>
                  {preview && <span className="block truncate text-xs font-normal text-muted-foreground">{preview}</span>}
                </span>
              </Command.Item>
            );
          })}
        </Command.Group>
      </Command.List>
    </Command.Dialog>
  );
}
