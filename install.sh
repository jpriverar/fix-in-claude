#!/bin/bash
set -e

INSTALL_DIR="$HOME/.claude-fix"
CONFIG_FILE="$INSTALL_DIR/config.json"
REPO="jpriverar/fix-in-claude"
SYMLINK_PATH="/usr/local/bin/claude-fix"

echo "Installing claude-fix..."

# 1. Check prerequisites
echo "Checking prerequisites..."

if [[ "$(uname)" != "Darwin" ]]; then
  echo "Error: claude-fix currently only supports macOS"
  exit 1
fi

if ! command -v node >/dev/null 2>&1; then
  echo "Error: Node.js is required"
  echo "Install from https://nodejs.org or via: brew install node"
  exit 1
fi

if ! command -v claude >/dev/null 2>&1; then
  echo "Error: Claude Code CLI is required"
  echo "Install from https://docs.anthropic.com/en/docs/claude-code"
  exit 1
fi

if ! command -v git >/dev/null 2>&1; then
  echo "Error: Git is required"
  exit 1
fi

echo "  Node.js: $(node --version)"
echo "  Claude CLI: $(claude --version 2>/dev/null || echo 'installed')"
echo "  Git: $(git --version)"

echo ""
echo "Note: This script requires sudo to create a symlink in /usr/local/bin"
echo ""

# 2. Check repo access
if ! git ls-remote "https://github.com/$REPO.git" HEAD >/dev/null 2>&1; then
  echo "Error: Cannot access $REPO"
  echo "Make sure you have access and are authenticated with GitHub"
  exit 1
fi

# 3. Download
if [ -d "$INSTALL_DIR" ]; then
  echo "Updating existing installation..."
  # Preserve config
  cp "$CONFIG_FILE" /tmp/claude-fix-config-backup.json 2>/dev/null || true
  rm -rf "$INSTALL_DIR"
fi

echo "Downloading claude-fix..."
git clone --quiet "https://github.com/$REPO.git" "$INSTALL_DIR"

# Restore config if updating
mv /tmp/claude-fix-config-backup.json "$CONFIG_FILE" 2>/dev/null || true

cd "$INSTALL_DIR"

# 4. Load existing config (for updates)
if [ -f "$CONFIG_FILE" ]; then
  EXISTING_DD_API_KEY=$(python3 -c "import json; print(json.load(open('$CONFIG_FILE')).get('DD_API_KEY',''))" 2>/dev/null || true)
  EXISTING_DD_APP_KEY=$(python3 -c "import json; print(json.load(open('$CONFIG_FILE')).get('DD_APP_KEY',''))" 2>/dev/null || true)
  EXISTING_TERMINAL=$(python3 -c "import json; print(json.load(open('$CONFIG_FILE')).get('CLAUDE_FIX_TERMINAL',''))" 2>/dev/null || true)
fi

# 5. Prompt for credentials
echo ""
echo "Datadog API credentials (optional)"
echo "Keys are stored in ~/.claude-fix/config.json and can be added/updated anytime."
echo "Without keys, the daemon starts but Datadog integration won't work."
echo ""

DD_API_KEY="${DD_API_KEY:-$EXISTING_DD_API_KEY}"
DD_APP_KEY="${DD_APP_KEY:-$EXISTING_DD_APP_KEY}"

if [ -z "$DD_API_KEY" ]; then
  read -p "Datadog API Key: " DD_API_KEY
elif [ -n "$DD_API_KEY" ]; then
  echo "Datadog API Key: (kept from existing config)"
fi

if [ -z "$DD_APP_KEY" ]; then
  read -p "Datadog App Key: " DD_APP_KEY
elif [ -n "$DD_APP_KEY" ]; then
  echo "Datadog App Key: (kept from existing config)"
fi

# 6. Select preferred terminal
echo ""
echo "Detecting installed terminals..."

TERMINALS=("Terminal")
[ -d "/Applications/iTerm.app" ] && TERMINALS+=("iTerm")
[ -d "/Applications/kitty.app" ] && TERMINALS+=("Kitty")
[ -d "/Applications/Alacritty.app" ] && TERMINALS+=("Alacritty")
[ -d "/Applications/WezTerm.app" ] && TERMINALS+=("WezTerm")

CLAUDE_FIX_TERMINAL="${CLAUDE_FIX_TERMINAL:-$EXISTING_TERMINAL}"

if [ -n "$CLAUDE_FIX_TERMINAL" ]; then
  echo "Using terminal: $CLAUDE_FIX_TERMINAL (kept from existing config)"
elif [ ${#TERMINALS[@]} -eq 1 ]; then
  echo "Only Terminal.app found, using it as default."
  CLAUDE_FIX_TERMINAL="Terminal"
else
  echo "Found terminals: ${TERMINALS[*]}"
  echo ""
  echo "Which terminal would you like claude-fix to use?"
  PS3="Select terminal (1-${#TERMINALS[@]}): "
  select CLAUDE_FIX_TERMINAL in "${TERMINALS[@]}"; do
    if [ -n "$CLAUDE_FIX_TERMINAL" ]; then
      break
    fi
    echo "Invalid selection. Please try again."
  done
fi

echo "  Selected: $CLAUDE_FIX_TERMINAL"

# Write config file
cat > "$CONFIG_FILE" << EOF
{
  "DD_API_KEY": "${DD_API_KEY}",
  "DD_APP_KEY": "${DD_APP_KEY}",
  "CLAUDE_FIX_TERMINAL": "${CLAUDE_FIX_TERMINAL}"
}
EOF
chmod 600 "$CONFIG_FILE"
echo "  Config saved: $CONFIG_FILE"

# 7. Create symlink
echo ""
echo "Adding claude-fix to PATH..."

if [ -L "$SYMLINK_PATH" ] || [ -e "$SYMLINK_PATH" ]; then
  echo "  Removing existing symlink..."
  sudo rm -f "$SYMLINK_PATH"
fi

# Ensure /usr/local/bin exists
if [ ! -d "/usr/local/bin" ]; then
  sudo mkdir -p /usr/local/bin
fi

sudo ln -sf "$INSTALL_DIR/bin/claude-fix.js" "$SYMLINK_PATH"
echo "  Created: $SYMLINK_PATH -> $INSTALL_DIR/bin/claude-fix.js"

# 8. Install launchd service
echo ""
echo "Installing launchd service..."
CLAUDE_FIX_TERMINAL="$CLAUDE_FIX_TERMINAL" node "$INSTALL_DIR/bin/claude-fix.js" install

# 9. Verify installation
echo ""
echo "Verifying installation..."
sleep 2

if curl -s --connect-timeout 5 http://localhost:8991/dd/health | grep -q '"status":"ok"'; then
  echo "claude-fix is running!"
else
  echo "Warning: Health check failed. The daemon may need a moment to start."
  echo "  Check status with: claude-fix status"
  echo "  View logs with: tail -f /tmp/claude-fix.log"
fi

echo ""
echo "============================================"
echo "  Installation complete!"
echo "============================================"
echo ""
echo "The daemon is now running and will auto-start on login."
echo ""
echo "Commands:"
echo "  claude-fix status     - Check daemon status"
echo "  claude-fix stop       - Stop the daemon"
echo "  claude-fix start      - Start the daemon"
echo ""
echo "API endpoint: http://localhost:8991/dd/claude-fix?data="
echo ""
echo "To uninstall:"
echo "  claude-fix uninstall && sudo rm $SYMLINK_PATH && rm -rf $INSTALL_DIR"
echo ""
