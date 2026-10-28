'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {loadHistoryHelpers} = require('./helpers/browser');

const {history} = loadHistoryHelpers();

function makeRecord(id, overrides = {}) {
  const channelId = overrides.channelId ?? 'channel-1';
  return {
    id,
    channelId,
    message: {id, channel_id: channelId, content: `content-${id}`, timestamp: overrides.timestamp},
    content: `content-${id}`,
    renderedContentHtml: `<b>${id}</b>`,
    richHtml: '',
    replyHtml: '',
    avatarUrl: '',
    authorColor: '',
    deletedAt: overrides.deletedAt ?? 0,
    editedAt: overrides.editedAt ?? 0,
    originalContent: '',
    originalHtml: '',
    edits: [],
  };
}

test('ensureChannel creates channel buckets on demand', () => {
  const map = new Map();
  const state = history.ensureChannel(map, '123');
  assert.deepEqual([...map.keys()], ['123']);
  assert.equal(state.deleted.size, 0);
  assert.equal(history.ensureChannel(map, '123'), state);
  assert.equal(history.ensureChannel(map, ''), null);
});

test('serializeHistory skips empty buckets and keeps saved records', () => {
  const map = new Map();
  history.ensureChannel(map, 'empty');
  history.ensureChannel(map, 'a').deleted.set('1', makeRecord('1', {channelId: 'a', deletedAt: 100}));
  history.ensureChannel(map, 'b').edited.set('2', makeRecord('2', {channelId: 'b', editedAt: 200}));

  const saved = history.serializeHistory(map);
  assert.equal(saved.version, 1);
  assert.deepEqual(Object.keys(saved.channels).sort(), ['a', 'b']);
  assert.equal(saved.channels.a.deleted[0].id, '1');
  assert.equal(saved.channels.b.edited[0].id, '2');
});

test('importHistory normalises records, ignores duplicates, and reports changes', () => {
  const map = new Map();
  const changed = history.importHistory(map, {
    channels: {
      c1: {
        deleted: [
          {id: '1', content: 'one'},
          {id: '1', content: 'duplicate'},
          {content: 'missing id'},
        ],
        edited: [{id: '2', message: {content: 'two'}, edits: [{content: 'old', at: 1}]}],
      },
      bad: null,
    },
  });

  assert.equal(changed, true);
  const state = map.get('c1');
  assert.equal(state.deleted.size, 1);
  assert.equal(state.deleted.get('1').channelId, 'c1');
  assert.equal(state.deleted.get('1').message.channel_id, 'c1');
  assert.equal(state.edited.get('2').content, 'two');
  assert.deepEqual(state.edited.get('2').edits, [{content: 'old', at: 1}]);
  assert.equal(history.importHistory(map, null), false);
});

test('enforceLimits keeps the newest records per channel', () => {
  const map = new Map();
  const state = history.ensureChannel(map, 'c');
  for (let index = 0; index < 5; index += 1) {
    state.deleted.set(String(index), makeRecord(String(index), {
      channelId: 'c',
      deletedAt: 1000 + index,
    }));
  }

  history.enforceLimits(map, {maxPerChannel: 3, maxTotal: 100});
  assert.deepEqual([...state.deleted.keys()].sort(), ['2', '3', '4']);
});

test('enforceLimits applies the global cap across channels', () => {
  const map = new Map();
  for (const channelId of ['a', 'b', 'c']) {
    const state = history.ensureChannel(map, channelId);
    for (let index = 0; index < 2; index += 1) {
      const id = `${channelId}${index}`;
      state.deleted.set(id, makeRecord(id, {
        channelId,
        deletedAt: 1000 + index + (channelId.charCodeAt(0) - 97) * 10,
      }));
    }
  }

  history.enforceLimits(map, {maxPerChannel: 10, maxTotal: 2});
  const remaining = [];
  for (const [, state] of map) remaining.push(...state.deleted.keys());
  assert.deepEqual(remaining.sort(), ['c0', 'c1']);
});

test('recordTimestamp handles numbers, ISO strings, and missing values', () => {
  assert.equal(history.recordTimestamp({deletedAt: 1234}), 1234);
  assert.equal(history.recordTimestamp({message: {timestamp: '2026-01-02T03:04:05.000Z'}}), Date.parse('2026-01-02T03:04:05.000Z'));
  assert.equal(history.recordTimestamp({}), 0);
});

test('snowflakeTimestamp extracts a timestamp and tolerates invalid ids', () => {
  assert.equal(history.snowflakeTimestamp('0'), 1420070400000);
  assert.equal(history.snowflakeTimestamp('not-a-snowflake'), 0);
});

test('channelIdFromPath matches channel routes and known channels', () => {
  assert.equal(history.channelIdFromPath('/channels/@me/123'), '123');
  assert.equal(history.channelIdFromPath('/channels/guild/456/message-789'), 'message-789');
  assert.equal(history.channelIdFromPath('/channels/guild/456/message-789', (id) => id === '456'), '456');
  assert.equal(history.channelIdFromPath('/channels/guild/456/', (id) => id === '456'), '456');
  assert.equal(history.channelIdFromPath('/settings'), null);
  assert.equal(history.channelIdFromPath('/channels/@me'), null);
});
