// Live device data over MQTT: the browser connects to the Core's /mqtt
// WebSocket bridge (same origin) with the read-only `console` login, and
// subscribes to device presence and config results. Retained presence means
// every device's last state arrives as soon as we connect.
import mqtt, { type MqttClient } from "mqtt";
import { createContext, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { api, getToken, type DeviceStatus, type Telemetry } from "./api";

export interface ConfigResult {
  type: "config";
  configVersion: number;
  status: "applied" | "unchanged" | "rejected";
  errors?: string[];
  receivedAt: string;
}

export interface LogChunk {
  seq: number;
  text: string;
  lost?: number;
}
type LogListener = (deviceId: string, chunk: LogChunk) => void;

interface Live {
  connected: boolean;
  status: Record<string, DeviceStatus>;      // deviceId -> presence
  results: Record<string, ConfigResult[]>;   // deviceId -> newest first
  telemetry: Record<string, Telemetry>;      // deviceId -> latest reading
  // Device log chunks (only flow while a Logs page asks the device to stream).
  onLog: (fn: LogListener) => () => void;
}

const LiveContext = createContext<Live>({ connected: false, status: {}, results: {}, telemetry: {}, onLog: () => () => {} });

export function LiveProvider({ children }: { children: ReactNode }) {
  const [connected, setConnected] = useState(false);
  const [status, setStatus] = useState<Record<string, DeviceStatus>>({});
  const [results, setResults] = useState<Record<string, ConfigResult[]>>({});
  const [telemetry, setTelemetry] = useState<Record<string, Telemetry>>({});
  const client = useRef<MqttClient | null>(null);
  const logListeners = useRef(new Set<LogListener>());

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
        c.subscribe(["devices/+/status", "devices/+/cmd/result", "devices/+/telemetry", "devices/+/log"]);
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
        if (kind === "log") {
          for (const fn of logListeners.current) fn(id, body as LogChunk);
        } else if (kind === "telemetry") {
          setTelemetry((t) => ({ ...t, [id]: { ...(body as Telemetry), at: new Date().toISOString() } }));
        } else if (kind === "status") {
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

  const onLog = useMemo(
    () => (fn: LogListener) => {
      logListeners.current.add(fn);
      return () => void logListeners.current.delete(fn);
    },
    []
  );
  const value = useMemo(() => ({ connected, status, results, telemetry, onLog }), [connected, status, results, telemetry, onLog]);
  return <LiveContext.Provider value={value}>{children}</LiveContext.Provider>;
}

export const useLive = () => useContext(LiveContext);
