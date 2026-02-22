---
name: 10x-chat
description: Chat with web AI agents (ChatGPT, Gemini, Claude) via browser automation. Use when stuck, need cross-validation, or want a second-model review.
---

# 10x-chat — AI Agent Skill

Use 10x-chat to send prompts to web-based AI agents (ChatGPT, Gemini, Claude) via automated browser sessions. The browser uses a persisted Chrome profile, so the user only needs to login once.

## When to use

- **Stuck on a bug**: ask another model for a fresh perspective.
- **Code review**: send PR diff to GPT / Claude / Gemini for cross-review.
- **Cross-validation**: compare answers from multiple models.
- **Knowledge gaps**: leverage a model with different training data / reasoning.

## Commands

use `bunx` (bun.sh) instead `npx` if you prefer speed.

```bash
# Login (one-time per provider — opens browser for user to authenticate)
npx 10x-chat login chatgpt
npx 10x-chat login gemini
npx 10x-chat login claude
npx 10x-chat login grok

# Chat with a single provider
npx 10x-chat chat -p "Review this code for bugs" --provider chatgpt --file "src/**/*.ts"

# Multi-provider fan-out (coming v0.2)
# npx 10x-chat chat -p "Review this PR" --providers chatgpt,gemini,claude --file "src/**"

# Dry run (preview the prompt bundle without sending)
npx 10x-chat chat --dry-run -p "Debug this error" --file src/

# Copy bundle to clipboard (manual paste fallback)
npx 10x-chat chat --copy -p "Explain this" --file "src/**"

# Check recent sessions
npx 10x-chat status

# View a session's response
npx 10x-chat session <id> --render
```

## Tips

- **Login first**: Run `npx 10x-chat login <provider>` once per provider. The session persists.
- **Keep file sets small**: fewer files + a focused prompt = better answers.
- **Don't send secrets**: exclude `.env`, key files, auth tokens from `--file` patterns.
- **Use `--dry-run`** to preview what will be sent before committing to a run.
- **Timeouts**: Default is 5 minutes. Use `--timeout <ms>` for long-thinking models.

## Safety

- Never include credentials, API keys, or tokens in the bundled files.
- The tool opens a real browser with real login state — treat it like your own browser session.
