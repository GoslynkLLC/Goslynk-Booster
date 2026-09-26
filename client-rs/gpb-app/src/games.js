import cs2 from "./assets/games/cs2.jpg";
import deltaforce from "./assets/games/deltaforce.jpg";
import lol from "./assets/games/lol.jpg";
import naraka from "./assets/games/naraka.jpg";
import pubg from "./assets/games/pubg.jpg";
import steam from "./assets/games/steam.jpg";
import tft from "./assets/games/tft.jpg";
import valorant from "./assets/games/valorant.jpg";
import wot from "./assets/games/wot.jpg";

// Cover art per game id. `focus` is the CSS object-position that keeps the subject in
// view once the landscape art is cropped to a portrait card.
export const GAME_ART = {
  pubg: { src: pubg, focus: "55% center" },
  cs2: { src: cs2, focus: "38% center" },
  valorant: { src: valorant, focus: "40% center" },
  tft: { src: tft, focus: "68% center" },
  lol: { src: lol, focus: "55% center" },
  deltaforce: { src: deltaforce, focus: "45% center" },
  wot: { src: wot, focus: "30% center" },
  naraka: { src: naraka, focus: "62% center" },
  steam: { src: steam, focus: "76% center" },
};

const IS_MAC = /Mac/i.test(navigator.platform || navigator.userAgent);

// The process name that matters on this OS: the Windows `.exe` or the macOS binary.
export function processLabel(names = []) {
  const native = names.find((n) => n.toLowerCase().endsWith(".exe") !== IS_MAC);
  return native || names[0] || "";
}

// "máy chủ Singapore và Hong Kong" from the regions that actually route something.
export function serverLabel(regions = []) {
  const live = regions.filter((r) => r.cidrCount > 0).map((r) => r.name);
  return live.length ? `máy chủ ${live.join(" và ")}` : "";
}

export const isLive = (game) => (game.regions || []).some((r) => r.cidrCount > 0);

export function detailLabel(game) {
  return [processLabel(game.processNames), serverLabel(game.regions)].filter(Boolean).join(" · ");
}

// Accent-insensitive, so "lien minh" finds "Liên Minh Huyền Thoại".
const fold = (s) =>
  (s || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/đ/gi, "d")
    .toLowerCase();

export function matchesQuery(game, query) {
  const q = fold(query).trim();
  if (!q) return true;
  return [game.name, game.nameVi, game.id, ...(game.processNames || [])].some((s) => fold(s).includes(q));
}

/** Regions the profile marks as helped by its relays; the rest stay off until ticked. */
export function defaultRegionIds(game) {
  return (game?.regions || []).filter((r) => r.cidrCount > 0 && r.defaultOn).map((r) => r.id);
}
