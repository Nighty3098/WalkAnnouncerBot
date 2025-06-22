require('dotenv').config();
const { Telegraf, Markup } = require('telegraf');
const fsm = require('./fsm');
const messages = require('./messages');

const bot = new Telegraf(process.env.BOT_TOKEN);

const MAIN_MENU = Markup.keyboard([
  ['📣 Пригласить на прогулку']
]).resize();

// In-memory хранилище анонсов
const events = [];

const channelUsername = process.env.CHANNEL_USERNAME || 'go_chill';

bot.start((ctx) => {
  ctx.reply(
    messages.start,
    MAIN_MENU
  );
});

// Команда /myevents — просмотр своих анонсов
bot.command('myevents', (ctx) => {
  const userId = ctx.from.id;
  const myEvents = events.filter(e => e.authorId === userId);
  console.log('Команда /myevents для пользователя:', userId);
  console.log('Найдено анонсов:', myEvents.length);
  console.log('Все анонсы:', myEvents);
  
  if (myEvents.length === 0) {
    ctx.reply(messages.noEvents);
    return;
  }
  myEvents.forEach(e => {
    let text = `\u{1F4CD} <b>${e.topic}</b>\n\n${e.description}\n\n`;
    if (e.place && e.place.latitude && e.place.longitude) {
      text += `📫 Место: <a href=\"https://maps.google.com/?q=${e.place.latitude},${e.place.longitude}\">${e.place.latitude},${e.place.longitude}</a>\n`;
    } else if (e.place) {
      text += `📫 Место: ${e.place}\n`;
    }
    text += `🗓 Когда: ${e.datetime}\n`;
    text += `📌 Контакт: ${e.contact}\n\n`;
    text += `Статус: ${messages.myEventStatus(e.status)}\n`;
    text += `#пошлигулять #${channelUsername.replace('@','')}`;
    const keyboard = Markup.inlineKeyboard([
      [Markup.button.callback('❌ Удалить', `delete_event_${e.id}`)]
    ]);
    if (e.photo) {
      ctx.replyWithPhoto(e.photo, { caption: text, parse_mode: 'HTML', reply_markup: keyboard.reply_markup });
    } else {
      ctx.reply(text, { parse_mode: 'HTML', reply_markup: keyboard.reply_markup });
    }
  });
});

// Удаление анонса пользователем
bot.action(/delete_event_(\d+)/, async (ctx) => {
  const eventId = Number(ctx.match[1]);
  console.log('Попытка удаления анонса:', eventId, 'пользователем:', ctx.from.id);
  console.log('Всего анонсов в памяти:', events.length);
  console.log('Анонсы пользователя:', events.filter(e => e.authorId === ctx.from.id));
  
  const idx = events.findIndex(e => e.id === eventId && e.authorId === ctx.from.id);
  if (idx === -1) {
    console.log('Анонс не найден или пользователь не является автором');
    return ctx.reply('Анонс не найден или вы не являетесь его автором.');
  }
  
  const deletedEvent = events.splice(idx, 1)[0];
  console.log('Анонс удален:', deletedEvent);
  
  // Если анонс был опубликован, удаляем сообщение из канала
  if (deletedEvent.status === 'published' && deletedEvent.channelMessageId && deletedEvent.channelChatId) {
    try {
      await ctx.telegram.deleteMessage(deletedEvent.channelChatId, deletedEvent.channelMessageId);
      console.log('Сообщение удалено из канала');
    } catch (error) {
      console.error('Ошибка при удалении сообщения из канала:', error.message);
      // Не прерываем выполнение, если не удалось удалить из канала
    }
  }
  
  ctx.editMessageReplyMarkup();
  ctx.reply(messages.eventDeleted);
});

bot.hears('📣 Пригласить на прогулку', (ctx) => {
  fsm.startFSM(ctx.from.id);
  ctx.reply(messages.invite, Markup.keyboard([['❌ Отменить']]).resize());
});

bot.hears('❌ Отменить', (ctx) => {
  fsm.resetFSM(ctx.from.id);
  ctx.reply(messages.cancel, MAIN_MENU);
});

