import { useCallback, useEffect, useState } from "react";
import { apiDefaultRelay, apiListGames, errMsg } from "./api.js";
import LoginScreen from "./screens/LoginScreen.jsx";
import RegisterScreen from "./screens/RegisterScreen.jsx";
import HomeScreen from "./screens/HomeScreen.jsx";
import BoostScreen from "./screens/BoostScreen.jsx";

const SESSION_KEY = "gpb-session-v1";
const RELAY_KEY = "gpb-relay-v1";
const REGIONS_KEY = "gpb-regions-v2";

function loadRegions() {
  try {
    return JSON.parse(localStorage.getItem(REGIONS_KEY)) || {};
  } catch {
    return {};
  }
}

/** Regions the profile marks as helped by its relays; the rest stay off until ticked. */
function defaultRegionIds(game) {
  return (game?.regions || []).filter((r) => r.cidrCount > 0 && r.defaultOn).map((r) => r.id);
}

function loadSession() {
  try {
    const raw = localStorage.getItem(SESSION_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function saveSession(user) {
  if (!user) localStorage.removeItem(SESSION_KEY);
  else localStorage.setItem(SESSION_KEY, JSON.stringify(user));
}

function loadRelay() {
  try {
    const raw = localStorage.getItem(RELAY_KEY);
    return raw
      ? JSON.parse(raw)
      : { endpoint: "", psk: "" };
  } catch {
    return { endpoint: "", psk: "" };
  }
}

export default function App() {
  const [screen, setScreen] = useState("login"); // login | register | home | boost
  const [user, setUser] = useState(null);
  const [games, setGames] = useState([]);
  const [selectedGame, setSelectedGame] = useState(null);
  const [relay, setRelay] = useState(loadRelay);
  const [regions, setRegions] = useState(loadRegions);
  const [bootError, setBootError] = useState("");

  useEffect(() => {
    const s = loadSession();
    if (s?.username) {
      setUser(s);
      setScreen("home");
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [list, defaults] = await Promise.all([apiListGames(), apiDefaultRelay()]);
        if (cancelled) return;
        setGames(list);
        const def = list.find((g) => g.isDefault) || list[0] || null;
        setSelectedGame((prev) => prev || def);
        setRelay((prev) => {
          const next = {
            endpoint: prev.endpoint?.trim() ? prev.endpoint : defaults.endpoint || "",
            psk: prev.psk ? prev.psk : defaults.psk || "",
          };
          localStorage.setItem(RELAY_KEY, JSON.stringify(next));
          return next;
        });
      } catch (e) {
        if (!cancelled) setBootError(errMsg(e));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const onLoggedIn = useCallback((u) => {
    setUser(u);
    saveSession(u);
    setScreen("home");
  }, []);

  const onLogout = useCallback(() => {
    setUser(null);
    saveSession(null);
    setScreen("login");
  }, []);

  const onRelayChange = useCallback((next) => {
    setRelay(next);
    localStorage.setItem(RELAY_KEY, JSON.stringify(next));
  }, []);

  const onRegionsChange = useCallback((gameId, ids) => {
    setRegions((prev) => {
      const next = { ...prev, [gameId]: ids };
      localStorage.setItem(REGIONS_KEY, JSON.stringify(next));
      return next;
    });
  }, []);

  return (
    <div className="app">
      {bootError ? <p className="error">{bootError}</p> : null}

      {screen === "login" && (
        <LoginScreen
          onSuccess={onLoggedIn}
          onGoRegister={() => setScreen("register")}
        />
      )}

      {screen === "register" && (
        <RegisterScreen
          onSuccess={onLoggedIn}
          onGoLogin={() => setScreen("login")}
        />
      )}

      {screen === "home" && user && (
        <HomeScreen
          user={user}
          games={games}
          selected={selectedGame}
          onSelect={setSelectedGame}
          onLogout={onLogout}
          onBoost={() => selectedGame && setScreen("boost")}
        />
      )}

      {screen === "boost" && selectedGame && (
        <BoostScreen
          game={selectedGame}
          regionIds={(regions[selectedGame.id] ?? defaultRegionIds(selectedGame)).filter((id) =>
            selectedGame.regions.some((r) => r.id === id),
          )}
          onRegionsChange={(ids) => onRegionsChange(selectedGame.id, ids)}
          relay={relay}
          onRelayChange={onRelayChange}
          onBack={() => setScreen("home")}
        />
      )}
    </div>
  );
}
