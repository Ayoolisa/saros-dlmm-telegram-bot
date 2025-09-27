import { Telegraf, Markup, Context } from 'telegraf';
import { session } from 'telegraf';
import * as dotenv from 'dotenv';
// FIX: Changed import to include .js extension for successful module resolution in compiled environment (e.g., Node.js ESM in dist/)
import { DlmmService } from './services/dlmmService.js'; 
import { Keypair, PublicKey, Connection } from '@solana/web3.js';
import bs58 from 'bs58';
import * as http from 'http'; // Import Node.js HTTP module for the landing page server

dotenv.config();

// WARNING: Global in-memory storage. All wallet and state data will be lost if the bot is restarted.
// For production use, this data must be persisted using a database.

// Types
interface WalletData {
  publicKey: string;
  privateKey: string;
}

interface PositionData {
  pool: string;
  lowerBin: number;
  upperBin: number;
  liquidity: number; // Changed to number for cleaner comparison
  feesEarned: number; // Changed to number for cleaner comparison
}

interface UserState {
  lastBalance: number;
  lastPositions: PositionData[]; // Use the defined type
  lastSignatures: string[];
  network: string;
  lastFaucetTime?: number; // Track last faucet request
}

// Extend Telegraf's Context with session properties
interface MyContext extends Context {
  session: {
    wallet?: WalletData;
    waitingForWalletImport?: boolean;
  };
}

// Global state
const wallets: Record<number, WalletData> = {};
const states: Record<number, UserState> = {};

const botToken = process.env.TELEGRAM_BOT_TOKEN;
if (!botToken) {
  console.error('Error: TELEGRAM_BOT_TOKEN not found in .env');
  process.exit(1);
}

const RPC_URL = process.env.SOLANA_RPC_URL || 'https://api.devnet.solana.com';
const FALLBACK_RPC_URL = process.env.SOLANA_FALLBACK_RPC_URL || 'https://devnet.genesysgo.net'; // Fallback RPC
const connection = new Connection(RPC_URL, 'confirmed');

const dlmmService = new DlmmService();

/**
 * Escapes all reserved MarkdownV2 characters that break plain text.
 * FIX: Re-added '.' and '!' to the escape list as they are reserved characters in MarkdownV2.
 */
