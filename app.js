const express = require('express');
const axios = require('axios');
const { Telegraf } = require('telegraf');
const FormData = require('form-data');
const { google } = require('googleapis');
const fs = require('fs/promises');
const path = require('path');

const app = express();
app.use(express.json({ limit: '2mb' }));

const env = (key, fallback = undefined) => {
  const value = process.env[key] ?? fallback;
  if (value === undefined || value === '') throw new Error(`Missing env: ${key}`);
  return value;
};

const optionalEnv = (key, fallback = undefined) => process.env[key] || fallback;

const CONFIG = {
  port: Number(optionalEnv('PORT', 10000)),
  stateFile: path.resolve(process.cwd(), optionalEnv('STATE_FILE', 'bot_state.json')),
  telegram: {
    token: env('TELEGRAM_TOKEN'),
    chatId: env('TELEGRAM_CHAT_ID'),
    webhookDomain: optionalEnv('TELEGRAM_WEBHOOK_DOMAIN'),
    webhookPath: optionalEnv('TELEGRAM_WEBHOOK_PATH', '/telegram'),
  },
  whatsapp: {
    token: env('WHATSAPP_TOKEN'),
    phoneNumberId: env('PHONE_NUMBER_ID'),
    verifyToken: env('VERIFY_TOKEN'),
    templateName: optionalEnv('WHATSAPP_TEMPLATE_NAME'),
    templateLang: optionalEnv('WHATSAPP_TEMPLATE_LANG', 'ar'),
    apiVersion: optionalEnv('WHATSAPP_API_VERSION', 'v20.0'),
  },
  sheets: {
    id: env('SHEET_ID'),
    range: optionalEnv('SHEET_RANGE', 'Sheet1!A:C'),
    email: env('GOOGLE_EMAIL'),
    key: env('GOOGLE_KEY').replace(/\\n/g, '\n'),
  },
};

const logger = {
  info: (...args) => console.log('[info]', ...args),
  warn: (...args) => console.warn('[warn]', ...args),
  error: (...args) => console.error('[error]', ...args),
};

const bot = new Telegraf(CONFIG.telegram.token);

const googleAuth = new google.auth.JWT(
  CONFIG.sheets.email,
  null,
  CONFIG.sheets.key,
  ['https://www.googleapis.com/auth/spreadsheets'],
);
const sheets = google.sheets({ version: 'v4', auth: googleAuth });

const wa = axios.create({
  baseURL: `https://graph.facebook.com/${CONFIG.whatsapp.apiVersion}/${CONFIG.whatsapp.phoneNumberId}`,
  timeout: 30000,
  headers: { Authorization: `Bearer ${CONFIG.whatsapp.token}` },
});

const state = {
  topicByPhone: new Map(),
  phoneByTopic: new Map(),
  nameByPhone: new Map(),
  pendingTopicByPhone: new Map(),
  sentByWaId: new Map(),
  outgoingByWaId: new Map(),
  processedInboundIds: new Map(),
};

