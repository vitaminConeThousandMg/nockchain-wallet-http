#!/usr/bin/env node

import { Command } from 'commander';
import * as fs from 'fs';
import * as nacl from 'tweetnacl';
import * as bs58 from 'bs58';

interface Payload {
  recipient: string;
  amount: number;
  timestamp: number;
}

interface TransactionOutput {
  payload: Payload;
  signature: string;
  pubkey: string;
}

function loadSigningKey(path: string): nacl.SignKeyPair {
  try {
    const keyBytes = fs.readFileSync(path);
    
    // Ensure we have the right key length for Ed25519
    if (keyBytes.length !== 32) {
      throw new Error(`Invalid key length: expected 32 bytes, got ${keyBytes.length}`);
    }
    
    return nacl.sign.keyPair.fromSecretKey(keyBytes);
  } catch (error) {
    throw new Error(`Failed to load signing key from ${path}: ${error.message}`);
  }
}

/**
 * Create transaction payload
 */
function createPayload(amount: number, recipient: string, timestamp: number): Payload {
  return {
    recipient,
    amount,
    timestamp
  };
}

function signTransaction(
  keyPair: nacl.SignKeyPair, 
  amount: number, 
  recipient: string
): TransactionOutput {
  const timestamp = Math.floor(Date.now() / 1000);
  const payload = createPayload(amount, recipient, timestamp);
  const payloadBytes = Buffer.from(
    JSON.stringify(payload, Object.keys(payload).sort(), '')
  );
  const signedMessage = nacl.sign(payloadBytes, keyPair.secretKey);
  
  const signature = signedMessage.slice(0, 64);
  
  return {
    payload,
    signature: bs58.encode(signature),
    pubkey: bs58.encode(keyPair.publicKey)
  };
}

function main(): void {
  const program = new Command();
  
  program
    .name('nockchain-signer')
    .description('Secure transaction signer for Nockchain')
    .version('1.0.0')
    .requiredOption('--key <path>', 'Path to private key file (binary Ed25519)')
    .requiredOption('--amount <number>', 'Amount to send', parseInt)
    .requiredOption('--recipient <address>', 'Recipient address')
    .parse();

  const options = program.opts();

  try {
    if (isNaN(options.amount) || options.amount <= 0) {
      throw new Error('Amount must be a positive number');
    }


    const keyPair = loadSigningKey(options.key);
    const transaction = signTransaction(keyPair, options.amount, options.recipient);
    console.log(JSON.stringify(transaction, null, 2));
    
  } catch (error) {
    console.error('Error:', error.message);
    process.exit(1);
  }
}


if (require.main === module) {
  main();
}

export { loadSigningKey, createPayload, signTransaction };
