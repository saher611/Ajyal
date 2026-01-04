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

// دالة محسنة لجلب رابط الوسائط مع طباعة الأخطاء
async function getWhatsappMediaUrl(mediaId) {
    try {
        const res = await axios.get(`https://graph.facebook.com/v21.0/${mediaId}`, {
            headers: { 'Authorization': `Bearer ${whatsappToken}` }
        });
        return res.data.url; 
    } catch (e) {
        console.error("❌ فشل جلب رابط الميديا من واتساب:", e.response ? e.response.data : e.message);
        return null;
    }
}

app.post('/', async (req, res) => {
    const body = req.body;

    // 1. استقبال من واتساب وتحويل لتليجرام
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
            } 
            // التعامل مع الصور والفيديوهات والملفات
            else if (['image', 'video', 'document', 'audio'].includes(msg.type)) {
                const mediaData = msg[msg.type];
                const mediaId = mediaData.id;
                const mediaUrl = await getWhatsappMediaUrl(mediaId);
                
                if (mediaUrl) {
                    const caption = `👤 من: ${from}\n📎 وسائط (${msg.type})\n${mediaData.caption || ''}`;
                    const method = msg.type === 'image' ? 'sendPhoto' : msg.type === 'video' ? 'sendVideo' : 'sendDocument';
                    
                    telegramMsg = await axios.post(`https://api.telegram.org/bot${telegramToken}/${method}`, {
                        chat_id: telegramChatId,
                        [msg.type === 'image' ? 'photo' : msg.type]: mediaUrl,
                        caption: caption
                    });
                } else {
                    console.error("⚠️ تعذر تحويل الميديا لأن الرابط فارغ");
                }
            }

            if (telegramMsg) {
                replyMap.set(telegramMsg.data.result.message_id, from);
            }
        } catch (e) {
            console.error("❌ خطأ أثناء الإرسال لتليجرام:", e.response ? e.response.data : e.message);
        }
        return res.sendStatus(200);
    }

    // 2. الرد من تليجرام إلى واتساب
    if (body.message && body.message.reply_to_message) {
        const whatsappRecipient = replyMap.get(body.message.reply_to_message.message_id);
        if (whatsappRecipient) {
            try {
                if (body.message.text) {
                    await axios.post(`https://graph.facebook.com/v21.0/${phoneId}/messages`, {
                        messaging_product: "whatsapp",
                        to: whatsappRecipient,
                        text: { body: body.message.text }
                    }, { headers: { 'Authorization': `Bearer ${whatsappToken}` } });
                } 
                else {
                    await axios.post(`https://api.telegram.org/bot${telegramToken}/sendMessage`, {
                        chat_id: telegramChatId,
                        text: "⚠️ الردود حالياً مدعومة للنصوص فقط. الوسائط قيد التطوير.",
                        reply_to_message_id: body.message.message_id
                    });
                }
            } catch (e) {
                console.error("❌ خطأ في الرد لواتساب:", e.response ? e.response.data : e.message);
            }
        }
    }
    res.sendStatus(200);
});

app.listen(port, () => {
    console.log(`✅ السيرفر يعمل بنجاح على المنفذ ${port}`);
});
