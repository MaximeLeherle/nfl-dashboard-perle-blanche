// Relevé des résultats No Finish Line via l'API publique Sportips.
// Node 20+, sans dépendance (fetch natif). Lancer : npm run scrape
//
// À chaque passage :
//  1. Parcours complet de toutes les courses, au plus une fois toutes les `scanMinutes` (60 par défaut) :
//     liste des marcheurs de l'équipe (data/roster.json) et nombre de marcheurs ayant marché par équipe.
//  2. Un appel par dossard pour ses tours / km / classements.
//  3. Classement des équipes (total km de l'équipe, rang, voisins, total de l'événement).
//  4. Ajout d'un relevé dans data/history.json et mise à jour de data/latest.json.

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DATA = path.join(ROOT, "data");
const API = "https://inscription.sportips.fr/api/chronometrie/endpoints/public";
const PAGE = 100; // maximum accepté par l'API
const PAUSE_MS = 150; // petite pause entre deux appels, par politesse

const cfg = JSON.parse(await readFile(path.join(ROOT, "config.json"), "utf8"));
const ORG = norm(cfg.team.organization);
const now = new Date();

function norm(s) { return String(s ?? "").normalize("NFD").replace(/\p{M}/gu, "").trim().toUpperCase().replace(/\s+/g, " "); }
function cap(s) { return String(s ?? "").toLowerCase().replace(/(^|[\s\-'’])(\p{L})/gu, (m, a, b) => a + b.toUpperCase()); }
const sleep = ms => new Promise(r => setTimeout(r, ms));
const isTeam = r => [r.organization, r.club, r.team_name].some(v => norm(v) === ORG);

async function api(route, body, tries = 3) {
  let res;
  try {
    res = await fetch(API + route, {
      method: body ? "POST" : "GET",
      headers: { "Accept": "application/json", ...(body ? { "Content-Type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(20_000),
    });
  } catch (e) {
    if (tries > 1) { await sleep(3000); return api(route, body, tries - 1); }
    throw new Error(`${route} → ${e.message}`);
  }
  // API saturée ou qui nous limite : on attend un peu et on réessaie
  if ((res.status === 429 || res.status >= 500) && tries > 1) { await sleep(res.status === 429 ? 15_000 : 3000); return api(route, body, tries - 1); }
  if (!res.ok) throw new Error(`${route} → HTTP ${res.status}`);
  const text = await res.text();
  let json;
  try { json = JSON.parse(text.slice(text.indexOf("{"))); } catch { throw new Error(`${route} → réponse illisible : ${text.slice(0, 120)}`); }
  if (!json.success) throw new Error(`${route} → ${json.message || "échec"}`);
  await sleep(PAUSE_MS);
  return json.data;
}

async function readJson(file, fallback) {
  try { return JSON.parse(await readFile(path.join(DATA, file), "utf8")); } catch { return fallback; }
}

function runnerInfo(r) {
  // nb_in_* ne sont justes que sur une page de classement complète (une recherche par dossard renvoie 1) :
  // on les garde ici, mis à jour à chaque recherche des marcheurs.
  return { bib: r.bib, race: r.id_race, first: cap(r.firstname), last: cap(r.name), sex: r.sexe, cat: r.category,
    nbCat: r.nb_in_category || null, nbSex: r.nb_in_sex || null, nbTotal: r.nb_in_total || null };
}
function runnerStats(r) {
  return {
    laps: r.lap_count ?? 0,
    km: r.lap_total_distance_km || +((r.lap_count ?? 0) * cfg.event.lapKm).toFixed(2), // distance API, sinon tours × longueur
    rank: r.rank || null,
    rankSex: r.rank_sex || null,
    rankCat: r.rank_category || null,
  };
}

// ---------- 1. événement ----------
const endLimit = new Date(cfg.event.end).getTime() + 6 * 3600e3;
if (now.getTime() > endLimit && !process.env.FORCE) {
  console.log("Événement terminé : plus de relevé (FORCE=1 pour forcer).");
  process.exit(78); // code compris par loop.sh : arrêter la boucle
}
const event = await api(`/event/get.php?base=${encodeURIComponent(cfg.event.base)}`);
console.log(`Événement : ${event.name} (id ${event.id})`);

// ---------- 2. parcours complet : marcheurs de l'équipe + actifs par équipe ----------
let roster = await readJson("roster.json", null);
const prevLatest = await readJson("latest.json", {});
let scan = prevLatest.scan ?? null; // { at, active: { ÉQUIPE: nb de marcheurs ayant fait au moins un tour } }
const scanAge = scan ? (now - new Date(scan.at)) / 60e3 : Infinity;
const fresh = new Map(); // bib -> ligne API récupérée pendant le parcours (évite un 2e appel)

if (!roster || scanAge >= (cfg.scanMinutes ?? 60) || process.env.REFRESH_ROSTER) {
  console.log("Parcours de toutes les courses (marcheurs de l'équipe, actifs par équipe)…");
  try {
    const active = {};
    const races = (await api("/races/get.php", { event_id: event.id, with_count_runners: true })).filter(r => r.count_runners > 0);
    const extra = new Set((cfg.extraRunners ?? []).map(Number));
    const found = new Map();
    for (const race of races) {
      let page = 1, last = 1;
      do {
        const d = await api("/results/get.php", { id_race: race.id, order_by: "rank", page, limit: PAGE });
        last = d.pagination?.last_page || 1;
        for (const r of d.runners ?? []) {
          if (isTeam(r) || extra.has(r.bib)) { found.set(r.bib, runnerInfo(r)); fresh.set(r.bib, r); }
          const o = norm(r.organization);
          if (o && (r.lap_count ?? 0) > 0) active[o] = (active[o] || 0) + 1;
        }
        page++;
      } while (page <= last);
      console.log(`  ${race.name} : ${last} page(s)`);
    }
    const exclude = new Set((cfg.excludeBibs ?? []).map(Number));
    const runners = [...found.values()].filter(r => !exclude.has(r.bib)).sort((a, b) => a.last.localeCompare(b.last, "fr") || a.first.localeCompare(b.first, "fr"));
    if (!runners.length) throw new Error(`aucun marcheur trouvé pour « ${cfg.team.organization} »`);
    roster = { updatedAt: now.toISOString(), eventId: event.id, races: races.map(r => ({ id: r.id, name: r.name })), runners };
    scan = { at: now.toISOString(), active };
    console.log(`  ${runners.length} marcheurs dans l'équipe, ${Object.keys(active).length} équipes avec au moins un marcheur actif.`);
  } catch (e) {
    console.error("Recherche des marcheurs impossible :", e.message);
    if (!roster) process.exit(1);
    console.error("On garde la liste précédente.");
    fresh.clear();
  }
}

// ---------- 3. un appel par dossard ----------
const history = await readJson("history.json", []);
const prev = (await readJson("latest.json", {})).stats ?? {};
const runners = {};
const errors = [];
for (const r of roster.runners) {
  try {
    let row = fresh.get(r.bib);
    if (!row) {
      const d = await api("/results/get.php", { id_race: r.race, search_terms: String(r.bib), page: 1, limit: 10 });
      row = (d.runners ?? []).find(x => x.bib === r.bib);
      if (!row) throw new Error("dossard introuvable dans la course " + r.race);
    }
    runners[r.bib] = runnerStats(row);
  } catch (e) {
    errors.push({ bib: r.bib, error: e.message });
    console.error(`Dossard ${r.bib} (${r.first} ${r.last}) : ${e.message}`);
    if (prev[r.bib]) runners[r.bib] = prev[r.bib]; // on garde la dernière valeur connue
  }
}

// ---------- 4. classement des équipes ----------
let team = null, eventTotals = null, peers = null;
try {
  const list = await api(`/customResults/list.php?event_id=${event.id}`);
  const ranking = list.find(x => /interorganisme/.test(x.type));
  if (!ranking) throw new Error("pas de classement par équipe publié");
  const orgs = [];
  let page = 1, last = 1;
  do {
    const d = await api(`/customResults/get.php?id=${ranking.id}&page=${page}&limit=${PAGE}`);
    orgs.push(...(d.organizations ?? []));
    last = d.pagination?.last_page || 1;
    page++;
  } while (page <= last);
  const pick = o => o && { name: o.organization, rank: o.rank, laps: o.total_laps, km: o.total_distance_km };
  const i = orgs.findIndex(o => norm(o.organization) === ORG);
  if (i >= 0) team = { ...pick(orgs[i]), runners: orgs[i].nb_runners_total, above: pick(orgs[i - 1]) ?? null, below: pick(orgs[i + 1]) ?? null };
  // Équipes de taille comparable : ±pct % de marcheurs (au moins ±min), comptés de deux façons :
  // « reg » = inscrits (donné par Sportips), « act » = ayant fait au moins un tour (parcours horaire).
  if (i >= 0) {
    const p = cfg.peers ?? {};
    const myActive = Object.values(runners).filter(v => v.laps > 0).length; // à jour à chaque relevé
    const actOf = o => norm(o.organization) === ORG ? myActive : scan?.active?.[norm(o.organization)] ?? 0;
    const tranche = (n, size) => {
      if (!n) return null;
      const w = Math.max(p.min ?? 2, Math.round(n * (p.pct ?? 25) / 100));
      const lo = Math.max(1, n - w), hi = n + w;
      return { lo, hi, teams: orgs.filter(o => size(o) >= lo && size(o) <= hi)
        .map(o => ({ name: o.organization, rank: o.rank, runners: o.nb_runners_total, active: actOf(o), laps: o.total_laps, km: o.total_distance_km })) };
    };
    peers = { reg: tranche(orgs[i].nb_runners_total, o => o.nb_runners_total), act: scan ? tranche(myActive, actOf) : null, scanAt: scan?.at ?? null };
  }
  eventTotals = {
    totalKm: +orgs.reduce((s, o) => s + (o.total_distance_km || 0), 0).toFixed(1),
    totalLaps: orgs.reduce((s, o) => s + (o.total_laps || 0), 0),
    teams: orgs.length,
    leader: pick(orgs[0]) ?? null,
  };
} catch (e) {
  errors.push({ bib: null, error: "classement équipes : " + e.message });
  console.error("Classement des équipes :", e.message);
}
// Total de l'équipe recalculé si le classement n'est pas disponible
if (!team) {
  const vals = Object.values(runners);
  team = { name: cfg.team.organization, rank: null, laps: vals.reduce((s, v) => s + v.laps, 0), km: +vals.reduce((s, v) => s + v.km, 0).toFixed(2), runners: roster.runners.length, above: null, below: null };
}

// ---------- 5. écriture ----------
// Dans l'historique : seulement les marcheurs qui ont marché, et seulement tours + km (les courbes).
// Les classements du moment sont dans latest.json. Un relevé toutes les 5 min : il faut rester léger.
const slim = Object.fromEntries(Object.entries(runners).filter(([, v]) => v.laps > 0).map(([b, v]) => [b, { laps: v.laps, km: v.km }]));
// Places dans les tranches « même taille » (même tri que le site), pour suivre leur évolution
const mine = t => norm(t.name) === ORG;
for (const [key, sfx] of [["reg", ""], ["act", "A"]]) {
  const P = team && peers?.[key];
  if (!P) continue;
  const size = t => key === "act" ? t.active : t.runners;
  const byLaps = [...P.teams].sort((a, b) => b.laps - a.laps || b.km - a.km);
  const byPer = [...P.teams].sort((a, b) => b.km / size(b) - a.km / size(a) || b.km - a.km);
  team["peers" + sfx] = P.teams.length;
  team["peerRank" + sfx] = byLaps.findIndex(mine) + 1 || null;
  team["peerRankPer" + sfx] = byPer.findIndex(mine) + 1 || null;
}
const snapshot = { t: now.toISOString(), event: eventTotals, team, runners: slim };
const compact = s => JSON.stringify({ team: { laps: s.team?.laps, rank: s.team?.rank, p: s.team?.peerRank, pp: s.team?.peerRankPer, pa: s.team?.peerRankA, ppa: s.team?.peerRankPerA }, runners: Object.fromEntries(Object.entries(s.runners).map(([b, v]) => [b, v.laps])) });
const last = history.at(-1);
const changed = !last || compact(last) !== compact(snapshot);
if (changed) history.push(snapshot);

await mkdir(DATA, { recursive: true });
await writeFile(path.join(DATA, "roster.json"), JSON.stringify(roster, null, 1) + "\n");
// un relevé par ligne : des diffs git lisibles et un dépôt qui grossit peu
await writeFile(path.join(DATA, "history.json"), "[\n" + history.map(s => JSON.stringify(s)).join(",\n") + "\n]\n");
await writeFile(path.join(DATA, "latest.json"), JSON.stringify({ checkedAt: now.toISOString(), snapshotAt: history.at(-1).t, runners: roster.runners.length, errors, stats: runners, peers, scan }) + "\n");

const v = Object.values(runners);
console.log(`Relevé ${changed ? "ajouté" : "identique au précédent (non ajouté)"} : ${v.length}/${roster.runners.length} marcheurs, ${v.filter(x => x.laps > 0).length} ont marché, équipe ${team.km} km${team.rank ? `, ${team.rank}e` : ""}${eventTotals ? `, événement ${eventTotals.totalKm} km` : ""}. ${errors.length} erreur(s).`);
if (v.length === 0) process.exit(1);
