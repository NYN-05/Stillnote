import { useEffect, useRef, useState } from 'react';
import { Check, CloudOff, LoaderCircle, Users } from 'lucide-react';
import { CollaborationProvider, type CollaborationStatus } from '@/lib/collaboration';
import { RichTextEditor } from '@/components/RichTextEditor';
import type { Editor } from '@tiptap/core';

interface Props {
  noteId: string;
  value: string;
  onChange: (html: string) => void;
  onEditor?: (editor: Editor | null) => void;
  label: string;
  placeholder?: string;
}

const statusCopy: Record<CollaborationStatus, string> = {
  connecting: 'Connecting…',
  synced: 'Synced',
  offline: 'Offline · changes queued',
  error: 'Sync retrying…',
};

export function CollaborativeRichTextEditor({ noteId, value: initialValue, onChange, onEditor, label, placeholder }: Props) {
  const [value, setValue] = useState(initialValue);
  const [status, setStatus] = useState<CollaborationStatus>('connecting');
  const [collaborators, setCollaborators] = useState(1);
  const providerRef = useRef<CollaborationProvider | null>(null);

  useEffect(() => {
    const provider = new CollaborationProvider(noteId, {
      onContent: (html) => setValue(html),
      onStatus: setStatus,
      onCollaborators: setCollaborators,
    });
    providerRef.current = provider;
    return () => {
      providerRef.current = null;
      provider.destroy();
    };
  }, [noteId]);

  const Icon = status === 'synced' ? Check : status === 'offline' ? CloudOff : LoaderCircle;
  return (
    <>
      <RichTextEditor
        value={value}
        onChange={(html) => {
          providerRef.current?.applyLocalHtml(html);
          onChange(html);
        }}
        onEditor={onEditor}
        label={label}
        placeholder={placeholder}
        externalUpdatesImmediate
      />
      <div className="mt-2 flex items-center gap-3 text-xs text-muted-foreground" role="status" aria-live="polite">
        <span className="flex items-center gap-1">
          <Icon className={`size-3.5 ${status === 'connecting' || status === 'error' ? 'animate-spin' : ''}`} aria-hidden="true" />
          {statusCopy[status]}
        </span>
        {collaborators > 1 && (
          <span className="flex items-center gap-1">
            <Users className="size-3.5" aria-hidden="true" /> {collaborators} editing
          </span>
        )}
      </div>
    </>
  );
}
