import type { ComponentType } from 'react';
import type { Editor } from '@tiptap/core';
import { useEditorState } from '@tiptap/react';
import { toast } from 'sonner';
import {
  AlignCenter,
  AlignLeft,
  AlignRight,
  Bold,
  Code,
  FileCode2,
  Heading1,
  Heading2,
  Heading3,
  Italic,
  Link2,
  List,
  ListOrdered,
  Minus,
  Quote,
  Redo2,
  Strikethrough,
  Underline,
  Undo2,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Tip } from '@/components/ui/tooltip';
import { modKey } from '@/components/ui/kbd';
import { isSafeLink, normalizeLinkUrl } from '@/lib/richText';

interface ToolbarSnapshot {
  bold: boolean;
  italic: boolean;
  underline: boolean;
  strike: boolean;
  code: boolean;
  heading1: boolean;
  heading2: boolean;
  heading3: boolean;
  bullet: boolean;
  ordered: boolean;
  quote: boolean;
  codeblock: boolean;
  link: boolean;
  alignLeft: boolean;
  alignCenter: boolean;
  alignRight: boolean;
  canUndo: boolean;
  canRedo: boolean;
}

const emptySnapshot: ToolbarSnapshot = {
  bold: false,
  italic: false,
  underline: false,
  strike: false,
  code: false,
  heading1: false,
  heading2: false,
  heading3: false,
  bullet: false,
  ordered: false,
  quote: false,
  codeblock: false,
  link: false,
  alignLeft: false,
  alignCenter: false,
  alignRight: false,
  canUndo: false,
  canRedo: false,
};

interface Tool {
  id: string;
  label: string;
  icon: ComponentType<{ className?: string }>;
  shortcut?: string;
  active?: keyof ToolbarSnapshot;
  run: () => void;
  disabled?: boolean;
}

