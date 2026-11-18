// Live device data over MQTT: the browser connects to the Core's /mqtt
// WebSocket bridge (same origin) with the read-only `console` login, and
// subscribes to device presence and config results. Retained presence means
// every device's last state arrives as soon as we connect.
import mqtt, { type MqttClient } from "mqtt";
import { createContext, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { api, getToken, type DeviceStatus } from "./api";

export interface ConfigResult {
  type: "config";
  configVersion: number;
  status: "applied" | "unchanged" | "rejected";
  errors?: string[];
  receivedAt: string;
}

interface Live {
  connected: boolean;
  status: Record<string, DeviceStatus>;      // deviceId -> presence
  results: Record<string, ConfigResult[]>;   // deviceId -> newest first
}

const LiveContext = createContext<Live>({ connected: false, status: {}, results: {} });

export function LiveProvider({ children }: { children: ReactNode }) {
  const [connected, setConnected] = useState(false);
  const [status, setStatus] = useState<Record<string, DeviceStatus>>({});
  const [results, setResults] = useState<Record<string, ConfigResult[]>>({});
  const client = useRef<MqttClient | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const session = await api<{ mqtt: { path: string; username: string; password: string } }>("/console/session");
      if (cancelled) return;
      const proto = location.protocol === "https:" ? "wss" : "ws";
      const c = mqtt.connect(`${proto}://${location.host}${session.mqtt.path}?token=${encodeURIComponent(getToken())}`, {
        username: session.mqtt.username,
        password: session.mqtt.password,
        reconnectPeriod: 3000,
      });
      client.current = c;
      c.on("connect", () => {
        setConnected(true);
        c.subscribe(["devices/+/status", "devices/+/cmd/result"]);
      });
      c.on("close", () => setConnected(false));
      c.on("message", (topic, payload) => {
        const [, id, kind, sub] = topic.split("/");
        let body: unknown;
        try {
          body = JSON.parse(payload.toString());
        } catch {
          return;
        }
        if (kind === "status") {
          setStatus((s) => ({ ...s, [id]: { ...(body as DeviceStatus), at: new Date().toISOString() } }));
        } else if (kind === "cmd" && sub === "result" && (body as ConfigResult).type === "config") {
          const r = { ...(body as ConfigResult), receivedAt: new Date().toISOString() };
          setResults((all) => ({ ...all, [id]: [r, ...(all[id] ?? [])].slice(0, 10) }));
        }
      });
    })().catch(() => setConnected(false));
    return () => {
      cancelled = true;
      client.current?.end(true);
    };
  }, []);

  const value = useMemo(() => ({ connected, status, results }), [connected, status, results]);
  return <LiveContext.Provider value={value}>{children}</LiveContext.Provider>;
}

export const useLive = () => useContext(LiveContext);
