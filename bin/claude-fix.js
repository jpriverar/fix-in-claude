#!/usr/bin/env node

/**
 * claude-fix CLI
 *
 * Commands:
 *   serve [--port]  - Start daemon in foreground
 *   start [--port]  - Start daemon in background
 *   stop            - Stop background daemon
 *   status          - Check if running
 *   fix "message"   - Manual one-shot (no daemon needed)
 *   install         - Install launchd service
 *   uninstall       - Uninstall launchd service
 */

const fs = require('fs');
const path = require('path');
const { spawn, execSync } = require('child_process');
const { createServer, DEFAULT_PORT } = require('../src/server');
const { buildPrompt } = require('../src/prompt-builder');
const { spawnTerminal } = require('../src/terminal');

const bold = (s) => `\x1b[1m${s}\x1b[0m`;
const green = (s) => `\x1b[32m${s}\x1b[0m`;
const cyan = (s) => `\x1b[36m${s}\x1b[0m`;
const dim = (s) => `\x1b[2m${s}\x1b[0m`;
const red = (s) => `\x1b[31m${s}\x1b[0m`;

const PID_FILE = '/tmp/claude-fix.pid';
const PLIST_NAME = 'com.jp.claude-fix.plist';
const PLIST_SRC = path.join(__dirname, '..', 'launchd', PLIST_NAME);
const PLIST_DEST = path.join(process.env.HOME, 'Library', 'LaunchAgents', PLIST_NAME);
const CONFIG_FILE = path.join(process.env.HOME, '.claude-fix', 'config.json');

function loadConfig() {
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    }
  } catch {}
  return {};
}

function parseArgs(args) {
  const result = { command: args[0], args: [], options: {} };

  for (let i = 1; i < args.length; i++) {
    if (args[i].startsWith('--')) {
      const key = args[i].slice(2);
      const value = args[i + 1] && !args[i + 1].startsWith('--') ? args[++i] : true;
      result.options[key] = value;
    } else {
      result.args.push(args[i]);
    }
  }

  return result;
}

function isRunning() {
  if (!fs.existsSync(PID_FILE)) {
    return false;
  }

  const pid = fs.readFileSync(PID_FILE, 'utf8').trim();
  try {
    process.kill(parseInt(pid), 0);
    return true;
  } catch {
    // Process not running, clean up stale PID file
    fs.unlinkSync(PID_FILE);
    return false;
  }
}

function getPid() {
  if (!fs.existsSync(PID_FILE)) {
    return null;
  }
  return fs.readFileSync(PID_FILE, 'utf8').trim();
}

async function cmdServe(options) {
  const port = parseInt(options.port) || DEFAULT_PORT;

  // Write PID file
  fs.writeFileSync(PID_FILE, process.pid.toString());

  // Clean up on exit
  process.on('SIGINT', () => {
    fs.unlinkSync(PID_FILE);
    process.exit(0);
  });
  process.on('SIGTERM', () => {
    fs.unlinkSync(PID_FILE);
    process.exit(0);
  });

  createServer(port);
}

function cmdStart(options) {
  if (isRunning()) {
    console.log('claude-fix is already running (PID: ' + getPid() + ')');
    return;
  }

  try {
    execSync('launchctl start com.jp.claude-fix', { stdio: 'pipe' });
    console.log('claude-fix started via launchctl');
  } catch (err) {
    console.error('Failed to start service. Is it installed?');
    console.error('  Run: claude-fix install');
  }
}

function cmdStop() {
  try {
    execSync('launchctl stop com.jp.claude-fix', { stdio: 'pipe' });
    console.log('Stopped claude-fix via launchctl');
  } catch (err) {
    console.error('Failed to stop service:', err.message);
  }
}

function cmdStatus() {
  if (isRunning()) {
    const pid = getPid();
    console.log(`claude-fix is running (PID: ${pid})`);

    // Try to get health info
    try {
      const http = require('http');
      const req = http.get(`http://127.0.0.1:${DEFAULT_PORT}/dd/health`, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          const health = JSON.parse(data);
          console.log(`  Terminal: ${health.terminal}`);
          console.log(`  Uptime: ${Math.round(health.uptime)}s`);
        });
      });
      req.on('error', () => {});
      req.end();
    } catch {}
  } else {
    console.log('claude-fix is not running');
  }
}

async function cmdFix(args) {
  const message = args.join(' ');
  if (!message) {
    console.error('Usage: claude-fix fix "error message"');
    process.exit(1);
  }

  const prompt = buildPrompt({ message });
  await spawnTerminal(prompt, process.cwd());
}

