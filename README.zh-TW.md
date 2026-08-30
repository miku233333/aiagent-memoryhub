# AI Agent MemoryHub

[简体中文](README.md) | **繁體中文** | [日本語](README.ja.md) | [English](README.en.md)

**AI Agent MemoryHub** 是一個本機優先、可稽核的跨 AI 用戶端記憶同步專案。它以 Memory Hub 作為唯一的 canonical 真實來源，將經過授權、依目標產生的上下文投影提供給 Claude Code、Claude Web 與其他適配器；不會把供應商內部的聊天記錄或原生記憶誤稱為已寫入。

目前版本：`0.1.0`。公開儲存庫：
[`miku233333/aiagent-memoryhub`](https://github.com/miku233333/aiagent-memoryhub)。

## 桌面應用程式

專案包含以 Electron 40 建置的跨平台桌面應用程式：應用程式啟動後會自動啟動內建的本機 Hub，使用現有的 React/Vite 控制台，並將 canonical SQLite 資料儲存在使用者的應用程式資料目錄中。使用者不需要分別啟動 Python 後端與 Web 開發伺服器。

桌面應用程式首次啟動時，會在同一個使用者資料目錄中產生一枚權限受限的本機 Hub 憑證。Electron 只會把它附加到精確的 `127.0.0.1:8787` 請求；適配器可從該私有檔案讀取，無須把 token 複製到專案設定或介面中。

```sh
./script/package_desktop.sh mac
```

macOS 建置會產生 DMG/ZIP；Windows 建置使用
`./script/package_desktop.sh win` 產生 NSIS 安裝程式。應用程式透過
`electron-updater` 檢查固定 GitHub 儲存庫的最新 Release；發現較新版本後會先提示使用者，不會在未經確認時下載或安裝。

完整架構、簽署狀態與發佈檢查請參閱[桌面應用程式說明](docs/desktop-app.md)。

## 目前可執行的縱向閉環

```mermaid
flowchart LR
    A["用戶端 Hook / MCP"] --> B["記憶提案"]
    B --> C["使用者審批"]
    C --> D["SQLite canonical memory"]
    D --> E["Scope + secret 檢查"]
    E --> F["目標投影"]
    F --> G["用戶端上下文"]
    G -. "回執或 digest 回讀" .-> H["稽核狀態"]
```

- FastAPI + SQLite Memory Hub：提案、審批、檢索、上下文套件、遺忘 tombstone、冪等 checkpoint。
- React 控制台：總覽、記憶、上下文、連接器、環境檢測、Claude 帳戶安全、稽核與投影設定。
- Claude Code：4 個 lifecycle Hooks、增量 JSONL cursor、上下文注入與提案/checkpoint。
- Claude Web：可執行的 Streamable HTTP REST→MCP bridge；真實遠端連線仍需要 HTTPS/OAuth 閘道。
- Codex：無相依性的 REST CLI + Hook runtime；Qoder 與 Grok Build 共用該安全 runtime。
- ChatGPT Web：獨立的遠端 MCP 應用程式範本；與 Codex 分開顯示，受方案與工作區原則限制，不能聲稱已寫入 ChatGPT 原生記憶。
- OpenClaw 與 Hermes：已完成 host-independent 合約測試的外掛/provider 骨架；仍待在真實宿主中驗證載入。
- Gemini Spark 與 Grok Web：僅提供遠端 MCP 範本；目前 Hub `/mcp` 明確回傳 501，不能聲稱已接通。
- 國際化表達潤飾：只產生 Claude/Claude Code 的出站 projection，預設關閉，永不改寫 canonical。
- Env Doctor：唯讀檢查 + dry-run 建置計畫；只有明確使用 `--apply` 才會寫入本機 Claude Code 設定。

其他用戶端的能力與目前實作層級，請參閱[平台能力矩陣](docs/platform-capabilities.md)。

## 本機啟動

需要 Python 3.12+、[`uv`](https://docs.astral.sh/uv/) 與 Node.js 20+。

如果只使用桌面版，執行 `./script/build_and_run.sh` 即可。需要分別偵錯後端與前端時，請先為本次開發工作階段產生一枚臨時本機 token；它只會保留在兩個終端機的環境變數中：

```sh
python3 -c 'import secrets; print(secrets.token_urlsafe(32))'
```

將輸出記為 `<local-token>`。終端機一：

```sh
cd backend
uv sync --extra dev
MEMORY_HUB_TOKEN='<local-token>' uv run --no-editable --reinstall-package ai-agent-memory-hub memory-hub
```

終端機二：

```sh
cd web
corepack pnpm install --frozen-lockfile
MEMORY_HUB_TOKEN='<local-token>' corepack pnpm dev
```

開啟 `http://127.0.0.1:4173`。Vite 會把 `/health` 與 `/v1` 代理至預設的 Hub 位址 `http://127.0.0.1:8787`；後端無法使用時，控制台會明確顯示「示範資料」。

## 環境檢測與安全建置

```sh
cd tools/env-doctor

# 唯讀檢查
python3 -m env_doctor check --project-root ../.. --json

# 明確連線：只對兩個 Claude 官方網域執行 DNS/TLS，不查詢公網 IP 或地理位置
python3 -m env_doctor check --project-root ../.. --probe-network --json

# 只產生變更計畫
python3 -m env_doctor setup --project-root ../.. --user-id local-user

# 審閱後才套用；寫入前會備份
python3 -m env_doctor setup --project-root ../.. --user-id local-user --apply
```

完整行為與復原邊界請參閱 [Env Doctor README](tools/env-doctor/README.md)。

## Claude 整合

- [Claude Code adapter](adapters/claude-code/README.md)：複製/註冊外掛 Hook，設定固定的本機 user/project scope。
- [Claude Web MCP bridge](adapters/claude-web/README.md)：可在本機驗證的 MCP 工具；接入真實 Claude Custom Connector 前，必須增加公網 HTTPS、驗證與部署層級的存取控制。

「Hook 成功」只表示上下文已注入；「HTTP 2xx」只表示適配器已接收。只有目標以相同的 nonce、scope 與 digest 完成回讀時，介面才允許顯示「已同步」。

## 驗證

```sh
(cd backend && uv run --no-editable pytest -q && uv run --no-editable ruff check . && uv run --no-editable ruff format --check . && uv build)
(cd web && corepack pnpm test && corepack pnpm build)
(cd adapters/claude-code && npm test && npm run check)
(cd adapters/claude-web && npm test && npm run check)
(cd adapters/codex && npm test)
(cd adapters/openclaw && npm test)
(cd adapters/hermes && python3 -m unittest discover -s tests -v)
(cd tools/env-doctor && python3 -m unittest discover -s tests -v)
```

這是本機單一使用者 PoC，不包含多租戶身分系統、託管資料庫或內建遠端 OAuth 閘道，也尚未在真實 Claude/ChatGPT 帳戶中完成最終 UI 驗證。桌面套件會產生本機 bearer 並維持 loopback-only；個別啟動開發環境時，也必須為 `/v1` 設定相同的 bearer。若要遠端部署，必須另行提供驗證、TLS、租戶邊界、DLP、速率限制，以及可撤銷的交付回執。
