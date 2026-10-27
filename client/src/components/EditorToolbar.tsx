import type { ComponentType } from 'react';
import {
  Bold,
  Code,
  FileCode2,
  Heading1,
  Heading2,
  Heading3,
  Italic,
  Link2,
  List,
  ListChecks,
  ListOrdered,
  Minus,
  Quote,
  Strikethrough,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Tip } from '@/components/ui/tooltip';
import { modKey } from '@/components/ui/kbd';
import type { FormatCommand } from '@/lib/format';

interface Tool {
  command: FormatCommand;
  label: string;
  icon: ComponentType<{ className?: string }>;
  shortcut?: string;
}

const groups: Tool[][] = [
  [
    { command: 'bold', label: 'Bold', icon: Bold, shortcut: `${modKey}+B` },
    { command: 'italic', label: 'Italic', icon: Italic, shortcut: `${modKey}+I` },
    { command: 'strike', label: 'Strikethrough', icon: Strikethrough },
    { command: 'code', label: 'Inline code', icon: Code },
  ],
  [
    { command: 'heading1', label: 'Heading 1', icon: Heading1 },
    { command: 'heading2', label: 'Heading 2', icon: Heading2 },
    { command: 'heading3', label: 'Heading 3', icon: Heading3 },
  ],
  [
    { command: 'bullet', label: 'Bulleted list', icon: List },
    { command: 'ordered', label: 'Numbered list', icon: ListOrdered },
    { command: 'task', label: 'Task list', icon: ListChecks },
    { command: 'quote', label: 'Quote', icon: Quote },
  ],
  [
    { command: 'link', label: 'Link', icon: Link2 },
    { command: 'codeblock', label: 'Code block', icon: FileCode2 },
    { command: 'rule', label: 'Divider', icon: Minus },
  ],
];

export function EditorToolbar({ onFormat, disabled }: { onFormat: (command: FormatCommand) => void; disabled?: boolean }) {
  return (
    <div role="toolbar" aria-label="Formatting" className="flex items-center gap-1 overflow-x-auto px-4 py-1.5 sm:px-8">
      {groups.map((group, index) => (
        <div key={index} className="flex shrink-0 items-center gap-0.5 border-r border-border pr-1 last:border-r-0">
          {group.map(({ command, label, icon: Icon, shortcut }) => (
            <Tip key={command} label={shortcut ? `${label} (${shortcut})` : label}>
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label={label}
                disabled={disabled}
                // Keep the editor's selection: a click must not move focus to the button.
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => onFormat(command)}
              >
                <Icon className="size-4" />
              </Button>
            </Tip>
          ))}
        </div>
      ))}
    </div>
  );
}
