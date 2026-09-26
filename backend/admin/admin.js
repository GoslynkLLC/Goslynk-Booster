(() => {
  const API = new URL("../api/", location.href).href;
  const TOKEN_KEY = "gsb-admin-token";
  const $ = (id) => document.getElementById(id);

  let token = sessionStorage.getItem(TOKEN_KEY) || "";
  let me = null;
  let page = 1;

  async function api(path, { method = "GET", body } = {}) {
    const res = await fetch(API + path, {
      method,
      headers: {
        "Content-Type": "application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    let data;
    try {
      data = await res.json();
    } catch {
      throw new Error(`Máy chủ trả về lỗi ${res.status}.`);
    }
    if (!data.ok) {
      const err = new Error(data.error || `Lỗi ${res.status}`);
      err.status = res.status;
      err.code = data.code;
      throw err;
    }
    return data;
  }

  function esc(s) {
    return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  }

  function flash(el, text, ok = true) {
    el.textContent = text;
    el.className = `status ${ok ? "ok" : "err"}`;
    if (ok) setTimeout(() => { if (el.textContent === text) el.textContent = ""; }, 3000);
  }

  function showLogin(message = "") {
    token = "";
    sessionStorage.removeItem(TOKEN_KEY);
    $("app-view").hidden = true;
    $("login-view").hidden = false;
    $("login-error").textContent = message;
  }

  function onAuthError(e) {
    if (e.status === 401 || e.code === "forbidden" || e.code === "locked") {
      showLogin(e.message);
      return true;
    }
    return false;
  }

  // ------------------------------------------------------------ login

  $("login-form").addEventListener("submit", async (ev) => {
    ev.preventDefault();
    const f = ev.target;
    const btn = f.querySelector("button");
    btn.disabled = true;
    $("login-error").textContent = "";
    try {
      const data = await api("auth/login", {
        method: "POST",
        body: { login: f.login.value, password: f.password.value, device: "admin-panel" },
      });
      if (data.user.role !== "admin") {
        token = data.token;
        await api("auth/logout", { method: "POST" }).catch(() => {});
        showLogin("Tài khoản này không phải admin.");
        return;
      }
      token = data.token;
      sessionStorage.setItem(TOKEN_KEY, token);
      f.password.value = "";
      await boot(data.user);
    } catch (e) {
      $("login-error").textContent = e.message;
    } finally {
      btn.disabled = false;
    }
  });

  $("logout").addEventListener("click", async () => {
    await api("auth/logout", { method: "POST" }).catch(() => {});
    showLogin();
  });

  // ------------------------------------------------------------ settings

  function renderSettings(s) {
    $("dev-toggle").checked = s.developerMode;
    $("dev-message").value = s.developerMessage;
    $("reg-toggle").checked = s.registrationOpen;
    $("relay-endpoint").value = s.relayEndpoint;
    $("relay-psk").value = s.relayPsk;
    $("devmode-card").classList.toggle("on", s.developerMode);
    $("devmode-status").textContent = s.developerMode
      ? "Đang BẬT - chỉ admin và developer vào được app."
      : "Đang tắt - mọi tài khoản đều vào được app.";
    $("devmode-status").className = "status";
  }

  async function saveSettings(patch, statusEl) {
    try {
      const { settings } = await api("admin/settings", { method: "POST", body: patch });
      renderSettings(settings);
      flash(statusEl, "Đã lưu.");
      loadAudit();
    } catch (e) {
      if (!onAuthError(e)) flash(statusEl, e.message, false);
    }
  }

  $("dev-toggle").addEventListener("change", (ev) => {
    const on = ev.target.checked;
    if (on && !confirm("Bật chế độ developer? User và VIP sẽ bị chặn khỏi app ngay.")) {
      ev.target.checked = false;
      return;
    }
    saveSettings({ developerMode: on, developerMessage: $("dev-message").value }, $("devmode-status"));
  });

  $("save-general").addEventListener("click", () =>
    saveSettings(
      { developerMessage: $("dev-message").value, registrationOpen: $("reg-toggle").checked },
      $("devmode-status"),
    ),
  );

  $("save-relay").addEventListener("click", () =>
    saveSettings({ relayEndpoint: $("relay-endpoint").value, relayPsk: $("relay-psk").value }, $("relay-status")),
  );

  $("psk-show").addEventListener("click", () => {
    const i = $("relay-psk");
    i.type = i.type === "password" ? "text" : "password";
    $("psk-show").textContent = i.type === "password" ? "Hiện" : "Ẩn";
  });

  // ------------------------------------------------------------ users

  async function loadUsers() {
    const q = encodeURIComponent($("user-q").value.trim());
    const role = encodeURIComponent($("user-role").value);
    try {
      const d = await api(`admin/users?q=${q}&role=${role}&page=${page}`);
      const c = d.roleCounts;
      $("role-counts").textContent = `· admin ${c.admin} · developer ${c.developer} · vip ${c.vip} · user ${c.user}`;
      $("user-total").textContent = `${d.total} tài khoản`;
      $("page-no").textContent = String(d.page);
      $("prev-page").disabled = d.page <= 1;
      $("next-page").disabled = d.page * d.perPage >= d.total;
      $("user-rows").innerHTML = d.users.map(userRow).join("") || `<tr><td colspan="6" class="muted">Không có tài khoản.</td></tr>`;
    } catch (e) {
      onAuthError(e);
    }
  }

  function userRow(u) {
    const self = me && u.id === me.id;
    const roles = ["user", "vip", "developer", "admin"]
      .map((r) => `<option value="${r}"${r === u.role ? " selected" : ""}>${r}</option>`)
      .join("");
    return `<tr data-id="${u.id}">
      <td>${u.id}</td>
      <td>${esc(u.displayName)}<span class="sub">${esc(u.username)} · ${esc(u.email)}</span></td>
      <td><select data-act="role"${self ? " disabled" : ""}>${roles}</select></td>
      <td>${u.isLocked ? `<span class="badge locked" title="${esc(u.lockReason)}">Đã khóa</span>` : `<span class="badge active">Hoạt động</span>`}</td>
      <td>${esc(u.lastLoginAt || "—")}<span class="sub">${esc(u.lastLoginIp || "")}</span></td>
      <td class="row">
        ${self ? "" : u.isLocked
          ? `<button class="btn ghost sm" data-act="unlock">Mở khóa</button>`
          : `<button class="btn danger sm" data-act="lock">Khóa</button>`}
        <button class="btn ghost sm" data-act="revoke" title="Buộc đăng xuất mọi thiết bị">Đăng xuất</button>
      </td>
    </tr>`;
  }

  async function updateUser(id, patch) {
    try {
      await api("admin/users", { method: "POST", body: { id, ...patch } });
      await loadUsers();
      loadAudit();
    } catch (e) {
      if (!onAuthError(e)) alert(e.message);
      loadUsers();
    }
  }

  $("user-rows").addEventListener("change", (ev) => {
    if (ev.target.dataset.act !== "role") return;
    const id = Number(ev.target.closest("tr").dataset.id);
    updateUser(id, { role: ev.target.value });
  });

  $("user-rows").addEventListener("click", (ev) => {
    const act = ev.target.dataset?.act;
    if (!act || act === "role") return;
    const id = Number(ev.target.closest("tr").dataset.id);
    if (act === "lock") {
      const reason = prompt("Lý do khóa (người dùng sẽ thấy):", "");
      if (reason === null) return;
      updateUser(id, { isLocked: true, lockReason: reason });
    } else if (act === "unlock") {
      updateUser(id, { isLocked: false });
    } else if (act === "revoke") {
      if (confirm("Đăng xuất tài khoản này khỏi mọi thiết bị?")) updateUser(id, { revokeSessions: true });
    }
  });

  let searchTimer;
  $("user-q").addEventListener("input", () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => { page = 1; loadUsers(); }, 300);
  });
  $("user-role").addEventListener("change", () => { page = 1; loadUsers(); });
  $("prev-page").addEventListener("click", () => { page = Math.max(1, page - 1); loadUsers(); });
  $("next-page").addEventListener("click", () => { page += 1; loadUsers(); });

  // ------------------------------------------------------------ audit

  async function loadAudit() {
    try {
      const { entries } = await api("admin/audit");
      $("audit-rows").innerHTML = entries.map((a) => `<tr>
        <td>${esc(a.createdAt)}</td><td>${esc(a.actor || "—")}</td><td>${esc(a.action)}</td>
        <td>${esc(a.target)}</td><td>${esc(a.detail)}</td><td>${esc(a.ip)}</td></tr>`).join("")
        || `<tr><td colspan="6" class="muted">Chưa có thao tác nào.</td></tr>`;
    } catch (e) {
      onAuthError(e);
    }
  }
  $("reload-audit").addEventListener("click", loadAudit);

  // ------------------------------------------------------------ boot

  async function boot(user) {
    me = user;
    $("whoami").textContent = `${user.displayName} (${user.role})`;
    $("login-view").hidden = true;
    $("app-view").hidden = false;
    try {
      const { settings } = await api("admin/settings");
      renderSettings(settings);
    } catch (e) {
      if (onAuthError(e)) return;
    }
    loadUsers();
    loadAudit();
  }

  (async () => {
    if (!token) return showLogin();
    try {
      const d = await api("auth/me");
      if (d.user.role !== "admin") return showLogin("Tài khoản này không phải admin.");
      await boot(d.user);
    } catch (e) {
      showLogin(e.status === 401 ? "" : e.message);
    }
  })();
})();
