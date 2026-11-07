const Y = require('yjs');

const textName = 'html';
const PERSIST_DELAY = 750;
const SNAPSHOT_INTERVAL = 30_000;

function encode(update) {
  return Buffer.from(update).toString('base64');
}

function decode(value) {
  return new Uint8Array(Buffer.from(value, 'base64'));
}

class CollaborationHub {
  constructor({ store, logger = console }) {
    this.store = store;
    this.logger = logger;
    this.rooms = new Map();
  }

  async open(userId, documentId, socket) {
    const room = await this.getRoom(userId, documentId);
    room.clients.add(socket);
    this.send(socket, { type: 'sync', update: encode(Y.encodeStateAsUpdate(room.doc)), collaborators: room.clients.size });
    socket.on('close', () => {
      room.clients.delete(socket);
      this.broadcastPresence(room);
      if (room.clients.size === 0) this.scheduleRoomCleanup(room);
    });
    socket.on('message', (raw) => this.receive(room, socket, raw));
    this.broadcastPresence(room);
    return room;
  }

  async getRoom(userId, documentId) {
    const key = `${userId}:${documentId}`;
    const existing = this.rooms.get(key);
    if (existing) return existing;
    const document = await this.store.get(userId, documentId);
    if (!document) throw Object.assign(new Error('Document not found.'), { statusCode: 404 });
    const doc = new Y.Doc();
    const persisted = await this.store.getCollaborationState(userId, documentId);
    if (persisted) Y.applyUpdate(doc, new Uint8Array(persisted));
    else doc.getText(textName).insert(0, document.content);
    const room = {
      key,
      userId,
      documentId,
      doc,
      clients: new Set(),
      dirty: false,
      persistTimer: null,
      snapshotAt: Date.now(),
    };
    doc.on('update', () => {
      room.dirty = true;
      this.schedulePersist(room);
      for (const client of room.clients) this.send(client, { type: 'update', update: encode(Y.encodeStateAsUpdate(doc)) });
    });
    this.rooms.set(key, room);
    return room;
  }

  receive(room, sender, raw) {
    let message;
    try {
      message = JSON.parse(raw.toString());
    } catch {
      return;
    }
    if (message.type !== 'sync' || typeof message.update !== 'string') return;
    try {
      Y.applyUpdate(room.doc, decode(message.update), sender);
    } catch (error) {
      this.logger.warn?.({ error }, 'Ignoring invalid collaboration update');
    }
  }

  schedulePersist(room) {
    if (room.persistTimer) return;
    room.persistTimer = setTimeout(() => {
      room.persistTimer = null;
      void this.persist(room);
    }, PERSIST_DELAY);
  }

  async persist(room) {
    if (!room.dirty) return;
    room.dirty = false;
    try {
      const version = await this.store.saveCollaborationState(
        room.userId,
        room.documentId,
        Buffer.from(Y.encodeStateAsUpdate(room.doc)),
        room.doc.getText(textName).toString(),
      );
      if (Date.now() - room.snapshotAt >= SNAPSHOT_INTERVAL) room.snapshotAt = Date.now();
      this.broadcast(room, { type: 'persisted', version });
    } catch (error) {
      room.dirty = true;
      this.logger.error?.({ error }, 'Could not persist collaboration update');
      this.broadcast(room, { type: 'persistence-error' });
    }
  }

  scheduleRoomCleanup(room) {
    setTimeout(() => {
      if (room.clients.size === 0) {
        void this.persist(room);
        this.rooms.delete(room.key);
        room.doc.destroy();
      }
    }, 5_000).unref();
  }

  broadcast(room, message) {
    for (const client of room.clients) this.send(client, message);
  }

  broadcastPresence(room) {
    this.broadcast(room, { type: 'presence', collaborators: room.clients.size });
  }

  send(socket, message) {
    if (socket.readyState === 1) socket.send(JSON.stringify(message));
  }

  async close() {
    await Promise.all([...this.rooms.values()].map((room) => this.persist(room)));
    this.rooms.clear();
  }
}

module.exports = { CollaborationHub };
