const express = require('express');
const axios = require('axios');
const { Telegraf } = require('telegraf');
const { google } = require('googleapis');

const app = express();
app.use(express.json());

// سحب البيانات من إعدادات Render (خزنة الأسرار)
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const GOOGLE_EMAIL = process.env.GOOGLE_EMAIL;
const GOOGLE_KEY = process.env.GOOGLE_KEY ? process.env.GOOGLE_KEY.replace(/\\n/g, '\n') : undefined;

const SPREADSHEET_ID = '1coOeDXKCqgDLVrHBAwtIQ8hsDJQPED3oL1Jp-Ad7jmk';
const ULTRAMSG_INSTANCE = 'instance101905'; 
const ULTRAMSG_TOKEN = '689f9euh50m2l8d1'; 

const bot = new Telegraf(TELEGRAM_TOKEN);

const auth = new google.auth.JWT(GOOGLE_EMAIL, null, GOOGLE_KEY, ['https://www.googleapis.com/auth/spreadsheets']);
const sheets = google.sheets({ version: 'v4', auth });

// وظيفة جلب الهاتف من جدول جوجل
async function getPhoneFromSheet(topicId) {
    try {
        const res = await sheets.spreadsheets.values.get({
            spreadsheetId: SPREADSHEET_ID, range: 'Sheet1!A:B' 
        });
        const rows = res.data.values;
        if (!rows) return null;
        const match = rows.reverse().find(row => row[0] == topicId.toString());
        return match ? match[1] : null;
    } catch (e) { return null; }
}

// الرد من تليجرام إلى واتساب
bot.on('message', async (ctx) => {
    try {
        const topicId = ctx.message.message_thread_id;
        if (topicId && ctx.message.text) {
            const phone = await getPhoneFromSheet(topicId);
            if (phone) {
                await axios.post(`https://api.ultramsg.com/${ULTRAMSG_INSTANCE}/messages/chat`, {
                    token: ULTRAMSG_TOKEN, to: phone, body: ctx.message.text
                });
                await ctx.reply("✅ تم إرسال الرد للجار عبر واتساب");
            }
        }
    } catch (e) { console.error("WhatsApp Send Error:", e.message); }
});

app.get('/', (req, res) => res.send('Ajyal Bot is Secure & Online! ✅'));

const PORT = process.env.PORT || 10000;
app.listen(PORT, async () => {
    console.log(`Server is running on port ${PORT}`);
    try {
        // حذف أي جلسة قديمة لتجنب خطأ 409 Conflict
        await axios.get(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/deleteWebhook?drop_pending_updates=true`);
        bot.launch();
        console.log("Telegram Bot Connected ✅ - البوت يعمل الآن بنجاح");
    } catch (err) {
        console.error("Connection Error:", err.message);
    }
});