const normalizePhone = (phone) => {
  const raw = String(phone || '').trim();
  const digits = raw.replace(/[^\d]/g, '');
  if (!digits) return '';
  return raw.startsWith('+') ? `+${digits}` : digits;
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const compactError = (data) => {
  const err = data?.error || data || {};
  return [
    err.code && `code=${err.code}`,
    err.message,
    err.error_data?.details,
  ].filter(Boolean).join(' | ') || 'Unknown error';
};

const rememberTopic = (phone, topicId, name) => {
  const normalized = normalizePhone(phone);
  if (normalized && topicId) {
    const id = String(topicId);
    state.topicByPhone.set(normalized, id);
    state.phoneByTopic.set(id, normalized);
  }
  if (normalized && name) state.nameByPhone.set(normalized, name);
};

async function saveState() {
  const payload = {
    savedAt: new Date().toISOString(),
    sentByWaId: [...state.sentByWaId],
    outgoingByWaId: [...state.outgoingByWaId],
    processedInboundIds: [...state.processedInboundIds],
  };
  await fs.writeFile(CONFIG.stateFile, JSON.stringify(payload, null, 2), 'utf8');
}

async function loadState() {
  try {
    const raw = await fs.readFile(CONFIG.stateFile, 'utf8');
    const data = JSON.parse(raw);
    state.sentByWaId = new Map(data.sentByWaId || []);
    state.outgoingByWaId = new Map(data.outgoingByWaId || []);
    state.processedInboundIds = new Map(data.processedInboundIds || []);
    logger.info(`state loaded: ${state.sentByWaId.size} sent messages`);
  } catch (error) {
    if (error.code !== 'ENOENT') logger.warn('could not load state:', error.message);
  }
}

async function pruneState() {
  const maxAgeMs = 24 * 60 * 60 * 1000;
  const now = Date.now();
  let changed = false;

  for (const map of [state.sentByWaId, state.outgoingByWaId, state.processedInboundIds]) {
    for (const [key, value] of map) {
      if (now - value.createdAt > maxAgeMs) {
        map.delete(key);
        changed = true;
      }
    }
  }

  if (changed) await saveState().catch((error) => logger.warn('state save failed:', error.message));
}

async function syncSheetsToMemory() {
  try {
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId: CONFIG.sheets.id,
      range: CONFIG.sheets.range,
    });

    for (const row of res.data.values || []) {
      rememberTopic(row[0], row[1], row[2]);
    }

    logger.info(`sheets synced: ${state.topicByPhone.size} linked phones`);
    return true;
  } catch (error) {
    logger.error('sheets sync failed:', error.message);
    return false;
  }
}

async function waRequest(method, url, data, config = {}) {
  try {
    const res = await wa.request({ method, url, data, ...config });
    return { ok: true, data: res.data, messageId: res.data?.messages?.[0]?.id };
  } catch (error) {
    return {
      ok: false,
      status: error.response?.status,
      errorData: error.response?.data,
      errorMessage: compactError(error.response?.data),
    };
  }
}

async function sendWhatsAppText(phone, body) {
  return waRequest('POST', '/messages', {
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to: normalizePhone(phone),
    type: 'text',
    text: { preview_url: true, body },
  });
}

async function sendWhatsAppTemplate(phone, body) {
  if (!CONFIG.whatsapp.templateName) {
    return { ok: false, errorMessage: 'WHATSAPP_TEMPLATE_NAME is not configured' };
  }

  return waRequest('POST', '/messages', {
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to: normalizePhone(phone),
    type: 'template',
    template: {
      name: CONFIG.whatsapp.templateName,
      language: { code: CONFIG.whatsapp.templateLang },
      components: [{
        type: 'body',
        parameters: [{ type: 'text', text: String(body || '').slice(0, 900) || '...' }],
      }],
    },
  });
}

async function smartSendWhatsApp(phone, body) {
  const textAttempt = await sendWhatsAppText(phone, body);
  if (textAttempt.ok) return { ...textAttempt, usedTemplate: false };

  const code = textAttempt.errorData?.error?.code;
  const message = textAttempt.errorData?.error?.message || '';
  const outsideWindow = code === 131047 || message.includes('outside the allowed window');

  if (!outsideWindow) return textAttempt;

  logger.warn(`session expired for ${phone}; trying template`);
  const templateAttempt = await sendWhatsAppTemplate(phone, body);
  return { ...templateAttempt, usedTemplate: true };
}

async function getOrCreateTopic(phone) {
  const normalized = normalizePhone(phone);
  if (!normalized) return null;
  if (state.topicByPhone.has(normalized)) return state.topicByPhone.get(normalized);
  if (state.pendingTopicByPhone.has(normalized)) return state.pendingTopicByPhone.get(normalized);

  const task = (async () => {
    try {
      const topic = await bot.telegram.createForumTopic(
        CONFIG.telegram.chatId,
        `WhatsApp: ${normalized}`,
      );
      const topicId = String(topic.message_thread_id);

      await sheets.spreadsheets.values.append({
        spreadsheetId: CONFIG.sheets.id,
        range: 'Sheet1!A:C',
        valueInputOption: 'USER_ENTERED',
        resource: { values: [[normalized, topicId, '']] },
      });

      rememberTopic(normalized, topicId);
      return topicId;
    } catch (error) {
      logger.error('topic creation failed:', error.message);
      return null;
    } finally {
      state.pendingTopicByPhone.delete(normalized);
    }
  })();

  state.pendingTopicByPhone.set(normalized, task);
  return task;
}

