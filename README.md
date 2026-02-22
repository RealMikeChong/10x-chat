# 10x-chat

> Chat with web AI agents (ChatGPT, Gemini, Claude) from your terminal via browser automation.

10x-chat uses [Playwright](https://playwright.dev) to automate browser sessions with persisted login profiles. Login once, then send prompts — bundled with file context — from your CLI or AI coding agent.

## Use with OpenClaw

Paste this into your [OpenClaw](https://openclaw.ai) chat to install as a skill:

```
https://raw.githubusercontent.com/RealMikeChong/10x-chat/refs/heads/main/skills/10x-chat/SKILL.md
```

## Install

```bash
npm install -g 10x-chat
npx playwright install chromium  # one-time browser setup
```

## Quick Start

```bash
# 1. Login to a provider (opens a browser window)
10x-chat login chatgpt

# 2. Send a prompt
10x-chat chat -p "Explain this error" --provider chatgpt --file "src/**/*.ts"

# 3. View session history
10x-chat status
```

## Commands

### `login <provider>`

Opens a headed browser for you to authenticate. The session persists across runs.

```bash
10x-chat login chatgpt       # Login to ChatGPT
10x-chat login gemini         # Login to Gemini
10x-chat login claude         # Login to Claude
10x-chat login --status       # Check login status for all providers
```

### `chat`

Send a prompt to an AI provider via browser automation.

```bash
10x-chat chat -p "Review this code for bugs" --provider chatgpt --file "src/**/*.ts"
10x-chat chat -p "Debug this error" --file "logs/error.log"
10x-chat chat -p "Explain this" --dry-run              # Preview bundle without sending
10x-chat chat -p "Explain this" --copy                  # Copy bundle to clipboard
10x-chat chat -p "Long task" --timeout 600000 --headed  # 10min timeout, visible browser
```

| Flag | Description |
|------|-------------|
| `-p, --prompt <text>` | **(required)** The prompt to send |
| `--provider <name>` | Provider: `chatgpt`, `gemini`, `claude` (default: config) |
| `--model <name>` | Model to select in the UI |
| `-f, --file <paths...>` | Files/globs to bundle as context |
| `--copy` | Copy bundle to clipboard instead of sending |
| `--dry-run` | Preview the bundle without sending |
| `--headed` | Show browser window during chat |
| `--timeout <ms>` | Response timeout in milliseconds (default: 300000) |

### `status`

List recent chat sessions.

```bash
10x-chat status              # Last 24 hours
10x-chat status --hours 72   # Last 3 days
```

### `session <id>`

View details of a specific session.

```bash
10x-chat session <id> --render   # Pretty-print the response
```

### `config`

View or modify configuration.

```bash
10x-chat config show
10x-chat config set provider gemini
10x-chat config set timeout 600000
10x-chat config set headless false
```

### `skill`

Manage the agent integration skill (for Codex, Claude Code, etc).

```bash
10x-chat skill install   # Install SKILL.md to ~/.codex/skills/
10x-chat skill show      # Display SKILL.md content
```

## File Bundling

The `--file` flag accepts globs. Files are assembled into a markdown bundle sent as the prompt:

```bash
10x-chat chat -p "Review these" --file "src/**/*.ts" "!src/**/*.test.ts"
```

Security-sensitive files (`.env*`, `*.pem`, `*.key`, etc.) are automatically excluded.

## Data Layout

```
~/.10x-chat/
├── profiles/
│   ├── chatgpt/          # Playwright persistent browser profile
│   ├── gemini/
│   └── claude/
├── sessions/
│   └── <uuid>/
│       ├── meta.json     # Session metadata
│       ├── bundle.md     # Prompt bundle sent
│       └── response.md   # Captured response
└── config.json           # User configuration
```

## Agent Integration

10x-chat includes a `SKILL.md` for AI coding agents. Install it with:

```bash
10x-chat skill install
```

This lets agents like Codex or Claude Code use 10x-chat to query other models for cross-validation, code review, or debugging help.

## Supported Providers

| Provider | Status | URL |
|----------|--------|-----|
| ChatGPT | ✅ | chatgpt.com |
| Gemini | ✅ | gemini.google.com |
| Claude | ✅ | claude.ai |
| Grok | ✅ | grok.com |

## Development

```bash
bun install
bun run dev login chatgpt      # Run CLI in dev mode
bun run typecheck               # Type check
bun run lint                    # Lint
bun run test                    # Run tests
bun run build                   # Build for production
```

## Publishing

Releases are automated via GitHub Actions. Push a version tag to publish:

```bash
npm version patch   # or minor / major
git push --follow-tags
```

Requires `NPM_TOKEN` secret in the GitHub repository settings.

## License

MIT
