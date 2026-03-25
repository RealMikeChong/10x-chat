---
name: 10x-chat
description: Chat with web AI agents (ChatGPT, Gemini, Claude, Grok, Perplexity, NotebookLM) via browser automation. Use when stuck, need cross-validation, want a second-model review, need image generation, or want deep research from web AI tools.
---

# 10x-chat — AI Agent Skill

Use 10x-chat to send prompts to web-based AI agents via automated browser sessions. Supports chat, image generation, deep research, and video generation. Sessions use a shared persisted profile by default.

## Architecture (v0.9.0+)

10x-chat uses an **HTTP browser daemon** — a persistent local Node.js server wrapping Playwright:

- **One daemon, multiple sessions**: parallel CLI runs share a single Chrome instance via HTTP RPC
- **Auto-start/stop**: daemon launches on first use, shuts down after 30 min idle
- **Crash recovery**: if daemon dies, next CLI run auto-restarts it
- **No zombie Chrome**: proper tab ref-counting and graceful shutdown
- **State file**: `~/.10x-chat/browser-daemon.json` (port, PID, bearer token, chmod 600)

## Installation

No install needed. Always use `@latest`:

```bash
npx 10x-chat@latest --version
```

Use `npx` (not `bunx` — symlink conflicts in parallel).

## When to use

- **Stuck on a bug**: ask another model for a fresh perspective
- **Code review**: send PR diff to GPT / Claude / Gemini for cross-review
- **Cross-validation**: compare answers from multiple models
- **Knowledge gaps**: leverage a model with different training data
- **Image generation**: DALL-E via ChatGPT or Imagen via Gemini
- **Deep research**: long-form analysis via Perplexity, ChatGPT, or Gemini

## Providers

| Provider | Chat | Image | Research | Models | Notes |
|----------|------|-------|----------|--------|-------|
| chatgpt | ✅ | ✅ (DALL-E) | ✅ | — | Runs headed by default (anti-bot) |
| gemini | ✅ | ✅ (Imagen) | ✅ | Fast, **Thinking** (default), Pro | `--model` switches mode |
| claude | ✅ | ❌ | ❌ | — | Runs headed by default |
| grok | ✅ | ❌ | ❌ | UI changes often, use `@latest` |
| perplexity | ✅ | ❌ | ✅ | Best for research with citations |
| notebooklm | ✅ | ❌ | ❌ | Add sources first, then chat |

## Commands

```bash
# Login (one-time per provider — opens browser for auth)
npx 10x-chat@latest login chatgpt
npx 10x-chat@latest login gemini
npx 10x-chat@latest login claude
npx 10x-chat@latest login grok
npx 10x-chat@latest login perplexity
npx 10x-chat@latest login notebooklm

# Chat
npx 10x-chat@latest chat -p "Review this code for bugs" --provider chatgpt --file "src/**/*.ts"
npx 10x-chat@latest chat --provider gemini --file "path/to/prompt.md" -p "Complete this task"
npx 10x-chat@latest chat --provider gemini --model Pro -p "Solve this math problem"

# Image generation
npx 10x-chat@latest image -p "A fox astronaut in space" --provider chatgpt
npx 10x-chat@latest image -p "Watercolor landscape" --provider gemini --save-dir ./images

# Deep research (long-form, 5-10 min)
npx 10x-chat@latest research -p "Latest breakthroughs in quantum computing" --provider perplexity
npx 10x-chat@latest research -p "Market analysis of EVs" --provider chatgpt --timeout 600000

# Dry run / clipboard
npx 10x-chat@latest chat --dry-run -p "Debug this error" --file src/
npx 10x-chat@latest chat --copy -p "Explain this" --file "src/**"

# Session management
npx 10x-chat@latest status
npx 10x-chat@latest session <id> --render

# NotebookLM
npx 10x-chat@latest notebooklm list
npx 10x-chat@latest notebooklm create "My Research"
npx 10x-chat@latest notebooklm add-url <id> https://...
npx 10x-chat@latest notebooklm add-file <id> ./paper.pdf
npx 10x-chat@latest notebooklm sources <id>
npx 10x-chat@latest notebooklm summarize <id>

# Install bundled skill to coding agent
npx 10x-chat@latest skill install
```

## Parallel sessions (v0.9.0+)

HTTP daemon makes parallel runs stable. All providers share one Chrome:

```bash
# Login all once
npx 10x-chat@latest login gemini
npx 10x-chat@latest login claude
npx 10x-chat@latest login chatgpt

# Run concurrently — each opens a tab in the shared daemon
npx 10x-chat@latest chat --provider gemini -p "Your prompt" --file context.md &
npx 10x-chat@latest chat --provider claude -p "Your prompt" --file context.md &
npx 10x-chat@latest chat --provider chatgpt -p "Your prompt" --file context.md &
wait
```

## Browser mode

- **Headless (default for gemini, grok, perplexity)**: no visible window
- **Headed (default for chatgpt, claude)**: visible Chrome window (anti-bot protection)
- **Force headed**: `--headed` flag on any provider

The daemon stores the headless/headed mode in its state file. If you switch modes, the daemon restarts automatically.

## Profile modes

**Shared (default):** One browser profile, all providers share cookies. Login once per Google account covers Gemini + NotebookLM.

**Isolated:** Separate profile per provider (backward compat): `--isolated-profile`

```bash
# Migrate from isolated to shared
npx 10x-chat@latest migrate
```

## Daemon management

```bash
# Check daemon state
cat ~/.10x-chat/browser-daemon.json

# Force stop daemon
# (CLI calls stopDaemon() on Ctrl+C automatically)
kill $(cat ~/.10x-chat/browser-daemon.json | python3 -c "import sys,json; print(json.load(sys.stdin)['pid'])")
```

## Tips

- **Always use `@latest`**: ensures newest fixes
- **Login first**: `login <provider>` once per provider. Sessions persist in `~/.10x-chat/profiles/`
- **Use `--headed`** if a provider is flaky (Grok especially)
- **Keep file sets small**: fewer files + focused prompt = better answers
- **Research needs longer timeouts**: `--timeout 600000` for 10-min research jobs
- **Image gen can take 1-2 min**: use `--timeout 120000` when needed
- **Use `--dry-run`** to preview what will be sent

## Known issues

- **Grok**: UI changes frequently. Always use `@latest`. Use `--headed` for best reliability
- **ChatGPT/Grok sessions expire quickly**: login again if you get "Not logged in" errors
- **Some provider UIs are flaky under automation**: retry with `--headed` before assuming a hard failure

## Safety

- Never include credentials, API keys, or tokens in the bundled files
- The tool opens a real browser with real login state. Treat it like your own browser session
