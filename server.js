require('dotenv').config();

const args = process.argv.slice(2);
if (args.includes('--verbose')) {
  process.env.VERBOSE = 'true';
}

const http = require('http');
const fs = require('fs');
const WebSocket = require('ws');
const { captureBlitzortungData } = require('./lightning_data');
const { verbose } = require('./utils');
const cloudMirror = require('./cloudMirror');

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
    if (cluster.length > bestCluster.length) bestCluster = cluster;
  }

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

function haversineDistance(lat1, lng1, lat2, lng2) {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLng = (lng2 - lng1) * Math.PI / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// Create HTTP server with API routes
const CLOUDS_ROUTE_RE = /^\/api\/clouds\/([a-z0-9]+)(?:\?(.*))?$/;
const server = http.createServer((req, res) => {
  const cloudsMatch = req.url.match(CLOUDS_ROUTE_RE);
  if (cloudsMatch && req.method === 'GET') {
    const resKey = cloudsMatch[1];
    const params = new URLSearchParams(cloudsMatch[2] || '');
    const variant = params.get('previous') === '1' ? 'previous' : 'current';
    const file = cloudMirror.getCachedFile(resKey, variant)
      || (variant === 'current' ? cloudMirror.getCachedFile(resKey, 'previous') : null);
    if (!file) {
      res.writeHead(503, { 'Access-Control-Allow-Origin': '*' });
      res.end('Cloud mirror cache empty');
      return;
    }
    const stat = fs.statSync(file);
    res.writeHead(200, {
      'Content-Type': 'image/png',
      'Content-Length': stat.size,
      'Cache-Control': 'public, max-age=1800',
      'Last-Modified': stat.mtime.toUTCString(),
      'Access-Control-Allow-Origin': '*',
      'X-Cloud-Attribution': cloudMirror.ATTRIBUTION,
    });
    fs.createReadStream(file).pipe(res);
    return;
  }

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

const wss = new WebSocket.Server({ server });

const strikes = [];
const MAX_STRIKES = 10000;
let isShuttingDown = false;

// Tracked hotspot for change detection
let currentHotspot = null;
const HOTSPOT_MIN_DISTANCE_KM = 150;
const HOTSPOT_INTERVAL_MS = 2 * 60 * 1000;

function broadcastToClients(data) {
  const payload = JSON.stringify(data);
  wss.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(payload);
    }
  });
}

function updateAndBroadcastHotspot() {
  const hotspot = getHotspot();
  if (!hotspot) return;

  let shouldBroadcast = false;
  if (!currentHotspot) {
    shouldBroadcast = true;
  } else {
    const moved = haversineDistance(currentHotspot.lat, currentHotspot.lng, hotspot.lat, hotspot.lng) > HOTSPOT_MIN_DISTANCE_KM;
    const surged = hotspot.count > currentHotspot.count * 1.5;
    shouldBroadcast = moved || surged;
  }

  if (shouldBroadcast) {
    currentHotspot = hotspot;
    console.log(`[hotspot] broadcasting: ${hotspot.count} strikes at lat=${hotspot.lat.toFixed(2)}, lng=${hotspot.lng.toFixed(2)}`);
    broadcastToClients({ type: 'hotspot', lat: hotspot.lat, lng: hotspot.lng, count: hotspot.count });
  }
}

wss.on('connection', (ws) => {
  console.log('Client connected');
  ws.isAlive = true;

  // Send current hotspot immediately so new clients don't have to wait
  if (currentHotspot) {
    ws.send(JSON.stringify({ type: 'hotspot', ...currentHotspot }));
  }

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

function handleNewStrike(strike) {
  strikes.unshift(strike);
  if (strikes.length > MAX_STRIKES) {
    strikes.pop();
  }
  broadcastToClients(strike);
}

const PORT = process.env.PORT || 3001;
const httpServer = server.listen(PORT, () => {
  console.log(`Lightning relay server running on port ${PORT}`);
  console.log(`Verbose mode: ${verbose ? 'ENABLED' : 'DISABLED'}`);

  const capture = captureBlitzortungData({
    onStrikeDetected: handleNewStrike,
    getIsShuttingDown: () => isShuttingDown,
  });

  cloudMirror.start().catch(err => console.error('[cloudMirror] start failed:', err));

  // Broadcast hotspot updates every 2 minutes
  const hotspotInterval = setInterval(updateAndBroadcastHotspot, HOTSPOT_INTERVAL_MS);

  // Extend shutdown to stop capture and hotspot interval
  const originalShutdown = shutdown;
  global._captureStop = capture.stop;
  global._hotspotInterval = hotspotInterval;
});

function shutdown() {
  if (isShuttingDown) {
    console.log('Shutdown already in progress');
    return;
  }

  isShuttingDown = true;
  console.log('Shutting down server...');

  clearInterval(pingInterval);

  if (global._captureStop) global._captureStop();
  if (global._hotspotInterval) clearInterval(global._hotspotInterval);
  cloudMirror.stop();

  console.log('Closing WebSocket server...');
  wss.close(() => {
    console.log('WebSocket server closed');

    console.log('Closing HTTP server...');
    httpServer.close(() => {
      console.log('HTTP server closed');
      process.exit(0);
    });
  });

  setTimeout(() => {
    console.log('Forcing exit after timeout');
    process.exit(1);
  }, 2000);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
