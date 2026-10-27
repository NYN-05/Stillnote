import { forwardRef, type ComponentPropsWithoutRef, type ElementRef } from 'react';
import * as Primitive from '@radix-ui/react-dropdown-menu';
import { cn } from '@/lib/utils';

export const DropdownMenu = Primitive.Root;
export const DropdownMenuTrigger = Primitive.Trigger;

export const DropdownMenuLabel = forwardRef<ElementRef<typeof Primitive.Label>, ComponentPropsWithoutRef<typeof Primitive.Label>>(
  ({ className, ...props }, ref) => (
    <Primitive.Label ref={ref} className={cn('px-2.5 py-1.5 text-xs text-muted-foreground', className)} {...props} />
  ),
);
DropdownMenuLabel.displayName = 'DropdownMenuLabel';

export const DropdownMenuContent = forwardRef<ElementRef<typeof Primitive.Content>, ComponentPropsWithoutRef<typeof Primitive.Content>>(
  ({ className, sideOffset = 6, align = 'end', ...props }, ref) => (
    <Primitive.Portal>
      <Primitive.Content
        ref={ref}
        sideOffset={sideOffset}
        align={align}
        className={cn(
          'z-[70] min-w-48 animate-pop-in rounded-xl border border-border bg-card p-1 text-card-foreground shadow-pop',
          className,
        )}
        {...props}
      />
    </Primitive.Portal>
  ),
);
DropdownMenuContent.displayName = 'DropdownMenuContent';

export const DropdownMenuItem = forwardRef<
  ElementRef<typeof Primitive.Item>,
  ComponentPropsWithoutRef<typeof Primitive.Item> & { destructive?: boolean }
>(({ className, destructive, ...props }, ref) => (
  <Primitive.Item
    ref={ref}
    className={cn(
      'flex cursor-pointer select-none items-center gap-2.5 rounded-lg px-2.5 py-2 text-sm outline-none transition-colors data-[disabled]:pointer-events-none data-[disabled]:opacity-45 data-[highlighted]:bg-muted [&_svg]:size-4 [&_svg]:text-muted-foreground',
      destructive && 'text-destructive data-[highlighted]:bg-destructive/10 [&_svg]:text-destructive',
      className,
    )}
    {...props}
  />
));
DropdownMenuItem.displayName = 'DropdownMenuItem';

export const DropdownMenuSeparator = () => <Primitive.Separator className="-mx-1 my-1 h-px bg-border" />;
