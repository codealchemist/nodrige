// Logs: a terminal for a panel's serial log (streamed over MQTT while this
// page is open) or the Core's own log. On a panel, the prompt runs shell
// commands on the device (help, stats, tasks, wifi, keys, reboot); their
// output comes back in the log. `clear` is handled here.
import { useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { api, type Device } from "../lib/api";
import { useLive } from "../lib/live";
import { Icon, PageHead } from "../components/icons";

type Line = { id: number; at: number; text: string; level?: "warn" | "error" | "cmd" | "info" };
const MAX_LINES = 4000;
const CORE = "core";

function classify(text: string): Line["level"] {
  if (text.startsWith("$ ")) return "cmd";
  if (/\b(error|failed|fail|panic|abort|guru|not sent|exception)\b/i.test(text)) return "error";
  if (/\b(warn(ing)?|timeout|retry|offline|unknown|disconnected|no reply)\b/i.test(text)) return "warn";
  return undefined;
}

export function LogsPage() {
  const [params, setParams] = useSearchParams();
  const devices = useQuery({ queryKey: ["devices"], queryFn: () => api<Device[]>("/devices") });
  const live = useLive();
  const source = params.get("source") ?? devices.data?.[0]?.id ?? CORE;
  const device = devices.data?.find((d) => d.id === source);
  const online = device ? (live.status[device.id] ?? device.status)?.state === "online" : true;

  const [lines, setLines] = useState<Line[]>([]);
  const [paused, setPaused] = useState(false);
  const [filter, setFilter] = useState("");
  const [stamps, setStamps] = useState(false);
  const [follow, setFollow] = useState(true);
  const nextId = useRef(1);
  const partial = useRef("");
  const pausedRef = useRef(paused);
  const held = useRef<Line[]>([]);
  pausedRef.current = paused;

  const push = (texts: string[], level?: Line["level"]) => {
    const now = Date.now();
    const add = texts.map((text) => ({ id: nextId.current++, at: now, text, level: level ?? classify(text) }));
    if (pausedRef.current) {
      held.current.push(...add);
      return;
    }
    setLines((l) => {
      const all = l.concat(add);
      return all.length > MAX_LINES ? all.slice(all.length - MAX_LINES) : all;
    });
  };

  // Switching source starts over.
  useEffect(() => {
    setLines([]);
    held.current = [];
    partial.current = "";
  }, [source]);

  // Panel: ask it to stream (backlog first), renew the lease, stop on leave.
  useEffect(() => {
    if (!device || !online) return;
    const diag = (body: object) => api(`/devices/${device.id}/diag`, { method: "POST", body: JSON.stringify(body) }).catch(() => {});
    diag({ action: "log_stream", seconds: 120, backlog: true });
    const renew = setInterval(() => diag({ action: "log_stream", seconds: 120 }), 60_000);
    const off = live.onLog((id, chunk) => {
      if (id !== device.id) return;
      if (chunk.lost) push([`… ${chunk.lost} bytes of log skipped (buffer overrun)`], "warn");
      const text = partial.current + chunk.text;
      const parts = text.split(/\r?\n/);
      partial.current = parts.pop() ?? "";
      if (parts.length) push(parts);
    });
    return () => {
      clearInterval(renew);
      off();
      diag({ action: "log_stream", seconds: 0 });
    };
  }, [device?.id, online, live.onLog]);

  // Core: poll its log.
  useEffect(() => {
    if (source !== CORE) return;
    let after = 0;
    let stop = false;
    const poll = async () => {
      try {
        const r = await api<{ lines: { seq: number; level: string; text: string }[]; last: number }>(`/logs/core?after=${after}`);
        for (const l of r.lines) push([l.text], l.level === "error" ? "error" : l.level === "warn" ? "warn" : undefined);
        after = r.last;
      } catch {}
      if (!stop) setTimeout(poll, 1000);
    };
    poll();
    return () => {
      stop = true;
    };
  }, [source]);

  const resume = () => {
    setPaused(false);
    const h = held.current;
    held.current = [];
    setLines((l) => l.concat(h).slice(-MAX_LINES));
  };

  const shown = useMemo(() => {
    if (!filter) return lines;
    const f = filter.toLowerCase();
    return lines.filter((l) => l.text.toLowerCase().includes(f));
  }, [lines, filter]);

  // Follow the end unless scrolled up.
  const screen = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (follow && screen.current) screen.current.scrollTop = screen.current.scrollHeight;
  }, [shown, follow]);

  const download = () => {
    const blob = new Blob([lines.map((l) => `${new Date(l.at).toISOString()} ${l.text}`).join("\n")], { type: "text/plain" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `${source}-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-")}.log`;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  const name = device?.name ?? "Core";
  return (
    <section className="logs-page">
      <PageHead title="Logs" sub={device ? (online ? "Streaming from the panel while this page is open" : "The panel is offline") : "The Core server's log"}>
        <select value={source} onChange={(e) => setParams({ source: e.target.value }, { replace: true })} aria-label="Log source">
          {devices.data?.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
          <option value={CORE}>Core server</option>
        </select>
      </PageHead>

      <div className="term">
        <div className="term-bar">
          <span className="term-dots"><i /><i /><i /></span>
          <span className="term-title">{name}{device && !online ? " (offline)" : ""}</span>
          <span className="grow" />
          <input className="term-filter" value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Filter" aria-label="Filter lines" />
          <button className={`term-btn ${stamps ? "on" : ""}`} onClick={() => setStamps(!stamps)} title="Timestamps">ts</button>
          <button className={`term-btn ${paused ? "on" : ""}`} onClick={() => (paused ? resume() : setPaused(true))} title={paused ? "Resume" : "Pause"}>
            {paused ? `▶ ${held.current.length || ""}` : "❚❚"}
          </button>
          <button className="term-btn" onClick={() => setLines([])} title="Clear">⌫</button>
          <button className="term-btn" onClick={download} title="Download">⤓</button>
        </div>
        <div
          className="term-screen"
          ref={screen}
          onScroll={(e) => {
            const el = e.currentTarget;
            setFollow(el.scrollHeight - el.scrollTop - el.clientHeight < 24);
          }}
        >
          {shown.length === 0 && (
            <div className="term-line dim">{device && !online ? "The panel is offline; its log streams when it's back." : filter ? "No lines match the filter." : "Waiting for output…"}</div>
          )}
          {shown.map((l) => (
            <div key={l.id} className={`term-line ${l.level ?? ""}`}>
              {stamps && <span className="term-ts">{new Date(l.at).toLocaleTimeString([], { hour12: false })}</span>}
              <Highlight text={l.text} />
            </div>
          ))}
        </div>
        {!follow && (
          <button className="term-jump" onClick={() => setFollow(true)}><Icon name="chevronRight" size={14} className="rot90" /> Latest</button>
        )}
        {device ? <Prompt deviceId={device.id} disabled={!online} onLocal={(cmd) => cmd === "clear" && setLines([])} /> : <div className="term-prompt ro">read-only</div>}
      </div>
    </section>
  );
}

// "[Switch] lights -> on": the tag stands out.
function Highlight({ text }: { text: string }) {
  const m = /^(\$ |\[[^\]]{1,24}\])(.*)$/.exec(text);
  if (!m) return <>{text || " "}</>;
  return (
    <>
      <span className="term-tag">{m[1]}</span>
      {m[2]}
    </>
  );
}

function Prompt({ deviceId, disabled, onLocal }: { deviceId: string; disabled: boolean; onLocal: (cmd: string) => void }) {
  const [value, setValue] = useState("");
  const [history, setHistory] = useState<string[]>([]);
  const [pos, setPos] = useState(-1);
  const [error, setError] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);

  const run = async (line: string) => {
    const l = line.trim();
    if (!l) return;
    setHistory((h) => [l, ...h.filter((x) => x !== l)].slice(0, 50));
    setPos(-1);
    setValue("");
    if (l === "clear") return onLocal("clear");
    if (l === "reboot" && !confirm("Restart the panel?")) return;
    try {
      setError(null);
      await api(`/devices/${deviceId}/diag`, { method: "POST", body: JSON.stringify({ action: "shell", line: l }) });
    } catch (e) {
      setError((e as Error).message);
    }
  };

  return (
    <form
      className="term-prompt"
      onSubmit={(e) => {
        e.preventDefault();
        run(value);
      }}
      onClick={() => input.current?.focus()}
    >
      <span className="term-ps">panel $</span>
      <input
        ref={input}
        value={value}
        disabled={disabled}
        spellCheck={false}
        autoCapitalize="off"
        autoComplete="off"
        placeholder={disabled ? "offline" : "help"}
        aria-label="Shell command"
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "ArrowUp" && history.length) {
            e.preventDefault();
            const p = Math.min(pos + 1, history.length - 1);
            setPos(p);
            setValue(history[p]);
          } else if (e.key === "ArrowDown") {
            e.preventDefault();
            const p = pos - 1;
            setPos(Math.max(p, -1));
            setValue(p >= 0 ? history[p] : "");
          }
        }}
      />
      {error && <span className="term-err">{error}</span>}
    </form>
  );
}
