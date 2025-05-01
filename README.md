# Lightning Server

A minimal server that captures real-time lightning strike data from Blitzortung.org and relays it to connected clients.

## How It Works

1. Uses Puppeteer to launch a headless browser
2. Loads the Blitzortung map website
3. Intercepts WebSocket communication
4. Decodes the data using LZW algorithm
5. Forwards strike data to clients via WebSockets

## Usage

```
npm install
npm start
```

The server runs on port 3001 and provides a WebSocket endpoint for clients to connect to.
