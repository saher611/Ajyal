const express = require('express');
const axios = require('axios');
const app = express();
app.use(express.json());

const port = process.env.PORT || 3000;
const telegramToken = process.env.TELEGRAM_TOKEN;
const telegramChatId = process.env.TELEGRAM_CHAT_ID;
const whatsappToken = process.env.WHATSAPP_TOKEN;
const phoneId = process.env.PHONE_NUMBER_ID;

const replyMap = new Map();

// دالة لجلب رابط الوسائط من واتساب
async function getWhatsappMediaUrl(mediaId) {
    try {
        const res = await axios.get(`https://graph.facebook.com/v21.0/${mediaId}`, {
            headers: { 'Authorization': `Bearer ${whatsappToken}` }
        });
        return res.data.url;
    } catch (e) { return null; }
}

app.post('/', async (req, res) => {
    const body = req.body;

    // 1. من واتساب إلى تليجرام (نص + وسائط)
    if (body.object === 'whatsapp_business_account' && body.entry[0].changes[0].value.messages) {
        const msg = body.entry[0].changes[0].value.messages[0];
        const from = msg.from;
        let telegramMsg;

        try {
            if (msg.type === 'text') {
                telegramMsg = await axios.post(`https://api.telegram.org/bot${telegramToken}/sendMessage`, {
                    chat_id: telegramChatId,
                    text: `👤 من: ${from}\n💬: ${msg.text.body}`
                });
            } else if (['image', 'video', 'document', 'audio'].includes(msg.type)) {
                const mediaId = msg[msg.type].id;
                const mediaUrl = await getWhatsappMediaUrl(mediaId);
                const caption = `👤 من: ${from}\n📎 وسائط (${msg.type})`;
                
                const method = msg.type === 'image' ? 'sendPhoto' : msg.type === 'video' ? 'sendVideo' : 'sendDocument';
                telegramMsg = await axios.post(`https://api.telegram.org/bot${telegramToken}/${method}`, {
                    chat_id: telegramChatId,
                    [msg.type === 'image' ? 'photo' : msg.type]: mediaUrl,
                    caption: caption
                });
            }
            if (telegramMsg) replyMap.set(telegramMsg.data.result.message_id, from);
        } catch (e) { console.error("خطأ تحويل لتليجرام"); }
        return res.sendStatus(200);
    }

    // 2. من تليجرام إلى واتساب (ردود نصية + وسائط)
    if (body.message && body.message.reply_to_message) {
        const whatsappRecipient = replyMap.get(body.message.reply_to_message.message_id);
        if (whatsappRecipient) {
            try {
                if (body.message.text) {
                    await axios.post(`https://graph.facebook.com/v21.0/${phoneId}/messages`, {
                        messaging_product: "whatsapp", to: whatsappRecipient, text: { body: body.message.text }
                    }, { headers: { 'Authorization': `Bearer ${whatsappToken}` } });
                } else if (body.message.photo || body.message.document) {
                    // ملاحظة: إرسال الوسائط من تليجرام لواتساب يتطلب رفعها أولاً أو استخدام روابط مباشرة
                    // هنا نرسل إشعاراً للموظف حالياً لضمان استقرار الكود
                    await axios.post(`https://api.telegram.org/bot${telegramToken}/sendMessage`, {
                        chat_id: telegramChatId, text: "⚠️ إرسال الوسائط من تليجرام لواتساب يتطلب برمجة إضافية للرفع، حالياً الردود النصية فقط مدعومة.",
                        reply_to_message_id: body.message.message_id
                    });
                }
            } catch (e) { console.error("خطأ رد واتساب"); }
        }
    }
    res.sendStatus(200);
});

app.listen(port);
