import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Webhooks } from '../../src/studio/webhooks.mjs';

test('localhost webhook registration is itself the intentional owner action', () => {
  const feed = new EventEmitter();
  const hooks = new Webhooks(feed);
  try {
    const registered = hooks.register({ url: 'http://127.0.0.1:5055/events' });
    assert.equal(hooks.list().length, 1);
    assert.equal(registered.url, 'http://127.0.0.1:5055/events');
    assert.equal(typeof registered.secret, 'string');
    assert.equal(hooks.remove(registered.id).deleted, registered.id);
  } finally { hooks.close(); }
});

test('more than sixteen local subscriptions may be registered without a UX gate', () => {
  const hooks = new Webhooks(new EventEmitter());
  try {
    for (let i = 0; i < 20; i++) {
      hooks.register({ url: 'http://127.0.0.1:' + (5100 + i) + '/events' });
    }
    assert.equal(hooks.list().length, 20);
  } finally { hooks.close(); }
});

test('local integrations remain on the PC; remote HTTP webhook endpoints are rejected', () => {
  const hooks = new Webhooks(new EventEmitter(), { forbiddenPorts: () => [7878, 9222] });
  try {
    assert.throws(() => hooks.register({ url: 'https://example.com/events' }), /literal 127.0.0.1/);
    assert.throws(() => hooks.register({ url: 'http://127.0.0.1:7878/events' }), /ports cannot/);
    assert.equal(hooks.list().length, 0);
  } finally { hooks.close(); }
});
