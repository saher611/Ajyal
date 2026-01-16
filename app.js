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
const SPREADSHEET_ID = '1coOeDXKCqgDLVrHBAwtIQ8hsDJQPED3oL1Jp-Ad7jmk';

const bot = new Telegraf(TELEGRAM_TOKEN);
const GOOGLE_EMAIL = process.env.GOOGLE_EMAIL;
const GOOGLE_KEY = process.env.GOOGLE_KEY ? process.env.GOOGLE_KEY.replace(/\\n/g, '\n') : undefined;

const auth = new google.auth.JWT(GOOGLE_EMAIL, null, GOOGLE_KEY, ['https://www.googleapis.com/auth/spreadsheets']);
const sheets = google.sheets({ version: 'v4', auth });

const topicCache = new Map();
const reverseTopicCache = new Map();
const inFlightTopics = new Map();

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

async function sendWhatsAppText(phone, body, attempt = 1) {
    try {
        await axios({
            method: 'POST',
            url: `https://graph.facebook.com/v20.0/${PHONE_NUMBER_ID}/messages`,
            data: { messaging_product: 'whatsapp', recipient_type: 'individual', to: phone, type: 'text', text: { body } },
            headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}` }
        });
        return { ok: true };
    } catch (e) {
        const status = e.response?.status;
        const errorData = e.response?.data;
        console.error('WhatsApp Send Error:', status, errorData || e.message);
        if (attempt < 2) {
            await sleep(400);
            return sendWhatsAppText(phone, body, attempt + 1);
        }
        return { ok: false, status, errorData };
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
    if (message) {
        const phone = normalizePhone(message.from);
        const messageId = message.id;

        // تفعيل الصحين الزرقاء أولاً
        await markAsRead(messageId);

        const topicId = await getOrCreateTopic(phone);
        const options = { message_thread_id: topicId || undefined };

        if (message.text) {
            await bot.telegram.sendMessage(TELEGRAM_CHAT_ID, `📩 من ${phone}:\n${message.text.body}`, options);
        } else if (message.image) {
            const buffer = await getWhatsAppMedia(message.image.id);
            if (buffer) await bot.telegram.sendPhoto(TELEGRAM_CHAT_ID, { source: buffer }, { ...options, caption: `🖼 صورة من ${phone}` });
        } else if (message.video) {
            const buffer = await getWhatsAppMedia(message.video.id);
            if (buffer) await bot.telegram.sendVideo(TELEGRAM_CHAT_ID, { source: buffer }, { ...options, caption: `📹 فيديو من ${phone}` });
        } else if (message.document) {
            const buffer = await getWhatsAppMedia(message.document.id);
            if (buffer) await bot.telegram.sendDocument(TELEGRAM_CHAT_ID, { source: buffer, filename: message.document.filename }, { ...options, caption: `📄 ملف من ${phone}` });
        } else if (message.audio) {
            const buffer = await getWhatsAppMedia(message.audio.id);
            if (buffer) await bot.telegram.sendVoice(TELEGRAM_CHAT_ID, { source: buffer }, options);
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
        await bot.telegram.sendMessage(
            TELEGRAM_CHAT_ID,
            `✅ تم إنشاء غرفة وربط الرقم ${phone}. اكتب رسالتك هنا لإرسالها للواتساب.`,
            { message_thread_id: topicId }
        );
        await ctx.reply(`تم إنشاء غرفة للرقم ${phone}.`);
    } catch (e) {
        console.error('New Topic Error:', e.response?.data || e.message);
        await ctx.reply('تعذر إنشاء غرفة للرقم.');
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
            const result = await sendWhatsAppText(phone, message);
            if (result.ok) {
                success += 1;
            } else {
                failed += 1;
                failedNumbers.push(phone);
            }
        } catch (e) {
            failed += 1;
            failedNumbers.push(phone);
            console.error('Bulk Send Error:', e.response?.data || e.message);
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
                const result = await sendWhatsAppText(phone, ctx.message.text);
                if (!result.ok) {
                    await ctx.reply('تعذر إرسال الرسالة للواتساب. تأكد من أن الرقم مسموح له باستقبال الرسائل.');
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
app.listen(PORT, () => {
    console.log('Ajyal System Pro Online ✅');
    bot.launch();
});
