import { StrictMode, useState } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, NavLink, Navigate, Route, Routes } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { getToken, setToken } from "./lib/api";
import { LiveProvider, useLive } from "./lib/live";
import { DevicesPage } from "./pages/Devices";
import { DevicePage } from "./pages/Device";
import { ConfigsPage } from "./pages/Configs";
import { ConfigEditPage } from "./pages/ConfigEdit";
import "./styles.css";

const queryClient = new QueryClient({ defaultOptions: { queries: { refetchOnWindowFocus: false, retry: 1 } } });

function Login({ onDone }: { onDone: () => void }) {
  const [token, setValue] = useState("");
  return (
    <div className="login">
      <h1>nodrige console</h1>
      <p className="muted">Enter the Core's access token (<code>DEV_BEARER_TOKEN</code> in the Core's <code>.env</code>).</p>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          setToken(token.trim());
          onDone();
        }}
      >
        <input type="password" autoFocus value={token} onChange={(e) => setValue(e.target.value)} placeholder="Token" />
        <button type="submit" disabled={!token.trim()}>Sign in</button>
      </form>
    </div>
  );
}

function LiveBadge() {
  const { connected } = useLive();
  return <span className={`live ${connected ? "on" : "off"}`}>{connected ? "Live" : "Offline"}</span>;
}

function Shell() {
  return (
    <LiveProvider>
      <div className="shell">
        <nav className="side">
          <div className="brand">nodrige</div>
          <NavLink to="/devices">Devices</NavLink>
          <NavLink to="/configs">Configs</NavLink>
          <div className="grow" />
          <LiveBadge />
          <span className="muted small version">Console v{__APP_VERSION__}</span>
          <button
            className="link"
            onClick={() => {
              setToken("");
              location.reload();
            }}
          >
            Sign out
          </button>
        </nav>
        <main>
          <Routes>
            <Route path="/" element={<Navigate to="/devices" replace />} />
            <Route path="/devices" element={<DevicesPage />} />
            <Route path="/devices/:id" element={<DevicePage />} />
            <Route path="/configs" element={<ConfigsPage />} />
            <Route path="/configs/:id" element={<ConfigEditPage />} />
          </Routes>
        </main>
      </div>
    </LiveProvider>
  );
}

function App() {
  const [signedIn, setSignedIn] = useState(Boolean(getToken()));
  return signedIn ? <Shell /> : <Login onDone={() => setSignedIn(true)} />;
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <BrowserRouter basename="/console">
        <App />
      </BrowserRouter>
    </QueryClientProvider>
  </StrictMode>
);
