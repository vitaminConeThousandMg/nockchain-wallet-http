import fetch from 'node-fetch';
import nacl from 'tweetnacl';
import bs58 from 'bs58';
import * as fs from 'fs';

// Configuration
const API_BASE = process.env.API_BASE || 'http://localhost:3000';
const DEFAULT_PRIVATE_KEY_PATH = process.env.PRIVATE_KEY_PATH || './my-private-key';

// Types
interface SignedCommand {
  action: string;
  params: any;
  timestamp: number;
  nonce: string;
}

interface SignedRequest {
  msg: string;
  sig: string;
  publicKey: string;
}

interface Recipient {
  count: number;
  address: string;
}

interface SwapStatus {
  swap_id: string;
  status: string;
  recipient: string;
  amount: number;
  fee: number;
  initial_block_height: number;
  created_at: number;
  updated_at: number;
  tx_id?: string;
  error?: string;
}

// ============================================================================
// CORE CLIENT CLASS
// ============================================================================

export class NockchainClient {
  private keyPair: nacl.SignKeyPair;
  private apiBase: string;

  constructor(privateKeyPath: string, apiBase: string = API_BASE) {
    this.keyPair = this.loadPrivateKey(privateKeyPath);
    this.apiBase = apiBase;
  }

  // Load Ed25519 private key from file
  private loadPrivateKey(path: string): nacl.SignKeyPair {
    try {
      const keyBytes = fs.readFileSync(path);
      if (keyBytes.length !== 32) {
        throw new Error(`Invalid key length: expected 32 bytes, got ${keyBytes.length}`);
      }
      return nacl.sign.keyPair.fromSecretKey(keyBytes);
    } catch (error: any) {
      throw new Error(`Failed to load private key from ${path}: ${error.message}`);
    }
  }

  // Get public key as base58 string
  getPublicKey(): string {
    return bs58.encode(this.keyPair.publicKey);
  }

  // Create and sign a command
  private createSignedCommand(action: string, params: any): SignedRequest {
    const signedCommand: SignedCommand = {
      action,
      params,
      timestamp: Math.floor(Date.now() / 1000),
      nonce: Math.random().toString(36).substr(2, 9)
    };

    const msgBytes = Buffer.from(JSON.stringify(signedCommand, Object.keys(signedCommand).sort()));
    const signedMessage = nacl.sign(msgBytes, this.keyPair.secretKey);
    const signature = signedMessage.slice(0, 64);

    return {
      msg: JSON.stringify(signedCommand),
      sig: bs58.encode(signature),
      publicKey: this.getPublicKey()
    };
  }

  // ============================================================================
  // API COMMUNICATION
  // ============================================================================

  // Send any signed command to the API
  async sendCommand(action: string, params: any): Promise<any> {
    const signedRequest = this.createSignedCommand(action, params);
    
    const response = await fetch(`${this.apiBase}/send`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(signedRequest)
    });

    const result = await response.json();
    
    if (!response.ok) {
      throw new Error(`API Error: ${result.error}`);
    }
    
