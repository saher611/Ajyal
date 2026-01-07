const express = require('express');
const axios = require('axios');
const { Telegraf } = require('telegraf');
const { google } = require('googleapis');

const app = express();
app.use(express.json());

// --- الربط مع خزنة Render (Environment Variables) ---
// الكود سيسحب التوكن والمفتاح تلقائياً من الخانات التي ملأتها في Render
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const GOOGLE_EMAIL = process.env.GOOGLE_EMAIL;
const GOOGLE_KEY = process.env.GOOGLE_KEY ? process.env.GOOGLE_KEY.replace(/\\n/g, '\n') : undefined;

const SPREADSHEET_ID = '1coOeDXKCqgDLVrHBAwtIQ8hsDJQPED3oL1Jp-Ad7jmk';
const ULTRAMSG_INSTANCE = 'instance101905'; 
const ULTRAMSG_TOKEN = '689f9euh50m2l8d1'; 

const bot = new Telegraf(TELEGRAM_TOKEN);

// إعداد جوجل باستخدام البيانات المسحوبة من Render
const auth = new google.auth.JWT(GOOGLE_EMAIL, null, GOOGLE_KEY, ['https://www.googleapis.com/auth/spreadsheets']);
const sheets = google.sheets({ version: 'v4', auth });

// جلب الهاتف من الجدول بناءً على رقم التوبيك
async function getPhoneFromSheet(topicId) {
    try {
        const res = await sheets.spreadsheets.values.get({
            spreadsheetId: SPREADSHEET_ID, range: 'Sheet1!A:B' 
        });
        const rows = res.data.values;
        if (!rows) return null;
        const match = rows.reverse().find(row => row[0] == topicId.toString());
        return match ? match[1] : null;
    } catch (e) { 
        console.error("خطأ في قراءة الجدول:", e.message);
        return null; 
    }
}

// استقبال ردودك من تليجرام وإرسالها لواتساب
bot.on('message', async (ctx) => {
    try {
        const topicId = ctx.message.message_thread_id;
        if (topicId && ctx.message.text) {
            const phone = await getPhoneFromSheet(topicId);
            if (phone) {
                await axios.post(`https://api.ultramsg.com/${ULTRAMSG_INSTANCE}/messages/chat`, {
                    token: ULTRAMSG_TOKEN, to: phone, body: ctx.message.text
                });
                await ctx.reply("✅ تم الإرسال للجار");
            }
        }
    } catch (e) { console.error("Error sending to WhatsApp:", e.message); }
});

app.get('/', (req, res) => res.send('System Online - Secure Mode ✅'));

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
    if (TELEGRAM_TOKEN) {
        bot.launch()
            .then(() => console.log("Telegram Bot Started ✅"))
            .catch(err => console.error("Bot fail:", err.message));
    } else {
        console.error("خطأ: TELEGRAM_TOKEN غير موجود في إعدادات Render!");
    }
});
