const express = require('express');
const axios = require('axios');
const { Telegraf } = require('telegraf');
const FormData = require('form-data');
const { google } = require('googleapis');
const fs = require('fs');
const path = require('path');

// ==========================================
// التكوين والإعدادات (Configuration)
// ==========================================
const app = express();
app.use(express.json());

const requiredEnv = [
    'TELEGRAM_TOKEN', 'TELEGRAM_CHAT_ID', 'WHATSAPP_TOKEN',
    'PHONE_NUMBER_ID', 'VERIFY_TOKEN', 'GOOGLE_EMAIL', 'GOOGLE_KEY'
];
const missingEnv = requiredEnv.filter(key => !process.env[key]);
if (missingEnv.length > 0) {
    console.error('❌ Missing Environment Variables:', missingEnv.join(', '));
    process.exit(1);
}

const CONFIG = {
    TELEGRAM: {
        TOKEN: process.env.TELEGRAM_TOKEN,
        CHAT_ID: process.env.TELEGRAM_CHAT_ID,
        WEBHOOK_DOMAIN: process.env.TELEGRAM_WEBHOOK_DOMAIN,
        WEBHOOK_PATH: process.env.TELEGRAM_WEBHOOK_PATH || '/telegram'
    },
    WHATSAPP: {
        TOKEN: process.env.WHATSAPP_TOKEN,
        PHONE_ID: process.env.PHONE_NUMBER_ID,
        TEMPLATE_NAME: process.env.WHATSAPP_TEMPLATE_NAME,
        TEMPLATE_LANG: process.env.WHATSAPP_TEMPLATE_LANG || 'ar',
        VERIFY_TOKEN: process.env.VERIFY_TOKEN
    },
    SHEETS: {
        ID: '1coOeDXKCqgDLVrHBAwtIQ8hsDJQPED3oL1Jp-Ad7jmk'
    },
    FILES: {
        STATE: path.resolve(process.cwd(), 'bot_state.json')
    }
};

const bot = new Telegraf(CONFIG.TELEGRAM.TOKEN);

// إعداد Google Sheets
const GOOGLE_KEY = process.env.GOOGLE_KEY.replace(/\\n/g, '\n');
const auth = new google.auth.JWT(process.env.GOOGLE_EMAIL, null, GOOGLE_KEY, ['https://www.googleapis.com/auth/spreadsheets']);
const sheets = google.sheets({ version: 'v4', auth });

// ==========================================
// إدارة الحالة والذاكرة (State Management)
// ==========================================
// نستخدم الذاكرة للسرعة، ونحفظ في ملف للحماية من إعادة التشغيل
const state = {
    topicCache: new Map(),        // Phone -> TopicID
    reverseTopicCache: new Map(), // TopicID -> Phone
    inFlightTopics: new Map(),    // منع ازدواجية إنشاء الغرف
    sentMessages: new Map(),      // تتبع الرسائل المرسلة: MessageID -> {topicId, phone, timestamp}
    outgoingStore: new Map(),     // تخزين نص الرسائل لإعادة الإرسال: MessageID -> {phone, body, ...}
    names: new Map()              // Phone -> Name
};

// حفظ الحالة محلياً (نسخ احتياطي)
function saveStateToDisk() {
    try {
        const payload = {
            sentMessages: Array.from(state.sentMessages.entries()),
            outgoingStore: Array.from(state.outgoingStore.entries())
        };
        fs.writeFileSync(CONFIG.FILES.STATE, JSON.stringify(payload));
    } catch (e) {
        console.error('⚠️ Failed to save state to disk:', e.message);
    }
}

// استعادة الحالة عند البدء
function loadStateFromDisk() {
    try {
        if (fs.existsSync(CONFIG.FILES.STATE)) {
            const raw = fs.readFileSync(CONFIG.FILES.STATE, 'utf8');
            const data = JSON.parse(raw);
            if (data.sentMessages) state.sentMessages = new Map(data.sentMessages);
            if (data.outgoingStore) state.outgoingStore = new Map(data.outgoingStore);
            console.log(`✅ State loaded: ${state.sentMessages.size} tracked messages.`);
        }
    } catch (e) {
        console.error('⚠️ Failed to load state:', e.message);
    }
}

