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

// ذاكرة مؤقتة لربط الرسائل (ملاحظة: تُمحى عند إعادة تشغيل السيرفر في Render)
const replyMap = new Map();

app.post('/', async (req, res) => {
  const body = req.body;

  // 1. استقبال من واتساب وإرسال لتليجرام
  if (body.object === 'whatsapp_business_account' && body.entry[0].changes[0].value.messages) {
    const msg = body.entry[0].changes[0].value.messages[0];
    const from = msg.from;
    const text = msg.text ? msg.text.body : "وسائط أو رسالة غير نصية";

    try {
      const response = await axios.post(`https://api.telegram.org/bot${telegramToken}/sendMessage`, {
        chat_id: telegramChatId,
        text: `👤 من: ${from}\n💬 الرسالة: ${text}\n\n(للرد: استخدم خاصية Reply على هذه الرسالة)`
      });
      
      const telegramMsgId = response.data.result.message_id;
      replyMap.set(telegramMsgId, from); // حفظ الرقم للرد عليه لاحقاً
    } catch (e) { 
      console.error("خطأ تليجرام تفصيلي:", e.response ? e.response.data : e.message); 
    }
    return res.sendStatus(200);
  }

  // 2. استقبال رد الموظف من تليجرام وتحويله لواتساب
  if (body.message && body.message.reply_to_message) {
    const replyToId = body.message.reply_to_message.message_id;
    const whatsappRecipient = replyMap.get(replyToId);

    if (whatsappRecipient) {
      try {
        await axios.post(`https://api.facebook.com/v24.0/${phoneId}/messages`, {
          messaging_product: "whatsapp",
          to: whatsappRecipient,
          type: "text",
          text: { body: body.message.text }
        }, { 
          headers: { 
            'Authorization': `Bearer ${whatsappToken}`,
            'Content-Type': 'application/json'
          } 
        });
        
        await axios.post(`https://api.telegram.org/bot${telegramToken}/sendMessage`, {
          chat_id: telegramChatId,
          text: `✅ تم إرسال ردك للرقم ${whatsappRecipient}`,
          reply_to_message_id: body.message.message_id
        });
      } catch (e) { 
        // هذا السطر سيطبع لنا السبب الحقيقي لرفض واتساب في الـ Logs
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

app.listen(port, () => {
  console.log(`Server is running on port ${port}`);
});
