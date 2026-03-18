---
name: 10x-chat
description: Chat with web AI agents (ChatGPT, Gemini, Claude, Grok, Perplexity, NotebookLM) via browser automation, plus image generation and deep research workflows. Use when stuck on a bug, need cross-validation, want a second-model review, need browser-only model access, want long-form research, or need image generation from web AI tools.
---

# 10x-chat — AI Agent Skill

Use 10x-chat to send prompts to web-based AI agents (ChatGPT, Gemini, Claude, Grok, Perplexity, NotebookLM) via automated browser sessions. It also supports image generation and deep research flows. Sessions use the shared persisted profile by default, so the user usually only needs to log in once per provider.

## Installation

No install needed. Always use `@latest` to get the newest version:

```bash
npx 10x-chat@latest --version    # check current version
```

Prefer `npx` over `bunx` — `bunx` has symlink conflicts when running multiple providers in parallel.

## When to use

- **Stuck on a bug**: ask another model for a fresh perspective.
- **Code review**: send PR diff to GPT / Claude / Gemini for cross-review.
- **Cross-validation**: compare answers from multiple models.
- **Knowledge gaps**: leverage a model with different training data / reasoning.

## Commands

```bash
# Login (one-time per provider — opens browser for user to authenticate)
npx 10x-chat@latest login chatgpt
npx 10x-chat@latest login gemini
npx 10x-chat@latest login claude
npx 10x-chat@latest login grok
npx 10x-chat@latest login perplexity
npx 10x-chat@latest login notebooklm

# Chat with a single provider
npx 10x-chat@latest chat -p "Review this code for bugs" --provider chatgpt --file "src/**/*.ts"

# Chat with file context
npx 10x-chat@latest chat --provider gemini --file "path/to/prompt.md" -p "Complete this task"

# Generate images
npx 10x-chat@latest image -p "A fox astronaut in space, digital art" --provider chatgpt
npx 10x-chat@latest image -p "Watercolor landscape" --provider gemini --save-dir ./images

# Run deep research
npx 10x-chat@latest research -p "Latest breakthroughs in quantum computing" --provider perplexity
npx 10x-chat@latest research -p "Market analysis of EVs" --provider chatgpt --timeout 600000

# Dry run (preview the prompt bundle without sending)
npx 10x-chat@latest chat --dry-run -p "Debug this error" --file src/

# Copy bundle to clipboard (manual paste fallback)
npx 10x-chat@latest chat --copy -p "Explain this" --file "src/**"

# Check recent sessions
npx 10x-chat@latest status

# View a session's response
npx 10x-chat@latest session <id> --render

# Install bundled skill to ~/.codex/skills/
npx 10x-chat@latest skill install

# NotebookLM — manage notebooks & sources
npx 10x-chat@latest notebooklm list                         # List notebooks
npx 10x-chat@latest notebooklm create "My Research"         # Create notebook
npx 10x-chat@latest notebooklm add-url <id> https://...     # Add URL source
npx 10x-chat@latest notebooklm add-file <id> ./paper.pdf    # Upload file source
npx 10x-chat@latest notebooklm sources <id>                 # List sources
npx 10x-chat@latest notebooklm summarize <id>               # AI summary
npx 10x-chat@latest chat -p "Summarize" --provider notebooklm
```

## Multi-provider workflow

Prefer `npx 10x-chat@latest`. Shared profile mode is the default, so parallel runs are supported more reliably than before, but sequential runs are still the safest choice when debugging flaky provider UIs.

```bash
# Login all providers first
npx 10x-chat@latest login gemini
npx 10x-chat@latest login claude
npx 10x-chat@latest login chatgpt
npx 10x-chat@latest login grok

# Safer sequential review flow
npx 10x-chat@latest chat --provider gemini --headed -p "Your prompt" --file context.md
npx 10x-chat@latest chat --provider claude --headed -p "Your prompt" --file context.md
npx 10x-chat@latest chat --provider chatgpt --headed -p "Your prompt" --file context.md
npx 10x-chat@latest chat --provider grok --headed -p "Your prompt" --file context.md
```

## Tips

- **Always use `@latest`**: ensures you get the newest fixes.
- **Use `--headed`** for Grok and ChatGPT when reliability matters.
- **Login first**: Run `npx 10x-chat@latest login <provider>` once per provider. Sessions persist in `~/.10x-chat/profiles/`.
- **Deep research needs longer timeouts**: use `research --timeout 600000` for long jobs.
- **Image generation can take 1–2 minutes**: use `image --timeout 120000` when needed.
- **Keep file sets small**: fewer files + a focused prompt = better answers.
- **Don't send secrets**: exclude `.env`, key files, auth tokens from `--file` patterns.
- **Use `--dry-run`** to preview what will be sent before committing to a run.
- **NotebookLM**: add sources first, then chat with `--provider notebooklm`.

## Known issues

- **Grok**: UI changes frequently. If response capture fails, selectors may need updating.
- **ChatGPT/Grok sessions expire quickly**: log in again if you get "Not logged in" errors.
- **Some provider UIs are flaky under automation**: retry with `--headed` before assuming a hard failure.

## Safety

- Never include credentials, API keys, or tokens in the bundled files.
- The tool opens a real browser with real login state — treat it like your own browser session.