// ГЛАВНЫЙ ОБРАБОТЧИК FSM ДЛЯ ТЕКСТА, ГОЛОСА И ЛОКАЦИИ
bot.on(['text', 'voice', 'location'], async (ctx) => {
  // 0. Обработка комментария модератора (отдельная логика)
  const moderatorUserId = Object.keys(modRejectComments).find(uid => modRejectComments[uid] === ctx.from.id);
  if (moderatorUserId) {
    const event = events.find(e => e.authorId == moderatorUserId && e.status === 'pending');
    if (event) {
      if (ctx.message.text) {
        await ctx.telegram.sendMessage(moderatorUserId, messages.rejectedWithComment(event.topic, ctx.message.text));
      } else if (ctx.message.voice) {
        await ctx.telegram.sendVoice(moderatorUserId, ctx.message.voice.file_id, { caption: messages.rejectedWithVoice(event.topic) });
      }
      ctx.reply(messages.moderatorCommentSent);
      delete modRejectComments[moderatorUserId];
      fsm.resetFSM(moderatorUserId);
    }
    return;
  }
  
  // 1. Не обрабатываем команды внутри FSM
  if (ctx.message.text && ctx.message.text.startsWith('/')) return;
  
  const state = fsm.getState(ctx.from.id);
  const draft = fsm.getDraft(ctx.from.id);

  // 2. Логика по шагам FSM
  switch(state) {
    case fsm.STATES.TOPIC: {
      const text = ctx.message.text.trim();
      if (text.length >= 101) {
        return ctx.reply(messages.topicTooLong(text.length));
      }
      fsm.setDraftField(ctx.from.id, 'topic', text);
      if (draft.isEditing) {
        draft.isEditing = false;
        fsm.setState(ctx.from.id, fsm.STATES.PREVIEW);
        return sendPreview(ctx);
      }
      fsm.setState(ctx.from.id, fsm.STATES.PLACE);
      return ctx.reply(messages.place, Markup.keyboard([['❌ Отменить']]).resize());
    }

    case fsm.STATES.PLACE: {
      let place;
      if (ctx.message.location) {
        const { latitude, longitude } = ctx.message.location;
        place = { latitude, longitude };
      } else {
        const text = ctx.message.text.trim();
        if (text.length >= 201) {
          return ctx.reply(messages.placeTooLong(text.length));
        }
        place = text;
      }
      fsm.setDraftField(ctx.from.id, 'place', place);
      if (draft.isEditing) {
        draft.isEditing = false;
        fsm.setState(ctx.from.id, fsm.STATES.PREVIEW);
        return sendPreview(ctx);
      }
      fsm.setState(ctx.from.id, fsm.STATES.DATETIME);
      return ctx.reply(messages.datetime, Markup.keyboard([['❌ Отменить']]).resize());
    }

    case fsm.STATES.DATETIME: {
      fsm.setDraftField(ctx.from.id, 'datetime', ctx.message.text);
      if (draft.isEditing) {
        draft.isEditing = false;
        fsm.setState(ctx.from.id, fsm.STATES.PREVIEW);
        return sendPreview(ctx);
      }
      fsm.setState(ctx.from.id, fsm.STATES.CONTACT);
      return ctx.reply(messages.contact, Markup.keyboard([['❌ Отменить']]).resize());
    }
    
    case fsm.STATES.CONTACT: {
      const text = ctx.message.text.trim();
      if (text.length >= 101) {
        return ctx.reply(messages.contactTooLong(text.length));
      }
      fsm.setDraftField(ctx.from.id, 'contact', text);
      if (draft.isEditing) {
        draft.isEditing = false;
        fsm.setState(ctx.from.id, fsm.STATES.PREVIEW);
        return sendPreview(ctx);
      }
      fsm.setState(ctx.from.id, fsm.STATES.DESCRIPTION);
      return ctx.reply(messages.description, Markup.keyboard([['❌ Отменить']]).resize());
    }

    case fsm.STATES.DESCRIPTION: {
      const text = ctx.message.text.trim();
      if (text.length >= 501) {
        return ctx.reply(messages.descriptionTooLong(text.length));
      }
      fsm.setDraftField(ctx.from.id, 'description', text);
      if (draft.isEditing) {
        draft.isEditing = false;
        fsm.setState(ctx.from.id, fsm.STATES.PREVIEW);
        return sendPreview(ctx);
      }
      fsm.setState(ctx.from.id, fsm.STATES.PHOTO);
      return ctx.reply(messages.photo, Markup.keyboard([
        ['Пропустить'],
        ['❌ Отменить']
      ]).resize());
    }

    case fsm.STATES.PHOTO: {
      if (ctx.message.text && ctx.message.text.toLowerCase() === 'пропустить') {
        fsm.setDraftField(ctx.from.id, 'photo', null);
        fsm.setState(ctx.from.id, fsm.STATES.PREVIEW);
        return sendPreview(ctx);
      }
      return ctx.reply(messages.photoWrong);
    }
  }
});

