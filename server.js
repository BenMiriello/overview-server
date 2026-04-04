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

let dobbyscan = null;
import('dobbyscan').then(m => { dobbyscan = m.default || m; });

// Find the densest cluster of recent strikes using DBSCAN.
// Returns the recency-weighted centroid of the largest cluster.
const CLUSTER_RADIUS_KM = 200;

function getHotspot(windowMs = 5 * 60 * 1000) {
  if (!dobbyscan) return null;
  const cutoff = Date.now() - windowMs;
  const recent = strikes.filter(s => s.timestamp >= cutoff);
  if (recent.length === 0) return null;

  const clusters = dobbyscan(recent, CLUSTER_RADIUS_KM, s => s.lng, s => s.lat);

  if (clusters.length === 0) return null;

  let bestCluster = clusters[0];
  for (const cluster of clusters) {
    if (cluster.length > bestCluster.length) {
      bestCluster = cluster;
    }
  }

  // Recency-weighted centroid within the winning cluster
  let totalWeight = 0;
  let weightedLat = 0;
  let weightedLng = 0;

  for (const s of bestCluster) {
    const age = Date.now() - s.timestamp;
    const weight = 1 - (age / windowMs);
    weightedLat += s.lat * weight;
    weightedLng += s.lng * weight;
    totalWeight += weight;
  }

  return {
    lat: weightedLat / totalWeight,
    lng: weightedLng / totalWeight,
    count: bestCluster.length,
  };
}

// Create HTTP server with API routes
const server = http.createServer((req, res) => {
  if (req.url === '/api/hotspot' && req.method === 'GET') {
    res.writeHead(200, {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
    });
    const hotspot = getHotspot();
    if (hotspot) {
      console.log(`[hotspot] ${hotspot.count} strikes → lat=${hotspot.lat.toFixed(2)}, lng=${hotspot.lng.toFixed(2)}`);
    } else {
      console.log('[hotspot] no recent strikes, returning null');
    }
    res.end(JSON.stringify(hotspot));
    return;
  }

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
  ws.isAlive = true;

  ws.on('pong', () => {
    ws.isAlive = true;
  });

  ws.on('message', (message) => {
    try {
      const data = JSON.parse(message);
      if (data.type === 'ping') {
        ws.send(JSON.stringify({ type: 'pong' }));
      }
    } catch (e) {
      // Ignore non-JSON messages
    }
  });

  ws.on('close', () => {
    console.log('Client disconnected');
  });
});

// Ping all clients every 20s; terminate unresponsive ones
const PING_INTERVAL = 20000;
const pingInterval = setInterval(() => {
  wss.clients.forEach(client => {
    if (!client.isAlive) {
      verbose && console.log('Terminating unresponsive client');
      return client.terminate();
    }
    client.isAlive = false;
    client.ping();
  });
}, PING_INTERVAL);

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

  clearInterval(pingInterval);

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
