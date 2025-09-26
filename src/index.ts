// src/index.ts
import { Telegraf, Markup, Context } from 'telegraf';
import { session } from 'telegraf';
import * as dotenv from 'dotenv';
import { DlmmService } from './services/dlmmService';
import { Keypair, PublicKey, Connection, clusterApiUrl } from '@solana/web3.js';
import bs58 from 'bs58';
import fs from 'fs';

// Constants
const WALLET_FILE = 'wallets.json';
const STATE_FILE = 'states.json';

// Interfaces
interface WalletData {
  publicKey: string;
  privateKey: string;
}

interface UserState {
  lastBalance: number;
  lastPositions: any[];
  lastSignatures: string[];
}

interface SessionData {
  wallet?: WalletData;
  waitingForWalletImport?: boolean;
}

interface MyContext extends Context {
  session: SessionData;
}

// Load and save data
let wallets: Record<number, WalletData> = {};
let states: Record<number, UserState> = {};

function loadData(file: string): any {
  if (fs.existsSync(file)) {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  }
  return {};
}

function saveData(file: string, data: any) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

wallets = loadData(WALLET_FILE);
states = loadData(STATE_FILE);

// Config
dotenv.config();

const botToken = process.env.TELEGRAM_BOT_TOKEN;
if (!botToken) {
  console.error('Error: TELEGRAM_BOT_TOKEN not found in .env');
  process.exit(1);
}

const RPC_URL = process.env.SOLANA_RPC_URL || clusterApiUrl('devnet'); // Default to Devnet, but allow override
const connection = new Connection(RPC_URL, 'confirmed');

const dlmmService = new DlmmService();

