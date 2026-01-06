const express = require('express');
const axios = require('axios');
const app = express();
app.use(express.json());

const port = process.env.PORT || 10000;
const telegramToken = process.env.TELEGRAM_TOKEN;
const telegramChatId = process.env.TELEGRAM_CHAT_ID;
const whatsappToken = process.env.WHATSAPP_TOKEN;
const phoneId = process.env.PHONE_NUMBER_ID;

// ذاكرة لحفظ روابط الرسائل (لتحديث علامات الصح)
const messageMap = new Map(); 

app.post('/', async (req, res) => {
    const body = req.body;

    // --- أولاً: استقبال تحديثات الحالة (علامات الصح) ---
    if (body.entry?.[0]?.changes?.[0]?.value?.statuses) {
        const status = body.entry[0].changes[0].value.statuses[0];
        const msgId = status.id;
        const statusType = status.status; // delivered, read, sent

        if (messageMap.has(msgId)) {
            const { tgChatId, tgMsgId, text } = messageMap.get(msgId);
            let icon = "✅";
            if (statusType === "delivered") icon = "✅✅";
            if (statusType === "read") icon = "🔵🔵";

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

    // --- ثانياً: استقبال رسالة من الجار (واتساب -> تليجرام) ---
    if (body.object === 'whatsapp_business_account' && body.entry[0].changes[0].value.messages) {
        const msg = body.entry[0].changes[0].value.messages[0];
        const from = msg.from;
        
        // البحث عن الغرفة أو إنشاؤها
        // ملاحظة: نعتمد هنا على الذاكرة المؤقتة أو إنشاء غرفة جديدة بالرقم
        let topicId = await getOrCreateTopic(from); 

        await axios.post(`https://api.telegram.org/bot${telegramToken}/sendMessage`, {
            chat_id: telegramChatId,
            message_thread_id: topicId,
            text: `${msg.text.body}\n\n#ID_${from}`
        });
        return res.sendStatus(200);
    }

    // --- ثالثاً: الرد المباشر من الغرفة (تليجرام -> واتساب) ---
    if (body.message && !body.message.from.is_bot) {
        const threadId = body.message.message_thread_id;
        
        // جلب معلومات الغرفة لمعرفة الرقم من "العنوان"
        try {
            const chatResponse = await axios.get(`https://api.telegram.org/bot${telegramToken}/getForumTopicIconStickers`, {
                params: { chat_id: telegramChatId }
            });
            
            // استخراج الرقم من اسم الغرفة (يفترض أنك وضعت الرقم في العنوان)
            // سنستخدم البحث عن الرقم (ID) في الرسائل السابقة كخيار أكثر دقة
            let recipientNumber = null;
            if (body.message.reply_to_message) {
                 const match = (body.message.reply_to_message.text || "").match(/#ID_(\d+)/);
                 if (match) recipientNumber = match[1];
            }

            if (recipientNumber && body.message.text) {
                const waRes = await axios.post(`https://graph.facebook.com/v21.0/${phoneId}/messages`, {
                    messaging_product: "whatsapp",
                    to: recipientNumber,
                    text: { body: body.message.text }
                }, { headers: { 'Authorization': `Bearer ${whatsappToken}` } });

                // حفظ رقم الرسالة لتحديث علامة الصح لاحقاً
                const waMsgId = waRes.data.messages[0].id;
                messageMap.set(waMsgId, {
                    tgChatId: telegramChatId,
                    tgMsgId: body.message.message_id,
                    text: body.message.text
                });
            }
        } catch (e) { console.error("Error in direct reply"); }
    }
    res.sendStatus(200);
});

// دالة مساعدة لإنشاء/جلب المواضيع
async function getOrCreateTopic(phoneNumber) {
    // الكود البرمجي المعتاد لإنشاء الـ Topic
}

app.listen(port, () => console.log(`✅ نظام علامات الصح والرد المباشر جاهز`));
