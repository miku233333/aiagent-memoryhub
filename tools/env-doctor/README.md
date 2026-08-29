# OmniMemory Env Doctor

一个安全、跨平台优先、默认只读的环境检查与本地配置工具。它面向本仓库的 Memory Hub 与 Claude Code 适配器，帮助用户回答三件事：

1. Node.js、Python、Git、Claude Code 是否可用且版本合适；
2. Claude Code 的 settings、Hooks、MCP 配置是否存在、是否是有效 JSON；
3. 本地 Memory Hub 的端口和 `/health` 是否可达；
4. 经用户明确启用后，两个 Claude 官方域名能否完成 DNS 与受系统信任的 TLS 握手。

`setup` 默认只生成计划。只有显式加入 `--apply` 才会修改本地配置；已有配置会先生成带 UTC 时间戳的备份。

## 快速使用

无需安装第三方 Python 依赖：

```sh
cd tools/env-doctor

# 人类可读报告
python3 -m env_doctor check --project-root ../..

# 机器可读 JSON
python3 -m env_doctor check --project-root ../.. --json

# 可选公网诊断：只探测两个固定官方域名
python3 -m env_doctor check --project-root ../.. --probe-network

# 先预览搭建计划；不会写文件
python3 -m env_doctor setup \
  --project-root ../.. \
  --user-id local-user

# 确认计划后才应用
python3 -m env_doctor setup \
  --project-root ../.. \
  --user-id local-user \
  --apply
```

也可以本地安装命令入口：

```sh
python3 -m pip install ./tools/env-doctor
omnimemory-env check --project-root .
```

`user-id` 是本地、非秘密、稳定的伪名作用域，允许字符为字母、数字、点、下划线和短横线。不要把 API key、token、邮箱或真实身份证明放进去。

## 检查项

| 检查 | 当前门槛/行为 |
| --- | --- |
| Node.js | `>=20`，用于 `adapters/claude-code/bin/hook.mjs` |
| Python | `>=3.12`，用于本仓库 Memory Hub；Env Doctor 自身可在 Python `>=3.10` 运行 |
| uv | 检测到本仓库 `backend/` 时验证；缺失为警告，不自动安装 |
| Git | `>=2.23` |
| Claude Code | 运行 `claude --version` 和官方只读 `claude doctor` |
| 路由与凭据风险 | 只报告自定义 Anthropic endpoint、proxy、credential-like 变量与字面量 MCP header 是否存在/数量，不读取或输出其值 |
| 官方网络连通性 | 默认跳过；显式 `--probe-network` 后只检查 `claude.ai:443` 与 `api.anthropic.com:443` 的 DNS、TCP 与 TLS/SNI |
| Sandbox | 合并检查用户、项目与项目本地 settings；显式关闭文件系统隔离为失败，未启用或允许非 sandbox fallback 为警告 |
| Hooks | 只统计配置文件、事件名与有效性，不输出 handler 内容或环境变量值 |
| MCP | 默认只验证 `claude mcp --help` 并读取配置数量，不连接 MCP server |
| Memory Hub | 仅请求配置 URL 的 `/health`，最多读取 64 KiB，并只保留 `status` 字段 |

如需真正运行 `claude mcp list`，必须显式加 `--probe-mcp`。该命令可能启动或连接已经配置的 MCP server，因此不是默认检查的一部分。

公网网络诊断也必须显式加 `--probe-network`。默认检查不会联系 Claude 公网域名；本地 Memory Hub `/health` 检查仍会访问所配置的 loopback 地址。启用后，目标固定为 `claude.ai:443` 与 `api.anthropic.com:443`，不可传入其他 host 或 URL。每个目标只执行：

1. DNS 解析；
2. 直连 TCP；
3. 带官方域名 SNI、使用 Python/操作系统默认信任链的 TLS 握手。

它不会发送 HTTP 请求、请求路径、Cookie 或业务内容，不使用配置的 HTTP proxy，不跟随重定向，也不查询公网 IP、IP 信誉、地理位置或 STUN。报告只包含是否解析、`ipv4`/`ipv6` 族类数量、TLS 是否验证成功和固定错误分类；不会包含解析出的 IP、proxy 地址或证书内容。失败只记为连通性警告，不推断用户所在国家、账号封禁风险或服务资格。

本仓库后端当前建议由用户审阅后手动启动：

```sh
cd backend
MEMORY_HUB_TOKEN='<generated-local-token>' \
  uv run --no-editable --reinstall-package ai-agent-memory-hub memory-hub
```

`--no-editable` 避免某些 macOS 工作区对 editable `.pth` 的文件标志兼容问题。Env Doctor 只在报告中给出此命令，不会自动运行依赖解析、下载或服务启动。

退出码：

