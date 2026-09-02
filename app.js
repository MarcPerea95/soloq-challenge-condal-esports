/* ============================================================
   SoloQ Challenge 2026 — app.js
   Fetches the published Google Sheets CSV, computes every trophy
   and the leaderboard, and renders the page. Refreshes on load
   and every REFRESH_INTERVAL_MS afterwards, so the page behaves
   like a "live" dashboard for anyone who has it open.
   ============================================================ */

const CSV_URL = "https://docs.google.com/spreadsheets/d/e/2PACX-1vRn56mRGDa04SRzR-XDTgpGILmuFLq7cmXCHhRHHa0x-t0r7MUOmWDClIshT7eQoIse6aeLMZG57bwo/pub?gid=596174264&single=true&output=csv";
const REFRESH_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
const TOURNAMENT_END = new Date("2026-08-26T00:00:00+02:00"); // CEST
const MIN_GAME_MINUTES = 3; // filters out remakes/aborted games from every stat

/* ------------------------------------------------------------
   1) EDIT THIS SECTION YOURSELVES — hardcoded SoloQ rank data
   ------------------------------------------------------------
   The CSV has no rank column, so each player's current rank has
   to be entered here by hand and kept up to date manually.
   tier   : one of TIER_ORDER below, ALL CAPS
   division: 4,3,2,1 for tiers IRON..DIAMOND (IV..I). Use null for
             UNRANKED, MASTER, GRANDMASTER and CHALLENGER (no divisions).
   lp     : league points, used as the tiebreaker within a tier/division
   tag    : Riot ID tag shown next to the summoner name (without '#')
------------------------------------------------------------- */
const PLAYER_CONFIG = {
  "Dügün":  { summoner: "Dugunsito",         tag: "LGA", tier: "PLATINUM", division: 4, lp: 94 },
  "Laion":  { summoner: "BarbAhridaddy",     tag: "Spain", tier: "PLATINUM",   division: 2, lp: 25 },
  "Juanjo": { summoner: "JuanchoCasalobas",  tag: "BRO", tier: "GOLD",   division: 2, lp: 38 },
  "Laia":   { summoner: "JustRakan",         tag: "koala", tier: "BRONZE", division: 2, lp: 18 },
  "Marc":   { summoner: "FableD0t",          tag: "EUW", tier: "GOLD",   division: 3, lp: 4 },
  "Sito":   { summoner: "Domado por rito",     tag: "doggy", tier: "GOLD", division: 3, lp: 81 },
  "Iker":   { summoner: "Makinoide",         tag: "SPAIN", tier: "SILVER", division: 3, lp: 49 },
};

const TIER_ORDER = ["UNRANKED","IRON","BRONZE","SILVER","GOLD","PLATINUM","EMERALD","DIAMOND","MASTER","GRANDMASTER","CHALLENGER"];
const TIER_COLORS = {
  UNRANKED:"#5C6B82", IRON:"#5B5A57", BRONZE:"#8C5A3C", SILVER:"#9FB0C2",
  GOLD:"#C9A24B", PLATINUM:"#3FB8A3", EMERALD:"#22B571", DIAMOND:"#4FA6E0",
  MASTER:"#B968E0", GRANDMASTER:"#E15C56", CHALLENGER:"#7FE9E0"
};
const ROMAN = { 1:"I", 2:"II", 3:"III", 4:"IV" };
const NO_DIVISION_TIERS = new Set(["UNRANKED","MASTER","GRANDMASTER","CHALLENGER"]);

/* ------------------------------------------------------------
   Champion portraits via Data Dragon (Riot's public static CDN).
   The "Champ name" column already comes in Data Dragon key format
   (e.g. "MasterYi", "DrMundo"), so it's used directly as the key.
------------------------------------------------------------- */
let DDRAGON_VERSION = "14.19.1"; // fallback if the version fetch fails
async function loadDDragonVersion(){
  try{
    const res = await fetch("https://ddragon.leagueoflegends.com/api/versions.json");
    const versions = await res.json();
    if (Array.isArray(versions) && versions.length) DDRAGON_VERSION = versions[0];
  } catch (e){
    console.warn("[SoloQ] No se pudo obtener la versión de Data Dragon, usando fallback.", e);
  }
}

/* Campeones cuya "id" de Data Dragon (el nombre de archivo de la imagen)
   no sale de simplemente quitar espacios/puntuación al nombre tal cual se
   escribe a mano en la hoja de cálculo. La clave del mapa es el nombre en
   minúsculas sin ningún carácter que no sea a-z, así que da igual si en el
   CSV se escribió "Kai'Sa", "Kaisa" o "kai sa": las tres caen en la misma
   entrada. */
const CHAMPION_KEY_OVERRIDES = {
  wukong: "MonkeyKing", monkeyking: "MonkeyKing",
  leblanc: "Leblanc",
  reksai: "RekSai",
  kaisa: "Kaisa",
  khazix: "Khazix",
  chogath: "Chogath",
  velkoz: "Velkoz",
  kogmaw: "KogMaw",
  belveth: "Belveth",
  ksante: "KSante",
  drmundo: "DrMundo",
  missfortune: "MissFortune",
  masteryi: "MasterYi",
  tahmkench: "TahmKench",
  twistedfate: "TwistedFate",
  xinzhao: "XinZhao",
  aurelionsol: "AurelionSol",
  leesin: "LeeSin",
  jarvaniv: "JarvanIV",
  nunu: "Nunu", nunuwillump: "Nunu",
  renata: "Renata", renataglasc: "Renata",
  fiddlesticks: "Fiddlesticks",
};

