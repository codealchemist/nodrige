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
import { Icon } from "./components/icons";
import "@fontsource/montserrat/600.css";
import "@fontsource/montserrat/700.css";
import "./styles.css";

const queryClient = new QueryClient({ defaultOptions: { queries: { refetchOnWindowFocus: false, retry: 1 } } });

function Login({ onDone }: { onDone: () => void }) {
  const [token, setValue] = useState("");
  return (
    <div className="login-wrap">
      <div className="login">
        <img className="login-logo" src={`${import.meta.env.BASE_URL}logo.png`} alt="" />
        <h1>nodrige console</h1>
        <p className="muted small">
          Enter the Core's access token: <code>DEV_BEARER_TOKEN</code> in the Core's <code>.env</code>.
        </p>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            setToken(token.trim());
            onDone();
          }}
        >
          <input type="password" autoFocus value={token} onChange={(e) => setValue(e.target.value)} placeholder="Access token" aria-label="Access token" />
          <button type="submit" disabled={!token.trim()}>Sign in</button>
        </form>
      </div>
    </div>
  );
}

function LiveBadge() {
  const { connected } = useLive();
  return (
    <span className={`live ${connected ? "on" : "off"}`} title={connected ? "Receiving live updates from the Core" : "Not connected to the Core's live feed"}>
      <span className="live-dot" />
      {connected ? "Live" : "Offline"}
    </span>
  );
}

const signOut = () => {
  setToken("");
  location.reload();
};

function Shell() {
  const logo = `${import.meta.env.BASE_URL}logo.png`;
  return (
    <LiveProvider>
      <div className="shell">
        {/* Phones: top bar here, the nav below turns into a bottom tab bar. */}
        <header className="topbar">
          <div className="brand"><img src={logo} alt="" />nodrige</div>
          <span className="grow" />
          <LiveBadge />
          <button className="icon-only" onClick={signOut} title="Sign out" aria-label="Sign out"><Icon name="signOut" /></button>
        </header>
        <nav className="side">
          <div className="brand"><img src={logo} alt="" />nodrige</div>
          <NavLink to="/devices"><Icon name="devices" /><span>Devices</span></NavLink>
          <NavLink to="/configs"><Icon name="configs" /><span>Configs</span></NavLink>
          <div className="side-foot">
            <LiveBadge />
            <button className="link" onClick={signOut}><Icon name="signOut" size={16} /> Sign out</button>
            <span className="muted small">Console v{__APP_VERSION__}</span>
          </div>
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
