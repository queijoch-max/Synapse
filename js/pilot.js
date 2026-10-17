// Pilotage : le tableau de bord (tâches, projets, agenda, bloc-notes, post-its) + la page "Aujourd'hui".
// Tout est stocké dans le navigateur (IndexedDB, magasin "pilot"), comme les notes de Synapse.

import * as DB from "./db.js";

let ui; // utilitaires d'interface fournis par app.js
export function initPilot(helpers) { ui = helpers; }

const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (s = "") => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

// ───────── Dates ─────────

const pad = (n) => String(n).padStart(2, "0");
const iso = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const todayIso = () => iso(new Date());
const parseIso = (s) => { const [y, m, d] = s.split("-").map(Number); return new Date(y, m - 1, d); };
const daysUntil = (s) => Math.round((parseIso(s) - parseIso(todayIso())) / 86400000);
const dateLong = (s) => parseIso(s).toLocaleDateString("fr-FR", { weekday: "long", day: "numeric", month: "long" });
const dateShort = (s) => parseIso(s).toLocaleDateString("fr-FR", { day: "numeric", month: "short" });

function dueLabel(s) {
  const d = daysUntil(s);
  if (d < 0) return `en retard de ${-d} j`;
  if (d === 0) return "aujourd'hui";
  if (d === 1) return "demain";
  return `dans ${d} j`;
}

// ───────── Données ─────────

const STATUS = {
  not_started: { label: "À faire", color: "var(--muted)" },
  in_progress: { label: "En cours", color: "var(--cyan)" },
  completed: { label: "Terminé", color: "var(--green)" },
};

const POSTIT_COLORS = {
  yellow: { label: "Jaune", bg: "#fde68a" },
  orange: { label: "Orange", bg: "#fdba74" },
  red: { label: "Rouge", bg: "#fca5a5" },
  green: { label: "Vert", bg: "#86efac" },
};

const tasks = () => DB.pilot("task").sort((a, b) => (a.status === "done") - (b.status === "done") || a.createdAt - b.createdAt);
const projects = () => DB.pilot("project");
const events = () => DB.pilot("event");

// Rendez-vous + échéances de projets, triés par date.
function agendaItems() {
  const ev = events().map((e) => ({ type: "rdv", date: e.date, time: e.time || "", title: e.title, id: e.id }));
  const dl = projects().filter((p) => p.deadline && p.status !== "completed")
    .map((p) => ({ type: "deadline", date: p.deadline, time: "", title: p.name, id: p.id }));
  return [...ev, ...dl].sort((a, b) => a.date.localeCompare(b.date) || a.time.localeCompare(b.time));
}

// ───────── Météo (Open-Meteo, gratuit, sans clé) ─────────

const WEATHER_KEY = "synapse.weather";
const WEATHER_CODES = {
  0: ["☀️", "Ciel dégagé"], 1: ["🌤️", "Plutôt dégagé"], 2: ["⛅", "Partiellement nuageux"], 3: ["☁️", "Couvert"],
  45: ["🌫️", "Brouillard"], 48: ["🌫️", "Brouillard givrant"],
  51: ["🌦️", "Bruine légère"], 53: ["🌦️", "Bruine"], 55: ["🌦️", "Bruine forte"],
  56: ["🌧️", "Bruine verglaçante légère"], 57: ["🌧️", "Bruine verglaçante"],
  61: ["🌧️", "Pluie légère"], 63: ["🌧️", "Pluie"], 65: ["🌧️", "Pluie forte"],
  66: ["🌧️", "Pluie verglaçante légère"], 67: ["🌧️", "Pluie verglaçante"],
  71: ["🌨️", "Neige légère"], 73: ["🌨️", "Neige"], 75: ["🌨️", "Neige forte"], 77: ["🌨️", "Grains de neige"],
  80: ["🌦️", "Averses légères"], 81: ["🌦️", "Averses"], 82: ["⛈️", "Averses violentes"],
  85: ["🌨️", "Averses de neige légères"], 86: ["🌨️", "Averses de neige"],
  95: ["⛈️", "Orage"], 96: ["⛈️", "Orage avec grêle légère"], 99: ["⛈️", "Orage avec grêle forte"],
};

function weatherTip(code, temp) {
  if (code >= 95) return "Fais gaffe à tes équipements !";
  if ([51, 53, 55, 61, 63, 65, 80, 81, 82].includes(code)) return "Tu as une bonne excuse pour pas sortir !";
  if (temp > 25) return "Pense à refroidir tes équipements";
  if (temp < 15) return "Raison pour rester près de la chaleur de ton ordi !";
  return "Profites-en pour sortir un peu de ta grotte, ta tête a besoin de respirer";
}

function weatherPlace() {
  try { return JSON.parse(localStorage.getItem(WEATHER_KEY) || "null"); } catch { return null; }
}

let weatherCache = null;
async function fetchWeather(place) {
  if (weatherCache && weatherCache.key === `${place.lat},${place.lon}` && Date.now() - weatherCache.at < 30 * 60000) return weatherCache.data;
  const res = await fetch(`https://api.open-meteo.com/v1/forecast?latitude=${place.lat}&longitude=${place.lon}&current_weather=true&timezone=auto`);
  if (!res.ok) throw new Error("météo indisponible");
  const data = (await res.json()).current_weather;
  weatherCache = { key: `${place.lat},${place.lon}`, at: Date.now(), data };
  return data;
}

