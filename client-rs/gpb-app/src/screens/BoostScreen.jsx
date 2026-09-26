import { useEffect, useState } from "react";
import { apiConnect, apiDisconnect, apiGetStatus, errMsg } from "../api.js";

const RELAY_SOURCE = {
  override: "relay thủ công",
  server: "relay máy chủ",
  build: "relay mặc định",
  none: "chưa có relay",
};

export default function BoostScreen({
  game,
  regionIds,
  onRegionsChange,
  relay,
  canEditRelay,
  relayOverride,
  onRelayOverrideChange,
  onBack,
}) {
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
        if (relay.source === "none") {
          throw new Error("Máy chủ chưa cấu hình relay. Liên hệ admin Goslynk.");
        }
        if (routedCount === 0) throw new Error("Chọn ít nhất một khu vực có dải IP.");
        const result = await apiConnect({
          psk: relay.psk,
          endpoint: relay.endpoint.trim(),
          gameId: game.id,
          regionIds,
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
  const regions = game.regions || [];
  const routedCount = regions
    .filter((r) => regionIds.includes(r.id))
    .reduce((n, r) => n + r.cidrCount, 0);

  function toggleRegion(id) {
    onRegionsChange(
      regionIds.includes(id) ? regionIds.filter((x) => x !== id) : [...regionIds, id],
    );
  }

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

      <section className="config regions">
        <p className="section-title">
          Khu vực server
          <span className="muted"> · {routedCount} dải IP</span>
        </p>
        {regions.map((r) => (
          <label key={r.id} className={`region${r.cidrCount === 0 ? " empty" : ""}`}>
            <input
              type="checkbox"
              checked={regionIds.includes(r.id)}
              onChange={() => toggleRegion(r.id)}
              disabled={connected || busy || r.cidrCount === 0}
            />
            <span className="region-text">
              <span className="region-name">
                {r.name}
                <span className="muted">
                  {r.cidrCount > 0 ? ` · ${r.cidrCount}` : " · chưa có IP"}
                </span>
              </span>
              {r.note ? <span className="region-note">{r.note}</span> : null}
            </span>
          </label>
        ))}
        {game.customProfile ? (
          <p className="hint">Đang dùng profile tùy chỉnh trong thư mục dữ liệu app.</p>
        ) : null}
      </section>

      <button
        type="button"
        className={`btn primary toggle${connected ? " connected" : ""}`}
        onClick={onToggle}
        disabled={busy || (!connected && routedCount === 0)}
      >
        {busy ? "…" : connected ? "Ngắt kết nối" : "Kết nối"}
      </button>
      {error ? <p className="error">{error}</p> : null}

      {canEditRelay ? (
        <details className="config">
          <summary>
            Relay thủ công (developer)
            <span className="muted"> · đang dùng {RELAY_SOURCE[relay.source]}</span>
          </summary>
          <p className="hint">Để trống để dùng relay do admin cấu hình trên máy chủ.</p>
          <label>
            Endpoint
            <input
              value={relayOverride.endpoint}
              onChange={(e) => onRelayOverrideChange({ ...relayOverride, endpoint: e.target.value })}
              placeholder={relay.endpoint || "203.0.113.10:51820"}
              autoComplete="off"
              disabled={connected || busy}
            />
          </label>
          <label>
            PSK
            <input
              type="password"
              value={relayOverride.psk}
              onChange={(e) => onRelayOverrideChange({ ...relayOverride, psk: e.target.value })}
              placeholder="≥ 16 ký tự"
              autoComplete="off"
              disabled={connected || busy}
            />
          </label>
        </details>
      ) : null}
    </section>
  );
}
