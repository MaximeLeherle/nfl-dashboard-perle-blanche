// Tableau de bord d'équipe — No Finish Line Monaco 2026
// Lit config.json, data/roster.json, data/history.json et data/latest.json. Aucun framework, aucune étape de build.
"use strict";

const REFRESH_MS = 5 * 60e3;
const SCRAPE_MIN = 5; // un relevé toutes les 5 min
// « En piste » tant qu'un tour est apparu dans les 4 derniers relevés (20 min) : un tour de 1 km à pied
// peut prendre plus de 5 min, mais pas 20. Au-delà : en pause. (+2 min de marge sur l'heure des relevés)
const ON_TRACK_MIN = 4 * SCRAPE_MIN + 2;

let CFG, ROSTER, HIST, LATEST, TZ, LAP;
let members = [], byBib = {}, days = [];
let NOW = new Date();
let filter = "all", query = "", showAll = false, rhythm = "h", follows = [], peerSort = "km", peersAll = false, rankView = "g", peerBase = "reg";
const charts = {};

/* ---------- utilitaires ---------- */
const $ = s => document.querySelector(s);
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
// minuscules sans accents : « anais » trouve « Anaïs »
const fold = s => String(s ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
// prénom seul, ou prénom + nom quand les deux marcheurs comparés ont le même prénom
const pairNames = (a, b) => fold(a.first) === fold(b.first) ? [a.name, b.name] : [a.first, b.first];
const css = v => getComputedStyle(document.documentElement).getPropertyValue(v).trim();
const km = n => (n ?? 0).toLocaleString("fr-FR", { minimumFractionDigits: 1, maximumFractionDigits: 1 });
const int = n => (n ?? 0).toLocaleString("fr-FR");
const ord = n => n === 1 ? "1er" : n + "e";
const ordF = n => n === 1 ? "1re" : n + "e";
const plural = (n, w) => `${n} ${w}${n > 1 ? "s" : ""}`;
// 1 tour = LAP km exactement chez Sportips : on retrouve les tours à partir des km (totaux, par jour, par heure)
const lapsOf = k => Math.round((k ?? 0) / LAP);
const tours = k => plural(lapsOf(k), "tour");
const hhmm = t => new Date(t).toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit", timeZone: TZ }).replace(":", "h");
const dayKey = t => new Intl.DateTimeFormat("fr-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(t));
function tzParts(t) { return Object.fromEntries(new Intl.DateTimeFormat("en-GB", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" }).formatToParts(new Date(t)).map(p => [p.type, p.value])); }
// heure de début de l’intervalle de relevé (le relevé de 15h00 compte pour 14h-15h)
const hourKey = t => { const p = tzParts(+new Date(t) - 1000); return `${p.year}-${p.month}-${p.day} ${p.hour}`; };
// décalage horaire du fuseau de l’événement à l instant t (ms)
const tzOffset = t => { const p = tzParts(t); return Date.UTC(+p.year, p.month - 1, +p.day, +p.hour, +p.minute, +p.second) - Math.floor(t / 1000) * 1000; };
function ago(t, short) {
  const m = Math.max(0, Math.round((NOW - new Date(t)) / 60000));
  let s;
  if (m < 1) return "à l'instant";
  if (m < 60) s = `${m} min`;
  else if (m < 1440) s = `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, "0")}`;
  else s = `${Math.floor(m / 1440)} j`;
  return short ? s : "il y a " + s;
}
function rgba(hex, a) { const n = parseInt(hex.replace("#", ""), 16); return `rgba(${n >> 16 & 255},${n >> 8 & 255},${n & 255},${a})`; }
const store = {
  get(k, d) { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* stockage indisponible */ } },
};
const norm = s => String(s ?? "").normalize("NFD").replace(/\p{M}/gu, "").trim().toUpperCase().replace(/\s+/g, " ");
const followKey = () => "nfl-follow-" + CFG.team.organization;

/* ---------- chargement ---------- */
async function getJson(url) {
  try { const r = await fetch(url + "?v=" + Date.now(), { cache: "no-store" }); return r.ok ? await r.json() : null; }
  catch { return null; }
}
async function load() {
  const [cfg, roster, history, latest] = await Promise.all(["config.json", "data/roster.json", "data/history.json", "data/latest.json"].map(getJson));
  if (!cfg) throw new Error("config.json introuvable");
  CFG = cfg; ROSTER = roster; HIST = (history ?? []).sort((a, b) => a.t.localeCompare(b.t)); LATEST = latest;
  TZ = CFG.event.timezone || "Europe/Paris"; LAP = CFG.event.lapKm || 1;
  NOW = new Date();
  // équipe et couleurs depuis la config
  document.title = `${CFG.team.label} · No Finish Line`;
  let st = document.getElementById("teamColors");
  if (!st) { st = document.createElement("style"); st.id = "teamColors"; document.head.append(st); }
  const t = CFG.team;
  st.textContent = `:root{--team:${t.color};--team-2:${t.compareColor}}
@media (prefers-color-scheme:dark){:root:not([data-theme="light"]){--team:${t.colorDark || t.color};--team-2:${t.compareColorDark || t.compareColor}}}
:root[data-theme="dark"]{--team:${t.colorDark || t.color};--team-2:${t.compareColorDark || t.compareColor}}`;
  // jours de l'événement
  days = [];
  for (let d = new Date(CFG.event.start); dayKey(d) <= dayKey(CFG.event.end); d = new Date(+d + 864e5)) days.push(dayKey(d));
  // marcheurs
  const stats = LATEST?.stats ?? HIST.at(-1)?.runners ?? {};
  members = (ROSTER?.runners ?? []).map(r => {
    const s = stats[r.bib] ?? {};
    return { ...r, name: `${r.first} ${r.last}`, laps: s.laps ?? 0, km: s.km ?? +((s.laps ?? 0) * LAP).toFixed(2), rank: s.rank, rankSex: s.rankSex, rankCat: s.rankCat };
  });
  members.sort((a, b) => b.laps - a.laps || b.km - a.km || a.last.localeCompare(b.last, "fr"));
  members.forEach((m, i) => { m.pos = m.laps ? i + 1 : null; m.lastLap = lastLap(m.bib); });
  byBib = Object.fromEntries(members.map(m => [m.bib, m]));
  follows = store.get(followKey(), []).filter(b => byBib[b]);
}

/* ---------- calculs à partir des relevés ---------- */
const runnerKm = (s, bib) => s.runners?.[bib]?.km ?? 0;
const teamKm = s => s.team?.km ?? Object.values(s.runners ?? {}).reduce((a, v) => a + (v.km || 0), 0);
// heure du relevé où le dernier tour est apparu (null s'il date d'avant le premier relevé)
function lastLap(bib) {
  let prev = null, at = null;
  for (const s of HIST) {
    const l = s.runners?.[bib]?.laps ?? 0;
    if (prev !== null && l > prev) at = s.t;
    prev = l;
  }
  return at;
}
function series(fn) { return HIST.map(s => ({ x: +new Date(s.t), y: +fn(s).toFixed(2) })); }
// km parcourus chaque jour de l'événement (null pour les jours à venir)
function daily(fn) {
  const today = dayKey(NOW);
  let before = 0;
  return days.map(d => {
    if (d > today) return null;
    const inDay = HIST.filter(s => dayKey(s.t) === d);
    if (!inDay.length) return 0;
    const end = fn(inDay.at(-1)), v = Math.max(0, end - before);
    before = end;
    return +v.toFixed(1);
  });
}
// km ajoutés par heure, aujourd'hui
function hourly(fn) {
  const today = dayKey(NOW), out = new Map();
  for (let i = 1; i < HIST.length; i++) {
    if (hourKey(HIST[i].t).slice(0, 10) !== today) continue;
    const k = hourKey(HIST[i].t);
    out.set(k, (out.get(k) || 0) + Math.max(0, fn(HIST[i]) - fn(HIST[i - 1])));
  }
  return [...out].map(([k, v]) => ({ label: +k.slice(-2) + "h", y: +v.toFixed(1) }));
}
// Évolution d'une place depuis le premier relevé du jour (ou du suivi, le premier jour)
function rankMove(get) {
  const cur = get(HIST.at(-1));
  if (!cur) return "";
  const today = dayKey(NOW);
  const ref = HIST.find(s => dayKey(s.t) === today && get(s)) ?? null;
  const first = HIST.find(s => get(s));
  const from = ref ?? first, since = ref && ref !== first ? "depuis minuit" : "depuis le début du suivi";
  if (!from || from === HIST.at(-1)) return "";
  const d = get(from) - cur; // positif = on a gagné des places
  return d > 0 ? `<span class="move up">▲ ${plural(d, "place")} ${since}</span>`
    : d < 0 ? `<span class="move down">▼ ${plural(-d, "place")} ${since}</span>`
    : `<span class="move">= même place ${since}</span>`;
}

function state(m) {
  if (!m.laps) return { k: "off", t: m.sex === "F" ? "Pas encore partie" : "Pas encore parti" };
  // compté depuis le dernier relevé, pas depuis maintenant : un robot en retard ne met pas tout le monde en pause.
  // Mais si plus aucun relevé n'arrive (> 15 min), on repasse sur l'heure réelle.
  const checked = new Date(LATEST?.checkedAt ?? HIST.at(-1)?.t ?? NOW);
  const ref = NOW - checked > 15 * 60e3 ? NOW : checked;
  if (m.lastLap && (ref - new Date(m.lastLap)) / 60000 <= ON_TRACK_MIN) return { k: "on", t: "En piste" };
  return { k: "pause", t: m.lastLap ? ago(m.lastLap, true) : "En pause" };
}
const pill = m => { const s = state(m); return `<span class="pill ${s.k}" title="${s.k === "pause" && m.lastLap ? "Dernier tour " + esc(ago(m.lastLap)) : ""}">${esc(s.t)}</span>`; };

/* ---------- en-tête, navigation, pied ---------- */
function renderHeader(view) {
  const ev = CFG.event, start = new Date(ev.start), end = new Date(ev.end);
  $("#evSub").textContent = `Boucle de ${String(LAP).replace(".", ",")} km · ${start.toLocaleDateString("fr-FR", { day: "numeric", month: "long", timeZone: TZ })} → ${end.toLocaleDateString("fr-FR", { day: "numeric", month: "long", timeZone: TZ })}`;
  const checked = LATEST?.checkedAt ?? HIST.at(-1)?.t;
  const running = NOW >= start && NOW <= end;
  $("#updated").textContent = checked ? `${running ? "En direct · " : ""}relevé ${ago(checked)} (${hhmm(checked)})` : "Aucun relevé pour l'instant";
  $("#liveDot").classList.toggle("idle", !running);
  const di = days.indexOf(dayKey(NOW));
  const track = $("#dayTrack");
  track.style.setProperty("--n", days.length);
  if (NOW < start) {
    $("#dayLabel").textContent = "Bientôt";
    $("#dayLeft").textContent = `départ ${start.toLocaleDateString("fr-FR", { weekday: "long", day: "numeric", timeZone: TZ })}`;
  } else if (NOW > end) {
    $("#dayLabel").textContent = "Course terminée";
    $("#dayLeft").textContent = "";
  } else {
    const left = end - NOW;
    $("#dayLabel").textContent = `Jour ${di + 1} / ${days.length}`;
    $("#dayLeft").textContent = `fin dans ${Math.floor(left / 864e5)} j ${Math.floor(left % 864e5 / 36e5)} h`;
  }
  const frac = (() => { const [h, m] = new Intl.DateTimeFormat("fr-FR", { timeZone: TZ, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(NOW).split(":").map(Number); return (h * 60 + m) / 1440; })();
  const doneUpTo = NOW > end ? days.length : di;
  track.innerHTML = days.map((_, i) => `<span class="${i < doneUpTo ? "done" : i === di && NOW <= end ? "today" : ""}" style="--p:${Math.round(frac * 100)}%"></span>`).join("");

  // alerte si les relevés sont en retard pendant la course
  const late = running && checked && (NOW - new Date(checked)) > 20 * 60e3;
  const errs = LATEST?.errors?.length ? `${plural(LATEST.errors.length, "erreur")} au dernier relevé.` : "";
  $("#notice").hidden = !(late || errs);
  $("#noticeText").textContent = late ? `Pas de nouveau relevé depuis ${ago(checked, true)}. GitHub Actions est sans doute en retard ; les chiffres reviendront tout seuls. ${errs}` : errs;

  const nb = members.length;
  $("#nav").innerHTML = `
    <a class="tab" href="#equipe" ${view === "equipe" ? 'aria-current="page"' : ""}><span class="sw"></span>${esc(CFG.team.label)} <small>${nb}</small></a>
    <a class="tab" href="#comparer" ${view === "comparer" ? 'aria-current="page"' : ""}>Comparer</a>
    <select class="pick" id="pick" aria-label="Voir un marcheur">
      <option value="">Voir un marcheur…</option>
      ${[...members].sort((a, b) => a.last.localeCompare(b.last, "fr") || a.first.localeCompare(b.first, "fr")).map(m => `<option value="${m.bib}" ${view === "coureur-" + m.bib ? "selected" : ""}>${esc(m.last.toUpperCase())} ${esc(m.first)}${m.laps ? " · " + km(m.km) + " km" : ""}</option>`).join("")}
    </select>`;
}
function renderFoot() {
  const ev = HIST.at(-1)?.event;
  $("#foot").innerHTML = `
    ${ev ? `<span>Toute la course : <b>${int(Math.round(ev.totalKm))} km</b> par <b>${int(ev.teams)} équipes</b>${ev.leader ? ` · en tête <b>${esc(ev.leader.name)}</b> (${int(ev.leader.laps)} tours)` : ""}</span>` : "<span></span>"}
    <span>Source : chronométrage Sportips, relevé toutes les ${SCRAPE_MIN} min · 1 tour = ${String(LAP).replace(".", ",")} km</span>`;
}

/* ---------- suivis ---------- */
function followStrip() {
  const list = follows.map(b => byBib[b]).filter(Boolean);
  return `<div class="follow-strip"><span class="lbl">☆ Vos suivis</span>${list.length
    ? list.map(m => `<a class="chip" href="#coureur-${m.bib}">${esc(m.first)} ${esc(m.last[0])}. <span class="num">${km(m.km)} km · ${m.laps} t</span></a>`).join("")
    : `<span class="muted">Touchez l'étoile d'un marcheur pour le garder ici. C'est mémorisé sur cet appareil, sans compte.</span>`}</div>`;
}
function toggleFollow(bib) {
  bib = +bib;
  follows = follows.includes(bib) ? follows.filter(b => b !== bib) : [...follows, bib];
  store.set(followKey(), follows);
  render(true);
}
const starBtn = m => `<button class="star" data-star="${m.bib}" aria-pressed="${follows.includes(m.bib)}" aria-label="${follows.includes(m.bib) ? "Ne plus suivre" : "Suivre"} ${esc(m.name)}">${follows.includes(m.bib) ? "★" : "☆"}</button>`;

/* ---------- vue équipe ---------- */
function teamView() {
  const S = HIST.at(-1), T = S.team, n = members.length;
  const active = members.filter(m => m.laps > 0), onTrack = members.filter(m => state(m).k === "on");
  const last = active.map(m => m.lastLap).filter(Boolean).sort().at(-1);
  const di = days.indexOf(dayKey(NOW)), today = di >= 0 ? daily(teamKm)[di] : null;
  const gapTxt = (g, o, dir) => g === 0 ? `À égalité de tours avec <b>${esc(o.name)}</b> (${ordF(o.rank)})`
    : dir === "up" ? `<b>${plural(g, "tour")}</b> derrière <b>${esc(o.name)}</b> (${ordF(o.rank)})`
    : `<b>${plural(g, "tour")}</b> d'avance sur <b>${esc(o.name)}</b> (${ordF(o.rank)})`;

  const counts = { all: n, on: onTrack.length, ran: active.length, off: n - active.length };
  const q = fold(query.trim());
  let rows = members.filter(m => filter === "all" || (filter === "on" ? state(m).k === "on" : filter === "ran" ? m.laps > 0 : m.laps === 0))
    .filter(m => !q || fold(`${m.first} ${m.last} ${m.bib}`).includes(q));
  const total = rows.length;
  if (!showAll && !q) rows = rows.slice(0, 15);
  const maxKm = Math.max(members[0]?.km || 0, 0.1);

  return `
  ${followStrip()}
  <section class="hero">
    <div>
      <div class="team"><span class="sw"></span><h2>${esc(CFG.team.name)}</h2></div>
      <div class="bigkm">${km(T.km)}<small>km</small></div>
      <div class="sub">${int(T.laps)} tours · ${active.length} marcheur${active.length > 1 ? "s" : ""} sur ${n} ${active.length > 1 ? "ont" : "a"} déjà marché</div>
    </div>
    <div class="panel">
      <span class="lbl">Classement des équipes</span>
      ${T.rank ? `<div class="rankline"><span class="num">${ordF(T.rank)}</span><span>sur ${int(S.event?.teams)} équipes</span>${rankMove(s => s.team?.rank)}</div>
      ${T.above ? `<div class="gap"><span class="arrow">↑</span><span>${gapTxt(T.above.laps - T.laps, T.above, "up")}</span></div>` : `<div class="gap"><span class="arrow">★</span><span><b>En tête du classement !</b></span></div>`}
      ${T.below ? `<div class="gap"><span class="arrow">↓</span><span>${gapTxt(T.laps - T.below.laps, T.below, "down")}</span></div>` : ""}`
      : `<span class="muted">Classement des équipes indisponible pour le moment.</span>`}
    </div>
  </section>

  <section class="kpis">
    <div class="kpi"><span class="lbl">Aujourd'hui</span><span class="num">${today == null ? "–" : km(today)} <small>km</small></span><p>${di >= 0 ? `${today ? tours(today) + " · " : ""}Jour ${di + 1}, depuis minuit` : "en dehors des jours de course"}</p></div>
    <div class="kpi"><span class="lbl">En piste</span><span class="num">${onTrack.length} <small>/ ${n}</small></span><div class="meter"><i style="width:${n ? active.length / n * 100 : 0}%"></i></div><p>${active.length} ${active.length > 1 ? "ont" : "a"} marché au moins un tour</p></div>
    <div class="kpi"><span class="lbl">Moyenne</span><span class="num">${km(active.length ? T.km / active.length : 0)} <small>km</small></span><p>${active.length ? `soit ${(T.laps / active.length).toLocaleString("fr-FR", { maximumFractionDigits: 1 })} tours ` : ""}par personne qui a marché</p></div>
    <div class="kpi"><span class="lbl">Dernier tour</span><span class="num">${last ? ago(last, true) : "–"}</span><p>${last ? "vu au relevé de " + hhmm(last) : "aucun depuis le début du suivi"}</p></div>
  </section>

  ${goalCard(T)}

  ${peersCard()}

  ${rankCard()}

  <section class="grid2">
    <div class="card">
      <div class="card-h"><div><h3>Kilomètres cumulés</h3><p>Total de l'équipe, un point par relevé</p></div></div>
      <div class="chart"><canvas id="cCum" role="img" aria-label="Kilomètres cumulés de l'équipe"></canvas></div>
    </div>
    <div class="card">
      <div class="card-h"><div><h3>Podium de l'équipe</h3><p>Touchez un nom pour sa fiche</p></div></div>
      <div class="podium">${active.slice(0, 3).map((m, i) => `<a class="pod" href="#coureur-${m.bib}"><span class="p">${i + 1}</span><span style="min-width:0"><div class="n">${esc(m.name)}</div><div class="m">${m.laps} tours${m.rank ? " · " + ord(m.rank) + " au général" : ""}</div></span><span class="num">${km(m.km)}</span></a>`).join("") || `<p class="empty">Personne n'a encore marché.</p>`}</div>
    </div>
  </section>

  <section class="card">
    <div class="card-h"><div><h3>Rythme de l'équipe</h3><p>${rhythm === "h" ? "Kilomètres ajoutés chaque heure, aujourd'hui" : `Kilomètres par jour sur les ${days.length} jours`}</p></div>
      <div class="seg" role="group" aria-label="Période"><button data-rhythm="h" aria-pressed="${rhythm === "h"}">Par heure</button><button data-rhythm="d" aria-pressed="${rhythm === "d"}">Par jour</button></div></div>
    <div class="chart sm"><canvas id="cRhythm" role="img" aria-label="Rythme de l'équipe"></canvas></div>
  </section>

  <section class="card">
    <div class="card-h"><div><h3>Les marcheurs</h3><p>${n} inscrits sous « ${esc(CFG.team.organization)} » chez Sportips · touchez un nom pour sa fiche</p></div></div>
    <div class="roster-tools">
      <input class="search" id="q" type="search" placeholder="Chercher un prénom, un nom ou un dossard" value="${esc(query)}" aria-label="Chercher un marcheur" autocomplete="off">
      <div class="filters" role="group" aria-label="Filtrer">${[["all", "Tous"], ["on", "En piste"], ["ran", "Ont marché"], ["off", "Pas encore partis"]].map(([v, l]) => `<button data-filter="${v}" aria-pressed="${filter === v}">${l} · ${counts[v]}</button>`).join("")}</div>
    </div>
    <div class="rows">
      <div class="row head lbl"><span></span><span class="pos">#</span><span>Marcheur</span><span></span><span class="r" style="text-align:right">Km</span><span class="r tours">Tours</span><span class="r gen">Général</span><span style="text-align:right">État</span></div>
      ${rows.map(m => `
      <a class="row" href="#coureur-${m.bib}">
        ${starBtn(m)}
        <span class="pos">${m.pos ?? "–"}</span>
        <div class="who"><div class="n">${esc(m.name)}</div><div class="m">Dossard ${m.bib} · ${esc(m.cat)}</div></div>
        <div class="bar"><i style="width:${m.km / maxKm * 100}%"></i></div>
        <span class="km num">${m.laps ? km(m.km) : "–"}${m.laps ? `<small class="lt">${plural(m.laps, "tour")}</small>` : ""}</span>
        <span class="r tours">${m.laps || "–"}</span>
        <span class="r gen">${m.rank ? ord(m.rank) : "–"}</span>
        ${pill(m)}
      </a>`).join("") || `<p class="empty">Aucun marcheur ne correspond.</p>`}
    </div>
    ${total > rows.length ? `<button class="more" id="more">Afficher les ${total} marcheurs</button>` : ""}
  </section>`;
}

/* ---------- équipes de même taille ---------- */
// peerBase : "reg" = taille comptée en inscrits, "act" = en marcheurs ayant fait au moins un tour
const pk = k => peerBase === "act" ? k + "A" : k; // clé dans l'historique : peerRank / peerRankA…
function peerData() {
  const P = LATEST?.peers;
  if (!P) return null;
  if (!("reg" in P)) return peerBase === "reg" ? P : null; // ancien format
  return P[peerBase];
}
const hasActive = () => !!LATEST?.peers?.act;
// Classement parmi les équipes qui ont à peu près autant de marcheurs inscrits (tranche calculée par le relevé),
// au total ou ramené au nombre de marcheurs (plus juste entre une équipe de 32 et une de 54).
function peersCard() {
  if (peerBase === "act" && !hasActive()) peerBase = "reg";
  const P = peerData();
  if (!P?.teams?.length) return "";
  const me = norm(CFG.team.organization), act = peerBase === "act";
  const size = t => act ? t.active : t.runners;
  const all = P.teams.map(t => ({ ...t, per: size(t) ? t.km / size(t) : 0, me: norm(t.name) === me }));
  const byKm = [...all].sort((a, b) => b.laps - a.laps || b.km - a.km);
  const byPer = [...all].sort((a, b) => b.per - a.per || b.km - a.km);
  const list = peerSort === "per" ? byPer : byKm;
  const i = list.findIndex(t => t.me);
  if (i < 0) return "";
  const mine = list[i], n = list.length;
  const posKm = byKm.indexOf(mine) + 1, posPer = byPer.indexOf(mine) + 1;
  // lignes montrées : le top 3 et les 3 équipes de part et d'autre de la nôtre (ou toutes)
  const show = list.map((t, k) => ({ ...t, pos: k + 1 })).filter((t, k) => peersAll || k < 3 || Math.abs(k - i) <= 3);
  let prev = 0;
  const rows = show.map(t => {
    const gap = t.pos - prev > 1 ? `<div class="prow gapline" aria-hidden="true">⋯</div>` : "";
    prev = t.pos;
    return gap + `<div class="prow${t.me ? " me" : ""}">
      <span class="pos">${t.pos}</span>
      <div class="who"><div class="n">${esc(t.name)}</div><div class="m">${act ? `${t.active} ont marché sur ${t.runners}` : `${t.runners} marcheurs`} · ${ordF(t.rank)} au général</div></div>
      <span class="r">${km(t.km)}<small> km</small></span>
      <span class="r tours">${int(t.laps)}<small> t</small></span>
      <span class="r">${km(t.per)}<small> km</small></span>
    </div>`;
  }).join("");
  const above = list[i - 1], below = list[i + 1];
  const lead = !below ? "" : peerSort === "per" ? ` ${km(mine.per - below.per)} km par marcheur d'avance sur <b>${esc(below.name)}</b>.`
    : ` ${plural(mine.laps - below.laps, "tour")} d'avance sur <b>${esc(below.name)}</b>.`;
  const gapTxt = !above ? `<b>En tête des équipes de cette taille !</b>${lead}`
    : peerSort === "per" ? `<b>${km(above.per - mine.per)} km par marcheur</b> derrière <b>${esc(above.name)}</b>`
    : above.laps === mine.laps ? `À égalité de tours avec <b>${esc(above.name)}</b>`
    : `<b>${plural(above.laps - mine.laps, "tour")}</b> derrière <b>${esc(above.name)}</b>`;
  return `
  <section class="card">
    <div class="card-h"><div><h3>Face aux équipes de notre taille</h3><p>${n} équipes de ${P.lo} à ${P.hi} marcheurs ${act ? "ayant marché" : "inscrits"} · ${esc(CFG.team.label)} en compte ${size(mine)}</p></div>
      <div class="segs">
      ${hasActive() ? `<div class="seg" role="group" aria-label="Compter les marcheurs"><button data-peerbase="reg" aria-pressed="${!act}" title="Tous les inscrits, même ceux qui n'ont pas encore marché">Inscrits</button><button data-peerbase="act" aria-pressed="${act}" title="Seulement ceux qui ont fait au moins un tour">Ont marché</button></div>` : ""}
      <div class="seg" role="group" aria-label="Classer par"><button data-peersort="km" aria-pressed="${peerSort === "km"}">Total</button><button data-peersort="per" aria-pressed="${peerSort === "per"}">Par marcheur</button></div></div></div>
    <div class="peer-sum">
      <div><span class="num">${ordF(posKm)}</span><small>au total, sur ${n}</small>${rankMove(s => s.team?.[pk("peerRank")])}</div>
      <div><span class="num">${ordF(posPer)}</span><small>en km par marcheur (${km(mine.per)} km)</small>${rankMove(s => s.team?.[pk("peerRankPer")])}</div>
      <div class="gap"><span class="arrow">${above ? "↑" : "★"}</span><span>${gapTxt}</span></div>
    </div>
    <div class="prows">
      <div class="prow head lbl"><span class="pos">#</span><span>Équipe</span><span class="r">Km</span><span class="r tours">Tours</span><span class="r">Km / marcheur</span></div>
      ${rows}
    </div>
    ${act ? `<p class="muted note">Nombre de marcheurs ayant marché recompté toutes les heures pour les autres équipes${LATEST.peers.scanAt ? ` (dernier comptage à ${hhmm(LATEST.peers.scanAt)})` : ""}, à chaque relevé pour ${esc(CFG.team.label)}.</p>` : ""}
    ${!peersAll && show.length < n ? `<button class="more" id="peersMore">Voir les ${n} équipes</button>` : ""}
  </section>`;
}

/* ---------- objectif d'équipe ---------- */
// Rythme des dernières 24 h (journée et nuit comprises), ou depuis le début du suivi s'il dure moins de 24 h
function pacePerDay() {
  const last = HIST.at(-1), t1 = +new Date(last.t);
  const from = HIST.find(s => +new Date(s.t) >= t1 - 864e5) ?? HIST[0];
  const dt = t1 - new Date(from.t);
  if (dt < 3 * 36e5) return null; // trop court pour être parlant
  return (teamKm(last) - teamKm(from)) / dt * 864e5;
}
function goalCard(T) {
  const goal = CFG.team.goalKm;
  if (!goal) return "";
  const done = T.km, pct = Math.min(100, done / goal * 100), left = Math.max(0, goal - done);
  const end = new Date(CFG.event.end), msLeft = Math.max(0, end - NOW), daysLeft = msLeft / 864e5;
  const pace = pacePerDay();
  const dateFr = t => new Date(t).toLocaleDateString("fr-FR", { weekday: "long", day: "numeric", month: "long", timeZone: TZ });
  let line1, line2 = "";
  if (!left) {
    line1 = `<b>Objectif atteint !</b> ${km(done - goal)} km de plus que prévu.`;
  } else {
    line1 = `Encore <b>${int(Math.ceil(left))} km</b>, soit <b>${int(Math.ceil(left / LAP))} tours</b>${daysLeft > 0 ? `, environ <b>${int(Math.ceil(left / Math.max(daysLeft, 1 / 24)))} km par jour</b> d'ici la fin` : ""}.`;
    if (pace && daysLeft > 0) {
      const eta = +NOW + left / pace * 864e5;
      line2 = eta <= +end
        ? `Au rythme des dernières 24 h (${int(Math.round(pace))} km par jour), objectif atteint vers le <b>${dateFr(eta)}</b>.`
        : `Au rythme des dernières 24 h (${int(Math.round(pace))} km par jour), l'équipe finirait vers <b>${int(Math.round(done + pace * daysLeft))} km</b> : il faut accélérer !`;
    }
  }
  return `
  <section class="card goal">
    <div class="goal-h"><span class="lbl">Objectif de l'équipe</span><span class="num">${int(goal)} <small>km</small></span></div>
    <div class="goal-bar" role="progressbar" aria-valuemin="0" aria-valuemax="${goal}" aria-valuenow="${Math.round(done)}" aria-label="Progression vers l'objectif"><i style="width:${pct}%"></i></div>
    <div class="goal-legend"><span><b>${km(done)} km</b> · ${Math.floor(pct)} %</span><span>${int(goal)} km</span></div>
    <p>${line1}</p>${line2 ? `<p class="muted">${line2}</p>` : ""}
  </section>`;
}

/* ---------- évolution du classement ---------- */
function rankCard() {
  const hasPeers = HIST.some(s => s.team?.[pk("peerRank")]);
  if (!HIST.some(s => s.team?.rank)) return "";
  const v = hasPeers ? rankView : "g";
  const P = HIST.at(-1).team;
  const nb = P[pk("peers")] ?? "", how = peerBase === "act" ? " (comptées en marcheurs ayant marché)" : "";
  const sub = v === "g" ? `Place parmi toutes les équipes, un point par relevé`
    : v === "p" ? `Place parmi les ${nb} équipes de notre taille${how}, au total`
    : `Place parmi les ${nb} équipes de notre taille${how}, en km par marcheur`;
  const move = rankMove(rankGetter(v));
  return `
  <section class="card">
    <div class="card-h"><div><h3>Évolution du classement</h3><p>${sub} ${move}</p></div>
      ${hasPeers ? `<div class="seg" role="group" aria-label="Classement"><button data-rankview="g" aria-pressed="${v === "g"}">Général</button><button data-rankview="p" aria-pressed="${v === "p"}">Même taille</button><button data-rankview="pp" aria-pressed="${v === "pp"}">Par marcheur</button></div>` : ""}</div>
    <div class="chart sm"><canvas id="cRank" role="img" aria-label="Évolution du classement de l'équipe"></canvas></div>
  </section>`;
}

/* ---------- fiche marcheur ---------- */
function runnerView(m) {
  const n = members.length, d = daily(s => runnerKm(s, m.bib)), di = days.indexOf(dayKey(NOW));
  const best = d.reduce((b, v, i) => v != null && v > (b.v ?? 0) ? { v, i } : b, {});
  const other = members.find(x => x.bib !== m.bib && x.laps) ?? members.find(x => x.bib !== m.bib);
  const following = follows.includes(m.bib);
  return `
  <a class="back" href="#equipe">← Toute l'équipe</a>
  <section class="runner-head">
    <h2>${esc(m.name)}</h2>${pill(m)}
  </section>
  <div class="actions">
    <span class="muted">Dossard ${m.bib} · ${esc(m.cat)} · ${m.sex === "F" ? "Femme" : "Homme"}</span>
    <button class="chip" data-star="${m.bib}" aria-pressed="${following}">${following ? "★ Suivi" : "☆ Suivre"}</button>
    ${other ? `<a class="chip" href="#comparer-${m.bib}-${other.bib}">⇄ Comparer</a>` : ""}
  </div>
  <section class="hero">
    <div><div class="bigkm">${km(m.km)}<small>km</small></div><div class="sub">${plural(m.laps, "tour")}${m.lastLap ? ` · dernier tour vu au relevé de ${hhmm(m.lastLap)}` : ""}</div></div>
  </section>
  <section class="stats">
    <div><span class="num">${m.rank ? ord(m.rank) : "–"}</span><small>au général${m.nbTotal ? " sur " + int(m.nbTotal) : ""}</small></div>
    <div><span class="num">${m.rankCat ? (m.sex === "F" ? ordF(m.rankCat) : ord(m.rankCat)) : "–"}</span><small>en catégorie ${esc(m.cat)}${m.nbCat ? " sur " + int(m.nbCat) : ""}</small></div>
    <div><span class="num">${m.rankSex ? (m.sex === "F" ? ordF(m.rankSex) : ord(m.rankSex)) : "–"}</span><small>${m.sex === "F" ? "chez les femmes" : "chez les hommes"}${m.nbSex ? " sur " + int(m.nbSex) : ""}</small></div>
    <div><span class="num">${m.pos ?? "–"}<small style="font-size:15px"> / ${n}</small></span><small>dans l'équipe</small></div>
  </section>
  <section class="kpis">
    <div class="kpi"><span class="lbl">Aujourd'hui</span><span class="num">${di >= 0 && d[di] != null ? km(d[di]) : "–"} <small>km</small></span><p>${di >= 0 ? `${d[di] ? tours(d[di]) + " · " : ""}Jour ${di + 1}` : "hors course"}</p></div>
    <div class="kpi"><span class="lbl">Meilleure journée</span><span class="num">${best.v ? km(best.v) : "–"} <small>km</small></span><p>${best.v ? `${tours(best.v)} · Jour ${best.i + 1}` : "pas encore"}</p></div>
    <div class="kpi"><span class="lbl">Part de l'équipe</span><span class="num">${HIST.at(-1).team.km ? Math.round(m.km / HIST.at(-1).team.km * 100) : 0} <small>%</small></span><p>des km de ${esc(CFG.team.label)}</p></div>
    <div class="kpi"><span class="lbl">Dernier tour</span><span class="num">${m.lastLap ? ago(m.lastLap, true) : "–"}</span><p>${m.lastLap ? "vu au relevé de " + hhmm(m.lastLap) : m.laps ? "avant le début du suivi" : "pas encore de tour"}</p></div>
  </section>
  <section class="grid2 even">
    <div class="card"><div class="card-h"><div><h3>Sa progression</h3><p>Kilomètres cumulés, un point par relevé</p></div></div><div class="chart sm"><canvas id="cRun" role="img" aria-label="Kilomètres cumulés de ${esc(m.name)}"></canvas></div></div>
    <div class="card"><div class="card-h"><div><h3>Par jour</h3><p>Kilomètres parcourus chaque jour</p></div></div><div class="chart sm"><canvas id="cRunDay" role="img" aria-label="Kilomètres par jour de ${esc(m.name)}"></canvas></div></div>
  </section>`;
}

/* ---------- comparer deux marcheurs ---------- */
function compareView(a, b) {
  const opts = sel => [...members].sort((x, y) => x.last.localeCompare(y.last, "fr")).map(m => `<option value="${m.bib}" ${m.bib === sel ? "selected" : ""}>${esc(m.name)}${m.laps ? " · " + km(m.km) + " km" : ""}</option>`).join("");
  const da = daily(s => runnerKm(s, a.bib)), db = daily(s => runnerKm(s, b.bib)), di = days.indexOf(dayKey(NOW));
  const bestOf = d => Math.max(0, ...d.filter(v => v != null));
  const kmT = v => v ? `${km(v)} km<small> · ${lapsOf(v)} t</small>` : "–";
  const rows = [
    ["Kilomètres", a.km, b.km, km, "max"],
    ["Tours", a.laps, b.laps, int, "max"],
    ["Classement général", a.rank, b.rank, v => v ? ord(v) : "–", "min"],
    ["Aujourd'hui", di >= 0 ? da[di] : 0, di >= 0 ? db[di] : 0, kmT, "max"],
    ["Meilleure journée", bestOf(da), bestOf(db), kmT, "max"],
    ["Dernier tour", a.lastLap ? +new Date(a.lastLap) : 0, b.lastLap ? +new Date(b.lastLap) : 0, v => v ? ago(v, true) : "–", "max"],
  ];
  const diff = +(a.km - b.km).toFixed(2), lapsDiff = a.laps - b.laps;
  const [na, nb] = pairNames(a, b);
  const lead = diff === 0 ? `<b>${esc(na)}</b> et <b>${esc(nb)}</b> sont à égalité.`
    : `<b>${esc(diff > 0 ? na : nb)}</b> a <b>${km(Math.abs(diff))} km</b> d'avance (${plural(Math.abs(lapsDiff), "tour")}) sur <b>${esc(diff > 0 ? nb : na)}</b>.`;
  return `
  <section class="card">
    <div class="pickers">
      <select id="pa" style="--a:var(--team)" aria-label="Premier marcheur">${opts(a.bib)}</select>
      <span class="vs">VS</span>
      <select id="pb" style="--a:var(--team-2)" aria-label="Second marcheur">${opts(b.bib)}</select>
    </div>
  </section>
  <p class="verdict">${lead}</p>
  <section class="card"><div class="cmp">${rows.map(([l, x, y, f, mode]) => {
    // "min" : le plus petit gagne (classement), une valeur absente compte comme dernière
    const sx = mode === "min" ? -(x || Infinity) : x ?? 0, sy = mode === "min" ? -(y || Infinity) : y ?? 0;
    const wa = sx > sy, wb = sy > sx;
    return `<div class="cmp-row"><span class="a ${wa ? "win" : ""}">${f(x)}</span><span class="c">${l}</span><span class="b ${wb ? "win" : ""}">${f(y)}</span></div>`;
  }).join("")}</div></section>
  <section class="grid2 even">
    <div class="card"><div class="card-h"><div><h3>Kilomètres cumulés</h3><p>Un point par relevé</p></div></div>
      <div class="legend"><span><i style="background:var(--team)"></i>${esc(a.name)}</span><span><i style="background:var(--team-2)"></i>${esc(b.name)}</span></div>
      <div class="chart sm"><canvas id="cCmp" role="img" aria-label="Kilomètres cumulés des deux marcheurs"></canvas></div></div>
    <div class="card"><div class="card-h"><div><h3>Par jour</h3><p>Kilomètres parcourus chaque jour</p></div></div>
      <div class="legend"><span><i style="background:var(--team)"></i>${esc(na)}</span><span><i style="background:var(--team-2)"></i>${esc(nb)}</span></div>
      <div class="chart sm"><canvas id="cCmpDay" role="img" aria-label="Kilomètres par jour des deux marcheurs"></canvas></div></div>
  </section>
  <p class="muted"><a href="#coureur-${a.bib}">Fiche de ${esc(na)}</a> · <a href="#coureur-${b.bib}">Fiche de ${esc(nb)}</a></p>`;
}

/* ---------- graphiques ---------- */
function timeAxis() {
  const xs = HIST.map(s => +new Date(s.t)), min = xs[0], max = Math.max(xs.at(-1), min + 36e5), span = max - min;
  const step = span <= 8 * 36e5 ? 36e5 : span <= 30 * 36e5 ? 3 * 36e5 : span <= 4 * 864e5 ? 12 * 36e5 : 864e5;
  const fmt = v => span <= 30 * 36e5 ? hhmm(v)
    : step < 864e5 && tzParts(v).hour !== "00" ? hhmm(v)
    : new Date(v).toLocaleDateString("fr-FR", { weekday: "short", day: "numeric", timeZone: TZ });
  return { type: "linear", min, max, grid: { display: false }, border: { color: css("--line") },
    ticks: { color: css("--ink-3"), callback: fmt, maxRotation: 0, autoSkipPadding: 18, font: { family: "Inter", size: 11 } },
    // graduations calées sur les heures pleines / minuits du fuseau de l’événement
    afterBuildTicks: ax => {
      const off = tzOffset(min), ticks = [];
      for (let v = Math.ceil((min + off) / step) * step - off; v <= max; v += step) ticks.push({ value: v });
      ax.ticks = ticks;
    } };
}
function opts(kind, unit = "km") {
  return {
    responsive: true, maintainAspectRatio: false, animation: { duration: 350 },
    interaction: { mode: "index", intersect: false },
    plugins: {
      legend: { display: false },
      tooltip: {
        backgroundColor: css("--surface"), titleColor: css("--ink"), bodyColor: css("--ink-2"), borderColor: css("--line"), borderWidth: 1,
        padding: 10, boxPadding: 4, usePointStyle: true, titleFont: { family: "Inter", weight: "600" }, bodyFont: { family: "Inter" },
        callbacks: {
          title: it => kind === "time" ? new Date(it[0].parsed.x).toLocaleString("fr-FR", { weekday: "short", day: "numeric", hour: "2-digit", minute: "2-digit", timeZone: TZ }) : it[0].label,
          label: c => c.parsed.y == null ? " à venir" : ` ${c.chart.data.datasets.length > 1 ? c.dataset.label + " : " : ""}${km(c.parsed.y)} ${unit}${unit === "km" ? " · " + tours(c.parsed.y) : ""}`,
        },
      },
    },
    scales: {
      x: kind === "time" ? timeAxis() : { grid: { display: false }, border: { color: css("--line") }, ticks: { color: css("--ink-3"), font: { family: "Inter", size: 11 }, maxRotation: 0, autoSkipPadding: 8 } },
      y: { beginAtZero: true, grid: { color: css("--line"), drawTicks: false }, border: { display: false },
        ticks: { color: css("--ink-3"), padding: 8, maxTicksLimit: 5, font: { family: "Inter", size: 11 }, callback: v => int(v) + " " + unit } },
    },
  };
}
function line(label, data, colorVar, fill) {
  const c = css(colorVar);
  return { label, data, borderColor: c, backgroundColor: rgba(c, .12), fill, borderWidth: 2, tension: .25, pointRadius: data.length === 1 ? 4 : 0,
    pointBackgroundColor: c, pointHoverRadius: 5, pointHoverBorderWidth: 2, pointHoverBorderColor: css("--surface"), pointHoverBackgroundColor: c };
}
function bars(label, data, colorVar) {
  return { label, data, backgroundColor: css(colorVar), borderRadius: { topLeft: 4, topRight: 4 }, borderSkipped: "start", barPercentage: .72, categoryPercentage: .86 };
}
const dayLabels = () => days.map((d, i) => `J${i + 1} ${new Date(d + "T12:00:00Z").toLocaleDateString("fr-FR", { weekday: "short", day: "numeric", timeZone: "UTC" })}`);
function chart(id, cfg) { const el = document.getElementById(id); if (el) charts[id] = new Chart(el, cfg); }
function killCharts() { for (const k in charts) { charts[k].destroy(); delete charts[k]; } }

function rankGetter(v) {
  return v === "g" ? s => s.team?.rank : v === "p" ? s => s.team?.[pk("peerRank")] : s => s.team?.[pk("peerRankPer")];
}
function drawRank() {
  const v = HIST.some(s => s.team?.[pk("peerRank")]) ? rankView : "g";
  const get = rankGetter(v);
  const data = HIST.filter(s => get(s)).map(s => ({ x: +new Date(s.t), y: get(s) }));
  if (!data.length) return;
  const o = opts("time", "");
  o.scales.y = { ...o.scales.y, reverse: true, beginAtZero: false, suggestedMin: 1,
    ticks: { ...o.scales.y.ticks, precision: 0, callback: x => Number.isInteger(x) && x > 0 ? ordF(x) : "" } };
  o.plugins.tooltip.callbacks.label = c => ` ${ordF(c.parsed.y)}`;
  chart("cRank", { type: "line", data: { datasets: [{ ...line(CFG.team.label, data, "--team", false), stepped: true }] }, options: o });
}
function drawTeam() {
  drawRank();
  chart("cCum", { type: "line", data: { datasets: [line(CFG.team.label, series(teamKm), "--team", true)] }, options: opts("time") });
  if (rhythm === "h") {
    const h = hourly(teamKm);
    chart("cRhythm", { type: "bar", data: { labels: h.map(p => p.label), datasets: [bars(CFG.team.label, h.map(p => p.y), "--team")] }, options: opts("cat") });
  } else {
    chart("cRhythm", { type: "bar", data: { labels: dayLabels(), datasets: [bars(CFG.team.label, daily(teamKm), "--team")] }, options: opts("cat") });
  }
}
function drawRunner(m) {
  chart("cRun", { type: "line", data: { datasets: [line(m.name, series(s => runnerKm(s, m.bib)), "--team", true)] }, options: opts("time") });
  chart("cRunDay", { type: "bar", data: { labels: dayLabels(), datasets: [bars(m.name, daily(s => runnerKm(s, m.bib)), "--team")] }, options: opts("cat") });
}
function drawCompare(a, b) {
  const [na, nb] = pairNames(a, b);
  chart("cCmp", { type: "line", data: { datasets: [line(na, series(s => runnerKm(s, a.bib)), "--team", false), line(nb, series(s => runnerKm(s, b.bib)), "--team-2", false)] }, options: opts("time") });
  chart("cCmpDay", { type: "bar", data: { labels: dayLabels(), datasets: [bars(na, daily(s => runnerKm(s, a.bib)), "--team"), bars(nb, daily(s => runnerKm(s, b.bib)), "--team-2")] }, options: opts("cat") });
}

/* ---------- routage et rendu ---------- */
function route() {
  const h = decodeURIComponent(location.hash.slice(1));
  let m;
  if ((m = h.match(/^coureur-(\d+)$/)) && byBib[m[1]]) return { view: "coureur-" + m[1], runner: byBib[m[1]] };
  if (h.startsWith("comparer")) {
    const bibs = (h.match(/\d+/g) || []).map(Number).filter(b => byBib[b]);
    const defaults = [...follows, ...members.map(x => x.bib)];
    const a = bibs[0] ?? defaults[0];
    const b = bibs[1] && bibs[1] !== a ? bibs[1] : defaults.find(x => x !== a);
    return { view: "comparer", a: byBib[a], b: byBib[b] };
  }
  return { view: "equipe" };
}
function render(keepScroll) {
  const y = scrollY;
  killCharts();
  const r = route();
  renderHeader(r.view);
  renderFoot();
  if (!HIST.length || !members.length) {
    $("#view").innerHTML = `<p class="empty">Pas encore de relevé. Le premier arrivera au prochain passage du robot (toutes les ${SCRAPE_MIN} min).</p>`;
    return;
  }
  if (r.runner) { $("#view").innerHTML = runnerView(r.runner); drawRunner(r.runner); document.title = `${r.runner.name} · ${CFG.team.label}`; }
  else if (r.view === "comparer" && r.a && r.b) { $("#view").innerHTML = compareView(r.a, r.b); drawCompare(r.a, r.b); document.title = `Comparer · ${CFG.team.label}`; }
  else { $("#view").innerHTML = teamView(); drawTeam(); document.title = `${CFG.team.label} · No Finish Line`; }
  if (keepScroll) scrollTo(0, y);
}

/* ---------- événements ---------- */
addEventListener("hashchange", () => { filter = "all"; query = ""; showAll = false; render(); scrollTo(0, 0); });
document.addEventListener("click", e => {
  const star = e.target.closest("[data-star]");
  if (star) { e.preventDefault(); e.stopPropagation(); toggleFollow(star.dataset.star); return; }
  const f = e.target.closest("[data-filter]"); if (f) { filter = f.dataset.filter; render(true); return; }
  const rh = e.target.closest("[data-rhythm]"); if (rh) { rhythm = rh.dataset.rhythm; render(true); return; }
  const ps = e.target.closest("[data-peersort]"); if (ps) { peerSort = ps.dataset.peersort; render(true); return; }
  if (e.target.id === "peersMore") { peersAll = true; render(true); return; }
  const pb = e.target.closest("[data-peerbase]"); if (pb) { peerBase = pb.dataset.peerbase; render(true); return; }
  const rv = e.target.closest("[data-rankview]"); if (rv) { rankView = rv.dataset.rankview; render(true); return; }
  if (e.target.id === "more") { showAll = true; render(true); }
});
document.addEventListener("change", e => {
  if (e.target.id === "pick" && e.target.value) location.hash = "coureur-" + e.target.value;
  if (e.target.id === "pa" || e.target.id === "pb") location.hash = `comparer-${$("#pa").value}-${$("#pb").value}`;
});
document.addEventListener("input", e => {
  if (e.target.id !== "q") return;
  query = e.target.value;
  const pos = e.target.selectionStart;
  render(true);
  const q = $("#q"); q.focus(); q.setSelectionRange(pos, pos);
});
matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => render(true));
new MutationObserver(() => render(true)).observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });

/* ---------- mises à jour du site lui-même ----------
   Ouvert depuis l'écran d'accueil d'un iPhone, le site n'a ni bouton « recharger » ni « tirer pour actualiser »,
   et iOS reprend la page déjà ouverte au lieu de la recharger : les données se mettent à jour, mais pas le code.
   Donc : rechargement complet si le site a changé (app.js ou index.html), si la page est restée longtemps
   en arrière-plan, ou si on touche « relevé il y a… ». */
let codeTag = null, hiddenAt = 0;
async function siteTag() {
  try {
    const tags = await Promise.all(["app.js", "index.html"].map(async f => {
      const r = await fetch(f + "?v=" + Date.now(), { method: "HEAD", cache: "no-store" });
      return r.ok ? (r.headers.get("etag") || r.headers.get("last-modified") || "") : "";
    }));
    return tags.every(Boolean) ? tags.join("|") : null;
  } catch { return null; }
}
async function hardReload() {
  // remplace les copies en cache avant de recharger (sinon iOS peut resservir l'ancien code)
  try { await Promise.all(["./", "index.html", "app.js"].map(f => fetch(f, { cache: "reload" }))); } catch { /* hors ligne */ }
  location.reload();
}
async function refresh() {
  if (document.activeElement?.id === "q") return; // ne pas interrompre une saisie
  const tag = await siteTag();
  if (tag && codeTag && tag !== codeTag) return hardReload(); // nouvelle version du site
  if (tag) codeTag = tag;
  try { await load(); render(true); } catch (e) { console.error(e); }
}
(async () => {
  try { await load(); render(); }
  catch (e) { console.error(e); $("#view").innerHTML = `<p class="empty">Impossible de charger les données (${esc(e.message)}).</p>`; }
  codeTag = await siteTag();
  setInterval(refresh, REFRESH_MS);
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) { hiddenAt = Date.now(); return; }
    if (hiddenAt && Date.now() - hiddenAt > 30 * 60e3) hardReload(); // revenu après plus de 30 min : on repart de zéro
    else refresh();
  });
  // pageshow : retour sur une page gardée en mémoire par Safari
  addEventListener("pageshow", e => { if (e.persisted) refresh(); });
  $("#updated").addEventListener("click", hardReload);
})();
