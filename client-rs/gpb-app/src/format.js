export const ROLE_LABEL = { admin: "Admin", developer: "Developer", vip_plus: "VIP+", vip: "VIP", user: "Thành viên" };
export const REWARD_LABEL = { vip_days: "VIP", vip_plus_days: "VIP+" };

/** Unexpired VIP+ and VIP days as "VIP+ đến …" lines, VIP+ first. */
export function vipLines(user, format = shortDate) {
  return [
    user?.vipPlusUntil ? `VIP+ đến ${format(user.vipPlusUntil)}` : null,
    user?.vipUntil ? `VIP đến ${format(user.vipUntil)}` : null,
  ].filter(Boolean);
}

/** "2026-10-05 23:50:00" (server time) as "05/10/2026". */
export function shortDate(s) {
  const [y, m, d] = String(s ?? "").slice(0, 10).split("-");
  return d && m && y ? `${d}/${m}/${y}` : s || "—";
}

/** "2026-10-05 23:50:00" as "05/10/2026 23:50". */
export function shortDateTime(s) {
  return s ? `${shortDate(s)} ${String(s).slice(11, 16)}`.trim() : "—";
}
