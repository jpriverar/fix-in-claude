#!/bin/bash
set -e

INSTALL_DIR="$HOME/.claude-fix"
CONFIG_FILE="$INSTALL_DIR/config.json"
REPO="jpriverar/fix-in-claude"
SYMLINK_PATH="/usr/local/bin/claude-fix"

# ANSI formatting
bold=$'\e[1m'
green=$'\e[32m'
cyan=$'\e[36m'
dim=$'\e[2m'
red=$'\e[31m'
yellow=$'\e[33m'
reset=$'\e[0m'

echo ""
echo "${bold}🔧  Installing claude-fix...${reset}"
echo ""

# 1. Check prerequisites
echo "Checking prerequisites..."

if [[ "$(uname)" != "Darwin" ]]; then
  echo "${red}❌ Error: claude-fix currently only supports macOS${reset}"
  exit 1
fi

if ! command -v node >/dev/null 2>&1; then
  echo "${red}❌ Error: Node.js is required${reset}"
  echo "   Install from https://nodejs.org or via: brew install node"
  exit 1
fi

if ! command -v claude >/dev/null 2>&1; then
  echo "${red}❌ Error: Claude Code CLI is required${reset}"
  echo "   Install from https://docs.anthropic.com/en/docs/claude-code"
  exit 1
fi

if ! command -v git >/dev/null 2>&1; then
  echo "${red}❌ Error: Git is required${reset}"
  exit 1
fi

echo "  ${green}✅ Node.js:${reset} $(node --version)"
echo "  ${green}✅ Claude CLI:${reset} $(claude --version 2>/dev/null || echo 'installed')"
echo "  ${green}✅ Git:${reset} $(git --version)"

echo ""
echo "${yellow}⚠️  This script requires sudo to create a symlink in /usr/local/bin${reset}"
echo ""

# 2. Check repo access
if ! git ls-remote "https://github.com/$REPO.git" HEAD >/dev/null 2>&1; then
  echo "${red}❌ Error: Cannot access $REPO${reset}"
  echo "   Make sure you have access and are authenticated with GitHub"
  exit 1
fi

# 3. Download
if [ -d "$INSTALL_DIR" ]; then
  echo "📦  Updating existing installation..."
  # Preserve config
  cp "$CONFIG_FILE" /tmp/claude-fix-config-backup.json 2>/dev/null || true
  rm -rf "$INSTALL_DIR"
else
  echo "📦  Downloading claude-fix..."
fi

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
echo "${bold}🔑  Datadog API credentials${reset} ${dim}(optional)${reset}"
echo "${dim}   Keys are stored in ~/.claude-fix/config.json and can be added/updated anytime.${reset}"
echo "${dim}   Without keys, the daemon starts but Datadog integration won't work.${reset}"
echo ""

DD_API_KEY="${DD_API_KEY:-$EXISTING_DD_API_KEY}"
DD_APP_KEY="${DD_APP_KEY:-$EXISTING_DD_APP_KEY}"

if [ -z "$DD_API_KEY" ]; then
  read -p "   Datadog API Key: " DD_API_KEY < /dev/tty
elif [ -n "$DD_API_KEY" ]; then
  echo "   Datadog API Key: ${dim}(kept from existing config)${reset}"
fi

if [ -z "$DD_APP_KEY" ]; then
  read -p "   Datadog App Key: " DD_APP_KEY < /dev/tty
elif [ -n "$DD_APP_KEY" ]; then
  echo "   Datadog App Key: ${dim}(kept from existing config)${reset}"
fi

# 6. Select preferred terminal
TERMINALS=("Terminal")
[ -d "/Applications/iTerm.app" ] && TERMINALS+=("iTerm")
[ -d "/Applications/kitty.app" ] && TERMINALS+=("Kitty")
[ -d "/Applications/Alacritty.app" ] && TERMINALS+=("Alacritty")
[ -d "/Applications/WezTerm.app" ] && TERMINALS+=("WezTerm")

# Only skip prompt if CLAUDE_FIX_TERMINAL was explicitly passed as env var
EXPLICIT_TERMINAL="$CLAUDE_FIX_TERMINAL"
DEFAULT_TERMINAL="${EXISTING_TERMINAL:-Terminal}"

echo ""
echo "${bold}🖥  Select terminal:${reset}"

if [ -n "$EXPLICIT_TERMINAL" ]; then
  CLAUDE_FIX_TERMINAL="$EXPLICIT_TERMINAL"
  echo "   Using terminal: ${cyan}${CLAUDE_FIX_TERMINAL}${reset}"
elif [ ${#TERMINALS[@]} -eq 1 ]; then
  echo "   Using terminal: ${cyan}Terminal${reset} ${dim}(only Terminal.app found)${reset}"
  CLAUDE_FIX_TERMINAL="Terminal"
else
  DEFAULT_IDX=1
  for i in "${!TERMINALS[@]}"; do
    if [ "${TERMINALS[$i]}" = "$DEFAULT_TERMINAL" ]; then
      echo "${cyan}   ◉ $((i+1))) ${TERMINALS[$i]}  (current)${reset}"
      DEFAULT_IDX=$((i+1))
    else
      echo "${dim}   ○ $((i+1))) ${TERMINALS[$i]}${reset}"
    fi
  done
  echo ""
  read -p "   Choice [${DEFAULT_IDX}]: " CHOICE < /dev/tty
  CHOICE="${CHOICE:-$DEFAULT_IDX}"
  CLAUDE_FIX_TERMINAL="${TERMINALS[$((CHOICE-1))]:-$DEFAULT_TERMINAL}"
fi

# Write config file
cat > "$CONFIG_FILE" << EOF
{
  "DD_API_KEY": "${DD_API_KEY}",
  "DD_APP_KEY": "${DD_APP_KEY}",
  "CLAUDE_FIX_TERMINAL": "${CLAUDE_FIX_TERMINAL}"
}
EOF
chmod 600 "$CONFIG_FILE"

echo ""
echo "${green}✅ Config saved${reset}         ${dim}${CONFIG_FILE}${reset}"

# 7. Create symlink
if [ -L "$SYMLINK_PATH" ] || [ -e "$SYMLINK_PATH" ]; then
  sudo rm -f "$SYMLINK_PATH"
fi

# Ensure /usr/local/bin exists
if [ ! -d "/usr/local/bin" ]; then
  sudo mkdir -p /usr/local/bin
fi

sudo ln -sf "$INSTALL_DIR/bin/claude-fix.js" "$SYMLINK_PATH"
echo "${green}✅ Symlink created${reset}      ${dim}${SYMLINK_PATH}${reset}"

# 8. Install launchd service (JS handles plist + service loading output)
echo ""
CLAUDE_FIX_TERMINAL="$CLAUDE_FIX_TERMINAL" node "$INSTALL_DIR/bin/claude-fix.js" install

# 9. Verify installation
sleep 2

if curl -s --connect-timeout 5 http://localhost:8991/dd/health | grep -q '"status":"ok"'; then
  echo "${green}✅ claude-fix is running!${reset}"
else
  echo "${yellow}⚠️  Health check failed. The daemon may need a moment to start.${reset}"
  echo "${dim}   Check status with: claude-fix status${reset}"
  echo "${dim}   View logs with: tail -f /tmp/claude-fix.log${reset}"
fi

echo ""
echo "${bold}${green}🎉  Installation complete!${reset}"
echo ""
echo "   The daemon is now running and will auto-start on login."
echo ""
echo "   Commands:"
echo "     claude-fix status     Check daemon status"
echo "     claude-fix stop       Stop the daemon"
echo "     claude-fix start      Start the daemon"
echo ""
