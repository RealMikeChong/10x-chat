# 10x-chat

> 透過瀏覽器自動化，從終端機與網頁 AI 助手（ChatGPT、Gemini、Claude、Grok、NotebookLM）對話。

10x-chat 使用 [Playwright](https://playwright.dev) 自動化瀏覽器工作階段，並保存登入設定。只需登入一次，即可從 CLI 或 AI 編碼助手發送提示——自動附帶檔案內容。

[English](./README.md) | **繁體中文**

## 搭配 OpenClaw 使用

將以下連結貼到 [OpenClaw](https://openclaw.ai) 聊天中即可安裝為技能：

```
https://raw.githubusercontent.com/RealMikeChong/10x-chat/refs/heads/main/skills/10x-chat/SKILL.md
```

## 快速開始

```bash
npx playwright install chromium  # 一次性瀏覽器安裝

# 1. 登入提供者（會開啟瀏覽器視窗）
npx 10x-chat@latest login chatgpt

# 2. 發送提示
npx 10x-chat@latest chat -p "解釋這個錯誤" --provider chatgpt --file "src/**/*.ts"

# 3. 檢視工作階段歷史
npx 10x-chat@latest status
```

> [!TIP]
> 使用 `bunx`（bun.sh）取代 `npx` 可加快啟動速度。

## 指令

### `login <provider>`

開啟有界面的瀏覽器供您驗證身份。工作階段會跨次執行保留。

```bash
npx 10x-chat@latest login chatgpt       # 登入 ChatGPT
npx 10x-chat@latest login gemini         # 登入 Gemini
npx 10x-chat@latest login claude         # 登入 Claude
npx 10x-chat@latest login grok           # 登入 Grok
npx 10x-chat@latest login notebooklm     # 登入 NotebookLM
npx 10x-chat@latest login --status       # 檢查所有提供者的登入狀態
```

### `chat`

透過瀏覽器自動化向 AI 提供者發送提示。

```bash
npx 10x-chat@latest chat -p "檢查這段程式碼的錯誤" --provider chatgpt --file "src/**/*.ts"
npx 10x-chat@latest chat -p "除錯這個錯誤" --file "logs/error.log"
npx 10x-chat@latest chat -p "解釋一下" --dry-run              # 預覽打包內容但不發送
npx 10x-chat@latest chat -p "解釋一下" --copy                  # 將打包內容複製到剪貼簿
npx 10x-chat@latest chat -p "長時間任務" --timeout 600000 --headed  # 10 分鐘逾時，顯示瀏覽器
```

| 參數 | 說明 |
|------|------|
| `-p, --prompt <text>` | **（必填）** 要發送的提示 |
| `--provider <name>` | 提供者：`chatgpt`、`gemini`、`claude`、`grok`、`notebooklm`（預設：設定檔） |
| `--model <name>` | 要在 UI 中選擇的模型 |
| `-f, --file <paths...>` | 要作為上下文打包的檔案/glob 模式 |
| `--copy` | 將打包內容複製到剪貼簿而不發送 |
| `--dry-run` | 預覽打包內容但不發送 |
| `--headed` | 在聊天期間顯示瀏覽器視窗 |
| `--timeout <ms>` | 回應逾時（毫秒，預設：300000） |

### `status`

列出最近的聊天工作階段。

```bash
npx 10x-chat@latest status              # 最近 24 小時
npx 10x-chat@latest status --hours 72   # 最近 3 天
```

### `session <id>`

檢視特定工作階段的詳細資訊。

```bash
npx 10x-chat@latest session <id> --render   # 格式化輸出回應
```

### `config`

檢視或修改設定。

```bash
npx 10x-chat@latest config show
npx 10x-chat@latest config set provider gemini
npx 10x-chat@latest config set timeout 600000
npx 10x-chat@latest config set headless false
```

### `skill`

管理代理整合技能（適用於 Codex、Claude Code 等）。

```bash
npx 10x-chat@latest skill install   # 安裝 SKILL.md 到 ~/.codex/skills/
npx 10x-chat@latest skill show      # 顯示 SKILL.md 內容
```

### `notebooklm`（別名：`nb`）

透過 RPC API 管理 NotebookLM 筆記本和來源。

```bash
npx 10x-chat@latest notebooklm list                              # 列出所有筆記本
npx 10x-chat@latest notebooklm create "研究主題"                   # 建立筆記本
npx 10x-chat@latest notebooklm delete <notebookId>                # 刪除筆記本
npx 10x-chat@latest notebooklm sources <notebookId>               # 列出筆記本中的來源
npx 10x-chat@latest notebooklm add-url <notebookId> <url>         # 新增網址來源
npx 10x-chat@latest notebooklm add-url <notebookId> <url> --wait  # 新增網址並等待處理
npx 10x-chat@latest notebooklm add-file <notebookId> ./paper.pdf  # 上傳檔案來源
npx 10x-chat@latest notebooklm add-text <id> "標題" "內容"         # 新增文字來源
npx 10x-chat@latest notebooklm summarize <notebookId>             # AI 摘要與建議主題

# 接著與筆記本的來源對話：
npx 10x-chat@latest chat -p "摘要重點" --provider notebooklm
```

## 檔案打包

`--file` 參數接受 glob 模式。檔案會組裝成 Markdown 打包內容作為提示發送：

```bash
npx 10x-chat@latest chat -p "檢查這些檔案" --file "src/**/*.ts" "!src/**/*.test.ts"
```

安全敏感檔案（`.env*`、`*.pem`、`*.key` 等）會自動排除。

## 資料目錄結構

```
~/.10x-chat/
├── profiles/
│   ├── chatgpt/          # Playwright 持久化瀏覽器設定
│   ├── gemini/
│   ├── claude/
│   ├── grok/
│   └── notebooklm/       # NotebookLM 瀏覽器設定（共用 Google 驗證）
├── sessions/
│   └── <uuid>/
│       ├── meta.json     # 工作階段中繼資料
│       ├── bundle.md     # 發送的提示打包
│       └── response.md   # 擷取的回應
└── config.json           # 使用者設定
```

## 代理整合

10x-chat 內附 `SKILL.md` 供 AI 編碼助手使用。安裝方式：

```bash
npx 10x-chat@latest skill install
```

這讓 Codex 或 Claude Code 等助手可以使用 10x-chat 查詢其他模型，進行交叉驗證、程式碼審查或除錯協助。

## 支援的提供者

| 提供者 | 狀態 | 網址 |
|--------|------|------|
| ChatGPT | ✅ | chatgpt.com |
| Gemini | ✅ | gemini.google.com |
| Claude | ✅ | claude.ai |
| Grok | ✅ | grok.com |
| NotebookLM | ✅ | notebooklm.google.com |

## 開發

```bash
bun install
bun run dev login chatgpt      # 以開發模式執行 CLI
bun run typecheck               # 型別檢查
bun run lint                    # 程式碼檢查
bun run test                    # 執行測試
bun run build                   # 建置正式版本
```

## 發佈

發佈透過 GitHub Actions 自動化。推送版本標籤即可發佈：

```bash
npm version patch   # 或 minor / major
git push --follow-tags
```

需要在 GitHub 儲存庫設定中配置 `NPM_TOKEN` 密鑰。

## 授權

MIT
