import {
  Activity,
  AlertTriangle,
  Archive,
  ArrowRight,
  Bot,
  Check,
  CheckCircle2,
  ChevronRight,
  CircleDashed,
  Clipboard,
  Clock3,
  CloudCog,
  Code2,
  Copy,
  Database,
  Eye,
  ExternalLink,
  FileCheck2,
  FileClock,
  Fingerprint,
  Gauge,
  Globe2,
  HardDrive,
  HeartPulse,
  History,
  KeyRound,
  Laptop,
  Link2,
  ListChecks,
  LockKeyhole,
  Menu,
  Plus,
  PauseCircle,
  PlayCircle,
  RefreshCw,
  Search,
  Settings,
  ShieldCheck,
  Sparkles,
  TerminalSquare,
  Trash2,
  UserRoundCheck,
  X,
  XCircle,
  Zap,
} from "lucide-react";
import {
  type ComponentType,
  type FormEvent,
  type ReactNode,
  useEffect,
  useMemo,
  useState,
} from "react";
import {
  approveProposal,
  forgetMemory,
  getSettings,
  loadSnapshot,
  previewProjection,
  proposeMemory,
  updateSettings,
} from "./api";
import { defaultSettings, demoSnapshot } from "./demo";
import {
  connectorById,
  connectors,
  PlatformIcon,
  type ConnectorDefinition,
} from "./platforms";
import type {
  Destination,
  HubSnapshot,
  MemoryItem,
  ProjectionPreview,
  ProjectionSettings,
} from "./types";

type Section =
  | "overview"
  | "memories"
  | "context"
  | "connectors"
  | "environment"
  | "claude_safety"
  | "audit"
  | "settings";

interface NavItem {
  id: Section;
  label: string;
  icon: ComponentType<{ size?: number; strokeWidth?: number }>;
}

const navItems: NavItem[] = [
  { id: "overview", label: "总览", icon: Gauge },
  { id: "memories", label: "记忆", icon: Database },
  { id: "context", label: "上下文包", icon: Archive },
  { id: "connectors", label: "连接器", icon: Link2 },
  { id: "environment", label: "环境检测", icon: HeartPulse },
  { id: "claude_safety", label: "Claude 帐号安全", icon: ShieldCheck },
  { id: "audit", label: "审计记录", icon: History },
  { id: "settings", label: "设置", icon: Settings },
];

const originalPreview =
  "国内服务器需要备案，外网访问走香港节点，北京时间每天 09:00 检查。";

function Switch({
  checked,
  onChange,
  label,
  disabled = false,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label: string;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      className="switch"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      data-checked={checked}
      onClick={() => onChange(!checked)}
    >
      <span />
    </button>
  );
}

function StatusPill({
  children,
  tone = "neutral",
}: {
  children: ReactNode;
  tone?: "success" | "warning" | "danger" | "neutral" | "primary";
}) {
  return <span className={`status-pill status-${tone}`}>{children}</span>;
}

function EmptyState({ children }: { children: ReactNode }) {
  return (
    <div className="empty-state">
      <CircleDashed size={26} />
      <p>{children}</p>
    </div>
  );
}

function formatRelative(date: string) {
  const delta = Date.now() - new Date(date).getTime();
  const minutes = Math.max(1, Math.round(delta / 60_000));
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;
  return `${Math.round(hours / 24)} 天前`;
}

async function copyToClipboard(value: string) {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(value);
    return;
  }
  const input = document.createElement("textarea");
  input.value = value;
  document.body.appendChild(input);
  input.select();
  document.execCommand("copy");
  input.remove();
}

function AppSidebar({
  active,
  setActive,
  open,
  close,
}: {
  active: Section;
  setActive: (section: Section) => void;
  open: boolean;
  close: () => void;
}) {
  return (
    <aside className={`sidebar ${open ? "sidebar-open" : ""}`} aria-label="主导航">
      <div className="brand">
        <span className="brand-mark"><Database size={21} /></span>
        <span>
          <strong>AI Agent MemoryHub</strong>
          <small>Local control plane</small>
        </span>
      </div>
      <nav>
        {navItems.map((item) => {
          const Icon = item.icon;
          return (
            <button
              type="button"
              key={item.id}
              className={active === item.id ? "active" : ""}
              onClick={() => {
                setActive(item.id);
                close();
              }}
            >
              <Icon size={18} strokeWidth={1.9} />
              <span>{item.label}</span>
              {(item.id === "environment" || item.id === "claude_safety") && <span className="nav-new">新</span>}
            </button>
          );
        })}
      </nav>
      <div className="sidebar-foot">
        <div className="privacy-lock"><LockKeyhole size={16} /> 本地优先</div>
        <p>原始记忆保存在你的控制面。各平台只接收经过授权的上下文副本。</p>
      </div>
    </aside>
  );
}

function TopBar({
  title,
  subtitle,
  onMenu,
  children,
}: {
  title: string;
  subtitle: string;
  onMenu: () => void;
  children?: ReactNode;
}) {
  return (
    <header className="topbar">
      <button type="button" className="mobile-menu" onClick={onMenu} aria-label="打开导航">
        <Menu size={21} />
      </button>
      <div className="topbar-copy">
        <h1>{title}</h1>
        <p>{subtitle}</p>
      </div>
      {children && <div className="topbar-actions">{children}</div>}
    </header>
  );
}

function ConnectorRail() {
  return (
    <section className="connector-rail" aria-label="连接器状态">
      <div className="connector-rail-heading">
        <span>目标平台</span>
        <small>仅表示接入能力，不代表当前在线</small>
      </div>
      <div className="connector-scroll">
        {connectors.map((connector) => (
          <div className="connector-mini" key={connector.name}>
            <PlatformIcon connector={connector} />
            <span className="connector-name">
              <strong>{connector.name}</strong>
              <small>{connector.detail}</small>
            </span>
            <StatusPill tone={connector.tone}>能力 · {connector.status}</StatusPill>
          </div>
        ))}
      </div>
    </section>
  );
}

