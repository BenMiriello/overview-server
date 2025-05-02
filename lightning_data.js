const puppeteer = require('puppeteer');
const { decode } = require('./utils');

/**
 * Captures lightning strike data from Blitzortung.org using Puppeteer
 * @param {Object} options Configuration options
 * @param {Function} options.onStrikeDetected Callback for when a strike is detected
 * @param {boolean} options.isShuttingDown Reference to shutdown flag
 * @returns {Promise<void>}
 */
async function captureBlitzortungData({ onStrikeDetected, isShuttingDown }) {
  console.log('Launching browser...');
  
  // Launch a headless browser
  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });
  
  try {
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
        
        try {
          const jsonData = JSON.parse(decodedData);
          console.log('Parsed JSON data:', JSON.stringify(jsonData).substring(0, 150));
          
          // Extract coordinates and other useful data
          if (jsonData.lat !== undefined && jsonData.lon !== undefined) {
            const strike = {
              id: `strike-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
              timestamp: Date.now(),
              lat: +jsonData['lat'],
              lng: +jsonData['lon'],
            };

            console.log('Extracted strike data:', strike);

            // Notify the caller about the new strike
            if (typeof onStrikeDetected === 'function') {
              onStrikeDetected(strike);
            }
          }
        } catch (parseErr) {
          console.error('JSON parse error:', parseErr.message);
          // Sometimes the data might not be valid JSON despite decoding
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
      setTimeout(() => captureBlitzortungData({ onStrikeDetected, isShuttingDown }), 10000);
    }
  }
}

module.exports = { captureBlitzortungData };