async function sendTelegramMessage(topicId, text) {
  return bot.telegram.sendMessage(CONFIG.telegram.chatId, text, {
    message_thread_id: Number(topicId),
    disable_web_page_preview: false,
  });
}

async function markWhatsAppRead(messageId) {
  await waRequest('POST', '/messages', {
    messaging_product: 'whatsapp',
    status: 'read',
    message_id: messageId,
  });
}

async function relayWhatsAppMediaToTelegram(message, topicId, phone) {
  if (message.location) {
    const { latitude, longitude, name, address } = message.location;
    await bot.telegram.sendLocation(CONFIG.telegram.chatId, latitude, longitude, {
      message_thread_id: Number(topicId),
    });
    if (name || address) await sendTelegramMessage(topicId, `موقع من ${phone}\n${name || ''}\n${address || ''}`.trim());
    return;
  }

  if (message.contacts) {
    for (const contact of message.contacts) {
      const name = contact.name?.formatted_name || 'غير معروف';
      const phones = contact.phones?.map((item) => item.phone).join(', ') || 'لا يوجد رقم';
      await sendTelegramMessage(topicId, `جهة اتصال من ${phone}\nالاسم: ${name}\nالرقم: ${phones}`);
    }
    return;
  }

  if (message.interactive) {
    const reply = message.interactive.button_reply || message.interactive.list_reply;
    await sendTelegramMessage(topicId, `${phone}: ${reply?.title || 'تفاعل غير معروف'}`);
    return;
  }

  const type = ['image', 'video', 'audio', 'voice', 'document', 'sticker'].find((key) => message[key]);
  if (!type) {
    await sendTelegramMessage(topicId, `${phone}: نوع رسالة غير مدعوم (${message.type || 'unknown'})`);
    return;
  }

  const item = message[type];
  const mediaMeta = await axios.get(`https://graph.facebook.com/${CONFIG.whatsapp.apiVersion}/${item.id}`, {
    headers: { Authorization: `Bearer ${CONFIG.whatsapp.token}` },
    timeout: 30000,
  });
  const mediaUrl = mediaMeta.data?.url;
  if (!mediaUrl) throw new Error('WhatsApp media URL is missing');

  const fileRes = await axios.get(mediaUrl, {
    responseType: 'arraybuffer',
    timeout: 60000,
    headers: { Authorization: `Bearer ${CONFIG.whatsapp.token}` },
  });

  const file = {
    source: Buffer.from(fileRes.data),
    filename: item.filename || `whatsapp-${Date.now()}`,
  };
  const caption = item.caption || message.caption || `ملف من ${phone}`;
  const options = { message_thread_id: Number(topicId), caption };

  const methods = {
    image: 'sendPhoto',
    video: 'sendVideo',
    audio: 'sendAudio',
    voice: 'sendVoice',
    document: 'sendDocument',
    sticker: 'sendSticker',
  };

  try {
    await bot.telegram[methods[type]](CONFIG.telegram.chatId, file, options);
  } catch (error) {
    logger.warn(`telegram ${type} send failed; falling back to document:`, error.message);
    await bot.telegram.sendDocument(CONFIG.telegram.chatId, file, options);
  }
}

async function uploadAndSendTelegramMediaToWhatsApp(phone, file, mediaType) {
  const form = new FormData();
  form.append('messaging_product', 'whatsapp');
  form.append('file', file.buffer, {
    filename: file.filename,
    contentType: file.mimeType || 'application/octet-stream',
  });

  const upload = await axios.post(
    `https://graph.facebook.com/${CONFIG.whatsapp.apiVersion}/${CONFIG.whatsapp.phoneNumberId}/media`,
    form,
    {
      timeout: 60000,
      headers: { Authorization: `Bearer ${CONFIG.whatsapp.token}`, ...form.getHeaders() },
    },
  );

  const mediaId = upload.data?.id;
  if (!mediaId) return { ok: false, errorMessage: 'WhatsApp did not return a media id' };

  const payload = {
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to: normalizePhone(phone),
    type: mediaType,
    [mediaType]: { id: mediaId },
  };
  if (mediaType === 'document') payload.document.filename = file.filename;

  return waRequest('POST', '/messages', payload);
}

