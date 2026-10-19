const crypto = require('crypto');

const CHAT_ID = /^-?[1-9][0-9]{0,19}$/;
const POSITIVE_ID = /^[1-9][0-9]{0,19}$/;

function hmacSignature(secret, raw) {
  return `sha256=${crypto.createHmac('sha256', String(secret)).update(raw).digest('hex')}`;
}

function sameSignature(expected, received) {
  const a = Buffer.from(String(expected));
  const b = Buffer.from(String(received || ''));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function signedJson(secret, payload) {
  const raw = Buffer.from(JSON.stringify(payload));
  return { raw, signature: hmacSignature(secret, raw) };
}

function writeJson(res, status, body) {
  if (typeof res.status === 'function') return res.status(status).json(body);
  res.statusCode = status;
  res.body = body;
  return res;
}

function createTopicBindingHandler({ secret, expectedChatId, phoneByTopic, syncSheetsToMemory }) {
  return async (req, res) => {
    if (!secret) return writeJson(res, 503, { ok: false, error: 'relay signing is unavailable' });
    const raw = req.ajyalRawBody;
    const signature = req.headers?.['x-wa-relay-signature'];
    if (!Buffer.isBuffer(raw) || !sameSignature(hmacSignature(secret, raw), signature)) {
      return writeJson(res, 401, { ok: false, error: 'invalid relay signature' });
    }

    const chatId = String(req.body?.telegram_chat_id || '');
    const topicId = String(req.body?.telegram_topic_id || '');
    if (!CHAT_ID.test(chatId) || !POSITIVE_ID.test(topicId)) {
      return writeJson(res, 400, { ok: false, error: 'invalid Telegram binding identity' });
    }
    if (chatId !== String(expectedChatId)) {
      return writeJson(res, 403, { ok: false, error: 'Telegram chat is outside this bridge' });
    }

    let phone = phoneByTopic.get(topicId);
    if (!phone) {
      try {
        await syncSheetsToMemory();
      } catch {
        return writeJson(res, 503, { ok: false, error: 'binding source unavailable' });
      }
      phone = phoneByTopic.get(topicId);
    }
    if (!phone) return writeJson(res, 404, { ok: false, error: 'unknown Telegram topic' });
    return writeJson(res, 200, { ok: true, recipient_phone: String(phone) });
  };
}

function outboundImportPayload({ ctx, phone, providerMessageId, type, body, mediaId = null, mediaMime = null }) {
  const chatId = String(ctx?.chat?.id || '');
  const topicId = String(ctx?.message?.message_thread_id || '');
  const messageId = String(ctx?.message?.message_id || '');
  const telegramUserId = String(ctx?.from?.id || '');
  const updateId = ctx?.update?.update_id == null ? null : String(ctx.update.update_id);
  const sentAt = ctx?.message?.date ? new Date(ctx.message.date * 1000).toISOString() : null;
  const normalizedPhone = String(phone || '').replace(/[^0-9]/g, '');
  if (!CHAT_ID.test(chatId) || !POSITIVE_ID.test(topicId) || !POSITIVE_ID.test(messageId)
    || !POSITIVE_ID.test(telegramUserId) || !/^wamid\.[^\s]+$/.test(String(providerMessageId || ''))
    || !/^[1-9][0-9]{7,14}$/.test(normalizedPhone) || !sentAt) return null;
  if (!['text', 'image', 'audio', 'video', 'document', 'sticker'].includes(type)) return null;
  if (type === 'text' && !String(body || '').trim()) return null;
  if (type !== 'text' && (!/^[0-9]{6,40}$/.test(String(mediaId || ''))
    || !/^[a-z0-9.+-]+\/[a-z0-9.+-]+$/i.test(String(mediaMime || '')))) return null;

  return {
    source: 'telegram', direction: 'outbound', provider_status: 'accepted',
    phone: normalizedPhone, body: String(body || ''), type, media_id: mediaId, media_mime: mediaMime,
    telegram_chat_id: chatId, telegram_topic_id: topicId, telegram_message_id: messageId,
    telegram_update_id: updateId, telegram_user_id: telegramUserId,
    provider_message_id: String(providerMessageId), accepted_at: sentAt, sent_at: sentAt,
    actor_provenance: {
      source: 'telegram_update', telegram_user_id: telegramUserId,
      telegram_update_id: updateId, staff_identity_verified: false, staff_auth_user_id: null,
    },
  };
}

module.exports = { createTopicBindingHandler, hmacSignature, outboundImportPayload, sameSignature, signedJson };
