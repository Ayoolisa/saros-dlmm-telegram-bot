// src/index.ts
import { Telegraf, Markup } from 'telegraf';
import * as dotenv from 'dotenv';
import { DlmmService } from './services/dlmmService';
import { PublicKey } from '@solana/web3.js';

dotenv.config();

const botToken = process.env.TELEGRAM_BOT_TOKEN;
if (!botToken) {
  console.error('Error: TELEGRAM_BOT_TOKEN not found in .env');
  process.exit(1);
}

const bot = new Telegraf(botToken);
const dlmmService = new DlmmService();

// Use real wallet public key (replace with your key from solana address or convert-key.js)
const USER_WALLET = new PublicKey('DT62WqM5a3AdKwvmH86Tu1R36VmGNDS72LqJrZuJ5CcF'); // e.g., '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM'

// Escape MarkdownV2 special characters
const escapeMarkdown = (text: string) =>
  text.replace(/([_*[\]()~`>#+=|{}.!])/g, '\\$1');

// Shared logic for positions
async function getPositions() {
  await dlmmService.init('mockPoolAddress');
  const positions = await dlmmService.getPositions(USER_WALLET);
  return positions.length
    ? positions
        .map(
          (p, i) =>
            `*Position ${i + 1}* 📊\n` +
            `Pool: \`${escapeMarkdown(p.pool)}\`\n` +
            `Range: ${p.lowerBin}\\-${p.upperBin}\n` +
            `Liquidity: ${p.liquidity} SOL\n` +
            `Fees: ${p.feesEarned} SOL`
        )
        .join('\n\n')
    : 'No positions found\\. Try *Add Liquidity*\\.';
}

// Shared logic for rebalance
async function getRebalanceSuggestion() {
  await dlmmService.init('mockPoolAddress');
  const positions = await dlmmService.getPositions(USER_WALLET);
  if (!positions.length) {
    return 'No positions to rebalance\\. Add liquidity first\\.';
  }
  return escapeMarkdown(await dlmmService.suggestRebalance(positions[0]));
}

bot.start((ctx) =>
  ctx.reply(
    '*Welcome to Saros DLMM Bot\\!* 🚀\nManage your liquidity on Solana devnet\\.\nChoose an action:',
    {
      parse_mode: 'MarkdownV2',
      ...Markup.inlineKeyboard([
        [Markup.button.callback('View Positions', 'positions')],
        [Markup.button.callback('Add Liquidity', 'add_liquidity')],
        [Markup.button.callback('Remove Liquidity', 'remove_liquidity')],
        [Markup.button.callback('Rebalance', 'rebalance')],
      ]),
    }
  )
);

bot.action('positions', async (ctx) => {
  try {
    const message = await getPositions();
    ctx.reply(`*Your Positions* 📋\n\n${message}`, {
      parse_mode: 'MarkdownV2',
      ...Markup.inlineKeyboard([[Markup.button.callback('Back to Menu', 'menu')]]),
    });
  } catch (error) {
    ctx.reply(`*Error*: ${escapeMarkdown((error as Error).message)}`, {
      parse_mode: 'MarkdownV2',
    });
  }
});

bot.action('add_liquidity', async (ctx) => {
  ctx.reply(
    '*Add Liquidity* 💧\nUse the command: `/add_liquidity <pool> <lower_bin> <upper_bin> <amount_x> <amount_y>`',
    {
      parse_mode: 'MarkdownV2',
      ...Markup.inlineKeyboard([[Markup.button.callback('Back to Menu', 'menu')]]),
    }
  );
});

bot.action('remove_liquidity', async (ctx) => {
  ctx.reply(
    '*Remove Liquidity* 🏦\nUse the command: `/remove_liquidity <position_pubkey> <amount>`',
    {
      parse_mode: 'MarkdownV2',
      ...Markup.inlineKeyboard([[Markup.button.callback('Back to Menu', 'menu')]]),
    }
  );
});

bot.action('rebalance', async (ctx) => {
  try {
    const suggestion = await getRebalanceSuggestion();
    ctx.reply(`*Rebalance Suggestion* ⚖️\n${suggestion}`, {
      parse_mode: 'MarkdownV2',
      ...Markup.inlineKeyboard([[Markup.button.callback('Back to Menu', 'menu')]]),
    });
  } catch (error) {
    ctx.reply(`*Error*: ${escapeMarkdown((error as Error).message)}`, {
      parse_mode: 'MarkdownV2',
    });
  }
});

bot.action('menu', (ctx) =>
  ctx.reply(
    '*Saros DLMM Bot Menu* 🚀\nChoose an action:',
    {
      parse_mode: 'MarkdownV2',
      ...Markup.inlineKeyboard([
        [Markup.button.callback('View Positions', 'positions')],
        [Markup.button.callback('Add Liquidity', 'add_liquidity')],
        [Markup.button.callback('Remove Liquidity', 'remove_liquidity')],
        [Markup.button.callback('Rebalance', 'rebalance')],
      ]),
    }
  )
);

// Text commands
bot.command('positions', async (ctx) => {
  try {
    const message = await getPositions();
    ctx.reply(`*Your Positions* 📋\n\n${message}`, {
      parse_mode: 'MarkdownV2',
      ...Markup.inlineKeyboard([[Markup.button.callback('Back to Menu', 'menu')]]),
    });
  } catch (error) {
    ctx.reply(`*Error*: ${escapeMarkdown((error as Error).message)}`, {
      parse_mode: 'MarkdownV2',
    });
  }
});

bot.command('add_liquidity', async (ctx) => {
  const args = ctx.message!.text.split(' ').slice(1);
  if (args.length < 4) {
    return ctx.reply(
      '*Add Liquidity* 💧\nUsage: `/add_liquidity <pool> <lower_bin> <upper_bin> <amount_x> <amount_y>`',
      { parse_mode: 'MarkdownV2' }
    );
  }
  const [pool, lowerBin, upperBin, amountX, amountY = '0'] = args;
  try {
    await dlmmService.init(pool);
    const sig = await dlmmService.addLiquidity(Number(lowerBin), Number(upperBin), amountX, amountY);
    ctx.reply(`*Liquidity Added* 💧\nTransaction: \`${escapeMarkdown(sig)}\``, {
      parse_mode: 'MarkdownV2',
      ...Markup.inlineKeyboard([[Markup.button.callback('Back to Menu', 'menu')]]),
    });
  } catch (error) {
    ctx.reply(`*Error*: ${escapeMarkdown((error as Error).message)}`, {
      parse_mode: 'MarkdownV2',
    });
  }
});

bot.command('remove_liquidity', async (ctx) => {
  const args = ctx.message!.text.split(' ').slice(1);
  if (args.length < 2) {
    return ctx.reply(
      '*Remove Liquidity* 🏦\nUsage: `/remove_liquidity <position_pubkey> <amount>`',
      { parse_mode: 'MarkdownV2' }
    );
  }
  const [positionPubkey, amount] = args;
  try {
    const sig = await dlmmService.removeLiquidity(new PublicKey(positionPubkey), amount);
    ctx.reply(`*Liquidity Removed* 🏦\nTransaction: \`${escapeMarkdown(sig)}\``, {
      parse_mode: 'MarkdownV2',
      ...Markup.inlineKeyboard([[Markup.button.callback('Back to Menu', 'menu')]]),
    });
  } catch (error) {
    ctx.reply(`*Error*: ${escapeMarkdown((error as Error).message)}`, {
      parse_mode: 'MarkdownV2',
    });
  }
});

bot.command('rebalance', async (ctx) => {
  try {
    const suggestion = await getRebalanceSuggestion();
    ctx.reply(`*Rebalance Suggestion* ⚖️\n${suggestion}`, {
      parse_mode: 'MarkdownV2',
      ...Markup.inlineKeyboard([[Markup.button.callback('Back to Menu', 'menu')]]),
    });
  } catch (error) {
    ctx.reply(`*Error*: ${escapeMarkdown((error as Error).message)}`, {
      parse_mode: 'MarkdownV2',
    });
  }
});

bot.launch()
  .then(() => console.log('Bot running...'))
  .catch((error) => console.error('Failed to launch bot:', error));

// Handle graceful shutdown
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));

console.log('Starting index.ts...');