// Обработка фото (отдельно, т.к. тип 'photo')
bot.on('photo', (ctx) => {
  const state = fsm.getState(ctx.from.id);
  if (state === fsm.STATES.PHOTO) {
    const photo = ctx.message.photo[ctx.message.photo.length - 1];
    fsm.setDraftField(ctx.from.id, 'photo', photo.file_id);
    const draft = fsm.getDraft(ctx.from.id);
    if (draft.isEditing) {
      draft.isEditing = false;
      fsm.setState(ctx.from.id, fsm.STATES.PREVIEW);
      sendPreview(ctx);
      return;
    }
    fsm.setState(ctx.from.id, fsm.STATES.PREVIEW);
    sendPreview(ctx);
    return;
  }
});

// Функция предпросмотра анонса
function sendPreview(ctx) {
  const draft = fsm.getDraft(ctx.from.id);
  let text = `\u{1F4CD} <b>${draft.topic}</b>\n\n${draft.description}\n\n`;
  if (draft.place && draft.place.latitude && draft.place.longitude) {
    text += `📫 Место: <a href="https://maps.google.com/?q=${draft.place.latitude},${draft.place.longitude}">${draft.place.latitude},${draft.place.longitude}</a>\n`;
  } else if (draft.place) {
    text += `📫 Место: ${draft.place}\n`;
  }
  text += `🗓 Когда: ${draft.datetime}\n`;
  text += `📌 Контакт: ${draft.contact}\n\n`;
  text += `#пошлигулять #${channelUsername.replace('@','')}`;

  const keyboard = Markup.inlineKeyboard([
    [Markup.button.callback('✏ Картинка', 'edit_photo'), Markup.button.callback('✏ Название', 'edit_topic')],
    [Markup.button.callback('✏ Описание', 'edit_description'), Markup.button.callback('✏ Место', 'edit_place')],
    [Markup.button.callback('✏ Дата и время', 'edit_datetime'), Markup.button.callback('✏ Контакт', 'edit_contact')],
    [],
    [Markup.button.callback('✅ Всё верно, отправить!', 'submit')],
    [Markup.button.callback('❌ Отменить', 'cancel')],
  ]);

  if (draft.photo) {
    ctx.replyWithPhoto(draft.photo, {
      caption: text,
      parse_mode: 'HTML',
      reply_markup: keyboard.reply_markup
    });
  } else {
    ctx.reply(text, {
      parse_mode: 'HTML',
      reply_markup: keyboard.reply_markup
    });
  }
}

bot.action('edit_topic', (ctx) => {
  fsm.setState(ctx.from.id, fsm.STATES.TOPIC);
  const draft = fsm.getDraft(ctx.from.id);
  draft.isEditing = true;
  ctx.editMessageReplyMarkup();
  ctx.reply('Введите новую тему прогулки (до 100 символов):', Markup.keyboard([['❌ Отменить']]).resize());
});
bot.action('edit_place', (ctx) => {
  fsm.setState(ctx.from.id, fsm.STATES.PLACE);
  const draft = fsm.getDraft(ctx.from.id);
  draft.isEditing = true;
  ctx.editMessageReplyMarkup();
  ctx.reply('Где встречаемся? Пришлите геоточку или адрес и ссылку на Google Maps.', Markup.keyboard([['❌ Отменить']]).resize());
});
bot.action('edit_datetime', (ctx) => {
  fsm.setState(ctx.from.id, fsm.STATES.DATETIME);
  const draft = fsm.getDraft(ctx.from.id);
  draft.isEditing = true;
  ctx.editMessageReplyMarkup();
  ctx.reply('Когда? Укажите дату и время. Например: "25 декабря, 12:30" (до 100 символов).', Markup.keyboard([['❌ Отменить']]).resize());
});
bot.action('edit_contact', (ctx) => {
  fsm.setState(ctx.from.id, fsm.STATES.CONTACT);
  const draft = fsm.getDraft(ctx.from.id);
  draft.isEditing = true;
  ctx.editMessageReplyMarkup();
  ctx.reply('Оставьте контакт для связи (ваш username в Telegram или номер телефона, до 100 символов).', Markup.keyboard([['❌ Отменить']]).resize());
});
bot.action('edit_description', (ctx) => {
  fsm.setState(ctx.from.id, fsm.STATES.DESCRIPTION);
  const draft = fsm.getDraft(ctx.from.id);
  draft.isEditing = true;
  ctx.editMessageReplyMarkup();
  ctx.reply('Добавьте короткое описание прогулки. (Максимум 500 символов)', Markup.keyboard([['❌ Отменить']]).resize());
});
bot.action('edit_photo', (ctx) => {
  fsm.setState(ctx.from.id, fsm.STATES.PHOTO);
  const draft = fsm.getDraft(ctx.from.id);
  draft.isEditing = true;
  ctx.editMessageReplyMarkup();
  ctx.reply('Загрузите новое фото или нажмите «Пропустить».', Markup.keyboard([
    ['Пропустить'],
    ['❌ Отменить']
  ]).resize());
});
bot.action('cancel', (ctx) => {
  fsm.resetFSM(ctx.from.id);
  ctx.editMessageReplyMarkup();
  ctx.reply(messages.cancel, MAIN_MENU);
});
bot.action('submit', async (ctx) => {
  ctx.editMessageReplyMarkup();
  const draft = fsm.getDraft(ctx.from.id);
  // Генерируем id для анонса
  const eventId = Date.now() + Math.floor(Math.random() * 1000);
  events.push({
    ...draft,
    id: eventId,
    authorId: ctx.from.id,
    status: 'pending',
    createdAt: new Date()
  });
  // Отправка анонса админу на модерацию
  const adminChatId = process.env.ADMIN_CHAT_ID;
  let text = `\u{1F4CD} <b>${draft.topic}</b>\n\n${draft.description}\n\n`;
  if (draft.place && draft.place.latitude && draft.place.longitude) {
    text += `📫 Место: <a href=\"https://maps.google.com/?q=${draft.place.latitude},${draft.place.longitude}\">${draft.place.latitude},${draft.place.longitude}</a>\n`;
  } else if (draft.place) {
    text += `📫 Место: ${draft.place}\n`;
  }
  text += `🗓 Когда: ${draft.datetime}\n`;
  text += `📌 Контакт: ${draft.contact}\n\n`;
  text += `#пошлигулять #${channelUsername.replace('@','')}`;

  const moderationKeyboard = Markup.inlineKeyboard([
    [Markup.button.callback('✅ Опубликовать', `mod_approve_${ctx.from.id}`), Markup.button.callback('❌ Отклонить', `mod_reject_${ctx.from.id}`)]
  ]);

  if (draft.photo) {
    await ctx.telegram.sendPhoto(adminChatId, draft.photo, {
      caption: text,
      parse_mode: 'HTML',
      reply_markup: moderationKeyboard.reply_markup
    });
  } else {
    await ctx.telegram.sendMessage(adminChatId, text, {
      parse_mode: 'HTML',
      reply_markup: moderationKeyboard.reply_markup
    });
  }
  fsm.setState(ctx.from.id, fsm.STATES.IDLE);
  ctx.reply(messages.sentForModeration, MAIN_MENU);
});