export function openWeatherSettings(onDone) {
  const cur = weatherPlace();
  ui.modal(`
    <div class="modal-head">🌤️ Ville pour la météo</div>
    <div class="modal-body">
      <div class="field"><label>Chercher une ville</label>
        <input id="wCity" placeholder="ex : Lyon, Annecy, Bruxelles…" value="${esc(cur?.name || "")}" autocomplete="off" />
        <small>Météo fournie gratuitement par Open-Meteo.</small></div>
      <div id="wResults" class="w-results"></div>
      <div class="row"><button class="btn" id="wGeo" type="button">📍 Utiliser ma position</button>
        ${cur ? `<button class="btn danger" id="wClear" type="button">Retirer la météo</button>` : ""}</div>
    </div>
    <div class="modal-foot"><button class="btn" data-close>Fermer</button></div>`);
  const pick = (place) => {
    try { localStorage.setItem(WEATHER_KEY, JSON.stringify(place)); } catch {}
    weatherCache = null;
    ui.closeModal();
    ui.toast(`Météo : ${place.name}`);
    onDone?.();
  };
  let timer;
  $("#wCity").addEventListener("input", (e) => {
    clearTimeout(timer);
    const q = e.target.value.trim();
    if (q.length < 2) { $("#wResults").innerHTML = ""; return; }
    timer = setTimeout(async () => {
      try {
        const r = await fetch(`https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(q)}&count=6&language=fr&format=json`);
        const list = (await r.json()).results || [];
        $("#wResults").innerHTML = list.length ? list.map((c, i) => `<button type="button" class="w-res" data-i="${i}">
          <b>${esc(c.name)}</b> <span>${esc([c.admin1, c.country].filter(Boolean).join(", "))}</span></button>`).join("")
          : `<small style="color:var(--muted)">Aucune ville trouvée</small>`;
        $$(".w-res").forEach((b) => b.addEventListener("click", () => {
          const c = list[+b.dataset.i];
          pick({ name: c.name, lat: c.latitude, lon: c.longitude });
        }));
      } catch {
        $("#wResults").innerHTML = `<small style="color:var(--red)">Recherche impossible (hors ligne ?)</small>`;
      }
    }, 300);
  });
  $("#wGeo").addEventListener("click", () => {
    if (!navigator.geolocation) return ui.toast("Géolocalisation non disponible", true);
    navigator.geolocation.getCurrentPosition(
      (p) => pick({ name: "Ma position", lat: +p.coords.latitude.toFixed(3), lon: +p.coords.longitude.toFixed(3) }),
      () => ui.toast("Position refusée ou indisponible", true),
      { timeout: 10000 }
    );
  });
  $("#wClear")?.addEventListener("click", () => {
    try { localStorage.removeItem(WEATHER_KEY); } catch {}
    ui.closeModal();
    onDone?.();
  });
}

// ═════════════ Aujourd'hui ═════════════

export function renderToday() {
  ui.setCrumbs([{ label: "Tableau de bord" }]);
  $("#topActions").innerHTML = "";
  const now = new Date();
  const hour = now.getHours();
  const hello = hour < 5 ? "Bonne nuit" : hour < 18 ? "Bonjour" : "Bonsoir";
  const today = tasks().filter((t) => t.period === "today");
  const doneToday = today.filter((t) => t.status === "done").length;
  const running = projects().filter((p) => p.status === "in_progress")
    .sort((a, b) => (a.deadline || "9999").localeCompare(b.deadline || "9999"));
  const upcoming = agendaItems().filter((x) => daysUntil(x.date) >= 0 && daysUntil(x.date) <= 7);
  const late = agendaItems().filter((x) => x.type === "deadline" && daysUntil(x.date) < 0);
  const postits = DB.pilot("postit").sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 4);

  $("#view").innerHTML = `
  <div class="home today">
    <div class="hero">
      <div class="fname" style="--fc:var(--amber)"><i></i>${esc(now.toLocaleDateString("fr-FR", { weekday: "long", day: "numeric", month: "long", year: "numeric" }))}</div>
      <h1>${hello} 👋</h1>
      <p>${today.length ? `${doneToday}/${today.length} tâche${today.length > 1 ? "s" : ""} du jour faite${doneToday > 1 ? "s" : ""}` : "Aucune tâche prévue aujourd'hui"}${running.length ? ` · ${running.length} projet${running.length > 1 ? "s" : ""} en cours` : ""}${upcoming.length ? ` · ${upcoming.length} échéance${upcoming.length > 1 ? "s" : ""} ou rendez-vous cette semaine` : ""}.</p>
    </div>

    <div class="t-grid">
      <section class="t-card t-weather" id="tWeather"><div class="t-head"><h3>Météo</h3></div><div class="t-body">…</div></section>

      <section class="t-card">
        <div class="t-head"><h3>✅ Tâches du jour</h3><a href="#/tasks">Toutes →</a></div>
        <form class="t-add" data-add-task="today"><input placeholder="Ajouter une tâche pour aujourd'hui…" /><button class="btn">+</button></form>
        <div class="t-list">${today.length ? today.map(taskRow).join("") : `<div class="conn-empty">Rien de prévu. Profites-en ✨</div>`}</div>
      </section>

      <section class="t-card">
        <div class="t-head"><h3>🚀 Projets en cours</h3><a href="#/projects">Tous →</a></div>
        <div class="t-list">${running.length ? running.map((p) => `
          <button class="t-proj" data-proj="${p.id}">
            <span class="t-proj-name">${esc(p.name)}</span>
            ${p.deadline ? `<span class="t-due ${dueClass(p)}">${dueLabel(p.deadline)}</span>` : ""}
            <span class="bar"><i style="width:${p.progress || 0}%"></i></span><span class="pct">${p.progress || 0}%</span>
          </button>`).join("") : `<div class="conn-empty">Aucun projet en cours. <a href="#/projects">Créer un projet</a></div>`}</div>
        ${late.length ? `<div class="t-alert">⚠️ ${late.length} projet${late.length > 1 ? "s" : ""} en retard</div>` : ""}
      </section>

      <section class="t-card">
        <div class="t-head"><h3>📅 Cette semaine</h3><a href="#/agenda">Agenda →</a></div>
        ${miniCalendar()}
        <div class="t-list">${upcoming.length ? upcoming.map(agendaRow).join("") : `<div class="conn-empty">Rien dans les 7 prochains jours.</div>`}</div>
      </section>

      <section class="t-card">
        <div class="t-head"><h3>🗒️ Post-its</h3><a href="#/memos">Tous →</a></div>
        ${postits.length ? `<div class="postits mini">${postits.map((p) => `<div class="postit" style="--pc:${POSTIT_COLORS[p.color]?.bg || POSTIT_COLORS.yellow.bg}"><div class="postit-text">${esc(p.content)}</div></div>`).join("")}</div>`
          : `<div class="conn-empty">Aucun post-it. <a href="#/memos">En coller un</a></div>`}
      </section>
    </div>
  </div>`;

  bindTaskRows($("#view"), renderToday);
  $$("[data-proj]").forEach((b) => b.addEventListener("click", () => projectModal(DB.getPilot(b.dataset.proj), renderToday)));
  bindAgendaRows($("#view"), renderToday);
  drawWeather();
}

