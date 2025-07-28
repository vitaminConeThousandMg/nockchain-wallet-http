import express from 'express';
import fetch from 'node-fetch';
import { 
  processSignedCommand, 
  createSignedCommand, 
  verifyCommandSignature, 
  getConfiguration,
  CommandRequest,
  parseNotesOutput  
} from './sendor';

// --

interface SwapTransaction {
  swap_id: string;
  recipient: string;
  amount: number;
  fee: number;
  initial_block_height: number;
  status: 'pending' | 'unconfirmed' | 'sent-pending' | 'sent-confirmed' | 'failed';
  created_at: number;
  updated_at: number;
  notes_before?: any[];
  change_utxo?: any;
  tx_id?: string;
  confirmed_block_height?: number;
  error?: string;
}

// In-memory store with cleanup
const swapTransactions = new Map<string, SwapTransaction>();

// Cleanup old transactions every hour
setInterval(() => {
  const oneDayAgo = Date.now() - (24 * 60 * 60 * 1000);
  for (const [id, swap] of swapTransactions.entries()) {
    if (swap.updated_at < oneDayAgo && 
        (swap.status === 'confirmed' || swap.status === 'failed')) {
      swapTransactions.delete(id);
    }
  }
}, 60 * 60 * 1000);

// --

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;
const RPC_URL = "https://nockblocks.com/rpc";

// --

export class MaintenanceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MaintenanceError";
  }
}

export class RPCError extends Error {
  code: number;
  
  constructor(code: number, message: string) {
    super(message);
    this.name = "RPCError";
    this.code = code;
  }
}


export async function rpcCall<T>(method: string, params: any[] = []): Promise<T> {
  try {
    const response = await fetch(RPC_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Accept": "application/json",
        "Origin": "https://nockblocks.com",
        "Referer": "https://nockblocks.com/"
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        method,
        params,
        id: `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`
      })
    });

    const data = await response.json();

    if (!response.ok) {
      throw new RPCError(response.status, response.statusText);
    }

    if (data.error) {
      const code = data.error.code;
      const message = data.error.message;
      
      if (code === -32000 && message.includes("Try again")) {
        throw new MaintenanceError(message);
      }
      
      throw new RPCError(code, message);
    }

    return data.result;
  } catch (error) {
    if (error instanceof MaintenanceError || error instanceof RPCError) {
      throw error;
    }
    
    console.error("RPC Call Failed:", { method, params, error: error.message });
    throw new Error(`Network error: ${error.message}`);
  }
}

// -- endpoints

export const blockchainApi = {
  getTip: () => rpcCall("getTip"),
  getHeight: () => rpcCall("getHeight"),
  getBlockByHeight: (height: number) => rpcCall("getBlockByHeight", [{ height }]),
  getBlockByHash: (hash: string) => rpcCall("getBlockByHash", [{ hash }]),
  getTransactionById: (id: string) => rpcCall("getTransactionById", [{ id }]),
  getAllTransactions: (limit = 100, offset = 0) => rpcCall("getAllTransactions", [{ limit, offset }]),
  getTransactionsByBlockHeight: (height: number) => rpcCall("getTransactionsByBlockHeight", [{ height }]),
  isMainnet: () => rpcCall("isMainnet"),
  getMiningPubkeys: () => rpcCall("getMiningPubkeys"),
  getNetworkHealthSummary: (height?: number | null) => 
    rpcCall("getNetworkHealthSummary", height ? [{ height }] : [])
};

// API 

app.post('/send', async (req, res) => {
  try {
    const commandRequest: CommandRequest = req.body;
    const result = await processSignedCommand(commandRequest);
    
    if (result.success) {
      res.json(result);
    } else {
      // Determine appropriate status code based on error
      let status = 400;
      if (result.error?.includes('Invalid signature')) status = 401;
      if (result.error?.includes('Unauthorized')) status = 403;
      
      res.status(status).json(result);
    }
  } catch (err: any) {
    console.error('Send endpoint error:', err);
    res.status(500).json({ 
      success: false, 
      error: 'Internal server error' 
    });
  }
});


app.post('/sign', async (req, res) => {
  try {
    const { action, params, keyPath } = req.body;

    if (!action) {
      return res.status(400).json({ 
        success: false, 
        error: 'Missing required field: action' 
      });
    }

    const signedCommand = await createSignedCommand(action, params, keyPath);
    
    res.json({ 
      success: true, 
      signedCommand 
    });

  } catch (err: any) {
    res.status(400).json({ success: false, error: err.message });
  }
});


