require('dotenv').config();

// Parse command line arguments
const args = process.argv.slice(2);
if (args.includes('--verbose')) {
  process.env.VERBOSE = 'true';
}

const http = require('http');
const WebSocket = require('ws');
const { captureBlitzortungData } = require('./lightning_data');
const { verbose } = require('./utils');

// Create a simple HTTP server
const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('Lightning relay server is running\n');
});

// Create a WebSocket server for clients to connect to
const wss = new WebSocket.Server({ server });

// Store captured strikes
const strikes = [];
const MAX_STRIKES = 10000;
let isShuttingDown = false;

// Function to broadcast data to all connected clients
function broadcastToClients(data) {
  wss.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(JSON.stringify(data));
    }
  });
}

// Handle client connections
wss.on('connection', (ws) => {
  console.log('Client connected');

  // Note: We no longer send initial strikes to the client
  // Starting with 0 strikes and only showing live ones as they come in

  ws.on('close', () => {
    console.log('Client disconnected');
  });
});

// Handler for new strike data
function handleNewStrike(strike) {
  // Store the strike
  strikes.unshift(strike);
  if (strikes.length > MAX_STRIKES) {
    strikes.pop();
  }

  // Forward to all connected clients
  broadcastToClients(strike);
}

// Start the server
const PORT = process.env.PORT || 3001;
const httpServer = server.listen(PORT, () => {
  console.log(`Lightning relay server running on port ${PORT}`);
  console.log(`Verbose mode: ${verbose ? 'ENABLED' : 'DISABLED'}`);

  // Start capturing WebSocket data
  captureBlitzortungData({ 
    onStrikeDetected: handleNewStrike,
    isShuttingDown
  }).catch(err => {
    console.error('Failed to start WebSocket capture:', err);
  });
});

// Handle graceful shutdown
function shutdown() {
  if (isShuttingDown) {
    console.log('Shutdown already in progress');
    return;
  }

  isShuttingDown = true;
  console.log('Shutting down server...');

  // Close WebSocket server
  console.log('Closing WebSocket server...');
  wss.close(() => {
    console.log('WebSocket server closed');

    // Close HTTP server
    console.log('Closing HTTP server...');
    httpServer.close(() => {
      console.log('HTTP server closed');
      console.log('Shutdown complete');
      process.exit(0);
    });
  });

  // Force exit after timeout
  setTimeout(() => {
    console.log('Forcing exit after timeout');
    process.exit(1);
  }, 2000);
}

// Register shutdown handlers
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