async function drawWeather() {
  const box = $("#tWeather .t-body");
  if (!box) return;
  const place = weatherPlace();
  if (!place) {
    box.innerHTML = `<p class="conn-empty" style="margin:0 0 10px">Choisis ta ville pour voir la météo du jour.</p><button class="btn" id="wSet">🌤️ Choisir ma ville</button>`;
    $("#wSet").addEventListener("click", () => openWeatherSettings(renderToday));
    return;
  }
  try {
    const w = await fetchWeather(place);
    const [emoji, label] = WEATHER_CODES[w.weathercode] || ["🌡️", "Météo"];
    if (!$("#tWeather")) return;
    box.innerHTML = `<div class="w-now"><span class="w-emoji">${emoji}</span><div><div class="w-temp">${Math.round(w.temperature)}°C</div><div class="w-label">${label}</div></div></div>
      <p class="w-tip">${esc(weatherTip(w.weathercode, w.temperature))}</p>
      <button class="w-place" id="wSet">📍 ${esc(place.name)}</button>`;
  } catch {
    box.innerHTML = `<p class="conn-empty">Météo indisponible pour le moment.</p><button class="w-place" id="wSet">📍 ${esc(place.name)}</button>`;
  }
  $("#wSet")?.addEventListener("click", () => openWeatherSettings(renderToday));
}

function miniCalendar() {
  const now = new Date();
  const first = new Date(now.getFullYear(), now.getMonth(), 1);
  const offset = (first.getDay() + 6) % 7;
  const days = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
  const marked = new Set(agendaItems().map((x) => x.date));
  let cells = "";
  for (let i = 0; i < offset; i++) cells += `<span></span>`;
  for (let d = 1; d <= days; d++) {
    const key = iso(new Date(now.getFullYear(), now.getMonth(), d));
    cells += `<span class="${d === now.getDate() ? "today" : ""} ${marked.has(key) ? "has" : ""}">${d}</span>`;
  }
  return `<div class="mini-cal"><div class="mini-cal-title">${now.toLocaleDateString("fr-FR", { month: "long", year: "numeric" })}</div>
    <div class="mini-cal-grid">${["L", "M", "M", "J", "V", "S", "D"].map((x) => `<b>${x}</b>`).join("")}${cells}</div></div>`;
}

// ═════════════ Tâches ═════════════

const HIDE_DONE = "synapse.hideDone";
const hideDone = () => { try { return localStorage.getItem(HIDE_DONE) === "1"; } catch { return false; } };

function taskRow(t) {
  return `<div class="task ${t.status === "done" ? "done" : ""}" data-task="${t.id}">
    <input type="checkbox" ${t.status === "done" ? "checked" : ""} data-toggle title="Fait / pas fait" />
    <button class="task-title" data-edit>${esc(t.title)}${t.description ? `<small>${esc(t.description)}</small>` : ""}</button>
    <button class="icon-btn sm" data-move title="${t.period === "today" ? "Déplacer vers ce mois-ci" : "Faire aujourd'hui"}">${t.period === "today" ? "↓" : "↑"}</button>
    <button class="icon-btn sm" data-del title="Supprimer"><svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6 6 18"/></svg></button>
  </div>`;
}

