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

const userTopics = new Map(); // ذاكرة المواضيع
const messageMap = new Map(); // ذاكرة علامات الصح

// دالة إنشاء أو جلب الغرفة (Topic)
async function getOrCreateTopic(phoneNumber) {
    if (userTopics.has(phoneNumber)) return userTopics.get(phoneNumber);
    try {
        const res = await axios.post(`https://api.telegram.org/bot${telegramToken}/createForumTopic`, {
            chat_id: telegramChatId,
            name: `${phoneNumber}` // سيفتحها بالرقم وأنت سمّها كما تشاء
        });
        const topicId = res.data.result.message_thread_id;
        userTopics.set(phoneNumber, topicId);
        return topicId;
    } catch (e) { 
        console.error("❌ فشل إنشاء الغرفة:", e.message);
        return null; 
    }
}

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
    } catch (e) { return null; }
}

app.post('/', async (req, res) => {
    const body = req.body;

    // 1. تحديث علامات الصح (✅، ✅✅، 🔵🔵)
    if (body.entry?.[0]?.changes?.[0]?.value?.statuses) {
        const status = body.entry[0].changes[0].value.statuses[0];
        if (messageMap.has(status.id)) {
            const { tgChatId, tgMsgId, text, threadId } = messageMap.get(status.id);
            let icon = "✅";
            if (status.status === "delivered") icon = "✅✅";
            if (status.status === "read") icon = "🔵🔵";
            try {
                await axios.post(`https://api.telegram.org/bot${telegramToken}/editMessageText`, {
                    chat_id: tgChatId,
                    message_id: tgMsgId,
                    text: `${text}\n\n${icon}`
                });
            } catch (e) { /* تجاهل أخطاء التحديث */ }
        }
        return res.sendStatus(200);
    }

    // 2. من واتساب إلى تليجرام (إنشاء غرف وإرسال ميديا)
    if (body.object === 'whatsapp_business_account' && body.entry[0].changes[0].value.messages) {
        const msg = body.entry[0].changes[0].value.messages[0];
        const from = msg.from;
        const topicId = await getOrCreateTopic(from);

        try {
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
                    formData.append('caption', `📎 وسائط (${msg.type})\n\n#ID_${from}`);
                    let ext = msg.type === 'image' ? 'jpg' : msg.type === 'video' ? 'mp4' : 'pdf';
                    let fileName = msg.document?.filename || `file_${Date.now()}.${ext}`;
                    formData.append(msg.type === 'image' ? 'photo' : (msg.type === 'video' ? 'video' : 'document'), fileData, { filename: fileName });
                    const method = msg.type === 'image' ? 'sendPhoto' : (msg.type === 'video' ? 'sendVideo' : 'sendDocument');
                    await axios.post(`https://api.telegram.org/bot${telegramToken}/${method}`, formData, { headers: formData.getHeaders() });
                }
            }
        } catch (e) { console.error("Error sending to TG"); }
        return res.sendStatus(200);
    }

    // 3. الرد المباشر من الغرفة (تليجرام -> واتساب)
    if (body.message && !body.message.from.is_bot && body.message.chat.id.toString() === telegramChatId.toString()) {
        const threadId = body.message.message_thread_id;
        
        // البحث عن الـ ID في آخر رسالة بالغرفة
        let recipientNumber = null;
        if (body.message.reply_to_message) {
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

                // حفظ بيانات الرسالة لتحديث علامة الصح
                const waMsgId = waRes.data.messages[0].id;
                messageMap.set(waMsgId, {
                    tgChatId: telegramChatId,
                    tgMsgId: body.message.message_id,
                    text: body.message.text,
                    threadId: threadId
                });
            } catch (e) { console.error("❌ فشل الرد المباشر"); }
        }
    }
    res.sendStatus(200);
});

app.listen(port, () => console.log(`✅ النظام الشامل جاهز يا أبو ريان`));