export function EditorToolbar({ editor, disabled = false }: { editor: Editor; disabled?: boolean }) {
  const snapshot =
    useEditorState({
      editor,
      selector: ({ editor: current }) => ({
        bold: current.isActive('bold'),
        italic: current.isActive('italic'),
        underline: current.isActive('underline'),
        strike: current.isActive('strike'),
        code: current.isActive('code'),
        heading1: current.isActive('heading', { level: 1 }),
        heading2: current.isActive('heading', { level: 2 }),
        heading3: current.isActive('heading', { level: 3 }),
        bullet: current.isActive('bulletList'),
        ordered: current.isActive('orderedList'),
        quote: current.isActive('blockquote'),
        codeblock: current.isActive('codeBlock'),
        link: current.isActive('link'),
        alignLeft: current.isActive({ textAlign: 'left' }),
        alignCenter: current.isActive({ textAlign: 'center' }),
        alignRight: current.isActive({ textAlign: 'right' }),
        canUndo: current.can().undo(),
        canRedo: current.can().redo(),
      }),
    }) ?? emptySnapshot;

  const addLink = () => {
    const previous = editor.getAttributes('link').href as string | undefined;
    const answer = window.prompt('Link URL', previous ?? 'https://');
    if (answer === null) return;
    const url = normalizeLinkUrl(answer);
    if (!url) {
      editor.chain().focus().extendMarkRange('link').unsetLink().run();
      return;
    }
    if (!isSafeLink(url)) {
      toast.error('Use an http(s), mailto, or relative link.');
      return;
    }
    editor.chain().focus().extendMarkRange('link').setLink({ href: url }).run();
  };

  const groups: Tool[][] = [
    [
      {
        id: 'undo',
        label: 'Undo',
        icon: Undo2,
        shortcut: `${modKey}+Z`,
        run: () => editor.chain().focus().undo().run(),
        disabled: !snapshot.canUndo,
      },
      {
        id: 'redo',
        label: 'Redo',
        icon: Redo2,
        shortcut: `${modKey}+Shift+Z`,
        run: () => editor.chain().focus().redo().run(),
        disabled: !snapshot.canRedo,
      },
    ],
    [
      {
        id: 'bold',
        label: 'Bold',
        icon: Bold,
        shortcut: `${modKey}+B`,
        active: 'bold',
        run: () => editor.chain().focus().toggleBold().run(),
      },
      {
        id: 'italic',
        label: 'Italic',
        icon: Italic,
        shortcut: `${modKey}+I`,
        active: 'italic',
        run: () => editor.chain().focus().toggleItalic().run(),
      },
      {
        id: 'underline',
        label: 'Underline',
        icon: Underline,
        shortcut: `${modKey}+U`,
        active: 'underline',
        run: () => editor.chain().focus().toggleUnderline().run(),
      },
      {
        id: 'strike',
        label: 'Strikethrough',
        icon: Strikethrough,
        active: 'strike',
        run: () => editor.chain().focus().toggleStrike().run(),
      },
      {
        id: 'code',
        label: 'Inline code',
        icon: Code,
        active: 'code',
        run: () => editor.chain().focus().toggleCode().run(),
      },
    ],
    [
      {
        id: 'heading1',
        label: 'Heading 1',
        icon: Heading1,
        active: 'heading1',
        run: () => editor.chain().focus().toggleHeading({ level: 1 }).run(),
      },
      {
        id: 'heading2',
        label: 'Heading 2',
        icon: Heading2,
        active: 'heading2',
        run: () => editor.chain().focus().toggleHeading({ level: 2 }).run(),
      },
      {
        id: 'heading3',
        label: 'Heading 3',
        icon: Heading3,
        active: 'heading3',
        run: () => editor.chain().focus().toggleHeading({ level: 3 }).run(),
      },
    ],
    [
      {
        id: 'bullet',
        label: 'Bulleted list',
        icon: List,
        active: 'bullet',
        run: () => editor.chain().focus().toggleBulletList().run(),
      },
      {
        id: 'ordered',
        label: 'Numbered list',
        icon: ListOrdered,
        active: 'ordered',
        run: () => editor.chain().focus().toggleOrderedList().run(),
      },
      {
        id: 'quote',
        label: 'Quote',
        icon: Quote,
        active: 'quote',
        run: () => editor.chain().focus().toggleBlockquote().run(),
      },
    ],
    [
      {
        id: 'link',
        label: 'Link',
        icon: Link2,
        active: 'link',
        run: addLink,
      },
      {
        id: 'codeblock',
        label: 'Code block',
        icon: FileCode2,
        active: 'codeblock',
        run: () => editor.chain().focus().toggleCodeBlock().run(),
      },
      {
        id: 'rule',
        label: 'Divider',
        icon: Minus,
        run: () => editor.chain().focus().setHorizontalRule().run(),
      },
    ],
    [
      {
        id: 'align-left',
        label: 'Align left',
        icon: AlignLeft,
        active: 'alignLeft',
        run: () => editor.chain().focus().setTextAlign('left').run(),
      },
      {
        id: 'align-center',
        label: 'Align center',
        icon: AlignCenter,
        active: 'alignCenter',
        run: () => editor.chain().focus().setTextAlign('center').run(),
      },
      {
        id: 'align-right',
        label: 'Align right',
        icon: AlignRight,
        active: 'alignRight',
        run: () => editor.chain().focus().setTextAlign('right').run(),
      },
    ],
  ];

  return (
    <div role="toolbar" aria-label="Formatting" className="flex items-center gap-1 overflow-x-auto px-4 py-1.5 sm:px-8">
      {groups.map((group, index) => (
        <div key={index} className="flex shrink-0 items-center gap-0.5 border-r border-border pr-1 last:border-r-0">
          {group.map(({ id, label, icon: Icon, shortcut, active, run, disabled: toolDisabled }) => {
            const pressed = active ? snapshot[active] : undefined;
            return (
              <Tip key={id} label={shortcut ? `${label} (${shortcut})` : label}>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label={label}
                  aria-pressed={pressed}
                  disabled={disabled || toolDisabled}
                  // Keep the editor's selection: a click must not move focus to the button.
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={run}
                  className={pressed ? 'bg-accent text-accent-foreground' : undefined}
                >
                  <Icon className="size-4" />
                </Button>
              </Tip>
            );
          })}
        </div>
      ))}
    </div>
  );
}