function bindTaskRows(root, rerender) {
  $$("[data-add-task]", root).forEach((form) => form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const input = $("input", form);
    const title = input.value.trim();
    if (!title) return;
    await DB.savePilot({ kind: "task", title, description: "", status: "todo", period: form.dataset.addTask });
    rerender();
    setTimeout(() => $(`[data-add-task="${form.dataset.addTask}"] input`)?.focus(), 0);
  }));
  $$("[data-task]", root).forEach((row) => {
    const t = DB.getPilot(row.dataset.task);
    $("[data-toggle]", row).addEventListener("change", async (e) => {
      t.status = e.target.checked ? "done" : "todo";
      t.doneAt = e.target.checked ? Date.now() : null;
      await DB.savePilot(t);
      rerender();
    });
    $("[data-edit]", row).addEventListener("click", () => taskModal(t, rerender));
    $("[data-move]", row).addEventListener("click", async () => {
      t.period = t.period === "today" ? "month" : "today";
      await DB.savePilot(t);
      rerender();
    });
    $("[data-del]", row).addEventListener("click", async () => {
      await DB.removePilot(t.id);
      ui.toast("Tâche supprimée");
      rerender();
    });
  });
}

function taskModal(t, rerender) {
  ui.modal(`
    <div class="modal-head">Modifier la tâche</div>
    <div class="modal-body">
      <div class="field"><label>Titre</label><input id="tTitle" value="${esc(t.title)}" /></div>
      <div class="field"><label>Description</label><textarea id="tDesc" rows="3">${esc(t.description || "")}</textarea></div>
      <div class="field"><label>Quand</label><select id="tPeriod"><option value="today" ${t.period === "today" ? "selected" : ""}>Aujourd'hui</option><option value="month" ${t.period === "month" ? "selected" : ""}>Ce mois-ci</option></select></div>
    </div>
    <div class="modal-foot"><button class="btn" data-close>Annuler</button><button class="btn-primary" id="tSave">Enregistrer</button></div>`);
  const save = async () => {
    t.title = $("#tTitle").value.trim() || t.title;
    t.description = $("#tDesc").value.trim();
    t.period = $("#tPeriod").value;
    await DB.savePilot(t);
    ui.closeModal();
    rerender();
  };
  $("#tSave").addEventListener("click", save);
  $("#tTitle").addEventListener("keydown", (e) => { if (e.key === "Enter") save(); });
}

export function renderTasks() {
  ui.setCrumbs([{ label: "Tableau de bord", href: "#/dashboard" }, { label: "Tâches" }]);
  const all = tasks();
  const doneCount = all.filter((t) => t.status === "done").length;
  $("#topActions").innerHTML = `
    <label class="check" style="align-self:center"><input type="checkbox" id="hideDone" ${hideDone() ? "checked" : ""} /> Masquer les terminées</label>
    ${doneCount ? `<button class="btn" id="clearDone">Vider les terminées (${doneCount})</button>` : ""}`;
  const col = (period, title, hint) => {
    const list = all.filter((t) => t.period === period);
    const visible = hideDone() ? list.filter((t) => t.status !== "done") : list;
    const done = list.filter((t) => t.status === "done").length;
    return `<section class="t-card">
      <div class="t-head"><h3>${title}</h3><span class="t-count">${done}/${list.length}</span></div>
      ${list.length ? `<div class="bar" style="margin-bottom:12px"><i style="width:${(done / list.length) * 100}%"></i></div>` : ""}
      <form class="t-add" data-add-task="${period}"><input placeholder="${hint}" /><button class="btn">+</button></form>
      <div class="t-list">${visible.length ? visible.map(taskRow).join("") : `<div class="conn-empty">${list.length ? "Tout est fait 🎉" : "Aucune tâche."}</div>`}</div>
    </section>`;
  };
  $("#view").innerHTML = `
  <div class="home">
    <div class="hero"><h1>✅ Tâches</h1><p>Ce que tu fais aujourd'hui, et ce qui doit être fait ce mois-ci. ↑ ↓ pour passer une tâche d'une liste à l'autre.</p></div>
    <div class="t-cols">${col("today", "Aujourd'hui", "Ajouter une tâche pour aujourd'hui…")}${col("month", "Ce mois-ci", "Ajouter une tâche pour ce mois…")}</div>
  </div>`;
  bindTaskRows($("#view"), renderTasks);
  $("#hideDone").addEventListener("change", (e) => { try { localStorage.setItem(HIDE_DONE, e.target.checked ? "1" : "0"); } catch {} renderTasks(); });
  $("#clearDone")?.addEventListener("click", async () => {
    for (const t of all.filter((x) => x.status === "done")) await DB.removePilot(t.id);
    ui.toast("Tâches terminées supprimées");
    renderTasks();
  });
}

// ═════════════ Projets ═════════════

const PVIEW = "synapse.projectView";
const projectView = () => { try { return localStorage.getItem(PVIEW) || "kanban"; } catch { return "kanban"; } };
let projectSort = { key: "deadline", dir: 1 };

function dueClass(p) {
  if (!p.deadline || p.status === "completed") return "";
  const d = daysUntil(p.deadline);
  return d < 0 ? "late" : d <= 3 ? "soon" : "";
}

function formationBadge(p) {
  const f = p.formationId && DB.getFormation(p.formationId);
  return f ? `<span class="fbadge" style="--fc:${f.color}"><i></i>${esc(f.name)}</span>` : "";
}

