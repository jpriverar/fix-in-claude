# claude-fix

A lightweight HTTP daemon that receives Datadog recommendation links and spawns Claude Code in a terminal with the context.

## Quick Install

```bash
curl -fsSL https://raw.githubusercontent.com/jpriverar/fix-in-claude/main/install.sh | bash
```

This one-liner:
1. Downloads claude-fix to `~/.claude-fix/`
2. Prompts for Datadog API credentials
3. Installs a launchd service (auto-starts on login)
4. Creates `/usr/local/bin/claude-fix` symlink

### Prerequisites

- macOS
- Node.js (`brew install node`)
- Claude Code CLI ([installation guide](https://docs.anthropic.com/en/docs/claude-code))
- Datadog API key and App key

## Manual Installation

```bash
git clone https://github.com/jpriverar/fix-in-claude.git ~/.claude-fix
cd ~/.claude-fix
claude-fix install
```

## Usage

### Start the daemon

```bash
# Foreground (for testing)
claude-fix serve

# Background
claude-fix start

# Check status
claude-fix status

# Stop
claude-fix stop
```

### Auto-start on login

```bash
claude-fix install    # Install launchd service
claude-fix uninstall  # Remove launchd service
```

## API

### GET /dd/claude-fix?data=

Spawn Claude Code with Datadog recommendation context.

```bash
curl "http://localhost:8991/dd/claude-fix?data=eyJpZCI6InJlYy0xMjMifQ"
```

The `data` parameter is a base64url-encoded JSON payload (e.g., `{"id": "rec-123"}`).

Response:
```json
{
  "status": "spawned",
  "terminal": "Terminal.app",
  "prompt": "I received the following recommendation from Datadog APM:..."
}
```

### GET /dd/health

Check daemon status.

```bash
curl http://localhost:8991/dd/health
```

Response:
```json
{
  "status": "ok",
  "terminal": "Terminal.app",
  "datadog": "configured",
  "platform": "darwin",
  "pid": 12345,
  "uptime": 3600
}
```

## Configuration

- **Default port**: 8991
- **Terminal**: Terminal.app (macOS only)
- **PID file**: /tmp/claude-fix.pid
- **Logs**: /tmp/claude-fix.log, /tmp/claude-fix.err

## Uninstall

```bash
claude-fix uninstall
sudo rm /usr/local/bin/claude-fix
rm -rf ~/.claude-fix
```
