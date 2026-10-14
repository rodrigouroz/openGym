import test from 'node:test';
import assert from 'node:assert/strict';
import { createECDH, randomBytes } from 'node:crypto';
import webpush from 'web-push';
import { pushEndpointError, sendNotification } from '../push.js';

test('Web Push encrypts a payload over fetch, rejects redirects and limits destinations to browser vendors', async t => {
  for (const url of ['http://fcm.googleapis.com/a', 'https://127.0.0.1/a', 'https://fcm.googleapis.com.evil.test/a', 'https://u:p@web.push.apple.com/a', 'https://web.push.apple.com:444/a']) assert.ok(pushEndpointError(url));
  assert.equal(pushEndpointError('https://updates.push.services.mozilla.com/a'), null);
  const ecdh = createECDH('prime256v1'); ecdh.generateKeys();
  const subscription = { endpoint: 'https://fcm.googleapis.com/synthetic', keys: { p256dh: ecdh.getPublicKey().toString('base64url'), auth: randomBytes(16).toString('base64url') } };
  const vapid = webpush.generateVAPIDKeys();
  const options = { vapidDetails: { subject: 'mailto:fixture@example.com', ...vapid } };
  let sent;
  const original = globalThis.fetch; t.after(() => { globalThis.fetch = original; });
  globalThis.fetch = async (url, init) => { sent = { url, ...init }; return new Response(null, { status: 201 }); };
  await sendNotification(subscription, 'synthetic rest timer', options);
  assert.equal(sent.redirect, 'error'); assert.equal(sent.method, 'POST');
  assert.equal(sent.headers['Content-Encoding'], 'aes128gcm');
  assert.ok(!Buffer.from(sent.body).includes(Buffer.from('synthetic rest timer')));
  globalThis.fetch = async () => new Response(null, { status: 410 });
  await assert.rejects(sendNotification(subscription, 'synthetic', options), e => e.statusCode === 410);
});
