import { exec } from 'child_process';
import { promisify } from 'util';
import nacl from 'tweetnacl';
import bs58 from 'bs58';
import { loadSigningKey } from './signer';
import * as path from 'path';
import * as fs from 'fs/promises';

const execAsync = promisify(exec);

// Configuration
const WALLET_PATH = process.env.WALLET_PATH || './test-leader/nockchain.sock';
const DEFAULT_SIGNING_KEY_PATH = process.env.SIGNING_KEY_PATH || '/path/to/signing/key';
const AUTHORIZED_PUBLIC_KEYS = process.env.AUTHORIZED_PUBLIC_KEYS?.split(',') || [];
const DRAFTS_DIR = process.env.DRAFTS_DIR || './drafts';

export interface SignedCommand {
  action: string;
  params: any;
  timestamp: number;
  nonce: string;
}

export interface CommandRequest {
  msg: string;
  sig: string;
  publicKey: string;
}

export interface CommandResult {
  success: boolean;
  output?: string;
  command?: SignedCommand;
  executedAt?: string;
  error?: string;
}

// Interface for parsed note/UTXO
export interface ParsedNote {
  first_name: string;
  last_name: string;
  assets: number;  // Already parsed as number (without dots)
  source_pubkey1?: string;
  source_pubkey2?: string;
  is_coinbase?: boolean;
  lock_m?: number;
  lock_signers?: string[];
}

// Strict interfaces for simple-spend validation
export interface ValidatedRecipient {
  count: number;    
  address: string;  
}

export interface ValidatedSimpleSpendParams {
  recipients: ValidatedRecipient[];
  gifts: number[];      
  names: string[][];   
  fee: number;         
}

// Extended interface for UTXO-based spending
export interface ValidatedSimpleSpendParamsWithUTXOs extends ValidatedSimpleSpendParams {
  selectedNotes?: ParsedNote[];
  senderPubkey?: string;
}

function isValidNockchainAddress(address: string): boolean {
  if (!address || typeof address !== 'string') return false;
  
  if (address.length < 150 || address.length > 156) return false;
  
  const base58Regex = /^[123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz]+$/;
  if (!base58Regex.test(address)) return false;
  
  try {
    const decoded = bs58.decode(address);
    
    if (decoded.length < 110 || decoded.length > 115) return false;
    
    return true;
  } catch (error) {
    return false;
  }
}

