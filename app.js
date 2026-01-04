const express = require('express');
const axios = require('axios');
const app = express();
app.use(express.json());

const port = process.env.PORT || 10000;
const telegramToken = process.env.TELEGRAM_TOKEN;
const telegramChatId = process.env.TELEGRAM_CHAT_ID;
const whatsappToken = process.env.WHATSAPP_TOKEN;
const phoneId = process.env.PHONE_NUMBER_ID;

const replyMap = new Map();

// دالة لجلب الميديا كـ "ملف" (Buffer) وليس كرابط
async function downloadWhatsappMedia(mediaId) {
    try {
        const resInfo = await axios.get(`https://graph.facebook.com/v21.0/${mediaId}`, {
            headers: { 'Authorization': `Bearer ${whatsappToken}` }
        });
        const mediaBuffer = await axios.get(resInfo.data.url, {
            headers: { 'Authorization': `Bearer ${whatsappToken}` },
            responseType: 'arraybuffer'
        });
        return mediaBuffer.data;
    } catch (e) {
        console.error("❌ فشل تحميل الملف من واتساب:", e.message);
        return null;
    }
}

app.post('/', async (req, res) => {
    const body = req.body;
    if (body.object === 'whatsapp_business_account' && body.entry[0].changes[0].value.messages) {
        const msg = body.entry[0].changes[0].value.messages[0];
        const from = msg.from;
        let telegramMsg;

        try {
            if (msg.type === 'text') {
                telegramMsg = await axios.post(`https://api.telegram.org/bot${telegramToken}/sendMessage`, {
                    chat_id: telegramChatId, text: `👤 من: ${from}\n💬: ${msg.text.body}`
                });
            } 
            else if (['image', 'video', 'document'].includes(msg.type)) {
                const fileData = await downloadWhatsappMedia(msg[msg.type].id);
                if (fileData) {
                    const formData = new (require('form-data'))();
                    formData.append('chat_id', telegramChatId);
                    formData.append('caption', `👤 من: ${from}\n📎 وسائط (${msg.type})`);
                    formData.append(msg.type === 'image' ? 'photo' : msg.type, fileData, { filename: 'file' });

                    const method = msg.type === 'image' ? 'sendPhoto' : msg.type === 'video' ? 'sendVideo' : 'sendDocument';
                    telegramMsg = await axios.post(`https://api.telegram.org/bot${telegramToken}/${method}`, formData, {
                        headers: formData.getHeaders()
                    });
                }
            }
            if (telegramMsg) replyMap.set(telegramMsg.data.result.message_id, from);
        } catch (e) {
            console.error("❌ خطأ أثناء الإرسال لتليجرام:", e.response ? e.response.data : e.message);
        }
        return res.sendStatus(200);
    }
    // ... (باقي كود الرد النصي كما هو)
    res.sendStatus(200);
});

app.listen(port, () => console.log(`✅ السيرفر يعمل على المنفذ ${port}`));
