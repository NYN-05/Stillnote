import { useEffect, useMemo, useRef } from 'react';
import type { Editor } from '@tiptap/core';
import { EditorContent, useEditor } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import Underline from '@tiptap/extension-underline';
import Link from '@tiptap/extension-link';
import Image from '@tiptap/extension-image';
import Table from '@tiptap/extension-table';
import TableRow from '@tiptap/extension-table-row';
import TableCell from '@tiptap/extension-table-cell';
import TableHeader from '@tiptap/extension-table-header';
import TextAlign from '@tiptap/extension-text-align';
import Placeholder from '@tiptap/extension-placeholder';
import { isSafeLink, sanitizeRichHtml } from '@/lib/richText';
import { cn } from '@/lib/utils';

interface RichTextEditorProps {
  /** Sanitized HTML. The editor is the source of truth while it has focus. */
  value: string;
  onChange: (html: string) => void;
  label: string;
  placeholder?: string;
  editable?: boolean;
  onEditor?: (editor: Editor | null) => void;
  className?: string;
  externalUpdatesImmediate?: boolean;
}

function createExtensions(placeholder: string) {
  return [
    StarterKit.configure({
      heading: { levels: [1, 2, 3, 4, 5, 6] },
      dropcursor: { color: 'var(--primary)', width: 2 },
    }),
    Underline,
    // Keep links inside the editor undecorated until the user uses the toolbar.
    Link.configure({
      openOnClick: false,
      autolink: true,
      linkOnPaste: true,
      protocols: ['http', 'https', 'mailto'],
      HTMLAttributes: { rel: 'noopener noreferrer nofollow', target: '_blank' },
      // The shared policy allows http(s), mailto and relative URLs, and nothing
      // else. Applying it here stops unsafe hrefs from entering the document.
      isAllowedUri: (url) => isSafeLink(url),
      validate: (url) => isSafeLink(url),
    }),
    // Inline images keep the flow of Markdown notes that had images in a paragraph.
    Image.configure({ inline: true, allowBase64: false }),
    Table.configure({ resizable: false, allowTableNodeSelection: true }),
    TableRow,
    TableHeader,
    TableCell,
    TextAlign.configure({ types: ['heading', 'paragraph'] }),
    Placeholder.configure({
      placeholder: ({ node }) => (node.type.name === 'heading' ? 'Heading' : placeholder),
      includeChildren: false,
    }),
  ];
}

/**
 * The single rich-text schema used by the whole client.
 *
 * Content arriving from outside the editor (note switch, a server-sanitized
 * copy, a conflict reload) is applied without emitting an update, and never
 * while the user is typing. That keeps the cursor and undo history intact when
 * an autosave response arrives.
 */
export function RichTextEditor({
  value,
  onChange,
  label,
  placeholder = 'Start with a thought…',
  editable = true,
  onEditor,
  className,
  externalUpdatesImmediate = false,
}: RichTextEditorProps) {
  const editorRef = useRef<Editor | null>(null);
  const lastEmitted = useRef<string | null>(null);
  // A server copy that arrived mid-sentence waits here until focus leaves.
  const pendingExternal = useRef<string | null>(null);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const onEditorRef = useRef(onEditor);
  onEditorRef.current = onEditor;

  // Sanitize the initial document once. Later values are compared and sanitized
  // only when they actually differ from what the editor already holds.
  const initialContent = useRef(sanitizeRichHtml(value));
  const extensions = useMemo(() => createExtensions(placeholder), [placeholder]);

  const editor = useEditor({
    extensions,
    content: initialContent.current,
    editable,
    editorProps: {
      attributes: {
        class: 'rich-text',
        role: 'textbox',
        'aria-multiline': 'true',
        'aria-label': label,
        'aria-placeholder': placeholder,
        spellcheck: 'true',
        autocapitalize: 'sentences',
        autocomplete: 'off',
      },
      // Pasted HTML is reduced to the same allowlist the server enforces before
      // ProseMirror ever parses it. Clipboard text from Word or a browser keeps
      // its structure but loses scripts, styles, frames and unsafe URLs.
      transformPastedHTML: (html) => sanitizeRichHtml(html),
      handleDOMEvents: {
        blur: () => {
          const next = pendingExternal.current;
          const current = editorRef.current;
          pendingExternal.current = null;
          if (!next || !current) return false;
          if (next !== current.getHTML()) {
            current.commands.setContent(next, false);
            lastEmitted.current = current.getHTML();
          }
          return false;
        },
      },
    },
    onCreate: ({ editor: created }) => {
      lastEmitted.current = created.getHTML();
    },
    onUpdate: ({ editor: current }) => {
      const html = current.getHTML();
      lastEmitted.current = html;
      pendingExternal.current = null;
      onChangeRef.current(html);
    },
  });

  useEffect(() => {
    editorRef.current = editor;
    onEditorRef.current?.(editor ?? null);
    return () => {
      editorRef.current = null;
      onEditorRef.current?.(null);
    };
  }, [editor]);

  useEffect(() => {
    editor?.setEditable(editable);
  }, [editor, editable]);

  useEffect(() => {
    if (!editor) return;
    // Our own edit coming back through React state: nothing to apply.
    if (value === lastEmitted.current || value === editor.getHTML()) return;
    const next = sanitizeRichHtml(value);
    if (next === editor.getHTML()) {
      lastEmitted.current = editor.getHTML();
      return;
    }
    // Never move the caret while the user is in the document. The pending copy
    // is applied on blur, after their own edits have already been stored.
    if (editor.isFocused && !externalUpdatesImmediate) {
      pendingExternal.current = next;
      return;
    }
    pendingExternal.current = null;
    editor.commands.setContent(next, false);
    lastEmitted.current = editor.getHTML();
  }, [editor, value, externalUpdatesImmediate]);

  return <EditorContent editor={editor} className={cn('rich-text-host', !editable && 'rich-text-host-readonly', className)} />;
}

export default RichTextEditor;