const escapeMarkdownV2 = (text: string): string => {
  if (typeof text !== 'string') return '';
  // Escapes: _ * [ ] ( ) ~ ` > # + - = | { } . ! \
  // This is the full set of reserved characters that must be escaped in plain text for MarkdownV2.
  return text.replace(/([_*[\]()~`>#+\-=|{}.!\\/])/g, '\\$1'); 
};

// --- Shared Utility Functions ---

/**
 * Sends a helpful message when wallet data is missing due to session loss.
 */
const replyWalletMissing = (ctx: MyContext) => {
  ctx.reply(
    escapeMarkdownV2('Oops! Your wallet session was lost (e.g., bot restart). Please use /start to re-create or re-import your wallet.'), 
    { parse_mode: 'MarkdownV2' }
  );
};


// Shared logic for positions
async function getPositions(userWallet: PublicKey) {
  try {
    // Initialize the service for read operations
    await dlmmService.init('', userWallet); 
    const positions = await dlmmService.getPositions(userWallet);
    
    if (!positions.length) {
      return escapeMarkdownV2('You don\'t have any positions yet. Try adding some liquidity!');
    }
    
    // Construct the string, escaping the dynamic parts (addresses, numbers)
    return positions
        .map(
          (p, i) =>
            `*Position ${i + 1}*\n` +
            `Pool: ${escapeMarkdownV2(p.pool)}\n` +
            `Range: ${p.lowerBin} to ${p.upperBin}\n` +
            `Liquidity: ${escapeMarkdownV2(p.liquidity.toFixed(4))} SOL\n` + // FIX: Escaping the formatted number which contains '.'
            `Fees: ${escapeMarkdownV2(p.feesEarned.toFixed(4))} SOL` // FIX: Escaping the formatted number which contains '.'
        )
        .join('\n\n');
  } catch (error) {
    console.error('getPositions error:', error);
    const errorMessage = (error as Error).message || 'an unknown error occurred';
    return escapeMarkdownV2(`Sorry, we couldn’t check your positions right now. Error: ${errorMessage}. Try again later.`);
  }
}

// Shared logic for rebalance
async function getRebalanceSuggestion(userWallet: PublicKey) {
  try {
    await dlmmService.init('', userWallet);
    const positions = await dlmmService.getPositions(userWallet);
    if (!positions.length) {
      return escapeMarkdownV2('You don’t have any positions to rebalance. Add liquidity first!');
    }
    // Assuming suggestRebalance returns a descriptive string
    return dlmmService.suggestRebalance(positions[0]); // Service handles escaping
  } catch (error) {
    console.error('getRebalanceSuggestion error:', error);
    const errorMessage = (error as Error).message || 'an unknown error occurred';
    return escapeMarkdownV2(`Sorry, we couldn’t suggest a rebalance right now. Error: ${errorMessage}. Try again later.`);
  }
}

// Function to get wallet overview
async function getWalletOverview(userWallet: PublicKey) {
  try {
    await dlmmService.init('', userWallet);
    const balance = await connection.getBalance(userWallet) / 1e9; // Fetch actual balance
    const escapedBalance = escapeMarkdownV2(balance.toFixed(4)); // FIX: Escaping the formatted number which contains '.'
    const address = escapeMarkdownV2(userWallet.toString()); // Escape the address
    const positions = await dlmmService.getPositions(userWallet);
    
    const poolDetails = positions.length
      ? positions
          .map(
            (p) => {
              const safePool = escapeMarkdownV2(p.pool); // Fully escape the pool string first
              const safeLiquidity = escapeMarkdownV2(p.liquidity.toFixed(4)); // FIX: Escaping the formatted number which contains '.'
              return `Pool: ${safePool}, Range: ${p.lowerBin} to ${p.upperBin}, Liquidity: ${safeLiquidity} SOL`;
            }
          )
          .join('\n')
      : 'No pools yet. Add liquidity to join one!';
      
    // Return the escaped message content
    return escapeMarkdownV2(
      `Your Wallet Info\n` +
      `Address: ${address}\n` +
      `Balance: ${escapedBalance} SOL\n` + 
      `Pools:\n${poolDetails}`
    ); 
  } catch (error) {
    console.error('getWalletOverview error:', error);
    const errorMessage = (error as Error).message || 'an unknown error occurred';
    return escapeMarkdownV2(`Sorry, we couldn’t load your wallet info. Error: ${errorMessage}. Try again later.`);
  }
}

/**
 * Robust retry function for airdrop with enhanced error handling.
 */
async function requestAirdropWithRetry(conn: Connection, publicKey: PublicKey, lamports: number, retries = 3, delayMs = 2000) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const signature = await conn.requestAirdrop(publicKey, lamports);
      // Wait for confirmation to ensure the airdrop is processed
      const confirmation = await conn.confirmTransaction(signature, 'confirmed');
      if (confirmation.value.err) {
          throw new Error(`Transaction failed to confirm: ${JSON.stringify(confirmation.value.err)}`);
      }
      return signature;
    } catch (error) {
      const err = error as any;
      const rpcUrl = (conn as any)._rpcEndpoint; // Get the URL used for logging
      console.error(`Airdrop attempt ${attempt} on ${rpcUrl} failed: ${err.message}`);
      
      if (attempt === retries) {
        throw err; 
      }
      // Implement exponential backoff for retries
      await new Promise((resolve) => setTimeout(resolve, delayMs * Math.pow(2, attempt - 1)));
    }
  }
  throw new Error('Airdrop failed after all retries.'); 
}

// Initialize Telegraf bot and session middleware
const bot = new Telegraf<MyContext>(botToken);
bot.use(session());

// Logging middleware
bot.use((ctx, next) => {
  const userId = ctx.from?.id || 'unknown';
  if (ctx.callbackQuery && 'data' in ctx.callbackQuery) {
    console.log(`User ${userId} clicked button: ${ctx.callbackQuery.data}`);
  } else if (ctx.message && 'text' in ctx.message) { // Explicitly check if it's a text message for logging
    console.log(`User ${userId} sent message: ${ctx.message.text}`);
  }
  return next();
});

// Wallet loading middleware
bot.use((ctx, next) => {
  const userId = ctx.from?.id;
  if (userId) {
    if (!ctx.session) ctx.session = {}; 
    
    // Attempt to restore wallet from global map if session is new or missing wallet data
    if (wallets[userId] && !ctx.session.wallet) {
      ctx.session.wallet = wallets[userId];
    }
  }
  return next();
});

// Start command
bot.start(async (ctx) => {
  if (!ctx.session.wallet) {
    ctx.reply(
      escapeMarkdownV2('Welcome! You need to set up a wallet first. Choose an option to get started:'),
      {
        ...Markup.inlineKeyboard([
          [Markup.button.callback('Create a new wallet', 'create_wallet')],
          [Markup.button.callback('Import a wallet', 'import_wallet')],
        ]),
        parse_mode: 'MarkdownV2',
      }
    );
    return;
  }

  ctx.reply(
    escapeMarkdownV2(`Welcome back! Your wallet is ready: ${ctx.session.wallet.publicKey}. Pick an action:`),
    {
      ...Markup.inlineKeyboard([
        [Markup.button.callback('See my positions', 'positions')],
        [Markup.button.callback('Add liquidity', 'add_liquidity')],
        [Markup.button.callback('Remove liquidity', 'remove_liquidity')],
        [Markup.button.callback('Get rebalance tips', 'rebalance')],
        [Markup.button.callback('Check my wallet', 'wallet_overview')],
        [Markup.button.callback('View pools', 'pools')],
        [Markup.button.callback('Request Faucet', 'request_tokens')], 
      ]),
      parse_mode: 'MarkdownV2',
    }
  );
});

bot.action('create_wallet', async (ctx) => {
  await ctx.answerCbQuery();
  const userId = ctx.from!.id;
  const keypair = Keypair.generate();
  const publicKey = keypair.publicKey.toString();
  const privateKeyBase58 = bs58.encode(keypair.secretKey);

  ctx.session.wallet = { publicKey, privateKey: privateKeyBase58 };
  wallets[userId] = ctx.session.wallet;
  
  try {
    const balance = await connection.getBalance(new PublicKey(publicKey)) / 1e9;
    const escapedBalance = escapeMarkdownV2(balance.toFixed(4));
    
    ctx.reply(
      escapeMarkdownV2(
        `New wallet created! Your public key is: ${publicKey}\n` +
        `Keep this private key safe: ${privateKeyBase58}\n` +
        `*Please don’t share it with anyone!* (Except for testing in this sandbox.)\n` +
        `Initial balance: ${escapedBalance} SOL. No positions or pools yet.`),
      {
        ...Markup.inlineKeyboard([
          [Markup.button.callback('Request Test Tokens', 'request_tokens')],
          [Markup.button.callback('Go to menu', 'menu')],
        ]),
        parse_mode: 'MarkdownV2',
      }
    );
  } catch (error) {
    console.error('Initial balance check failed:', error);
    ctx.reply(
      escapeMarkdownV2(`New wallet created, but we couldn't check the balance due to a network error. Public key: ${publicKey}`),
      {
        ...Markup.inlineKeyboard([
          [Markup.button.callback('Request Test Tokens', 'request_tokens')],
          [Markup.button.callback('Go to menu', 'menu')],
        ]),
        parse_mode: 'MarkdownV2',
      }
    );
  }
});

