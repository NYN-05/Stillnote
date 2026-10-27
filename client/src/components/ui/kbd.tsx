import type { HTMLAttributes } from 'react';
import { cn } from '@/lib/utils';

export const Kbd = ({ className, ...props }: HTMLAttributes<HTMLElement>) => (
  <kbd
    className={cn(
      'inline-flex h-5 min-w-5 items-center justify-center rounded border border-border bg-muted px-1 font-mono text-[10px] font-medium text-muted-foreground',
      className,
    )}
    {...props}
  />
);

/** The command key on Apple platforms, Ctrl elsewhere. */
export const modKey = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform) ? '⌘' : 'Ctrl';
