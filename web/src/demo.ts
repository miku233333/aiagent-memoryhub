import type { HubSnapshot, MemoryItem, ProjectionSettings } from "./types";

const now = new Date();
const iso = (minutesAgo: number) =>
  new Date(now.getTime() - minutesAgo * 60_000).toISOString();

export const demoMemories: MemoryItem[] = [
  {
    id: "mem_demo_approved_1",
    scope: { user_id: "local-user", project_id: "agent-sync" },
    content: "用户偏好先给结论，再提供必要的技术细节。",
    status: "approved",
    explicit_user_fact: true,
    source_platform: "codex",
    metadata: { kind: "preference" },
    created_at: iso(82),
    updated_at: iso(76),
    approved_at: iso(76),
  },
  {
    id: "mem_demo_approved_2",
    scope: { user_id: "local-user", project_id: "agent-sync" },
    content: "中国大陆境内服务器需要完成适用的备案要求；国际互联网访问经香港节点路由；每天中国标准时间（UTC+8）09:00 检查。",
    status: "approved",
    explicit_user_fact: true,
    source_platform: "claude_code",
    metadata: { kind: "narrative" },
    created_at: iso(49),
    updated_at: iso(42),
    approved_at: iso(42),
  },
];

export const demoProposals: MemoryItem[] = [
  {
    id: "mem_demo_pending_1",
    scope: { user_id: "local-user", project_id: "agent-sync" },
    content: "该项目可能更偏好使用 SQLite 作为本地真源。",
    status: "pending",
    explicit_user_fact: false,
    source_platform: "claude_code",
    metadata: { kind: "preference", confidence: 0.78 },
    created_at: iso(13),
    updated_at: iso(13),
  },
  {
    id: "mem_demo_pending_2",
    scope: { user_id: "local-user", project_id: "agent-sync" },
    content: "跨平台上下文应优先使用经过审批的项目级记忆。",
    status: "pending",
    explicit_user_fact: false,
    source_platform: "openclaw",
    metadata: { kind: "narrative", confidence: 0.71 },
    created_at: iso(28),
    updated_at: iso(28),
  },
];

export const demoSnapshot: HubSnapshot = {
  memories: demoMemories,
  proposals: demoProposals,
  mode: "demo",
  health: "degraded",
};

export const defaultSettings: Record<"claude_web" | "claude_code", ProjectionSettings> = {
  claude_web: {
    target: "claude_web",
    enabled: true,
    cross_cultural_polish: false,
    output_language: "preserve",
    require_preview: true,
    policy_version: 1,
  },
  claude_code: {
    target: "claude_code",
    enabled: true,
    cross_cultural_polish: false,
    output_language: "preserve",
    require_preview: true,
    policy_version: 1,
  },
};