bot.action('import_wallet', async (ctx) => {
  await ctx.answerCbQuery();
  ctx.session.waitingForWalletImport = true;
  ctx.reply(
    escapeMarkdownV2(
      'Import your wallet by sending your private key (Base58 encoded, e.g., "dev123..."). ' +
      'This is just for testing—use secure methods in real use!'
    ),
    { parse_mode: 'MarkdownV2' }
  );
});

// Handle wallet import from text message
bot.on('text', async (ctx) => {
  const userId = ctx.from!.id;
  // Safely access 'text' using type assertion for Telegraf's complex type union
  const privateKeyText = (ctx.message as any).text || '';

  if (ctx.session.waitingForWalletImport && (privateKeyText.startsWith('dev') || privateKeyText.length > 80)) {
    try {
      const privateKeyBase58 = privateKeyText.trim();
      
      const secretKey = bs58.decode(privateKeyBase58);
      if (secretKey.length !== 64) {
        throw new Error('Invalid private key length (must be 64 bytes).');
      }
      
      const keypair = Keypair.fromSecretKey(secretKey);
      const publicKey = keypair.publicKey.toString();

      ctx.session.wallet = { publicKey, privateKey: privateKeyBase58 };
      wallets[userId] = ctx.session.wallet;
      delete ctx.session.waitingForWalletImport;

      const balance = await connection.getBalance(new PublicKey(publicKey)) / 1e9;
      const escapedBalance = escapeMarkdownV2(balance.toFixed(4));
      
      ctx.reply(
        escapeMarkdownV2(
          `Wallet imported! Your public key is: ${publicKey}\n` +
          `Initial balance: ${escapedBalance} SOL. No positions or pools yet.`
        ),
        {
          ...Markup.inlineKeyboard([
            [Markup.button.callback('Request Test Tokens', 'request_tokens')],
            [Markup.button.callback('Go to menu', 'menu')],
          ]),
          parse_mode: 'MarkdownV2',
        }
      );
    } catch (error) {
      console.error(`Wallet import error for user ${userId}:`, error);
      const errorMessage = (error as Error).message || 'Invalid key or unknown error';
      ctx.reply(escapeMarkdownV2(`Oops! Something went wrong: ${errorMessage}. Please try again with a valid private key:`), { parse_mode: 'MarkdownV2' });
    }
  } else if (privateKeyText.startsWith('/')) {
    // If it's a command, let it proceed to command handlers, or prompt if no wallet
    if (!ctx.session.wallet) {
      replyWalletMissing(ctx);
    }
  }
});