// تنظيف دوري للبيانات القديمة
setInterval(() => {
    const now = Date.now();
    const day = 24 * 60 * 60 * 1000;
    let changed = false;

    for (const [id, data] of state.sentMessages) {
        if (now - data.createdAt > day) {
            state.sentMessages.delete(id);
            changed = true;
        }
    }
    for (const [id, data] of state.outgoingStore) {
        if (now - data.createdAt > day) {
            state.outgoingStore.delete(id);
            changed = true;
        }
    }
    if (changed) saveStateToDisk();
}, 60 * 60 * 1000); // كل ساعة

// ==========================================
// أدوات مساعدة (Helpers)
// ==========================================
const normalizePhone = (phone) => {
    const raw = (phone || '').toString().trim();
    if (!raw) return '';
    const hasPlus = raw.startsWith('+');
    const digits = raw.replace(/[^\d]/g, '');
    return digits ? (hasPlus ? `+${digits}` : digits) : '';
};

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

const formatWhatsAppError = (errorData) => {
    if (!errorData) return 'Unknown Error';
    const err = errorData.error || {};
    return [
        err.code && `Code: ${err.code}`,
        err.message && `Msg: ${err.message}`,
        err.error_data?.details && `Details: ${err.error_data.details}`
    ].filter(Boolean).join(' | ');
};

function updateCache(phone, topicId, name) {
    if (phone && topicId) {
        state.topicCache.set(phone, topicId.toString());
        state.reverseTopicCache.set(topicId.toString(), phone);
    }
    if (phone && name) {
        state.names.set(phone, name);
    }
}

// ==========================================
// خدمات Google Sheets
// ==========================================
async function syncSheetsToMemory() {
    console.log('🔄 Syncing data from Google Sheets...');
    try {
        const res = await sheets.spreadsheets.values.get({
            spreadsheetId: CONFIG.SHEETS.ID,
            range: 'Sheet1!A:C'
        });
        const rows = res.data.values || [];
        let count = 0;
        rows.forEach(row => {
            const phone = normalizePhone(row[0]);
            const topicId = row[1]?.toString();
            const name = row[2]?.toString();
            if (phone) {
                updateCache(phone, topicId, name);
                count++;
            }
        });
        console.log(`✅ Synced ${count} records from Sheets.`);
        return true;
    } catch (e) {
        console.error('❌ Sheet Sync Error:', e.message);
        return false;
    }
}

async function startBackgroundSync() {
    await syncSheetsToMemory();
    // إعادة المزامنة كل 10 دقائق للتأكد
    setInterval(syncSheetsToMemory, 10 * 60 * 1000);
}

// ==========================================
// خدمات WhatsApp
// ==========================================
const waAxios = axios.create({
    baseURL: `https://graph.facebook.com/v20.0/${CONFIG.WHATSAPP.PHONE_ID}`,
    headers: { Authorization: `Bearer ${CONFIG.WHATSAPP.TOKEN}` }
});

// التعامل مع الأخطاء بشكل مركزي
async function safeWaRequest(method, url, data) {
    try {
        const response = await waAxios({ method, url, data });
        return { ok: true, data: response.data, messageId: response.data?.messages?.[0]?.id };
    } catch (e) {
        const errorData = e.response?.data;
        const status = e.response?.status;
        console.error(`❌ WA API Error [${status}]:`, formatWhatsAppError(errorData));
        return { ok: false, status, errorData, errorMessage: formatWhatsAppError(errorData) };
    }
}

async function sendWhatsAppText(phone, body) {
    return safeWaRequest('POST', '/messages', {
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to: phone,
        type: 'text',
        text: { body }
    });
}