// Convierte el nombre de campeón tal cual viene del CSV en la "id" exacta
// que usa Data Dragon para el fichero de imagen (mira primero en la tabla
// de excepciones de arriba y, si no está, hace el intento genérico de
// quitar espacios/puntuación y poner cada palabra con mayúscula inicial).
function normalizeChampionKey(rawName){
  const clean = String(rawName || "").trim();
  if (!clean) return clean;
  const lookupKey = clean.toLowerCase().replace(/[^a-z]/g, "");
  if (CHAMPION_KEY_OVERRIDES[lookupKey]) return CHAMPION_KEY_OVERRIDES[lookupKey];
  return clean
    .split(/[\s.'’&-]+/)
    .filter(Boolean)
    .map(w => w.charAt(0).toUpperCase() + w.slice(1))
    .join("");
}

// Evita que un nombre con comillas o "&" rompa los atributos HTML (alt, title, etc.)
function escapeHtml(str){
  return String(str ?? "")
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function champImgUrl(champKey){
  return `https://ddragon.leagueoflegends.com/cdn/${DDRAGON_VERSION}/img/champion/${normalizeChampionKey(champKey)}.png`;
}

// Icono de repuesto (SVG en línea, sin depender de red) para cuando ni con
// la normalización se encuentra la imagen — evita el icono roto del navegador
// y avisa por consola con el nombre exacto que ha fallado, para depurarlo.
const CHAMP_FALLBACK_IMG = "data:image/svg+xml;utf8," + encodeURIComponent(
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="8" fill="#1b2432"/><text x="32" y="40" font-size="28" text-anchor="middle" fill="#5C6B82" font-family="sans-serif">?</text></svg>`
);
// OJO: esta función se llama desde el atributo onerror="" del HTML como
// champImgFallback(this) — sin pasarle el nombre del campeón como texto,
// para no tener que meter comillas dinámicas dentro de un atributo HTML
// (eso es justo lo que rompía el fallback antes: JSON.stringify pone
// comillas dobles, y el atributo onerror="..." también usa comillas
// dobles, así que el navegador cortaba el atributo a mitad de frase y
// el JS quedaba inválido — por eso nunca saltaba ni el aviso en consola
// ni la imagen de repuesto). Leemos el nombre desde imgEl.alt en su lugar.
function champImgFallback(imgEl){
  imgEl.onerror = null;
  console.warn("[SoloQ] No se encontró la imagen del campeón:", imgEl.alt);
  imgEl.src = CHAMP_FALLBACK_IMG;
}
function formatDuration(minutesDecimal){
  const totalSeconds = Math.round(minutesDecimal * 60);
  const m = Math.floor(totalSeconds / 60);
  const s = totalSeconds % 60;
  return `${m}:${String(s).padStart(2,"0")}`;
}

/* ------------------------------------------------------------
   2) CSV parsing (handles quoted fields, e.g. the "Time" column)
------------------------------------------------------------- */
function parseCSV(text){
  const rows = [];
  let row = [], field = "", inQuotes = false;
  for (let i = 0; i < text.length; i++){
    const c = text[i];
    if (inQuotes){
      if (c === '"'){
        if (text[i+1] === '"'){ field += '"'; i++; }
        else inQuotes = false;
      } else field += c;
    } else {
      if (c === '"') inQuotes = true;
      else if (c === ','){ row.push(field); field = ""; }
      else if (c === '\n' || c === '\r'){
        if (c === '\r' && text[i+1] === '\n') i++;
        row.push(field); field = "";
        if (!(row.length === 1 && row[0] === "")) rows.push(row);
        row = [];
      } else field += c;
    }
  }
  if (field.length || row.length){ row.push(field); if (!(row.length===1 && row[0]==="")) rows.push(row); }
  return rows;
}

function rowsToObjects(rows){
  const headers = rows[0].map(h => h.trim());
  return rows.slice(1).filter(r => r.length > 1).map(r => {
    const obj = {};
    headers.forEach((h, i) => obj[h] = (r[i] ?? "").trim());
    return obj;
  });
}

function num(v){ const n = parseFloat(String(v).replace(",", ".")); return isNaN(n) ? 0 : n; }
function bool(v){ return String(v).trim().toUpperCase() === "TRUE"; }

// "29,02" (mm,ss) -> minutes as a decimal
function timeToMinutes(v){
  const parts = String(v).split(",");
  if (parts.length < 2) return num(v);
  const mins = parseInt(parts[0], 10) || 0;
  const secs = parseInt(parts[1], 10) || 0;
  return mins + secs / 60;
}

// Ordena cronológicamente las partidas de un jugador para calcular rachas
function parseDateValue(v){
  const [d, m, y] = String(v).split("/").map(Number);
  return new Date(y || 0, (m || 1) - 1, d || 1);
}
function matchIdNum(id){
  const match = String(id).match(/(\d+)\s*$/);
  return match ? parseInt(match[1], 10) : 0;
}
function computeLongestStreak(log){
  const sorted = [...log].sort((a, b) => {
    const diff = parseDateValue(a.date) - parseDateValue(b.date);
    return diff !== 0 ? diff : matchIdNum(a.matchId) - matchIdNum(b.matchId);
  });
  let longest = 0, current = 0;
  sorted.forEach(g => {
    current = g.win ? current + 1 : 0;
    if (current > longest) longest = current;
  });
  return longest;
}

/* ------------------------------------------------------------
   3) Aggregate raw rows into one stat block per player
------------------------------------------------------------- */
function buildPlayerStats(rows){
  const byPlayer = {};

  rows.forEach(r => {
    const minutes = timeToMinutes(r["Time"]);
    if (!minutes || minutes < MIN_GAME_MINUTES) return; // drop remakes

    const name = r["Player"];
    if (!name) return;

    if (!byPlayer[name]) byPlayer[name] = {
      name, games:0, wins:0, kills:0, deaths:0, assists:0,
      totalDmg:0, minutes:0, visionScore:0, champCounts:{},
      goldEarned:0, dragons:0, barons:0, towers:0, inhibitors:0,
      pentakills:0, totalCS:0, resultLog:[],
    };

    const p = byPlayer[name];
    p.games += 1;
    if (bool(r["Result"])) p.wins += 1;
    p.resultLog.push({ date: r["Date"], matchId: r["MatchID"], win: bool(r["Result"]) });
    p.kills += num(r["Asesinatos"]);
    p.deaths += num(r["Muertes"]);
    p.assists += num(r["Asistencias"]);
    p.totalDmg += num(r["Total Dmg"]);
    p.minutes += minutes;
    p.visionScore += num(r["Punt. visión"]);
    p.goldEarned += num(r["Gold earned"]);
    p.dragons += num(r["Dragones"]);
    p.barons += num(r["Barones"]);
    p.towers += num(r["Torres"]);
    p.inhibitors += num(r["Inhibidores"]);
    p.pentakills += num(r["Pentakills"]);
    p.totalCS += num(r["Total CS"]);

    const champ = r["Champ name"] || r["Champ"];
    if (champ){
      p.champCounts[champ] = (p.champCounts[champ] || 0) + 1;
      p.lastChamp = champ; // used as a portrait fallback
    }
  });

  return Object.values(byPlayer).map(p => {
    const sortedChamps = Object.entries(p.champCounts).sort((a,b)=>b[1]-a[1]);
    const topChamp = sortedChamps[0];
    const top3Champs = sortedChamps.slice(0,3).map(([name,count]) => ({ name, count }));
    return {
      ...p,
      top3Champs,
      longestWinStreak: computeLongestStreak(p.resultLog),
      winRate: p.games ? p.wins / p.games : 0,
      kda: p.deaths > 0 ? (p.kills + p.assists) / p.deaths : (p.kills + p.assists),
      kdaPerfect: p.deaths === 0,
      killsPerGame: p.games ? p.kills / p.games : 0,
      deathsPerGame: p.games ? p.deaths / p.games : 0,
      dmgPerMin: p.minutes ? p.totalDmg / p.minutes : 0,
      goldPerMin: p.minutes ? p.goldEarned / p.minutes : 0,
      csPerMin: p.minutes ? p.totalCS / p.minutes : 0,
      uniqueChamps: Object.keys(p.champCounts).length,
      topChampName: topChamp ? topChamp[0] : "—",
      topChampGames: topChamp ? topChamp[1] : 0,
      objectives: p.dragons + p.barons,
      structures: p.towers + p.inhibitors,
    };
  });
}

/* ------------------------------------------------------------
   3b) Tournament-wide stats (not per player) for the stats cards
------------------------------------------------------------- */
const MIN_CHAMP_GAMES = 5; // avoids a single lucky/unlucky pick deciding "best/worst champion"

function buildTournamentStats(rows){
  let totalGames = 0, totalWins = 0;
  const champAgg = {};
  let longest = null, shortest = null;

  rows.forEach(r => {
    const minutes = timeToMinutes(r["Time"]);
    if (!minutes || minutes < MIN_GAME_MINUTES) return;

    totalGames += 1;
    const win = bool(r["Result"]);
    if (win) totalWins += 1;

    const champ = r["Champ name"] || r["Champ"];
    if (champ){
      if (!champAgg[champ]) champAgg[champ] = { name: champ, games: 0, wins: 0 };
      champAgg[champ].games += 1;
      if (win) champAgg[champ].wins += 1;
    }

    const entry = { minutes, player: r["Player"], champ };
    if (!longest || minutes > longest.minutes) longest = entry;
    if (!shortest || minutes < shortest.minutes) shortest = entry;
  });

  const champList = Object.values(champAgg).map(c => ({ ...c, wr: c.games ? c.wins / c.games : 0 }));
  const mostPlayed = champList.length ? champList.reduce((a,b) => (b.games > a.games ? b : a)) : null;

  const eligible = champList.filter(c => c.games >= MIN_CHAMP_GAMES);
  const bestWR = eligible.length ? eligible.reduce((a,b) => (b.wr > a.wr ? b : a)) : null;
  const worstWR = eligible.length ? eligible.reduce((a,b) => (b.wr < a.wr ? b : a)) : null;

  return {
    totalGames, totalWins, totalLosses: totalGames - totalWins,
    winRate: totalGames ? totalWins / totalGames : 0,
    mostPlayed, bestWR, worstWR, longest, shortest,
  };
}

/* ------------------------------------------------------------
   4) Rank sorting (real SoloQ tier/division/LP from PLAYER_CONFIG)
------------------------------------------------------------- */
function rankScore(cfg){
  const tierIdx = TIER_ORDER.indexOf(cfg.tier);
  const divScore = NO_DIVISION_TIERS.has(cfg.tier) ? 0 : (5 - (cfg.division || 4)); // I=4 III... higher is better
  return tierIdx * 1000 + divScore * 100 + Math.min(cfg.lp || 0, 99);
}

function rankLabel(cfg){
  if (NO_DIVISION_TIERS.has(cfg.tier)) return `${titleCase(cfg.tier)} · ${cfg.lp || 0} LP`;
  return `${titleCase(cfg.tier)} ${ROMAN[cfg.division] || "IV"} · ${cfg.lp || 0} LP`;
}
function titleCase(s){ return s.charAt(0) + s.slice(1).toLowerCase(); }

/* ------------------------------------------------------------
   5) SVG icon set (self-contained, no external deps)
------------------------------------------------------------- */
const ICONS = {
  crown: `<path d="M4 19h16M5 19l-2-9 6 4 3-7 3 7 6-4-2 9" stroke-width="1.8" fill="none" stroke-linejoin="round"/>`,
  chart: `<path d="M4 20V10M11 20V4M18 20v-7" stroke-width="1.8" fill="none" stroke-linecap="round"/>`,
  hourglass: `<path d="M6 3h12M6 21h12M7 3c0 5 5 6 5 9s-5 4-5 9M17 3c0 5-5 6-5 9s5 4 5 9" stroke-width="1.6" fill="none" stroke-linejoin="round"/>`,
  ratio: `<circle cx="9" cy="9" r="3" stroke-width="1.7" fill="none"/><circle cx="16" cy="16" r="4" stroke-width="1.7" fill="none"/>`,
  sword: `<path d="M4 20l8-8M12 12l7-7 2 2-7 7M16 8l3 3M9 15l2 2-3 3H5v-3z" stroke-width="1.6" fill="none" stroke-linejoin="round"/>`,
  flame: `<path d="M12 3c1 3-2 4-2 7a4 4 0 108 0c0-2-1-2-1-4 2 1 3 4 3 6a8 8 0 11-16 0c0-4 3-6 8-9z" stroke-width="1.5" fill="none" stroke-linejoin="round"/>`,
  shield: `<path d="M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z" stroke-width="1.6" fill="none" stroke-linejoin="round"/>`,
  skull: `<path d="M12 3a7 7 0 00-7 7c0 3 1.5 4.5 2 6h10c.5-1.5 2-3 2-6a7 7 0 00-7-7z" stroke-width="1.5" fill="none"/><circle cx="9.5" cy="10" r="1.1"/><circle cx="14.5" cy="10" r="1.1"/><path d="M10 19v2M14 19v2" stroke-width="1.5"/>`,
  eye: `<path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7-10-7-10-7z" stroke-width="1.6" fill="none" stroke-linejoin="round"/><circle cx="12" cy="12" r="3" stroke-width="1.6" fill="none"/>`,
  mask: `<path d="M4 8c2-2 5-3 8-3s6 1 8 3c0 6-3 10-8 10S4 14 4 8z" stroke-width="1.5" fill="none" stroke-linejoin="round"/><circle cx="9" cy="10" r="1"/><circle cx="15" cy="10" r="1"/>`,
  book: `<path d="M4 5h7a3 3 0 013 3v11a3 3 0 00-3-3H4zM20 5h-7a3 3 0 00-3 3v11a3 3 0 013-3h7z" stroke-width="1.5" fill="none" stroke-linejoin="round"/>`,
  coin: `<circle cx="12" cy="12" r="8" stroke-width="1.6" fill="none"/><path d="M12 8v8M9.5 10a2.5 2 0 012.5-1.5c1.5 0 2.5.7 2.5 1.7 0 2.3-5 1.3-5 3.6 0 1 1 1.7 2.5 1.7a2.5 2 0 002.5-1.5" stroke-width="1.3" fill="none"/>`,
  claw: `<path d="M5 21c3-6 2-11-1-15M11 21c2-7 1-12-2-16M17 21c1-8 0-13-3-17M20 8l2-3M20 8l3 1M20 8l1 3" stroke-width="1.5" fill="none" stroke-linecap="round"/>`,
  tower: `<path d="M7 21V9l5-5 5 5v12M9 21v-6h6v6M4 9h16" stroke-width="1.5" fill="none" stroke-linejoin="round"/>`,
  burst: `<path d="M12 2l1.8 6.2L20 6l-3.6 5L20 16l-6.2-1.8L12 22l-1.8-6.2L4 18l3.6-5L4 6l6.2 1.8z" stroke-width="1.3" fill="none" stroke-linejoin="round"/>`,
  wheat: `<path d="M12 22V9M12 9c-2 0-3-1.5-3-3.5S12 2 12 2s3 1 3 3.5S14 9 12 9zM9 13c-2-.5-3-2-3-2s1.5-1.5 3.5-1 2.5 2.5 2.5 2.5M15 13c2-.5 3-2 3-2s-1.5-1.5-3.5-1-2.5 2.5-2.5 2.5" stroke-width="1.4" fill="none" stroke-linejoin="round"/>`,
  bolt: `<path d="M13 2L4 14h6l-1 8 9-12h-6l1-8z" stroke-width="1.4" fill="none" stroke-linejoin="round"/>`,
  trophy: `<path d="M8 4h8v4a4 4 0 01-8 0V4zM6 5H4v2a3 3 0 003 3M18 5h2v2a3 3 0 01-3 3M10 15h4v3h-4zM8 21h8" stroke-width="1.5" fill="none" stroke-linejoin="round"/>`,
};
function icon(name){ return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round">${ICONS[name] || ICONS.trophy}</svg>`; }

/* ------------------------------------------------------------
   6) Trophy definitions: id, label, description, category (=color),
      icon, and a compute(stats[]) function returning {value, winners:[{name, display}]}
------------------------------------------------------------- */
const CATS = { combat:"var(--red)", macro:"var(--gold)", vision:"var(--teal)", meme:"var(--purple)" };
const CAT_LABELS = { combat:"Combate", macro:"Macro", vision:"Visión", meme:"Leyenda" };

function topBy(stats, keyFn, opts = {}){
  const min = opts.minGames || 0;
  const eligible = stats.filter(p => p.games >= min);
  if (!eligible.length) return { value: null, winners: [] };
  const sorted = [...eligible].sort((a, b) => opts.lowest ? (keyFn(a) - keyFn(b)) : (keyFn(b) - keyFn(a)));
  const best = keyFn(sorted[0]);
  const winners = sorted.filter(p => Math.abs(keyFn(p) - best) < 1e-9);
  return { value: best, winners };
}

const TROPHIES = [
  { id:"grinder", name:"El grinder", desc:"Más partidas jugadas en el torneo", icon:"hourglass", cat:"macro",
    compute: s => { const r = topBy(s, p=>p.games); return { ...r, fmt: v => `${v} partidas` }; } },

  { id:"built-different", name:"Built different", desc:"Mayor ratio de victorias sobre partidas jugadas", icon:"shield", cat:"macro",
    compute: s => { const r = topBy(s, p=>p.winRate, {minGames:3}); return { ...r, fmt: v => `${(v*100).toFixed(0)}% WR` }; } },

  { id:"kda", name:"KDA player", desc:"(Asesinatos + Asistencias) / Muertes", icon:"ratio", cat:"combat",
    compute: s => { const r = topBy(s, p=>p.kda, {minGames:3}); return { ...r, fmt: (v,p) => p && p[0] && p[0].kdaPerfect ? "Perfecto" : `${v.toFixed(2)} KDA` }; } },

  { id:"asesino", name:"El asesino", desc:"Asesinatos por partida", icon:"sword", cat:"combat",
    compute: s => { const r = topBy(s, p=>p.killsPerGame, {minGames:3}); return { ...r, fmt: v => `${v.toFixed(1)} kills/partida` }; } },

  { id:"danger", name:"I am the danger", desc:"Daño total causado por minuto de partida", icon:"flame", cat:"combat",
    compute: s => { const r = topBy(s, p=>p.dmgPerMin, {minGames:3}); return { ...r, fmt: v => `${Math.round(v).toLocaleString("es-ES")} dmg/min` }; } },

  { id:"immortal", name:"Immortal Demon King", desc:"Menor número de muertes por partida", icon:"shield", cat:"vision",
    compute: s => { const r = topBy(s, p=>p.deathsPerGame, {minGames:3, lowest:true}); return { ...r, fmt: v => `${v.toFixed(2)} muertes/partida` }; } },

  { id:"afk", name:"AFK", desc:"Mayor número de muertes por partida", icon:"skull", cat:"meme",
    compute: s => { const r = topBy(s, p=>p.deathsPerGame, {minGames:3}); return { ...r, fmt: v => `${v.toFixed(2)} muertes/partida` }; } },

  { id:"ojo-de-dios", name:"El ojo de dios", desc:"Mayor puntuación de visión acumulada", icon:"eye", cat:"vision",
    compute: s => { const r = topBy(s, p=>p.visionScore); return { ...r, fmt: v => `${Math.round(v).toLocaleString("es-ES")} visión` }; } },

  { id:"otp", name:"One Trick Pony", desc:"Más partidas jugadas con un mismo campeón", icon:"mask", cat:"meme",
    compute: s => { const r = topBy(s, p=>p.topChampGames); return { ...r, fmt: (v,p) => p && p[0] ? `${v}x ${p[0].topChampName}` : `${v}` }; } },

  { id:"main", name:"I main League of Legends", desc:"Mayor número de campeones distintos jugados", icon:"book", cat:"meme",
    compute: s => { const r = topBy(s, p=>p.uniqueChamps); return { ...r, fmt: v => `${v} campeones` }; } },

  { id:"midas", name:"El Rey Midas", desc:"Oro ganado por minuto de partida", icon:"coin", cat:"macro",
    compute: s => { const r = topBy(s, p=>p.goldPerMin, {minGames:3}); return { ...r, fmt: v => `${Math.round(v).toLocaleString("es-ES")} oro/min` }; } },

  { id:"matabestias", name:"Matabestias", desc:"Dragones + Barones acumulados", icon:"claw", cat:"combat",
    compute: s => { const r = topBy(s, p=>p.objectives); return { ...r, fmt: v => `${v} objetivos` }; } },

  { id:"911", name:"911", desc:"Torres + Inhibidores acumulados", icon:"tower", cat:"macro",
    compute: s => { const r = topBy(s, p=>p.structures); return { ...r, fmt: v => `${v} estructuras` }; } },

  { id:"pentas", name:"De 5 en 5", desc:"Mayor número de pentakills", icon:"burst", cat:"combat",
    compute: s => { const r = topBy(s, p=>p.pentakills); return r.value > 0 ? { ...r, fmt: v => `${v} pentakill${v===1?"":"s"}` } : { value:null, winners:[] }; } },

  { id:"precision", name:"Precisión fatal", desc:"CS acumulado por minuto de partida", icon:"wheat", cat:"vision",
    compute: s => { const r = topBy(s, p=>p.csPerMin, {minGames:3}); return { ...r, fmt: v => `${v.toFixed(1)} CS/min` }; } },

  { id:"streak", name:"Racha imparable", desc:"Mayor racha de victorias consecutivas", icon:"bolt", cat:"macro",
    compute: s => { const r = topBy(s, p=>p.longestWinStreak); return r.value > 0 ? { ...r, fmt: v => `${v} victoria${v===1?"":"s"} seguidas` } : { value:null, winners:[] }; } },
];

/* ------------------------------------------------------------
   7) Rendering
------------------------------------------------------------- */
function displayName(rawName){
  const cfg = PLAYER_CONFIG[rawName];
  return cfg ? cfg.summoner : rawName;
}
function displayTag(rawName){
  const cfg = PLAYER_CONFIG[rawName];
  return cfg && cfg.tag ? `#${cfg.tag}` : "";
}

function winnerNames(winners){
  return winners.map(p => displayName(p.name)).join(" · ");
}

function renderLeaderboard(stats){
  const el = document.getElementById("leaderboard");
  const ranked = stats
    .map(p => ({ p, cfg: PLAYER_CONFIG[p.name] || { tier:"UNRANKED", division:null, lp:0 } }))
    .sort((a,b) => rankScore(b.cfg) - rankScore(a.cfg));

  el.innerHTML = ranked.map(({p, cfg}, i) => {
    const losses = p.games - p.wins;
    const wrPct = Math.round(p.winRate * 100);
    const champsHTML = p.top3Champs.length
      ? p.top3Champs.map(c => `<img class="lb-champ-icon" src="${champImgUrl(c.name)}" alt="${escapeHtml(c.name)}" title="${escapeHtml(c.name)} ×${c.count}" loading="lazy" onerror="champImgFallback(this)">`).join("")
      : `<span class="empty-note">—</span>`;

    return `
    <div class="lb-row ${i===0 ? "lb-first" : ""}">
      <div class="lb-pos" data-label="Pos">#${i+1}</div>
      <div data-label="Rango">${tierIconSVG(cfg.tier)}</div>
      <div class="lb-name-block" data-label="Jugador">
        <div class="lb-name">${displayName(p.name)}</div>
        <div class="lb-tag">${displayTag(p.name)} · ${p.games} partidas</div>
      </div>
      <div class="lb-wl" data-label="V / D"><span class="lb-win">${p.wins}V</span><span class="lb-loss">${losses}D</span></div>
      <div class="lb-winrate" data-label="Winrate">
        <div class="lb-winrate-bar"><div class="lb-winrate-fill" style="width:${wrPct}%"></div></div>
        <span class="lb-winrate-pct">${wrPct}%</span>
      </div>
      <div class="lb-champs" data-label="Top campeones">${champsHTML}</div>
      <div class="lb-rank-text" data-label="Rango SoloQ">
        <div class="lb-rank-tier" style="color:${TIER_COLORS[cfg.tier]}">${rankLabel(cfg)}</div>
      </div>
    </div>`;
  }).join("");

  return ranked;
}

function tierIconSVG(tier){
  const color = TIER_COLORS[tier] || TIER_COLORS.UNRANKED;
  return `<svg class="lb-tier-icon" viewBox="0 0 24 24">
    <polygon points="12,1 21,7 21,17 12,23 3,17 3,7" fill="${color}" opacity="0.9"/>
    <polygon points="12,1 21,7 21,17 12,23 3,17 3,7" fill="none" stroke="${color}" stroke-width="1" opacity="0.5"/>
  </svg>`;
}

function renderLeaderHighlight(rankedList){
  const el = document.getElementById("leader-highlight");
  if (!rankedList.length){ el.innerHTML = `<p class="empty-note">Sin datos todavía</p>`; return; }
  const { p, cfg } = rankedList[0];
  el.innerHTML = `
    <div class="leader-badge">${icon("crown")}</div>
    <div>
      <div class="leader-name">${displayName(p.name)}</div>
      <div class="leader-meta" style="color:${TIER_COLORS[cfg.tier]}">${rankLabel(cfg)}</div>
    </div>
  `;
}

function renderTournamentStats(t){
  const el = document.getElementById("stats-grid");
  const winPct = Math.round(t.winRate * 100);
  const lossPct = 100 - winPct;

  const champCard = (title, champ, sub, iconName) => {
    if (!champ) return `
      <div class="stat-card">
        <div class="stat-icon">${icon(iconName)}</div>
        <p class="stat-label">${title}</p>
        <p class="empty-note">Sin datos suficientes</p>
      </div>`;
    return `
      <div class="stat-card stat-card--champ">
        <img class="stat-champ-img" src="${champImgUrl(champ.name)}" alt="${escapeHtml(champ.name)}" loading="lazy" onerror="champImgFallback(this)">
        <div class="stat-champ-body">
          <p class="stat-label">${title}</p>
          <div class="stat-champ-name">${champ.name}</div>
          <p class="stat-sub">${sub(champ)}</p>
        </div>
      </div>`;
  };

  const durationCard = (title, entry, iconName) => {
    if (!entry) return `
      <div class="stat-card">
        <div class="stat-icon">${icon(iconName)}</div>
        <p class="stat-label">${title}</p>
        <p class="empty-note">Sin datos suficientes</p>
      </div>`;
    return `
      <div class="stat-card">
        <div class="stat-icon">${icon(iconName)}</div>
        <p class="stat-label">${title}</p>
        <div class="stat-value">${formatDuration(entry.minutes)}</div>
        <p class="stat-sub">${displayName(entry.player)} · ${entry.champ || "—"}</p>
      </div>`;
  };

  el.innerHTML = `
    <div class="stat-card">
      <div class="stat-icon">${icon("chart")}</div>
      <p class="stat-label">Partidas totales</p>
      <div class="stat-value">${t.totalGames}</div>
    </div>
    <div class="stat-card">
      <div class="stat-icon">${icon("shield")}</div>
      <p class="stat-label">Victorias totales</p>
      <div class="stat-value stat-win">${t.totalWins}</div>
    </div>
    <div class="stat-card">
      <div class="stat-icon">${icon("skull")}</div>
      <p class="stat-label">Derrotas totales</p>
      <div class="stat-value stat-loss">${t.totalLosses}</div>
    </div>
    <div class="stat-card stat-card--bar">
      <p class="stat-label">Winratio global del torneo</p>
      <div class="stat-bar-row">
        <div class="stat-bar"><div class="stat-bar-win" style="width:${winPct}%"></div></div>
      </div>
      <div class="stat-bar-labels">
        <span class="lb-win">${winPct}% victorias</span>
        <span class="lb-loss">${lossPct}% derrotas</span>
      </div>
    </div>
    ${champCard("Campeón más jugado", t.mostPlayed, c => `${c.games} partidas jugadas`, "burst")}
    ${champCard("Mayor % de victorias", t.bestWR, c => `${Math.round(c.wr*100)}% WR · ${c.wins} victorias`, "shield")}
    ${champCard("Menor % de victorias", t.worstWR, c => `${Math.round(c.wr*100)}% WR · ${c.games - c.wins} derrotas`, "skull")}
    ${durationCard("Partida más larga", t.longest, "hourglass")}
    ${durationCard("Partida más corta", t.shortest, "hourglass")}
  `;
}

function featuredLeaderCard(rankedList){
  const color = "var(--gold)";
  if (!rankedList.length){
    return `
      <div class="trophy-card trophy-card--featured" style="--cat-color:${color}">
        <div class="medallion">${icon("crown")}</div>
        <div class="trophy-body">
          <span class="trophy-tag">Trofeo mayor</span>
          <h3 class="trophy-name">Líder supremo</h3>
          <p class="trophy-desc">El jugador mejor clasificado del torneo, según su rango de SoloQ</p>
        </div>
        <p class="empty-note">Sin datos todavía</p>
      </div>`;
  }
  const { p, cfg } = rankedList[0];
  return `
    <div class="trophy-card trophy-card--featured" style="--cat-color:${color}">
      <div class="medallion">${icon("crown")}</div>
      <div class="trophy-body">
        <span class="trophy-tag">Trofeo mayor</span>
        <h3 class="trophy-name">Líder supremo</h3>
        <p class="trophy-desc">El jugador mejor clasificado del torneo, según su rango de SoloQ</p>
      </div>
      <div class="trophy-winner">
        <div class="trophy-winner-body">
          <span class="trophy-winner-name">${displayName(p.name)}</span>
          <div class="trophy-winner-value" style="color:${TIER_COLORS[cfg.tier]}">${rankLabel(cfg)}</div>
        </div>
      </div>
    </div>`;
}

function renderTrophies(stats, rankedList){
  const el = document.getElementById("trophy-grid");

  const cards = TROPHIES.map(t => {
    const result = t.compute(stats);
    const color = CATS[t.cat];
    const tag = `<span class="trophy-tag">${CAT_LABELS[t.cat]}</span>`;

    if (result.value === null || !result.winners.length){
      return `
        <div class="trophy-card" style="--cat-color:${color}">
          ${tag}
          <div class="medallion">${icon(t.icon)}</div>
          <h3 class="trophy-name">${t.name}</h3>
          <p class="trophy-desc">${t.desc}</p>
          <p class="empty-note">Sin datos suficientes todavía</p>
        </div>`;
    }

    const isTie = result.winners.length > 1;
    const valueText = result.fmt(result.value, result.winners);

    return `
      <div class="trophy-card" style="--cat-color:${color}">
        ${tag}
        <div class="medallion">${icon(t.icon)}</div>
        <h3 class="trophy-name">${t.name}</h3>
        <p class="trophy-desc">${t.desc}</p>
        <div class="trophy-winner">
          <div class="trophy-winner-body">
            ${isTie
              ? `<span class="trophy-tie-list">${winnerNames(result.winners)}</span>`
              : `<span class="trophy-winner-name">${displayName(result.winners[0].name)}</span>`}
            <div class="trophy-winner-value">${valueText}</div>
          </div>
        </div>
      </div>`;
  }).join("");

  el.innerHTML = featuredLeaderCard(rankedList) + cards;
}

/* ------------------------------------------------------------
   8) Countdown
------------------------------------------------------------- */
function tickCountdown(){
  const now = new Date();
  let diff = TOURNAMENT_END.getTime() - now.getTime();
  if (diff < 0) diff = 0;
  const days = Math.floor(diff / 86400000);
  const hours = Math.floor((diff % 86400000) / 3600000);
  const mins = Math.floor((diff % 3600000) / 60000);
  const secs = Math.floor((diff % 60000) / 1000);
  document.getElementById("cd-days").textContent = String(days);
  document.getElementById("cd-hours").textContent = String(hours).padStart(2,"0");
  document.getElementById("cd-mins").textContent = String(mins).padStart(2,"0");
  document.getElementById("cd-secs").textContent = String(secs).padStart(2,"0");
}

/* ------------------------------------------------------------
   9) Load cycle
------------------------------------------------------------- */
function showDebugBanner(message){
  let banner = document.getElementById("debug-banner");
  if (!banner){
    banner = document.createElement("div");
    banner.id = "debug-banner";
    banner.style.cssText = "position:relative;z-index:2;max-width:920px;margin:0 auto 24px;padding:14px 18px;background:#3A1414;border:1px solid #E1594F;border-radius:8px;color:#F5C9C5;font-family:monospace;font-size:12.5px;white-space:pre-wrap;text-align:left;";
    document.querySelector(".hero-inner").appendChild(banner);
  }
  banner.textContent = message;
}
function clearDebugBanner(){
  const banner = document.getElementById("debug-banner");
  if (banner) banner.remove();
}

let ddragonLoaded = false;

async function loadAndRender(){
  try{
    if (!ddragonLoaded){ await loadDDragonVersion(); ddragonLoaded = true; }

    const res = await fetch(`${CSV_URL}&cachebust=${Date.now()}`, { cache: "no-store" });
    if (!res.ok) throw new Error(`La petición al CSV devolvió HTTP ${res.status}`);
    const text = await res.text();

    if (text.trim().toLowerCase().startsWith("<!doctype") || text.trim().toLowerCase().startsWith("<html")){
      throw new Error("El CSV_URL no devolvió un CSV, devolvió una página HTML (probablemente un login de Google). Revisa que la hoja esté publicada como 'Anyone with the link' / publicada en la web, no solo compartida.");
    }

    const rows = rowsToObjects(parseCSV(text));
    console.log(`[SoloQ] CSV recibido: ${text.length} caracteres, ${rows.length} filas de datos.`);
    if (rows.length){
      console.log("[SoloQ] Cabeceras detectadas:", Object.keys(rows[0]));
      console.log("[SoloQ] Primera fila:", rows[0]);
    }

    const stats = buildPlayerStats(rows);
    console.log(`[SoloQ] Jugadores agregados: ${stats.length}`, stats.map(p => `${p.name}: ${p.games} partidas`));

    if (!rows.length){
      throw new Error("El CSV se ha descargado pero no contiene filas de datos. Revisa el gid= de la URL (pestaña correcta de la hoja) y que 'Publicar en la web' esté activo.");
    }
    if (!stats.length){
      throw new Error("Se han leído " + rows.length + " filas pero ningún jugador cumple el mínimo. Es probable que el nombre de alguna columna (p.ej. 'Time' o 'Player') no coincida exactamente con la cabecera real del CSV. Mira 'Cabeceras detectadas' en la consola (F12) y compáralas con las que usa app.js.");
    }

    clearDebugBanner();
    const ranked = renderLeaderboard(stats);
    renderLeaderHighlight(ranked);
    renderTournamentStats(buildTournamentStats(rows));
    renderTrophies(stats, ranked);

    document.getElementById("last-updated").textContent =
      `Última actualización: ${new Date().toLocaleString("es-ES", { dateStyle:"medium", timeStyle:"short" })}`;
  } catch (err){
    console.error("[SoloQ] Error cargando datos:", err);
    showDebugBanner("⚠ " + err.message);
    document.getElementById("last-updated").textContent =
      "No se han podido cargar los datos. Reintentando…";
  }
}

tickCountdown();
setInterval(tickCountdown, 1000);
loadAndRender();
setInterval(loadAndRender, REFRESH_INTERVAL_MS);