// Action to request test tokens
bot.action('request_tokens', async (ctx) => {
  await ctx.answerCbQuery();
  const userId = ctx.from!.id;

  try {
    if (!ctx.session.wallet) {
      replyWalletMissing(ctx);
      return;
    }

    if (!states[userId]) {
      states[userId] = { lastBalance: 0, lastPositions: [], lastSignatures: [], network: 'devnet', lastFaucetTime: 0 };
    }
    const state = states[userId];
    const now = Date.now();
    const timeSinceLastFaucet = (now - (state.lastFaucetTime || 0)) / 1000; // In seconds
    const hourlyLimitSeconds = 60 * 60; // 1 hour

    // Check hourly limit
    if (timeSinceLastFaucet < hourlyLimitSeconds) {
      const remainingTime = Math.ceil((hourlyLimitSeconds - timeSinceLastFaucet) / 60);
      ctx.reply(escapeMarkdownV2(`Sorry, you can only request tokens once per hour. Wait *${remainingTime}* minutes and try again.`), { parse_mode: 'MarkdownV2' });
      return;
    }

    ctx.reply(escapeMarkdownV2('Requesting 2 test SOL, this may take a moment...'));
    
    const pubkey = new PublicKey(ctx.session.wallet.publicKey);
    let signature;
    
    // --- Attempt with Primary and Fallback RPCs ---
    try {
      signature = await requestAirdropWithRetry(connection, pubkey, 2e9); 
    } catch (primaryError) {
      console.warn(`Primary RPC failed: ${RPC_URL}. Trying fallback RPC...`);
      const fallbackConnection = new Connection(FALLBACK_RPC_URL, 'confirmed');
      signature = await requestAirdropWithRetry(fallbackConnection, pubkey, 2e9);
    }
    
    // Success
    states[userId] = { ...state, lastFaucetTime: now };
    ctx.reply(
      escapeMarkdownV2(`Success! You got 2 test SOL.\nTransaction Signature: ${signature.slice(0, 10)}....\nCheck your wallet in a few minutes.`), 
      {
        ...Markup.inlineKeyboard([[Markup.button.callback('Go to menu', 'menu')]]),
        parse_mode: 'MarkdownV2',
      }
    );
  } catch (error) {
    console.error(`Request tokens error for user ${ctx.from!.id}:`, error);
    const err = error as any;

    // Step 1: Define the plain text error part (and escape it)
    let replyMessage = 'Sorry, the airdrop service is unavailable or severely rate-limited right now.';
    
    if ((err.message || '').includes('rate limit') || (err.message || '').includes('Airdrop failed')) {
      replyMessage += ' This is common on Devnet public RPCs.';
    } else if ((err.message || '').includes('timeout') || (err.message || '').includes('network')) {
      replyMessage += ' We encountered a network issue during the request.';
    }
    
    const escapedReplyMessage = escapeMarkdownV2(replyMessage);

    // Step 2: Construct the final message using a template literal, ensuring backticks are used correctly for Markdown V2
    const walletAddress = ctx.session.wallet?.publicKey || 'No wallet set';
    const faucetLink = 'https://faucet.solana.com/';

    const finalMessage = 
        escapedReplyMessage + 
        '\n\n' +
        escapeMarkdownV2('You can also try the official web faucet: ') + 
        `\`${faucetLink}\`` + 
        escapeMarkdownV2(' using your wallet address: ') + 
        `\`${walletAddress}\``;

    ctx.reply(finalMessage, { parse_mode: 'MarkdownV2' });
  }
});

// Update action handlers

bot.action('positions', async (ctx) => {
  await ctx.answerCbQuery();
  
  try {
    if (!ctx.session.wallet) {
      replyWalletMissing(ctx); // Use the new function for clarity
      return;
    }
    const message = await getPositions(new PublicKey(ctx.session.wallet.publicKey));
    ctx.reply(message, {
      parse_mode: 'MarkdownV2',
      ...Markup.inlineKeyboard([[Markup.button.callback('Go to menu', 'menu')]]),
    });
  } catch (error) {
    console.error(`Positions error for user ${ctx.from!.id}:`, error);
    const errorMessage = (error as Error).message || 'an unknown error occurred';
    ctx.reply(escapeMarkdownV2(`Sorry, we couldn’t check your positions. Error: ${errorMessage}. Try again later.`), { parse_mode: 'MarkdownV2' });
  }
});

