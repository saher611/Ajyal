const express = require('express');
const axios = require('axios');
const { Telegraf } = require('telegraf');
const { google } = require('googleapis');

const app = express();
app.use(express.json());

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

// وظيفة لإرسال "تمت القراءة" لواتساب (لتظهر الصحين الزرقاء)
async function markAsRead(messageId) {
    try {
        await axios({
            method: 'POST',
            url: `https://graph.facebook.com/v20.0/${PHONE_NUMBER_ID}/messages`,
            data: {
                messaging_product: "whatsapp",
                status: "read",
                message_id: messageId
            },
            headers: { 'Authorization': `Bearer ${WHATSAPP_TOKEN}` }
        });
    } catch (e) { console.error("Error marking read:", e.message); }
}

async function getOrCreateTopic(phone) {
    try {
        const res = await sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: 'Sheet1!A:B' });
        const rows = res.data.values || [];
        const existing = rows.find(row => row[0] == phone);
        if (existing) return existing[1];

        const topic = await bot.telegram.createForumTopic(TELEGRAM_CHAT_ID, `الجار: ${phone}`);
        const topicId = topic.message_thread_id;

        await sheets.spreadsheets.values.append({
            spreadsheetId: SPREADSHEET_ID, range: 'Sheet1!A:B',
            valueInputOption: 'USER_ENTERED',
            resource: { values: [[phone, topicId]] }
        });
        return topicId;
    } catch (e) { return null; }
}

app.post('/webhook', async (req, res) => {
    const entry = req.body.entry?.[0]?.changes?.[0]?.value;
    const message = entry?.messages?.[0];
    if (message) {
        const phone = message.from;
        const text = message.text?.body || "رسالة جديدة";
        const messageId = message.id;

        const topicId = await getOrCreateTopic(phone);
        await bot.telegram.sendMessage(TELEGRAM_CHAT_ID, `📩 من ${phone}:\n${text}`, { 
            message_thread_id: topicId || undefined 
        });

        // تفعيل الصحين الزرقاء فوراً
        await markAsRead(messageId);
    }
    res.sendStatus(200);
});

bot.on('message', async (ctx) => {
    const topicId = ctx.message.message_thread_id;
    if (topicId && ctx.message.text) {
        try {
            const res = await sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: 'Sheet1!A:B' });
            const rows = res.data.values || [];
            const match = rows.find(row => row[1] == topicId.toString());
            if (match) {
                await axios({
                    method: 'POST',
                    url: `https://graph.facebook.com/v20.0/${PHONE_NUMBER_ID}/messages`,
                    data: {
                        messaging_product: "whatsapp",
                        recipient_type: "individual",
                        to: match[0],
                        type: "text",
                        text: { body: ctx.message.text }
                    },
                    headers: { 'Authorization': `Bearer ${WHATSAPP_TOKEN}` }
                });
            }
        } catch (e) { console.error("Send Error:", e.message); }
    }
});

app.get('/webhook', (req, res) => {
    if (req.query['hub.verify_token'] === VERIFY_TOKEN) res.send(req.query['hub.challenge']);
    else res.send('Error');
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
    console.log("Ajyal System Pro Online ✅");
    bot.launch();
});
