import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react';
import { Annotation, Compartment, EditorState } from '@codemirror/state';
import { EditorView, keymap, placeholder as placeholderExtension } from '@codemirror/view';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { tags } from '@lezer/highlight';
import { runFormat, type FormatCommand } from '@/lib/format';
import { cn } from '@/lib/utils';

export interface EditorHandle {
  format: (command: FormatCommand) => void;
  focus: () => void;
}

interface MarkdownEditorProps {
  value: string;
  onChange: (value: string) => void;
  readOnly?: boolean;
  monospace?: boolean;
  placeholder?: string;
  label: string;
  className?: string;
}

// Colors come from CSS variables, so the editor follows the light and dark themes.
const highlightStyle = HighlightStyle.define([
  { tag: tags.heading1, fontWeight: '700', fontSize: '1.45em', color: 'var(--foreground)' },
  { tag: tags.heading2, fontWeight: '700', fontSize: '1.25em', color: 'var(--foreground)' },
  { tag: [tags.heading3, tags.heading4, tags.heading5, tags.heading6], fontWeight: '650', color: 'var(--foreground)' },
  { tag: tags.strong, fontWeight: '700' },
  { tag: tags.emphasis, fontStyle: 'italic' },
  { tag: tags.strikethrough, textDecoration: 'line-through', color: 'var(--muted-foreground)' },
  { tag: tags.link, color: 'var(--primary)' },
  { tag: tags.url, color: 'var(--primary)' },
  { tag: tags.monospace, fontFamily: 'var(--font-mono)', fontSize: '0.9em', color: 'var(--accent-foreground)' },
  { tag: tags.quote, color: 'var(--muted-foreground)' },
  { tag: [tags.processingInstruction, tags.meta, tags.contentSeparator], color: 'var(--muted-foreground)' },
]);

// Changes made by syncing from outside must not be echoed back as user edits.
const external = Annotation.define<boolean>();

export const MarkdownEditor = forwardRef<EditorHandle, MarkdownEditorProps>(
  ({ value, onChange, readOnly = false, monospace = false, placeholder = '', label, className }, ref) => {
    const host = useRef<HTMLDivElement>(null);
    const viewRef = useRef<EditorView | null>(null);
    const onChangeRef = useRef(onChange);
    const editable = useRef(new Compartment());
    onChangeRef.current = onChange;

    useImperativeHandle(
      ref,
      () => ({
        format: (command) => {
          if (viewRef.current) runFormat(viewRef.current, command);
        },
        focus: () => viewRef.current?.focus(),
      }),
      [],
    );

    useEffect(() => {
      const view = new EditorView({
        parent: host.current!,
        state: EditorState.create({
          doc: value,
          extensions: [
            history(),
            keymap.of([
              { key: 'Mod-b', run: (v) => runFormat(v, 'bold') },
              { key: 'Mod-i', run: (v) => runFormat(v, 'italic') },
              indentWithTab,
              ...defaultKeymap,
              ...historyKeymap,
            ]),
            markdown({ base: markdownLanguage }),
            syntaxHighlighting(highlightStyle),
            EditorView.lineWrapping,
            placeholderExtension(placeholder),
            EditorView.contentAttributes.of({ 'aria-label': label, 'aria-multiline': 'true', spellcheck: 'true' }),
            editable.current.of([EditorView.editable.of(!readOnly), EditorState.readOnly.of(readOnly)]),
            EditorView.updateListener.of((update) => {
              if (update.docChanged && !update.transactions.some((tr) => tr.annotation(external))) {
                onChangeRef.current(update.state.doc.toString());
              }
            }),
          ],
        }),
      });
      viewRef.current = view;
      return () => {
        view.destroy();
        viewRef.current = null;
      };
      // The editor is created once per mount; props below are synced by their own effects.
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    useEffect(() => {
      const view = viewRef.current;
      if (!view || view.state.doc.toString() === value) return;
      view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: value }, annotations: external.of(true) });
    }, [value]);

    useEffect(() => {
      viewRef.current?.dispatch({
        effects: editable.current.reconfigure([EditorView.editable.of(!readOnly), EditorState.readOnly.of(readOnly)]),
      });
    }, [readOnly]);

    return <div ref={host} className={cn('note-editor', monospace && 'editor-mono', className)} />;
  },
);
MarkdownEditor.displayName = 'MarkdownEditor';

export default MarkdownEditor;
