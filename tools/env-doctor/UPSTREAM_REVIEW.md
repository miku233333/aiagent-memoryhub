# FuckClaude 上游只读审查

审查日期：2026-08-30

仓库：[LinXiaoTao/FuckClaude](https://github.com/LinXiaoTao/FuckClaude)
审查快照：[`3edbe10399e4b9762cac370b3a029854b764d10e`](https://github.com/LinXiaoTao/FuckClaude/tree/3edbe10399e4b9762cac370b3a029854b764d10e)

## 结论

上游是 Astro 7 + TypeScript 的双语浏览器环境评分网站，不是 Claude Code 安装器或通用环境搭建 CLI。它适合借鉴扫描步骤、状态反馈与修复建议的交互结构，但目标与 OmniMemory 环境同步不同；其“地区指纹/防封”能力不应被移植。

本目录没有复制上游源码或资产，因此不形成上游代码的实质性副本。仍在文档中保留来源与审查快照，方便追溯设计启发。

## 仓库、许可证与开发流程

- 默认分支：`master`；审查时仓库有 32 次提交。
- [LICENSE](https://github.com/LinXiaoTao/FuckClaude/blob/3edbe10399e4b9762cac370b3a029854b764d10e/LICENSE) 是 MIT，版权为 `Copyright (c) 2026 LinXiaoTao`。复制或实质性复用必须保留版权与许可声明。
- [package.json](https://github.com/LinXiaoTao/FuckClaude/blob/3edbe10399e4b9762cac370b3a029854b764d10e/package.json) 使用 pnpm；脚本只有 Astro `dev`、`build`、`preview` 等。仓库没有面向 Claude Code 的安装/配置 CLI。
- [README](https://github.com/LinXiaoTao/FuckClaude/blob/3edbe10399e4b9762cac370b3a029854b764d10e/README.md) 的本地开发流程为 `pnpm install`、`pnpm dev`、`pnpm build`、`pnpm preview`；部署目标以 Vercel 为主。
- 主要目录为 `src/`、`public/`、`scripts/` 与 `skills/detection-signals/`。唯一根级辅助脚本主要用于生成站点资产。

## 实际行为

上游浏览器评分会组合时区、语言、字体、浏览器/设备线索、Intl locale、UTC 偏移、emoji 风格和 WebRTC 信号。其 `/api/check` 还会使用 Vercel 提供的 IP 国家/时区、`Accept-Language` 与 `User-Agent` 做服务端估算。

“所有检测都在本地”需要结合其隐私说明理解：

- 页面布局加载 Google Analytics 与 Google AdSense；
- WebRTC 检测可能联系公共 STUN 服务；
- `/api/check` 是网络端点，会基于请求头与 Vercel geo header 返回估算；
- 分享功能会生成外部社交平台 URL。

这些行为不等同于恶意，但不符合 Env Doctor 的默认离线、最小网络与不做地区画像边界。

## 风险与不采用项

1. **结论可靠性**：上游明确表示依据公开逆向报告，并非 Anthropic 官方判断。评分不能证明账号会被标记或封禁。
2. **敏感画像**：以中文语言、字体、设备品牌、地区与公网网络为风险信号，容易把正常身份/地域事实误作需要“清理”的特征。
3. **规避导向**：仓库包含环境伪装、代理、注册支付、多账号和“防封”内容；其中部分内容可能被用于规避地区资格、认证、付费或平台风控。
4. **额外网络面**：GA、广告、STUN、Vercel API 与社交分享扩大了数据暴露面。
5. **安装误解**：它的 `pnpm install` 只安装网站开发依赖，不能搭建 Claude Code 或 Memory Hub 环境。

Env Doctor 明确排除：地区/语言/字体/品牌/IP 评分、代理“纯化”、账号身份伪装、多账号养号、支付规避、认证绕过、服务限制规避与远程脚本直执行。

## 保留的产品启发

- 清楚列出每个环境信号，而不是给出一个黑箱总分；
- 使用 `pass` / `warn` / `fail` / `skip` 和总状态；
- 同时提供人类报告与版本化 JSON；
- 每个失败项给出下一步，但把高影响动作留给用户确认；
- 检测和搭建分离，搭建先预览、后显式应用。
