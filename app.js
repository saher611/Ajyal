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

// دالة لجلب أو إنشاء توبيك وتسجيله في الجدول
async function getOrCreateTopic(phone) {
    try {
        const res = await sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: 'Sheet1!A:B' });
        const rows = res.data.values || [];
        const existing = rows.find(row => row[0] == phone);
        if (existing) return existing[1];

        // إذا الجار جديد، نفتح له توبيك (تأكد أن البوت Admin في القروب)
        const topic = await bot.telegram.createForumTopic(TELEGRAM_CHAT_ID, `الجار: ${phone}`);
        const topicId = topic.message_thread_id;

        // تسجيل البيانات في Sheet1
        await sheets.spreadsheets.values.append({
            spreadsheetId: SPREADSHEET_ID, range: 'Sheet1!A:B',
            valueInputOption: 'USER_ENTERED',
            resource: { values: [[phone, topicId]] }
        });
        return topicId;
    } catch (e) {
        console.error("خطأ في الجدول أو التوبيك:", e.message);
        return null; 
    }
}

// 1. استقبال من واتساب وإرسال لتليجرام
app.post('/webhook', async (req, res) => {
    const entry = req.body.entry?.[0]?.changes?.[0]?.value;
    const message = entry?.messages?.[0];
    if (message) {
        const phone = message.from;
        const text = message.text?.body || "رسالة غير نصية";
        const topicId = await getOrCreateTopic(phone);
        await bot.telegram.sendMessage(TELEGRAM_CHAT_ID, `📩 من ${phone}:\n${text}`, { 
            message_thread_id: topicId || undefined 
        });
    }
    res.sendStatus(200);
});

// 2. الرد من تليجرام لواتساب
bot.on('message', async (ctx) => {
    const topicId = ctx.message.message_thread_id;
    const replyText = ctx.message.text;
    if (topicId && replyText) {
        try {
            const res = await sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: 'Sheet1!A:B' });
            const rows = res.data.values || [];
            const match = rows.find(row => row[1] == topicId.toString());
            if (match) {
                await axios.post(`https://graph.facebook.com/v18.0/${PHONE_NUMBER_ID}/messages`, {
                    messaging_product: "whatsapp", to: match[0], type: "text", text: { body: replyText }
                }, { headers: { 'Authorization': `Bearer ${WHATSAPP_TOKEN}` } });
            }
        } catch (e) { console.error("فشل إرسال الرد لواتساب:", e.message); }
    }
});

app.get('/webhook', (req, res) => {
    if (req.query['hub.verify_token'] === VERIFY_TOKEN) res.send(req.query['hub.challenge']);
    else res.send('Error');
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
    console.log("Ajyal System Pro Online ✅");
    bot.launch().catch(err => console.error("فشل تشغيل بوت تليجرام:", err.message));
});
