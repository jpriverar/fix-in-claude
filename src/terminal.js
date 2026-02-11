/**
 * Terminal spawning for macOS with multiple terminal support
 */

const { exec } = require('child_process');
const { writeFileSync, unlinkSync } = require('fs');
const { join } = require('path');
const { tmpdir } = require('os');

const TERMINAL = process.env.CLAUDE_FIX_TERMINAL || 'Terminal';

/**
 * Terminal launcher implementations
 * Each launcher opens a terminal and runs the given command
 */
const launchers = {
  /**
   * macOS Terminal.app via .command file (avoids AppleScript two-window bug)
   */
  Terminal: (command, cwd, callback) => {
    const cdPart = cwd ? `cd '${cwd.replace(/'/g, "'\\''")}' && ` : '';
    const fullCommand = `${cdPart}${command}`;

    const scriptPath = join(tmpdir(), `claude-fix-${Date.now()}.command`);
    writeFileSync(scriptPath, `#!/bin/bash\n${fullCommand}\n`, { mode: 0o755 });

    exec(`open "${scriptPath}"`, { stdio: 'pipe' }, (err) => {
      // Clean up the temp file after a short delay
      setTimeout(() => { try { unlinkSync(scriptPath); } catch {} }, 5000);
      callback(err);
    });
  },

  /**
   * iTerm2 via AppleScript
   */
  iTerm: (command, cwd, callback) => {
    const cdPart = cwd ? `cd '${cwd.replace(/'/g, "'\\''")}' && ` : '';
    const fullCommand = `${cdPart}${command}`;

    const appleScript = `
tell application "iTerm"
    activate
    create window with default profile command "${fullCommand.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"
end tell
`;
    exec(`osascript -e '${appleScript.replace(/'/g, "'\\''")}'`, { stdio: 'pipe' }, callback);
  },

  /**
   * Kitty terminal via open command
   */
  Kitty: (command, cwd, callback) => {
    const cdPart = cwd ? `cd '${cwd.replace(/'/g, "'\\''")}' && ` : '';
    const fullCommand = `${cdPart}${command}`;

    exec(`open -a kitty --args bash -c "${fullCommand.replace(/"/g, '\\"')}; exec bash"`, { stdio: 'pipe' }, callback);
  },

  /**
   * Alacritty via open command
   */
  Alacritty: (command, cwd, callback) => {
    const cdPart = cwd ? `cd '${cwd.replace(/'/g, "'\\''")}' && ` : '';
    const fullCommand = `${cdPart}${command}`;

    exec(`open -a Alacritty --args -e bash -c "${fullCommand.replace(/"/g, '\\"')}; exec bash"`, { stdio: 'pipe' }, callback);
  },

  /**
   * WezTerm via open command
   */
  WezTerm: (command, cwd, callback) => {
    const cdPart = cwd ? `cd '${cwd.replace(/'/g, "'\\''")}' && ` : '';
    const fullCommand = `${cdPart}${command}`;

    exec(`open -a WezTerm --args start -- bash -c "${fullCommand.replace(/"/g, '\\"')}; exec bash"`, { stdio: 'pipe' }, callback);
  }
};

/**
 * Opens a new terminal window with interactive claude session
 * @param {string} prompt - The prompt to send to claude
 * @param {string} cwd - Working directory for the command
 * @returns {Promise<void>}
 */
function spawnTerminal(prompt, cwd) {
  return new Promise((resolve, reject) => {
    // Base64 encode the prompt to avoid escaping issues
    const encodedPrompt = Buffer.from(prompt).toString('base64');

    // Build the command - starts interactive session with initial prompt
    const command = `sleep 0.5 && claude "$(echo '${encodedPrompt}' | base64 -d)"`;

    const launcher = launchers[TERMINAL];
    if (!launcher) {
      reject(new Error(`Unsupported terminal: ${TERMINAL}. Supported: ${Object.keys(launchers).join(', ')}`));
      return;
    }

    launcher(command, cwd, (err) => {
      if (err) {
        reject(new Error(`Failed to spawn terminal: ${err.message}`));
      } else {
        resolve();
      }
    });
  });
}

/**
 * Gets the configured terminal name
 * @returns {string}
 */
function getTerminalName() {
  return TERMINAL;
}

/**
 * Checks if the configured terminal is available
 * @returns {boolean}
 */
function isTerminalAvailable() {
  if (process.platform !== 'darwin') {
    return false;
  }

  // Terminal.app is always available on macOS
  if (TERMINAL === 'Terminal') {
    return true;
  }

  // Check if the app exists
  const appPaths = {
    iTerm: '/Applications/iTerm.app',
    Kitty: '/Applications/kitty.app',
    Alacritty: '/Applications/Alacritty.app',
    WezTerm: '/Applications/WezTerm.app'
  };

  const appPath = appPaths[TERMINAL];
  if (!appPath) {
    return false;
  }

  try {
    require('fs').accessSync(appPath);
    return true;
  } catch {
    return false;
  }
}

module.exports = {
  spawnTerminal,
  getTerminalName,
  isTerminalAvailable
};