// Модерация: публикация или отклонение
bot.action(/mod_approve_(\d+)/, async (ctx) => {
  const userId = ctx.match[1];
  const event = events.find(e => e.authorId == userId && e.status === 'pending');
  if (event) event.status = 'published';
  // Публикация в канал
  const channelId = process.env.CHANNEL_ID;
  let text = `\u{1F4CD} <b>${event.topic}</b>\n\n${event.description}\n\n`;
  if (event.place && event.place.latitude && event.place.longitude) {
    text += `📫 Место: <a href=\"https://maps.google.com/?q=${event.place.latitude},${event.place.longitude}\">${event.place.latitude},${event.place.longitude}</a>\n`;
  } else if (event.place) {
    text += `📫 Место: ${event.place}\n`;
  }
  text += `🗓 Когда: ${event.datetime}\n`;
  text += `📌 Контакт: ${event.contact}\n\n`;
  text += `#пошлигулять #${channelUsername.replace('@','')}`;

  let sentMsg;
  if (event.photo) {
    sentMsg = await ctx.telegram.sendPhoto(channelId, event.photo, {
      caption: text,
      parse_mode: 'HTML'
    });
  } else {
    sentMsg = await ctx.telegram.sendMessage(channelId, text, {
      parse_mode: 'HTML'
    });
  }
  
  // Сохраняем информацию о сообщении в канале для возможности удаления
  event.channelMessageId = sentMsg.message_id;
  event.channelChatId = channelId;
  
  // Уведомление автору
  await ctx.telegram.sendMessage(userId, messages.published(event.topic, `https://t.me/${CHANNEL_USERNAME}/${sentMsg.message_id}`));
  ctx.editMessageReplyMarkup();
  ctx.reply('Анонс опубликован.');
  fsm.resetFSM(userId);
});

// Модератор может отправить комментарий при отклонении
const modRejectComments = {};
bot.action(/mod_reject_(\d+)/, async (ctx) => {
  const userId = ctx.match[1];
  const event = events.find(e => e.authorId == userId && e.status === 'pending');
  if (!event) return ctx.reply('Анонс не найден.');
  modRejectComments[userId] = ctx.from.id; // кто отклонил
  ctx.editMessageReplyMarkup();
  ctx.reply(messages.moderatorComment);
});

if (process.env.NODE_ENV !== 'production') {
  bot.launch();
  console.log('BOT: polling');
}

module.exports = bot; 