app.post('/verify', async (req, res) => {
  try {
    const commandRequest: CommandRequest = req.body;

    if (!commandRequest.msg || !commandRequest.sig || !commandRequest.publicKey) {
      return res.status(400).json({ 
        success: false, 
        error: 'Missing required fields: msg, sig, publicKey' 
      });
    }

    const result = verifyCommandSignature(commandRequest);

    res.json({ 
      success: true, 
      ...result
    });

  } catch (err: any) {
    res.status(400).json({ success: false, error: err.message });
  }
});


app.get('/blockchain/tip', async (req, res) => {
  try {
    const tip = await blockchainApi.getTip();
    res.json({ success: true, data: tip });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/blockchain/height', async (req, res) => {
  try {
    const height = await blockchainApi.getHeight();
    res.json({ success: true, data: height });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/blockchain/transactions/latest', async (req, res) => {
  try {
    const limit = parseInt(req.query.limit as string) || 10;
    const transactions = await blockchainApi.getAllTransactions(limit, 0);
    res.json({ success: true, data: transactions });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/blockchain/block', async (req, res) => {
  try {
    if (req.query.height) {
      const block = await blockchainApi.getBlockByHeight(parseInt(req.query.height as string));
      res.json({ success: true, data: block });
    } else if (req.query.hash) {
      const block = await blockchainApi.getBlockByHash(req.query.hash as string);
      res.json({ success: true, data: block });
    } else {
      res.status(400).json({ success: false, error: 'Height or hash required' });
    }
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/blockchain/transaction', async (req, res) => {
  try {
    if (req.query.id) {
      const tx = await blockchainApi.getTransactionById(req.query.id as string);
      res.json({ success: true, data: tx });
    } else {
      res.status(400).json({ success: false, error: 'Transaction ID required' });
    }
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});


app.get('/', (req, res) => {
  const config = getConfiguration();
  
  res.json({
    name: 'Nockchain Signed Command API',
    version: '1.0.0',
    endpoints: {
      'POST /send': 'Send any signed command (main endpoint)',
      'POST /sign': 'Create signed command (development)',
      'POST /verify': 'Verify signature',
      'GET /blockchain/*': 'Blockchain queries (read-only)',
      'GET /': 'This documentation'
    },
    supportedActions: config.supportedActions,
    commandFormat: {
      action: 'simple-spend',
      params: {
        gifts: [100, 200],
        recipients: [
          { count: 1, address: 'address1' },
          { count: 2, address: 'address2' }
        ],
        names: [['first1', 'last1'], ['first2', 'last2']],
        fee: 10
      },
      timestamp: 'unix_timestamp',
      nonce: 'random_string'
    },
    blockchain: {
      'GET /blockchain/tip': 'Get blockchain tip',
      'GET /blockchain/height': 'Get current height',
      'GET /blockchain/transactions/latest?limit=N': 'Get latest transactions',
      'GET /blockchain/block?height=N': 'Get block by height',
      'GET /blockchain/block?hash=H': 'Get block by hash',
      'GET /blockchain/transaction?id=ID': 'Get transaction by ID'
    },
    usage: {
      example: 'curl -X POST http://localhost:3000/send -d \'{"msg":"...","sig":"...","publicKey":"..."}\'',
      note: 'All commands must be cryptographically signed with Ed25519'
    }
  });
});

//--

app.get('/health', (req, res) => {
  const config = getConfiguration();
  
  res.json({ 
    status: 'ok', 
    timestamp: new Date().toISOString(),
    walletPath: config.walletPath,
    authorizedKeys: config.authorizedKeysCount,
    uptime: process.uptime()
  });
});

// --

app.post('/swap/initiate', async (req, res) => {
  try {
    const { swap_id, recipient, amount, fee = 10, msg, sig, publicKey } = req.body;

    if (!swap_id || !recipient || !amount || !msg || !sig || !publicKey) {
      return res.status(400).json({
        success: false,
        error: 'Missing required fields: swap_id, recipient, amount, msg, sig, publicKey'
      });
    }

    if (swapTransactions.has(swap_id)) {
      return res.status(409).json({
        success: false,
        error: 'Swap ID already exists'
      });
    }

//block height
    const heightData = await blockchainApi.getHeight();
    const currentHeight = typeof heightData === 'object' && 'height' in heightData 
      ? heightData.height 
      : heightData;

// notes
    const notesCommand = await createSignedCommand('list-notes', {});
    const notesResult = await processSignedCommand(notesCommand);
    const notesBefore = notesResult.success && notesResult.output 
      ? parseNotesOutput(notesResult.output) 
      : [];

    const swapTx: SwapTransaction = {
      swap_id,
      recipient,
      amount: Number(amount),
      fee: Number(fee),
      initial_block_height: currentHeight,
      status: 'pending',
      created_at: Date.now(),
      updated_at: Date.now(),
      notes_before: notesBefore
    };

    swapTransactions.set(swap_id, swapTx);

    const spendParams = {
      recipients: [{ count: 1, address: recipient }],
      gifts: [Number(amount)],
      names: [['swap', 'bridge']],
      fee: Number(fee)
    };

    const parsedCommand = JSON.parse(msg);
    parsedCommand.action = 'simple-spend';
    parsedCommand.params = spendParams;

    const updatedCommandRequest: CommandRequest = {
      msg: JSON.stringify(parsedCommand),
      sig,
      publicKey
    };

    const sendResult = await processSignedCommand(updatedCommandRequest);

    if (!sendResult.success) {
      swapTx.status = 'failed';
      swapTx.error = sendResult.error;
      swapTx.updated_at = Date.now();
      
      return res.status(400).json({
        success: false,
        swap_id,
        status: 'failed',
        error: sendResult.error
      });
    }

    res.json({
      success: true,
      swap_id,
      status: swapTx.status,
      initial_block_height: currentHeight,
      created_at: swapTx.created_at
    });

  } catch (err: any) {
    console.error('Swap initiate error:', err);
    res.status(500).json({
      success: false,
      error: err.message
    });
  }
});

// GET /swap/status/:swap_id - Check swap status
app.get('/swap/status/:swap_id', async (req, res) => {
  try {
    const { swap_id } = req.params;
    const swap = swapTransactions.get(swap_id);

    if (!swap) {
      return res.status(404).json({
        success: false,
        error: 'Swap not found'
      });
    }

    // Check for status updates based on current state
    if (swap.status === 'pending' || swap.status === 'unconfirmed') {
      try {
        // First check if we have new UTXOs (notes)
        const notesCommand = await createSignedCommand('list-notes', {});
        const notesResult = await processSignedCommand(notesCommand);
        
        if (notesResult.success && notesResult.output) {
          const currentNotes = parseNotesOutput(notesResult.output);
          
          // Check if old notes are spent (transaction was sent)
          const oldNotesStillExist = swap.notes_before?.every(oldNote => 
            currentNotes.some(currentNote => 
              currentNote.assets === oldNote.assets &&
              currentNote.first_name === oldNote.first_name &&
              currentNote.last_name === oldNote.last_name
            )
          );
          
          if (swap.notes_before && swap.notes_before.length > 0 && !oldNotesStillExist) {
            // Transaction was sent - update to sent-pending
            swap.status = 'sent-pending';
            swap.updated_at = Date.now();
            
            // Store any new notes (change UTXOs)
            const newNotes = currentNotes.filter(note => {
              return !swap.notes_before?.some(oldNote => 
                oldNote.assets === note.assets && 
                oldNote.first_name === note.first_name &&
                oldNote.last_name === note.last_name
              );
            });
            
            if (newNotes.length > 0) {
              swap.change_utxo = newNotes;
            }
          }
        }
      } catch (err) {
        console.error('Error checking notes:', err);
      }
    }

    // If sent-pending, check blockchain for confirmation
    if (swap.status === 'sent-pending') {
      try {
        const heightData = await blockchainApi.getHeight();
        const currentHeight = typeof heightData === 'object' && 'height' in heightData 
          ? heightData.height 
          : heightData;
        
        const blocksSince = currentHeight - swap.initial_block_height;
        
        // Check current and previous block for the transaction
        const blocksToCheck = [currentHeight];
        if (currentHeight > swap.initial_block_height) {
          blocksToCheck.push(currentHeight - 1);
        }
        
        for (const blockHeight of blocksToCheck) {
          try {
            const transactions = await blockchainApi.getTransactionsByBlockHeight(blockHeight);
            
            // Look for exact match with all our swap details
            const matchingTx = transactions.find((tx: any) => {
              // Check if transaction has outputs matching our swap
              if (tx.outputs && Array.isArray(tx.outputs)) {
                const hasRecipient = tx.outputs.some((output: any) => 
                  output.address === swap.recipient && 
                  output.amount === swap.amount
                );
                
                // Also check if sender/names match if available in tx data
                // This depends on nockchain transaction structure
                if (hasRecipient) {
                  // Additional validation could go here
                  return true;
                }
              }
              
              return false;
            });
            
            if (matchingTx) {
              swap.status = 'sent-confirmed';
              swap.tx_id = matchingTx.id;
              swap.confirmed_block_height = blockHeight;
              swap.updated_at = Date.now();
              break;
            }
          } catch (err) {
            console.error(`Error checking block ${blockHeight}:`, err);
          }
        }
        
        // Check for timeout
        if (blocksSince >= 3 && swap.status !== 'sent-confirmed') {
          swap.status = 'failed';
          swap.error = 'Transaction not confirmed after 3 blocks';
          swap.updated_at = Date.now();
        }
      } catch (err) {
        console.error('Error checking blockchain:', err);
      }
    }

    res.json({
      success: true,
      swap_id,
      status: swap.status,
      recipient: swap.recipient,
      amount: swap.amount,
      fee: swap.fee,
      initial_block_height: swap.initial_block_height,
      created_at: swap.created_at,
      updated_at: swap.updated_at,
      tx_id: swap.tx_id,
      confirmed_block_height: swap.confirmed_block_height,
      change_utxo: swap.change_utxo,
      error: swap.error
    });

  } catch (err: any) {
    res.status(500).json({
      success: false,
      error: err.message
    });
  }
});

//--

// POST /wallet/list-notes get receipts/utxo of sent and locally confirmed tx
app.post('/wallet/list-notes', async (req, res) => {
  try {
    const { msg, sig, publicKey, pubkey } = req.body;

    if (!msg || !sig || !publicKey) {
      return res.status(400).json({
        success: false,
        error: 'Missing required fields: msg, sig, publicKey'
      });
    }

    const commandRequest: CommandRequest = { msg, sig, publicKey };
    
    // Parse the command and update action
    const parsedCommand = JSON.parse(msg);
    
    if (pubkey) {
      parsedCommand.action = 'list-notes-by-pubkey';
      parsedCommand.params = { pubkey };
    } else {
      parsedCommand.action = 'list-notes';
      parsedCommand.params = {};
    }

    // Create updated command request
    const updatedRequest: CommandRequest = {
      msg: JSON.stringify(parsedCommand),
      sig,
      publicKey
    };

    const result = await processSignedCommand(updatedRequest);

    if (!result.success) {
      return res.status(400).json({
        success: false,
        error: result.error
      });
    }

    // Parse the notes output
    const notes = parseNotesOutput(result.output || '');

    res.json({
      success: true,
      notes,
      count: notes.length
    });

  } catch (err: any) {
    res.status(500).json({
      success: false,
      error: err.message
    });
  }
});

// GET /swap/pending - Get all pending swaps
app.get('/swap/pending', async (req, res) => {
  try {
    const pendingSwaps = Array.from(swapTransactions.values())
      .filter(swap => swap.status === 'pending' || swap.status === 'spent_pending')
      .map(swap => ({
        swap_id: swap.swap_id,
        status: swap.status,
        recipient: swap.recipient,
        amount: swap.amount,
        created_at: swap.created_at,
        updated_at: swap.updated_at,
        initial_block_height: swap.initial_block_height
      }));

    res.json({
      success: true,
      count: pendingSwaps.length,
      swaps: pendingSwaps
    });

  } catch (err: any) {
    res.status(500).json({
      success: false,
      error: err.message
    });
  }
});

// Add helper functions at the bottom before export:

// Export for monitoring services
export function getSwapTransaction(swap_id: string): SwapTransaction | undefined {
  return swapTransactions.get(swap_id);
}

export function updateSwapStatus(
  swap_id: string, 
  status: SwapTransaction['status'],
  updates?: Partial<SwapTransaction>
): boolean {
  const swap = swapTransactions.get(swap_id);
  if (!swap) return false;
  
  swap.status = status;
  swap.updated_at = Date.now();
  if (updates) Object.assign(swap, updates);
  
  return true;
}

export function getPendingSwaps(): SwapTransaction[] {
  return Array.from(swapTransactions.values())
    .filter(s => s.status === 'pending' || s.status === 'spent_pending');
}

// Import parseNotesOutput from sendor
import { parseNotesOutput } from './sendor';
app.use((err: any, req: express.Request, res: express.Response, next: express.NextFunction) => {
  console.error('Unhandled error:', err);
  res.status(500).json({ 
    success: false, 
    error: 'Internal server error' 
  });
});


app.use((req, res) => {
  res.status(404).json({ 
    success: false, 
    error: 'Endpoint not found' 
  });
});


if (require.main === module) {
  const config = getConfiguration();
  
  app.listen(PORT, () => {
    console.log(`Nockchain API server running on port ${PORT}`);
    console.log(`Wallet socket: ${config.walletPath}`);
    console.log(`Authorized keys: ${config.authorizedKeysCount || 'None (allowing all)'}`);
    console.log(`Supported actions: ${config.supportedActions.join(', ')}`);
    console.log(`\nEndpoints:`);
    console.log(`  POST /send   - Execute signed commands`);
    console.log(`  POST /sign   - Create signed commands (dev)`);
    console.log(`  POST /verify - Verify signatures`);
    console.log(`  GET  /blockchain/* - Blockchain queries`);
    console.log(`  GET  /       - API documentation`);
  });
}

export default app;