async function sendWhatsAppTemplate(phone, bodyText) {
    if (!CONFIG.WHATSAPP.TEMPLATE_NAME) return { ok: false, errorMessage: 'No Template Configured' };
    return safeWaRequest('POST', '/messages', {
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to: phone,
        type: 'template',
        template: {
            name: CONFIG.WHATSAPP.TEMPLATE_NAME,
            language: { code: CONFIG.WHATSAPP.TEMPLATE_LANG },
            components: [{
                type: 'body',
                parameters: [{ type: 'text', text: bodyText }]
            }]
        }
    });
}

async function smartSendWhatsApp(phone, body) {
    // المحاولة الأولى: نص عادي
    const attempt1 = await sendWhatsAppText(phone, body);
    if (attempt1.ok) return { ...attempt1, usedTemplate: false };

    // إذا فشل بسبب انتهاء الجلسة (131047)، نستخدم القالب
    const isSessionExpired = attempt1.errorData?.error?.code === 131047 ||
        (attempt1.errorData?.error?.message || '').includes('outside the allowed window');

    if (isSessionExpired) {
        console.log(`⚠️ Session expired for ${phone}, trying template...`);
        const name = state.names.get(phone) || '';
        const templateBody = name ? `الأستاذ/ة ${name}\n${body}` : body;
        const attempt2 = await sendWhatsAppTemplate(phone, templateBody);
        return { ...attempt2, usedTemplate: true };
    }

    return attempt1;
}

// تحميل و إرسال ميديا من تيليجرام إلى واتساب
async function uploadAndSendMedia(phone, buffer, mimeType, filename, mediaType) {
    try {
        // 1. Upload
        const form = new FormData();
        form.append('messaging_product', 'whatsapp');
        form.append('file', buffer, { filename: filename || 'file', contentType: mimeType });
        if (mimeType) form.append('type', mimeType);

        const uploadRes = await axios.post(
            `https://graph.facebook.com/v20.0/${CONFIG.WHATSAPP.PHONE_ID}/media`,
            form,
            { headers: { Authorization: `Bearer ${CONFIG.WHATSAPP.TOKEN}`, ...form.getHeaders() } }
        );
        const mediaId = uploadRes.data?.id;
        if (!mediaId) throw new Error('No media ID returned');

        // 2. Send
        const payload = {
            messaging_product: 'whatsapp',
            recipient_type: 'individual',
            to: phone,
            type: mediaType,
            [mediaType]: { id: mediaId }
        };
        if (mediaType === 'document' && filename) payload.document.filename = filename;

        return safeWaRequest('POST', '/messages', payload);

    } catch (e) {
        console.error('Media Send Failed:', e.message);
        return { ok: false, errorMessage: e.message };
    }
}