async function handleWhatsAppStatus(status) {
  const stored = state.sentByWaId.get(status.id);
  if (!stored) return;

  if (status.status === 'read') {
    await sendTelegramMessage(stored.topicId, 'تمت قراءة الرسالة');
    return;
  }

  if (status.status !== 'failed') return;

  const errorText = compactError(status.errors?.[0]);
  const original = state.outgoingByWaId.get(status.id);
  if (status.errors?.[0]?.code === 131047 && original && !original.usedTemplate) {
    const retry = await smartSendWhatsApp(original.phone, original.body);
    if (retry.ok) {
      state.sentByWaId.set(retry.messageId, {
        topicId: stored.topicId,
        phone: original.phone,
        createdAt: Date.now(),
      });
      await saveState();
      await sendTelegramMessage(stored.topicId, 'فشلت الرسالة العادية وتمت إعادة إرسالها بالقالب');
      return;
    }
  }

  await sendTelegramMessage(stored.topicId, `فشل الإرسال: ${errorText}`);
}

app.get('/health', (req, res) => {
  res.json({
    ok: true,
    linkedPhones: state.topicByPhone.size,
    uptimeSeconds: Math.round(process.uptime()),
  });
});

app.get('/webhook', (req, res) => {
  if (req.query['hub.verify_token'] !== CONFIG.whatsapp.verifyToken) {
    res.status(403).send('Forbidden');
    return;
  }
  res.send(req.query['hub.challenge']);
});

app.post('/webhook', async (req, res) => {
  res.sendStatus(200);

  try {
    const change = req.body.entry?.[0]?.changes?.[0]?.value;
    if (!change) return;

    for (const status of change.statuses || []) await handleWhatsAppStatus(status);

    for (const message of change.messages || []) {
      if (state.processedInboundIds.has(message.id)) continue;
      state.processedInboundIds.set(message.id, { createdAt: Date.now() });

      const phone = normalizePhone(message.from);
      const topicId = await getOrCreateTopic(phone);
      await markWhatsAppRead(message.id);
      if (!topicId) return;

      if (message.text?.body) {
        await sendTelegramMessage(topicId, `${phone}:\n${message.text.body}`);
      } else {
        await relayWhatsAppMediaToTelegram(message, topicId, phone);
      }
    }

    await saveState();
  } catch (error) {
    logger.error('webhook handling failed:', error.message);
  }
});

bot.command('new', async (ctx) => {
  const phone = normalizePhone(ctx.message.text.replace('/new', ''));
  if (!phone) return ctx.reply('الاستخدام: /new 966xxxxxxxxx');

  const topicId = await getOrCreateTopic(phone);
  if (!topicId) return ctx.reply('تعذر إنشاء الغرفة.');
  return ctx.reply(`تم ربط الرقم ${phone} بالغرفة ${topicId}`);
});

bot.command('sync', async (ctx) => {
  const ok = await syncSheetsToMemory();
  return ctx.reply(ok ? 'تمت المزامنة.' : 'فشلت المزامنة، راجع السجل.');
});

