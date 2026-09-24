import { useCallback, useEffect, useState } from "react";
import { apiListGames, errMsg } from "./api.js";
import LoginScreen from "./screens/LoginScreen.jsx";
import RegisterScreen from "./screens/RegisterScreen.jsx";
import HomeScreen from "./screens/HomeScreen.jsx";
import BoostScreen from "./screens/BoostScreen.jsx";

const SESSION_KEY = "gpb-session-v1";
const RELAY_KEY = "gpb-relay-v1";

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
        const list = await apiListGames();
        if (cancelled) return;
        setGames(list);
        const def = list.find((g) => g.isDefault) || list[0] || null;
        setSelectedGame((prev) => prev || def);
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
          relay={relay}
          onRelayChange={onRelayChange}
          onBack={() => setScreen("home")}
        />
      )}
    </div>
  );
}