// دالة مساعدة لتحميل ميديا من واتساب وإرسالها لتيليجرام
async function relayMediaToTelegram(message, topicId, phone) {
    try {
        const supportedTypes = ['image', 'video', 'audio', 'document', 'voice', 'sticker'];
        const mediaType = supportedTypes.find(t => message[t]);

        // ============================
        // Handle Location
        // ============================
        if (message.location) {
            const { latitude, longitude, name, address } = message.location;
            console.log(`📍 Location from ${phone}`);

            // Telegram 'sendLocation' doesn't easily support captions or inside topics perfectly with simple interface sometimes, but let's try.
            try {
                // Send specific location
                await bot.telegram.sendLocation(CONFIG.TELEGRAM.CHAT_ID, latitude, longitude, {
                    message_thread_id: topicId,
                    horizontal_accuracy: message.location.accuracy
                });
                // If there is name/address, send as text context
                if (name || address) {
                    await bot.telegram.sendMessage(CONFIG.TELEGRAM.CHAT_ID, `📍 ${name || ''}\n${address || ''}`, { message_thread_id: topicId });
                }
            } catch (locErr) {
                // Fallback to text link
                const mapLink = `https://maps.google.com/?q=${latitude},${longitude}`;
                await bot.telegram.sendMessage(CONFIG.TELEGRAM.CHAT_ID, `📍 موقع من ${phone}:\n${mapLink}`, { message_thread_id: topicId });
            }
            return;
        }

        // ============================
        // Handle Contacts
        // ============================
        if (message.contacts) {
            console.log(`👤 Contacts from ${phone}`);
            for (const contact of message.contacts) {
                const name = contact.name?.formatted_name || 'Unknown';
                const phones = contact.phones?.map(p => p.phone).join(', ') || 'No number';
                await bot.telegram.sendMessage(CONFIG.TELEGRAM.CHAT_ID, `👤 جهة اتصال من ${phone}:\nالاسم: ${name}\nالرقم: ${phones}`, { message_thread_id: topicId });
            }
            return;
        }

        // ============================
        // Handle Button
        // ============================
        if (message.type === 'button' || message.button) {
            const btnText = message.button?.text || message.button?.payload || 'زر غير معروف';
            console.log(`🔘 Button response from ${phone}: ${btnText}`);
            await bot.telegram.sendMessage(CONFIG.TELEGRAM.CHAT_ID, `📩 ${phone}: [زر] ${btnText}`, { message_thread_id: topicId });
            return;
        }

        // ============================
        // Handle Unknown/Unsupported
        // ============================
        if (!mediaType) {
            console.log(`⚠️ Unsupported media type from ${phone}:`, JSON.stringify(message, null, 2));
            // Don't just say "Unsupported", try to give raw info if possible or specific error.
            if (message.interactive) {
                const type = message.interactive.type; // button_reply, list_reply
                let text = '[تفاعل]';
                if (type === 'button_reply') text = `[زر] ${message.interactive.button_reply.title}`;
                if (type === 'list_reply') text = `[قائمة] ${message.interactive.list_reply.title}`;

                await bot.telegram.sendMessage(CONFIG.TELEGRAM.CHAT_ID, `📩 ${phone}: ${text}`, { message_thread_id: topicId });
                return;
            }

            await bot.telegram.sendMessage(CONFIG.TELEGRAM.CHAT_ID, `📩 ${phone}: [مرفق غير مدعوم - راجع السجل]`, { message_thread_id: topicId });
            return;
        }

        // ============================
        // Handle Supported Media
        // ============================
        const mediaItem = message[mediaType];
        const mediaId = mediaItem.id;

        console.log(`📥 Downloading ${mediaType} from ${phone}...`);

        // 1. Get Media URL
        const mediaUrlRes = await axios.get(
            `https://graph.facebook.com/v20.0/${mediaId}`,
            { headers: { Authorization: `Bearer ${CONFIG.WHATSAPP.TOKEN}` } }
        );
        const mediaUrl = mediaUrlRes.data?.url;

        if (!mediaUrl) throw new Error('Failed to get media URL');

        // 2. Download Media Blob
        const fileRes = await axios.get(mediaUrl, {
            responseType: 'arraybuffer',
            headers: {
                Authorization: `Bearer ${CONFIG.WHATSAPP.TOKEN}`,
                'User-Agent': 'WhatsApp-Telegram-Bridge/1.0'
            }
        });

        const fileBuffer = Buffer.from(fileRes.data);
        const caption = message.caption || `وصل ملف (${mediaType}) من ${phone}`;

        // 3. Send to Telegram
        const telegramMethods = {
            image: 'sendPhoto',
            video: 'sendVideo',
            audio: 'sendAudio',
            voice: 'sendVoice',
            document: 'sendDocument',
            sticker: 'sendSticker'
        };

        const method = telegramMethods[mediaType];

        const filePayload = { source: fileBuffer };
        if (mediaType === 'document' && mediaItem.filename) {
            filePayload.filename = mediaItem.filename;
        } else if (mediaType === 'document') {
            // Try to guess extension or default
            const mime = mediaItem.mime_type || 'application/octet-stream';
            const ext = mime.split('/')[1] || 'bin';
            filePayload.filename = `file_${Date.now()}.${ext}`;
        }

        const options = { message_thread_id: topicId };

        if (mediaType !== 'sticker' && mediaType !== 'voice') {
            options.caption = caption;
        }

        try {
            await bot.telegram[method](CONFIG.TELEGRAM.CHAT_ID, filePayload, options);
            console.log(`✅ Relayed ${mediaType} to Telegram topic ${topicId}`);
        } catch (sendErr) {
            // Fallback for document if photo/video fails (sometimes compression issues)
            console.warn(`⚠️ Failed to send as ${mediaType}, trying as document...`, sendErr.message);
            await bot.telegram.sendDocument(CONFIG.TELEGRAM.CHAT_ID, filePayload, { message_thread_id: topicId, caption: caption });
        }

    } catch (e) {
        console.error('❌ Failed to relay media to Telegram:', e.message);
        await bot.telegram.sendMessage(CONFIG.TELEGRAM.CHAT_ID, `⚠️ فشل استلام ملف من ${phone}: ${e.message}`, { message_thread_id: topicId });
    }
}


