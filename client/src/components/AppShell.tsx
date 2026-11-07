import { Suspense, lazy, useEffect } from 'react';
import { Outlet, useNavigate } from 'react-router-dom';
import { toast } from 'sonner';
import { AlertCircle, Check, CloudOff, LoaderCircle, LogOut, PanelLeftClose, PanelLeftOpen, Search, Settings } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Kbd, modKey } from '@/components/ui/kbd';
import { Tip } from '@/components/ui/tooltip';
import { Sidebar, SidebarSkeleton } from '@/components/Sidebar';
import { useEngine, useEngineState } from '@/hooks/engine';
import { useSession, useSignOut } from '@/hooks/session';
import { THEMES, useUi } from '@/lib/ui-store';
import { cn } from '@/lib/utils';

const CommandPalette = lazy(() => import('@/components/CommandPalette'));

export function Logo({ className = 'size-8' }: { className?: string }) {
  return <img src="/favicon.png" alt="" aria-hidden="true" className={className} />;
}

const statusCopy = {
  saving: { label: 'Saving…', icon: LoaderCircle, tone: 'text-muted-foreground', spin: true },
  saved: { label: 'Saved', icon: Check, tone: 'text-success', spin: false },
  offline: { label: 'Offline · saved on this device', icon: CloudOff, tone: 'text-warning', spin: false },
  error: { label: 'Could not sync', icon: AlertCircle, tone: 'text-destructive', spin: false },
} as const;

function SyncStatus({ className }: { className?: string }) {
  const status = useEngineState((state) => state.status);
  const { label, icon: Icon, tone, spin } = statusCopy[status];
  return (
    <div role="status" aria-live="polite" className={cn('flex items-center gap-1.5 text-xs', tone, className)}>
      <Icon className={cn('size-3.5', spin && 'animate-spin')} aria-hidden="true" />
      <span className="hidden sm:inline">{label}</span>
      <span className="sr-only sm:hidden">{label}</span>
    </div>
  );
}

