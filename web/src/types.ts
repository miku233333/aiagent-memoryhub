export type Destination = "claude_web" | "claude_code";

export type MemoryStatus = "pending" | "approved" | "forgotten";

export interface MemoryItem {
  id: string;
  scope: { user_id: string; project_id?: string | null };
  content: string;
  canonical_digest?: string;
  status: MemoryStatus;
  explicit_user_fact: boolean;
  source_platform: string;
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
  approved_at?: string | null;
  forgotten_at?: string | null;
}

export interface ProjectionSettings {
  target: Destination;
  enabled: boolean;
  cross_cultural_polish: boolean;
  output_language: "preserve" | "zh" | "en";
  require_preview: boolean;
  policy_version?: number;
}

export interface ProjectionPreview {
  canonical: string;
  projected: string;
  transform_state: "applied" | "disabled" | "skipped" | "blocked";
  canonical_digest?: string;
  projected_digest?: string;
  warnings?: string[];
}

export interface HubSnapshot {
  memories: MemoryItem[];
  proposals: MemoryItem[];
  mode: "live" | "demo";
  health: "healthy" | "degraded";
}