bot.command('bulk', async (ctx) => {
  const raw = ctx.message.text.replace('/bulk', '').trim();
  const [numbersText, bodyText] = raw.split('|').map((part) => part?.trim());
  if (!numbersText || !bodyText) {
    return ctx.reply('الاستخدام:\n/bulk 966xxxx,966yyyy | نص الرسالة');
  }

  const phones = [...new Set(numbersText.split(/[\s,]+/).map(normalizePhone).filter(Boolean))];
  let success = 0;
  let failed = 0;

  await ctx.reply(`بدأ إرسال ${phones.length} رسالة.`);

  for (const phone of phones) {
    const result = await smartSendWhatsApp(phone, bodyText);
    const topicId = await getOrCreateTopic(phone);

    if (result.ok) {
      success += 1;
      state.sentByWaId.set(result.messageId, { topicId, phone, createdAt: Date.now() });
      state.outgoingByWaId.set(result.messageId, {
        phone,
        body: bodyText,
        usedTemplate: result.usedTemplate,
        createdAt: Date.now(),
      });
      if (topicId) await sendTelegramMessage(topicId, `رسالة جماعية:\n${bodyText}`).catch(() => {});
    } else {
      failed += 1;
      if (topicId) await sendTelegramMessage(topicId, `فشل إرسال جماعي: ${result.errorMessage}`).catch(() => {});
    }

    await sleep(500);
  }

  await saveState();
  return ctx.reply(`انتهى الإرسال.\nنجاح: ${success}\nفشل: ${failed}`);
});

bot.on('message', async (ctx) => {
  const topicId = String(ctx.message.message_thread_id || '');
  if (!topicId || ctx.message.text?.startsWith('/')) return;

  let phone = state.phoneByTopic.get(topicId);
  if (!phone) {
    await syncSheetsToMemory();
    phone = state.phoneByTopic.get(topicId);
  }
  if (!phone) return ctx.reply('هذه الغرفة غير مرتبطة برقم واتساب. استخدم /new أولا.');

  if (ctx.message.text) {
    const result = await smartSendWhatsApp(phone, ctx.message.text);
    if (!result.ok) return ctx.reply(`خطأ: ${result.errorMessage}`);

    state.sentByWaId.set(result.messageId, { topicId, phone, createdAt: Date.now() });
    state.outgoingByWaId.set(result.messageId, {
      phone,
      body: ctx.message.text,
      usedTemplate: result.usedTemplate,
      createdAt: Date.now(),
    });
    await saveState();
    return ctx.reply(result.usedTemplate ? 'تم الإرسال بالقالب.' : 'تم الإرسال.');
  }

  const telegramFile =
    ctx.message.photo?.at(-1) ||
    ctx.message.video ||
    ctx.message.document ||
    ctx.message.voice ||
    ctx.message.audio;

  if (!telegramFile) return;

  const link = await bot.telegram.getFileLink(telegramFile.file_id);
  const downloaded = await axios.get(link.href, { responseType: 'arraybuffer', timeout: 60000 });
  const mediaType = ctx.message.photo ? 'image' : ctx.message.video ? 'video' : ctx.message.voice ? 'audio' : 'document';

  const result = await uploadAndSendTelegramMediaToWhatsApp(phone, {
    buffer: Buffer.from(downloaded.data),
    filename: telegramFile.file_name || `telegram-${Date.now()}`,
    mimeType: telegramFile.mime_type,
  }, mediaType);

  return ctx.reply(result.ok ? 'تم إرسال الملف.' : `فشل إرسال الملف: ${result.errorMessage}`);
});

async function bootstrap() {
  await loadState();
  await syncSheetsToMemory();
  setInterval(() => syncSheetsToMemory().catch((error) => logger.warn(error.message)), 10 * 60 * 1000);
  setInterval(() => pruneState().catch((error) => logger.warn(error.message)), 60 * 60 * 1000);

  if (CONFIG.telegram.webhookDomain) {
    app.use(bot.webhookCallback(CONFIG.telegram.webhookPath));
    await bot.telegram.setWebhook(`${CONFIG.telegram.webhookDomain}${CONFIG.telegram.webhookPath}`);
    logger.info(`telegram webhook enabled: ${CONFIG.telegram.webhookDomain}${CONFIG.telegram.webhookPath}`);
  } else {
    await bot.launch();
    logger.info('telegram polling enabled');
  }

  app.listen(CONFIG.port, () => logger.info(`server listening on ${CONFIG.port}`));
}

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));

bootstrap().catch((error) => {
  logger.error('boot failed:', error.message);
  process.exit(1);
});
