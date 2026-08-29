import ClaudeIcon from "@lobehub/icons/es/Claude/components/Color";
import GeminiIcon from "@lobehub/icons/es/Gemini/components/Color";
import GrokIcon from "@lobehub/icons/es/Grok/components/Mono";
import HermesAgentIcon from "@lobehub/icons/es/HermesAgent/components/Mono";
import OpenAIIcon from "@lobehub/icons/es/OpenAI/components/Mono";
import OpenClawIcon from "@lobehub/icons/es/OpenClaw/components/Color";
import QoderIcon from "@lobehub/icons/es/Qoder/components/Color";
import type { ComponentType, SVGProps } from "react";

export type PlatformId =
  | "chatgpt_web"
  | "codex"
  | "openclaw"
  | "hermes"
  | "claude_web"
  | "claude_code"
  | "qoder"
  | "gemini_web"
  | "grok_web"
  | "grok_build";

export type ConnectorTone = "success" | "warning" | "neutral" | "primary";

type BrandIconKey =
  | "openai"
  | "openclaw"
  | "hermes"
  | "claude"
  | "qoder"
  | "gemini"
  | "grok";

export interface ConnectorDefinition {
  id: PlatformId;
  name: string;
  icon: BrandIconKey;
  badge?: "Code" | "Build";
  status: string;
  tone: ConnectorTone;
  detail: string;
  automationLevel: string;
  capability: string;
  memoryBoundary: string;
  nextSteps: readonly string[];
  limitations: readonly string[];
}

