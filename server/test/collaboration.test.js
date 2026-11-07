const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const Y = require('yjs');
const { CollaborationHub } = require('../src/collaboration');

class FakeSocket extends EventEmitter {
  readyState = 1;
  messages = [];

  send(value) {
    this.messages.push(JSON.parse(value));
  }

  close() {
    this.readyState = 3;
    this.emit('close');
  }
}

function updateMessage(doc) {
  return { type: 'sync', update: Buffer.from(Y.encodeStateAsUpdate(doc)).toString('base64') };
}

test('merges concurrent edits from two document sessions and persists the merged state', async () => {
  let persisted = null;
  const hub = new CollaborationHub({
    store: {
      async get() {
        return { content: '<p>start</p>' };
      },
      async getCollaborationState() {
        return null;
      },
      async saveCollaborationState(_userId, _id, state, content) {
        persisted = { state, content };
        return 2;
      },
    },
    logger: {},
  });
  const first = new FakeSocket();
  const second = new FakeSocket();
  await hub.open('user', 'note', first);
  await hub.open('user', 'note', second);

  const firstDoc = new Y.Doc();
  const secondDoc = new Y.Doc();
  Y.applyUpdate(firstDoc, Uint8Array.from(Buffer.from(first.messages.find((message) => message.type === 'sync').update, 'base64')));
  Y.applyUpdate(secondDoc, Uint8Array.from(Buffer.from(second.messages.find((message) => message.type === 'sync').update, 'base64')));
  firstDoc.getText('html').insert(12, ' first');
  secondDoc.getText('html').insert(12, ' second');
  first.emit('message', JSON.stringify(updateMessage(firstDoc)));
  second.emit('message', JSON.stringify(updateMessage(secondDoc)));

  await new Promise((resolve) => setTimeout(resolve, 850));
  const room = hub.rooms.get('user:note');
  assert.match(room.doc.getText('html').toString(), /first/);
  assert.match(room.doc.getText('html').toString(), /second/);
  assert.equal(persisted.content.includes('first'), true);
  assert.equal(persisted.content.includes('second'), true);
  await hub.close();
});