function OverviewPage({
  snapshot,
  onApprove,
  onReject,
  onNewMemory,
  onNavigate,
  announce,
  onMenu,
}: {
  snapshot: HubSnapshot;
  onApprove: (item: MemoryItem) => void;
  onReject: (item: MemoryItem) => void;
  onNewMemory: () => void;
  onNavigate: (section: Section) => void;
  announce: (message: string) => void;
  onMenu: () => void;
}) {
  const contextText = snapshot.memories.map((item) => `• ${item.content}`).join("\n");
  const isFirstRun =
    snapshot.mode === "live" &&
    snapshot.memories.length === 0 &&
    snapshot.proposals.length === 0;
  return (
    <>
      <TopBar
        title="记忆同步中心"
        subtitle="一份原始记忆，多平台按权限读取；平台接收不等于原生记忆已写入。"
        onMenu={onMenu}
      >
        <div className="automation-fact">
          <Link2 size={17} />
          <span>
            <strong>按连接器能力读取</strong>
            <small>仅支持 Hook / MCP 的目标可自动获取已审批上下文</small>
          </span>
        </div>
        <button type="button" className="button primary" onClick={onNewMemory}>
          <Plus size={17} /> 新增记忆
        </button>
      </TopBar>

      <ConnectorRail />

      {snapshot.mode === "demo" ? (
        <aside className="demo-mode-banner" role="note" aria-label="演示模式">
          <AlertTriangle size={18} />
          <span>
            <strong>当前为演示模式</strong>
            <small>当前显示演示数据，记忆、提案与同步记录均为示例；操作不会代表目标平台已收到内容。</small>
          </span>
          <StatusPill tone="warning">DEMO</StatusPill>
        </aside>
      ) : null}

      <div className="overview-grid">
        {isFirstRun ? (
          <section className="card timeline-card first-run-card">
            <div className="card-heading">
              <div>
                <span className="eyebrow">First run</span>
                <h2>开始建立你的记忆同步</h2>
              </div>
              <StatusPill tone="success">Hub 在线</StatusPill>
            </div>
            <div className="onboarding-steps">
              <div className="onboarding-step complete">
                <span><Check size={15} /></span>
                <div><strong>Hub 已在线</strong><small>本地 API 与存储已准备好。</small></div>
              </div>
              <div className="onboarding-step">
                <span>2</span>
                <div><button type="button" onClick={onNewMemory}>新增第一条记忆</button><small>先保存一条由你明确提供、可审批的事实。</small></div>
              </div>
              <div className="onboarding-step">
                <span>3</span>
                <div><button type="button" onClick={() => onNavigate("connectors")}>连接第一个 AI 工具</button><small>查看各平台真实的自动化等级与限制。</small></div>
              </div>
            </div>
          </section>
        ) : snapshot.mode === "demo" ? (
          <section className="card timeline-card">
            <div className="card-heading">
              <div>
                <span className="eyebrow">Activity</span>
                <h2>最近同步</h2>
              </div>
              <button type="button" className="text-button" onClick={() => onNavigate("audit")}>查看审计</button>
            </div>
            <div className="timeline">
              <div className="timeline-row">
                <span className="timeline-icon success"><CheckCircle2 size={16} /></span>
                <div>
                  <strong>Claude Code 上下文已注入</strong>
                  <p>适配器接收了项目级上下文；未声称写入 Claude 原生记忆。</p>
                  <small>8 分钟前 · accepted_by_adapter</small>
                </div>
              </div>
              <div className="timeline-row">
                <span className="timeline-icon primary"><FileCheck2 size={16} /></span>
                <div>
                  <strong>记忆审批完成</strong>
                  <p>Canonical revision 保持不变，新的上下文包可用。</p>
                  <small>21 分钟前 · owner approved</small>
                </div>
              </div>
              <div className="timeline-row">
                <span className="timeline-icon warning"><Clock3 size={16} /></span>
                <div>
                  <strong>Claude Web 等待读取</strong>
                  <p>Remote MCP 已准备上下文，但没有目标端 digest 回读。</p>
                  <small>37 分钟前 · delivered_unverified</small>
                </div>
              </div>
              <div className="timeline-row">
                <span className="timeline-icon neutral"><ShieldCheck size={16} /></span>
                <div>
                  <strong>敏感信息检查通过</strong>
                  <p>投影中未发现令牌、私钥或跨项目内容。</p>
                  <small>41 分钟前 · policy v1</small>
                </div>
              </div>
            </div>
          </section>
        ) : (
          <section className="card timeline-card verified-state-card">
            <div className="card-heading">
              <div>
                <span className="eyebrow">Live hub</span>
                <h2>可验证状态</h2>
              </div>
              <button type="button" className="text-button" onClick={() => onNavigate("audit")}>前往审计</button>
            </div>
            <div className="timeline">
              <div className="timeline-row">
                <span className="timeline-icon success"><Database size={16} /></span>
                <div>
                  <strong>已审批记忆 {snapshot.memories.length} 条</strong>
                  <p>数量来自当前 Hub 响应，不推断任何目标平台是否已读取。</p>
                </div>
              </div>
              <div className="timeline-row">
                <span className="timeline-icon primary"><FileClock size={16} /></span>
                <div>
                  <strong>待审批提案 {snapshot.proposals.length} 条</strong>
                  <p>只有审批后的内容才可进入目标上下文。</p>
                </div>
              </div>
              <div className="timeline-row">
                <span className="timeline-icon neutral"><CircleDashed size={16} /></span>
                <div>
                  <strong>尚无可验证的投递活动</strong>
                  <p>当前后端没有提供可核验的目标投递审计字段。</p>
                </div>
              </div>
            </div>
          </section>
        )}

        <section className="card proposal-card">
          <div className="card-heading">
            <div>
              <span className="eyebrow">Review queue</span>
              <h2>待审批记忆 <span className="count-badge">{snapshot.proposals.length}</span></h2>
            </div>
            <StatusPill tone={snapshot.mode === "live" ? "success" : "warning"}>
              {snapshot.mode === "live" ? "实时数据" : "演示数据"}
            </StatusPill>
          </div>
          <div className="proposal-list">
            {snapshot.proposals.length === 0 ? (
              <EmptyState>没有等待审批的推断。</EmptyState>
            ) : (
              snapshot.proposals.slice(0, 3).map((item) => (
                <article className="proposal" key={item.id}>
                  <div className="proposal-meta">
                    <span className="source-chip"><Bot size={13} /> {item.source_platform}</span>
                    <span>{formatRelative(item.created_at)}</span>
                  </div>
                  <p>{item.content}</p>
                  <div className="proposal-footer">
                    <span>项目：{item.scope.project_id ?? "全局"}</span>
                    <div>
                      <button
                        type="button"
                        className="icon-button reject"
                        onClick={() => onReject(item)}
                        aria-label={`拒绝记忆：${item.content}`}
                      ><X size={16} /></button>
                      <button type="button" className="button compact" onClick={() => onApprove(item)}>
                        <Check size={15} /> 批准
                      </button>
                    </div>
                  </div>
                </article>
              ))
            )}
          </div>
          <button type="button" className="card-link" onClick={() => onNavigate("memories")}>
            管理全部记忆 <ChevronRight size={16} />
          </button>
        </section>

        <section className="card context-card">
          <div className="card-heading">
            <div>
              <span className="eyebrow">Context preview</span>
              <h2>上下文预览</h2>
            </div>
            <button
              type="button"
              className="icon-button"
              aria-label="复制上下文"
              onClick={() => {
                void copyToClipboard(contextText);
                announce("上下文已复制");
              }}
            ><Copy size={16} /></button>
          </div>
          <div className="context-target">
            <PlatformIcon connector={connectorById.claude_code} />
            <span><strong>Claude Code</strong><small>project / agent-sync</small></span>
            <StatusPill tone="success">可生成</StatusPill>
          </div>
          <div className="context-block">
            <div className="context-label"><span>APPROVED MEMORY</span><span>{snapshot.memories.length} 项</span></div>
            {snapshot.memories.length ? (
              snapshot.memories.slice(0, 4).map((item) => <p key={item.id}>• {item.content}</p>)
            ) : (
              <p>尚无已审批记忆。</p>
            )}
          </div>
          <div className="context-integrity">
            <ShieldCheck size={16} />
            <span><strong>Canonical 未修改</strong><small>投影是可丢弃副本，不会回写原始记忆。</small></span>
          </div>
          <button type="button" className="button secondary full" onClick={() => onNavigate("context")}>
            <Eye size={16} /> 打开完整上下文包
          </button>
        </section>
      </div>

      <footer className="runtime-strip">
        <span><HardDrive size={15} /> SQLite 本地真源</span>
        <span><ShieldCheck size={15} /> 投影事实保护</span>
        <span><FileClock size={15} /> {snapshot.proposals.length} 项待审批</span>
        <span><Activity size={15} /> Hub {snapshot.health === "healthy" ? "在线" : "演示模式"}</span>
      </footer>
    </>
  );
}

