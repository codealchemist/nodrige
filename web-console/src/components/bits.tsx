import type { ConfigMeta, Device } from "../lib/api";

export function StateDot({ state }: { state?: string }) {
  return <span className={`dot ${state === "online" ? "on" : state === "offline" ? "off" : "unknown"}`} title={state ?? "unknown"} />;
}

export function ago(iso?: string): string {
  if (!iso) return "never";
  const s = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 1000));
  if (s < 10) return "just now";
  if (s < 60) return `${s} s ago`;
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} days ago`;
}

export function ResultBadge({ status }: { status: string }) {
  return <span className={`badge ${status}`}>{status}</span>;
}

// "Default v3", plus whether the library has moved on since it was sent.
export function SentConfig({ device, configs }: { device: Device; configs?: ConfigMeta[] }) {
  const sent = device.sentConfig;
  if (!sent) return <>–</>;
  const lib = configs?.find((c) => c.id === sent.libraryId);
  const name = lib?.name ?? sent.libraryId;
  const outdated = lib && sent.libraryVersion !== undefined && lib.version > sent.libraryVersion;
  return (
    <>
      {name}
      {sent.libraryVersion !== undefined ? ` v${sent.libraryVersion}` : ""}
      {outdated && <span className="badge outdated" title={`The library has ${name} v${lib!.version}`}>v{lib!.version} available</span>}
      {!lib && <span className="badge rejected">deleted</span>}
    </>
  );
}

export function StatePill({ state }: { state?: string }) {
  const cls = state === "online" ? "on" : state === "offline" ? "off" : "unknown";
  return (
    <span className={`state-pill ${cls}`}>
      <span className="live-dot" />
      {state ?? "unknown"}
    </span>
  );
}
