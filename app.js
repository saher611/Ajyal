// Import Express.js and Axios for Telegram API
const express = require('express');
const axios = require('axios');

// Create an Express app
const app = express();

// Middleware to parse JSON bodies
app.use(express.json());

// Set variables from Environment
const port = process.env.PORT || 3000;
const verifyToken = process.env.VERIFY_TOKEN;
const telegramToken = process.env.TELEGRAM_TOKEN;
const telegramChatId = process.env.TELEGRAM_CHAT_ID;

// Function to send message to Telegram
async function sendToTelegram(text) {
  const url = `https://api.telegram.org/bot${telegramToken}/sendMessage`;
  try {
    await axios.post(url, {
      chat_id: telegramChatId,
      text: text
    });
  } catch (error) {
    console.error('Error sending to Telegram:', error.response ? error.response.data : error.message);
  }
}

// Route for GET requests (Webhook Verification)
app.get('/', (req, res) => {
  const { 'hub.mode': mode, 'hub.challenge': challenge, 'hub.verify_token': token } = req.query;

  if (mode === 'subscribe' && token === verifyToken) {
    console.log('WEBHOOK VERIFIED');
    res.status(200).send(challenge);
  } else {
    res.status(403).end();
  }
});

// Route for POST requests (Handling WhatsApp Messages)
app.post('/', (req, res) => {
  const timestamp = new Date().toISOString().replace('T', ' ').slice(0, 19);
  
  // Log the body for debugging in Render logs
  console.log(`\nWebhook received ${timestamp}\n`);
  console.log(JSON.stringify(req.body, null, 2));

  // Check if it's a valid WhatsApp message
  if (req.body.entry && req.body.entry[0].changes && req.body.entry[0].changes[0].value.messages) {
    const messageData = req.body.entry[0].changes[0].value.messages[0];
    const from = messageData.from; // Phone number
    const body = messageData.text ? messageData.text.body : "أرسل وسائط (صورة/مقطع) لا يمكن عرضها كنص حالياً";

    // Build the alert message
    const alertText = `🔔 رسالة واتساب جديدة\n\n👤 من: ${from}\n💬 النص: ${body}`;

    // Send it to your Telegram
    sendToTelegram(alertText);
  }

  res.status(200).end();
});

// Start the server
app.listen(port, () => {
  console.log(`\nServer is running and listening on port ${port}\n`);
});
