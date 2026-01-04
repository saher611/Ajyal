const express = require('express');
const axios = require('axios');
const FormData = require('form-data');
const app = express();
app.use(express.json());

const port = process.env.PORT || 10000;
const telegramToken = process.env.TELEGRAM_TOKEN;
const telegramChatId = process.env.TELEGRAM_CHAT_ID;
const whatsappToken = process.env.WHATSAPP_TOKEN;
const phoneId = process.env.PHONE_NUMBER_ID;

// دالة تحميل الميديا من واتساب
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
        console.error("❌ فشل تحميل الملف:", e.message);
        return null;
    }
}

app.post('/', async (req, res) => {
    const body = req.body;

    // 1. من واتساب إلى تليجرام (إضافة الرقم في النص لضمان عدم ضياعه)
    if (body.object === 'whatsapp_business_account' && body.entry[0].changes[0].value.messages) {
        const msg = body.entry[0].changes[0].value.messages[0];
        const from = msg.from;
        const footer = `\n\n#ID_${from}`; // علامة مخفية تحتوي على الرقم

        try {
            if (msg.type === 'text') {
                await axios.post(`https://api.telegram.org/bot${telegramToken}/sendMessage`, {
                    chat_id: telegramChatId,
                    text: `👤 من: ${from}\n💬: ${msg.text.body}${footer}`
                });
            } else if (['image', 'video', 'document'].includes(msg.type)) {
                const fileData = await downloadWhatsappMedia(msg[msg.type].id);
                if (fileData) {
                    const formData = new FormData();
                    formData.append('chat_id', telegramChatId);
                    formData.append('caption', `👤 من: ${from}\n📎 وسائط (${msg.type})${footer}`);
                    formData.append(msg.type === 'image' ? 'photo' : msg.type, fileData, { filename: 'file' });

                    const method = msg.type === 'image' ? 'sendPhoto' : msg.type === 'video' ? 'sendVideo' : 'sendDocument';
                    await axios.post(`https://api.telegram.org/bot${telegramToken}/${method}`, formData, {
                        headers: formData.getHeaders()
                    });
                }
            }
        } catch (e) { console.error("❌ خطأ تليجرام:", e.message); }
        return res.sendStatus(200);
    }

    // 2. من تليجرام إلى واتساب (استخراج الرقم من الرسالة الأصلية)
    if (body.message && body.message.reply_to_message) {
        const originalText = body.message.reply_to_message.text || body.message.reply_to_message.caption || "";
        const match = originalText.match(/#ID_(\d+)/); // البحث عن العلامة المخفية
        
        if (match) {
            const whatsappRecipient = match[1];
            try {
                if (body.message.text) {
                    await axios.post(`https://graph.facebook.com/v21.0/${phoneId}/messages`, {
                        messaging_product: "whatsapp",
                        to: whatsappRecipient,
                        text: { body: body.message.text }
                    }, { headers: { 'Authorization': `Bearer ${whatsappToken}` } });
                    
                    console.log(`✅ تم الرد بنجاح على الرقم: ${whatsappRecipient}`);
                }
            } catch (e) {
                console.error("❌ فشل الرد لواتساب:", e.response ? JSON.stringify(e.response.data) : e.message);
            }
        } else {
            console.warn("⚠️ لم يتم العثور على وسم ID في الرسالة. تأكد من الرد على رسالة صحيحة.");
        }
    }
    res.sendStatus(200);
});

app.listen(port, () => console.log(`✅ السيرفر يعمل على المنفذ ${port}`));