const TERMINALS = ['Terminal', 'iTerm', 'Kitty', 'Alacritty', 'WezTerm'];

function promptTerminal(current) {
  const { createInterface } = require('readline');
  const rl = createInterface({ input: process.stdin, output: process.stdout });

  return new Promise((resolve) => {
    console.log(bold('\n\uD83D\uDDA5  Select terminal:'));
    TERMINALS.forEach((t, i) => {
      if (t === current) {
        console.log(cyan(`   \u25C9 ${i + 1}) ${t}  (current)`));
      } else {
        console.log(dim(`   \u25CB ${i + 1}) ${t}`));
      }
    });

    const defaultIndex = Math.max(0, TERMINALS.indexOf(current)) + 1;
    rl.question(`Choice [${defaultIndex}]: `, (answer) => {
      rl.close();
      const choice = parseInt(answer) || defaultIndex;
      resolve(TERMINALS[choice - 1] || current);
    });
  });
}

async function cmdInstall() {
  // When called from install.sh, CLAUDE_FIX_TERMINAL env var is set — skip redundant output
  const calledFromInstallSh = !!process.env.CLAUDE_FIX_TERMINAL;

  if (!calledFromInstallSh) {
    console.log(bold('\n\uD83D\uDD27 claude-fix install\n'));
  }

  if (!fs.existsSync(PLIST_SRC)) {
    console.error(red(`\u274C Plist file not found: ${PLIST_SRC}`));
    console.error('   Run this command from the claude-fix directory');
    process.exit(1);
  }

  // Prompt for terminal preference (skip when env var is set — install.sh already prompted)
  const config = loadConfig();
  if (calledFromInstallSh) {
    config.CLAUDE_FIX_TERMINAL = process.env.CLAUDE_FIX_TERMINAL;
  } else {
    const current = config.CLAUDE_FIX_TERMINAL || 'Terminal';
    config.CLAUDE_FIX_TERMINAL = await promptTerminal(current);
  }
  const configDir = path.dirname(CONFIG_FILE);
  if (!fs.existsSync(configDir)) {
    fs.mkdirSync(configDir, { recursive: true });
  }
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2) + '\n');
  fs.chmodSync(CONFIG_FILE, 0o600);
  console.log(green('\u2705 Config saved') + dim(`         ${CONFIG_FILE}`));

  // Read and update plist with correct paths
  let plist = fs.readFileSync(PLIST_SRC, 'utf8');
  plist = plist.replace(/\$\{NODE_PATH\}/g, process.execPath);
  plist = plist.replace(/\$\{SCRIPT_PATH\}/g, __filename);

  // Ensure LaunchAgents directory exists
  const launchAgentsDir = path.dirname(PLIST_DEST);
  if (!fs.existsSync(launchAgentsDir)) {
    fs.mkdirSync(launchAgentsDir, { recursive: true });
  }

  // Write plist
  fs.writeFileSync(PLIST_DEST, plist);
  console.log(green('\u2705 Plist installed') + dim(`      ~/Library/LaunchAgents/${PLIST_NAME}`));

  // Load the service
  try {
    // Unload first in case already loaded
    try {
      execSync(`launchctl bootout gui/$(id -u) ${PLIST_DEST}`, { stdio: 'pipe' });
    } catch {}
    execSync(`launchctl bootstrap gui/$(id -u) ${PLIST_DEST}`, { stdio: 'inherit' });
    console.log(green('\u2705 Service loaded') + dim('       claude-fix will start automatically on login'));
    if (!calledFromInstallSh) {
      console.log(bold('\n\uD83C\uDF89 Install complete!\n'));
    }
  } catch (err) {
    console.error(red('\n\u274C Failed to load service. Load manually:'));
    console.error(dim(`   launchctl bootstrap gui/$(id -u) ${PLIST_DEST}`));
  }
}

function cmdUninstall() {
  if (!fs.existsSync(PLIST_DEST)) {
    console.log('claude-fix service is not installed');
    return;
  }

  // Unload the service
  try {
    execSync(`launchctl bootout gui/$(id -u) ${PLIST_DEST}`, { stdio: 'pipe' });
  } catch {}

  // Remove plist
  fs.unlinkSync(PLIST_DEST);
  console.log(`Uninstalled: ${PLIST_DEST}`);
}

const VALID_CONFIG_KEYS = ['DD_API_KEY', 'DD_APP_KEY', 'CLAUDE_FIX_TERMINAL', 'GIT_SEARCH_PATHS', 'GIT_SEARCH_MAX_DEPTH'];

