const express = require('express');
const axios = require('axios');
const { Telegraf } = require('telegraf');
const { google } = require('googleapis');

const app = express();
app.use(express.json());

// جلب الإعدادات من Render
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID;
const VERIFY_TOKEN = process.env.VERIFY_TOKEN;
const WHATSAPP_TEMPLATE_NAME = process.env.WHATSAPP_TEMPLATE_NAME;
const WHATSAPP_TEMPLATE_LANG = process.env.WHATSAPP_TEMPLATE_LANG || 'ar';
const TELEGRAM_WEBHOOK_DOMAIN = process.env.TELEGRAM_WEBHOOK_DOMAIN;
const TELEGRAM_WEBHOOK_PATH = process.env.TELEGRAM_WEBHOOK_PATH || '/telegram';
const SPREADSHEET_ID = '1coOeDXKCqgDLVrHBAwtIQ8hsDJQPED3oL1Jp-Ad7jmk';

const bot = new Telegraf(TELEGRAM_TOKEN);
const GOOGLE_EMAIL = process.env.GOOGLE_EMAIL;
const GOOGLE_KEY = process.env.GOOGLE_KEY ? process.env.GOOGLE_KEY.replace(/\\n/g, '\n') : undefined;

const auth = new google.auth.JWT(GOOGLE_EMAIL, null, GOOGLE_KEY, ['https://www.googleapis.com/auth/spreadsheets']);
const sheets = google.sheets({ version: 'v4', auth });

const topicCache = new Map();
const reverseTopicCache = new Map();
const inFlightTopics = new Map();
const sentMessageIndex = new Map();
const nameCache = new Map();

const normalizePhone = (phone) => {
    const raw = (phone || '').toString().trim();
    if (!raw) return '';
    const hasPlus = raw.startsWith('+');
    const digits = raw.replace(/[^\d]/g, '');
    return digits ? (hasPlus ? `+${digits}` : digits) : '';
};

const cacheMapping = (phone, topicId) => {
    if (!phone || !topicId) return;
    topicCache.set(phone, topicId);
    reverseTopicCache.set(topicId, phone);
};

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

const isTopicDeletedError = (error) => {
    const description = error?.response?.description || error?.description || '';
    return description.includes('TOPIC_DELETED');
};

const shouldUseTemplate = (errorData) => {
    const code = errorData?.error?.code;
    const message = (errorData?.error?.message || '').toLowerCase();
    return code === 131047 || message.includes('template') || message.includes('outside the allowed window');
};

const formatWhatsAppError = (errorData, status) => {
    if (!errorData) return `HTTP ${status || 'unknown'}`;
    const code = errorData?.error?.code;
    const message = errorData?.error?.message;
    const details = errorData?.error?.error_data?.details;
    const fbtrace = errorData?.error?.fbtrace_id;
    const parts = [];
    if (code) parts.push(`code=${code}`);
    if (message) parts.push(`message=${message}`);
    if (details) parts.push(`details=${details}`);
    if (fbtrace) parts.push(`trace=${fbtrace}`);
    return parts.length ? parts.join(' | ') : `HTTP ${status || 'unknown'}`;
};

const formatAxiosPayload = (configData) => {
    if (!configData) return '';
    try {
        const data = typeof configData === 'string' ? JSON.parse(configData) : configData;
        return JSON.stringify(data);
    } catch (e) {
        return typeof configData === 'string' ? configData : JSON.stringify(configData);
    }
};

