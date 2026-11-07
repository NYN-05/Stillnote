import * as Y from 'yjs';

export type CollaborationStatus = 'connecting' | 'synced' | 'offline' | 'error';

interface CollaborationEvents {
  onContent: (html: string) => void;
  onStatus: (status: CollaborationStatus) => void;
  onCollaborators: (count: number) => void;
}

const REMOTE = Symbol('remote');

export class CollaborationProvider {
  readonly doc = new Y.Doc();
  private readonly text = this.doc.getText('html');
  private readonly events: CollaborationEvents;
  private socket: WebSocket | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;
  private ready = false;
  private pendingLocalHtml: string | null = null;

  constructor(noteId: string, events: CollaborationEvents) {
    this.events = events;
    this.doc.on('update', (update, origin) => {
      if (origin === REMOTE) {
        this.events.onContent(this.text.toString());
        return;
      }
      this.send(update);
    });
    this.connect(noteId);
  }

  applyLocalHtml(next: string) {
    if (!this.ready) {
      this.pendingLocalHtml = next;
      return;
    }
    const current = this.text.toString();
    if (current === next) return;
    let prefix = 0;
    while (prefix < current.length && prefix < next.length && current[prefix] === next[prefix]) prefix += 1;
    let currentEnd = current.length;
    let nextEnd = next.length;
    while (currentEnd > prefix && nextEnd > prefix && current[currentEnd - 1] === next[nextEnd - 1]) {
      currentEnd -= 1;
      nextEnd -= 1;
    }
    this.doc.transact(() => {
      if (currentEnd > prefix) this.text.delete(prefix, currentEnd - prefix);
      if (nextEnd > prefix) this.text.insert(prefix, next.slice(prefix, nextEnd));
    });
  }

  destroy() {
    this.stopped = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.socket?.close();
    this.doc.destroy();
  }

  private connect(noteId: string) {
    if (this.stopped) return;
    this.events.onStatus('connecting');
    const configured = import.meta.env.VITE_WS_URL as string | undefined;
    const base = configured || `${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}`;
    const socket = new WebSocket(`${base}/ws/documents/${encodeURIComponent(noteId)}`);
    this.socket = socket;
    socket.onopen = () => {
      this.send(Y.encodeStateAsUpdate(this.doc));
    };
    socket.onmessage = (event) => {
      try {
        const message = JSON.parse(event.data) as { type: string; update?: string; collaborators?: number };
        if (typeof message.collaborators === 'number') this.events.onCollaborators(message.collaborators);
        if (message.type === 'sync' || message.type === 'update') {
          if (!message.update) return;
          Y.applyUpdate(
            this.doc,
            Uint8Array.from(atob(message.update), (char) => char.charCodeAt(0)),
            REMOTE,
          );
          if (message.type === 'sync') {
            this.ready = true;
            const pending = this.pendingLocalHtml;
            this.pendingLocalHtml = null;
            if (pending !== null) this.applyLocalHtml(pending);
          }
          this.events.onStatus('synced');
        } else if (message.type === 'persistence-error') {
          this.events.onStatus('error');
        }
      } catch {
        this.events.onStatus('error');
      }
    };
    socket.onclose = () => {
      if (this.stopped) return;
      this.events.onStatus('offline');
      this.reconnectTimer = setTimeout(() => this.connect(noteId), 1_000);
    };
    socket.onerror = () => this.events.onStatus('offline');
  }

  private send(update: Uint8Array) {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) return;
    const binary = String.fromCharCode(...update);
    this.socket.send(JSON.stringify({ type: 'sync', update: btoa(binary) }));
  }
}
