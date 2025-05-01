// puppeteer-decoder.js
const puppeteer = require('puppeteer');
const WebSocket = require('ws');
const http = require('http');

// Create a simple HTTP server
const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('Lightning relay server is running\n');
});

// Create a WebSocket server for clients to connect to
const wss = new WebSocket.Server({ server });

// Store captured strikes
const strikes = [];
const MAX_STRIKES = 100;
let isShuttingDown = false;

// Copied from Blitzortung.org index.js - LZW decoding function
function decode(message) {
  try {
    let dict = {};
    let data = message.split('');
    let currChar = data[0];
    let oldPhrase = currChar;
    let out = [currChar];
    let code = 256;
    let phrase;
    for (let i = 1; i < data.length; i++) {
      let currCode = data[i].charCodeAt(0);
      
      if (currCode < 256) {
        phrase = data[i];
      } else {
        phrase = dict[currCode] ? dict[currCode] : (oldPhrase + currChar);
      }
      
      out.push(phrase);
      currChar = phrase.charAt(0);
      dict[code] = oldPhrase + currChar;
      code++;
      oldPhrase = phrase;
    }
    
    return out.join('');
  } catch (error) {
    console.error('Error in decode function:', error);
    return message; // Return original message if decoding fails
  }
}

// Main function to capture WebSocket data using Puppeteer
async function captureBlitzortungData() {
  console.log('Launching browser...');
  
  // Launch a headless browser
  const browser = await puppeteer.launch({
    headless: 'new', // Use new headless mode
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });
  
  try {
    // Create a new page
    const page = await browser.newPage();
    
    // Setup CDP session to capture WebSocket traffic
    const client = await page.target().createCDPSession();
    await client.send('Network.enable');
    
    // Setup listeners for WebSocket events
    client.on('Network.webSocketCreated', ({requestId, url}) => {
      console.log('WebSocket Created:', requestId, url);
    });
    
    client.on('Network.webSocketClosed', ({requestId, timestamp}) => {
      console.log('WebSocket Closed:', requestId, timestamp);
    });
    
    // Listen for WebSocket messages sent from browser to server
    client.on('Network.webSocketFrameSent', ({requestId, timestamp, response}) => {
      console.log('WebSocket Frame Sent:', requestId, timestamp);
      console.log('Payload:', response.payloadData);
    });
    
    // Listen for WebSocket messages received from server
    client.on('Network.webSocketFrameReceived', ({requestId, timestamp, response}) => {
      console.log('WebSocket Frame Received:', requestId, timestamp);
      console.log('Payload (First 100 chars):', response.payloadData.substring(0, 100));
      
      try {
        // Decode the data using the LZW decode function from Blitzortung
        const decodedData = decode(response.payloadData);
        console.log('Decoded data (First 150 chars):', decodedData.substring(0, 150));
        
        // Try to parse as JSON
        try {
          const jsonData = JSON.parse(decodedData);
          console.log('Parsed JSON data:', JSON.stringify(jsonData).substring(0, 150));
          
          // Extract coordinates and other useful data
          if (jsonData.lat !== undefined && jsonData.lon !== undefined) {
            const strike = {
              id: `strike-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
              timestamp: Date.now(),
              ...jsonData
            };
            
            console.log('Extracted strike data:', strike);
            
            // Store the strike
            strikes.unshift(strike);
            if (strikes.length > MAX_STRIKES) {
              strikes.pop();
            }
            
            // Forward to all connected clients
            broadcastToClients(strike);
          }
        } catch (parseErr) {
          console.error('JSON parse error:', parseErr.message);
          // Sometimes the data might not be valid JSON despite decoding
          // In real production code, we would handle this better
        }
      } catch (decodeErr) {
        console.error('Error decoding data:', decodeErr);
      }
    });
    
    // Navigate to the Blitzortung map page
    console.log('Navigating to Blitzortung map...');
    await page.goto('https://map.blitzortung.org/', { 
      waitUntil: 'networkidle2',
      timeout: 60000 
    });
    
    console.log('Page loaded, waiting for WebSocket connections...');
    
    // Keep the page open to continue receiving WebSocket data
    // The process will stay alive until manually terminated
    
  } catch (error) {
    console.error('Error in Puppeteer session:', error);
    await browser.close();
    
    // Try to reconnect after a delay if not shutting down
    if (!isShuttingDown) {
      console.log('Reconnecting in 10 seconds...');
      setTimeout(captureBlitzortungData, 10000);
    }
  }
}

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
  
  // Send recent strikes to the new client
  if (strikes.length > 0) {
    ws.send(JSON.stringify({
      type: 'initial',
      strikes: strikes
    }));
  }
  
  ws.on('close', () => {
    console.log('Client disconnected');
  });
});

// Start the server
const PORT = process.env.PORT || 3001;
const httpServer = server.listen(PORT, () => {
  console.log(`Lightning relay server running on port ${PORT}`);
  
  // Start capturing WebSocket data
  captureBlitzortungData().catch(err => {
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
