// test-token.js
import { Telegraf } from 'telegraf';

const bot = new Telegraf('your_bot_token_here');
bot.launch()
  .then(() => console.log('Bot started successfully'))
  .catch((error) => console.error('Bot failed to start:', error));