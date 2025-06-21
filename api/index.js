const { Telegraf } = require('telegraf');
const bot = require('../src/bot');
const express = require('express');

const app = express();
app.use(express.json());

// Telegraf webhook handler
app.post('/api', (req, res) => {
  bot.handleUpdate(req.body, res);
});

module.exports = app; 
