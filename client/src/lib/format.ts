import { EditorSelection, type SelectionRange, type TransactionSpec } from '@codemirror/state';
import type { EditorView } from '@codemirror/view';

export type FormatCommand =
  | 'bold'
  | 'italic'
  | 'strike'
  | 'code'
  | 'heading1'
  | 'heading2'
  | 'heading3'
  | 'bullet'
  | 'ordered'
  | 'task'
  | 'quote'
  | 'codeblock'
  | 'link'
  | 'rule';

const HEADING = /^#{1,6}\s+/;
// Bulleted, numbered and task lists replace one another instead of stacking markers.
const LIST = /^(?:[-*+]|\d+\.)\s+(?:\[[ xX]\]\s+)?/;
const QUOTE = /^>\s?/;

export function runFormat(view: EditorView, command: FormatCommand): boolean {
  switch (command) {
    case 'bold':
      return toggleWrap(view, '**', 'bold text');
    case 'italic':
      return toggleWrap(view, '*', 'italic text');
    case 'strike':
      return toggleWrap(view, '~~', 'struck text');
    case 'code':
      return toggleWrap(view, '`', 'code');
    case 'heading1':
      return toggleLinePrefix(view, '# ', HEADING);
    case 'heading2':
      return toggleLinePrefix(view, '## ', HEADING);
    case 'heading3':
      return toggleLinePrefix(view, '### ', HEADING);
    case 'bullet':
      return toggleLinePrefix(view, '- ', LIST);
    case 'ordered':
      return toggleLinePrefix(view, '1. ', LIST);
    case 'task':
      return toggleLinePrefix(view, '- [ ] ', LIST);
    case 'quote':
      return toggleLinePrefix(view, '> ', QUOTE);
    case 'codeblock':
      return insertCodeBlock(view);
    case 'link':
      return insertLink(view);
    case 'rule':
      return insertRule(view);
  }
}

function finish(view: EditorView, spec: TransactionSpec) {
  view.dispatch(view.state.update(spec, { userEvent: 'input.format', scrollIntoView: true }));
  view.focus();
  return true;
}

/** Wraps the selection in `marker`, or removes the markers when it is already wrapped. */
function toggleWrap(view: EditorView, marker: string, placeholder: string): boolean {
  const { state } = view;
  const length = marker.length;
  const transaction = state.changeByRange((range: SelectionRange) => {
    const outside = marker.length === 1 ? marker : '';
    const before = state.sliceDoc(Math.max(0, range.from - length), range.from);
    const after = state.sliceDoc(range.to, range.to + length);
    // A lone `*` next to another `*` belongs to bold, not italic.
    const crowded =
      outside &&
      (state.sliceDoc(Math.max(0, range.from - length - 1), range.from - length) === outside ||
        state.sliceDoc(range.to + length, range.to + length + 1) === outside);

    if (before === marker && after === marker && !crowded) {
      return {
        changes: [
          { from: range.from - length, to: range.from },
          { from: range.to, to: range.to + length },
        ],
        range: EditorSelection.range(range.from - length, range.to - length),
      };
    }
    const text = state.sliceDoc(range.from, range.to);
    if (text.length >= length * 2 && text.startsWith(marker) && text.endsWith(marker)) {
      const inner = text.slice(length, text.length - length);
      return {
        changes: { from: range.from, to: range.to, insert: inner },
        range: EditorSelection.range(range.from, range.from + inner.length),
      };
    }
    const inner = text || placeholder;
    return {
      changes: { from: range.from, to: range.to, insert: `${marker}${inner}${marker}` },
      range: EditorSelection.range(range.from + length, range.from + length + inner.length),
    };
  });
  return finish(view, transaction);
}

/** Applies a line prefix to every selected line, replacing a prefix of the same family, or removes it. */
function toggleLinePrefix(view: EditorView, prefix: string, family: RegExp): boolean {
  const { state } = view;
  const lines = new Map<number, { from: number; text: string }>();
  for (const range of state.selection.ranges) {
    const first = state.doc.lineAt(range.from).number;
    const last = state.doc.lineAt(range.to).number;
    for (let number = first; number <= last; number += 1) {
      const line = state.doc.line(number);
      lines.set(number, { from: line.from, text: line.text });
    }
  }
  const targets = [...lines.values()].filter((line) => line.text.trim() !== '' || lines.size === 1);
  const allHavePrefix = targets.length > 0 && targets.every((line) => line.text.startsWith(prefix));
  const changes = targets.map((line) => {
    const existing = line.text.match(family)?.[0] ?? '';
    return { from: line.from, to: line.from + existing.length, insert: allHavePrefix ? '' : prefix };
  });
  const changeSet = state.changes(changes);
  // assoc 1 keeps a cursor at the start of a line after the inserted prefix, not in front of it.
  return finish(view, { changes: changeSet, selection: state.selection.map(changeSet, 1) });
}

function insertCodeBlock(view: EditorView): boolean {
  const { state } = view;
  const transaction = state.changeByRange((range) => {
    const text = state.sliceDoc(range.from, range.to);
    const inner = text || 'code';
    const insert = `\`\`\`\n${inner}\n\`\`\``;
    return {
      changes: { from: range.from, to: range.to, insert },
      range: EditorSelection.range(range.from + 4, range.from + 4 + inner.length),
    };
  });
  return finish(view, transaction);
}

function insertLink(view: EditorView): boolean {
  const { state } = view;
  const transaction = state.changeByRange((range) => {
    const text = state.sliceDoc(range.from, range.to) || 'link text';
    const url = 'https://';
    const urlStart = range.from + text.length + 3;
    return {
      changes: { from: range.from, to: range.to, insert: `[${text}](${url})` },
      range: EditorSelection.range(urlStart, urlStart + url.length),
    };
  });
  return finish(view, transaction);
}

function insertRule(view: EditorView): boolean {
  const { state } = view;
  const transaction = state.changeByRange((range) => {
    const insert = '\n\n---\n\n';
    return { changes: { from: range.from, to: range.to, insert }, range: EditorSelection.cursor(range.from + insert.length) };
  });
  return finish(view, transaction);
}
