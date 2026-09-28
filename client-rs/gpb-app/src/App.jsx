import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  apiBoost,
  apiDefaultRelay,
  apiDisconnect,
  apiGetStatus,
  apiListGames,
  apiLogout,
  apiMe,
  apiUnboost,
  errMsg,
  isSessionRejected,
  setToken,
} from "./api.js";
import { defaultRegionIds } from "./games.js";
import AppHeader from "./components/AppHeader.jsx";
import UpdateBanner from "./components/UpdateBanner.jsx";
import LoginScreen from "./screens/LoginScreen.jsx";
import RegisterScreen from "./screens/RegisterScreen.jsx";
import HomeScreen from "./screens/HomeScreen.jsx";
import GamesScreen from "./screens/GamesScreen.jsx";
import AdminScreen from "./screens/AdminScreen.jsx";
import RedeemModal from "./components/RedeemModal.jsx";
import ProfileScreen from "./screens/ProfileScreen.jsx";

const SESSION_KEY = "gsb-session-v2";
// Held a hand-entered relay PSK in versions up to 0.1.4; cleared on start.
const OLD_RELAY_OVERRIDE_KEY = "gsb-relay-override-v1";
const REGIONS_KEY = "gpb-regions-v2";
const POLL_MS = 60_000;
const STATUS_POLL_MS = 1000;
const MAX_SLOTS = 3;
const NOTICE_MS = 4000;
const EMPTY_RELAY = { endpoint: "", psk: "" };
const IDLE_STATUS = { connected: false, games: [] };
const NO_BOOST = "Boost game chỉ dành cho tài khoản VIP. Nhập mã quà tặng để nhận VIP.";

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

const hasRelay = (r) => !!(r?.endpoint?.trim() && r?.psk);

function without(obj, key) {
  if (!(key in obj)) return obj;
  const next = { ...obj };
  delete next[key];
  return next;
}