function MemoriesPage({
  snapshot,
  onForget,
  onMenu,
}: {
  snapshot: HubSnapshot;
  onForget: (item: MemoryItem) => void;
  onMenu: () => void;
}) {
  const [query, setQuery] = useState("");
  const filtered = snapshot.memories.filter((item) =>
    item.content.toLowerCase().includes(query.trim().toLowerCase()),
  );
  return (
    <>
      <TopBar title="记忆" subtitle="只显示已审批的 canonical memory；投影不进入这里。" onMenu={onMenu}>
        <div className="search-box"><Search size={16} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索记忆" /></div>
      </TopBar>
      <section className="page-card">
        <div className="table-heading">
          <span>内容</span><span>来源</span><span>范围</span><span>状态</span><span />
        </div>
        {filtered.length ? filtered.map((item) => (
          <article className="memory-row" key={item.id}>
            <div><strong>{item.content}</strong><small>{item.id}</small></div>
            <span>{item.source_platform}</span>
            <span>{item.scope.project_id ?? "全局"}</span>
            <StatusPill tone="success">已审批</StatusPill>
            <button
              type="button"
              className="button compact memory-forget"
              aria-label={`遗忘记忆：${item.content}`}
              title="遗忘此记忆"
              onClick={() => onForget(item)}
            ><Trash2 size={14} /> 遗忘</button>
          </article>
        )) : <EmptyState>没有匹配的已审批记忆。</EmptyState>}
      </section>
    </>
  );
}

function ContextPage({ snapshot, onMenu, announce }: { snapshot: HubSnapshot; onMenu: () => void; announce: (message: string) => void }) {
  const [target, setTarget] = useState("claude_code");
  const pack = [
    "# Approved project context",
    "",
    ...snapshot.memories.map((item) => `- ${item.content}`),
    "",
    "> Generated projection. Canonical memory remains unchanged.",
  ].join("\n");
  return (
    <>
      <TopBar title="上下文包" subtitle="按目标、项目与权限生成最小必要上下文。" onMenu={onMenu}>
        <select className="select" value={target} onChange={(event) => setTarget(event.target.value)} aria-label="目标平台">
          <option value="claude_code">Claude Code</option>
          <option value="claude_web">Claude Web</option>
          <option value="codex">Codex</option>
          <option value="openclaw">OpenClaw</option>
        </select>
        <button type="button" className="button primary" onClick={() => { void copyToClipboard(pack); announce("上下文包已复制"); }}><Copy size={16} />复制</button>
      </TopBar>
      <div className="context-page-grid">
        <section className="page-card compact-card">
          <span className="eyebrow">Scope</span>
          <h2>agent-sync</h2>
          <dl className="detail-list">
            <div><dt>目标</dt><dd>{target}</dd></div>
            <div><dt>记忆数</dt><dd>{snapshot.memories.length}</dd></div>
            <div><dt>权限</dt><dd>owner / project</dd></div>
            <div><dt>输出</dt><dd>临时 projection</dd></div>
          </dl>
        </section>
        <section className="page-card code-card">
          <div className="card-heading"><h2>生成预览</h2><StatusPill tone="neutral">未投递</StatusPill></div>
          <pre>{pack}</pre>
        </section>
      </div>
    </>
  );
}

function ConnectorBoundaryDialog({
  connector,
  close,
  returnFocus,
}: {
  connector: ConnectorDefinition;
  close: () => void;
  returnFocus: HTMLButtonElement | null;
}) {
  const titleId = `connector-boundary-${connector.id}`;
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") close();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      returnFocus?.focus();
    };
  }, [close, returnFocus]);

  return (
    <div
      className="modal-backdrop boundary-backdrop"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) close();
      }}
    >
      <section
        className="modal connector-boundary-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
      >
        <div className="boundary-dialog-head">
          <PlatformIcon connector={connector} size="large" />
          <div>
            <span className="eyebrow">Connector boundary</span>
            <h2 id={titleId}>{connector.name} 接入边界</h2>
          </div>
          <button
            type="button"
            className="icon-button"
            aria-label="关闭接入边界"
            onClick={close}
            autoFocus
          ><X size={17} /></button>
        </div>

        <dl className="boundary-facts">
          <div><dt>接入能力</dt><dd><StatusPill tone={connector.tone}>{connector.status}</StatusPill></dd></div>
          <div><dt>自动化等级</dt><dd>{connector.automationLevel}</dd></div>
          <div className="boundary-fact-wide"><dt>当前能力</dt><dd>{connector.capability}</dd></div>
          <div className="boundary-fact-wide boundary-readback">
            <dt>运行与回读</dt>
            <dd>
              <StatusPill tone="neutral">未检测</StatusPill>
              <span>只有审计记录出现 <code>readback_verified</code>，才表示目标端已回读并可显示“已同步”。</span>
            </dd>
          </div>
        </dl>

        <section className="boundary-section">
          <h3><ListChecks size={16} /> 下一步</h3>
          <ol>
            {connector.nextSteps.map((step) => <li key={step}>{step}</li>)}
          </ol>
        </section>

        <section className="boundary-section boundary-limitations">
          <h3><ShieldCheck size={16} /> 限制</h3>
          <p>{connector.memoryBoundary}</p>
          <ul>
            {connector.limitations.map((limitation) => <li key={limitation}>{limitation}</li>)}
          </ul>
        </section>
      </section>
    </div>
  );
}

