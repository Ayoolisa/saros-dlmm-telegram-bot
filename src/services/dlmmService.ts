// src/services/dlmmService.ts
import { Connection, PublicKey, Keypair, TransactionSignature } from '@solana/web3.js';
import * as dotenv from 'dotenv';
import bs58 from 'bs58';

dotenv.config();

// src/services/dlmmService.ts
// ... (previous imports and setup remain unchanged)

const MockDLMM = {
  async getUserPositions(user: PublicKey) {
    return [
      {
        pool: 'mockPoolAddress',
        lowerBinId: 100,
        upperBinId: 200,
        liquidity: '1000',
        feesOwed: '10',
      },
    ];
  },
  async createPositionAndAddLiquidity(lowerBin: number, upperBin: number, amountX: string, amountY: string) {
    if (isNaN(lowerBin) || isNaN(upperBin) || !amountX || !amountY) {
      throw new Error('Invalid liquidity parameters');
    }
    const txSig = `mockTx_${lowerBin}_${upperBin}_${amountX}_${amountY}_${Date.now()}`;
    console.log('MockDLMM.createPositionAndAddLiquidity called with:', { lowerBin, upperBin, amountX, amountY }, 'returning:', txSig);
    return txSig;
  },
  async removeLiquidity(positionPubkey: PublicKey, amount: string) {
    if (!amount || isNaN(Number(amount))) throw new Error('Invalid amount for removal');
    const txSig = `mockRemoveTx_${positionPubkey.toString()}_${amount}_${Date.now()}`;
    console.log('MockDLMM.removeLiquidity called with:', { positionPubkey, amount }, 'returning:', txSig);
    return txSig;
  },
};

const RPC_URL = process.env.SOLANA_RPC_URL || 'https://api.devnet.solana.com';
const connection = new Connection(RPC_URL, 'confirmed');

// Global bot wallet (for bot-owned operations, if needed)
const walletPrivateKey = process.env.WALLET_PRIVATE_KEY;
let botWallet: Keypair | null = null;

if (walletPrivateKey) {
  try {
    const secretKey = bs58.decode(walletPrivateKey);
    if (secretKey.length !== 64) {
      throw new Error('Invalid private key length; expected 64 bytes');
    }
    botWallet = Keypair.fromSecretKey(secretKey);
    console.log('Bot wallet public key:', botWallet.publicKey.toString());
  } catch (error) {
    console.error('Failed to parse WALLET_PRIVATE_KEY:', (error as Error).message);
  }
} else {
  console.error('WALLET_PRIVATE_KEY not found in .env');
}

export class DlmmService {
  private dlmm: typeof MockDLMM | null = null;
  private userWallet: Keypair | null = null;

  async init(poolAddress: string, userWallet?: PublicKey | Keypair) {
    console.log('DlmmService init called with poolAddress:', poolAddress, 'userWallet type:', typeof userWallet);
    if (userWallet instanceof Keypair) {
      this.userWallet = userWallet;
    } else if (userWallet) {
      this.userWallet = botWallet; // Fallback to bot wallet for read-only ops with PublicKey
    } else {
      this.userWallet = botWallet;
    }
    if (!this.userWallet) throw new Error('Wallet not configured');
    this.dlmm = MockDLMM;
    console.log('DlmmService init successful, userWallet publicKey:', this.userWallet.publicKey.toString());
    return this.dlmm;
  }

  async getPositions(userPublicKey: PublicKey) {
    console.log('getPositions called with userPublicKey:', userPublicKey.toString());
    if (!this.dlmm) throw new Error('DLMM not initialized');
    try {
      const positions = await this.dlmm.getUserPositions(userPublicKey);
      const formattedPositions = positions.map((pos) => ({
        pool: pos.pool.toString(),
        lowerBin: pos.lowerBinId,
        upperBin: pos.upperBinId,
        liquidity: pos.liquidity.toString(),
        feesEarned: pos.feesOwed.toString(),
      }));
      console.log('getPositions returned:', formattedPositions);
      return formattedPositions;
    } catch (error) {
      console.error('getPositions error:', error);
      throw new Error(`Failed to fetch positions: ${(error as Error).message}`);
    }
  }

  async addLiquidity(lowerBin: number, upperBin: number, amountX: string, amountY: string, userKeypair?: Keypair): Promise<TransactionSignature> {
    console.log('addLiquidity called with lowerBin:', lowerBin, 'upperBin:', upperBin, 'amountX:', amountX, 'amountY:', amountY);
    if (!this.dlmm || (!this.userWallet && !userKeypair)) throw new Error('DLMM/Wallet not ready');
    const signer = userKeypair || this.userWallet!;
    console.log('addLiquidity signer publicKey:', signer.publicKey.toString());
    try {
      if (isNaN(lowerBin) || isNaN(upperBin) || !amountX || !amountY) {
        throw new Error('Invalid input parameters for liquidity addition');
      }
      const tx = await this.dlmm.createPositionAndAddLiquidity(lowerBin, upperBin, amountX, amountY);
      console.log('addLiquidity returned tx:', tx);
      return tx;
    } catch (error) {
      console.error('addLiquidity error:', error);
      throw new Error(`Add liquidity failed: ${(error as Error).message}`);
    }
  }

  async removeLiquidity(positionPubkey: PublicKey, amount: string, userKeypair?: Keypair): Promise<TransactionSignature> {
    console.log('removeLiquidity called with positionPubkey:', positionPubkey.toString(), 'amount:', amount);
    if (!this.dlmm || (!this.userWallet && !userKeypair)) throw new Error('DLMM/Wallet not ready');
    const signer = userKeypair || this.userWallet!;
    console.log('removeLiquidity signer publicKey:', signer.publicKey.toString());
    try {
      if (!amount || isNaN(Number(amount))) throw new Error('Invalid amount for removal');
      const tx = await this.dlmm.removeLiquidity(positionPubkey, amount); // Pass positionPubkey
      console.log('removeLiquidity returned tx:', tx);
      return tx;
    } catch (error) {
      console.error('removeLiquidity error:', error);
      throw new Error(`Remove liquidity failed: ${(error as Error).message}`);
    }
  }

  async suggestRebalance(position: any) {
    console.log('suggestRebalance called with position:', position);
    return 'Suggestion: Shift 20% liquidity to lower bins for better yield\\.';
  }
}