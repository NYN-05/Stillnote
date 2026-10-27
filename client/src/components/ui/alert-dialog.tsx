import type { ReactNode } from 'react';
import * as Primitive from '@radix-ui/react-alert-dialog';
import { Button } from './button';

interface ConfirmDialogProps {
  open: boolean;
  title: string;
  description: ReactNode;
  confirmLabel: string;
  destructive?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

export function ConfirmDialog({ open, title, description, confirmLabel, destructive = true, onConfirm, onCancel }: ConfirmDialogProps) {
  return (
    <Primitive.Root
      open={open}
      onOpenChange={(next) => {
        if (!next) onCancel();
      }}
    >
      <Primitive.Portal>
        <Primitive.Overlay className="fixed inset-0 z-[60] animate-fade-in bg-black/50 backdrop-blur-[2px]" />
        <Primitive.Content className="fixed left-1/2 top-1/2 z-[61] w-[calc(100vw-2rem)] max-w-md -translate-x-1/2 -translate-y-1/2 animate-pop-in rounded-2xl border border-border bg-card p-6 text-card-foreground shadow-pop">
          <Primitive.Title className="text-base font-semibold">{title}</Primitive.Title>
          <Primitive.Description className="mt-2 text-sm leading-6 text-muted-foreground">{description}</Primitive.Description>
          <div className="mt-6 flex justify-end gap-2">
            <Primitive.Cancel asChild>
              <Button variant="outline">Cancel</Button>
            </Primitive.Cancel>
            <Primitive.Action asChild>
              <Button variant={destructive ? 'destructive' : 'primary'} onClick={onConfirm}>
                {confirmLabel}
              </Button>
            </Primitive.Action>
          </div>
        </Primitive.Content>
      </Primitive.Portal>
    </Primitive.Root>
  );
}