function projectCard(p) {
  return `<div class="p-card" draggable="true" data-proj="${p.id}">
    <div class="p-card-top"><b>${esc(p.name)}</b>${formationBadge(p)}</div>
    ${p.description ? `<p>${esc(p.description)}</p>` : ""}
    <div class="p-progress"><span class="bar"><i style="width:${p.progress || 0}%"></i></span><span class="pct">${p.progress || 0}%</span></div>
    ${p.deadline ? `<div class="t-due ${dueClass(p)}">🚩 ${dateShort(p.deadline)} · ${p.status === "completed" ? "terminé" : dueLabel(p.deadline)}</div>` : ""}
  </div>`;
}

export function renderProjects() {
  ui.setCrumbs([{ label: "Tableau de bord", href: "#/dashboard" }, { label: "Projets" }]);
  const view = projectView();
  $("#topActions").innerHTML = `
    <div class="seg"><button data-pview="kanban" class="${view === "kanban" ? "on" : ""}">Kanban</button><button data-pview="table" class="${view === "table" ? "on" : ""}">Tableau</button></div>
    <button class="btn-primary" id="newProject">+ Projet</button>`;
  $$("[data-pview]").forEach((b) => b.addEventListener("click", () => { try { localStorage.setItem(PVIEW, b.dataset.pview); } catch {} renderProjects(); }));
  $("#newProject").addEventListener("click", () => projectModal(null, renderProjects));

  const all = projects();
  if (!all.length) {
    $("#view").innerHTML = `<div class="home"><div class="hero"><h1>🚀 Projets</h1><p>Suis l'avancement de tes projets : statut, progression, échéance.</p></div>
      <div class="empty-state"><b>Aucun projet pour l'instant</b>Crée ton premier projet avec le bouton « + Projet ».</div></div>`;
    return;
  }

  if (view === "kanban") {
    $("#view").innerHTML = `<div class="home wide"><div class="kanban">${Object.entries(STATUS).map(([k, s]) => {
      const list = all.filter((p) => p.status === k).sort((a, b) => (a.deadline || "9999").localeCompare(b.deadline || "9999"));
      return `<section class="k-col" data-col="${k}">
        <div class="k-head"><span class="k-dot" style="background:${s.color}"></span>${s.label}<span class="t-count">${list.length}</span></div>
        <div class="k-list">${list.map(projectCard).join("") || `<div class="k-empty">Glisse un projet ici</div>`}</div>
      </section>`;
    }).join("")}</div></div>`;
    $$(".p-card").forEach((c) => {
      c.addEventListener("click", () => projectModal(DB.getPilot(c.dataset.proj), renderProjects));
      c.addEventListener("dragstart", (e) => { e.dataTransfer.setData("text/x-project", c.dataset.proj); c.classList.add("dragging"); });
      c.addEventListener("dragend", () => c.classList.remove("dragging"));
    });
    $$(".k-col").forEach((col) => {
      col.addEventListener("dragover", (e) => { if ([...e.dataTransfer.types].includes("text/x-project")) { e.preventDefault(); col.classList.add("over"); } });
      col.addEventListener("dragleave", () => col.classList.remove("over"));
      col.addEventListener("drop", async (e) => {
        e.preventDefault();
        e.stopPropagation();
        col.classList.remove("over");
        const p = DB.getPilot(e.dataTransfer.getData("text/x-project"));
        if (!p || p.status === col.dataset.col) return;
        p.status = col.dataset.col;
        if (p.status === "completed") p.progress = 100;
        await DB.savePilot(p);
        renderProjects();
      });
    });
    return;
  }

  // Vue tableau, triable
  const { key, dir } = projectSort;
  const order = { not_started: 0, in_progress: 1, completed: 2 };
  const sorted = [...all].sort((a, b) => {
    const va = key === "status" ? order[a.status] : key === "progress" ? a.progress || 0 : (a[key] || (key === "deadline" ? "9999" : "")).toString().toLowerCase();
    const vb = key === "status" ? order[b.status] : key === "progress" ? b.progress || 0 : (b[key] || (key === "deadline" ? "9999" : "")).toString().toLowerCase();
    return (va > vb ? 1 : va < vb ? -1 : 0) * dir;
  });
  const th = (k, label) => `<th><button data-sort="${k}">${label}${key === k ? (dir > 0 ? " ↑" : " ↓") : ""}</button></th>`;
  $("#view").innerHTML = `<div class="home wide"><div class="p-table-wrap"><table class="p-table">
    <thead><tr>${th("name", "Projet")}${th("status", "Statut")}${th("progress", "Avancement")}${th("deadline", "Échéance")}<th></th></tr></thead>
    <tbody>${sorted.map((p) => `<tr data-row="${p.id}">
      <td><button class="p-name" data-editp>${esc(p.name)}</button>${formationBadge(p)}${p.description ? `<small>${esc(p.description)}</small>` : ""}</td>
      <td><select data-f="status">${Object.entries(STATUS).map(([k, s]) => `<option value="${k}" ${p.status === k ? "selected" : ""}>${s.label}</option>`).join("")}</select></td>
      <td><div class="p-progress"><input type="range" min="0" max="100" step="5" value="${p.progress || 0}" data-f="progress" /><span class="pct">${p.progress || 0}%</span></div></td>
      <td><input type="date" value="${p.deadline || ""}" data-f="deadline" />${p.deadline ? `<span class="t-due ${dueClass(p)}">${p.status === "completed" ? "" : dueLabel(p.deadline)}</span>` : ""}</td>
      <td><button class="icon-btn sm" data-delp title="Supprimer"><svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6 6 18"/></svg></button></td>
    </tr>`).join("")}</tbody></table></div></div>`;
  $$("[data-sort]").forEach((b) => b.addEventListener("click", () => {
    projectSort = { key: b.dataset.sort, dir: projectSort.key === b.dataset.sort ? -projectSort.dir : 1 };
    renderProjects();
  }));
  $$("[data-row]").forEach((row) => {
    const p = DB.getPilot(row.dataset.row);
    $("[data-editp]", row).addEventListener("click", () => projectModal(p, renderProjects));
    $$("[data-f]", row).forEach((input) => {
      if (input.type === "range") input.addEventListener("input", () => { $(".pct", input.parentElement).textContent = `${input.value}%`; });
      input.addEventListener("change", async () => {
        const f = input.dataset.f;
        p[f] = f === "progress" ? +input.value : input.value;
        if (f === "status" && p.status === "completed") p.progress = 100;
        await DB.savePilot(p);
        renderProjects();
      });
    });
    $("[data-delp]", row).addEventListener("click", () => deleteProject(p, renderProjects));
  });
}

