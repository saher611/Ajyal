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

// ذاكرة الحفظ
const userTopics = new Map(); 
const messageMap = new Map(); 

// 1. دالة إنشاء الغرف (تم وضعها هنا لضمان التشغيل)
async function getOrCreateTopic(phoneNumber) {
    if (userTopics.has(phoneNumber)) return userTopics.get(phoneNumber);
    try {
        const res = await axios.post(`https://api.telegram.org/bot${telegramToken}/createForumTopic`, {
            chat_id: telegramChatId,
            name: `${phoneNumber}`
        });
        const topicId = res.data.result.message_thread_id;
        userTopics.set(phoneNumber, topicId);
        return topicId;
    } catch (e) {
        console.error("❌ فشل إنشاء الموضوع:", e.message);
        return null;
    }
}

// 2. دالة تحميل الميديا
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
    } catch (e) { return null; }
}

app.post('/', async (req, res) => {
    const body = req.body;

    // --- تحديث علامات الصح ---
    if (body.entry?.[0]?.changes?.[0]?.value?.statuses) {
        const status = body.entry[0].changes[0].value.statuses[0];
        if (messageMap.has(status.id)) {
            const { tgChatId, tgMsgId, text } = messageMap.get(status.id);
            let icon = status.status === "delivered" ? "✅✅" : (status.status === "read" ? "🔵🔵" : "✅");
            try {
                await axios.post(`https://api.telegram.org/bot${telegramToken}/editMessageText`, {
                    chat_id: tgChatId,
                    message_id: tgMsgId,
                    text: `${text}\n\n${icon}`
                });
            } catch (e) {}
        }
        return res.sendStatus(200);
    }

    // --- استقبال من واتساب ---
    if (body.object === 'whatsapp_business_account' && body.entry[0].changes[0].value.messages) {
        const msg = body.entry[0].changes[0].value.messages[0];
        const from = msg.from;
        
        // استدعاء الدالة لفتح الغرفة
        const topicId = await getOrCreateTopic(from);

        if (msg.type === 'text') {
            await axios.post(`https://api.telegram.org/bot${telegramToken}/sendMessage`, {
                chat_id: telegramChatId,
                message_thread_id: topicId,
                text: `${msg.text.body}\n\n#ID_${from}`
            });
        } else if (['image', 'video', 'document'].includes(msg.type)) {
            const fileData = await downloadWhatsappMedia(msg[msg.type].id);
            if (fileData) {
                const formData = new FormData();
                formData.append('chat_id', telegramChatId);
                formData.append('message_thread_id', topicId);
                formData.append('caption', `📎 وسائط\n\n#ID_${from}`);
                let ext = msg.type === 'image' ? 'jpg' : (msg.type === 'video' ? 'mp4' : 'pdf');
                formData.append(msg.type === 'image' ? 'photo' : (msg.type === 'video' ? 'video' : 'document'), fileData, { filename: `file.${ext}` });
                await axios.post(`https://api.telegram.org/bot${telegramToken}/${msg.type === 'image' ? 'sendPhoto' : (msg.type === 'video' ? 'sendVideo' : 'sendDocument')}`, formData, { headers: formData.getHeaders() });
            }
        }
        return res.sendStatus(200);
    }

    // --- الرد المباشر ---
    if (body.message && !body.message.from.is_bot && body.message.chat.id.toString() === telegramChatId.toString()) {
        const threadId = body.message.message_thread_id;
        if (!threadId) return res.sendStatus(200);

        let recipientNumber = null;
        for (let [num, id] of userTopics.entries()) {
            if (id.toString() === threadId.toString()) { recipientNumber = num; break; }
        }

        if (!recipientNumber && body.message.reply_to_message) {
            const match = (body.message.reply_to_message.text || body.message.reply_to_message.caption || "").match(/#ID_(\d+)/);
            if (match) recipientNumber = match[1];
        }

        if (recipientNumber && body.message.text) {
            try {
                const waRes = await axios.post(`https://graph.facebook.com/v21.0/${phoneId}/messages`, {
                    messaging_product: "whatsapp",
                    to: recipientNumber,
                    text: { body: body.message.text }
                }, { headers: { 'Authorization': `Bearer ${whatsappToken}` } });

                messageMap.set(waRes.data.messages[0].id, {
                    tgChatId: telegramChatId,
                    tgMsgId: body.message.message_id,
                    text: body.message.text
                });
            } catch (e) {}
        }
    }
    res.sendStatus(200);
});

app.listen(port, () => console.log(`✅ النظام المحدث شغال يا أبو ريان`));