// ==========================================
// منطق الغرف والربط (Topic & Linking Logic)
// ==========================================
async function getOrCreateTopic(phone) {
    const normalized = normalizePhone(phone);
    if (!normalized) return null;

    // 1. Check Memory Cache
    if (state.topicCache.has(normalized)) return state.topicCache.get(normalized);

    // 2. Check In-Flight (Debounce)
    if (state.inFlightTopics.has(normalized)) return state.inFlightTopics.get(normalized);

    const task = (async () => {
        try {
            // 3. Optional: Double check sheet before creating (redundant if sync works but safe)
            // Not modifying here to keep it fast, relying on bot.on message sync fallback.

            const topic = await bot.telegram.createForumTopic(CONFIG.TELEGRAM.CHAT_ID, `الجار: ${normalized}`);
            const topicId = topic.message_thread_id.toString();

            // Save to Sheet
            await sheets.spreadsheets.values.append({
                spreadsheetId: CONFIG.SHEETS.ID,
                range: 'Sheet1!A:B',
                valueInputOption: 'USER_ENTERED',
                resource: { values: [[normalized, topicId]] }
            });

            updateCache(normalized, topicId);
            return topicId;
        } catch (e) {
            console.error('❌ Topic Creation Error:', e.message);
            return null;
        } finally {
            state.inFlightTopics.delete(normalized);
        }
    })();

    state.inFlightTopics.set(normalized, task);
    return task;
}

// ==========================================
// Webhook Handlers
// ==========================================
app.post('/webhook', async (req, res) => {
    res.sendStatus(200); // رد سريع لتجنب Timeout من فيسبوك

    const change = req.body.entry?.[0]?.changes?.[0]?.value;
    if (!change) return;

    // 1. معالجة تحديثات الحالة (Delivered, Read, Failed)
    if (change.statuses) {
        for (const status of change.statuses) {
            const stored = state.sentMessages.get(status.id);
            if (!stored) continue;

            const topicId = stored.topicId;
            let logMsg = '';

            if (status.status === 'read') {
                logMsg = '✅ تمت القراءة';
            } else if (status.status === 'failed') {
                const errText = formatWhatsAppError({ error: status.errors?.[0] });
                logMsg = `❌ فشل الإرسال: ${errText}`;

                // محاولة إعادة الإرسال الذكي إذا كان الخطأ 131047
                const original = state.outgoingStore.get(status.id);
                if (status.errors?.[0]?.code === 131047 && original && !original.usedTemplate) {
                    console.log(`🔄 Auto-retrying with template for ${original.phone}`);
                    const retry = await smartSendWhatsApp(original.phone, original.body);
                    if (retry.ok) {
                        // تحديث السجل بالرسالة الجديدة
                        state.sentMessages.set(retry.messageId, { topicId, phone: original.phone, createdAt: Date.now() });
                        logMsg = '⚠️ فشلت الرسالة العادية، تم إعادة الإرسال بالقالب تلقائياً ✅';
                    }
                }
            }

            if (logMsg && topicId) {
                try {
                    // Check if topic exists before sending status, but usually fire and forget is fine here.
                    await bot.telegram.sendMessage(CONFIG.TELEGRAM.CHAT_ID, logMsg, { message_thread_id: topicId });
                } catch (e) { /* ignore topic deleted errors here mostly */ }
            }
        }
        return;
    }

    // 2. معالجة الرسائل الواردة
    const message = change.messages?.[0];
    if (message) {
        const phone = normalizePhone(message.from);
        const topicId = await getOrCreateTopic(phone);

        // Mark as Read immediately
        safeWaRequest('POST', '/messages', {
            messaging_product: 'whatsapp', status: 'read', message_id: message.id
        });

        if (!topicId) return;

        try {
            if (message.text) {
                await bot.telegram.sendMessage(CONFIG.TELEGRAM.CHAT_ID, `📩 ${phone}:\n${message.text.body}`, { message_thread_id: topicId });
            } else {
                // التعامل مع الميديا المطور/الموقع/جهات الاتصال واستدعاء الدالة الجديدة
                await relayMediaToTelegram(message, topicId, phone);
            }
        } catch (e) {
            console.error('❌ Failed to relay to Telegram:', e.message);
            // إذا كانت الغرفة محذوفة، ننشئ واحدة جديدة المرة القادمة
            if (e.message.includes('TOPIC_DELETED')) {
                state.topicCache.delete(phone);
            }
        }
    }
});