function sanitizeForBash(input: string): string {
  if (typeof input !== 'string') return '';
  return input
    .replace(/[;|&$`\\'"]/g, '') // Remove dangerous bash characters
    .replace(/\s+/g, ' ')        // Normalize whitespace
    .trim()
    .slice(0, 100);              // Limit length
}

// Parse asset amount from string with dots to number
function parseAssetAmount(assetStr: string): number {
  // Remove dots and parse as number
  return parseFloat(assetStr.replace(/\./g, ''));
}

// Get notes for a specific public key
export async function getNotesByPubkey(pubkey: string): Promise<ParsedNote[]> {
  const command = await createSignedCommand('list-notes-by-pubkey', { pubkey });
  const result = await processSignedCommand(command);
  
  if (!result.success || !result.output) {
    throw new Error('Failed to get notes by pubkey');
  }
  
  return parseNotesOutput(result.output);
}

// Get all notes from wallet
export async function getAllNotes(): Promise<ParsedNote[]> {
  const command = await createSignedCommand('list-notes', {});
  const result = await processSignedCommand(command);
  
  if (!result.success || !result.output) {
    throw new Error('Failed to get notes');
  }
  
  return parseNotesOutput(result.output);
}

// Get wallet balance for a public key
export async function getWalletBalance(pubkey?: string): Promise<number> {
  const notes = pubkey ? await getNotesByPubkey(pubkey) : await getAllNotes();
  return notes.reduce((total, note) => total + note.assets, 0);
}

// Select notes that total at least the required amount
export async function getNotesEqualTo(amountNock: number, pubkey?: string): Promise<{
  selectedNotes: ParsedNote[];
  totalAssets: number;
}> {
  // Calculate required assets (amount * 65536 + 10)
  const requiredAssets = (amountNock * 65536) + 10;
  
  // Get available notes
  const availableNotes = pubkey ? await getNotesByPubkey(pubkey) : await getAllNotes();
  
  // Sort notes by assets descending (use larger notes first)
  availableNotes.sort((a, b) => b.assets - a.assets);
  
  const selectedNotes: ParsedNote[] = [];
  let totalAssets = 0;
  
  // Select notes until we have enough
  for (const note of availableNotes) {
    selectedNotes.push(note);
    totalAssets += note.assets;
    
    if (totalAssets >= requiredAssets) {
      break;
    }
  }
  
  // Check if we have enough
  if (totalAssets < requiredAssets) {
    throw new Error(`Insufficient balance. Required: ${requiredAssets} assets (${amountNock} NOCK), Available: ${totalAssets} assets`);
  }
  
  return { selectedNotes, totalAssets };
}

// Build gifts array based on selected notes and amount to send
function buildGiftsArray(selectedNotes: ParsedNote[], amountNock: number, fee: number): number[] {
  const totalAssetsToSpend = (amountNock * 65536) + (fee * 65536);
  const gifts: number[] = [];
  let remainingToSpend = totalAssetsToSpend;
  
  for (let i = 0; i < selectedNotes.length; i++) {
    const note = selectedNotes[i];
    
    if (i === selectedNotes.length - 1) {
      // Last note: use exactly what's remaining
      gifts.push(remainingToSpend);
    } else if (note.assets <= remainingToSpend) {
      // Use entire note
      gifts.push(note.assets);
      remainingToSpend -= note.assets;
    } else {
      // Use part of the note
      gifts.push(remainingToSpend);
      remainingToSpend = 0;
    }
  }
  
  return gifts;
}

// Modified validation to handle UTXO-based params
async function validateSimpleSpendParamsWithUTXOs(params: any): Promise<ValidatedSimpleSpendParamsWithUTXOs> {
  if (!params || typeof params !== 'object') {
    throw new Error('Invalid params: must be an object');
  }

  const { recipients, gifts, names, fee, amountNock, senderPubkey } = params;

  // Validate recipients
  if (!Array.isArray(recipients) || recipients.length === 0) {
    throw new Error('Invalid recipients: must be non-empty array');
  }

  if (recipients.length > 50) {
    throw new Error('Too many recipients: maximum 50 allowed');
  }

  const validatedRecipients: ValidatedRecipient[] = recipients.map((recipient, index) => {
    if (!recipient || typeof recipient !== 'object') {
      throw new Error(`Invalid recipient at index ${index}: must be object with count and address`);
    }

    const { count, address } = recipient;

    // Validate count
    if (!Number.isInteger(count) || count < 1 || count > 999) {
      throw new Error(`Invalid count at recipient ${index}: must be integer between 1-999`);
    }

    // Validate address
    if (!isValidNockchainAddress(address)) {
      throw new Error(`Invalid address at recipient ${index}: ${address}`);
    }

    return { count, address };
  });

  // Validate fee
  const feeNum = Number(fee);
  if (!Number.isInteger(feeNum) || feeNum < 1 || feeNum > 1000) {
    throw new Error('Invalid fee: must be integer between 1-1000');
  }

  // If amountNock is provided, we need to select UTXOs
  if (amountNock !== undefined) {
    const amountNum = Number(amountNock);
    if (!Number.isFinite(amountNum) || amountNum <= 0) {
      throw new Error('Invalid amountNock: must be positive number');
    }

    // Select UTXOs
    const { selectedNotes, totalAssets } = await getNotesEqualTo(amountNum, senderPubkey);
    
    // Build gifts array based on selected notes
    const calculatedGifts = buildGiftsArray(selectedNotes, amountNum, feeNum);
    
    // Extract names from selected notes
    const calculatedNames = selectedNotes.map(note => [note.first_name, note.last_name]);

    return {
      recipients: validatedRecipients,
      gifts: calculatedGifts,
      names: calculatedNames,
      fee: feeNum,
      selectedNotes,
      senderPubkey
    };
  }

  // Fallback to manual validation if no amountNock provided
  if (!Array.isArray(gifts) || gifts.length === 0) {
    throw new Error('Invalid gifts: must be non-empty array when amountNock not provided');
  }

  const validatedGifts: number[] = gifts.map((gift, index) => {
    const giftNum = Number(gift);
    if (!Number.isFinite(giftNum) || giftNum <= 0) {
      throw new Error(`Invalid gift at index ${index}: must be positive number`);
    }
    return giftNum;
  });

  if (!Array.isArray(names)) {
    throw new Error('Invalid names: must be array when amountNock not provided');
  }

  const validatedNames: string[][] = names.map((nameArray, index) => {
    if (!Array.isArray(nameArray)) {
      throw new Error(`Invalid name at index ${index}: must be array of strings`);
    }
    
    return nameArray.map((name, nameIndex) => {
      if (typeof name !== 'string') {
        throw new Error(`Invalid name at ${index}[${nameIndex}]: must be string`);
      }
      const sanitized = sanitizeForBash(name);
      if (!sanitized) {
        throw new Error(`Invalid name at ${index}[${nameIndex}]: cannot be empty after sanitization`);
      }
      return sanitized;
    });
  });

  return {
    recipients: validatedRecipients,
    gifts: validatedGifts,
    names: validatedNames,
    fee: feeNum
  };
}

// Build safe command string for simple-spend
function buildSimpleSpendCommand(validated: ValidatedSimpleSpendParamsWithUTXOs): string {
  const baseCmd = `nockchain-wallet --nockchain-socket ${WALLET_PATH}`;
  
  // Build names string from actual UTXO names
  const namesStr = validated.names.map(nameArray => 
    nameArray.join(' ')
  ).join(',');
  
  // Build recipients string: "[1 addr1],[2 addr2]"
  const recipientsStr = validated.recipients.map(recipient => 
    `${recipient.count} ${recipient.address}`
  ).join(',');
  
  // Build gifts string: "100,200"
  const giftsStr = validated.gifts.join(',');
  
  return `${baseCmd} simple-spend --names "[${namesStr}]" --recipients "[${recipientsStr}]" --gifts "${giftsStr}" --fee ${validated.fee}`;
}

async function executeCompleteTransaction(simpleSpendCommand: string): Promise<string> {
  try {
    // Ensure drafts directory exists
    await fs.mkdir(DRAFTS_DIR, { recursive: true });
    
    // Step 1: Create draft with simple-spend
    console.log('[STEP 1] Creating draft:', simpleSpendCommand);
    const { stdout: draftOutput, stderr: draftStderr } = await execAsync(simpleSpendCommand, {
      timeout: 30000,
      maxBuffer: 1024 * 1024
    });
    
    if (draftStderr && draftStderr.trim()) {
      console.warn('[DRAFT STDERR]', draftStderr.trim());
    }
    
    // Extract draft filename from output
    const draftMatch = draftOutput.match(/draft[_\w]*\.draft/);
    if (!draftMatch) {
      throw new Error('Could not find draft filename in simple-spend output');
    }
    
    const draftFilename = draftMatch[0];
    const draftPath = path.join(DRAFTS_DIR, draftFilename);
    
    try {
      const signCommand = `nockchain-wallet --nockchain-socket ${WALLET_PATH} sign-tx --draft ${draftPath}`;
      console.log('[STEP 2] Signing draft:', signCommand);
      
      const { stdout: signOutput, stderr: signStderr } = await execAsync(signCommand, {
        timeout: 30000,
        maxBuffer: 1024 * 1024
      });
      
      if (signStderr && signStderr.trim()) {
        console.warn('[SIGN STDERR]', signStderr.trim());
      }
      
      // Step 3: Send the transaction
      const sendCommand = `nockchain-wallet --nockchain-socket ${WALLET_PATH} send-tx --draft ${draftPath}`;
      console.log('[STEP 3] Sending transaction:', sendCommand);
      
      const { stdout: sendOutput, stderr: sendStderr } = await execAsync(sendCommand, {
        timeout: 30000,
        maxBuffer: 1024 * 1024
      });
      
      if (sendStderr && sendStderr.trim()) {
        console.warn('[SEND STDERR]', sendStderr.trim());
      }
      
      // Return combined output
      return `Draft: ${draftOutput.trim()}\nSign: ${signOutput.trim()}\nSend: ${sendOutput.trim()}`;
      
    } finally {
      // Clean up draft file
      try {
        await fs.unlink(draftPath);
        console.log('[CLEANUP] Removed draft file:', draftPath);
      } catch (cleanupError) {
        console.warn('[CLEANUP WARNING] Could not remove draft file:', cleanupError);
      }
    }
    
  } catch (error: any) {
    console.error('[TRANSACTION ERROR]', error);
    throw new Error(`Transaction execution failed: ${error.message}`);
  }
}

// Fixed typo: "port" -> "export"
export async function parseAndBuildCommand(signedCommand: SignedCommand): Promise<string> {
  const { action, params } = signedCommand;
  
  if (action === 'simple-spend') {
    const validated = await validateSimpleSpendParamsWithUTXOs(params);
    return buildSimpleSpendCommand(validated);
  }
  
  if (action === 'list-notes') {
    return `nockchain-wallet --nockchain-socket ${WALLET_PATH} list-notes`;
  }
  
  if (action === 'list-notes-by-pubkey') {
    if (!params.pubkey) {
      throw new Error('list-notes-by-pubkey requires pubkey parameter');
    }
    const sanitizedPubkey = sanitizeForBash(params.pubkey);
    return `nockchain-wallet --nockchain-socket ${WALLET_PATH} list-notes-by-pubkey --pubkey ${sanitizedPubkey}`;
  }
  
  throw new Error(`Unknown action: ${action}. Supported: 'simple-spend', 'list-notes', 'list-notes-by-pubkey'`);
}

// Add missing executeWalletCommand function
export async function executeWalletCommand(command: string): Promise<string> {
  console.log('[EXECUTING]', command);
  
  // Check if this is a simple-spend command (needs 3-step process)
  if (command.includes('simple-spend')) {
    return executeCompleteTransaction(command);
  }
  
  // For other commands, execute directly
  try {
    const { stdout, stderr } = await execAsync(command, {
      timeout: 30000,
      maxBuffer: 1024 * 1024
    });

    if (stderr && stderr.trim()) {
      console.warn('[STDERR]', stderr.trim());
    }

    return stdout.trim();
  } catch (error: any) {
    console.error('[EXEC ERROR]', error);
    throw new Error(`Command execution failed: ${error.message}`);
  }
}

export function parseNotesOutput(output: string): ParsedNote[] {
  const notes: ParsedNote[] = [];
  const noteBlocks = output.split(/(?=details)/g);
  
  for (const block of noteBlocks) {
    if (!block.trim()) continue;
    
    const note: Partial<ParsedNote> = {};
    
    // Parse details section
    const nameMatch = block.match(/name:\s*\[first='([^']+)'\s+last='([^']+)'\]/);
    if (nameMatch) {
      note.first_name = nameMatch[1];
      note.last_name = nameMatch[2];
    }
    
    // Parse assets with dots
    const assetsMatch = block.match(/assets:\s*([\d.]+)/);
    if (assetsMatch) {
      note.assets = parseAssetAmount(assetsMatch[1]);
    }
    
    const sourceMatch = block.match(/source:\s*\[p=\[\[([^\]]+)\s+([^\]]+)\]\]\s+is-coinbase=([^\]]+)\]/);
    if (sourceMatch) {
      note.source_pubkey1 = sourceMatch[1];
      note.source_pubkey2 = sourceMatch[2];
      note.is_coinbase = sourceMatch[3] === '%.y';
    }
    
    // Parse lock section
    const lockMatch = block.match(/m:\s*(\d+)/);
    if (lockMatch) {
      note.lock_m = parseInt(lockMatch[1]);
    }
    
    const signersMatch = block.match(/signers:\s*\[m=\d+\s+pks=<\|([^|]+)\|>\]/);
    if (signersMatch) {
      note.lock_signers = [signersMatch[1]];
    }
    
    // Only add if we have the required fields
    if (note.first_name && note.last_name && note.assets !== undefined) {
      notes.push(note as ParsedNote);
    }
  }
  
  return notes;
}

export function verifySignature(msg: string, sig: string, publicKey: string): boolean {
  try {
    const sigBytes = bs58.decode(sig);
    const msgBytes = new TextEncoder().encode(msg);
    const pubKeyBytes = bs58.decode(publicKey);
    return nacl.sign.detached.verify(msgBytes, sigBytes, pubKeyBytes);
  } catch (error) {
    console.error('Signature verification error:', error);
    return false;
  }
}

export function isAuthorizedKey(publicKey: string): boolean {
  if (AUTHORIZED_PUBLIC_KEYS.length === 0) {
    console.warn('No authorized keys configured - allowing all signatures');
    return true;
  }
  return AUTHORIZED_PUBLIC_KEYS.includes(publicKey);
}

export function isValidTimestamp(timestamp: number, windowMinutes: number = 5): boolean {
  const now = Math.floor(Date.now() / 1000);
  const maxAge = windowMinutes * 60;
  return Math.abs(now - timestamp) <= maxAge;
}

export async function processSignedCommand(request: CommandRequest): Promise<CommandResult> {
  try {
    const { msg, sig, publicKey } = request;

    if (!msg || !sig || !publicKey) {
      return { success: false, error: 'Missing required fields: msg, sig, publicKey' };
    }

    if (!verifySignature(msg, sig, publicKey)) {
      return { success: false, error: 'Invalid signature' };
    }

    if (!isAuthorizedKey(publicKey)) {
      return { success: false, error: 'Unauthorized public key' };
    }

    let signedCommand: SignedCommand;
    try {
      signedCommand = JSON.parse(msg);
    } catch (error) {
      return { success: false, error: 'Invalid command format - must be valid JSON' };
    }

    if (!signedCommand.action || !signedCommand.timestamp) {
      return { success: false, error: 'Command must include action and timestamp' };
    }

    if (!isValidTimestamp(signedCommand.timestamp)) {
      return { success: false, error: 'Command timestamp is too old or too far in the future' };
    }

    const walletCommand = await parseAndBuildCommand(signedCommand);
    const output = await executeWalletCommand(walletCommand);
    
    return {
      success: true,
      output,
      command: signedCommand,
      executedAt: new Date().toISOString()
    };

  } catch (err: any) {
    console.error('Process signed command error:', err);
    return { success: false, error: err.message };
  }
}

export async function createSignedCommand(action: string, params: any, keyPath?: string): Promise<CommandRequest> {
  const signedCommand: SignedCommand = {
    action,
    params: params || {},
    timestamp: Math.floor(Date.now() / 1000),
    nonce: Math.random().toString(36).substr(2, 9)
  };

  const keyPair = loadSigningKey(keyPath || DEFAULT_SIGNING_KEY_PATH);
  const msgBytes = Buffer.from(JSON.stringify(signedCommand, Object.keys(signedCommand).sort()));
  const signedMessage = nacl.sign(msgBytes, keyPair.secretKey);
  const signature = signedMessage.slice(0, 64);

  return {
    msg: JSON.stringify(signedCommand),
    sig: bs58.encode(signature),
    publicKey: bs58.encode(keyPair.publicKey)
  };
}

export function verifyCommandSignature(request: CommandRequest): { valid: boolean; authorized: boolean } {
  const { msg, sig, publicKey } = request;
  
  const isValid = verifySignature(msg, sig, publicKey);
  const isAuthorized = isAuthorizedKey(publicKey);

  return { valid: isValid, authorized: isAuthorized };
}

export const getConfiguration = () => ({
  walletPath: WALLET_PATH,
  signingKeyPath: DEFAULT_SIGNING_KEY_PATH,
  authorizedKeysCount: AUTHORIZED_PUBLIC_KEYS.length,
  supportedActions: ['simple-spend', 'list-notes', 'list-notes-by-pubkey'],
  draftsDirectory: DRAFTS_DIR
});