- `0`：报告为通过/警告，或 setup 计划/应用成功；
- `1`：环境报告包含失败项；
- `2`：输入或配置不安全、JSON 无效、计划过期，因而拒绝继续。

## `setup` 会做什么

默认 Hook 入口是：

```text
adapters/claude-code/bin/hook.mjs
```

计划会把下列四个事件合并进项目本地的 `.claude/settings.local.json`：

- `SessionStart`
- `UserPromptSubmit`
- `Stop`
- `SessionEnd`

同时只在缺失时写入 `MEMORY_HUB_URL` 与 `MEMORY_HUB_USER_ID`。现有值不一致时会保留原值并给出警告，不会静默覆盖。已有的其他 `env`、Hooks、权限、模型等设置都会保留。

写入保障：

- dry-run 默认；
- 配置必须是严格 JSON；
- Hook 必须是项目内现有的普通文件，不接受符号链接；
- 写入前校验计划后文件未变化，避免覆盖并发编辑；
- 已有文件先备份为 `*.bak.<UTC timestamp>`；
- 临时文件与目标同目录，完成 `fsync` 后原子替换；
- 重复运行是幂等的，不重复添加相同 Hook。

在普通 Git checkout 中，计划还会把 `/.claude/settings.local.json` 及 Env Doctor 的 settings/MCP 备份模式追加到本机私有的 `.git/info/exclude`，避免误提交个人配置或可能含敏感值的备份，并同样先备份已有 exclude 文件。检测到 worktree 的 `.git` 指针文件时不会猜测公共 Git metadata 路径，而是提示用户手动加入私有 exclude。

可选的 MCP 配置必须另外传入 `--mcp-url`：

```sh
python3 -m env_doctor setup \
  --project-root ../.. \
  --mcp-url http://127.0.0.1:8787/mcp
```

它只会生成不带 headers/凭据的 `mcpServers.omnimemory`。当前 Memory Hub PoC 以 REST API 为主；只有在实际部署了 MCP HTTP endpoint 后才应使用这个选项。Claude Code 对项目级 `.mcp.json` 还会要求 workspace trust/approval。

## 安全与隐私边界

- 不执行 `curl | bash`、`irm | iex` 或任何远端脚本；
- 不自动安装、升级或登录 Node、Python、Git、Claude Code；
- 不读取或打印 secret 值、认证头、Cookie、API key、token；
- 不把 secret 放入命令行、URL、生成的 MCP 配置或报告；
- 不使用 shell 执行版本检查；固定 argv、禁用 stdin，并从子进程环境中移除 credential-like 变量；
- 健康检查默认只允许 `localhost`、`127.0.0.1`、`::1`，且绝不跟随重定向；
- 远程 health/MCP 地址必须显式解锁，URL 仍禁止 userinfo、query 与 fragment；
- 公网诊断默认关闭，开启后也只有两个编译期固定官方 host；不接受任意探测目标，避免 SSRF/端口扫描；
- 公网诊断只做直接 DNS/TCP/TLS 握手，不输出解析 IP、proxy 地址、证书或异常原文；
- 不探测地区、语言、字体、设备品牌、公网 IP、支付方式或账号身份；
- 不提供绕过认证、付费、地区资格、风控或服务条款的能力。

自定义 endpoint 或 proxy 只会触发合规与供应链风险提示；工具不会显示其地址，也不会替用户“清理”、伪装或重写网络环境。Sandbox 检查同样只读，`setup` 不会静默改变 Claude Code 的执行权限或隔离策略。

如果 Claude Code 尚未安装，本工具只会链接到[官方安装与签名验证文档](https://code.claude.com/docs/en/setup)，不会代替用户执行安装。官方目前也提供 Homebrew、WinGet 与签名的软件包仓库方案，适合需要审计安装来源的环境。

Claude Code 配置依据：

- [Settings scopes and files](https://code.claude.com/docs/en/settings)
- [Hooks reference](https://code.claude.com/docs/en/hooks)
- [MCP configuration and approvals](https://code.claude.com/docs/en/mcp)
- [Sandboxing](https://code.claude.com/docs/en/sandboxing)

## 测试

```sh
cd tools/env-doctor
python3 -m unittest discover -s tests -v
```

测试不需要真实 Claude 账号、API key 或外部网络。健康检查测试只启动临时 loopback HTTP server。

## 与 FuckClaude 的关系

本工具仅借鉴 [LinXiaoTao/FuckClaude](https://github.com/LinXiaoTao/FuckClaude) “逐项扫描、分级结果、可执行建议”的产品体验，没有复制其源码、视觉资产、检测信号或规避指南。上游快照、许可证与风险分析见 [UPSTREAM_REVIEW.md](UPSTREAM_REVIEW.md)。