function deleteProject(p, rerender) {
  ui.modal(`<div class="modal-head">Supprimer « ${esc(p.name)} » ?</div>
    <div class="modal-body"><p>Cette action est définitive.</p></div>
    <div class="modal-foot"><button class="btn" data-close>Annuler</button><button class="btn danger" id="pDelOk">Supprimer</button></div>`);
  $("#pDelOk").addEventListener("click", async () => {
    await DB.removePilot(p.id);
    ui.closeModal();
    ui.toast("Projet supprimé");
    rerender();
  });
}

function projectModal(p, rerender) {
  const isNew = !p;
  p ||= { kind: "project", name: "", description: "", status: "not_started", progress: 0, deadline: "", formationId: null };
  ui.modal(`
    <div class="modal-head">${isNew ? "Nouveau projet" : "Modifier le projet"}</div>
    <div class="modal-body">
      <div class="field"><label>Nom</label><input id="pName" value="${esc(p.name)}" placeholder="ex : Portfolio, projet fil rouge…" /></div>
      <div class="field"><label>Description</label><textarea id="pDesc" rows="3">${esc(p.description || "")}</textarea></div>
      <div class="row" style="flex-wrap:nowrap">
        <div class="field" style="flex:1"><label>Statut</label><select id="pStatus">${Object.entries(STATUS).map(([k, s]) => `<option value="${k}" ${p.status === k ? "selected" : ""}>${s.label}</option>`).join("")}</select></div>
        <div class="field" style="flex:1"><label>Échéance</label><input type="date" id="pDeadline" value="${p.deadline || ""}" /></div>
      </div>
      <div class="field"><label>Avancement : <b id="pPct">${p.progress || 0}%</b></label><input type="range" id="pProgress" min="0" max="100" step="5" value="${p.progress || 0}" /></div>
      <div class="field"><label>Formation liée (optionnel)</label><select id="pFormation"><option value="">— Aucune —</option>${DB.formations().map((f) => `<option value="${f.id}" ${p.formationId === f.id ? "selected" : ""}>${esc(f.name)}</option>`).join("")}</select></div>
    </div>
    <div class="modal-foot">${isNew ? "" : `<button class="btn danger" id="pDel" style="margin-right:auto">Supprimer</button>`}<button class="btn" data-close>Annuler</button><button class="btn-primary" id="pSave">${isNew ? "Créer" : "Enregistrer"}</button></div>`);
  $("#pProgress").addEventListener("input", (e) => { $("#pPct").textContent = `${e.target.value}%`; });
  $("#pStatus").addEventListener("change", (e) => { if (e.target.value === "completed") { $("#pProgress").value = 100; $("#pPct").textContent = "100%"; } });
  $("#pDel")?.addEventListener("click", () => deleteProject(p, rerender));
  $("#pSave").addEventListener("click", async () => {
    const name = $("#pName").value.trim();
    if (!name) return ui.toast("Donne un nom au projet", true);
    Object.assign(p, {
      name, description: $("#pDesc").value.trim(), status: $("#pStatus").value,
      progress: +$("#pProgress").value, deadline: $("#pDeadline").value, formationId: $("#pFormation").value || null,
    });
    await DB.savePilot(p);
    ui.closeModal();
    ui.toast(isNew ? "Projet créé" : "Projet enregistré");
    rerender();
  });
}

// ═════════════ Agenda ═════════════

let agendaMonth = null; // Date du 1er du mois affiché

function agendaRow(x) {
  const d = daysUntil(x.date);
  return `<button class="a-row" data-agenda="${x.type}:${x.id}">
    <span class="a-date ${d === 0 ? "now" : ""}"><b>${parseIso(x.date).getDate()}</b>${parseIso(x.date).toLocaleDateString("fr-FR", { month: "short" })}</span>
    <span class="a-main"><span class="a-title">${x.type === "deadline" ? "🚩 " : ""}${esc(x.title)}</span>
      <small>${x.type === "deadline" ? "Échéance de projet" : "Rendez-vous"} · ${dateLong(x.date)}${x.time ? ` · ${x.time}` : ""}</small></span>
  </button>`;
}

function bindAgendaRows(root, rerender) {
  $$("[data-agenda]", root).forEach((b) => b.addEventListener("click", (e) => {
    e.stopPropagation();
    const [type, id] = b.dataset.agenda.split(":");
    if (type === "deadline") projectModal(DB.getPilot(id), rerender);
    else eventModal(DB.getPilot(id), null, rerender);
  }));
}

