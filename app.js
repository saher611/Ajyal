      if (!topicId) return;

      if (message.text?.body) {
        await sendTelegramMessage(topicId, `${phone}:\n${message.text.body}`);
      } else {
        await relayWhatsAppMediaToTelegram(message, topicId, phone);
      }
    }

    await saveState();
  } catch (error) {
    logger.error('webhook handling failed:', error.message);
  }
});

bot.command('new', async (ctx) => {
  const phone = normalizePhone(ctx.message.text.replace('/new', ''));
  if (!phone) return ctx.reply('الاستخدام: /new 966xxxxxxxxx');

  const topicId = await getOrCreateTopic(phone);
  if (!topicId) return ctx.reply('تعذر إنشاء الغرفة.');
  return ctx.reply(`تم ربط الرقم ${phone} بالغرفة ${topicId}`);
});

bot.command('sync', async (ctx) => {
  const ok = await syncSheetsToMemory();
  return ctx.reply(ok ? 'تمت المزامنة.' : 'فشلت المزامنة، راجع السجل.');
});

bot.command('bulk', async (ctx) => {
  const raw = ctx.message.text.replace('/bulk', '').trim();
  const [numbersText, bodyText] = raw.split('|').map((part) => part?.trim());
  if (!numbersText || !bodyText) {
    return ctx.reply('الاستخدام:\n/bulk 966xxxx,966yyyy | نص الرسالة');
  }

  const phones = [...new Set(numbersText.split(/[\s,]+/).map(normalizePhone).filter(Boolean))];
  let success = 0;
  let failed = 0;

  await ctx.reply(`بدأ إرسال ${phones.length} رسالة.`);

  for (const phone of phones) {
    const result = await smartSendWhatsApp(phone, bodyText);
    const topicId = await getOrCreateTopic(phone);

    if (result.ok) {
      success += 1;
      state.sentByWaId.set(result.messageId, { topicId, phone, createdAt: Date.now() });
      state.outgoingByWaId.set(result.messageId, {
        phone,
        body: bodyText,
        usedTemplate: result.usedTemplate,
        createdAt: Date.now(),
      });
      if (topicId) await sendTelegramMessage(topicId, `رسالة جماعية:\n${bodyText}`).catch(() => {});
    } else {
      failed += 1;
      if (topicId) await sendTelegramMessage(topicId, `فشل إرسال جماعي: ${result.errorMessage}`).catch(() => {});
    }

    await sleep(500);
  }

  await saveState();
  return ctx.reply(`انتهى الإرسال.\nنجاح: ${success}\nفشل: ${failed}`);
});

bot.on('message', async (ctx) => {
  const topicId = String(ctx.message.message_thread_id || '');
  if (!topicId || ctx.message.text?.startsWith('/')) return;

  let phone = state.phoneByTopic.get(topicId);
  if (!phone) {
    await syncSheetsToMemory();
    phone = state.phoneByTopic.get(topicId);
  }
  if (!phone) return ctx.reply('هذه الغرفة غير مرتبطة برقم واتساب. استخدم /new أولا.');

  if (ctx.message.text) {
    const result = await smartSendWhatsApp(phone, ctx.message.text);
    if (!result.ok) return ctx.reply(`خطأ: ${result.errorMessage}`);

    state.sentByWaId.set(result.messageId, { topicId, phone, createdAt: Date.now() });
    state.outgoingByWaId.set(result.messageId, {
      phone,
      body: ctx.message.text,
      usedTemplate: result.usedTemplate,
      createdAt: Date.now(),
    });
    await saveState();
    return ctx.reply(result.usedTemplate ? 'تم الإرسال بالقالب.' : 'تم الإرسال.');
  }

  const telegramFile =
    ctx.message.photo?.at(-1) ||
    ctx.message.video ||
    ctx.message.document ||
    ctx.message.voice ||
    ctx.message.audio;

  if (!telegramFile) return;

  const link = await bot.telegram.getFileLink(telegramFile.file_id);
  const downloaded = await axios.get(link.href, { responseType: 'arraybuffer', timeout: 60000 });
  const uploadInfo = inferTelegramUpload(ctx, telegramFile);

  const result = await uploadAndSendTelegramMediaToWhatsApp(phone, {
    buffer: Buffer.from(downloaded.data),
    filename: uploadInfo.filename,
    mimeType: uploadInfo.mimeType,
  }, uploadInfo.mediaType);

  return ctx.reply(result.ok ? 'تم إرسال الملف.' : `فشل إرسال الملف: ${result.errorMessage}`);
});

async function bootstrap() {
  await loadState();
  await syncSheetsToMemory();
  setInterval(() => syncSheetsToMemory().catch((error) => logger.warn(error.message)), 10 * 60 * 1000);
  setInterval(() => pruneState().catch((error) => logger.warn(error.message)), 60 * 60 * 1000);

  if (CONFIG.telegram.webhookDomain) {
    app.use(bot.webhookCallback(CONFIG.telegram.webhookPath));
    await bot.telegram.setWebhook(`${CONFIG.telegram.webhookDomain}${CONFIG.telegram.webhookPath}`);
    logger.info(`telegram webhook enabled: ${CONFIG.telegram.webhookDomain}${CONFIG.telegram.webhookPath}`);
  } else {
    await bot.launch();
    logger.info('telegram polling enabled');
  }

  app.listen(CONFIG.port, () => logger.info(`server listening on ${CONFIG.port}`));
}

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));

bootstrap().catch((error) => {
  logger.error('boot failed:', error.message);
  process.exit(1);
});
