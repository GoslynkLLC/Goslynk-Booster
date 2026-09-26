import { useCallback, useEffect, useRef, useState } from "react";
import { errMsg, isTauri } from "../api.js";

const CHECK_EVERY_MS = 30 * 60_000;

// The feed only carries the newest version; the updater itself compares it against this
// build's version and verifies the signature before installing.
export default function UpdateBanner({ onBeforeInstall }) {
  const [update, setUpdate] = useState(null);
  const [phase, setPhase] = useState("idle"); // idle | downloading | installing | error
  const [progress, setProgress] = useState(null);
  const [error, setError] = useState("");
  const [dismissed, setDismissed] = useState("");
  const busy = useRef(false);

  const check = useCallback(async () => {
    if (busy.current) return;
    try {
      const { check: checkUpdate } = await import("@tauri-apps/plugin-updater");
      const found = await checkUpdate();
      if (found && !busy.current) setUpdate(found);
    } catch {
      /* offline or feed unreachable: try again on the next round */
    }
  }, []);

  useEffect(() => {
    if (!isTauri()) return undefined;
    check();
    const id = setInterval(check, CHECK_EVERY_MS);
    return () => clearInterval(id);
  }, [check]);

  async function install() {
    if (!update || busy.current) return;
    busy.current = true;
    setError("");
    setPhase("downloading");
    try {
      await onBeforeInstall?.();
      let total = 0;
      let done = 0;
      await update.downloadAndInstall((event) => {
        if (event.event === "Started") total = event.data.contentLength || 0;
        else if (event.event === "Progress") {
          done += event.data.chunkLength;
          if (total) setProgress(Math.min(100, Math.round((done / total) * 100)));
        } else if (event.event === "Finished") setPhase("installing");
      });
      const { relaunch } = await import("@tauri-apps/plugin-process");
      await relaunch();
    } catch (e) {
      busy.current = false;
      setPhase("error");
      setError(errMsg(e));
    }
  }

  if (!update || dismissed === update.version) return null;

  const working = phase === "downloading" || phase === "installing";
  let text = `Có bản mới ${update.version} (đang dùng ${update.currentVersion}).`;
  if (phase === "downloading") text = `Đang tải bản ${update.version}${progress != null ? ` · ${progress}%` : "…"}`;
  if (phase === "installing") text = `Đang cài bản ${update.version}, app sẽ tự mở lại…`;

  return (
    <div className="update-banner" role="status">
      <div className="update-text">
        <strong>{text}</strong>
        {phase === "idle" ? <span className="muted"> Game đang boost sẽ tạm dừng khi cập nhật.</span> : null}
        {error ? <span className="error"> Cập nhật lỗi: {error}</span> : null}
        {phase === "downloading" && progress != null ? (
          <span className="update-progress">
            <span style={{ width: `${progress}%` }} />
          </span>
        ) : null}
      </div>
      {!working ? (
        <div className="update-actions">
          <button type="button" className="btn primary sm" onClick={install}>
            {phase === "error" ? "Thử lại" : "Cập nhật ngay"}
          </button>
          <button type="button" className="btn ghost sm" onClick={() => setDismissed(update.version)}>
            Để sau
          </button>
        </div>
      ) : null}
    </div>
  );
}
