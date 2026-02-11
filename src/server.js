/**
 * HTTP server for claude-fix daemon
 */

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const { spawnTerminal, getTerminalName, isTerminalAvailable } = require('./terminal');

const CONFIG_FILE = path.join(process.env.HOME, '.claude-fix', 'config.json');

function loadConfig() {
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    }
  } catch {}
  return {};
}

// Load DD keys: env vars first, then config file
const config = loadConfig();
const DD_API_KEY = process.env.DD_API_KEY || config.DD_API_KEY || '';
const DD_APP_KEY = process.env.DD_APP_KEY || config.DD_APP_KEY || '';
const DD_BASE_URL = 'https://app.datadoghq.com';

const DEFAULT_PORT = 8991;

/**
 * Fetch prompt from Datadog recommendations API
 * @param {string} encodedData - The base64url encoded JSON data (e.g., {"id": "recommendation-id"})
 * @returns {Promise<string>} The prompt text
 */
function fetchDatadogPrompt(encodedData) {
  return new Promise((resolve, reject) => {
    if (!DD_API_KEY || !DD_APP_KEY) {
      reject(new Error('DD_API_KEY and DD_APP_KEY required (set in env or ~/.claude-fix/config.json)'));
      return;
    }

    // JSON:API formatted request body
    const requestBody = JSON.stringify({
      data: {
        type: 'prompt_request',
        id: 'prompt_request',
        attributes: {
          data: encodedData
        }
      }
    });

    const url = new URL(`${DD_BASE_URL}/api/unstable/recommendations/prompt`);

    const req = https.request({
      hostname: url.hostname,
      path: url.pathname,
      method: 'POST',
      headers: {
        'Content-Type': 'application/vnd.api+json',
        'Accept': 'application/vnd.api+json',
        'DD-API-KEY': DD_API_KEY,
        'DD-APPLICATION-KEY': DD_APP_KEY,
        'Content-Length': Buffer.byteLength(requestBody)
      }
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        if (res.statusCode !== 200) {
          reject(new Error(`Datadog API returned ${res.statusCode}: ${data}`));
          return;
        }
        // Parse JSON:API response
        try {
          const parsed = JSON.parse(data);
          // Extract prompt from JSON:API response
          const prompt = parsed.data?.attributes?.prompt || parsed.prompt || data;
          resolve(prompt);
        } catch {
          // If not JSON, return as-is
          resolve(data);
        }
      });
    });

    req.on('error', reject);
    req.write(requestBody);
    req.end();
  });
}

/**
 * Send JSON response
 */
function sendJson(res, statusCode, data) {
  res.writeHead(statusCode, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type'
  });
  res.end(JSON.stringify(data));
}

/**
 * Handle /dd/claude-fix endpoint
 */
async function handleFix(req, res, url) {
  try {
    const data = url.searchParams.get('data');
    if (!data) {
      sendJson(res, 400, { error: 'Missing data query parameter' });
      return;
    }

    const datadogPrompt = await fetchDatadogPrompt(data);

    // Wrap in meta-prompt to wait for user approval
    const prompt = `I received the following recommendation from Datadog APM:

---
${datadogPrompt}
---

IMPORTANT: Do NOT take any action yet. Do NOT use any tools. Do NOT analyze or investigate anything. Simply acknowledge that you received this recommendation and ask me if I want to proceed. Wait for my explicit approval before doing anything.`;

    sendJson(res, 200, {
      status: 'spawning',
      terminal: getTerminalName(),
      prompt: prompt.substring(0, 200) + (prompt.length > 200 ? '...' : '')
    });

    // Brief delay so the HTTP response reaches the UI before Terminal steals focus
    setTimeout(() => {
      spawnTerminal(prompt).catch(err => {
        console.error('Failed to spawn terminal:', err.message);
      });
    }, 500);
  } catch (err) {
    sendJson(res, 500, { error: err.message });
  }
}

/**
 * Handle /health endpoint
 */
function handleHealth(req, res) {
  sendJson(res, 200, {
    status: 'ok',
    terminal: isTerminalAvailable() ? getTerminalName() : 'unavailable',
    datadog: DD_API_KEY && DD_APP_KEY ? 'configured' : 'not configured',
    platform: process.platform,
    pid: process.pid,
    uptime: process.uptime()
  });
}

/**
 * Request handler
 */
async function requestHandler(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);

  // Handle CORS preflight
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type'
    });
    res.end();
    return;
  }

  // Route requests
  if (url.pathname === '/dd/claude-fix' && req.method === 'GET') {
    await handleFix(req, res, url);
  } else if (url.pathname === '/dd/health' && req.method === 'GET') {
    handleHealth(req, res);
  } else {
    sendJson(res, 404, { error: 'Not found' });
  }
}

/**
 * Create and start the server
 */
function createServer(port = DEFAULT_PORT) {
  const server = http.createServer(requestHandler);

  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.error(`Port ${port} is already in use. Is claude-fix already running?`);
      process.exit(1);
    }
    throw err;
  });

  server.listen(port, '127.0.0.1', () => {
    console.log(`claude-fix daemon listening on http://127.0.0.1:${port}`);
    console.log('Endpoints:');
    console.log(`  GET /dd/claude-fix?data=  - Spawn Claude Code with Datadog context`);
    console.log(`  GET /dd/health            - Check daemon status`);
  });

  return server;
}

module.exports = {
  createServer,
  DEFAULT_PORT
};