    return result;
  }

  // ============================================================================
  // WALLET OPERATIONS
  // ============================================================================

  // Send NOCK using automatic UTXO selection
  async sendNock(
    amountNock: number,
    recipient: string,
    fee: number = 10
  ): Promise<any> {
    console.log(`[SEND] ${amountNock} NOCK to ${recipient}`);
    
    const result = await this.sendCommand('simple-spend', {
      recipients: [{ count: 1, address: recipient }],
      amountNock,
      fee
    });
    
    console.log('[SUCCESS] Transaction sent');
    return result;
  }

  // List all notes (UTXOs) in wallet
  async listNotes(): Promise<any> {
    return this.sendCommand('list-notes', {});
  }

  // List notes for specific public key
  async listNotesByPubkey(pubkey: string): Promise<any> {
    return this.sendCommand('list-notes-by-pubkey', { pubkey });
  }

  // Check wallet balance
  async getBalance(pubkey?: string): Promise<{ assets: number; nock: number }> {
    const endpoint = pubkey ? `/wallet/balance?pubkey=${pubkey}` : '/wallet/balance';
    const response = await fetch(`${this.apiBase}${endpoint}`);
    const result = await response.json();
    
    if (!response.ok) {
      throw new Error(`Failed to get balance: ${result.error}`);
    }
    
    return result.balance;
  }

  // ============================================================================
  // SWAP OPERATIONS
  // ============================================================================

  // Initiate a swap (for bridge operations)
  async initiateSwap(
    swap_id: string,
    recipient: string,
    amount: number,
    fee: number = 10
  ): Promise<any> {
    const signedRequest = this.createSignedCommand('swap', {});
    
    const response = await fetch(`${this.apiBase}/swap/initiate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        swap_id,
        recipient,
        amount,
        fee,
        ...signedRequest
      })
    });

    const result = await response.json();
    
    if (!response.ok) {
      throw new Error(`Swap initiation failed: ${result.error}`);
    }
    
    return result;
  }

  // Check swap status
  async getSwapStatus(swap_id: string): Promise<SwapStatus> {
    const response = await fetch(`${this.apiBase}/swap/status/${swap_id}`);
    const result = await response.json();
    
    if (!response.ok) {
      throw new Error(`Failed to get swap status: ${result.error}`);
    }
    
    return result;
  }

  // ============================================================================
  // BLOCKCHAIN QUERIES
  // ============================================================================

  async getBlockchainHeight(): Promise<number> {
    const response = await fetch(`${this.apiBase}/blockchain/height`);
    const result = await response.json();
    return result.data;
  }

  async getTransaction(txId: string): Promise<any> {
    const response = await fetch(`${this.apiBase}/blockchain/transaction?id=${txId}`);
    const result = await response.json();
    return result.data;
  }

  async getLatestTransactions(limit: number = 10): Promise<any[]> {
    const response = await fetch(`${this.apiBase}/blockchain/transactions/latest?limit=${limit}`);
    const result = await response.json();
    return result.data;
  }

  // ============================================================================
  // STATUS & VERIFICATION
  // ============================================================================

  // Check server status and verify authentication
  async checkStatus(): Promise<{
    serverRunning: boolean;
    authenticated: boolean;
    publicKey?: string;
    error?: string;
  }> {
    try {
      // First check if server is running
      const healthResponse = await fetch(`${this.apiBase}/health`);
      if (!healthResponse.ok) {
        return { serverRunning: false, authenticated: false, error: 'Server not responding' };
      }

      // Then verify our signature is valid
      const signedRequest = this.createSignedCommand('test', {});
      const verifyResponse = await fetch(`${this.apiBase}/verify`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(signedRequest)
      });

      const verifyResult = await verifyResponse.json();
      
      return {
        serverRunning: true,
        authenticated: verifyResult.valid && verifyResult.authorized,
        publicKey: this.getPublicKey(),
        error: !verifyResult.valid ? 'Invalid signature' : 
               !verifyResult.authorized ? 'Unauthorized public key' : undefined
      };
    } catch (error: any) {
      return {
        serverRunning: false,
        authenticated: false,
        error: error.message
      };
    }
  }

  // Get API information
  async getApiInfo(): Promise<any> {
    const response = await fetch(`${this.apiBase}/`);
    return response.json();
  }
}

// ============================================================================
// CLI INTERFACE
// ============================================================================

async function runCLI() {
  const args = process.argv.slice(2);
  
  if (args.length === 0) {
    console.log(`
Nockchain API Client

Usage: node client.js <command> [args...]

Commands:
  status
    - Check server status and authentication
    
  send <amount> <recipient> [fee]
    - Send NOCK to recipient
    
  balance [pubkey]
    - Check wallet balance
    
  notes [pubkey]
    - List wallet notes (UTXOs)
    
  swap-init <swap_id> <recipient> <amount> [fee]
    - Initiate a swap transaction
    
  swap-status <swap_id>
    - Check swap status
    
  height
    - Get current blockchain height
    
  tx <transaction_id>
    - Get transaction details
    
  latest [limit]
    - Get latest transactions
    
  info
    - Get API information
    
  pubkey
    - Show your public key

Environment Variables:
  API_BASE=${API_BASE}
  PRIVATE_KEY_PATH=${DEFAULT_PRIVATE_KEY_PATH}

Examples:
  node client.js status
  node client.js send 100 3JWpD1VD...
  node client.js balance
  node client.js swap-init swap123 3JWpD1VD... 1000
    `);
    process.exit(1);
  }

  const command = args[0];
  
  try {
    const client = new NockchainClient(DEFAULT_PRIVATE_KEY_PATH);
    
    switch (command) {
      case 'status':
        const status = await client.checkStatus();
        console.log('Server Status:', status.serverRunning ? '✅ Running' : '❌ Not running');
        console.log('Authentication:', status.authenticated ? '✅ Valid' : '❌ Invalid');
        if (status.publicKey) console.log('Your Public Key:', status.publicKey);
        if (status.error) console.log('Error:', status.error);
        break;
      
      case 'send':
        if (args.length < 3) {
          console.error('Send requires: amount recipient [fee]');
          process.exit(1);
        }
        const amount = parseFloat(args[1]);
        const recipient = args[2];
        const fee = args[3] ? parseInt(args[3]) : 10;
        const sendResult = await client.sendNock(amount, recipient, fee);
        console.log('Transaction result:', sendResult.output);
        break;
      
      case 'balance':
        const balancePubkey = args[1];
        const balance = await client.getBalance(balancePubkey);
        console.log(`Balance: ${balance.nock} NOCK (${balance.assets} assets)`);
        break;
      
      case 'notes':
        const notesPubkey = args[1];
        const notesResult = notesPubkey 
          ? await client.listNotesByPubkey(notesPubkey)
          : await client.listNotes();
        console.log('Notes:', notesResult.output);
        break;
      
      case 'swap-init':
        if (args.length < 4) {
          console.error('Swap-init requires: swap_id recipient amount [fee]');
          process.exit(1);
        }
        const swapId = args[1];
        const swapRecipient = args[2];
        const swapAmount = parseFloat(args[3]);
        const swapFee = args[4] ? parseInt(args[4]) : 10;
        const swapResult = await client.initiateSwap(swapId, swapRecipient, swapAmount, swapFee);
        console.log('Swap initiated:', swapResult);
        break;
      
      case 'swap-status':
        if (args.length < 2) {
          console.error('Swap-status requires: swap_id');
          process.exit(1);
        }
        const checkSwapId = args[1];
        const swapStatus = await client.getSwapStatus(checkSwapId);
        console.log('Swap status:', swapStatus);
        break;
      
      case 'height':
        const height = await client.getBlockchainHeight();
        console.log('Current height:', height);
        break;
      
      case 'tx':
        if (args.length < 2) {
          console.error('Tx requires: transaction_id');
          process.exit(1);
        }
        const txId = args[1];
        const tx = await client.getTransaction(txId);
        console.log('Transaction:', JSON.stringify(tx, null, 2));
        break;
      
      case 'latest':
        const limit = args[1] ? parseInt(args[1]) : 10;
        const latest = await client.getLatestTransactions(limit);
        console.log(`Latest ${limit} transactions:`, JSON.stringify(latest, null, 2));
        break;
      
      case 'info':
        const info = await client.getApiInfo();
        console.log(JSON.stringify(info, null, 2));
        break;
      
      case 'pubkey':
        console.log(`Your public key: ${client.getPublicKey()}`);
        break;
      
      default:
        console.error(`Unknown command: ${command}`);
        console.log('Run without arguments to see usage help');
        process.exit(1);
    }
  } catch (error: any) {
    console.error('Error:', error.message);
    process.exit(1);
  }
}

// Run CLI if this file is executed directly
if (require.main === module) {
  runCLI();
}

export default NockchainClient;
