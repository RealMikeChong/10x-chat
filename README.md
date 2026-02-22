# 10x-chat

> Chat with web AI agents (ChatGPT, Gemini, Claude, Grok, NotebookLM) from your terminal via browser automation.

10x-chat uses [Playwright](https://playwright.dev) to automate browser sessions with persisted login profiles. Login once, then send prompts — bundled with file context — from your CLI or AI coding agent.

## Use with OpenClaw

Paste this into your [OpenClaw](https://openclaw.ai) chat to install as a skill:

```
https://raw.githubusercontent.com/RealMikeChong/10x-chat/refs/heads/main/skills/10x-chat/SKILL.md
```

## Quick Start

```bash
npx playwright install chromium  # one-time browser setup

# 1. Login to a provider (opens a browser window)
npx 10x-chat@latest login chatgpt

# 2. Send a prompt
npx 10x-chat@latest chat -p "Explain this error" --provider chatgpt --file "src/**/*.ts"

# 3. View session history
npx 10x-chat@latest status
```

> [!TIP]
> Use `bunx` (bun.sh) instead of `npx` for faster startup.

## Commands

### `login <provider>`

Opens a headed browser for you to authenticate. The session persists across runs.

```bash
npx 10x-chat@latest login chatgpt       # Login to ChatGPT
npx 10x-chat@latest login gemini         # Login to Gemini
npx 10x-chat@latest login claude         # Login to Claude
npx 10x-chat@latest login grok           # Login to Grok
npx 10x-chat@latest login notebooklm     # Login to NotebookLM
npx 10x-chat@latest login --status       # Check login status for all providers
```

### `chat`

Send a prompt to an AI provider via browser automation.

```bash
npx 10x-chat@latest chat -p "Review this code for bugs" --provider chatgpt --file "src/**/*.ts"
npx 10x-chat@latest chat -p "Debug this error" --file "logs/error.log"
npx 10x-chat@latest chat -p "Explain this" --dry-run              # Preview bundle without sending
npx 10x-chat@latest chat -p "Explain this" --copy                  # Copy bundle to clipboard
npx 10x-chat@latest chat -p "Long task" --timeout 600000 --headed  # 10min timeout, visible browser
```

| Flag | Description |
|------|-------------|
| `-p, --prompt <text>` | **(required)** The prompt to send |
| `--provider <name>` | Provider: `chatgpt`, `gemini`, `claude`, `grok`, `notebooklm` (default: config) |
| `--model <name>` | Model to select in the UI |
| `-f, --file <paths...>` | Files/globs to bundle as context |
| `--copy` | Copy bundle to clipboard instead of sending |
| `--dry-run` | Preview the bundle without sending |
| `--headed` | Show browser window during chat |
| `--timeout <ms>` | Response timeout in milliseconds (default: 300000) |

### `status`

List recent chat sessions.

```bash
npx 10x-chat@latest status              # Last 24 hours
npx 10x-chat@latest status --hours 72   # Last 3 days
```

### `session <id>`

View details of a specific session.

```bash
npx 10x-chat@latest session <id> --render   # Pretty-print the response
```

### `config`

View or modify configuration.

```bash
npx 10x-chat@latest config show
npx 10x-chat@latest config set provider gemini
npx 10x-chat@latest config set timeout 600000
npx 10x-chat@latest config set headless false
```

### `skill`

Manage the agent integration skill (for Codex, Claude Code, etc).

```bash
npx 10x-chat@latest skill install   # Install SKILL.md to ~/.codex/skills/
npx 10x-chat@latest skill show      # Display SKILL.md content
```

### `notebooklm` (alias: `nb`)

Manage NotebookLM notebooks and sources via RPC API.

```bash
npx 10x-chat@latest notebooklm list                              # List all notebooks
npx 10x-chat@latest notebooklm create "Research Topic"            # Create a notebook
npx 10x-chat@latest notebooklm delete <notebookId>                # Delete a notebook
npx 10x-chat@latest notebooklm sources <notebookId>               # List sources in notebook
npx 10x-chat@latest notebooklm add-url <notebookId> <url>         # Add URL source
npx 10x-chat@latest notebooklm add-url <notebookId> <url> --wait  # Add URL and wait for processing
npx 10x-chat@latest notebooklm add-file <notebookId> ./paper.pdf  # Upload file source
npx 10x-chat@latest notebooklm add-text <id> "Title" "Content"    # Add pasted text source
npx 10x-chat@latest notebooklm summarize <notebookId>             # AI summary + suggested topics

# Then chat with the notebook's sources:
npx 10x-chat@latest chat -p "Summarize key points" --provider notebooklm
```

## File Bundling

The `--file` flag accepts globs. Files are assembled into a markdown bundle sent as the prompt:

```bash
npx 10x-chat@latest chat -p "Review these" --file "src/**/*.ts" "!src/**/*.test.ts"
```

Security-sensitive files (`.env*`, `*.pem`, `*.key`, etc.) are automatically excluded.

## Data Layout

```
~/.10x-chat/
├── profiles/
│   ├── chatgpt/          # Playwright persistent browser profile
│   ├── gemini/
│   ├── claude/
│   ├── grok/
│   └── notebooklm/       # NotebookLM browser profile (shared Google auth)
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
npx 10x-chat@latest skill install
```

This lets agents like Codex or Claude Code use 10x-chat to query other models for cross-validation, code review, or debugging help.

## Supported Providers

| Provider | Status | URL |
|----------|--------|-----|
| ChatGPT | ✅ | chatgpt.com |
| Gemini | ✅ | gemini.google.com |
| Claude | ✅ | claude.ai |
| Grok | ✅ | grok.com |
| NotebookLM | ✅ | notebooklm.google.com |

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
