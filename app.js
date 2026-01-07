const express = require('express');
const axios = require('axios');
const { Telegraf } = require('telegraf');
const { google } = require('googleapis');

const app = express();
app.use(express.json());

// --- الربط مع خزنة Render (Environment Variables) ---
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID;
const VERIFY_TOKEN = process.env.VERIFY_TOKEN;
const GOOGLE_EMAIL = process.env.GOOGLE_EMAIL;
const GOOGLE_KEY = process.env.GOOGLE_KEY ? process.env.GOOGLE_KEY.replace(/\\n/g, '\n') : undefined;

const SPREADSHEET_ID = '1coOeDXKCqgDLVrHBAwtIQ8hsDJQPED3oL1Jp-Ad7jmk';

const bot = new Telegraf(TELEGRAM_TOKEN);

// --- إعداد جوجل شيت ---
const auth = new google.auth.JWT(GOOGLE_EMAIL, null, GOOGLE_KEY, ['https://www.googleapis.com/auth/spreadsheets']);
const sheets = google.sheets({ version: 'v4', auth });

// وظيفة لجلب رقم الهاتف من الجدول بناءً على رقم التوبيك (Topic ID)
async function getPhoneFromSheet(topicId) {
    try {
        const res = await sheets.spreadsheets.values.get({
            spreadsheetId: SPREADSHEET_ID,
            range: 'Sheet1!A:B'
        });
        const rows = res.data.values;
        if (!rows) return null;
        // البحث في العمود الثاني (TopicID) وإرجاع العمود الأول (Phone)
        const match = rows.reverse().find(row => row[1] == topicId.toString());
        return match ? match[0] : null;
    } catch (e) {
        console.error("خطأ في قراءة الجدول:", e.message);
        return null;
    }
}

// 1. استقبال الرد من تليجرام وإرساله لواتساب (عبر ميتا)
bot.on('message', async (ctx) => {
    try {
        const topicId = ctx.message.message_thread_id;
        if (topicId && ctx.message.text) {
            const phone = await getPhoneFromSheet(topicId);
            if (phone) {
                await axios.post(`https://graph.facebook.com/v18.0/${PHONE_NUMBER_ID}/messages`, {
                    messaging_product: "whatsapp",
                    to: phone,
                    type: "text",
                    text: { body: ctx.message.text }
                }, {
                    headers: { 'Authorization': `Bearer ${WHATSAPP_TOKEN}` }
                });
                await ctx.reply("✅ تم إرسال الرد للجار عبر واتساب");
            } else {
                await ctx.reply(`⚠️ التوبيك ${topicId} غير مربوط برقم في الجدول.`);
            }
        }
    } catch (e) {
        console.error("Meta Send Error:", e.response?.data || e.message);
    }
});

// 2. استقبال رسائل واتساب من ميتا وتحويلها لتليجرام (Webhook)
app.post('/webhook', async (req, res) => {
    try {
        const entry = req.body.entry?.[0]?.changes?.[0]?.value;
        const message = entry?.messages?.[0];
        if (message) {
            const phone = message.from;
            const text = message.text?.body;
            // إرسال الرسالة للقروب الرئيسي في تليجرام
            await bot.telegram.sendMessage(TELEGRAM_CHAT_ID, `📩 رسالة من واتساب (${phone}):\n\n${text}`);
        }
    } catch (e) {
        console.error("Webhook Receive Error:", e.message);
    }
    res.sendStatus(200);
});

// 3. تأكيد الـ Webhook لميتا (ضروري للربط)
app.get('/webhook', (req, res) => {
    if (req.query['hub.verify_token'] === VERIFY_TOKEN) {
        res.send(req.query['hub.challenge']);
    } else {
        res.send('Error, wrong validation token');
    }
});

app.get('/', (req, res) => res.send('Ajyal Bot System Online ✅'));

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
    bot.launch()
        .then(() => console.log("Telegram Bot Started ✅"))
        .catch(err => console.error("Bot fail:", err.message));
});
