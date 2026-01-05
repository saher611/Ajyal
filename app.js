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

// دالة جلب الميديا مع معالجة الأسماء لتناسب الجوال
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
        console.error("❌ فشل في جلب الميديا من واتساب:", e.message);
        return null;
    }
}

app.post('/', async (req, res) => {
    const body = req.body;

    // استقبال الرسائل من واتساب وتحويلها لتليجرام
    if (body.object === 'whatsapp_business_account' && body.entry[0].changes[0].value.messages) {
        const msg = body.entry[0].changes[0].value.messages[0];
        const from = msg.from;
        const footer = `\n\n#ID_${from}`; // الوسم لضمان معرفة الرقم عند الرد

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

                    // حل مشكلة ملفات الـ PDF (إعطاء اسم وصيغة للملف)
                    let ext = msg.type === 'image' ? 'jpg' : msg.type === 'video' ? 'mp4' : 'pdf';
                    let fileName = msg.document?.filename || `file_${Date.now()}.${ext}`;
                    
                    formData.append(msg.type === 'image' ? 'photo' : (msg.type === 'video' ? 'video' : 'document'), fileData, { filename: fileName });

                    const method = msg.type === 'image' ? 'sendPhoto' : (msg.type === 'video' ? 'sendVideo' : 'sendDocument');
                    await axios.post(`https://api.telegram.org/bot${telegramToken}/${method}`, formData, {
                        headers: formData.getHeaders()
                    });
                }
            }
        } catch (e) {
            console.error("❌ خطأ أثناء الإرسال لتليجرام:", e.response ? e.response.data : e.message);
        }
        return res.sendStatus(200);
    }

    // استقبال الردود من تليجرام وإرسالها لواتساب عبر نظام الـ ID
    if (body.message && body.message.reply_to_message) {
        const originalText = body.message.reply_to_message.text || body.message.reply_to_message.caption || "";
        const match = originalText.match(/#ID_(\d+)/);
        
        if (match) {
            const whatsappRecipient = match[1];
            try {
                if (body.message.text) {
                    await axios.post(`https://graph.facebook.com/v21.0/${phoneId}/messages`, {
                        messaging_product: "whatsapp",
                        to: whatsappRecipient,
                        text: { body: body.message.text }
                    }, { headers: { 'Authorization': `Bearer ${whatsappToken}` } });
                    
                    console.log(`✅ تم إرسال الرد بنجاح للرقم: ${whatsappRecipient}`);
                }
            } catch (e) {
                console.error("❌ فشل إرسال الرد لواتساب:", e.response ? JSON.stringify(e.response.data) : e.message);
            }
        }
    }

    res.sendStatus(200);
});

app.listen(port, () => console.log(`✅ السيرفر يعمل بنجاح يا أبو ريان`));
