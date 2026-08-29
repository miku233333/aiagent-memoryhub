import { defaultSettings, demoSnapshot } from "./demo";
import type {
  Destination,
  HubSnapshot,
  MemoryItem,
  ProjectionPreview,
  ProjectionSettings,
} from "./types";

const USER_ID = "local-user";
const PROJECT_ID = "agent-sync";

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...init?.headers,
    },
  });
  if (!response.ok) {
    throw new Error(`${response.status} ${response.statusText}`);
  }
  return response.json() as Promise<T>;
}

function unwrapItems(payload: unknown): MemoryItem[] {
  if (Array.isArray(payload)) return payload as MemoryItem[];
  if (payload && typeof payload === "object" && "items" in payload) {
    const items = (payload as { items: unknown }).items;
    return Array.isArray(items) ? (items as MemoryItem[]) : [];
  }
  return [];
}

export async function loadSnapshot(): Promise<HubSnapshot> {
  try {
    await request<{ status: string }>("/health");
    const approvedPayload = await request<unknown>(
      `/v1/memories?user_id=${USER_ID}&project_id=${PROJECT_ID}`,
    );
    let all = unwrapItems(approvedPayload);

    try {
      const pendingPayload = await request<unknown>(
        `/v1/memory/proposals?user_id=${USER_ID}&project_id=${PROJECT_ID}&status=pending&limit=100`,
      );
      all = [...all, ...unwrapItems(pendingPayload)];
    } catch {
      // Older servers may not expose pending items. The approved list remains live.
    }

    const unique = [...new Map(all.map((item) => [item.id, item])).values()];
    return {
      memories: unique.filter((item) => item.status === "approved"),
      proposals: unique.filter((item) => item.status === "pending"),
      mode: "live",
      health: "healthy",
    };
  } catch {
    return demoSnapshot;
  }
}

export async function approveProposal(id: string): Promise<MemoryItem> {
  const payload = await request<{ item: MemoryItem }>(
    `/v1/memory/proposals/${encodeURIComponent(id)}/approve`,
    {
      method: "POST",
      body: JSON.stringify({ scope: { user_id: USER_ID, project_id: PROJECT_ID } }),
    },
  );
  return payload.item;
}

export async function proposeMemory(content: string): Promise<MemoryItem> {
  const payload = await request<{ item: MemoryItem }>("/v1/memory/proposals", {
    method: "POST",
    body: JSON.stringify({
      scope: { user_id: USER_ID, project_id: PROJECT_ID },
      content,
      explicit_user_fact: true,
      source_platform: "memory_hub_web",
      metadata: { kind: "narrative", created_by: "owner" },
    }),
  });
  return payload.item;
}

export async function forgetMemory(id: string): Promise<MemoryItem> {
  const payload = await request<{ item: MemoryItem }>(
    `/v1/memories/${encodeURIComponent(id)}/forget`,
    {
      method: "POST",
      body: JSON.stringify({ scope: { user_id: USER_ID, project_id: PROJECT_ID } }),
    },
  );
  return payload.item;
}

export async function getSettings(target: Destination): Promise<ProjectionSettings> {
  try {
    const payload = await request<{
      setting: {
        target: Destination;
        cross_cultural_polish: boolean;
      };
    }>(
      `/v1/settings/${USER_ID}/${target}`,
    );
    return {
      ...defaultSettings[target],
      target: payload.setting.target,
      cross_cultural_polish: payload.setting.cross_cultural_polish,
    };
  } catch {
    return defaultSettings[target];
  }
}

export async function updateSettings(
  target: Destination,
  settings: ProjectionSettings,
): Promise<ProjectionSettings> {
  const payload = await request<{
    setting: {
      target: Destination;
      cross_cultural_polish: boolean;
    };
  }>(
    `/v1/settings/${USER_ID}/${target}`,
    {
      method: "PUT",
      body: JSON.stringify({
        cross_cultural_polish: settings.cross_cultural_polish,
      }),
    },
  );
  return {
    ...settings,
    target: payload.setting.target,
    cross_cultural_polish: payload.setting.cross_cultural_polish,
  };
}

export async function previewProjection(
  target: Destination,
  content: string,
  enabled: boolean,
): Promise<ProjectionPreview> {
  try {
    const payload = await request<{
      canonical_content: string;
      rendered_content: string;
      enabled: boolean;
      changed: boolean;
      canonical_digest: string;
      rendered_digest: string;
      applied_rules: string[];
    }>("/v1/projections/preview", {
      method: "POST",
      body: JSON.stringify({
        user_id: USER_ID,
        target,
        content,
      }),
    });
    return {
      canonical: payload.canonical_content,
      projected: payload.rendered_content,
      transform_state: payload.enabled
        ? payload.changed
          ? "applied"
          : "skipped"
        : "disabled",
      canonical_digest: payload.canonical_digest,
      projected_digest: payload.rendered_digest,
      warnings: payload.applied_rules,
    };
  } catch {
    return {
      canonical: content,
      projected: enabled
        ? "中国大陆境内服务器需要完成适用的备案要求；国际互联网访问经香港节点路由；每天中国标准时间（UTC+8）09:00 检查。"
        : content,
      transform_state: enabled ? "applied" : "disabled",
      warnings: ["本地预览：后端不可用，结果未投递。"],
    };
  }
}