bot.action('add_liquidity', async (ctx) => {
  await ctx.answerCbQuery();
  
  if (!ctx.session.wallet) {
    replyWalletMissing(ctx); // Use the new function for clarity
    return;
  }
  
  ctx.reply(
    escapeMarkdownV2('Add liquidity by typing: `/add_liquidity <pool_address> <lower_bin> <upper_bin> <amount_x> <amount_y>`\n\nOr try a test option:'),
    {
      ...Markup.inlineKeyboard([
        [Markup.button.callback('Try a test amount', 'add_liquidity_mock')],
        [Markup.button.callback('Go to menu', 'menu')],
      ]),
      parse_mode: 'MarkdownV2',
    }
  );
});

bot.action('add_liquidity_mock', async (ctx) => {
  await ctx.answerCbQuery();

  try {
    if (!ctx.session.wallet) {
      replyWalletMissing(ctx); // Use the new function for clarity
      return;
    }
    const keypair = Keypair.fromSecretKey(bs58.decode(ctx.session.wallet.privateKey));
    // Pass the actual keypair for signing
    const sig = await dlmmService.addLiquidity(1, 10, '1', '1', keypair); 
    
    ctx.reply(
      escapeMarkdownV2(`Great! Your mock liquidity was added.\nTransaction Signature: ${sig.slice(0, 10)}....\nCheck your wallet soon.`), 
      {
        ...Markup.inlineKeyboard([[Markup.button.callback('Go to menu', 'menu')]]),
        parse_mode: 'MarkdownV2',
      }
    );
  } catch (error) {
    console.error(`Add liquidity mock error for user ${ctx.from!.id}:`, error);
    const errorMessage = (error as Error).message || 'an unknown error occurred';
    ctx.reply(escapeMarkdownV2(`Sorry, we couldn’t add your liquidity. Error: ${errorMessage}. Try again later.`), { parse_mode: 'MarkdownV2' });
  }
});

bot.action('remove_liquidity', async (ctx) => {
  await ctx.answerCbQuery();

  if (!ctx.session.wallet) {
    replyWalletMissing(ctx); // Use the new function for clarity
    return;
  }
  
  ctx.reply(
    escapeMarkdownV2('Remove liquidity by typing: `/remove_liquidity <position_pubkey> <amount>`\n\n_Note: You need the position\'s public key from the "See my positions" view to use this command._'),
    {
      ...Markup.inlineKeyboard([
        [Markup.button.callback('Go to menu', 'menu')],
      ]),
      parse_mode: 'MarkdownV2',
    }
  );
});

bot.action('rebalance', async (ctx) => {
  await ctx.answerCbQuery();

  try {
    if (!ctx.session.wallet) {
      replyWalletMissing(ctx); // Use the new function for clarity
      return;
    }
    const suggestion = await getRebalanceSuggestion(new PublicKey(ctx.session.wallet.publicKey));
    ctx.reply(suggestion, {
      parse_mode: 'MarkdownV2',
      ...Markup.inlineKeyboard([[Markup.button.callback('Go to menu', 'menu')]]),
    });
  } catch (error) {
    console.error(`Rebalance error for user ${ctx.from!.id}:`, error);
    const errorMessage = (error as Error).message || 'an unknown error occurred';
    ctx.reply(escapeMarkdownV2(`Sorry, we couldn’t suggest a rebalance right now. Error: ${errorMessage}. Try again later.`), { parse_mode: 'MarkdownV2' });
  }
});

bot.action('wallet_overview', async (ctx) => {
  await ctx.answerCbQuery();

  try {
    if (!ctx.session.wallet) {
      replyWalletMissing(ctx); // Use the new function for clarity
      return;
    }
    const overview = await getWalletOverview(new PublicKey(ctx.session.wallet.publicKey));
    ctx.reply(overview, {
      parse_mode: 'MarkdownV2',
      ...Markup.inlineKeyboard([[Markup.button.callback('Go to menu', 'menu')]]),
    });
  } catch (error) {
    console.error(`Wallet overview error for user ${ctx.from!.id}:`, error);
    const errorMessage = (error as Error).message || 'an unknown error occurred';
    ctx.reply(escapeMarkdownV2(`Sorry, we couldn’t load your wallet info. Error: ${errorMessage}. Try again later.`), { parse_mode: 'MarkdownV2' });
  }
});

