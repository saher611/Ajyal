const express = require('express');
const axios = require('axios');
const app = express();
app.use(express.json());

const port = process.env.PORT || 3000;
const telegramToken = process.env.TELEGRAM_TOKEN;
const telegramChatId = process.env.TELEGRAM_CHAT_ID;
const whatsappToken = process.env.WHATSAPP_TOKEN;
const phoneId = process.env.PHONE_NUMBER_ID;
const verifyToken = process.env.VERIFY_TOKEN;

const replyMap = new Map();

app.post('/', async (req, res) => {
  const body = req.body;

  if (body.object === 'whatsapp_business_account' && body.entry[0].changes[0].value.messages) {
    const msg = body.entry[0].changes[0].value.messages[0];
    const from = msg.from;
    const text = msg.text ? msg.text.body : "وسائط";

    try {
      const response = await axios.post(`https://api.telegram.org/bot${telegramToken}/sendMessage`, {
        chat_id: telegramChatId,
        text: `👤 من: ${from}\n💬 الرسالة: ${text}\n\n(للرد: استخدم خاصية Reply)`
      });
      replyMap.set(response.data.result.message_id, from);
    } catch (e) { console.error("خطأ تليجرام"); }
    return res.sendStatus(200);
  }

  if (body.message && body.message.reply_to_message) {
    const whatsappRecipient = replyMap.get(body.message.reply_to_message.message_id);

    if (whatsappRecipient) {
      try {
        // تم تغيير الرابط هنا إلى v21.0 لحل مشكلة الـ 404
        await axios.post(`https://graph.facebook.com/v21.0/${phoneId}/messages`, {
          messaging_product: "whatsapp",
          to: whatsappRecipient,
          type: "text",
          text: { body: body.message.text }
        }, { 
          headers: { 'Authorization': `Bearer ${whatsappToken}` } 
        });
        
        await axios.post(`https://api.telegram.org/bot${telegramToken}/sendMessage`, {
          chat_id: telegramChatId,
          text: `✅ تم إرسال ردك للرقم ${whatsappRecipient}`,
          reply_to_message_id: body.message.message_id
        });
      } catch (e) { 
        console.error("خطأ واتساب تفصيلي:", e.response ? e.response.data : e.message); 
      }
    }
    return res.sendStatus(200);
  }
  res.sendStatus(200);
});

app.get('/', (req, res) => {
  if (req.query['hub.verify_token'] === verifyToken) res.send(req.query['hub.challenge']);
  else res.sendStatus(403);
});

app.listen(port);
