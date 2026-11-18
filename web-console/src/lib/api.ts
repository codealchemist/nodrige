// Core HTTP API. The token is the Core's bearer token (DEV_BEARER_TOKEN in
// the Core's .env for now), kept in this browser's localStorage.

const TOKEN_KEY = "nodrige.token";

export function getToken(): string {
  try {
    return localStorage.getItem(TOKEN_KEY) ?? "";
  } catch {
    return "";
  }
}

export function setToken(token: string) {
  try {
    if (token) localStorage.setItem(TOKEN_KEY, token);
    else localStorage.removeItem(TOKEN_KEY);
  } catch {
    /* private mode: token lasts for this page only */
  }
}

export class ApiError extends Error {
  constructor(public status: number, message: string, public body?: unknown) {
    super(message);
  }
}

export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${getToken()}`,
      ...(init.headers ?? {}),
    },
  });
  if (res.status === 204) return undefined as T;
  const body = await res.json().catch(() => undefined);
  if (!res.ok) throw new ApiError(res.status, (body as { error?: string })?.error ?? res.statusText, body);
  return body as T;
}

// --- Types shared with the Core ---

export interface DeviceStatus {
  state: "online" | "offline";
  ip?: string;
  fw?: string;
  configVersion?: number;
  at?: string;
}

export interface Device {
  id: string;
  name: string;
  firstSeen: string;
  lastSeen?: string;
  status?: DeviceStatus;
  configVersion?: number;
  lastConfigResult?: { status: string; configVersion: number; errors: string[]; at: string };
  // libraryVersion: the library entry's version this delivery carried.
  sentConfig?: { libraryId: string; libraryVersion?: number; configVersion: number; at: string };
}

export interface ConfigMeta {
  id: string;
  name: string;
  description: string;
  version: number;  // library edit counter (not the device's configVersion)
  updatedAt: string;
  items: number;
}

export interface MenuNode {
  id: string;
  type: "task" | "switch" | "folder" | "action";
  label: string;
  icon?: string;
  action?: string;
  binding?: string;
  children?: MenuNode[];
  task?: { payload: Record<string, unknown>; qos?: number; expectsResult?: boolean; params?: unknown[] };
  switch?: {
    payload: Record<string, unknown>;
    on?: Record<string, unknown>;
    off?: Record<string, unknown>;
    qos?: number;
    expectsResult?: boolean;
    default?: boolean;
  };
  shortcut?: boolean | { off?: Record<string, unknown> };
}

export interface PanelConfig {
  configVersion?: number;
  mqtt?: Record<string, unknown>;
  menu: MenuNode[];
}

export interface ConfigEntry {
  id: string;
  name: string;
  description: string;
  version: number;
  updatedAt: string;
  config: PanelConfig;
  errors: string[];
}

export interface Catalog {
  icons: { id: string; size: number; url: string }[];
  actions: { id: string; label: string }[];
  scenes: string[];
  tasks: string[];
  defaultConfig: PanelConfig | null;
}

export const iconUrl = (id: string) => `/catalog/icons/${id}.png`;