export const connectors: readonly ConnectorDefinition[] = [
  {
    id: "chatgpt_web",
    name: "ChatGPT Web",
    icon: "openai",
    status: "受限",
    tone: "warning",
    detail: "Template only / remote MCP / plan-dependent",
    automationLevel: "模板级 · 套餐与工作区相关",
    capability: "通过远程 MCP 或应用连接读取经授权的 Hub 上下文",
    memoryBoundary: "无本地生命周期 Hook；不能承诺写入原生 ChatGPT memory。",
    nextSteps: [
      "确认当前 ChatGPT 套餐、工作区与管理员策略允许应用连接或远程 MCP。",
      "准备带 HTTPS、鉴权与最小 scope 的远程端点。",
      "先用一条非敏感上下文做人工读取验证。",
      "将投递状态与 ChatGPT 实际读取回执分开记录。",
    ],
    limitations: [
      "完整 MCP（含写操作）目前是 Business、Enterprise 与 Edu 的 beta；Pro 目前仅可接入 read/fetch 能力。",
      "ChatGPT 只连接远程 MCP；本机服务需要受控的安全隧道或 HTTPS/OAuth 网关。",
      "当前 Hub 的 /mcp 尚未安装传输层，因此这里只提供部署模板。",
      "网页端没有本地会话生命周期 Hook，也没有原生记忆写入回读契约。",
    ],
  },
  {
    id: "codex",
    name: "Codex",
    icon: "openai",
    status: "可接入",
    tone: "success",
    detail: "REST CLI + Hooks",
    automationLevel: "本地自动化",
    capability: "通过 CLI 与本地 Hooks 按项目读取经审批上下文",
    memoryBoundary: "适配器接收不等于写入平台原生记忆。",
    nextSteps: [
      "运行环境医生确认 Node、Hub 与项目目录可用。",
      "为 Codex 配置本地 Hub URL 与项目 scope。",
      "触发一次会话读取并核对适配器回执。",
    ],
    limitations: ["只投影已审批记忆。", "当前回执只证明适配器处理，不证明平台永久保存。"],
  },
  {
    id: "openclaw",
    name: "OpenClaw",
    icon: "openclaw",
    status: "待验证",
    tone: "neutral",
    detail: "Plugin contract",
    automationLevel: "插件契约",
    capability: "计划通过插件入口请求项目级上下文",
    memoryBoundary: "尚无目标端 digest 回读，不能声称自动同步完成。",
    nextSteps: [
      "确认 OpenClaw 插件目录与版本。",
      "安装最小 Hub 连接配置。",
      "完成一次受控会话读取与失败回退测试。",
    ],
    limitations: ["当前为待验证契约。", "插件 API 变更时必须重新验证。"],
  },
  {
    id: "hermes",
    name: "Hermes",
    icon: "hermes",
    status: "待验证",
    tone: "neutral",
    detail: "Provider contract",
    automationLevel: "提供方契约",
    capability: "计划通过 Hermes Agent 提供方配置注入上下文",
    memoryBoundary: "没有目标端持久记忆写入保证。",
    nextSteps: [
      "确认 Hermes Agent 当前 provider 配置格式。",
      "绑定本地 Hub 与用户/项目 scope。",
      "验证启动、压缩与结束场景的上下文边界。",
    ],
    limitations: ["当前尚未完成端到端验证。", "模型上下文不等同于长期原生记忆。"],
  },
  {
    id: "claude_web",
    name: "Claude",
    icon: "claude",
    status: "受限",
    tone: "warning",
    detail: "Remote MCP",
    automationLevel: "远程读取",
    capability: "通过受保护的 Remote MCP 暴露最小必要上下文",
    memoryBoundary: "Claude 网页版无本地生命周期 Hook；不承诺原生记忆写入。",
    nextSteps: [
      "确认帐号、套餐与地区支持当前官方功能。",
      "部署带 OAuth、HTTPS 与最小 scope 的 Remote MCP。",
      "人工确认一次读取结果和撤销路径。",
    ],
    limitations: ["不能绕过帐号、套餐或地区限制。", "远程端点准备完成不等于 Claude 已读取。"],
  },
  {
    id: "claude_code",
    name: "Claude Code",
    icon: "claude",
    badge: "Code",
    status: "可接入",
    tone: "success",
    detail: "Hooks + MCP",
    automationLevel: "会话生命周期自动化",
    capability: "通过 Session/Hooks 与 MCP 自动准备项目上下文",
    memoryBoundary: "Hook 回执不等于写入 Claude 原生记忆。",
    nextSteps: [
      "用环境医生验证 Claude Code、Hook 文件和 Hub 健康。",
      "配置用户 ID、项目 scope 与四个生命周期事件。",
      "启动一次新会话并核对上下文 digest。",
    ],
    limitations: ["Hub 故障时不阻塞 Claude Code；敏感内容仍在本地阻断。", "只发送经过审批与敏感信息检查的投影。"],
  },
  {
    id: "qoder",
    name: "Qoder",
    icon: "qoder",
    status: "起步包",
    tone: "neutral",
    detail: "Hooks wrapper",
    automationLevel: "起步封装",
    capability: "通过最小 Hooks wrapper 准备 Hub 上下文",
    memoryBoundary: "尚无稳定目标端回读，不能声称已同步。",
    nextSteps: [
      "确认 Qoder 当前扩展或 Hook 接口。",
      "生成只读起步配置并人工检查。",
      "完成一次项目隔离与撤销测试。",
    ],
    limitations: ["适配接口仍需实机确认。", "不修改 Qoder 帐号、认证或平台限制。"],
  },
  {
    id: "gemini_web",
    name: "Gemini",
    icon: "gemini",
    status: "受限",
    tone: "warning",
    detail: "Spark MCP",
    automationLevel: "网页端受限读取",
    capability: "在产品支持的连接能力内准备最小上下文",
    memoryBoundary: "网页端没有本地生命周期 Hook，也不承诺原生记忆写入。",
    nextSteps: [
      "确认当前 Gemini 产品入口支持的连接方式。",
      "配置最小 scope 的服务端连接。",
      "人工验证读取结果与断开连接流程。",
    ],
    limitations: ["功能可能受帐号、地区与工作区策略影响。", "当前没有目标端持久化回读。"],
  },
  {
    id: "grok_web",
    name: "Grok",
    icon: "grok",
    status: "受限",
    tone: "warning",
    detail: "Custom MCP",
    automationLevel: "自定义连接",
    capability: "在官方支持范围内通过自定义连接读取上下文",
    memoryBoundary: "网页会话读取不等于原生长期记忆。",
    nextSteps: [
      "确认 Grok 当前帐号与产品入口的连接能力。",
      "配置鉴权端点与最小 scope。",
      "用非敏感上下文验证读取和撤销。",
    ],
    limitations: ["不能绕过产品或帐号限制。", "当前无本地生命周期 Hook。"],
  },
  {
    id: "grok_build",
    name: "Grok Build",
    icon: "grok",
    badge: "Build",
    status: "起步包",
    tone: "neutral",
    detail: "CLI hooks",
    automationLevel: "CLI 起步包",
    capability: "计划通过 CLI Hooks 请求项目级上下文",
    memoryBoundary: "起步包只准备上下文，不声明目标已保存。",
    nextSteps: [
      "确认 Grok Build 当前 CLI 与 Hook 契约。",
      "生成项目级只读配置。",
      "验证一次注入、失败回退和清理流程。",
    ],
    limitations: ["当前适配状态为起步包。", "CLI/Hook 契约变化后需要重新验证。"],
  },
] as const;

export const connectorById = Object.fromEntries(
  connectors.map((connector) => [connector.id, connector]),
) as Record<PlatformId, ConnectorDefinition>;

type BrandIcon = ComponentType<
  SVGProps<SVGSVGElement> & { size?: number | string }
>;

const brandIcons: Record<BrandIconKey, BrandIcon> = {
  openai: OpenAIIcon,
  openclaw: OpenClawIcon,
  hermes: HermesAgentIcon,
  claude: ClaudeIcon,
  qoder: QoderIcon,
  gemini: GeminiIcon,
  grok: GrokIcon,
};

export function PlatformIcon({
  connector,
  size = "default",
}: {
  connector: ConnectorDefinition;
  size?: "default" | "large";
}) {
  const Icon = brandIcons[connector.icon];
  const iconSize = size === "large" ? 27 : 20;
  return (
    <span
      className={`platform-icon platform-${connector.icon} platform-icon-${size}`}
      role="img"
      aria-label={`${connector.name} 品牌图标`}
      data-platform={connector.id}
    >
      <Icon aria-hidden="true" focusable="false" size={iconSize} />
      {connector.badge ? (
        <span className="platform-icon-badge" aria-hidden="true">
          {connector.badge}
        </span>
      ) : null}
    </span>
  );
}