function ConnectorsPage({ onMenu }: { onMenu: () => void }) {
  const [selectedConnector, setSelectedConnector] = useState<ConnectorDefinition | null>(null);
  const [connectorTrigger, setConnectorTrigger] = useState<HTMLButtonElement | null>(null);
  return (
    <>
      <TopBar title="连接器" subtitle="同一个 Hub，不同平台采用各自支持的最小接入方式；能力、运行与回读分开核验。" onMenu={onMenu} />
      <section className="connector-status-guide" aria-label="连接器状态说明">
        <div>
          <CheckCircle2 size={17} />
          <span><strong>接入能力</strong><small>卡片标签说明适配器契约，不代表当前已连接。</small></span>
        </div>
        <div>
          <Activity size={17} />
          <span><strong>本机运行</strong><small>需由环境检测或实际 Hook / MCP 回执确认。</small></span>
        </div>
        <div>
          <FileCheck2 size={17} />
          <span><strong>目标回读</strong><small>只有 readback_verified 才表示同步完成。</small></span>
        </div>
      </section>
      <div className="connector-grid">
        {connectors.map((connector) => (
          <article
            className="page-card connector-card"
            key={connector.id}
            aria-label={`${connector.name} 连接器`}
          >
            <div className="connector-card-top">
              <PlatformIcon connector={connector} size="large" />
              <StatusPill tone={connector.tone}>能力 · {connector.status}</StatusPill>
            </div>
            <h2>{connector.name}</h2>
            <p>{connector.detail}</p>
            <div className="capability-row"><CheckCircle2 size={15} /> {connector.capability}</div>
            <div className="capability-row muted"><CircleDashed size={15} /> {connector.memoryBoundary}</div>
            <button
              type="button"
              className="button tertiary full"
              aria-label={`查看 ${connector.name} 接入边界`}
              onClick={(event) => {
                setConnectorTrigger(event.currentTarget);
                setSelectedConnector(connector);
              }}
            >查看接入边界 <ArrowRight size={15} /></button>
          </article>
        ))}
      </div>
      {selectedConnector ? (
        <ConnectorBoundaryDialog
          connector={selectedConnector}
          close={() => setSelectedConnector(null)}
          returnFocus={connectorTrigger}
        />
      ) : null}
    </>
  );
}

interface DoctorCheck {
  id?: string;
  title?: string;
  status?: string;
  summary?: string;
  remediation?: string;
}

const desktopToolLabels: Record<MemoryHubDesktopTool, string> = {
  node: "Node.js",
  python3: "Python 3",
  uv: "uv",
  git: "Git",
  claude: "Claude Code",
};

function isDesktopEnvironmentCheck(
  payload: unknown,
): payload is MemoryHubDesktopEnvironmentCheckResult {
  if (!payload || typeof payload !== "object") return false;
  const record = payload as Record<string, unknown>;
  return Boolean(record.hub) && typeof record.hub === "object" && Array.isArray(record.tools);
}

function desktopEnvironmentChecks(
  result: MemoryHubDesktopEnvironmentCheckResult,
): DoctorCheck[] {
  const hubReady = result.hub.status === "ready";
  const hubCheck: DoctorCheck = {
    id: "desktop-hub",
    title: "内置 Hub",
    status: hubReady ? "pass" : "warn",
    summary: hubReady ? "Hub 已就绪" : `Hub 状态：${result.hub.status}`,
  };
  const toolChecks = result.tools.map((tool): DoctorCheck => {
    const available = tool.installed && tool.status === "available";
    const label = desktopToolLabels[tool.tool] ?? tool.tool;
    return {
      id: `desktop-${tool.tool}`,
      title: label,
      status: available ? "pass" : "warn",
      summary: available
        ? `${label} 可用${tool.version ? ` · ${tool.version}` : ""}`
        : `${label} ${tool.status}`,
    };
  });
  return [hubCheck, ...toolChecks];
}

function parseDoctorChecks(payload: unknown): DoctorCheck[] {
  if (typeof payload === "string") return parseDoctorChecks(JSON.parse(payload));
  if (isDesktopEnvironmentCheck(payload)) return desktopEnvironmentChecks(payload);
  if (Array.isArray(payload)) {
    return payload.filter((item): item is DoctorCheck => Boolean(item) && typeof item === "object");
  }
  if (!payload || typeof payload !== "object") {
    throw new Error("Environment report is not an object");
  }
  const record = payload as Record<string, unknown>;
  if ("checks" in record) return parseDoctorChecks(record.checks);
  if ("report" in record) return parseDoctorChecks(record.report);
  if (typeof record.stdout === "string") return parseDoctorChecks(record.stdout);
  throw new Error("Environment report does not contain checks");
}

