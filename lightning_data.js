const puppeteer = require('puppeteer');
const { decode, logStreamData, verbose } = require('./utils');

// How long without a strike before the watchdog assumes the WS is dead
const WATCHDOG_SILENCE_MS = 2 * 60 * 1000;
const WATCHDOG_INTERVAL_MS = 30 * 1000;

/**
 * Captures lightning strike data from Blitzortung.org using Puppeteer.
 * Automatically restarts when the upstream WebSocket closes or goes silent.
 *
 * @param {Object} options
 * @param {Function} options.onStrikeDetected - Called with each parsed strike
 * @param {Function} options.getIsShuttingDown - Returns true when server is shutting down
 * @returns {{ stop: () => void }}
 */
function captureBlitzortungData({ onStrikeDetected, getIsShuttingDown }) {
  let stopped = false;
  let currentBrowser = null;
  let watchdogInterval = null;
  let restartTimeout = null;

  async function start() {
    if (stopped) return;

    console.log('Launching virtual browser...');
    let browser;
    try {
      browser = await puppeteer.launch({
        headless: 'new',
        args: ['--no-sandbox', '--disable-setuid-sandbox'],
      });
    } catch (err) {
      console.error('Failed to launch virtual browser:', err.message);
      scheduleRestart(10_000);
      return;
    }

    currentBrowser = browser;
    let lastStrikeTime = Date.now();
    let wsOpenCount = 0;

    // Watchdog: restart if no strikes arrive for WATCHDOG_SILENCE_MS
    clearInterval(watchdogInterval);
    watchdogInterval = setInterval(() => {
      if (stopped) return;
      // Only enforce silence threshold once we've seen at least one WS open
      if (wsOpenCount > 0 && Date.now() - lastStrikeTime > WATCHDOG_SILENCE_MS) {
        console.warn('[watchdog] No strikes for 2 min — restarting capture');
        closeAndRestart(browser, 0);
      }
    }, WATCHDOG_INTERVAL_MS);

    try {
      const page = await browser.newPage();
      const client = await page.target().createCDPSession();
      await client.send('Network.enable');

      client.on('Network.webSocketCreated', ({ requestId, url }) => {
        wsOpenCount++;
        console.log('[blitzortung] WebSocket opened:', requestId, url);
        lastStrikeTime = Date.now(); // reset silence timer on new WS
      });

      client.on('Network.webSocketClosed', ({ requestId }) => {
        console.warn('[blitzortung] WebSocket closed:', requestId, '— scheduling restart');
        closeAndRestart(browser, 10_000);
      });

      client.on('Network.webSocketFrameReceived', ({ requestId, timestamp, response }) => {
        if (logStreamData && verbose) {
          console.log('WebSocket Frame Received:', requestId, timestamp);
          console.log('Payload (First 100 chars):', response.payloadData.substring(0, 100));
        }

        try {
          const decodedData = decode(response.payloadData);
          const jsonData = JSON.parse(decodedData);

          if (jsonData.lat !== undefined && jsonData.lon !== undefined) {
            lastStrikeTime = Date.now();

            const strike = {
              id: `strike-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
              timestamp: Date.now(),
              lat: +jsonData['lat'],
              lng: +jsonData['lon'],
            };

            if (logStreamData && verbose) {
              console.log('Extracted strike data:', strike);
            } else if (logStreamData) {
              console.log('Extracted strike data:', JSON.stringify(strike));
            }

            if (typeof onStrikeDetected === 'function') {
              onStrikeDetected(strike);
            }
          }
        } catch (err) {
          // Decode or parse errors are expected for non-strike frames
        }
      });

      console.log('Navigating to Blitzortung map...');
      await page.goto('https://map.blitzortung.org/', {
        waitUntil: 'networkidle2',
        timeout: 60_000,
      });

      console.log('Page loaded, waiting for WebSocket connections...');
      // Page stays open — watchdog and WS-close handler manage restarts
    } catch (err) {
      console.error('[blitzortung] Session error:', err.message);
      closeAndRestart(browser, 10_000);
    }
  }

  function closeAndRestart(browser, delayMs) {
    if (stopped) return;
    clearInterval(watchdogInterval);

    // Avoid double-scheduling
    if (restartTimeout !== null) return;

    try {
      browser.close().catch(() => {});
    } catch (_) {}
    currentBrowser = null;

    scheduleRestart(delayMs);
  }

  function scheduleRestart(delayMs) {
    if (stopped || getIsShuttingDown()) return;
    if (restartTimeout !== null) return;
    console.log(`[blitzortung] Restarting in ${delayMs / 1000}s...`);
    restartTimeout = setTimeout(() => {
      restartTimeout = null;
      start();
    }, delayMs);
  }

  // Begin
  start();

  return {
    stop() {
      stopped = true;
      clearInterval(watchdogInterval);
      if (restartTimeout !== null) {
        clearTimeout(restartTimeout);
        restartTimeout = null;
      }
      if (currentBrowser) {
        currentBrowser.close().catch(() => {});
        currentBrowser = null;
      }
    },
  };
}

module.exports = { captureBlitzortungData };