app.get('/webhook', (req, res) => {
    if (req.query['hub.verify_token'] === CONFIG.WHATSAPP.VERIFY_TOKEN) res.send(req.query['hub.challenge']);
    else res.status(403).send('Error');
});

// ==========================================
// أوامر البوت (Bot Commands)
// ==========================================
bot.command('new', async (ctx) => {
    const phone = normalizePhone(ctx.message.text.replace('/new', ''));
    if (!phone) return ctx.reply('الاستخدام: /new 966xxxxxxx');

    // Check if exists locally first
    const existing = state.topicCache.get(phone);
    if (existing) {
        return ctx.reply(`يوجد غرفة بالفعل لهذا الرقم: ${existing} \nيمكنك استخدامها مباشرة.`);
    }

    const topicId = await getOrCreateTopic(phone);
    if (topicId) ctx.reply(`تم إنشاء الغرفة للرقم ${phone}`);
    else ctx.reply('فشل إنشاء الغرفة.');
});

bot.command('bulk', async (ctx) => {
    const raw = ctx.message.text.replace('/bulk', '').trim();
    if (!raw) return ctx.reply('الشكل المطلوب:\n/bulk الرقم1, الرقم2 | الرسالة');

    let [numbersPart, msgPart] = raw.includes('|') ? raw.split('|') : [raw.split('\n').join(','), ''];
    let message = msgPart ? msgPart.trim() : numbersPart.split('\n')[0]; // fallback logic

    if (raw.includes('|')) {
        // Strict pipe mode
        message = msgPart.trim();
    } else {
        const lines = raw.split('\n').map(l => l.trim()).filter(Boolean);
        if (lines.length > 1) {
            message = lines[0]; // First line is MSG
            numbersPart = lines.slice(1).join(','); // Rest are numbers
        }
    }

    const numbers = numbersPart.split(/[, \n]+/).map(normalizePhone).filter(Boolean);
    if (!numbers.length || !message) return ctx.reply('تأكد من كتابة الأرقام والرسالة.');

    ctx.reply(`جاري إرسال ${numbers.length} رسالة...`);

    let stats = { success: 0, failed: 0 };

    // إرسال متتابع بفاصل زمني (Queueing)
    for (const phone of numbers) {
        try {
            const res = await smartSendWhatsApp(phone, message);
            const topicId = await getOrCreateTopic(phone); // Ensure topic exists for logging

            if (res.ok) {
                stats.success++;
                if (topicId) {
                    state.sentMessages.set(res.messageId, { topicId, phone, createdAt: Date.now() });
                    bot.telegram.sendMessage(CONFIG.TELEGRAM.CHAT_ID, `📤 رسالة جماعية: ${message}`, { message_thread_id: topicId }).catch(() => { });
                }
            } else {
                stats.failed++;
                if (topicId) {
                    bot.telegram.sendMessage(CONFIG.TELEGRAM.CHAT_ID, `❌ فشل جماعي: ${res.errorMessage}`, { message_thread_id: topicId }).catch(() => { });
                }
            }
        } catch (e) {
            stats.failed++;
        }
        await sleep(300); // 300ms delay between sends
    }

    ctx.reply(`انتهى الإرسال.\n✅ نجاح: ${stats.success}\n❌ فشل: ${stats.failed}`);
    saveStateToDisk(); // Save state after bulk
});