function EnvironmentPage({ onMenu, announce }: { onMenu: () => void; announce: (message: string) => void }) {
  const command = "(cd tools/env-doctor && python3 -m env_doctor check --project-root ../.. --json)";
  const networkCommand = "(cd tools/env-doctor && python3 -m env_doctor check --project-root ../.. --probe-network --json)";
  const planCommand = "(cd tools/env-doctor && python3 -m env_doctor setup --project-root ../.. --user-id local-user)";
  const [rawReport, setRawReport] = useState("");
  const [checks, setChecks] = useState<DoctorCheck[]>([]);
  const [reportError, setReportError] = useState("");
  const [checking, setChecking] = useState(false);
  const desktopEnvironment = window.memoryHubDesktop?.environment;
  const canRunDesktopCheck = typeof desktopEnvironment?.runCheck === "function";

  const importReport = () => {
    try {
      const next = parseDoctorChecks(rawReport);
      setChecks(next);
      setReportError("");
      announce(`已导入 ${next.length} 项环境检查`);
    } catch {
      setReportError("无法解析 JSON。请粘贴环境医生的完整输出。 ");
    }
  };

  const runDesktopCheck = async () => {
    if (!desktopEnvironment?.runCheck) return;
    setChecking(true);
    setReportError("");
    try {
      const next = parseDoctorChecks(await desktopEnvironment.runCheck());
      setChecks(next);
      announce(`一键检测完成，共 ${next.length} 项`);
    } catch {
      setReportError("一键检测失败。没有应用配置，请稍后重试或查看桌面端日志。");
    } finally {
      setChecking(false);
    }
  };

  return (
    <>
      <TopBar title="合规环境检测" subtitle="只读扫描依赖与配置；搭建计划默认 dry-run，应用前备份。" onMenu={onMenu}>
        <StatusPill tone="success">不上传诊断</StatusPill>
      </TopBar>
      <div className="environment-grid">
        <section className="page-card doctor-intro">
          <div className="doctor-icon"><TerminalSquare size={28} /></div>
          <span className="eyebrow">AI Agent MemoryHub Doctor</span>
          <h2>先检查，再搭建</h2>
          <p>检测 Node、Python、Git、Claude Code、Hooks、MCP 和 Hub 健康状态。不会读取或打印令牌，也不会改变系统地区、浏览器指纹或绕过平台限制。</p>
          {canRunDesktopCheck ? (
            <>
              <div className="desktop-check-action">
                <Laptop size={22} />
                <span><strong>桌面快速检测</strong><small>固定检查 Node、Python、uv、Git、Claude Code 与内置 Hub；默认不联网。</small></span>
                <button
                  type="button"
                  className="button primary"
                  onClick={() => void runDesktopCheck()}
                  disabled={checking}
                >{checking ? <RefreshCw className="spin" size={16} /> : <PlayCircle size={16} />}{checking ? "检测中" : "一键检测"}</button>
              </div>
              <div className="desktop-deep-check">
                <span><strong>Hook / MCP / sandbox 深度检查</strong><small>不在桌面快速检测范围内；复制合规 CLI 后在终端运行。</small></span>
                <code>{command}</code>
                <button type="button" className="button tertiary" onClick={() => { void copyToClipboard(command); announce("深度检测命令已复制"); }}><Copy size={15} />复制深度检测命令</button>
              </div>
            </>
          ) : (
            <>
              <div className="command-box"><code>{command}</code><button type="button" aria-label="复制检测命令" onClick={() => { void copyToClipboard(command); announce("检测命令已复制"); }}><Copy size={15} /></button></div>
              <div className="command-box"><code>{planCommand}</code><button type="button" aria-label="复制搭建计划命令" onClick={() => { void copyToClipboard(planCommand); announce("搭建计划命令已复制"); }}><Copy size={15} /></button></div>
              <div className="network-optin-note">
                <strong>可选公网网络检测</strong>
                <span>只连接 claude.ai 与 api.anthropic.com 做 DNS/TLS；不查询公网 IP、IP 信誉或地理位置。</span>
              </div>
              <div className="command-box"><code>{networkCommand}</code><button type="button" aria-label="复制网络检测命令" onClick={() => { void copyToClipboard(networkCommand); announce("网络检测命令已复制"); }}><Copy size={15} /></button></div>
            </>
          )}
          <div className="safety-note"><ShieldCheck size={18} /><span><strong>安全边界</strong>真正写配置需要显式 <code>--apply</code>，先做可恢复备份；不执行远端 <code>curl | bash</code>。</span></div>
        </section>
        <section className="page-card report-card">
          <div className="card-heading"><div><span className="eyebrow">Local report</span><h2>{canRunDesktopCheck ? "检测结果" : "导入检测结果"}</h2></div><Clipboard size={19} /></div>
          {!canRunDesktopCheck ? (
            <>
              <textarea value={rawReport} onChange={(event) => setRawReport(event.target.value)} placeholder='粘贴 JSON，例如 {"checks": [...]}' aria-label="环境检测 JSON" />
              <button type="button" className="button secondary full" onClick={importReport}>解析本地报告</button>
            </>
          ) : null}
          {reportError && <p className="inline-error"><XCircle size={15} />{reportError}</p>}
          <div className="doctor-results">
            {checks.length ? checks.map((check, index) => (
              <div className="doctor-check" key={check.id ?? `${check.title}-${index}`}>
                {check.status === "ok" || check.status === "pass" ? <CheckCircle2 size={17} className="good" /> : <CircleDashed size={17} />}
                <span><strong>{check.title ?? check.id ?? `检查 ${index + 1}`}</strong><small>{check.summary ?? check.remediation ?? check.status ?? "已读取"}</small></span>
              </div>
            )) : <EmptyState>{canRunDesktopCheck ? "点击“一键检测”后，结果会直接显示在这里。" : "运行命令后，把 JSON 粘贴到上方即可在本地查看。"}</EmptyState>}
          </div>
        </section>
      </div>
    </>
  );
}

