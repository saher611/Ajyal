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

// ذاكرة مؤقتة (للسرعة فقط)
let userTopics = new Map();

async function getOrCreateTopic(phoneNumber) {
    if (userTopics.has(phoneNumber)) return userTopics.get(phoneNumber);
    try {
        const res = await axios.post(`https://api.telegram.org/bot${telegramToken}/createForumTopic`, {
            chat_id: telegramChatId,
            name: `${phoneNumber}` // يفتحها بالرقم أول مرة
        });
        const topicId = res.data.result.message_thread_id;
        userTopics.set(phoneNumber, topicId);
        return topicId;
    } catch (e) { return null; }
}

app.post('/', async (req, res) => {
    const body = req.body;

    // 1. من واتساب إلى تليجرام
    if (body.object === 'whatsapp_business_account' && body.entry[0].changes[0].value.messages) {
        const msg = body.entry[0].changes[0].value.messages[0];
        const from = msg.from;
        const topicId = await getOrCreateTopic(from);

        if (msg.type === 'text') {
            await axios.post(`https://api.telegram.org/bot${telegramToken}/sendMessage`, {
                chat_id: telegramChatId,
                message_thread_id: topicId,
                text: `${msg.text.body}\n\n#ID_${from}`
            });
        }
        // ... (كود الميديا يبقى كما هو)
        return res.sendStatus(200);
    }

    // 2. الرد المباشر بقراءة "اسم الغرفة"
    if (body.message && body.message.chat.id.toString() === telegramChatId.toString()) {
        const threadId = body.message.message_thread_id;
        
        try {
            // جلب بيانات الغرفة لمعرفة اسمها الحالي
            const chatInfo = await axios.get(`https://api.telegram.org/bot${telegramToken}/getChat`, {
                params: { chat_id: telegramChatId }
            });
            
            // هنا نبحث عن الرقم داخل اسم الغرفة (Topic Name)
            // ملاحظة: تطلب استخراج معلومات الموضوع عبر سجلات الرسالة
            let topicName = "";
            if (body.message.reply_to_message && body.message.reply_to_message.forum_topic_created) {
                topicName = body.message.reply_to_message.forum_topic_created.name;
            }

            // محاولة استخراج الرقم من نص الرسالة السابقة (#ID_) كخيار أول وأدق
            let recipientNumber = null;
            if (body.message.reply_to_message) {
                const match = (body.message.reply_to_message.text || body.message.reply_to_message.caption || "").match(/#ID_(\d+)/);
                if (match) recipientNumber = match[1];
            }

            // إرسال الرد لواتساب
            if (recipientNumber && body.message.text && !body.message.from.is_bot) {
                await axios.post(`https://graph.facebook.com/v21.0/${phoneId}/messages`, {
                    messaging_product: "whatsapp",
                    to: recipientNumber,
                    text: { body: body.message.text }
                }, { headers: { 'Authorization': `Bearer ${whatsappToken}` } });
                console.log(`✅ تم الرد على: ${recipientNumber}`);
            }
        } catch (e) { console.error("❌ خطأ في الرد المباشر"); }
    }
    res.sendStatus(200);
});

app.listen(port, () => console.log(`✅ نظام استخراج الـ ID جاهز يا أبو ريان`));
