// src/index.ts
import { Telegraf, Markup, Context } from 'telegraf';
import { session } from 'telegraf';
import * as dotenv from 'dotenv';
import { DlmmService } from './services/dlmmService';
import { Keypair, PublicKey } from '@solana/web3.js';
import bs58 from 'bs58';

// Define session interface
interface SessionData {
  wallet?: {
    keypair: Keypair;
    publicKey: string;
    privateKey: string;
  };
  waitingForWalletImport?: boolean;
}

// Extend the base Context with session
interface MyContext extends Context {
  session: SessionData;
}

dotenv.config();

const botToken = process.env.TELEGRAM_BOT_TOKEN;
if (!botToken) {
  console.error('Error: TELEGRAM_BOT_TOKEN not found in .env');
  process.exit(1);
}

const bot = new Telegraf<MyContext>(botToken); // Use extended context
const dlmmService = new DlmmService();

// Escape MarkdownV2 special characters
const escapeMarkdown = (text: string) =>
  text.replace(/([_*[\]()~`>#+=|{}.!])/g, '\\$1');

// Shared logic for positions
async function getPositions(userWallet: PublicKey) {
  await dlmmService.init('mockPoolAddress', userWallet); // Use PublicKey for read-only
  const positions = await dlmmService.getPositions(userWallet);
  return positions.length
    ? positions
        .map(
          (p, i) =>
            `**Position ${i + 1}** 📊\n` +
            `Pool: \`${escapeMarkdown(p.pool)}\`\n` +
            `Range: ${p.lowerBin}\\-${p.upperBin}\n` +
            `Liquidity: ${p.liquidity} SOL\n` +
            `Fees: ${p.feesEarned} SOL`
        )
        .join('\n\n')
    : 'No positions found. Try **Add Liquidity**.';
}

// Shared logic for rebalance
async function getRebalanceSuggestion(userWallet: PublicKey) {
  await dlmmService.init('mockPoolAddress', userWallet); // Use PublicKey for read-only
  const positions = await dlmmService.getPositions(userWallet);
  if (!positions.length) {
    return 'No positions to rebalance. Add liquidity first.';
  }
  return escapeMarkdown(await dlmmService.suggestRebalance(positions[0]));
}

// Function to get wallet overview
async function getWalletOverview(userWallet: PublicKey) {
  await dlmmService.init('mockPoolAddress', userWallet); // Use PublicKey for read-only
  const positions = await dlmmService.getPositions(userWallet);
  const balance = '1.5'; // Mock balance in SOL (to be replaced with real data)
  const address = userWallet.toString();
  const poolDetails = positions.length
    ? positions
        .map(
          (p) =>
            `Pool: \`${escapeMarkdown(p.pool)}\`, Range: ${p.lowerBin}\\-${p.upperBin}, Liquidity: ${p.liquidity} SOL`
        )
        .join('\n')
    : 'No pools associated. Add liquidity to join a pool.';
  return (
    `**Wallet Overview** 💼\n` +
    `Address: \`${address}\`\n` +
    `Balance: ${balance} SOL\n` +
    `Pools:\n${poolDetails}`
  );
}

// Middleware for session storage
bot.use(session());

// Start command
bot.start(async (ctx) => {
  // Initialize session if undefined
  if (!ctx.session) ctx.session = {};

  const userId = ctx.from!.id;

  // Check if user has wallet
  if (!ctx.session.wallet) {
    ctx.reply(
      escapeMarkdown('**Wallet Setup Required** 🔐\nFirst time? Choose how to connect your Solana wallet:'),
      {
        parse_mode: 'MarkdownV2',
        ...Markup.inlineKeyboard([
          [Markup.button.callback('Create New Wallet', 'create_wallet')],
          [Markup.button.callback('Import Wallet', 'import_wallet')],
        ]),
      }
    );
    return;
  }

  // User has wallet, show menu
  ctx.reply(
    escapeMarkdown('**Welcome back!** 🚀\nYour wallet: `${ctx.session.wallet.publicKey}`\nChoose an action:'),
    {
      parse_mode: 'MarkdownV2',
      ...Markup.inlineKeyboard([
        [Markup.button.callback('View Positions', 'positions')],
        [Markup.button.callback('Add Liquidity', 'add_liquidity')],
        [Markup.button.callback('Remove Liquidity', 'remove_liquidity')],
        [Markup.button.callback('Rebalance', 'rebalance')],
        [Markup.button.callback('Wallet Overview', 'wallet_overview')],
      ]),
    }
  );
});

bot.action('create_wallet', async (ctx) => {
  // Initialize session if undefined
  if (!ctx.session) ctx.session = {};

  const userId = ctx.from!.id;
  const keypair = Keypair.generate();
  const publicKey = keypair.publicKey.toString();
  const privateKeyBase58 = bs58.encode(keypair.secretKey);

  // Store in session
  ctx.session.wallet = { keypair, publicKey, privateKey: privateKeyBase58 };

  ctx.reply(
    escapeMarkdown('**New Wallet Created** 🆕\nPublic Key: `${publicKey}`\n\n**Save this private key securely:** `${privateKeyBase58}`\n\n⚠️ Never share your private key!'),
    {
      parse_mode: 'MarkdownV2',
      ...Markup.inlineKeyboard([
        [Markup.button.callback('Back to Menu', 'menu')],
      ]),
    }
  );
});

bot.action('import_wallet', async (ctx) => {
  // Initialize session if undefined
  if (!ctx.session) ctx.session = {};

  ctx.session.waitingForWalletImport = true;
  ctx.reply(
    escapeMarkdown('**Import Wallet** 🔑\nSend your base58 private key (e.g., "dev123...").\n\n⚠️ Demo only—use secure methods in production.'),
    { parse_mode: 'MarkdownV2' }
  );
});

// Handle wallet import from text message
bot.on('text', async (ctx) => {
  // Initialize session if undefined
  if (!ctx.session) ctx.session = {};

  const userId = ctx.from!.id;

  if (ctx.session.waitingForWalletImport && (ctx.message!.text.startsWith('dev') || ctx.message!.text.length > 80)) {
    try {
      const privateKeyBase58 = ctx.message!.text.trim();
      const secretKey = bs58.decode(privateKeyBase58);
      if (secretKey.length !== 64) throw new Error('Invalid private key length');
      const keypair = Keypair.fromSecretKey(secretKey);
      const publicKey = keypair.publicKey.toString();

      ctx.session.wallet = { keypair, publicKey, privateKey: privateKeyBase58 };
      delete ctx.session.waitingForWalletImport;

      ctx.reply(
        escapeMarkdown('**Wallet Imported** ✅\nPublic Key: `${publicKey}`\n\nReady to use!'),
        {
          parse_mode: 'MarkdownV2',
          ...Markup.inlineKeyboard([
            [Markup.button.callback('Back to Menu', 'menu')],
          ]),
        }
      );
    } catch (error) {
      ctx.reply(escapeMarkdown('**Error**: Invalid private key. Try again.'), { parse_mode: 'MarkdownV2' });
    }
  } else if (ctx.message!.text.startsWith('/')) {
    // Handle commands directly if no wallet is set
    ctx.reply(escapeMarkdown('**Error**: No wallet set. Use /start to configure.'), { parse_mode: 'MarkdownV2' });
  }
});

// Update action handlers to use user wallet
bot.action('positions', async (ctx) => {
  // Initialize session if undefined
  if (!ctx.session) ctx.session = {};

  try {
    if (!ctx.session.wallet) {
      ctx.reply(escapeMarkdown('**Error**: No wallet set. Use /start to configure.'), { parse_mode: 'MarkdownV2' });
      return;
    }
    const message = await getPositions(ctx.session.wallet.keypair.publicKey);
    ctx.reply(escapeMarkdown(`**Your Positions** 📋\n\n${message}`), {
      parse_mode: 'MarkdownV2',
      ...Markup.inlineKeyboard([[Markup.button.callback('Back to Menu', 'menu')]]),
    });
  } catch (error) {
    ctx.reply(escapeMarkdown(`**Error**: ${escapeMarkdown((error as Error).message)}`), {
      parse_mode: 'MarkdownV2',
    });
  }
});

bot.action('add_liquidity', async (ctx) => {
  // Initialize session if undefined
  if (!ctx.session) ctx.session = {};

  ctx.reply(
    escapeMarkdown('**Add Liquidity** 💧\nUse the command: `/add_liquidity <pool> <lower_bin> <upper_bin> <amount_x> <amount_y>`'),
    {
      parse_mode: 'MarkdownV2',
      ...Markup.inlineKeyboard([[Markup.button.callback('Back to Menu', 'menu')]]),
    }
  );
});

bot.action('remove_liquidity', async (ctx) => {
  // Initialize session if undefined
  if (!ctx.session) ctx.session = {};

  ctx.reply(
    escapeMarkdown('**Remove Liquidity** 🏦\nUse the command: `/remove_liquidity <position_pubkey> <amount>`'),
    {
      parse_mode: 'MarkdownV2',
      ...Markup.inlineKeyboard([[Markup.button.callback('Back to Menu', 'menu')]]),
    }
  );
});

bot.action('rebalance', async (ctx) => {
  // Initialize session if undefined
  if (!ctx.session) ctx.session = {};

  try {
    if (!ctx.session.wallet) {
      ctx.reply(escapeMarkdown('**Error**: No wallet set. Use /start to configure.'), { parse_mode: 'MarkdownV2' });
      return;
    }
    const suggestion = await getRebalanceSuggestion(ctx.session.wallet.keypair.publicKey);
    ctx.reply(escapeMarkdown(`**Rebalance Suggestion** ⚖️\n${suggestion}`), {
      parse_mode: 'MarkdownV2',
      ...Markup.inlineKeyboard([[Markup.button.callback('Back to Menu', 'menu')]]),
    });
  } catch (error) {
    ctx.reply(escapeMarkdown(`**Error**: ${escapeMarkdown((error as Error).message)}`), {
      parse_mode: 'MarkdownV2',
    });
  }
});

bot.action('wallet_overview', async (ctx) => {
  // Initialize session if undefined
  if (!ctx.session) ctx.session = {};

  try {
    if (!ctx.session.wallet) {
      ctx.reply(escapeMarkdown('**Error**: No wallet set. Use /start to configure.'), { parse_mode: 'MarkdownV2' });
      return;
    }
    const overview = await getWalletOverview(ctx.session.wallet.keypair.publicKey);
    ctx.reply(escapeMarkdown(overview), {
      parse_mode: 'MarkdownV2',
      ...Markup.inlineKeyboard([[Markup.button.callback('Back to Menu', 'menu')]]),
    });
  } catch (error) {
    ctx.reply(escapeMarkdown(`**Error**: ${escapeMarkdown((error as Error).message)}`), {
      parse_mode: 'MarkdownV2',
    });
  }
});

bot.action('menu', (ctx) => {
  // Initialize session if undefined
  if (!ctx.session) ctx.session = {};

  ctx.reply(
    escapeMarkdown('**Saros DLMM Bot Menu** 🚀\nChoose an action:'),
    {
      parse_mode: 'MarkdownV2',
      ...Markup.inlineKeyboard([
        [Markup.button.callback('View Positions', 'positions')],
        [Markup.button.callback('Add Liquidity', 'add_liquidity')],
        [Markup.button.callback('Remove Liquidity', 'remove_liquidity')],
        [Markup.button.callback('Rebalance', 'rebalance')],
        [Markup.button.callback('Wallet Overview', 'wallet_overview')],
      ]),
    }
  );
});

// Text commands with wallet check
bot.command('positions', async (ctx) => {
  // Initialize session if undefined
  if (!ctx.session) ctx.session = {};

  try {
    if (!ctx.session.wallet) {
      ctx.reply(escapeMarkdown('**Error**: No wallet set. Use /start to configure.'), { parse_mode: 'MarkdownV2' });
      return;
    }
    const message = await getPositions(ctx.session.wallet.keypair.publicKey);
    ctx.reply(escapeMarkdown(`**Your Positions** 📋\n\n${message}`), {
      parse_mode: 'MarkdownV2',
      ...Markup.inlineKeyboard([[Markup.button.callback('Back to Menu', 'menu')]]),
    });
  } catch (error) {
    ctx.reply(escapeMarkdown(`**Error**: ${escapeMarkdown((error as Error).message)}`), {
      parse_mode: 'MarkdownV2',
    });
  }
});

bot.command('add_liquidity', async (ctx) => {
  // Initialize session if undefined
  if (!ctx.session) ctx.session = {};

  const args = ctx.message!.text.split(' ').slice(1);
  if (args.length < 4) {
    return ctx.reply(
      escapeMarkdown('**Add Liquidity** 💧\nUsage: `/add_liquidity <pool> <lower_bin> <upper_bin> <amount_x> <amount_y>`'),
      { parse_mode: 'MarkdownV2' }
    );
  }
  const [pool, lowerBin, upperBin, amountX, amountY = '0'] = args;
  try {
    if (!ctx.session.wallet) {
      ctx.reply(escapeMarkdown('**Error**: No wallet set. Use /start to configure.'), { parse_mode: 'MarkdownV2' });
      return;
    }
    await dlmmService.init(pool, ctx.session.wallet.keypair); // Use Keypair for write operation
    const sig = await dlmmService.addLiquidity(Number(lowerBin), Number(upperBin), amountX, amountY, ctx.session.wallet.keypair);
    ctx.reply(escapeMarkdown(`**Liquidity Added** 💧\nTransaction: \`${escapeMarkdown(sig)}\``), {
      parse_mode: 'MarkdownV2',
      ...Markup.inlineKeyboard([[Markup.button.callback('Back to Menu', 'menu')]]),
    });
  } catch (error) {
    ctx.reply(escapeMarkdown(`**Error**: ${escapeMarkdown((error as Error).message)}`), {
      parse_mode: 'MarkdownV2',
    });
  }
});

bot.command('remove_liquidity', async (ctx) => {
  // Initialize session if undefined
  if (!ctx.session) ctx.session = {};

  const args = ctx.message!.text.split(' ').slice(1);
  if (args.length < 2) {
    return ctx.reply(
      escapeMarkdown('**Remove Liquidity** 🏦\nUsage: `/remove_liquidity <position_pubkey> <amount>`'),
      { parse_mode: 'MarkdownV2' }
    );
  }
  const [positionPubkey, amount] = args;
  try {
    if (!ctx.session.wallet) {
      ctx.reply(escapeMarkdown('**Error**: No wallet set. Use /start to configure.'), { parse_mode: 'MarkdownV2' });
      return;
    }
    await dlmmService.init('mockPoolAddress', ctx.session.wallet.keypair); // Use default pool and Keypair
    const sig = await dlmmService.removeLiquidity(new PublicKey(positionPubkey), amount, ctx.session.wallet.keypair);
    ctx.reply(escapeMarkdown(`**Liquidity Removed** 🏦\nTransaction: \`${escapeMarkdown(sig)}\``), {
      parse_mode: 'MarkdownV2',
      ...Markup.inlineKeyboard([[Markup.button.callback('Back to Menu', 'menu')]]),
    });
  } catch (error) {
    ctx.reply(escapeMarkdown(`**Error**: ${escapeMarkdown((error as Error).message)}`), {
      parse_mode: 'MarkdownV2',
    });
  }
});

bot.command('rebalance', async (ctx) => {
  // Initialize session if undefined
  if (!ctx.session) ctx.session = {};

  try {
    if (!ctx.session.wallet) {
      ctx.reply(escapeMarkdown('**Error**: No wallet set. Use /start to configure.'), { parse_mode: 'MarkdownV2' });
      return;
    }
    const suggestion = await getRebalanceSuggestion(ctx.session.wallet.keypair.publicKey);
    ctx.reply(escapeMarkdown(`**Rebalance Suggestion** ⚖️\n${suggestion}`), {
      parse_mode: 'MarkdownV2',
      ...Markup.inlineKeyboard([[Markup.button.callback('Back to Menu', 'menu')]]),
    });
  } catch (error) {
    ctx.reply(escapeMarkdown(`**Error**: ${escapeMarkdown((error as Error).message)}`), {
      parse_mode: 'MarkdownV2',
    });
  }
});

bot.launch()
  .then(() => console.log('Bot running...'))
  .catch((error) => console.error('Failed to launch bot:', error));

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));

console.log('Starting index.ts...');