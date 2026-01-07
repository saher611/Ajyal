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

const userTopics = new Map(); 
const messageMap = new Map();

// دالة إنشاء الغرف
async function getOrCreateTopic(phoneNumber) {
    if (userTopics.has(phoneNumber)) return userTopics.get(phoneNumber);
    try {
        const res = await axios.post(`https://api.telegram.org/bot${telegramToken}/createForumTopic`, {
            chat_id: telegramChatId,
            name: `الجار: ${phoneNumber}`
        });
        const topicId = res.data.result.message_thread_id;
        userTopics.set(phoneNumber, topicId);
        return topicId;
    } catch (e) { return null; }
}

app.post('/', async (req, res) => {
    const body = req.body;

    // 1. استقبال رسائل واتساب
    if (body.object === 'whatsapp_business_account' && body.entry[0].changes[0].value.messages) {
        const msg = body.entry[0].changes[0].value.messages[0];
        const from = msg.from;
        const topicId = await getOrCreateTopic(from);
        
        const text = msg.type === 'text' ? msg.text.body : `أرسل وسائط (${msg.type})`;
        await axios.post(`https://api.telegram.org/bot${telegramToken}/sendMessage`, {
            chat_id: telegramChatId,
            message_thread_id: topicId,
            text: `${text}\n\n#ID_${from}`
        });
        return res.sendStatus(200);
    }

    // 2. معالجة أوامر تليجرام والرد المباشر
    if (body.message && !body.message.from.is_bot) {
        const text = body.message.text || "";
        const threadId = body.message.message_thread_id;

        // --- ميزة بدء محادثة جديدة (/new) ---
        if (text.startsWith('/new')) {
            const targetNumber = text.split(' ')[1];
            if (targetNumber && targetNumber.startsWith('966')) {
                const topicId = await getOrCreateTopic(targetNumber);
                await axios.post(`https://graph.facebook.com/v21.0/${phoneId}/messages`, {
                    messaging_product: "whatsapp",
                    to: targetNumber,
                    text: { body: "مرحباً بك في تواصل جمعية أجيال، كيف يمكننا خدمتك؟" }
                }, { headers: { 'Authorization': `Bearer ${whatsappToken}` } });
                
                await axios.post(`https://api.telegram.org/bot${telegramToken}/sendMessage`, {
                    chat_id: telegramChatId,
                    message_thread_id: topicId,
                    text: `✅ تم فتح الغرفة وبدء المحادثة مع: ${targetNumber}\n\n#ID_${targetNumber}`
                });
            }
            return res.sendStatus(200);
        }

        // --- الرد المباشر الذكي ---
        if (threadId) {
            let recipientNumber = null;
            // البحث عن الرقم في الذاكرة
            for (let [num, id] of userTopics.entries()) {
                if (id.toString() === threadId.toString()) { recipientNumber = num; break; }
            }
            // البحث في محتوى الرسالة السابقة إذا فقدت الذاكرة
            if (!recipientNumber && body.message.reply_to_message) {
                const match = (body.message.reply_to_message.text || "").match(/#ID_(\d+)/);
                if (match) recipientNumber = match[1];
            }

            if (recipientNumber && text) {
                await axios.post(`https://graph.facebook.com/v21.0/${phoneId}/messages`, {
                    messaging_product: "whatsapp",
                    to: recipientNumber,
                    text: { body: text }
                }, { headers: { 'Authorization': `Bearer ${whatsappToken}` } });
            }
        }
    }
    res.sendStatus(200);
});

app.listen(port, () => console.log(`✅ نظام أجيال المتطور جاهز`));
