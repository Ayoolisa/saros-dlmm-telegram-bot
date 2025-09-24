// convert-key.js
import { Keypair } from '@solana/web3.js';
import * as fs from 'fs';
import bs58 from 'bs58';

const keypairFile = './solana-key.json';

try {
  if (!fs.existsSync(keypairFile)) {
    throw new Error(`Keypair file not found at: ${keypairFile}`);
  }
  const secretKey = Uint8Array.from(JSON.parse(fs.readFileSync(keypairFile, 'utf8')));
  const keypair = Keypair.fromSecretKey(secretKey);
  // Use bs58.default.encode as a fallback for some versions
  const base58PrivateKey = (bs58.default?.encode || bs58.encode)(secretKey);
  console.log('Base58 Private Key:', base58PrivateKey);
  console.log('Public Key:', keypair.publicKey.toString());
} catch (error) {
  console.error('Error converting key:', error.message);
}