function ClaudeSafetyPage({
  onMenu,
  announce,
  onNavigate,
  accessPaused,
  setAccessPaused,
}: {
  onMenu: () => void;
  announce: (message: string) => void;
  onNavigate: (section: Section) => void;
  accessPaused: boolean;
  setAccessPaused: (paused: boolean) => void;
}) {
  const doctorCommand = "(cd tools/env-doctor && python3 -m env_doctor check --project-root ../.. --probe-network --json)";
  const toggleAccess = () => {
    const paused = !accessPaused;
    setAccessPaused(paused);
    announce(paused ? "Claude 自动接入已在当前会话暂停" : "Claude 自动接入已在当前会话恢复");
  };

  return (
    <>
      <TopBar
        title="Claude 帐号安全"
        subtitle="降低可避免的帐号与接入风险，但不能保证帐号不会被限制或封禁。"
        onMenu={onMenu}
      >
        <StatusPill tone={accessPaused ? "warning" : "success"}>
          {accessPaused ? "接入已暂停" : "等待合规自检"}
        </StatusPill>
      </TopBar>

      <div className="safety-grid">
        <section className="page-card safety-control-card">
          <div className={`safety-hero ${accessPaused ? "is-paused" : ""}`}>
            <span className="safety-hero-icon"><ShieldCheck size={29} /></span>
            <div>
              <span className="eyebrow">Account safety</span>
              <h2>先确认资格与接入状态</h2>
              <p>本页只帮助你减少可避免的配置、凭据与自动化风险；帐号资格和处置结果仍由 Anthropic 官方判定。</p>
            </div>
          </div>

          <div className="safety-signal-list" aria-label="帐号安全状态概览">
            <div className="safety-signal">
              <Activity size={18} />
              <span><strong>官方服务可用性</strong><small>需在官方状态页实时确认</small></span>
              <StatusPill tone="warning">待确认</StatusPill>
            </div>
            <div className="safety-signal">
              <UserRoundCheck size={18} />
              <span><strong>帐号与订阅资格</strong><small>不由 AI Agent MemoryHub 推断或改变</small></span>
              <StatusPill tone="neutral">官方判定</StatusPill>
            </div>
            <div className="safety-signal">
              <KeyRound size={18} />
              <span><strong>凭据隔离</strong><small>仅本地密钥存储或环境变量</small></span>
              <StatusPill tone="success">必需</StatusPill>
            </div>
            <div className="safety-signal">
              <CloudCog size={18} />
              <span><strong>{accessPaused ? "自动接入已暂停" : "自动接入未暂停"}</strong><small>仅为当前前端会话状态，不会修改 Claude 帐号</small></span>
              <StatusPill tone={accessPaused ? "warning" : "neutral"}>{accessPaused ? "paused" : "local only"}</StatusPill>
            </div>
          </div>

          <button
            type="button"
            className={`button full ${accessPaused ? "secondary" : "danger"}`}
            onClick={toggleAccess}
          >
            {accessPaused ? <PlayCircle size={16} /> : <PauseCircle size={16} />}
            {accessPaused ? "恢复自动接入" : "暂停自动接入"}
          </button>
          <p className="safety-local-note">发生异常时先暂停，再通过官方状态与支持渠道核实；不要用自动切换出口来掩盖异常。</p>

          <div className="safety-doctor">
            <div><TerminalSquare size={18} /><span><strong>运行合规环境检测</strong><small>另对两个官方域名做 DNS/TLS；不查询公网 IP，不上传令牌。</small></span></div>
            <div className="command-box"><code>{doctorCommand}</code><button type="button" aria-label="复制帐号安全检查命令" onClick={() => { void copyToClipboard(doctorCommand); announce("帐号安全检查命令已复制"); }}><Copy size={15} /></button></div>
            <button type="button" className="button tertiary full" onClick={() => onNavigate("environment")}>打开环境检测 <ArrowRight size={15} /></button>
          </div>
        </section>

        <section className="page-card safety-checklist-card">
          <div className="card-heading">
            <div><span className="eyebrow">Risk checklist</span><h2>处理优先级</h2></div>
            <ListChecks size={20} />
          </div>

          <div className="safety-priority-group">
            <div className="safety-priority-heading"><span className="priority-label p0">P0</span><strong>连接前必须满足</strong></div>
            <div className="safety-check-row">
              <UserRoundCheck size={18} />
              <span><strong>单帐号、单人使用</strong><small>禁止共用帐号、分享密码、会话 Cookie、令牌或其他凭据；发现共享应先注销会话并更换凭据。</small></span>
            </div>
            <div className="safety-check-row">
              <AlertTriangle size={18} />
              <span><strong>异常先暂停</strong><small>会话、登录提示或出口出现异常时暂停自动接入，保留诊断信息，并通过官方渠道核实。</small></span>
            </div>
            <div className="safety-check-row">
              <KeyRound size={18} />
              <span><strong>凭据保持隔离</strong><small>只存入本地密钥存储或受限环境变量；不得进入记忆正文、日志、仓库或浏览器脚本。</small></span>
            </div>
          </div>

          <div className="safety-priority-group">
            <div className="safety-priority-heading"><span className="priority-label p1">P1</span><strong>自动接入前验证</strong></div>
            <div className="safety-check-row">
              <CloudCog size={18} />
              <span><strong>Claude Web Remote MCP</strong><small>公网端点必须使用 HTTPS 与 OAuth，并限制 scope；不得暴露无鉴权的本地接口。</small></span>
            </div>
            <div className="safety-check-row">
              <Code2 size={18} />
              <span><strong>Claude Code Hook 状态</strong><small>用环境医生验证 Hook 文件、Hub URL 与权限；检查失败时保持 fail-closed。</small></span>
            </div>
            <div className="safety-check-row">
              <ShieldCheck size={18} />
              <span><strong>确认官方资格</strong><small>连接前确认帐号、订阅与服务资格符合官方要求；自动化不会改变平台的资格判断。</small></span>
            </div>
            <div className="region-eligibility-panel">
              <div className="region-eligibility-head">
                <Globe2 size={19} />
                <span><strong>官方地区资格</strong><small>风险提示仅列中国大陆、香港与澳门</small></span>
                <StatusPill tone="warning">不自动定位</StatusPill>
              </div>
              <p>本次核对：台湾已在官方支持清单中，不计为风险；中国大陆、香港、澳门未列出。名单可能更新，使用前以官方页面实时内容为准。</p>
              <div className="region-status-grid" aria-label="官方地区清单核对结果">
                <span className="is-listed"><strong>台湾</strong><small>官方支持</small></span>
                <span><strong>中国大陆</strong><small>当前官方清单未列出</small></span>
                <span><strong>香港</strong><small>当前官方清单未列出</small></span>
                <span><strong>澳门</strong><small>当前官方清单未列出</small></span>
              </div>
              <div className="region-privacy-note"><UserRoundCheck size={16} /><span>请用户主动确认实际所在地；本工具不读取 IP、不做中国 IP 评分，也不自动定位。</span></div>
              <a className="button tertiary full" href="https://support.claude.com/en/articles/8461763-where-can-i-access-claude" target="_blank" rel="noreferrer">查看官方地区清单 <ExternalLink size={14} /></a>
            </div>
          </div>
        </section>
      </div>

      <section className="page-card safety-boundary">
        <span className="boundary-icon"><ShieldCheck size={21} /></span>
        <div>
          <h2>合规边界</h2>
          <p>不会实施地区伪装、浏览器指纹篡改、代理轮换或用 sandbox 规避检测。Sandbox 只用于文件与令牌隔离，不用于欺骗平台风控。</p>
        </div>
        <div className="safety-links">
          <a className="button tertiary" href="https://status.anthropic.com/" target="_blank" rel="noreferrer">官方服务状态 <ExternalLink size={14} /></a>
          <a className="button secondary" href="https://support.claude.com/en/" target="_blank" rel="noreferrer">官方支持与申诉 <ExternalLink size={14} /></a>
        </div>
      </section>
    </>
  );
}

function AuditPage({ onMenu }: { onMenu: () => void }) {
  const states = [
    { state: "readback_verified", label: "已同步", note: "目标端以相同 nonce、scope 与 digest 回读。", tone: "success" as const },
    { state: "accepted_by_adapter", label: "上下文已注入", note: "适配器接收成功，尚无目标端回读证据。", tone: "primary" as const },
    { state: "delivered_unverified", label: "投递未验证", note: "HTTP 接收或工具返回不能证明平台已记住。", tone: "warning" as const },
    { state: "blocked", label: "已阻断", note: "命中 secret、跨 scope 或 authority 风险。", tone: "danger" as const },
  ];
  return (
    <>
      <TopBar title="审计记录" subtitle="日志只保存 ID、哈希、类别和状态，不保存正文或完整 prompt。" onMenu={onMenu} />
      <section className="page-card audit-table">
        <div className="audit-heading"><span>状态</span><span>用户可见文案</span><span>证据要求</span></div>
        {states.map((item) => (
          <div className="audit-row" key={item.state}>
            <code>{item.state}</code>
            <StatusPill tone={item.tone}>{item.label}</StatusPill>
            <p>{item.note}</p>
          </div>
        ))}
      </section>
    </>
  );
}