async function sendWhatsAppText(phone, body, attempt = 1) {
    try {
        const response = await axios({
            method: 'POST',
            url: `https://graph.facebook.com/v20.0/${PHONE_NUMBER_ID}/messages`,
            data: { messaging_product: 'whatsapp', recipient_type: 'individual', to: phone, type: 'text', text: { body } },
            headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}` }
        });
        const messageId = response.data?.messages?.[0]?.id || null;
        return { ok: true, messageId };
    } catch (e) {
        const status = e.response?.status;
        const errorData = e.response?.data;
        console.error('WhatsApp Send Error:', status, errorData || e.message);
        console.error('WhatsApp Send Debug:', {
            status,
            data: errorData,
            request: formatAxiosPayload(e.config?.data)
        });
        if (attempt < 2) {
            await sleep(400);
            return sendWhatsAppText(phone, body, attempt + 1);
        }
        return { ok: false, status, errorData, errorMessage: formatWhatsAppError(errorData, status) };
    }
}

async function sendWhatsAppTemplateWithText(phone, bodyText) {
    if (!WHATSAPP_TEMPLATE_NAME) {
        return { ok: false, message: 'Template name not configured' };
    }
    try {
        const response = await axios({
            method: 'POST',
            url: `https://graph.facebook.com/v20.0/${PHONE_NUMBER_ID}/messages`,
            data: {
                messaging_product: 'whatsapp',
                recipient_type: 'individual',
                to: phone,
                type: 'template',
                template: {
                    name: WHATSAPP_TEMPLATE_NAME,
                    language: { code: WHATSAPP_TEMPLATE_LANG },
                    components: [
                        {
                            type: 'body',
                            parameters: [{ type: 'text', text: bodyText }]
                        }
                    ]
                }
            },
            headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}` }
        });
        const messageId = response.data?.messages?.[0]?.id || null;
        return { ok: true, messageId };
    } catch (e) {
        const status = e.response?.status;
        const errorData = e.response?.data;
        console.error('WhatsApp Template Error:', status, errorData || e.message);
        console.error('WhatsApp Template Debug:', {
            status,
            data: errorData,
            request: formatAxiosPayload(e.config?.data)
        });
        return { ok: false, status, errorData, errorMessage: formatWhatsAppError(errorData, status) };
    }
}

const registerSentMessage = (messageId, topicId, phone) => {
    if (!messageId || !topicId || !phone) return;
    sentMessageIndex.set(messageId, { topicId, phone, createdAt: Date.now() });
    if (sentMessageIndex.size > 5000) {
        const cutoff = Date.now() - 24 * 60 * 60 * 1000;
        for (const [id, data] of sentMessageIndex.entries()) {
            if (data.createdAt < cutoff) {
                sentMessageIndex.delete(id);
            }
        }
    }
};

async function sendWhatsAppMessage(phone, body) {
    const textResult = await sendWhatsAppText(phone, body);
    if (textResult.ok) {
        return { ...textResult, usedTemplate: false };
    }
    if (shouldUseTemplate(textResult.errorData)) {
        const recipientName = await getNameForPhone(phone);
        const composedBody = recipientName ? `الأستاذ/ة ${recipientName}\n${body}` : body;
        const templateResult = await sendWhatsAppTemplateWithText(phone, composedBody);
        return { ...templateResult, usedTemplate: true };
    }
    return { ...textResult, usedTemplate: false };
}

async function getNameForPhone(phone) {
    const normalizedPhone = normalizePhone(phone);
    if (!normalizedPhone) return '';
    if (nameCache.has(normalizedPhone)) {
        return nameCache.get(normalizedPhone);
    }
    const res = await sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: 'Sheet1!A:C' });
    const rows = res.data.values || [];
    const match = rows.find(row => normalizePhone(row[0]) === normalizedPhone);
    const name = match?.[2]?.toString().trim() || '';
    if (name) {
        nameCache.set(normalizedPhone, name);
    }
    return name;
}

async function setNameForPhone(phone, name) {
    const normalizedPhone = normalizePhone(phone);
    if (!normalizedPhone) return false;
    const trimmedName = name.trim();
    const res = await sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: 'Sheet1!A:C' });
    const rows = res.data.values || [];
    const rowIndex = rows.findIndex(row => normalizePhone(row[0]) === normalizedPhone);
    if (rowIndex >= 0) {
        await sheets.spreadsheets.values.update({
            spreadsheetId: SPREADSHEET_ID,
            range: `Sheet1!C${rowIndex + 1}`,
            valueInputOption: 'USER_ENTERED',
            resource: { values: [[trimmedName]] }
        });
    } else {
        await sheets.spreadsheets.values.append({
            spreadsheetId: SPREADSHEET_ID,
            range: 'Sheet1!A:C',
            valueInputOption: 'USER_ENTERED',
            resource: { values: [[normalizedPhone, '', trimmedName]] }
        });
    }
    nameCache.set(normalizedPhone, trimmedName);
    return true;
}

async function updateTopicInSheet(phone, topicId) {
    const res = await sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: 'Sheet1!A:B' });
    const rows = res.data.values || [];
    const rowIndex = rows.findIndex(row => normalizePhone(row[0]) === phone);
    if (rowIndex >= 0) {
        await sheets.spreadsheets.values.update({
            spreadsheetId: SPREADSHEET_ID,
            range: `Sheet1!B${rowIndex + 1}`,
            valueInputOption: 'USER_ENTERED',
            resource: { values: [[topicId]] }
        });
    } else {
        await sheets.spreadsheets.values.append({
            spreadsheetId: SPREADSHEET_ID,
            range: 'Sheet1!A:B',
            valueInputOption: 'USER_ENTERED',
            resource: { values: [[phone, topicId]] }
        });
    }
}

async function recreateTopicForPhone(phone) {
    const topic = await bot.telegram.createForumTopic(TELEGRAM_CHAT_ID, `الجار: ${phone}`);
    const topicId = topic.message_thread_id?.toString();
    if (!topicId) return null;
    await updateTopicInSheet(phone, topicId);
    cacheMapping(phone, topicId);
    return topicId;
}

async function sendToTelegramTopic(phone, sendAction) {
    const topicId = await getOrCreateTopic(phone);
    if (!topicId) return;
    try {
        await sendAction(topicId);
    } catch (e) {
        if (!isTopicDeletedError(e)) {
            throw e;
        }
        console.warn('Topic deleted, recreating topic for phone:', phone);
        const newTopicId = await recreateTopicForPhone(phone);
        if (newTopicId) {
            await sendAction(newTopicId);
        }
    }
}

// دالة الصحين الزرقاء
async function markAsRead(messageId) {
    try {
        await axios({
            method: 'POST',
            url: `https://graph.facebook.com/v20.0/${PHONE_NUMBER_ID}/messages`,
            data: { messaging_product: 'whatsapp', status: 'read', message_id: messageId },
            headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}`, 'Content-Type': 'application/json' }
        });
        console.log('✅ تمت القراءة (الصحين الزرقاء)');
    } catch (e) {
        console.error('Error marking read:', e.response?.data || e.message);
    }
}

async function getWhatsAppMedia(mediaId) {
    try {
        const response = await axios.get(`https://graph.facebook.com/v20.0/${mediaId}`, { headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}` } });
        const fileRes = await axios.get(response.data.url, { headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}` }, responseType: 'arraybuffer' });
        return fileRes.data;
    } catch (e) {
        return null;
    }
}

async function fetchTopicFromSheet(phone) {
    const res = await sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: 'Sheet1!A:B' });
    const rows = res.data.values || [];
    const existing = rows.find(row => normalizePhone(row[0]) === phone);
    const topicId = existing ? existing[1]?.toString() : null;
    if (topicId) {
        cacheMapping(phone, topicId);
    }
    return topicId;
}

async function getPhoneByTopicId(topicId) {
    if (!topicId) return null;
    if (reverseTopicCache.has(topicId)) {
        return reverseTopicCache.get(topicId);
    }
    const res = await sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: 'Sheet1!A:B' });
    const rows = res.data.values || [];
    const match = rows.find(row => row[1]?.toString() === topicId);
    if (!match) return null;
    const phone = normalizePhone(match[0]);
    if (phone) {
        cacheMapping(phone, topicId);
        return phone;
    }
    return null;
}

async function ensureMapping(phone, topicId) {
    const normalizedPhone = normalizePhone(phone);
    const normalizedTopicId = topicId?.toString();
    if (!normalizedPhone || !normalizedTopicId) return false;

    const existingTopicId = await fetchTopicFromSheet(normalizedPhone);
    if (existingTopicId && existingTopicId !== normalizedTopicId) {
        cacheMapping(normalizedPhone, existingTopicId);
        return false;
    }

    const existingPhone = await getPhoneByTopicId(normalizedTopicId);
    if (existingPhone && existingPhone !== normalizedPhone) {
        cacheMapping(existingPhone, normalizedTopicId);
        return false;
    }

    if (!existingTopicId && !existingPhone) {
        await sheets.spreadsheets.values.append({
            spreadsheetId: SPREADSHEET_ID,
            range: 'Sheet1!A:B',
            valueInputOption: 'USER_ENTERED',
            resource: { values: [[normalizedPhone, normalizedTopicId]] }
        });
        cacheMapping(normalizedPhone, normalizedTopicId);
        return true;
    }

    cacheMapping(normalizedPhone, normalizedTopicId);
    return true;
}

async function getOrCreateTopic(phone) {
    const normalizedPhone = normalizePhone(phone);
    if (!normalizedPhone) return null;

    if (topicCache.has(normalizedPhone)) {
        return topicCache.get(normalizedPhone);
    }

    if (inFlightTopics.has(normalizedPhone)) {
        return inFlightTopics.get(normalizedPhone);
    }

    const creationPromise = (async () => {
        try {
            const existing = await fetchTopicFromSheet(normalizedPhone);
            if (existing) {
                return existing;
            }

            const topic = await bot.telegram.createForumTopic(TELEGRAM_CHAT_ID, `الجار: ${normalizedPhone}`);
            const topicId = topic.message_thread_id?.toString();
            if (topicId) {
                await sheets.spreadsheets.values.append({
                    spreadsheetId: SPREADSHEET_ID,
                    range: 'Sheet1!A:B',
                    valueInputOption: 'USER_ENTERED',
                    resource: { values: [[normalizedPhone, topicId]] }
                });
                cacheMapping(normalizedPhone, topicId);
            }
            return topicId || null;
        } catch (e) {
            console.error('Topic Error:', e.response?.data || e.message);
            return null;
        } finally {
            inFlightTopics.delete(normalizedPhone);
        }
    })();

    inFlightTopics.set(normalizedPhone, creationPromise);
    return creationPromise;
}

app.post('/webhook', async (req, res) => {
    const entry = req.body.entry?.[0]?.changes?.[0]?.value;
    const message = entry?.messages?.[0];
    const statuses = entry?.statuses || [];
    if (message) {
        const phone = normalizePhone(message.from);
        const messageId = message.id;

        // تفعيل الصحين الزرقاء أولاً
        await markAsRead(messageId);

        if (message.text) {
            await sendToTelegramTopic(phone, (topicId) => (
                bot.telegram.sendMessage(TELEGRAM_CHAT_ID, `📩 من ${phone}:\n${message.text.body}`, { message_thread_id: topicId })
            ));
        } else if (message.image) {
            const buffer = await getWhatsAppMedia(message.image.id);
            if (buffer) {
                await sendToTelegramTopic(phone, (topicId) => (
                    bot.telegram.sendPhoto(TELEGRAM_CHAT_ID, { source: buffer }, { message_thread_id: topicId, caption: `🖼 صورة من ${phone}` })
                ));
            }
        } else if (message.video) {
            const buffer = await getWhatsAppMedia(message.video.id);
            if (buffer) {
                await sendToTelegramTopic(phone, (topicId) => (
                    bot.telegram.sendVideo(TELEGRAM_CHAT_ID, { source: buffer }, { message_thread_id: topicId, caption: `📹 فيديو من ${phone}` })
                ));
            }
        } else if (message.document) {
            const buffer = await getWhatsAppMedia(message.document.id);
            if (buffer) {
                await sendToTelegramTopic(phone, (topicId) => (
                    bot.telegram.sendDocument(
                        TELEGRAM_CHAT_ID,
                        { source: buffer, filename: message.document.filename },
                        { message_thread_id: topicId, caption: `📄 ملف من ${phone}` }
                    )
                ));
            }
        } else if (message.audio) {
            const buffer = await getWhatsAppMedia(message.audio.id);
            if (buffer) {
                await sendToTelegramTopic(phone, (topicId) => (
                    bot.telegram.sendVoice(TELEGRAM_CHAT_ID, { source: buffer }, { message_thread_id: topicId })
                ));
            }
        }
    }

    if (statuses.length) {
        for (const status of statuses) {
            const statusId = status.id;
            const statusValue = status.status;
            const tracked = sentMessageIndex.get(statusId);
            if (!tracked) continue;
            if (statusValue === 'read') {
                await sendToTelegramTopic(tracked.phone, (topicThreadId) => (
                    bot.telegram.sendMessage(
                        TELEGRAM_CHAT_ID,
                        '✅ تم قراءة الرسالة على واتساب.',
                        { message_thread_id: topicThreadId }
                    )
                ));
            } else if (statusValue === 'failed') {
                await sendToTelegramTopic(tracked.phone, (topicThreadId) => (
                    bot.telegram.sendMessage(
                        TELEGRAM_CHAT_ID,
                        '❌ فشل تسليم الرسالة على واتساب.',
                        { message_thread_id: topicThreadId }
                    )
                ));
            }
        }
    }
    res.sendStatus(200);
});

bot.command('new', async (ctx) => {
    const raw = ctx.message.text.replace('/new', '').trim();
    const phone = normalizePhone(raw);
    if (!phone) {
        await ctx.reply('اكتب الرقم بعد الأمر مثل: /new 9665xxxxxxx');
        return;
    }
    try {
        const topicId = await getOrCreateTopic(phone);
        if (!topicId) {
            await ctx.reply('تعذر إنشاء غرفة للرقم.');
            return;
        }
        await ensureMapping(phone, topicId);
        await sendToTelegramTopic(phone, (threadId) => (
            bot.telegram.sendMessage(
                TELEGRAM_CHAT_ID,
                `✅ تم إنشاء غرفة وربط الرقم ${phone}. اكتب رسالتك هنا لإرسالها للواتساب.`,
                { message_thread_id: threadId }
            )
        ));
        await ctx.reply(`تم إنشاء غرفة للرقم ${phone}.`);
    } catch (e) {
        console.error('New Topic Error:', e.response?.data || e.message);
        await ctx.reply('تعذر إنشاء غرفة للرقم.');
    }
});

bot.command('name', async (ctx) => {
    const topicId = ctx.message.message_thread_id?.toString();
    const rawName = ctx.message.text.replace('/name', '').trim();
    if (!topicId) {
        await ctx.reply('استخدم الأمر داخل الغرفة.');
        return;
    }
    if (!rawName) {
        await ctx.reply('اكتب الاسم بعد الأمر مثل: /name محمد');
        return;
    }
    try {
        const phone = await getPhoneByTopicId(topicId);
        if (!phone) {
            await ctx.reply('لا يوجد رقم مربوط لهذه الغرفة. استخدم /to أولاً.');
            return;
        }
        await setNameForPhone(phone, rawName);
        await ctx.reply(`تم حفظ الاسم للرقم ${phone}.`);
    } catch (e) {
        console.error('Name Update Error:', e.response?.data || e.message);
        await ctx.reply('تعذر حفظ الاسم.');
    }
});

bot.command('bulk', async (ctx) => {
    const payload = ctx.message.text.replace('/bulk', '').trim();
    if (!payload) {
        await ctx.reply('استخدم الأمر بهذا الشكل:\n/bulk نص الرسالة\n9665xxxxxxx\n9665yyyyyyy\nأو\n/bulk 9665xxxxxxx,9665yyyyyyy | نص الرسالة');
        return;
    }

    let message = '';
    let numbers = [];

    if (payload.includes('|')) {
        const [numbersPart, messagePart] = payload.split('|');
        message = messagePart?.trim();
        numbers = numbersPart
            .split(/[,\n]/)
            .map(item => normalizePhone(item))
            .filter(Boolean);
    } else {
        const lines = payload.split('\n').map(line => line.trim()).filter(Boolean);
        message = lines.shift() || '';
        numbers = lines
            .join(',')
            .split(/[,\s]+/)
            .map(item => normalizePhone(item))
            .filter(Boolean);
    }

    if (!message) {
        await ctx.reply('اكتب نص الرسالة بعد الأمر أو بعد علامة |');
        return;
    }

    if (!numbers.length) {
        await ctx.reply('لم يتم العثور على أرقام صحيحة.');
        return;
    }

    let success = 0;
    let failed = 0;
    const failedNumbers = [];

    for (const phone of numbers) {
        try {
            const topicId = await getOrCreateTopic(phone);
            if (topicId) {
                await ensureMapping(phone, topicId);
            }
            const result = await sendWhatsAppMessage(phone, message);
            if (result.ok) {
                success += 1;
            } else {
                failed += 1;
                failedNumbers.push(phone);
            }
            if (result.messageId && topicId) {
                registerSentMessage(result.messageId, topicId, phone);
            }
            await sendToTelegramTopic(phone, (topicThreadId) => (
                bot.telegram.sendMessage(
                    TELEGRAM_CHAT_ID,
                    `📣 رسالة جماعية:\n${message}\n\nالحالة: ${result.ok ? '✅ تم الإرسال' : '❌ فشل الإرسال'}${result.usedTemplate ? '\nتم الإرسال عبر قالب موافقة.' : ''}${!result.ok && result.errorMessage ? `\nالسبب: ${result.errorMessage}` : ''}`,
                    { message_thread_id: topicThreadId }
                )
            ));
        } catch (e) {
            failed += 1;
            failedNumbers.push(phone);
            console.error('Bulk Send Error:', e.response?.data || e.message);
            try {
                await sendToTelegramTopic(phone, (topicThreadId) => (
                    bot.telegram.sendMessage(
                        TELEGRAM_CHAT_ID,
                        `📣 رسالة جماعية:\n${message}\n\nالحالة: ❌ فشل الإرسال\nالسبب: ${e.response?.data?.error?.message || e.message}`,
                        { message_thread_id: topicThreadId }
                    )
                ));
            } catch (sendError) {
                console.error('Bulk Telegram Report Error:', sendError.response?.data || sendError.message);
            }
        }
        await sleep(200);
    }

    const failureNote = failedNumbers.length ? `\nالأرقام الفاشلة: ${failedNumbers.join(', ')}` : '';
    await ctx.reply(`تم إرسال ${success} رسالة. فشل ${failed}.${failureNote}`);
});

bot.on('message', async (ctx) => {
    const topicId = ctx.message.message_thread_id?.toString();
    if (topicId && ctx.message.text) {
        try {
            const text = ctx.message.text.trim();
            if (text.startsWith('/to ')) {
                const phone = normalizePhone(text.replace('/to', '').trim());
                if (!phone) {
                    await ctx.reply('اكتب الرقم بعد الأمر مثل: /to 9665xxxxxxx');
                    return;
                }
                const mapped = await ensureMapping(phone, topicId);
                if (mapped) {
                    await ctx.reply(`تم ربط هذه الغرفة بالرقم ${phone}.`);
                } else {
                    await ctx.reply('تعذر ربط الرقم (قد يكون مربوطاً مسبقاً).');
                }
                return;
            }

            const phone = await getPhoneByTopicId(topicId);
            if (phone) {
                const result = await sendWhatsAppMessage(phone, ctx.message.text);
                if (result.messageId) {
                    registerSentMessage(result.messageId, topicId, phone);
                }
                if (result.ok) {
                    await ctx.reply(`✅ تم إرسال الرسالة.${result.usedTemplate ? ' (تم الإرسال عبر قالب موافقة)' : ''}`);
                } else {
                    const errorNote = result.errorMessage ? `\nالسبب: ${result.errorMessage}` : '';
                    await ctx.reply(`❌ تعذر إرسال الرسالة للواتساب.${errorNote}`);
                }
            } else {
                await ctx.reply('لا يوجد رقم مربوط لهذه الغرفة. استخدم الأمر /to 9665xxxxxxx للربط.');
            }
        } catch (e) {
            console.error('Send Error:', e.response?.data || e.message);
        }
    }
});

app.get('/webhook', (req, res) => {
    if (req.query['hub.verify_token'] === VERIFY_TOKEN) res.send(req.query['hub.challenge']);
    else res.send('Error');
});

const PORT = process.env.PORT || 10000;
if (TELEGRAM_WEBHOOK_DOMAIN) {
    app.use(bot.webhookCallback(TELEGRAM_WEBHOOK_PATH));
}

app.listen(PORT, async () => {
    console.log('Ajyal System Pro Online ✅');
    try {
        if (TELEGRAM_WEBHOOK_DOMAIN) {
            await bot.telegram.setWebhook(`${TELEGRAM_WEBHOOK_DOMAIN}${TELEGRAM_WEBHOOK_PATH}`);
            console.log('Telegram webhook set ✅');
        } else {
            bot.launch();
        }
    } catch (e) {
        console.error('Telegram Launch Error:', e.response?.data || e.message);
    }
});
