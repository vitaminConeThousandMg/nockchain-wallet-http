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
  // SIMPLE-SPEND COMMANDS
  // ============================================================================

  // Full simple-spend with all parameters
  async simpleSpend(
    recipients: Recipient[],
    gifts: number[],
    names: string[][] = [['anon', 'anon']],
    fee: number = 10
  ): Promise<any> {
    console.log(`[SEND] ${gifts.join(',')} to ${recipients.length} recipients`);
    
    const result = await this.sendCommand('simple-spend', {
      recipients,
      gifts,
      names,
      fee
    });
    
    console.log('[SUCCESS] Transaction executed:', result.output);
    return result;
  }

  // Send to single recipient (most common case)
  async sendToOne(
    amount: number,
    recipient: string,
    senderName: string[] = ['anon', 'anon'],
    fee: number = 10
  ): Promise<any> {
    return this.simpleSpend(
      [{ count: 1, address: recipient }],
      [amount],
      [senderName],
      fee
    );
  }

  // Send to multiple recipients with same amount each
  async sendToMany(
    amount: number,
    recipients: string[],
    senderName: string[] = ['anon', 'anon'],
    fee: number = 10
  ): Promise<any> {
    const recipientObjects = recipients.map(addr => ({ count: 1, address: addr }));
    const gifts = recipients.map(() => amount);
    
    return this.simpleSpend(recipientObjects, gifts, [senderName], fee);
  }

  // Send different amounts to different recipients
  async sendMultiple(transfers: Array<{
    amount: number;
    recipient: string;
    count?: number;
  }>): Promise<any> {
    const recipients = transfers.map(t => ({ 
      count: t.count || 1, 
      address: t.recipient 
    }));
    const gifts = transfers.map(t => t.amount);
    
    return this.simpleSpend(recipients, gifts);
  }

  // ============================================================================
  // UTILITY METHODS
  // ============================================================================

  // Verify a signature (can be used with any public key)
  static verifySignature(msg: string, sig: string, publicKey: string): boolean {
    try {
      const sigBytes = bs58.decode(sig);
      const msgBytes = new TextEncoder().encode(msg);
      const pubKeyBytes = bs58.decode(publicKey);
      return nacl.sign.detached.verify(msgBytes, sigBytes, pubKeyBytes);
    } catch (error) {
      return false;
    }
  }

  // Test API connection
  async testConnection(): Promise<boolean> {
    try {
      const response = await fetch(`${this.apiBase}/health`);
      return response.ok;
    } catch (error) {
      return false;
    }
  }

  // Get API information
  async getApiInfo(): Promise<any> {
    const response = await fetch(`${this.apiBase}/`);
    return response.json();
  }
}

// ============================================================================
// STANDALONE UTILITY FUNCTIONS
// ============================================================================

// Create a client instance
export function createClient(privateKeyPath: string = DEFAULT_PRIVATE_KEY_PATH): NockchainClient {
  return new NockchainClient(privateKeyPath);
}

// Quick send function for simple cases
export async function quickSend(
  amount: number, 
  recipient: string, 
  privateKeyPath: string = DEFAULT_PRIVATE_KEY_PATH
): Promise<any> {
  const client = createClient(privateKeyPath);
  return client.sendToOne(amount, recipient);
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
  send <amount> <recipient> [firstName] [lastName]
    - Send amount to single recipient
    
  send-many <amount> <recipient1,recipient2,...>
    - Send same amount to multiple recipients
    
  send-multi <amount1,amount2> <recipient1,recipient2> [count1,count2]
    - Send different amounts to different recipients
    
  info
    - Get API information
    
  test
    - Test connection to API
    
  pubkey
    - Show your public key

Environment Variables:
  API_BASE=${API_BASE}
  PRIVATE_KEY_PATH=${DEFAULT_PRIVATE_KEY_PATH}

Examples:
  node client.js send 100 2v1Togj... Alice Sender
  node client.js send-many 50 addr1,addr2,addr3
  node client.js send-multi 100,200 addr1,addr2 1,2
  node client.js info
    `);
    process.exit(1);
  }

  const command = args[0];
  
  try {
    const client = createClient();
    
    switch (command) {
      case 'send':
        if (args.length < 3) {
          console.error('Send requires: amount recipient [firstName] [lastName]');
          process.exit(1);
        }
        const amount = parseInt(args[1]);
        const recipient = args[2];
        const firstName = args[3] || 'anon';
        const lastName = args[4] || 'anon';
        await client.sendToOne(amount, recipient, [firstName, lastName]);
        break;
      
      case 'send-many':
        if (args.length < 3) {
          console.error('Send-many requires: amount recipient1,recipient2,...');
          process.exit(1);
        }
        const amountMany = parseInt(args[1]);
        const recipients = args[2].split(',');
        await client.sendToMany(amountMany, recipients);
        break;
      
      case 'send-multi':
        if (args.length < 3) {
          console.error('Send-multi requires: amounts recipients [counts]');
          process.exit(1);
        }
        const amounts = args[1].split(',').map(a => parseInt(a));
        const recipientAddrs = args[2].split(',');
        const counts = args[3] ? args[3].split(',').map(c => parseInt(c)) : amounts.map(() => 1);
        
        if (amounts.length !== recipientAddrs.length || amounts.length !== counts.length) {
          console.error('Amounts, recipients, and counts must have same length');
          process.exit(1);
        }
        
        const transfers = amounts.map((amount, i) => ({
          amount,
          recipient: recipientAddrs[i],
          count: counts[i]
        }));
        
        await client.sendMultiple(transfers);
        break;
      
      case 'info':
        const info = await client.getApiInfo();
        console.log(JSON.stringify(info, null, 2));
        break;
      
      case 'test':
        const isConnected = await client.testConnection();
        console.log(`API connection: ${isConnected ? '✅ OK' : '❌ Failed'}`);
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