function SettingsPage({
  settings,
  setSettings,
  onSave,
  saveState,
  onMenu,
}: {
  settings: Record<Destination, ProjectionSettings>;
  setSettings: (settings: Record<Destination, ProjectionSettings>) => void;
  onSave: () => void;
  saveState: "idle" | "saving" | "saved" | "local";
  onMenu: () => void;
}) {
  const bothPolished = settings.claude_web.cross_cultural_polish && settings.claude_code.cross_cultural_polish;
  const [previewTarget, setPreviewTarget] = useState<Destination>("claude_code");
  const [preview, setPreview] = useState<ProjectionPreview>({
    canonical: originalPreview,
    projected: originalPreview,
    transform_state: "disabled",
  });
  const [previewing, setPreviewing] = useState(false);

  useEffect(() => {
    let active = true;
    setPreviewing(true);
    void previewProjection(previewTarget, originalPreview, settings[previewTarget].cross_cultural_polish)
      .then((result) => { if (active) setPreview(result); })
      .finally(() => { if (active) setPreviewing(false); });
    return () => { active = false; };
  }, [previewTarget, settings]);

  const setTarget = (target: Destination, patch: Partial<ProjectionSettings>) => {
    setSettings({ ...settings, [target]: { ...settings[target], ...patch } });
  };

  const setBothPolish = (enabled: boolean) => {
    setSettings({
      claude_web: { ...settings.claude_web, cross_cultural_polish: enabled },
      claude_code: { ...settings.claude_code, cross_cultural_polish: enabled },
    });
  };

  return (
    <>
      <TopBar
        title="Claude 记忆投影"
        subtitle="只调整发送给 Claude 的表达，原始记忆永远保留。"
        onMenu={onMenu}
      >
        <button type="button" className="button primary" onClick={onSave} disabled={saveState === "saving"}>
          {saveState === "saving" ? <RefreshCw className="spin" size={16} /> : <Check size={16} />}
          {saveState === "saving" ? "保存中" : "保存设置"}
        </button>
      </TopBar>
      <div className="settings-grid">
        <section className="page-card policy-card">
          <div className="policy-section">
            <span className="section-number">01</span>
            <div className="policy-copy"><h2>目标平台</h2><p>只为明确启用的目标生成投影。</p></div>
          </div>
          <label className="check-row">
            <input type="checkbox" checked={settings.claude_web.enabled} onChange={(event) => setTarget("claude_web", { enabled: event.target.checked })} />
            <PlatformIcon connector={connectorById.claude_web} />
            <span><strong>Claude Web</strong><small>Remote MCP · 无生命周期 Hook</small></span>
            <StatusPill tone="warning">受限</StatusPill>
          </label>
          <label className="check-row">
            <input type="checkbox" checked={settings.claude_code.enabled} onChange={(event) => setTarget("claude_code", { enabled: event.target.checked })} />
            <PlatformIcon connector={connectorById.claude_code} />
            <span><strong>Claude Code</strong><small>Hooks + MCP · 自动注入</small></span>
            <StatusPill tone="success">可接入</StatusPill>
          </label>

          <div className="policy-divider" />
          <div className="policy-section align-start">
            <span className="section-number">02</span>
            <div className="policy-copy">
              <div className="switch-heading">
                <span><h2>国际化表达润色</h2><p>改善跨文化可读性，不删除中国或其他国家相关事实。</p></span>
                <Switch checked={bothPolished} onChange={setBothPolish} label="国际化表达润色" />
              </div>
              <div className="info-banner"><Sparkles size={17} /><span><strong>不是“隐藏身份”</strong>只处理可编辑叙述和偏好；若要匿名化，必须使用另一套显式隐私脱敏流程。</span></div>
              <label className="field-label">输出语言<select className="select" value={settings.claude_code.output_language} onChange={(event) => {
                const output = event.target.value as ProjectionSettings["output_language"];
                setSettings({ claude_web: { ...settings.claude_web, output_language: output }, claude_code: { ...settings.claude_code, output_language: output } });
              }}><option value="preserve">保持原语言</option><option value="zh">中文</option><option value="en">English</option></select></label>
              <label className="toggle-row"><span><strong>先预览后使用</strong><small>需要确认投影后再交给适配器</small></span><Switch checked={settings.claude_code.require_preview} onChange={(value) => setSettings({ claude_web: { ...settings.claude_web, require_preview: value }, claude_code: { ...settings.claude_code, require_preview: value } })} label="先预览后使用" /></label>
            </div>
          </div>

          <div className="policy-divider" />
          <div className="policy-section align-start">
            <span className="section-number locked"><LockKeyhole size={14} /></span>
            <div className="policy-copy">
              <h2>固定事实保护 <span className="lock-label">不可关闭</span></h2>
              <p>这些类别会在转换前后校验；失败时跳过投影或阻断投递。</p>
              <div className="protection-grid">
                {["姓名与身份", "国家与国籍", "地点与组织", "法域与法律", "引用与来源", "代码与路径", "数值日期单位", "币种与 URL"].map((label) => <span key={label}><ShieldCheck size={14} />{label}</span>)}
              </div>
            </div>
          </div>
        </section>

        <section className="page-card preview-card">
          <div className="preview-head">
            <div><span className="eyebrow">Projection preview</span><h2>转换预览</h2></div>
            <div className="segmented">
              <button type="button" className={previewTarget === "claude_web" ? "active" : ""} onClick={() => setPreviewTarget("claude_web")}>Claude</button>
              <button type="button" className={previewTarget === "claude_code" ? "active" : ""} onClick={() => setPreviewTarget("claude_code")}>Claude Code</button>
            </div>
          </div>
          <div className="preview-block canonical-block">
            <div><span>原始记忆</span><StatusPill tone="neutral">Canonical</StatusPill></div>
            <p>{preview.canonical}</p>
          </div>
          <div className="preview-arrow"><ArrowRight size={18} /></div>
          <div className="preview-block projection-block">
            <div><span>出站投影</span><StatusPill tone={preview.transform_state === "blocked" ? "danger" : preview.transform_state === "applied" ? "success" : "neutral"}>{previewing ? "生成中" : preview.transform_state}</StatusPill></div>
            <p>{preview.projected}</p>
          </div>
          <div className="diff-audit">
            <h3><Fingerprint size={17} />事实校验</h3>
            <div><CheckCircle2 size={15} /> 香港、北京时间、09:00 保留</div>
            <div><CheckCircle2 size={15} /> 目标 scope 与权限保持不变</div>
            <div><CheckCircle2 size={15} /> Canonical digest 不变</div>
            {preview.warnings?.map((warning) => <div className="warning-line" key={warning}><Clock3 size={15} />{warning}</div>)}
          </div>
          <div className="preview-actions">
            <button type="button" className="button secondary" onClick={() => setPreview({ ...preview })}><RefreshCw size={15} />重新预览</button>
            <button type="button" className="button tertiary" onClick={() => void copyToClipboard(preview.projected)}><Copy size={15} />复制投影</button>
          </div>
        </section>
      </div>
      <div className="canonical-banner"><LockKeyhole size={17} /><span><strong>原始记忆保持不变</strong>关闭开关会停止生成新润色投影；历史 canonical 无需恢复。</span><StatusPill tone={saveState === "saved" ? "success" : saveState === "local" ? "warning" : "neutral"}>{saveState === "saved" ? "已保存" : saveState === "local" ? "仅本地" : `policy v${settings.claude_code.policy_version ?? 1}`}</StatusPill></div>
    </>
  );
}

function NewMemoryModal({
  open,
  close,
  submit,
}: {
  open: boolean;
  close: () => void;
  submit: (content: string) => Promise<void>;
}) {
  const [content, setContent] = useState("");
  const [saving, setSaving] = useState(false);
  if (!open) return null;
  const onSubmit = async (event: FormEvent) => {
    event.preventDefault();
    if (!content.trim()) return;
    setSaving(true);
    await submit(content.trim());
    setSaving(false);
    setContent("");
    close();
  };
  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) close(); }}>
      <form className="modal" onSubmit={onSubmit} aria-label="新增记忆">
        <div className="card-heading"><div><span className="eyebrow">Owner authored</span><h2>新增记忆</h2></div><button type="button" className="icon-button" onClick={close} aria-label="关闭"><X size={17} /></button></div>
        <p>由你直接输入的事实会作为已审批 canonical 保存。请不要粘贴密钥或私密令牌。</p>
        <textarea autoFocus value={content} onChange={(event) => setContent(event.target.value)} placeholder="例如：这个项目优先使用本地 SQLite，并在提交前运行测试。" />
        <div className="modal-actions"><button type="button" className="button tertiary" onClick={close}>取消</button><button type="submit" className="button primary" disabled={!content.trim() || saving}>{saving ? "保存中" : "保存原始记忆"}</button></div>
      </form>
    </div>
  );
}

