import { useEffect, useState } from "react";
import { apiConnect, apiDisconnect, apiGetStatus, errMsg } from "../api.js";

export default function BoostScreen({ game, relay, onRelayChange, onBack }) {
  const [status, setStatus] = useState({ connected: false });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    let alive = true;
    const tick = async () => {
      try {
        const s = await apiGetStatus();
        if (alive) setStatus(s);
      } catch {
        /* ignore poll errors */
      }
    };
    tick();
    const id = setInterval(tick, 1500);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, []);

  async function onToggle() {
    setError("");
    setBusy(true);
    try {
      if (status.connected) {
        await apiDisconnect();
        setStatus({ connected: false });
      } else {
        if (!relay.endpoint?.trim()) throw new Error("Nhập endpoint relay.");
        if (!relay.psk) throw new Error("Nhập PSK.");
        const result = await apiConnect({
          psk: relay.psk,
          endpoint: relay.endpoint.trim(),
          profilePath: game.profilePath,
          gameId: game.id,
          routeWithoutGame: true,
        });
        setStatus({
          connected: true,
          innerIp: result.innerIp,
          handshakeRttMs: result.handshakeRttMs,
          packetsSent: 0,
          packetsReceived: 0,
        });
      }
    } catch (e) {
      setError(errMsg(e));
      try {
        setStatus(await apiGetStatus());
      } catch {
        /* ignore */
      }
    } finally {
      setBusy(false);
    }
  }

  const connected = !!status.connected;

  return (
    <section className="screen">
      <header className="brand row">
        <div>
          <h1>{game.nameVi}</h1>
          <p className="tag">{game.name}</p>
        </div>
        <button type="button" className="btn ghost sm" onClick={onBack} disabled={busy}>
          Menu
        </button>
      </header>

      <section className="status-card">
        <div className="status-row">
          <span className="label">Trạng thái</span>
          <span className={`value${connected ? " on" : " muted"}`}>
            {connected ? "Đã kết nối" : "Chưa kết nối"}
          </span>
        </div>
        <div className="status-row">
          <span className="label">Inner IP</span>
          <span className="value">{status.innerIp || "—"}</span>
        </div>
        <div className="status-row">
          <span className="label">Handshake RTT</span>
          <span className="value">
            {status.handshakeRttMs != null
              ? `${status.handshakeRttMs.toFixed(1)} ms`
              : "—"}
          </span>
        </div>
        <div className="status-row">
          <span className="label">Ping RTT</span>
          <span className="value">
            {status.lastRttMs != null ? `${status.lastRttMs.toFixed(1)} ms` : "—"}
          </span>
        </div>
        <div className="status-row">
          <span className="label">Packets</span>
          <span className="value">
            ↑{status.packetsSent || 0} ↓{status.packetsReceived || 0}
          </span>
        </div>
      </section>

      <button
        type="button"
        className={`btn primary toggle${connected ? " connected" : ""}`}
        onClick={onToggle}
        disabled={busy}
      >
        {busy ? "…" : connected ? "Ngắt kết nối" : "Kết nối"}
      </button>
      {error ? <p className="error">{error}</p> : null}

      <details className="config" open={!connected}>
        <summary>Relay (PSK)</summary>
        <label>
          Endpoint
          <input
            value={relay.endpoint}
            onChange={(e) => onRelayChange({ ...relay, endpoint: e.target.value })}
            placeholder="203.0.113.10:51820"
            autoComplete="off"
            disabled={connected || busy}
          />
        </label>
        <label>
          PSK
          <input
            type="password"
            value={relay.psk}
            onChange={(e) => onRelayChange({ ...relay, psk: e.target.value })}
            placeholder="≥ 16 ký tự"
            autoComplete="off"
            disabled={connected || busy}
          />
        </label>
      </details>
    </section>
  );
}