function eventModal(ev, date, rerender) {
  const isNew = !ev;
  ev ||= { kind: "event", title: "", description: "", date: date || todayIso(), time: "" };
  ui.modal(`
    <div class="modal-head">${isNew ? "Nouveau rendez-vous" : "Modifier le rendez-vous"}</div>
    <div class="modal-body">
      <div class="field"><label>Titre</label><input id="eTitle" value="${esc(ev.title)}" placeholder="ex : Entretien, révision groupe, visio formateur…" /></div>
      <div class="row" style="flex-wrap:nowrap">
        <div class="field" style="flex:1"><label>Date</label><input type="date" id="eDate" value="${ev.date}" /></div>
        <div class="field" style="flex:1"><label>Heure (optionnel)</label><input type="time" id="eTime" value="${ev.time || ""}" /></div>
      </div>
      <div class="field"><label>Description</label><textarea id="eDesc" rows="3">${esc(ev.description || "")}</textarea></div>
    </div>
    <div class="modal-foot">${isNew ? "" : `<button class="btn danger" id="eDel" style="margin-right:auto">Supprimer</button>`}<button class="btn" data-close>Annuler</button><button class="btn-primary" id="eSave">${isNew ? "Ajouter" : "Enregistrer"}</button></div>`);
  $("#eDel")?.addEventListener("click", async () => {
    await DB.removePilot(ev.id);
    ui.closeModal();
    ui.toast("Rendez-vous supprimé");
    rerender();
  });
  $("#eSave").addEventListener("click", async () => {
    const title = $("#eTitle").value.trim();
    if (!title || !$("#eDate").value) return ui.toast("Il faut au moins un titre et une date", true);
    Object.assign(ev, { title, date: $("#eDate").value, time: $("#eTime").value, description: $("#eDesc").value.trim() });
    await DB.savePilot(ev);
    ui.closeModal();
    rerender();
  });
}

export function renderAgenda() {
  ui.setCrumbs([{ label: "Tableau de bord", href: "#/dashboard" }, { label: "Agenda" }]);
  const now = new Date();
  agendaMonth ||= new Date(now.getFullYear(), now.getMonth(), 1);
  const y = agendaMonth.getFullYear(), m = agendaMonth.getMonth();
  $("#topActions").innerHTML = `<button class="btn-primary" id="newEvent">+ Rendez-vous</button>`;
  $("#newEvent").addEventListener("click", () => eventModal(null, null, renderAgenda));

  const items = agendaItems();
  const byDay = new Map();
  items.forEach((x) => { if (!byDay.has(x.date)) byDay.set(x.date, []); byDay.get(x.date).push(x); });
  const offset = (new Date(y, m, 1).getDay() + 6) % 7;
  const days = new Date(y, m + 1, 0).getDate();
  let cells = "";
  for (let i = 0; i < offset; i++) cells += `<div class="cal-cell out"></div>`;
  for (let d = 1; d <= days; d++) {
    const key = iso(new Date(y, m, d));
    const list = byDay.get(key) || [];
    cells += `<div class="cal-cell ${key === todayIso() ? "today" : ""}" data-day="${key}">
      <span class="cal-num">${d}</span>
      ${list.slice(0, 3).map((x) => `<button class="cal-chip ${x.type}" data-agenda="${x.type}:${x.id}" title="${esc(x.title)}">${x.time ? `${x.time} ` : x.type === "deadline" ? "🚩 " : ""}${esc(x.title)}</button>`).join("")}
      ${list.length > 3 ? `<span class="cal-more">+${list.length - 3}</span>` : ""}
    </div>`;
  }
  const upcoming = items.filter((x) => daysUntil(x.date) >= 0).slice(0, 15);
  $("#view").innerHTML = `
  <div class="home wide">
    <div class="cal-bar">
      <button class="icon-btn" id="calPrev" aria-label="Mois précédent">‹</button>
      <h2>${agendaMonth.toLocaleDateString("fr-FR", { month: "long", year: "numeric" })}</h2>
      <button class="icon-btn" id="calNext" aria-label="Mois suivant">›</button>
      <button class="btn" id="calToday">Aujourd'hui</button>
      <span class="cal-legend"><i class="rdv"></i>Rendez-vous <i class="deadline"></i>Échéance de projet</span>
    </div>
    <div class="cal">${["Lun", "Mar", "Mer", "Jeu", "Ven", "Sam", "Dim"].map((d) => `<div class="cal-dow">${d}</div>`).join("")}${cells}</div>
    <div class="section-title">À venir</div>
    <div class="t-card"><div class="t-list">${upcoming.length ? upcoming.map(agendaRow).join("") : `<div class="conn-empty">Rien de prévu. Clique sur un jour du calendrier pour ajouter un rendez-vous.</div>`}</div></div>
  </div>`;
  $("#calPrev").addEventListener("click", () => { agendaMonth = new Date(y, m - 1, 1); renderAgenda(); });
  $("#calNext").addEventListener("click", () => { agendaMonth = new Date(y, m + 1, 1); renderAgenda(); });
  $("#calToday").addEventListener("click", () => { agendaMonth = null; renderAgenda(); });
  $$("[data-day]").forEach((c) => c.addEventListener("click", () => eventModal(null, c.dataset.day, renderAgenda)));
  bindAgendaRows($("#view"), renderAgenda);
}

