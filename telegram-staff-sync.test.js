const assert = require('assert/strict');
const test = require('node:test');
const { createTopicBindingHandler, outboundImportPayload, signedJson } = require('./telegram-staff-sync');

const secret = 'test-relay-secret';
const chatId = '-1001234567890';
const topicId = '42';
const phone = '966500000000';
const context = {
  chat: { id: Number(chatId) },
  message: { message_thread_id: Number(topicId), message_id: 17, date: 1760832000 },
  from: { id: 77 }, update: { update_id: 88 },
};
function response() { return { status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } }; }
function request(payload) { const signed = signedJson(secret, payload); return { body: payload, ajyalRawBody: signed.raw, headers: { 'x-wa-relay-signature': signed.signature } }; }

test('topic resolver accepts only a signed bridge-group topic and returns no sheet metadata', async () => {
  const topics = new Map([[topicId, phone]]);
  const handler = createTopicBindingHandler({ secret, expectedChatId: chatId, phoneByTopic: topics, syncSheetsToMemory: async () => {} });
  const res = response();
  await handler(request({ telegram_chat_id: chatId, telegram_topic_id: topicId }), res);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, { ok: true, recipient_phone: phone });
});

test('topic resolver verifies the exact raw bytes before reading the binding', async () => {
  const handler = createTopicBindingHandler({ secret, expectedChatId: chatId, phoneByTopic: new Map([[topicId, phone]]), syncSheetsToMemory: async () => {} });
  const req = request({ telegram_chat_id: chatId, telegram_topic_id: topicId });
  req.ajyalRawBody = Buffer.from('{"telegram_topic_id":"42","telegram_chat_id":"-1001234567890"}');
  const res = response(); await handler(req, res);
  assert.equal(res.statusCode, 401);
});

test('topic resolver refreshes Sheets once but rejects another bridge chat', async () => {
  const topics = new Map(); let refreshed = 0;
  const handler = createTopicBindingHandler({ secret, expectedChatId: chatId, phoneByTopic: topics, syncSheetsToMemory: async () => { refreshed += 1; topics.set(topicId, phone); } });
  const res = response(); await handler(request({ telegram_chat_id: chatId, telegram_topic_id: topicId }), res);
  assert.equal(res.statusCode, 200); assert.equal(refreshed, 1);
  const denied = response(); await handler(request({ telegram_chat_id: '-1009999999999', telegram_topic_id: topicId }), denied);
  assert.equal(denied.statusCode, 403);
});

test('outbound payload carries accepted Meta and media metadata without verified staff identity', () => {
  const payload = outboundImportPayload({ ctx: context, phone, providerMessageId: 'wamid.test-17', type: 'image', body: 'caption', mediaId: '123456', mediaMime: 'image/png' });
  assert.equal(payload.provider_status, 'accepted');
  assert.equal(payload.accepted_at, payload.sent_at);
  assert.equal(payload.telegram_topic_id, topicId);
  assert.equal(payload.media_id, '123456');
  assert.equal(payload.actor_provenance.staff_identity_verified, false);
  assert.equal(outboundImportPayload({ ctx: context, phone, providerMessageId: 'wamid.test', type: 'image', body: '', mediaId: null, mediaMime: null }), null);
});