bot.action('pools', async (ctx) => {
  await ctx.answerCbQuery();
  ctx.reply(
    escapeMarkdownV2('Here are some example pool addresses to try (you must replace these with real addresses for actual interaction):\n\n- `9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin` (SOL/USDC example)\n- `7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU` (Another example)'),
    {
      ...Markup.inlineKeyboard([[Markup.button.callback('Go to menu', 'menu')]]),
      parse_mode: 'MarkdownV2',
    }
  );
});

bot.action('menu', async (ctx) => {
  await ctx.answerCbQuery();

  ctx.reply(
    escapeMarkdownV2('What would you like to do next?'),
    {
      ...Markup.inlineKeyboard([
        [Markup.button.callback('See my positions', 'positions')],
        [Markup.button.callback('Add liquidity', 'add_liquidity')],
        [Markup.button.callback('Remove liquidity', 'remove_liquidity')],
        [Markup.button.callback('Get rebalance tips', 'rebalance')],
        [Markup.button.callback('Check my wallet', 'wallet_overview')],
        [Markup.button.callback('View pools', 'pools')],
        [Markup.button.callback('Request Faucet', 'request_tokens')],
      ]),
      parse_mode: 'MarkdownV2',
    }
  );
});

// --- Text commands with wallet check ---

bot.command('positions', async (ctx) => {
  try {
    if (!ctx.session.wallet) {
      replyWalletMissing(ctx); // Use the new function for clarity
      return;
    }
    const message = await getPositions(new PublicKey(ctx.session.wallet.publicKey));
    ctx.reply(message, {
      parse_mode: 'MarkdownV2',
      ...Markup.inlineKeyboard([[Markup.button.callback('Go to menu', 'menu')]]),
    });
  } catch (error) {
    console.error(`Positions command error for user ${ctx.from!.id}:`, error);
    const errorMessage = (error as Error).message || 'an unknown error occurred';
    ctx.reply(escapeMarkdownV2(`Sorry, we couldn’t check your positions. Error: ${errorMessage}. Try again later.`), { parse_mode: 'MarkdownV2' });
  }
});

bot.command('add_liquidity', async (ctx) => {
  const args = ctx.message.text.split(' ').slice(1) || []; 
  if (args.length < 5) { 
    return ctx.reply(
      escapeMarkdownV2('Invalid format. Use: `/add_liquidity <pool_address> <lower_bin> <upper_bin> <amount_x> <amount_y>`'),
      { parse_mode: 'MarkdownV2' }
    );
  }
  const [pool, lowerBinStr, upperBinStr, amountX, amountY] = args;
  
  if (!ctx.session.wallet) {
    replyWalletMissing(ctx); // Use the new function for clarity
    return;
  }
  
  const lowerBin = Number(lowerBinStr);
  const upperBin = Number(upperBinStr);
  const amountXStr = amountX.trim();
  const amountYStr = amountY.trim();
  
  if (isNaN(lowerBin) || isNaN(upperBin) || lowerBin < 0 || upperBin < 0 || isNaN(Number(amountXStr)) || isNaN(Number(amountYStr)) || Number(amountXStr) <= 0 || Number(amountYStr) <= 0) {
    return ctx.reply(escapeMarkdownV2('Oops! Please use valid positive numbers for bins and amounts.'), { parse_mode: 'MarkdownV2' });
  }
  
  try {
    // Basic validation for Public Key format
    new PublicKey(pool);
    
    const keypair = Keypair.fromSecretKey(bs58.decode(ctx.session.wallet.privateKey));
    await dlmmService.init(pool, keypair.publicKey); 
    
    // Call the service, passing the signing Keypair
    const sig = await dlmmService.addLiquidity(lowerBin, upperBin, amountXStr, amountYStr, keypair); 
    
    ctx.reply(
      escapeMarkdownV2(`Great! Your liquidity was added.\nTransaction Signature: ${sig.slice(0, 10)}....\nCheck your wallet soon.`), 
      {
        parse_mode: 'MarkdownV2',
        ...Markup.inlineKeyboard([[Markup.button.callback('Go to menu', 'menu')]]),
      }
    );
  } catch (error) {
    console.error(`Add liquidity command error for user ${ctx.from!.id}:`, error);
    const errorMessage = (error as Error).message || 'an unknown error occurred';
    
    if (errorMessage.includes('Invalid public key')) {
       ctx.reply(escapeMarkdownV2('Error: The pool address provided is not a valid Solana Public Key. Please check the format.'), { parse_mode: 'MarkdownV2' });
    } else {
       ctx.reply(escapeMarkdownV2(`Sorry, we couldn’t add your liquidity. Error: ${errorMessage}. Try again later.`), { parse_mode: 'MarkdownV2' });
    }
  }
});

