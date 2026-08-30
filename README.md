# AI Agent MemoryHub

**简体中文** | [繁體中文](README.zh-TW.md) | [日本語](README.ja.md) | [English](README.en.md)

**AI Agent MemoryHub** 是一个本地优先、可审计的跨 AI 客户端记忆同步项目。它把 Memory Hub 作为唯一 canonical 真源，把经授权、按目标生成的上下文投影交给 Claude Code、Claude Web 与其他适配器；不会把厂商内部的聊天历史或原生记忆误称为已写入。

当前版本：`0.1.0`。公开仓库：
[`miku233333/aiagent-memoryhub`](https://github.com/miku233333/aiagent-memoryhub)。

## 桌面应用

项目包含基于 Electron 40 的跨平台桌面应用：应用启动后自动拉起内置本地 Hub，使用现有 React/Vite 控制台，并把 canonical SQLite 数据保存在用户应用数据目录。用户不需要分别启动 Python 后端和 Web 开发服务器。

桌面应用首次启动会在同一用户数据目录生成一枚权限受限的本地 Hub 凭证。Electron 只会把它附加到精确的 `127.0.0.1:8787` 请求；适配器可从该私有文件读取，不需要把 token 复制进项目配置或界面。

```sh
./script/package_desktop.sh mac
```

macOS 构建产生 DMG/ZIP；Windows 构建使用
`./script/package_desktop.sh win` 产生 NSIS 安装包。应用通过
`electron-updater` 检查固定 GitHub 仓库的最新 Release；发现更高版本后先提示用户，不会在未确认时下载或安装。

完整架构、签名状态与发布检查见 [桌面应用说明](docs/desktop-app.md)。

## 当前可以运行的纵向闭环

```mermaid
flowchart LR
    A["客户端 Hook / MCP"] --> B["记忆提案"]
    B --> C["用户审批"]
    C --> D["SQLite canonical memory"]
    D --> E["Scope + secret 检查"]
    E --> F["目标投影"]
    F --> G["客户端上下文"]
    G -. "回执或 digest 回读" .-> H["审计状态"]
```

- FastAPI + SQLite Memory Hub：提案、审批、检索、上下文包、遗忘 tombstone、幂等 checkpoint。
- React 控制台：总览、记忆、上下文、连接器、环境检测、Claude 帐号安全、审计与投影设置。
- Claude Code：4 个 lifecycle Hooks、增量 JSONL cursor、上下文注入与提案/checkpoint。
- Claude Web：可运行的 Streamable HTTP REST→MCP bridge；真实远程连接仍需 HTTPS/OAuth 网关。
- Codex：无依赖 REST CLI + Hook runtime；Qoder 与 Grok Build 复用该安全 runtime。
- ChatGPT Web：独立的远程 MCP 应用模板；与 Codex 分开显示，受套餐和工作区策略限制，不能声称写入 ChatGPT 原生记忆。
- OpenClaw 与 Hermes：已做 host-independent 合约测试的插件/provider 骨架；真实宿主加载仍待验证。
- Gemini Spark 与 Grok Web：仅远程 MCP 模板；当前 Hub `/mcp` 明确返回 501，不能声称已接通。
- 国际化表达润色：仅生成 Claude/Claude Code 出站 projection，默认关闭，canonical 永不改写。
- Env Doctor：只读检查 + dry-run 搭建计划；只有显式 `--apply` 才写本地 Claude Code 配置。

其他客户端的能力与当前实现等级见 [平台能力矩阵](docs/platform-capabilities.md)。

## 本地启动

要求 Python 3.12+、[`uv`](https://docs.astral.sh/uv/) 与 Node.js 20+。

如果只是使用桌面版，运行 `./script/build_and_run.sh` 即可。需要分别调试后端与前端时，先为本次开发会话生成一枚临时本地 token；它只留在两个终端的环境变量中：

```sh
python3 -c 'import secrets; print(secrets.token_urlsafe(32))'
```

把输出记为 `<local-token>`。终端一：

```sh
cd backend
uv sync --extra dev
MEMORY_HUB_TOKEN='<local-token>' uv run --no-editable --reinstall-package ai-agent-memory-hub memory-hub
```

终端二：

```sh
cd web
corepack pnpm install --frozen-lockfile
MEMORY_HUB_TOKEN='<local-token>' corepack pnpm dev
```

打开 `http://127.0.0.1:4173`。Vite 会把 `/health` 与 `/v1` 代理到默认的 Hub 地址 `http://127.0.0.1:8787`；后端不可用时，控制台会明确显示“演示数据”。

## 环境检测与安全搭建

```sh
cd tools/env-doctor

# 只读检查
python3 -m env_doctor check --project-root ../.. --json

# 显式联网：只对两个 Claude 官方域名做 DNS/TLS，不查询公网 IP 或地理位置
python3 -m env_doctor check --project-root ../.. --probe-network --json

# 只生成变更计划
python3 -m env_doctor setup --project-root ../.. --user-id local-user

# 审阅后才应用；写入前会备份
python3 -m env_doctor setup --project-root ../.. --user-id local-user --apply
```

完整行为与恢复边界见 [Env Doctor README](tools/env-doctor/README.md)。

## Claude 接入

- [Claude Code adapter](adapters/claude-code/README.md)：复制/注册插件 Hook，配置固定的本地 user/project scope。
- [Claude Web MCP bridge](adapters/claude-web/README.md)：本地可验证 MCP 工具；接入真实 Claude Custom Connector 前必须增加公网 HTTPS、鉴权和部署级访问控制。

“Hook 成功”只表示上下文已注入；“HTTP 2xx”只表示适配器已接收。只有目标以同一 nonce、scope 与 digest 回读时，界面才允许显示“已同步”。

## 验证

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

这是本地单用户 PoC，不包含多租户身份系统、托管数据库或内置远程 OAuth 网关，也没有在真实 Claude/ChatGPT 账号中完成最终 UI 验证。桌面包会生成本机 bearer 并保持 loopback-only；单独开发启动也必须为 `/v1` 配置同一 bearer。若要远程部署，必须另行提供认证、TLS、租户边界、DLP、速率限制与可撤销的交付回执。
