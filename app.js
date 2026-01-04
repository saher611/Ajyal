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

// ذاكرة مؤقتة لحفظ أرقام الواتساب المرتبطة برسائل تليجرام
const replyMap = new Map();

// 1. دالة تحميل الميديا من واتساب
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
        console.error("❌ فشل تحميل الملف من واتساب. التفاصيل:", e.response ? e.response.data : e.message);
        return null;
    }
}

app.post('/', async (req, res) => {
    const body = req.body;

    // --- الجزء الأول: استقبال من واتساب وإرسال لتليجرام ---
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
            } else if (['image', 'video', 'document'].includes(msg.type)) {
                const fileData = await downloadWhatsappMedia(msg[msg.type].id);
                if (fileData) {
                    const formData = new FormData();
                    formData.append('chat_id', telegramChatId);
                    formData.append('caption', `👤 من: ${from}\n📎 وسائط (${msg.type})`);
                    formData.append(msg.type === 'image' ? 'photo' : msg.type, fileData, { filename: 'file' });

                    const method = msg.type === 'image' ? 'sendPhoto' : msg.type === 'video' ? 'sendVideo' : 'sendDocument';
                    telegramMsg = await axios.post(`https://api.telegram.org/bot${telegramToken}/${method}`, formData, {
                        headers: formData.getHeaders()
                    });
                }
            }

            if (telegramMsg) {
                replyMap.set(telegramMsg.data.result.message_id, from);
                console.log(`✅ تم حفظ الرسالة ${telegramMsg.data.result.message_id} للرقم ${from}`);
            }
        } catch (e) {
            console.error("❌ خطأ في إرسال الوسائط لتليجرام:", e.response ? JSON.stringify(e.response.data) : e.message);
        }
        return res.sendStatus(200);
    }

    // --- الجزء الثاني: الرد من تليجرام وإرسال لواتساب ---
    if (body.message && body.message.reply_to_message) {
        const originalMsgId = body.message.reply_to_message.message_id;
        const whatsappRecipient = replyMap.get(originalMsgId);

        console.log(`🔄 محاولة معالجة رد تليجرام على رسالة رقم: ${originalMsgId}`);

        if (whatsappRecipient) {
            try {
                if (body.message.text) {
                    const response = await axios.post(`https://graph.facebook.com/v21.0/${phoneId}/messages`, {
                        messaging_product: "whatsapp",
                        recipient_type: "individual",
                        to: whatsappRecipient,
                        type: "text",
                        text: { body: body.message.text }
                    }, { 
                        headers: { 'Authorization': `Bearer ${whatsappToken}` } 
                    });
                    
                    console.log(`✅ نجح الرد لواتساب: ${whatsappRecipient}`);
                }
            } catch (e) {
                // توضيح تفصيلي للخطأ في السجلات
                console.error("❌ فشل إرسال الرد لواتساب!");
                if (e.response) {
                    console.error("تفاصيل الخطأ من فيسبوك:", JSON.stringify(e.response.data, null, 2));
                } else {
                    console.error("خطأ في الاتصال:", e.message);
                }
            }
        } else {
            console.warn(`⚠️ لم يتم العثور على رقم واتساب مرتبط بالرسالة رقم ${originalMsgId}. ربما تمت إعادة تشغيل السيرفر.`);
        }
    }

    res.sendStatus(200);
});

app.listen(port, () => console.log(`✅ السيرفر يعمل بنجاح على المنفذ ${port}`));