bot.command('remove_liquidity', async (ctx) => {
  const args = ctx.message.text.split(' ').slice(1) || []; 
  if (args.length < 2) {
    return ctx.reply(
      escapeMarkdownV2('Invalid format. Use: `/remove_liquidity <position_pubkey> <amount>`'),
      { parse_mode: 'MarkdownV2' }
    );
  }
  const [positionPubkeyStr, amount] = args;
  
  if (!ctx.session.wallet) {
    replyWalletMissing(ctx); // Use the new function for clarity
    return;
  }
  
  const amountNum = Number(amount);
  if (isNaN(amountNum) || amountNum <= 0) {
    return ctx.reply(escapeMarkdownV2('Oops! Please use a valid positive number for the amount to remove.'), { parse_mode: 'MarkdownV2' });
  }
  
  try {
    // Basic validation for Public Key format
    const positionPubkey = new PublicKey(positionPubkeyStr); 
    
    const keypair = Keypair.fromSecretKey(bs58.decode(ctx.session.wallet.privateKey));
    
    await dlmmService.init('', keypair.publicKey); // Init for signing context
    // Call the service, passing the signing Keypair
    const sig = await dlmmService.removeLiquidity(positionPubkey, amount, keypair);
    
    ctx.reply(
      escapeMarkdownV2(`Great! Your liquidity was removed.\nTransaction Signature: ${sig.slice(0, 10)}....\nCheck your wallet soon.`), 
      {
        parse_mode: 'MarkdownV2',
        ...Markup.inlineKeyboard([[Markup.button.callback('Go to menu', 'menu')]]),
      }
    );
  } catch (error) {
    console.error(`Remove liquidity command error for user ${ctx.from!.id}:`, error);
    const errorMessage = (error as Error).message || 'an unknown error occurred';
    
    if (errorMessage.includes('Invalid public key')) {
       ctx.reply(escapeMarkdownV2('Error: The position address provided is not a valid Solana Public Key. Please check the format.'), { parse_mode: 'MarkdownV2' });
    } else {
       ctx.reply(escapeMarkdownV2(`Sorry, we couldn’t remove your liquidity. Error: ${errorMessage}. Try again later.`), { parse_mode: 'MarkdownV2' });
    }
  }
});

bot.command('rebalance', async (ctx) => {
  try {
    if (!ctx.session.wallet) {
      replyWalletMissing(ctx); // Use the new function for clarity
      return;
    }
    const suggestion = await getRebalanceSuggestion(new PublicKey(ctx.session.wallet.publicKey));
    ctx.reply(suggestion, {
      parse_mode: 'MarkdownV2',
      ...Markup.inlineKeyboard([[Markup.button.callback('Go to menu', 'menu')]]),
    });
  } catch (error) {
    console.error(`Rebalance command error for user ${ctx.from!.id}:`, error);
    const errorMessage = (error as Error).message || 'an unknown error occurred';
    ctx.reply(escapeMarkdownV2(`Sorry, we couldn’t suggest a rebalance. Error: ${errorMessage}. Try again later.`), { parse_mode: 'MarkdownV2' });
  }
});

bot.command('faucet', async (ctx) => {
  // Directly call the action handler to avoid code duplication
  await bot.handleUpdate({
    update_id: ctx.update.update_id,
    callback_query: {
      id: `faucet_cmd_${Date.now()}`,
      from: ctx.from!,
      chat_instance: '',
      data: 'request_tokens',
    }
  } as any); 
});

// Global error handler to prevent bot crash
bot.catch((err, ctx) => {
  const error = err as Error;
  console.error(`Telegraf error for user ${ctx?.from?.id || 'unknown'} in chat ${ctx.chat?.id || 'unknown'}:`, error.message, error);
  if (ctx) {
    ctx.reply(escapeMarkdownV2('Sorry, something went wrong on our end. Please try again later.'), { parse_mode: 'MarkdownV2' }).catch(() => {
      console.error('Failed to send error message to user.');
    });
  }
});

// --- New HTTP Server for Landing Page Redirect ---

/**
 * Starts a minimal HTTP server to redirect web requests (like clicking the Render URL)
 * to a dedicated landing page.
 */