// Escape Markdown
const escapeMarkdown = (text: string) =>
  text.replace(/([_*[\]()~`>#+=|{}.!])/g, '\\$1');

// Utility Functions
async function getPositions(userWallet: PublicKey) {
  await dlmmService.init('mockPoolAddress', userWallet);
  const positions = await dlmmService.getPositions(userWallet);
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
    : 'No positions found. Try *Add Liquidity*.';
}

async function getRebalanceSuggestion(userWallet: PublicKey) {
  await dlmmService.init('mockPoolAddress', userWallet);
  const positions = await dlmmService.getPositions(userWallet);
  if (!positions.length) {
    return 'No positions to rebalance. Add liquidity first.';
  }
  return escapeMarkdown(await dlmmService.suggestRebalance(positions[0]));
}

async function getWalletOverview(userWallet: PublicKey) {
  await dlmmService.init('mockPoolAddress', userWallet);
  const positions = await dlmmService.getPositions(userWallet);
  const balance = await connection.getBalance(userWallet) / 1e9;
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
    `*Wallet Overview* 💼\n` +
    `Address: \`${address}\`\n` +
    `Balance: ${balance} SOL\n` +
    `Pools:\n${poolDetails}`
  );
}

// Initialize Bot
const bot = new Telegraf<MyContext>(botToken);

// Middleware
bot.use(session());

bot.use((ctx, next) => {
  const userId = ctx.from?.id || 'unknown';
  if (ctx.callbackQuery) {
    // Type guard to ensure ctx.callbackQuery has data property
    if ('data' in ctx.callbackQuery) {
      console.log(`User ${userId} clicked button: ${ctx.callbackQuery.data}`);
    } else {
      console.log(`User ${userId} triggered a callback without data`);
    }
  } else if (ctx.message && 'text' in ctx.message) {
    console.log(`User ${userId} sent message: ${ctx.message.text}`);
  }
  return next();
});

bot.use((ctx, next) => {
  if (!ctx.session) ctx.session = {}; // Initialize session if undefined
  const userId = ctx.from?.id;
  if (userId && wallets[userId]) {
    ctx.session.wallet = wallets[userId];
  }
  return next();
});

// Handlers
bot.start(async (ctx) => {
  if (!ctx.session) ctx.session = {};

  const userId = ctx.from!.id;

  if (!ctx.session.wallet) {
    ctx.reply(
      escapeMarkdown('*Wallet Setup Required* 🔐\nFirst time? Choose how to connect your Solana wallet:'),
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

  ctx.reply(
    escapeMarkdown(`*Welcome back!* 🚀\nYour wallet: \`${ctx.session.wallet.publicKey}\`\nChoose an action:`),
    {
      parse_mode: 'MarkdownV2',
      ...Markup.inlineKeyboard([
        [Markup.button.callback('View Positions', 'positions')],
        [Markup.button.callback('Add Liquidity', 'add_liquidity')],
        [Markup.button.callback('Remove Liquidity', 'remove_liquidity')],
        [Markup.button.callback('Rebalance', 'rebalance')],
        [Markup.button.callback('Wallet Overview', 'wallet_overview')],
        [Markup.button.callback('Change Wallet', 'change_wallet')],
      ]),
    }
  );
});

bot.action('create_wallet', async (ctx) => {
  await ctx.answerCbQuery();
  if (!ctx.session) ctx.session = {};

  const userId = ctx.from!.id;
  const keypair = Keypair.generate();
  const publicKey = keypair.publicKey.toString();
  const privateKeyBase58 = bs58.encode(keypair.secretKey);

  const walletData: WalletData = { publicKey, privateKey: privateKeyBase58 };
  ctx.session.wallet = walletData;
  wallets[userId] = walletData;
  saveData(WALLET_FILE, wallets);

  ctx.reply(
    escapeMarkdown(`*New Wallet Created* 🆕\nPublic Key: \`${publicKey}\`\n\n*Save this private key securely:* \`${privateKeyBase58}\`\n\n⚠️ Never share your private key!`),
    {
      parse_mode: 'MarkdownV2',
      ...Markup.inlineKeyboard([
        [Markup.button.callback('Back to Menu', 'menu')],
      ]),
    }
  );

  if (!states[userId]) {
    states[userId] = { lastBalance: 0, lastPositions: [], lastSignatures: [] };
    saveData(STATE_FILE, states);
  }
});

bot.action('import_wallet', async (ctx) => {
  await ctx.answerCbQuery();
  if (!ctx.session) ctx.session = {};

  ctx.session.waitingForWalletImport = true;
  ctx.reply(
    escapeMarkdown('*Import Wallet* 🔑\nSend your base58 private key (e.g., "dev123...").\n\n⚠️ Demo only—use secure methods in production.'),
    { parse_mode: 'MarkdownV2' }
  );
});

bot.on('text', async (ctx) => {
  if (!ctx.session) ctx.session = {};

  const userId = ctx.from!.id;

  if (ctx.session.waitingForWalletImport && (ctx.message!.text.startsWith('dev') || ctx.message!.text.length > 80)) {
    try {
      const privateKeyBase58 = ctx.message!.text.trim();
      const secretKey = bs58.decode(privateKeyBase58);
      if (secretKey.length !== 64) throw new Error('Invalid private key length');
      const keypair = Keypair.fromSecretKey(secretKey);
      const publicKey = keypair.publicKey.toString();

      const walletData: WalletData = { publicKey, privateKey: privateKeyBase58 };
      ctx.session.wallet = walletData;
      wallets[userId] = walletData;
      saveData(WALLET_FILE, wallets);
      delete ctx.session.waitingForWalletImport;

      ctx.reply(
        escapeMarkdown(`*Wallet Imported* ✅\nPublic Key: \`${publicKey}\`\n\nReady to use!`),
        {
          parse_mode: 'MarkdownV2',
          ...Markup.inlineKeyboard([
            [Markup.button.callback('Back to Menu', 'menu')],
          ]),
        }
      );

      if (!states[userId]) {
        states[userId] = { lastBalance: 0, lastPositions: [], lastSignatures: [] };
        saveData(STATE_FILE, states);
      }
    } catch (error) {
      ctx.reply(escapeMarkdown(`*Error*: ${(error as Error).message}. Try again.`), { parse_mode: 'MarkdownV2' });
    }
  } else if (ctx.message!.text.startsWith('/')) {
    ctx.reply(escapeMarkdown('*Error*: No wallet set. Use /start to configure.'), { parse_mode: 'MarkdownV2' });
  }
});

bot.action('positions', async (ctx) => {
  await ctx.answerCbQuery();
  if (!ctx.session) ctx.session = {};

  try {
    if (!ctx.session.wallet) {
      ctx.reply(escapeMarkdown('*Error*: No wallet set. Use /start to configure.'), { parse_mode: 'MarkdownV2' });
      return;
    }
    const message = await getPositions(new PublicKey(ctx.session.wallet.publicKey));
    ctx.reply(escapeMarkdown(`*Your Positions* 📋\n\n${message}`), {
      parse_mode: 'MarkdownV2',
      ...Markup.inlineKeyboard([[Markup.button.callback('Back to Menu', 'menu')]]),
    });
  } catch (error) {
    ctx.reply(escapeMarkdown(`*Error*: ${escapeMarkdown((error as Error).message)}`), { parse_mode: 'MarkdownV2' });
  }
});

bot.action('add_liquidity', async (ctx) => {
  await ctx.answerCbQuery();
  if (!ctx.session) ctx.session = {};

  ctx.reply(
    escapeMarkdown('*Add Liquidity* 💧\nUse the command: `/add_liquidity <pool> <lower_bin> <upper_bin> <amount_x> <amount_y>`'),
    {
      parse_mode: 'MarkdownV2',
      ...Markup.inlineKeyboard([[Markup.button.callback('Back to Menu', 'menu')]]),
    }
  );
});

bot.command('add_liquidity', async (ctx) => {
  if (!ctx.session) ctx.session = {};

  const args = ctx.message!.text.split(' ').slice(1);
  if (args.length < 4) {
    return ctx.reply(
      escapeMarkdown('*Add Liquidity* 💧\nUsage: `/add_liquidity <pool> <lower_bin> <upper_bin> <amount_x> <amount_y>`'),
      { parse_mode: 'MarkdownV2' }
    );
  }
  const [pool, lowerBinStr, upperBinStr, amountX, amountY = '0'] = args;
  const lowerBin = Number(lowerBinStr);
  const upperBin = Number(upperBinStr);
  if (isNaN(lowerBin) || isNaN(upperBin) || !amountX || !amountY || lowerBin >= upperBin) {
    return ctx.reply(escapeMarkdown('*Error*: Invalid inputs. Ensure bins are numbers, amount_x and amount_y are positive, and lower_bin < upper_bin.'), { parse_mode: 'MarkdownV2' });
  }
  try {
    if (!ctx.session.wallet) {
      ctx.reply(escapeMarkdown('*Error*: No wallet set. Use /start to configure.'), { parse_mode: 'MarkdownV2' });
      return;
    }
    const keypair = Keypair.fromSecretKey(bs58.decode(ctx.session.wallet.privateKey));
    await dlmmService.init(pool, keypair);
    const sig = await dlmmService.addLiquidity(lowerBin, upperBin, amountX, amountY, keypair);
    ctx.reply(escapeMarkdown(`*Liquidity Added* 💧\nTransaction: \`${escapeMarkdown(sig)}\`\nPool: ${escapeMarkdown(pool)}`), {
      parse_mode: 'MarkdownV2',
      ...Markup.inlineKeyboard([[Markup.button.callback('Back to Menu', 'menu')]]),
    });
  } catch (error) {
    ctx.reply(escapeMarkdown(`*Error*: ${escapeMarkdown((error as Error).message)}`), { parse_mode: 'MarkdownV2' });
  }
});

bot.action('remove_liquidity', async (ctx) => {
  await ctx.answerCbQuery();
  if (!ctx.session) ctx.session = {};

  ctx.reply(
    escapeMarkdown('*Remove Liquidity* 🏦\nUse the command: `/remove_liquidity <position_pubkey> <amount>`'),
    {
      parse_mode: 'MarkdownV2',
      ...Markup.inlineKeyboard([[Markup.button.callback('Back to Menu', 'menu')]]),
    }
  );
});

bot.command('remove_liquidity', async (ctx) => {
  if (!ctx.session) ctx.session = {};

  const args = ctx.message!.text.split(' ').slice(1);
  if (args.length < 2) {
    return ctx.reply(
      escapeMarkdown('*Remove Liquidity* 🏦\nUsage: `/remove_liquidity <position_pubkey> <amount>`'),
      { parse_mode: 'MarkdownV2' }
    );
  }
  const [positionPubkeyStr, amount] = args;
  try {
    const positionPubkey = new PublicKey(positionPubkeyStr);
    if (isNaN(Number(amount)) || !amount) {
      throw new Error('Invalid amount for liquidity removal');
    }
    if (!ctx.session.wallet) {
      ctx.reply(escapeMarkdown('*Error*: No wallet set. Use /start to configure.'), { parse_mode: 'MarkdownV2' });
      return;
    }
    const keypair = Keypair.fromSecretKey(bs58.decode(ctx.session.wallet.privateKey));
    await dlmmService.init('mockPoolAddress', keypair);
    const sig = await dlmmService.removeLiquidity(positionPubkey, amount, keypair);
    ctx.reply(escapeMarkdown(`*Liquidity Removed* 🏦\nTransaction: \`${escapeMarkdown(sig)}\`\nPosition: ${escapeMarkdown(positionPubkeyStr)}`), {
      parse_mode: 'MarkdownV2',
      ...Markup.inlineKeyboard([[Markup.button.callback('Back to Menu', 'menu')]]),
    });
  } catch (error) {
    ctx.reply(escapeMarkdown(`*Error*: ${escapeMarkdown((error as Error).message)}`), { parse_mode: 'MarkdownV2' });
  }
});

bot.action('rebalance', async (ctx) => {
  await ctx.answerCbQuery();
  if (!ctx.session) ctx.session = {};

  try {
    if (!ctx.session.wallet) {
      ctx.reply(escapeMarkdown('*Error*: No wallet set. Use /start to configure.'), { parse_mode: 'MarkdownV2' });
      return;
    }
    const suggestion = await getRebalanceSuggestion(new PublicKey(ctx.session.wallet.publicKey));
    ctx.reply(escapeMarkdown(`*Rebalance Suggestion* ⚖️\n${suggestion}`), {
      parse_mode: 'MarkdownV2',
      ...Markup.inlineKeyboard([[Markup.button.callback('Back to Menu', 'menu')]]),
    });
  } catch (error) {
    ctx.reply(escapeMarkdown(`*Error*: ${escapeMarkdown((error as Error).message)}`), { parse_mode: 'MarkdownV2' });
  }
});

bot.action('wallet_overview', async (ctx) => {
  await ctx.answerCbQuery();
  if (!ctx.session) ctx.session = {};

  try {
    if (!ctx.session.wallet) {
      ctx.reply(escapeMarkdown('*Error*: No wallet set. Use /start to configure.'), { parse_mode: 'MarkdownV2' });
      return;
    }
    const overview = await getWalletOverview(new PublicKey(ctx.session.wallet.publicKey));
    ctx.reply(escapeMarkdown(overview), {
      parse_mode: 'MarkdownV2',
      ...Markup.inlineKeyboard([[Markup.button.callback('Back to Menu', 'menu')]]),
    });
  } catch (error) {
    ctx.reply(escapeMarkdown(`*Error*: ${escapeMarkdown((error as Error).message)}`), { parse_mode: 'MarkdownV2' });
  }
});

bot.action('menu', async (ctx) => {
  await ctx.answerCbQuery();
  if (!ctx.session) ctx.session = {};

  ctx.reply(
    escapeMarkdown('*Saros DLMM Bot Menu* 🚀\nChoose an action:'),
    {
      parse_mode: 'MarkdownV2',
      ...Markup.inlineKeyboard([
        [Markup.button.callback('View Positions', 'positions')],
        [Markup.button.callback('Add Liquidity', 'add_liquidity')],
        [Markup.button.callback('Remove Liquidity', 'remove_liquidity')],
        [Markup.button.callback('Rebalance', 'rebalance')],
        [Markup.button.callback('Wallet Overview', 'wallet_overview')],
        [Markup.button.callback('Change Wallet', 'change_wallet')],
      ]),
    }
  );
});

bot.action('change_wallet', async (ctx) => {
  await ctx.answerCbQuery();
  ctx.reply(
    escapeMarkdown('*Change Wallet* 🔄\nThis will override your current wallet. Choose option:'),
    {
      parse_mode: 'MarkdownV2',
      ...Markup.inlineKeyboard([
        [Markup.button.callback('Create New Wallet', 'create_wallet')],
        [Markup.button.callback('Import Wallet', 'import_wallet')],
        [Markup.button.callback('Back to Menu', 'menu')],
      ]),
    }
  );
});

// Launch and Polling
bot.launch()
  .then(() => console.log('Bot running...'))
  .catch((error) => console.error('Failed to launch bot:', error));

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));

console.log('Starting index.ts...');

// Polling for alerts with retry logic
setInterval(async () => {
  for (const [userId, walletData] of Object.entries(wallets)) {
    try {
      const publicKey = new PublicKey(walletData.publicKey);
      const state = states[Number(userId)] || { lastBalance: 0, lastPositions: [], lastSignatures: [] };
      let currentBalance = state.lastBalance;
      let currentPositions = state.lastPositions;
      let currentSignatures = state.lastSignatures;

      // Retry logic for getBalance
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          currentBalance = await connection.getBalance(publicKey) / 1e9;
          break;
        } catch (err) {
          if (attempt === 2) throw err;
          console.warn(`Retry ${attempt + 1} for getBalance failed for user ${userId}:`, err);
          await new Promise((resolve) => setTimeout(resolve, 2000)); // Wait 2 seconds before retry
        }
      }

      await dlmmService.init('mockPoolAddress', publicKey);
      currentPositions = await dlmmService.getPositions(publicKey);

      // Retry logic for getSignaturesForAddress
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          const signatures = await connection.getSignaturesForAddress(publicKey, { limit: 5 });
          currentSignatures = signatures.map((s) => s.signature);
          break;
        } catch (err) {
          if (attempt === 2) throw err;
          console.warn(`Retry ${attempt + 1} for getSignaturesForAddress failed for user ${userId}:`, err);
          await new Promise((resolve) => setTimeout(resolve, 2000)); // Wait 2 seconds before retry
        }
      }

      let alert = '';

      if (currentBalance !== state.lastBalance) {
        alert += `Balance change: ${state.lastBalance} -> ${currentBalance} SOL\n`;
      }

      if (JSON.stringify(currentPositions) !== JSON.stringify(state.lastPositions)) {
        alert += 'LP positions updated!\n';
      }

      if (currentSignatures.some((sig) => !state.lastSignatures.includes(sig))) {
        alert += 'New activity detected - possible unauthorized access!\n';
      }

      if (alert) {
        await bot.telegram.sendMessage(Number(userId), escapeMarkdown(`*Wallet Alert* ⚠️\n${alert}`), { parse_mode: 'MarkdownV2' });
      }

      states[Number(userId)] = {
        lastBalance: currentBalance,
        lastPositions: currentPositions,
        lastSignatures: currentSignatures,
      };
      saveData(STATE_FILE, states);
    } catch (error) {
      console.error(`Alert polling error for user ${userId}:`, error);
    }
  }
}, 300000); // Poll every 5 minutes (300 seconds) to reduce load