// ═════════════ Bloc-notes & post-its ═════════════

export function renderMemos() {
  ui.setCrumbs([{ label: "Tableau de bord", href: "#/dashboard" }, { label: "Bloc-notes & post-its" }]);
  $("#topActions").innerHTML = "";
  const memos = DB.pilot("memo").sort((a, b) => b.createdAt - a.createdAt);
  const postits = DB.pilot("postit").sort((a, b) => a.createdAt - b.createdAt);
  let color = "yellow";
  $("#view").innerHTML = `
  <div class="home wide">
    <div class="hero"><h1>🗒️ Bloc-notes & post-its</h1><p>Pour les idées en vrac, les choses à ne pas oublier. Les notes de cours, elles, vont dans tes formations.</p></div>
    <div class="memo-layout">
      <section>
        <div class="section-title" style="margin-top:0">Bloc-notes</div>
        <form class="t-card memo-add" id="memoForm"><textarea id="memoText" rows="3" placeholder="Écris une note rapide…"></textarea>
          <div class="row" style="justify-content:flex-end"><button class="btn-primary">Ajouter</button></div></form>
        <div class="memo-list">${memos.map((n) => `<div class="t-card memo" data-memo="${n.id}">
          <div class="memo-text md">${ui.renderMd(n.content)}</div>
          <div class="memo-foot"><small>${new Date(n.createdAt).toLocaleDateString("fr-FR", { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" })}</small>
            <button class="btn" data-medit>Modifier</button><button class="btn danger" data-mdel>Supprimer</button></div>
        </div>`).join("") || `<div class="conn-empty">Aucune note pour l'instant.</div>`}</div>
      </section>
      <section>
        <div class="section-title" style="margin-top:0">Post-its</div>
        <form class="t-card memo-add" id="postitForm">
          <textarea id="postitText" rows="2" placeholder="Nouveau post-it…"></textarea>
          <div class="row" style="justify-content:space-between;align-items:center">
            <div class="color-row">${Object.entries(POSTIT_COLORS).map(([k, c]) => `<button type="button" data-pcolor="${k}" title="${c.label}" style="--c:${c.bg}" class="${k === color ? "on" : ""}"></button>`).join("")}</div>
            <button class="btn-primary">Coller</button>
          </div>
        </form>
        <div class="postits">${postits.map((p) => `<div class="postit" style="--pc:${POSTIT_COLORS[p.color]?.bg || POSTIT_COLORS.yellow.bg}" data-postit="${p.id}">
          <button class="postit-del" data-pdel title="Supprimer">×</button>
          <div class="postit-text" contenteditable="plaintext-only" spellcheck="false" data-ptext>${esc(p.content)}</div>
          <div class="postit-colors">${Object.entries(POSTIT_COLORS).map(([k, c]) => `<button type="button" data-recolor="${k}" title="${c.label}" style="--c:${c.bg}"></button>`).join("")}</div>
        </div>`).join("") || `<div class="conn-empty">Aucun post-it.</div>`}</div>
      </section>
    </div>
  </div>`;

  $("#memoForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const content = $("#memoText").value.trim();
    if (!content) return;
    await DB.savePilot({ kind: "memo", content });
    renderMemos();
  });
  $("#memoText").addEventListener("keydown", (e) => { if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) $("#memoForm").requestSubmit(); });
  $$("[data-memo]").forEach((card) => {
    const n = DB.getPilot(card.dataset.memo);
    $("[data-mdel]", card).addEventListener("click", async () => { await DB.removePilot(n.id); renderMemos(); });
    $("[data-medit]", card).addEventListener("click", () => {
      $(".memo-text", card).outerHTML = `<textarea class="memo-edit" rows="4">${esc(n.content)}</textarea>`;
      const ta = $(".memo-edit", card);
      ta.focus();
      $("[data-medit]", card).textContent = "Enregistrer";
      $("[data-medit]", card).addEventListener("click", async () => {
        n.content = ta.value.trim() || n.content;
        await DB.savePilot(n);
        renderMemos();
      }, { once: true });
    }, { once: true });
  });

  $$("[data-pcolor]").forEach((b) => b.addEventListener("click", () => {
    color = b.dataset.pcolor;
    $$("[data-pcolor]").forEach((x) => x.classList.toggle("on", x === b));
  }));
  $("#postitForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const content = $("#postitText").value.trim();
    if (!content) return;
    await DB.savePilot({ kind: "postit", content, color });
    renderMemos();
  });
  $("#postitText").addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); $("#postitForm").requestSubmit(); } });
  $$("[data-postit]").forEach((el) => {
    const p = DB.getPilot(el.dataset.postit);
    $("[data-pdel]", el).addEventListener("click", async () => { await DB.removePilot(p.id); renderMemos(); });
    $("[data-ptext]", el).addEventListener("blur", async (e) => {
      const v = e.target.innerText.trim();
      if (!v) { await DB.removePilot(p.id); return renderMemos(); }
      if (v !== p.content) { p.content = v; await DB.savePilot(p); }
    });
    $$("[data-recolor]", el).forEach((b) => b.addEventListener("click", async () => {
      p.color = b.dataset.recolor;
      await DB.savePilot(p);
      el.style.setProperty("--pc", POSTIT_COLORS[p.color].bg);
    }));
  });
}
