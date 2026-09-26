import { useCallback, useEffect, useMemo, useState } from "react";
import {
  apiDefaultRelay,
  apiDisconnect,
  apiListGames,
  apiLogout,
  apiMe,
  errMsg,
  isSessionRejected,
  setToken,
} from "./api.js";
import LoginScreen from "./screens/LoginScreen.jsx";
import RegisterScreen from "./screens/RegisterScreen.jsx";
import HomeScreen from "./screens/HomeScreen.jsx";
import BoostScreen from "./screens/BoostScreen.jsx";
import AdminScreen from "./screens/AdminScreen.jsx";

const SESSION_KEY = "gsb-session-v2";
const RELAY_OVERRIDE_KEY = "gsb-relay-override-v1";
const REGIONS_KEY = "gpb-regions-v2";
const POLL_MS = 60_000;
const DEV_ROLES = ["developer", "admin"];
const EMPTY_RELAY = { endpoint: "", psk: "" };

function loadJson(key, fallback) {
  try {
    return JSON.parse(localStorage.getItem(key)) ?? fallback;
  } catch {
    return fallback;
  }
}

function saveJson(key, value) {
  if (value == null) localStorage.removeItem(key);
  else localStorage.setItem(key, JSON.stringify(value));
}

/** Regions the profile marks as helped by its relays; the rest stay off until ticked. */
function defaultRegionIds(game) {
  return (game?.regions || []).filter((r) => r.cidrCount > 0 && r.defaultOn).map((r) => r.id);
}

const hasRelay = (r) => !!(r?.endpoint?.trim() && r?.psk);

export default function App() {
  const [screen, setScreen] = useState("boot"); // boot | login | register | home | boost | admin
  const [user, setUser] = useState(null);
  const [developerMode, setDeveloperMode] = useState(false);
  const [serverRelay, setServerRelay] = useState(EMPTY_RELAY);
  const [buildRelay, setBuildRelay] = useState(EMPTY_RELAY);
  const [relayOverride, setRelayOverride] = useState(() => loadJson(RELAY_OVERRIDE_KEY, EMPTY_RELAY));
  const [games, setGames] = useState([]);
  const [selectedGame, setSelectedGame] = useState(null);
  const [regions, setRegions] = useState(() => loadJson(REGIONS_KEY, {}));
  const [notice, setNotice] = useState("");
  const [bootError, setBootError] = useState("");

  const applyAuth = useCallback((data) => {
    setUser(data.user);
    setDeveloperMode(!!data.developerMode);
    setServerRelay(data.relay || EMPTY_RELAY);
  }, []);

  const endSession = useCallback((message = "") => {
    apiDisconnect().catch(() => {});
    setToken("");
    saveJson(SESSION_KEY, null);
    setUser(null);
    setServerRelay(EMPTY_RELAY);
    setNotice(message);
    setScreen("login");
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [list, defaults] = await Promise.all([apiListGames(), apiDefaultRelay()]);
        if (cancelled) return;
        setGames(list);
        setSelectedGame((prev) => prev || list.find((g) => g.isDefault) || list[0] || null);
        setBuildRelay({ endpoint: defaults.endpoint || "", psk: defaults.psk || "" });
      } catch (e) {
        if (!cancelled) setBootError(errMsg(e));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    const saved = loadJson(SESSION_KEY, null);
    if (!saved?.token) {
      setScreen("login");
      return;
    }
    setToken(saved.token);
    apiMe()
      .then((data) => {
        applyAuth(data);
        setScreen("home");
      })
      .catch((e) => {
        if (isSessionRejected(e)) endSession(e.status === 401 ? "" : e.message);
        else {
          setNotice(errMsg(e));
          setScreen("login");
        }
      });
  }, [applyAuth, endSession]);

  // Developer mode, a lock, or a revoked session reaches an open app within a minute.
  useEffect(() => {
    if (!user) return undefined;
    const id = setInterval(() => {
      apiMe()
        .then(applyAuth)
        .catch((e) => {
          if (isSessionRejected(e)) endSession(e.message);
        });
    }, POLL_MS);
    return () => clearInterval(id);
  }, [user, applyAuth, endSession]);

  const onLoggedIn = useCallback(
    (data) => {
      setToken(data.token);
      saveJson(SESSION_KEY, { token: data.token });
      setNotice("");
      applyAuth(data);
      setScreen("home");
    },
    [applyAuth],
  );

  const onLogout = useCallback(() => {
    apiLogout().catch(() => {});
    endSession();
  }, [endSession]);

  const refreshMe = useCallback(() => {
    apiMe()
      .then(applyAuth)
      .catch((e) => {
        if (isSessionRejected(e)) endSession(e.message);
      });
  }, [applyAuth, endSession]);

  const onRelayOverrideChange = useCallback((next) => {
    setRelayOverride(next);
    saveJson(RELAY_OVERRIDE_KEY, next);
  }, []);

  const onRegionsChange = useCallback((gameId, ids) => {
    setRegions((prev) => {
      const next = { ...prev, [gameId]: ids };
      saveJson(REGIONS_KEY, next);
      return next;
    });
  }, []);

  const isDev = DEV_ROLES.includes(user?.role);
  const relay = useMemo(() => {
    if (isDev && hasRelay(relayOverride)) return { ...relayOverride, source: "override" };
    if (hasRelay(serverRelay)) return { ...serverRelay, source: "server" };
    if (hasRelay(buildRelay)) return { ...buildRelay, source: "build" };
    return { ...EMPTY_RELAY, source: "none" };
  }, [isDev, relayOverride, serverRelay, buildRelay]);

  return (
    <div className={`app${screen === "admin" ? " wide" : ""}`}>
      {bootError && screen !== "login" && screen !== "register" ? <p className="error">{bootError}</p> : null}

      {screen === "boot" && <p className="hint muted">Đang kiểm tra phiên đăng nhập…</p>}

      {screen === "login" && (
        <LoginScreen notice={notice} onSuccess={onLoggedIn} onGoRegister={() => setScreen("register")} />
      )}

      {screen === "register" && (
        <RegisterScreen
          onSuccess={onLoggedIn}
          onBlocked={(message) => {
            setNotice(message);
            setScreen("login");
          }}
          onGoLogin={() => setScreen("login")}
        />
      )}

      {screen === "home" && user && (
        <HomeScreen
          user={user}
          developerMode={developerMode}
          games={games}
          selected={selectedGame}
          onSelect={setSelectedGame}
          onLogout={onLogout}
          onAdmin={user.role === "admin" ? () => setScreen("admin") : null}
          onBoost={() => selectedGame && setScreen("boost")}
        />
      )}

      {screen === "boost" && user && selectedGame && (
        <BoostScreen
          game={selectedGame}
          regionIds={(regions[selectedGame.id] ?? defaultRegionIds(selectedGame)).filter((id) =>
            selectedGame.regions.some((r) => r.id === id),
          )}
          onRegionsChange={(ids) => onRegionsChange(selectedGame.id, ids)}
          relay={relay}
          canEditRelay={isDev}
          relayOverride={relayOverride}
          onRelayOverrideChange={onRelayOverrideChange}
          onBack={() => setScreen("home")}
        />
      )}

      {screen === "admin" && user?.role === "admin" && (
        <AdminScreen me={user} onChanged={refreshMe} onSessionRejected={endSession} onBack={() => setScreen("home")} />
      )}
    </div>
  );
}