bot.on('message', async (ctx) => {
    const topicId = ctx.message.message_thread_id?.toString();
    if (!topicId) return;

    // البحث عن الرقم المرتبط بهذه الغرفة
    let phone = state.reverseTopicCache.get(topicId);

    // If phone not found in cache, try to resync and check again (Fix for "Room not linked")
    if (!phone) {
        console.log(`⚠️ Topic ${topicId} not in cache, attempting sync...`);
        const synced = await syncSheetsToMemory();
        if (synced) {
            phone = state.reverseTopicCache.get(topicId);
        }
    }

    if (!phone) {
        // Maybe the user deleted the row from the sheet or something?
        return ctx.reply('هذه الغرفة غير مرتبطة برقم واتساب (أو لم تتم المزامنة بعد). استخدم /new للإنشاء الصحيح.');
    }

    if (ctx.message.text && !ctx.message.text.startsWith('/')) {
        const res = await smartSendWhatsApp(phone, ctx.message.text);
        if (res.ok) {
            state.sentMessages.set(res.messageId, { topicId, phone, createdAt: Date.now() });
            state.outgoingStore.set(res.messageId, { phone, body: ctx.message.text, usedTemplate: res.usedTemplate, createdAt: Date.now() });
            saveStateToDisk();
            ctx.reply(`✅ ${res.usedTemplate ? 'قالب' : 'تم'}`);
        } else {
            ctx.reply(`❌ خطأ: ${res.errorMessage}`);
        }
    }

    // Media Handling (Photo/Video/etc) - Simplified for brevity but functional
    if (ctx.message.photo || ctx.message.video || ctx.message.document || ctx.message.voice) {
        const file = ctx.message.photo ? ctx.message.photo.pop() : (ctx.message.video || ctx.message.document || ctx.message.voice);
        const fileLink = await bot.telegram.getFileLink(file.file_id);
        const bufferRes = await axios.get(fileLink.href, { responseType: 'arraybuffer' });

        let type = 'document';
        if (ctx.message.photo) type = 'image';
        if (ctx.message.video) type = 'video';
        if (ctx.message.voice) type = 'audio';

        const res = await uploadAndSendMedia(phone, Buffer.from(bufferRes.data), file.mime_type, file.file_name || 'file', type);
        if (res.ok) ctx.reply('✅ ميديا تم');
        else ctx.reply('❌ ميديا فشل');
    }
});

// ==========================================
// التشغيل (Boot)
// ==========================================
async function bootstrap() {
    loadStateFromDisk();
    await startBackgroundSync();

    if (CONFIG.TELEGRAM.WEBHOOK_DOMAIN) {
        app.use(bot.webhookCallback(CONFIG.TELEGRAM.WEBHOOK_PATH));
        await bot.telegram.setWebhook(`${CONFIG.TELEGRAM.WEBHOOK_DOMAIN}${CONFIG.TELEGRAM.WEBHOOK_PATH}`);
        console.log(`🤖 Telegram Webhook Set: ${CONFIG.TELEGRAM.WEBHOOK_DOMAIN}`);
    } else {
        bot.launch();
        console.log('🤖 Telegram Polling Started');
    }

    const PORT = process.env.PORT || 10000;
    app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
}

bootstrap();