function ThemeMenu() {
  const theme = useUi((state) => state.theme);
  const setTheme = useUi((state) => state.setTheme);
  const Current = THEMES.find((item) => item.value === theme)!.icon;
  return (
    <DropdownMenu>
      <Tip label="Theme">
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="icon" aria-label="Change theme">
            <Current className="size-4" />
          </Button>
        </DropdownMenuTrigger>
      </Tip>
      <DropdownMenuContent>
        {THEMES.map(({ value, label, icon: Icon }) => (
          <DropdownMenuItem key={value} onSelect={() => setTheme(value)} aria-checked={theme === value} role="menuitemradio">
            <Icon /> {label}{' '}
            {theme === value && (
              <span className="ml-auto text-primary" aria-hidden="true">
                ●
              </span>
            )}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function UserMenu() {
  const navigate = useNavigate();
  const { data: user } = useSession();
  const signOut = useSignOut();
  const initial = (user?.email[0] ?? '?').toUpperCase();
  return (
    <DropdownMenu>
      <Tip label="Account">
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="icon" aria-label="Account menu" className="rounded-full">
            <span className="flex size-7 items-center justify-center rounded-full bg-accent text-xs font-semibold text-accent-foreground">
              {initial}
            </span>
          </Button>
        </DropdownMenuTrigger>
      </Tip>
      <DropdownMenuContent className="min-w-56">
        <DropdownMenuLabel className="truncate">{user?.email}</DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={() => navigate('/settings')}>
          <Settings /> Settings
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => signOut.mutate()}>
          <LogOut /> Sign out
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function useGlobalShortcuts() {
  const engine = useEngine();
  const navigate = useNavigate();
  const { paletteOpen, setPaletteOpen, sidebarOpen, setSidebarOpen } = useUi();

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const mod = event.metaKey || event.ctrlKey;
      const key = event.key.toLowerCase();
      if (mod && !event.altKey && key === 'k') {
        event.preventDefault();
        setPaletteOpen(!paletteOpen);
      } else if (mod && !event.altKey && key === 's') {
        event.preventDefault();
        const active = engine.activeNote;
        if (active) void engine.saveNow(active.id).then(() => toast('Saved'));
      } else if (mod && key === '\\') {
        event.preventDefault();
        setSidebarOpen(!sidebarOpen);
      } else if (event.altKey && !mod && key === 'n') {
        event.preventDefault();
        navigate(`/notes/${engine.create().id}`);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [engine, navigate, paletteOpen, setPaletteOpen, sidebarOpen, setSidebarOpen]);
}

export function AppShell() {
  const ready = useEngineState((state) => state.ready);
  const { sidebarOpen, setSidebarOpen, setPaletteOpen, paletteOpen } = useUi();
  useGlobalShortcuts();

  return (
    <div className="flex h-dvh min-h-[480px] flex-col overflow-hidden">
      <a
        href="#note-body"
        className="sr-only z-[80] rounded-lg bg-primary px-3 py-2 text-sm text-primary-foreground focus:not-sr-only focus:absolute focus:left-3 focus:top-3"
      >
        Skip to note
      </a>
      <header className="relative z-40 flex h-16 shrink-0 items-center gap-2 border-b border-border bg-card/90 px-3 backdrop-blur-xl sm:px-5">
        <Tip label={`${sidebarOpen ? 'Hide' : 'Show'} sidebar (${modKey}+\\)`}>
          <Button
            variant="ghost"
            size="icon"
            aria-label={sidebarOpen ? 'Hide sidebar' : 'Show sidebar'}
            aria-expanded={sidebarOpen}
            onClick={() => setSidebarOpen(!sidebarOpen)}
          >
            {sidebarOpen ? <PanelLeftClose className="size-[18px]" /> : <PanelLeftOpen className="size-[18px]" />}
          </Button>
        </Tip>
        <div className="flex items-center gap-2.5">
          <Logo />
          <span className="text-[15px] font-semibold tracking-tight">Stillnote</span>
        </div>

        <button
          type="button"
          onClick={() => setPaletteOpen(true)}
          className="mx-auto hidden h-9 w-full max-w-sm items-center gap-2 rounded-lg border border-input bg-background px-3 text-sm text-muted-foreground transition-colors hover:bg-muted md:flex"
        >
          <Search className="size-4" aria-hidden="true" /> <span>Search or run a command</span>
          <span className="ml-auto flex gap-1">
            <Kbd>{modKey}</Kbd>
            <Kbd>K</Kbd>
          </span>
        </button>

        <div className="ml-auto flex items-center gap-1 md:ml-0">
          <SyncStatus className="mr-2" />
          <Button
            variant="ghost"
            size="icon"
            className="md:hidden"
            aria-label="Search notes and commands"
            onClick={() => setPaletteOpen(true)}
          >
            <Search className="size-4" />
          </Button>
          <ThemeMenu />
          <UserMenu />
        </div>
      </header>

      <div className="relative flex min-h-0 flex-1">
        {sidebarOpen && (
          <>
            <button
              type="button"
              aria-label="Close sidebar"
              className="fixed inset-0 top-16 z-20 animate-fade-in bg-black/50 md:hidden"
              onClick={() => setSidebarOpen(false)}
            />
            <div className="fixed inset-y-0 left-0 top-16 z-30 w-[min(86vw,320px)] animate-slide-in border-r border-border shadow-pop md:static md:z-0 md:w-[296px] md:shrink-0 md:animate-none md:shadow-none">
              {ready ? <Sidebar /> : <SidebarSkeleton />}
            </div>
          </>
        )}
        <main id="main" className="flex min-w-0 flex-1">
          <Outlet />
        </main>
      </div>

      {paletteOpen && (
        <Suspense fallback={null}>
          <CommandPalette />
        </Suspense>
      )}
    </div>
  );
}