export default function App() {
  const [screen, setScreen] = useState("boot"); // boot | login | register | home | games | profile | admin
  const [user, setUser] = useState(null);
  const [developerMode, setDeveloperMode] = useState(false);
  const [serverRelay, setServerRelay] = useState(EMPTY_RELAY);
  const [buildRelay, setBuildRelay] = useState(EMPTY_RELAY);
  const [games, setGames] = useState([]);
  const [regions, setRegions] = useState(() => loadJson(REGIONS_KEY, {}));
  const [notice, setNotice] = useState("");
  const [bootError, setBootError] = useState("");
  const [showRedeemModal, setShowRedeemModal] = useState(false);

  const [status, setStatus] = useState(IDLE_STATUS);
  // Game ids in the order they took a slot; refs mirror state so quick clicks see the latest.
  const [slots, setSlotsState] = useState([]);
  const [pending, setPendingState] = useState({}); // id -> "connecting" | "stopping"
  const [boostErrors, setBoostErrors] = useState({});
  const [gamesNotice, setGamesNotice] = useState("");
  const slotsRef = useRef([]);
  const pendingRef = useRef({});

  const setSlots = useCallback((next) => {
    slotsRef.current = next;
    setSlotsState(next);
  }, []);
  const setPending = useCallback((fn) => {
    pendingRef.current = fn(pendingRef.current);
    setPendingState(pendingRef.current);
  }, []);

  const applyAuth = useCallback((data) => {
    setUser(data.user);
    setDeveloperMode(!!data.developerMode);
    setServerRelay(data.relay || EMPTY_RELAY);
  }, []);

  const endSession = useCallback(
    (message = "") => {
      apiDisconnect().catch(() => {});
      setToken("");
      saveJson(SESSION_KEY, null);
      setUser(null);
      setServerRelay(EMPTY_RELAY);
      setStatus(IDLE_STATUS);
      setSlots([]);
      setBoostErrors({});
      setNotice(message);
      setScreen("login");
    },
    [setSlots],
  );

  useEffect(() => {
    saveJson(OLD_RELAY_OVERRIDE_KEY, null);
    let cancelled = false;
    (async () => {
      try {
        const [list, defaults] = await Promise.all([apiListGames(), apiDefaultRelay()]);
        if (cancelled) return;
        setGames(list);
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
        if (isSessionRejected(e)) endSession(e.status === 401 && e.code !== "signed_in_elsewhere" ? "" : e.message);
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

  const refreshStatus = useCallback(async () => {
    try {
      const s = await apiGetStatus();
      setStatus({ ...s, games: s.games || [] });
      // A tunnel that outlived a webview reload still owns its games.
      const missing = (s.games || []).filter((id) => !slotsRef.current.includes(id));
      if (missing.length) setSlots([...slotsRef.current, ...missing]);
    } catch {
      /* ignore poll errors */
    }
  }, [setSlots]);

  useEffect(() => {
    if (!user) return undefined;
    refreshStatus();
    const id = setInterval(refreshStatus, STATUS_POLL_MS);
    return () => clearInterval(id);
  }, [user, refreshStatus]);

  useEffect(() => {
    if (!gamesNotice) return undefined;
    const id = setTimeout(() => setGamesNotice(""), NOTICE_MS);
    return () => clearTimeout(id);
  }, [gamesNotice]);

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

  // The server decides who may boost and only hands those accounts the relay.
  const canBoost = !!user?.canBoost;
  const relay = useMemo(() => {
    if (hasRelay(serverRelay)) return { ...serverRelay, source: "server" };
    if (hasRelay(buildRelay)) return { ...buildRelay, source: "build" };
    return { ...EMPTY_RELAY, source: "none" };
  }, [serverRelay, buildRelay]);

  const regionIdsFor = (game) =>
    (regions[game.id] ?? defaultRegionIds(game)).filter((id) => game.regions.some((r) => r.id === id));

  const boosted = status.games || [];
  const slotState = (id) =>
    pending[id] || (boosted.includes(id) ? "on" : boostErrors[id] ? "error" : "off");
  const isActive = (id) => !!pendingRef.current[id] || boosted.includes(id);
  const activeCount = slots.filter(isActive).length;

  async function boostGame(game, regionIds = regionIdsFor(game)) {
    const id = game.id;
    if (pendingRef.current[id]) return;
    if (!canBoost) {
      setGamesNotice(NO_BOOST);
      return;
    }

    let next = slotsRef.current;
    if (!next.includes(id)) {
      // Stopped or failed slots make room; boosted ones never get bumped.
      while (next.length >= MAX_SLOTS) {
        const idle = next.find((x) => !isActive(x));
        if (!idle) {
          setGamesNotice(`Đã đủ ${MAX_SLOTS} game đang boost. Dừng một game ở Home trước.`);
          return;
        }
        next = next.filter((x) => x !== idle);
      }
      next = [...next, id];
    }
    setSlots(next);
    setBoostErrors((e) => without(e, id));

    if (relay.source === "none") {
      setBoostErrors((e) => ({ ...e, [id]: "Máy chủ chưa cấu hình relay. Liên hệ admin Goslynk." }));
      return;
    }
    setPending((p) => ({ ...p, [id]: "connecting" }));
    try {
      const ids = await apiBoost({
        psk: relay.psk,
        endpoint: relay.endpoint.trim(),
        gameId: id,
        regionIds,
      });
      setStatus((s) => ({ ...s, games: ids }));
    } catch (e) {
      setBoostErrors((er) => ({ ...er, [id]: errMsg(e) }));
    } finally {
      setPending((p) => without(p, id));
      refreshStatus();
    }
  }

  async function stopGame(game) {
    const id = game.id;
    if (pendingRef.current[id]) return;
    setPending((p) => ({ ...p, [id]: "stopping" }));
    try {
      const ids = await apiUnboost(id);
      setStatus((s) => (ids.length ? { ...s, games: ids } : IDLE_STATUS));
      setSlots(slotsRef.current.filter((x) => x !== id));
      setBoostErrors((e) => without(e, id));
    } catch (e) {
      setBoostErrors((er) => ({ ...er, [id]: errMsg(e) }));
    } finally {
      setPending((p) => without(p, id));
      refreshStatus();
    }
  }

  function removeSlot(game) {
    setSlots(slotsRef.current.filter((x) => x !== game.id));
    setBoostErrors((e) => without(e, game.id));
  }

  function onRegionsChange(game, ids) {
    setRegions((prev) => {
      const next = { ...prev, [game.id]: ids };
      saveJson(REGIONS_KEY, next);
      return next;
    });
    if (boosted.includes(game.id)) boostGame(game, ids);
  }

  function onPick(game) {
    if (slotState(game.id) === "on") setScreen("home");
    else boostGame(game);
  }

  const inShell = ["home", "games", "profile"].includes(screen) && user;

  return (
    <div className={`app${screen === "admin" ? " wide" : ""}${inShell ? " shell" : ""}`}>
      <UpdateBanner onBeforeInstall={() => apiDisconnect().catch(() => {})} />

      {inShell ? (
        <AppHeader
          user={user}
          tab={screen}
          onTab={setScreen}
          boostedCount={boosted.length}
          maxSlots={MAX_SLOTS}
          onProfile={() => setScreen("profile")}
          onRedeem={() => setShowRedeemModal(true)}
          onAdmin={user.role === "admin" ? () => setScreen("admin") : null}
          onLogout={onLogout}
        />
      ) : null}

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
          developerMode={developerMode}
          games={games}
          slots={slots}
          maxSlots={MAX_SLOTS}
          slotState={slotState}
          errors={boostErrors}
          status={status}
          regionIdsFor={regionIdsFor}
          onRegionsChange={onRegionsChange}
          onStop={stopGame}
          onRetry={(g) => boostGame(g)}
          onRemove={removeSlot}
          onPickGames={() => setScreen("games")}
          canBoost={canBoost}
          onRedeem={() => setShowRedeemModal(true)}
        />
      )}

      {screen === "games" && user && (
        <GamesScreen
          games={games}
          slotState={slotState}
          errors={boostErrors}
          full={activeCount >= MAX_SLOTS}
          notice={gamesNotice}
          onPick={onPick}
        />
      )}

      {screen === "profile" && user && (
        <ProfileScreen
          user={user}
          onUpdated={applyAuth}
          onSessionRejected={endSession}
          onRedeem={() => setShowRedeemModal(true)}
        />
      )}

      {showRedeemModal && user && <RedeemModal onClose={() => setShowRedeemModal(false)} onRedeemed={refreshMe} />}

      {screen === "admin" && user?.role === "admin" && (
        <AdminScreen me={user} onChanged={refreshMe} onSessionRejected={endSession} onBack={() => setScreen("home")} />
      )}
    </div>
  );
}
