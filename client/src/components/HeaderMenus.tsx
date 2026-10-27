import { useNavigate } from 'react-router-dom';
import { LogOut, Monitor, Moon, Settings, Sun } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Tip } from '@/components/ui/tooltip';
import { useSession, useSignOut } from '@/hooks/session';
import { useUi, type Theme } from '@/lib/ui-store';

const themes: { value: Theme; label: string; icon: typeof Sun }[] = [
  { value: 'light', label: 'Light', icon: Sun },
  { value: 'dark', label: 'Dark', icon: Moon },
  { value: 'system', label: 'System', icon: Monitor },
];

export function ThemeMenu() {
  const theme = useUi((state) => state.theme);
  const setTheme = useUi((state) => state.setTheme);
  const Current = themes.find((item) => item.value === theme)!.icon;
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
        {themes.map(({ value, label, icon: Icon }) => (
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

export function UserMenu() {
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
