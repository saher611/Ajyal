app.post('/webhook', async (req, res) => {
    const entry = req.body.entry?.[0]?.changes?.[0]?.value;
    const message = entry?.messages?.[0];
    
    if (message) {
        const messageId = message.id;
        
        // تفعيل الصحين الزرقاء أولاً لضمان السرعة
        await markAsRead(messageId); 

        const phone = message.from;
        const topicId = await getOrCreateTopic(phone);
        const options = { message_thread_id: topicId || undefined };
        
        // ثم توجيه الرسالة لتليجرام...
        if (message.text) {
            await bot.telegram.sendMessage(TELEGRAM_CHAT_ID, `📩 من ${phone}:\n${message.text.body}`, options);
        }
        // وباقي أنواع الوسائط كما هي...
    }
    res.sendStatus(200);
});
