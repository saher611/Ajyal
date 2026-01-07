const express = require('express');
const axios = require('axios');
const { Telegraf } = require('telegraf');
const { google } = require('googleapis');

const app = express();
app.use(express.json());

// الإعدادات من Render
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const META_ACCESS_TOKEN = process.env.META_ACCESS_TOKEN;
const META_PHONE_ID = process.env.META_PHONE_ID;
const SPREADSHEET_ID = '1coOeDXKCqgDLVrHBAwtIQ8hsDJQPED3oL1Jp-Ad7jmk';

const bot = new Telegraf(TELEGRAM_TOKEN);

// إعداد جوجل شيت
const GOOGLE_EMAIL = process.env.GOOGLE_EMAIL;
const GOOGLE_KEY = process.env.GOOGLE_KEY.replace(/\\n/g, '\n');
const auth = new google.auth.JWT(GOOGLE_EMAIL, null, GOOGLE_KEY, ['https://www.googleapis.com/auth/spreadsheets']);
const sheets = google.sheets({ version: 'v4', auth });

// وظيفة جلب الرقم من الجدول
async function getPhoneFromSheet(topicId) {
    try {
        const res = await sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: 'Sheet1!A:B' });
        const rows = res.data.values;
        if (!rows) return null;
        const match = rows.reverse().find(row => row[0] == topicId.toString());
        return match ? match[1] : null;
    } catch (e) { return null; }
}

// الرد من تليجرام إلى واتساب (عبر META)
bot.on('message', async (ctx) => {
    try {
        const topicId = ctx.message.message_thread_id;
        const phone = await getPhoneFromSheet(topicId);
        if (phone && ctx.message.text) {
            await axios.post(`https://graph.facebook.com/v18.0/${META_PHONE_ID}/messages`, {
                messaging_product: "whatsapp",
                to: phone,
                text: { body: ctx.message.text }
            }, { headers: { 'Authorization': `Bearer ${META_ACCESS_TOKEN}` } });
            
            await ctx.reply("✅ تم الإرسال عبر واتساب (ميتا)");
        }
    } catch (e) { console.error("Meta Send Error:", e.response?.data || e.message); }
});

// استقبال رسائل واتساب من ميتا (Webhook)
app.post('/webhook', async (req, res) => {
    // كود معالجة رسائل ميتا الواردة وتحويلها لتليجرام يوضع هنا
    res.sendStatus(200);
});

// تأكيد الـ Webhook لميتا (ضروري)
app.get('/webhook', (req, res) => {
    const mode = req.query['hub.mode'];
    const token = req.query['hub.verify_token'];
    const challenge = req.query['hub.challenge'];
    if (mode === 'subscribe' && token === 'MY_VERIFY_TOKEN') { // استبدل MY_VERIFY_TOKEN بما عندك في ميتا
        res.status(200).send(challenge);
    }
});

app.listen(process.env.PORT || 10000, () => {
    bot.launch();
    console.log("System Online with Meta & Google Sheets ✅");
});
