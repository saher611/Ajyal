// 3. الرد المباشر من الغرفة (تليجرام -> واتساب)
    if (body.message && !body.message.from.is_bot && body.message.chat.id.toString() === telegramChatId.toString()) {
        const threadId = body.message.message_thread_id;
        if (!threadId) return res.sendStatus(200); // تجاهل العام

        let recipientNumber = null;

        try {
            // أولاً: محاولة البحث في الذاكرة السريعة
            for (let [num, id] of userTopics.entries()) {
                if (id.toString() === threadId.toString()) { recipientNumber = num; break; }
            }

            // ثانياً: إذا لم يجد في الذاكرة، يبحث عن الرقم المكتوب في "عنوان الغرفة"
            if (!recipientNumber) {
                const chatInfo = await axios.get(`https://api.telegram.org/bot${telegramToken}/getChat`, {
                    params: { chat_id: telegramChatId }
                });
                // سنفترض هنا أنك وضعت الرقم في العنوان كما اتفقنا
                const match = chatInfo.data.result.title.match(/(\966\d+)/); 
                if (match) recipientNumber = match[1];
            }

            // إرسال الرد
            if (recipientNumber && body.message.text) {
                const waRes = await axios.post(`https://graph.facebook.com/v21.0/${phoneId}/messages`, {
                    messaging_product: "whatsapp",
                    to: recipientNumber,
                    text: { body: body.message.text }
                }, { headers: { 'Authorization': `Bearer ${whatsappToken}` } });

                // حفظ رقم الرسالة فوراً لتحديث الصحين
                const waMsgId = waRes.data.messages[0].id;
                messageMap.set(waMsgId, {
                    tgChatId: telegramChatId,
                    tgMsgId: body.message.message_id,
                    text: body.message.text
                });
                console.log(`✅ تم الرد المباشر على: ${recipientNumber}`);
            }
        } catch (e) { console.error("❌ خطأ في الرد المباشر:", e.message); }
    }