export function App() {
  const [section, setSection] = useState<Section>("overview");
  const [snapshot, setSnapshot] = useState<HubSnapshot>(demoSnapshot);
  const [claudeAccessPaused, setClaudeAccessPaused] = useState(false);
  const [mobileNav, setMobileNav] = useState(false);
  const [newMemoryOpen, setNewMemoryOpen] = useState(false);
  const [announcement, setAnnouncement] = useState("");
  const [saveState, setSaveState] = useState<"idle" | "saving" | "saved" | "local">("idle");
  const [settings, setSettings] = useState<Record<Destination, ProjectionSettings>>(defaultSettings);

  useEffect(() => {
    document.documentElement.scrollTop = 0;
    document.body.scrollTop = 0;
  }, [section]);

  const announce = (message: string) => {
    setAnnouncement(message);
    window.setTimeout(() => setAnnouncement(""), 2800);
  };

  useEffect(() => {
    let active = true;
    void Promise.all([loadSnapshot(), getSettings("claude_web"), getSettings("claude_code")]).then(
      ([nextSnapshot, claudeWeb, claudeCode]) => {
        if (!active) return;
        setSnapshot(nextSnapshot);
        setSettings({ claude_web: claudeWeb, claude_code: claudeCode });
      },
    );
    return () => { active = false; };
  }, []);

  const approve = async (item: MemoryItem) => {
    if (snapshot.mode === "demo") {
      const approved = { ...item, status: "approved" as const, approved_at: new Date().toISOString() };
      setSnapshot({ ...snapshot, proposals: snapshot.proposals.filter((proposal) => proposal.id !== item.id), memories: [approved, ...snapshot.memories] });
      announce("演示记忆已批准；后端恢复后才会持久化");
      return;
    }
    try {
      const approved = await approveProposal(item.id);
      setSnapshot({ ...snapshot, proposals: snapshot.proposals.filter((proposal) => proposal.id !== item.id), memories: [approved, ...snapshot.memories] });
      announce("记忆已批准");
    } catch {
      announce("审批失败，未改变原始记忆");
    }
  };

  const reject = async (item: MemoryItem) => {
    if (snapshot.mode === "demo") {
      setSnapshot({ ...snapshot, proposals: snapshot.proposals.filter((proposal) => proposal.id !== item.id) });
      announce("演示提案已移除");
      return;
    }
    try {
      await forgetMemory(item.id);
      setSnapshot({ ...snapshot, proposals: snapshot.proposals.filter((proposal) => proposal.id !== item.id) });
      announce("提案已拒绝并生成 tombstone");
    } catch {
      announce("拒绝失败，提案仍保留");
    }
  };

  const forget = async (item: MemoryItem) => {
    if (!window.confirm("遗忘后，该记忆和投影应立即不可检索。继续吗？")) return;
    if (snapshot.mode === "demo") {
      setSnapshot({ ...snapshot, memories: snapshot.memories.filter((memory) => memory.id !== item.id) });
      announce("演示记忆已隐藏");
      return;
    }
    try {
      await forgetMemory(item.id);
      setSnapshot({ ...snapshot, memories: snapshot.memories.filter((memory) => memory.id !== item.id) });
      announce("记忆已遗忘，等待目标删除回执");
    } catch {
      announce("遗忘失败，记忆仍可检索");
    }
  };

  const addMemory = async (content: string) => {
    if (snapshot.mode === "demo") {
      const item: MemoryItem = {
        ...demoSnapshot.memories[0],
        id: `mem_local_${Date.now()}`,
        content,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      };
      setSnapshot({ ...snapshot, memories: [item, ...snapshot.memories] });
      announce("已加入演示数据；后端恢复后才会持久化");
      return;
    }
    try {
      const item = await proposeMemory(content);
      setSnapshot({ ...snapshot, memories: [item, ...snapshot.memories] });
      announce("原始记忆已保存");
    } catch {
      announce("保存失败，没有写入记忆");
    }
  };

  const saveSettings = async () => {
    setSaveState("saving");
    try {
      const [claudeWeb, claudeCode] = await Promise.all([
        updateSettings("claude_web", settings.claude_web),
        updateSettings("claude_code", settings.claude_code),
      ]);
      setSettings({ claude_web: claudeWeb, claude_code: claudeCode });
      setSaveState("saved");
      announce("投影策略已保存");
    } catch {
      setSaveState("local");
      announce("后端不可用，设置仅保留在当前页面");
    }
  };

  const titleBySection = useMemo(() => navItems.find((item) => item.id === section)?.label ?? "AI Agent MemoryHub", [section]);

  let page: ReactNode;
  if (section === "overview") page = <OverviewPage snapshot={snapshot} onApprove={(item) => void approve(item)} onReject={(item) => void reject(item)} onNewMemory={() => setNewMemoryOpen(true)} onNavigate={setSection} announce={announce} onMenu={() => setMobileNav(true)} />;
  else if (section === "memories") page = <MemoriesPage snapshot={snapshot} onForget={(item) => void forget(item)} onMenu={() => setMobileNav(true)} />;
  else if (section === "context") page = <ContextPage snapshot={snapshot} onMenu={() => setMobileNav(true)} announce={announce} />;
  else if (section === "connectors") page = <ConnectorsPage onMenu={() => setMobileNav(true)} />;
  else if (section === "environment") page = <EnvironmentPage onMenu={() => setMobileNav(true)} announce={announce} />;
  else if (section === "claude_safety") page = <ClaudeSafetyPage onMenu={() => setMobileNav(true)} announce={announce} onNavigate={setSection} accessPaused={claudeAccessPaused} setAccessPaused={setClaudeAccessPaused} />;
  else if (section === "audit") page = <AuditPage onMenu={() => setMobileNav(true)} />;
  else page = <SettingsPage settings={settings} setSettings={setSettings} onSave={() => void saveSettings()} saveState={saveState} onMenu={() => setMobileNav(true)} />;

  return (
    <div className="app-shell">
      <AppSidebar active={section} setActive={setSection} open={mobileNav} close={() => setMobileNav(false)} />
      {mobileNav && <button type="button" className="nav-scrim" aria-label="关闭导航" onClick={() => setMobileNav(false)} />}
      <main className="workspace" aria-label={titleBySection}>{page}</main>
      <NewMemoryModal open={newMemoryOpen} close={() => setNewMemoryOpen(false)} submit={addMemory} />
      <div className="sr-only" role="status" aria-live="polite">{announcement}</div>
      {announcement && <div className="toast"><CheckCircle2 size={17} />{announcement}</div>}
    </div>
  );
}