function redact(value) {
  if (!value || value.length <= 4) return value || '';
  return '...' + value.slice(-4);
}

function cmdConfig(args) {
  const sub = args[0];

  if (sub === 'path') {
    console.log(CONFIG_FILE);
    return;
  }

  if (sub === 'set') {
    const key = args[1];
    const value = args.slice(2).join(' ');

    if (!key || !value) {
      console.error('Usage: claude-fix config set <key> <value>');
      console.error('Keys: ' + VALID_CONFIG_KEYS.join(', '));
      process.exit(1);
    }

    if (!VALID_CONFIG_KEYS.includes(key)) {
      console.error(`Unknown key: ${key}`);
      console.error('Valid keys: ' + VALID_CONFIG_KEYS.join(', '));
      process.exit(1);
    }

    const config = loadConfig();

    // Type coercion for specific keys
    if (key === 'GIT_SEARCH_PATHS') {
      config[key] = value.split(',').map(p => p.trim());
    } else if (key === 'GIT_SEARCH_MAX_DEPTH') {
      config[key] = parseInt(value, 10);
    } else {
      config[key] = value;
    }

    const configDir = path.dirname(CONFIG_FILE);
    if (!fs.existsSync(configDir)) {
      fs.mkdirSync(configDir, { recursive: true });
    }
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2) + '\n');
    fs.chmodSync(CONFIG_FILE, 0o600);

    console.log(`Updated ${key} = ${key.includes('KEY') ? redact(value) : value}`);
    console.log('Restart the daemon for changes to take effect:');
    console.log('  claude-fix stop && claude-fix start');
    return;
  }

  // Default: show current config
  const config = loadConfig();
  if (Object.keys(config).length === 0) {
    console.log('No config found at ' + CONFIG_FILE);
    return;
  }

  for (const [key, value] of Object.entries(config)) {
    const display = key.includes('KEY') ? redact(value) : value;
    console.log(`${key} = ${display}`);
  }
}

function printHelp() {
  console.log(`
claude-fix - HTTP daemon that spawns Claude Code with context

Usage:
  claude-fix <command> [options]

Commands:
  serve [--port PORT]  Start daemon in foreground (default port: ${DEFAULT_PORT})
  start                Start daemon via launchctl
  stop                 Stop daemon via launchctl
  status               Check if daemon is running
  fix "message"        Quick one-shot fix (no daemon needed)
  config               Show current config
  config set <k> <v>   Set a config value
  config path          Print config file path
  install              Install launchd service for auto-start
  uninstall            Remove launchd service

Config keys:
  DD_API_KEY              Datadog API key
  DD_APP_KEY              Datadog application key
  CLAUDE_FIX_TERMINAL     Terminal app (Terminal, iTerm, Kitty, Alacritty, WezTerm)
  GIT_SEARCH_PATHS        Comma-separated dirs to scan for repos (default: ~/dd)
  GIT_SEARCH_MAX_DEPTH    Max directory depth for repo scan (default: 4)

Examples:
  claude-fix serve
  claude-fix config set CLAUDE_FIX_TERMINAL iTerm
  claude-fix config set GIT_SEARCH_PATHS "~/dd,~/projects"
  claude-fix config set GIT_SEARCH_MAX_DEPTH 3
  claude-fix fix "TypeError: Cannot read property 'foo' of undefined"

API:
  GET http://localhost:${DEFAULT_PORT}/dd/claude-fix?data=<encoded-data>&repo=<host/owner/repo>
  GET http://localhost:${DEFAULT_PORT}/dd/health
`);
}

// Main
async function main() {
  const args = process.argv.slice(2);
  const { command, args: cmdArgs, options } = parseArgs(args);

  switch (command) {
    case 'serve':
      await cmdServe(options);
      break;
    case 'start':
      cmdStart(options);
      break;
    case 'stop':
      cmdStop();
      break;
    case 'status':
      cmdStatus();
      break;
    case 'fix':
      await cmdFix(cmdArgs);
      break;
    case 'config':
      cmdConfig(cmdArgs);
      break;
    case 'install':
      await cmdInstall();
      break;
    case 'uninstall':
      cmdUninstall();
      break;
    case 'help':
    case '--help':
    case '-h':
    case undefined:
      printHelp();
      break;
    default:
      console.error(`Unknown command: ${command}`);
      printHelp();
      process.exit(1);
  }
}

main().catch(err => {
  console.error(err.message);
  process.exit(1);
});
