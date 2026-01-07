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
        } else if (['image', 'video', 'document', 'audio'].includes(msg.type)) {
            const mediaId = msg[msg.type].id;
            const fileData = await downloadWhatsappMedia(mediaId);
            
            if (fileData) {
                const formData = new FormData();
                formData.append('chat_id', telegramChatId);
                formData.append('message_thread_id', topicId);
                formData.append('caption', `📎 وسائط مستلمة\n\n#ID_${from}`);

                let method = 'sendDocument';
                let fileName = msg.document?.filename || `file_${Date.now()}`;
                
                if (msg.type === 'image') { method = 'sendPhoto'; fileName += '.jpg'; }
                else if (msg.type === 'video') { method = 'sendVideo'; fileName += '.mp4'; }
                else if (msg.type === 'audio') { method = 'sendAudio'; fileName += '.ogg'; }
                else { fileName += '.pdf'; }

                formData.append(msg.type === 'image' ? 'photo' : (msg.type === 'video' ? 'video' : (msg.type === 'audio' ? 'audio' : 'document')), fileData, { filename: fileName });

                try {
                    await axios.post(`https://api.telegram.org/bot${telegramToken}/${method}`, formData, {
                        headers: formData.getHeaders()
                    });
                } catch (err) { console.error("❌ فشل إرسال الوسائط لتليجرام"); }
            }
        }
        return res.sendStatus(200);
    }

    // الرد المباشر وبدء محادثة جديدة (/new)
    if (body.message && !body.message.from.is_bot) {
        const text = body.message.text || "";
        const threadId = body.message.message_thread_id;

        if (text.startsWith('/new')) {
            const targetNumber = text.split(' ')[1];
            if (targetNumber && targetNumber.startsWith('966')) {
                const tId = await getOrCreateTopic(targetNumber);
                await axios.post(`https://graph.facebook.com/v21.0/${phoneId}/messages`, {
                    messaging_product: "whatsapp",
                    to: targetNumber,
                    text: { body: "مرحباً بك في تواصل جمعية أجيال، كيف يمكننا خدمتك؟" }
                }, { headers: { 'Authorization': `Bearer ${whatsappToken}` } });
                
                await axios.post(`https://api.telegram.org/bot${telegramToken}/sendMessage`, {
                    chat_id: telegramChatId,
                    message_thread_id: tId,
                    text: `✅ تم فتح الغرفة وبدء المحادثة مع: ${targetNumber}\n\n#ID_${targetNumber}`
                });
            }
            return res.sendStatus(200);
        }

        if (threadId) {
            let recipientNumber = null;
            for (let [num, id] of userTopics.entries()) {
                if (id.toString() === threadId.toString()) { recipientNumber = num; break; }
            }
            if (!recipientNumber && body.message.reply_to_message) {
                const match = (body.message.reply_to_message.text || body.message.reply_to_message.caption || "").match(/#ID_(\d+)/);
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

app.listen(port, () => console.log(`✅ كود الوسائط المصحح يعمل`));