const startLandingPageServer = () => {
    // IMPORTANT: Change this to your actual landing page URL
    const LANDING_PAGE_URL = 'https://docs.saros.finance/saros-dlmm/dlmm-mechanism'; 
    const PORT = process.env.PORT || 3000;

    const server = http.createServer((req, res) => {
        // Only redirect requests to the root path
        if (req.url === '/') {
            console.log(`Web request received. Redirecting to: ${LANDING_PAGE_URL}`);
            res.writeHead(302, { 'Location': LANDING_PAGE_URL });
            res.end();
        } else {
            // Respond with a 404 for any other path
            res.writeHead(404, { 'Content-Type': 'text/plain' });
            res.end('Not Found');
        }
    });

    server.listen(PORT, () => {
        console.log(`HTTP Redirect Server running on port ${PORT}.`);
    });
};

// Launch with Retry
async function launchBotWithRetry(maxRetries = 5, delayMs = 5000) {
  // Start the HTTP redirect server first, as it needs to run concurrently
  startLandingPageServer(); 
  
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      await bot.launch();
      console.log(`Bot launched successfully on attempt ${attempt}`);
      return;
    } catch (error) {
      console.error(`Launch attempt ${attempt} failed: ${(error as Error).message}`);
      if (attempt === maxRetries) throw error;
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
  throw new Error('Bot launch failed after all retries.'); 
}

// Polling for alerts (runs every 5 minutes = 300,000ms)
setInterval(async () => {
  for (const [userIdStr, walletData] of Object.entries(wallets)) {
    const userId = Number(userIdStr);
    
    if (!states[userId]) {
      states[userId] = { lastBalance: 0, lastPositions: [], lastSignatures: [], network: 'devnet' };
    }
    
    try {
      const state = states[userId];
      let currentBalance = state.lastBalance;
      let currentPositions: PositionData[] = state.lastPositions;
      let currentSignatures = state.lastSignatures;
      const userPublicKey = new PublicKey(walletData.publicKey);

      // --- 1. Fetch Balance with Retry ---
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          currentBalance = await connection.getBalance(userPublicKey) / 1e9;
          break;
        } catch (err) {
          if (attempt === 2) throw err;
          await new Promise((r) => setTimeout(r, 2000));
        }
      }

      // --- 2. Fetch Positions ---
      await dlmmService.init('', userPublicKey);
      currentPositions = await dlmmService.getPositions(userPublicKey) as PositionData[];

      // --- 3. Fetch Signatures with Retry ---
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          const signatures = await connection.getSignaturesForAddress(userPublicKey, { limit: 5 });
          currentSignatures = signatures.map((s) => s.signature);
          break;
        } catch (err) {
          if (attempt === 2) throw err;
          await new Promise((r) => setTimeout(r, 2000));
        }
      }

      // --- 4. Alert Logic ---
      let alert = '';
      const oldBalanceStr = state.lastBalance.toFixed(4);
      const newBalanceStr = currentBalance.toFixed(4);
      
      if (newBalanceStr !== oldBalanceStr) { 
        alert += `Balance changed: ${oldBalanceStr} to ${newBalanceStr} SOL\n`;
      }
      
      // Compare positions by stringifying the filtered data (e.g., ignoring fees that change constantly)
      const positionsChanged = JSON.stringify(currentPositions.map(p => ({ p: p.pool, l: p.lowerBin, u: p.upperBin, liq: p.liquidity }))) !== 
                             JSON.stringify(state.lastPositions.map(p => ({ p: p.pool, l: p.lowerBin, u: p.upperBin, liq: p.liquidity })));

      if (positionsChanged) {
        alert += 'Your DLMM positions have updated (new position or range change)!\n';
      }
      if (currentSignatures.some((sig) => !state.lastSignatures.includes(sig))) {
        alert += 'New activity detected in your wallet (new transaction signature)!\n';
      }

      if (alert) {
        // Use an actual newline, and then escape the *entire* message.
        await bot.telegram.sendMessage(
            userId, 
            escapeMarkdownV2(`🚨 Hey! Something changed:\n${alert}`), 
            { parse_mode: 'MarkdownV2' }
        );
      }

      // Update state for next poll
      states[userId] = { 
        ...state, 
        lastBalance: currentBalance, 
        lastPositions: currentPositions, 
        lastSignatures: currentSignatures 
      };
    } catch (error) {
      console.error(`Polling error for ${userIdStr}:`, error);
    }
  }
}, 300000); // 5 minutes

process.on('SIGINT', () => {
    bot.stop('SIGINT');
    // Note: The HTTP server will shut down when the main process exits.
});
process.on('SIGTERM', () => {
    bot.stop('SIGTERM');
});

launchBotWithRetry().catch((error) => {
  console.error('Failed to launch bot after retries:', (error as Error).message);
  process.exit(1);
});
