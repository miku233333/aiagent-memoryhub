import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "./App";

const platformNames = [
  "ChatGPT Web",
  "Codex",
  "OpenClaw",
  "Hermes",
  "Claude",
  "Claude Code",
  "Qoder",
  "Gemini",
  "Grok",
  "Grok Build",
] as const;

function jsonResponse(payload: unknown): Response {
  return {
    ok: true,
    status: 200,
    statusText: "OK",
    json: async () => payload,
  } as Response;
}

function mockLiveHub({
  memories = [],
  proposals = [],
}: {
  memories?: unknown[];
  proposals?: unknown[];
} = {}) {
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
    const path = String(input);
    if (path === "/health") return jsonResponse({ status: "ok" });
    if (path.startsWith("/v1/memories?")) return jsonResponse({ items: memories });
    if (path.startsWith("/v1/memory/proposals?")) return jsonResponse({ items: proposals });
    if (path.includes("/v1/settings/")) {
      return jsonResponse({
        setting: {
          target: path.endsWith("claude_code") ? "claude_code" : "claude_web",
          cross_cultural_polish: false,
        },
      });
    }
    throw new Error(`Unexpected request: ${path}`);
  }));
}

describe("AI Agent MemoryHub dashboard", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));
    vi.stubGlobal("confirm", vi.fn(() => true));
    Reflect.deleteProperty(window, "memoryHubDesktop");
  });

  it("labels fallback content and never claims native vendor memory", async () => {
    render(<App />);

    expect(await screen.findByText("演示数据")).toBeInTheDocument();
    expect(screen.getByRole("note", { name: "演示模式" })).toHaveTextContent(
      "同步记录均为示例",
    );
    expect(screen.getByText(/平台接收不等于原生记忆已写入/)).toBeInTheDocument();
    expect(screen.queryByText("Claude 已记住")).not.toBeInTheDocument();
  });

  it("shows real first-use guidance instead of fabricated activity for an empty live hub", async () => {
    mockLiveHub();
    const user = userEvent.setup();
    render(<App />);

    expect(await screen.findByRole("heading", { name: "开始建立你的记忆同步" })).toBeInTheDocument();
    expect(screen.getByText("Hub 已在线")).toBeInTheDocument();
    expect(screen.getByText("新增第一条记忆")).toBeInTheDocument();
    expect(screen.getByText("连接第一个 AI 工具")).toBeInTheDocument();
    expect(screen.queryByText("最近同步")).not.toBeInTheDocument();
    expect(screen.queryByText("Claude Code 上下文已注入")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "新增第一条记忆" }));
    expect(screen.getByRole("form", { name: "新增记忆" })).toBeInTheDocument();
  });

  it("shows only backend-derived status for a populated live hub", async () => {
    mockLiveHub({
      memories: [
        {
          id: "mem_live_1",
          scope: { user_id: "local-user", project_id: "agent-sync" },
          content: "这是来自真实 Hub 的已审批记忆。",
          status: "approved",
          explicit_user_fact: true,
          source_platform: "codex",
          metadata: {},
          created_at: "2026-08-30T02:00:00.000Z",
          updated_at: "2026-08-30T02:00:00.000Z",
        },
      ],
    });
    render(<App />);

    expect(await screen.findByRole("heading", { name: "可验证状态" })).toBeInTheDocument();
    expect(screen.getByText("已审批记忆 1 条")).toBeInTheDocument();
    expect(screen.getByText("尚无可验证的投递活动")).toBeInTheDocument();
    expect(screen.queryByText("Claude Code 上下文已注入")).not.toBeInTheDocument();
    expect(screen.queryByText("Claude Web 等待读取")).not.toBeInTheDocument();
    expect(screen.queryByText(/8 分钟前|37 分钟前/)).not.toBeInTheDocument();
    expect(screen.queryByRole("switch", { name: "自动同步" })).not.toBeInTheDocument();
  });

  it("uses accessible brand icons for ten independently defined connectors", async () => {
    const user = userEvent.setup();
    render(<App />);

    expect(await screen.findByText("AI Agent MemoryHub")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "连接器" }));

    expect(screen.getAllByRole("article")).toHaveLength(10);
    expect(screen.getAllByRole("button", { name: /查看 .+ 接入边界/ })).toHaveLength(10);
    for (const name of platformNames) {
      expect(screen.getByRole("img", { name: `${name} 品牌图标` })).toBeInTheDocument();
    }

    const chatGptCard = screen.getByRole("article", { name: "ChatGPT Web 连接器" });
    expect(within(chatGptCard).getByText("能力 · 受限")).toBeInTheDocument();
    expect(within(chatGptCard).getByText("Template only / remote MCP / plan-dependent")).toBeInTheDocument();
    expect(within(chatGptCard).getByText(/无本地生命周期 Hook/)).toBeInTheDocument();
    expect(within(chatGptCard).getByText(/不能承诺写入原生 ChatGPT memory/)).toBeInTheDocument();

    const codexCard = screen.getByRole("article", { name: "Codex 连接器" });
    expect(within(codexCard).getByText("能力 · 可接入")).toBeInTheDocument();
    expect(within(codexCard).getByText("REST CLI + Hooks")).toBeInTheDocument();
    expect(screen.queryByText("已同步")).not.toBeInTheDocument();
  });

  it("separates connector capability, local runtime, and target readback", async () => {
    const user = userEvent.setup();
    render(<App />);

    await user.click(screen.getByRole("button", { name: "连接器" }));
    const guide = screen.getByRole("region", { name: "连接器状态说明" });
    expect(within(guide).getByText("接入能力")).toBeInTheDocument();
    expect(within(guide).getByText(/不代表当前已连接/)).toBeInTheDocument();
    expect(within(guide).getByText("本机运行")).toBeInTheDocument();
    expect(within(guide).getByText("目标回读")).toBeInTheDocument();
    expect(within(guide).getByText(/只有 readback_verified 才表示同步完成/)).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "查看 ChatGPT Web 接入边界" }));
    const dialog = screen.getByRole("dialog", { name: "ChatGPT Web 接入边界" });
    expect(within(dialog).getByText("接入能力")).toBeInTheDocument();
    expect(within(dialog).queryByText("真实状态")).not.toBeInTheDocument();
    expect(within(dialog).getByText("运行与回读")).toBeInTheDocument();
    expect(within(dialog).getByText("未检测")).toBeInTheDocument();
    expect(within(dialog).getByText(/readback_verified/)).toBeInTheDocument();
  });

  it("returns to the top when switching sections", async () => {
    const user = userEvent.setup();
    render(<App />);
    document.documentElement.scrollTop = 420;
    document.body.scrollTop = 420;

    await user.click(screen.getByRole("button", { name: "设置" }));

    expect(document.documentElement.scrollTop).toBe(0);
    expect(document.body.scrollTop).toBe(0);
  });

  it("opens a working automation boundary dialog for every connector", async () => {
    const user = userEvent.setup();
    render(<App />);
    await user.click(screen.getByRole("button", { name: "连接器" }));

    for (const name of platformNames) {
      const trigger = screen.getByRole("button", { name: `查看 ${name} 接入边界` });
      await user.click(trigger);
      const dialog = screen.getByRole("dialog", { name: `${name} 接入边界` });
      expect(within(dialog).getByText("自动化等级")).toBeInTheDocument();
      expect(within(dialog).getByText("下一步")).toBeInTheDocument();
      expect(within(dialog).getByText("限制")).toBeInTheDocument();
      await user.click(within(dialog).getByRole("button", { name: "关闭接入边界" }));
      expect(screen.queryByRole("dialog", { name: `${name} 接入边界` })).not.toBeInTheDocument();
      expect(trigger).toHaveFocus();
    }
  });

  it("approves a demo proposal without a backend", async () => {
    const user = userEvent.setup();
    render(<App />);

    expect(await screen.findByText("待审批记忆")).toBeInTheDocument();
    expect(screen.getByText("该项目可能更偏好使用 SQLite 作为本地真源。")).toBeInTheDocument();
    await user.click(screen.getAllByRole("button", { name: "批准" })[0]);

    await waitFor(() => {
      expect(screen.queryByText("该项目可能更偏好使用 SQLite 作为本地真源。")).not.toBeInTheDocument();
    });
    expect(screen.getByRole("status")).toHaveTextContent("演示记忆已批准");
  });

  it("keeps cross-cultural polish off by default and preserves protected facts", async () => {
    const user = userEvent.setup();
    render(<App />);

    await user.click(screen.getByRole("button", { name: "设置" }));
    const polish = await screen.findByRole("switch", { name: "国际化表达润色" });
    expect(polish).toHaveAttribute("aria-checked", "false");

    await user.click(polish);
    expect(polish).toHaveAttribute("aria-checked", "true");
    expect(await screen.findByText(/香港节点路由/)).toBeInTheDocument();
    expect(screen.getByText(/香港、北京时间、09:00 保留/)).toBeInTheDocument();
    expect(screen.getByText(/原始记忆保持不变/)).toBeInTheDocument();
  });

  it("opens the environment doctor and states its apply boundary", async () => {
    const user = userEvent.setup();
    render(<App />);

    await user.click(screen.getByRole("button", { name: /环境检测/ }));
    expect(await screen.findByText("先检查，再搭建")).toBeInTheDocument();
    expect(screen.getByText(/真正写配置需要显式/)).toBeInTheDocument();
    expect(screen.getByText("--apply")).toBeInTheDocument();
    expect(screen.getByText(/不会改变系统地区、浏览器指纹或绕过平台限制/)).toBeInTheDocument();
    expect(screen.getByText(/--probe-network/)).toBeInTheDocument();
    expect(screen.getByText(/只连接 claude.ai 与 api.anthropic.com 做 DNS\/TLS/)).toBeInTheDocument();
    expect(screen.getByText(/不查询公网 IP、IP 信誉或地理位置/)).toBeInTheDocument();
  });

  it("imports the environment doctor's versioned JSON report", async () => {
    const user = userEvent.setup();
    render(<App />);

    await user.click(screen.getByRole("button", { name: /环境检测/ }));
    fireEvent.change(screen.getByLabelText("环境检测 JSON"), {
      target: { value: JSON.stringify({
        schema_version: "omnimemory.env-doctor/v1",
        checks: [
          {
            id: "node",
            title: "Node.js",
            status: "pass",
            summary: "Node.js 22 可用",
          },
        ],
      }) },
    });
    await user.click(screen.getByRole("button", { name: "解析本地报告" }));

    expect(screen.getByText("Node.js")).toBeInTheDocument();
    expect(screen.getByText("Node.js 22 可用")).toBeInTheDocument();
  });

  it("runs the environment doctor through the desktop preload bridge", async () => {
    const runCheck = vi.fn().mockResolvedValue({
      checkedAt: "2026-08-30T03:00:00.000Z",
      hub: { service: "memory-hub", status: "ready" },
      tools: [
        {
          tool: "git",
          installed: true,
          status: "available",
          version: "git version 2.47.0",
        },
      ],
    });
    Object.defineProperty(window, "memoryHubDesktop", {
      configurable: true,
      value: { environment: { runCheck } },
    });
    const user = userEvent.setup();
    render(<App />);

    await user.click(screen.getByRole("button", { name: /环境检测/ }));
    expect(screen.getByRole("button", { name: "一键检测" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "解析本地报告" })).not.toBeInTheDocument();
    expect(screen.queryByLabelText("环境检测 JSON")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "一键检测" }));
    expect(await screen.findByText(/Git 可用 · git version 2.47.0/)).toBeInTheDocument();
    expect(screen.getByText("Hub 已就绪")).toBeInTheDocument();
    expect(runCheck).toHaveBeenCalledTimes(1);
  });

  it("makes the forget action visibly identifiable", async () => {
    const user = userEvent.setup();
    render(<App />);

    await user.click(screen.getByRole("button", { name: "记忆" }));
    const forgetButtons = await screen.findAllByRole("button", { name: /遗忘记忆/ });

    expect(forgetButtons.length).toBeGreaterThan(0);
    expect(forgetButtons[0]).toHaveTextContent("遗忘");
    expect(forgetButtons[0]).toHaveAttribute("title", "遗忘此记忆");
  });

  it("opens Claude account safety without making an anti-ban guarantee", async () => {
    const user = userEvent.setup();
    render(<App />);

    await user.click(screen.getByRole("button", { name: /Claude 帐号安全/ }));

    expect(await screen.findByRole("heading", { name: "Claude 帐号安全" })).toBeInTheDocument();
    expect(screen.getByText(/不能保证帐号不会被限制或封禁/)).toBeInTheDocument();
    expect(screen.queryByText(/绝对防封/)).not.toBeInTheDocument();
  });

  it("states the no-bypass boundary and can pause automatic Claude access locally", async () => {
    const user = userEvent.setup();
    render(<App />);

    await user.click(screen.getByRole("button", { name: /Claude 帐号安全/ }));
    expect(await screen.findByText(/不会实施地区伪装、浏览器指纹篡改、代理轮换或用 sandbox 规避检测/)).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "暂停自动接入" }));
    expect(screen.getByText("自动接入已暂停")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "恢复自动接入" })).toBeInTheDocument();
  });

  it("uses the official region list without IP scoring or automatic location", async () => {
    const user = userEvent.setup();
    render(<App />);

    await user.click(screen.getByRole("button", { name: /Claude 帐号安全/ }));

    expect(await screen.findByText(/风险提示仅列中国大陆、香港与澳门/)).toBeInTheDocument();
    expect(screen.getByText(/台湾已在官方支持清单中，不计为风险；中国大陆、香港、澳门未列出/)).toBeInTheDocument();
    expect(screen.getByText("官方支持")).toBeInTheDocument();
    expect(screen.getAllByText("当前官方清单未列出")).toHaveLength(3);
    expect(screen.getByText(/不读取 IP、不做中国 IP 评分，也不自动定位/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /查看官方地区清单/ })).toHaveAttribute(
      "href",
      "https://support.claude.com/en/articles/8461763-where-can-i-access-claude",
    );
  });
});
