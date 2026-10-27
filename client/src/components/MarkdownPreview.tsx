import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { cn } from '@/lib/utils';

// Raw HTML in notes is not rendered (react-markdown escapes it) and unsafe URL
// schemes such as javascript: are stripped by its default URL transform.
export function MarkdownPreview({ content, monospace }: { content: string; monospace?: boolean }) {
  return (
    <article className={cn('markdown-preview', monospace && 'font-mono text-[0.92rem]')}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{ a: ({ node: _node, ...props }) => <a {...props} target="_blank" rel="noopener noreferrer" /> }}
      >
        {content}
      </ReactMarkdown>
    </article>
  );
}

export default MarkdownPreview;
