import * as DB from "./db.js";
import * as AI from "./ai.js";
import { search, norm } from "./search.js";
import { renderGraph } from "./graph.js";
import { runAgent, describeStep } from "./agent.js";
import { extractText } from "./pdf.js";
import { attachFiche, detachFiche, hasFiche, chapKey, looksLikeFiche, isFicheFile, FICHE_ACCEPT, FICHE_DIR } from "./fiche.js";
import { initPilot, renderToday, renderTasks, renderProjects, renderAgenda, renderMemos, openWeatherSettings } from "./pilot.js";

const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (s = "") => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const TYPE_LABEL = { cours: "Cours", notion: "Notion", fiche: "Fiche" };
const dateFr = (t) => new Date(t).toLocaleDateString("fr-FR", { day: "numeric", month: "short", year: "numeric" });

const state = {
  current: null,        // id de la note ouverte
  mode: "preview",      // "edit" | "preview"
  cleanup: null,        // nettoyage de la vue graphe
  ai: new Map(),        // noteId → { history: [], items: [] }
  aiBusy: null,         // AbortController en cours
  agents: new Map(),    // formationId → conversation avec l'assistant
  searchAll: false,     // recherche dans toutes les formations
};

const ag = () => {
  const k = DB.getScope();
  if (!state.agents.has(k)) state.agents.set(k, { conv: {}, items: [], busy: null });
  return state.agents.get(k);
};

// ═════════════ Markdown + liens wiki ═════════════

marked.setOptions({ gfm: true, breaks: true });

function renderMd(md) {
  // Ne transforme pas les [[liens]] qui sont dans du code.
  const parts = md.split(/(```[\s\S]*?```|`[^`\n]*`)/g);
  const withLinks = parts.map((p, i) => (i % 2 ? p : p.replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (_, t, alias) => {
    const exists = !!DB.byTitle(t);
    return `<a class="wikilink${exists ? "" : " missing"}" data-title="${esc(t.trim())}" title="${exists ? "Ouvrir" : "Note inexistante : cliquer pour la créer"}">${esc(alias || t)}</a>`;
  }))).join("");
  return DOMPurify.sanitize(marked.parse(withLinks), { ADD_ATTR: ["data-title", "target"] });
}

function wireLinks(root) {
  $$(".wikilink", root).forEach((a) => a.addEventListener("click", (e) => {
    e.preventDefault();
    openOrCreateByTitle(a.dataset.title);
  }));
}

async function openOrCreateByTitle(title) {
  const found = DB.byTitle(title);
  if (found) return go(`#/note/${found.id}`);
  const cur = DB.get(state.current);
  const parentId = cur ? (cur.type === "cours" ? cur.id : cur.parentId) : null;
  const n = await DB.save(DB.create({ type: "notion", title, parentId }));
  toast(`Notion « ${title} » créée`);
  go(`#/note/${n.id}`, "edit");
}

// ═════════════ Routing ═════════════

function go(hash, mode) {
  if (mode) state.mode = mode;
  if (location.hash === hash) route(); else location.hash = hash;
}

// Pages de l'onglet "Suivi de projet"
const PILOT_ROUTES = {
  "#/dashboard": renderToday,
  "#/tasks": renderTasks,
  "#/projects": renderProjects,
  "#/agenda": renderAgenda,
  "#/memos": renderMemos,
};
const lastHash = { learn: "#/", pilot: "#/dashboard" };

function setSpace(space) {
  document.body.classList.toggle("in-pilot", space === "pilot");
  $$(".space-tab").forEach((b) => b.classList.toggle("on", b.dataset.space === space));
  $$("[data-space-panel]").forEach((p) => { p.hidden = p.dataset.spacePanel !== space; });
}

function renderPilotSummary() {
  const today = DB.pilot("task").filter((t) => t.period === "today");
  const running = DB.pilot("project").filter((p) => p.status === "in_progress");
  const d = new Date();
  const todayIso = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  const next = DB.pilot("event").filter((e) => e.date >= todayIso).sort((a, b) => (a.date + (a.time || "")).localeCompare(b.date + (b.time || "")))[0];
  $("#pilotSummary").innerHTML = `<div class="tree-section"><div class="tree-label">En bref</div>
    <a class="tree-item" href="#/tasks"><span class="dot" style="background:var(--green)"></span><span class="t">Tâches du jour</span><span class="n">${today.filter((t) => t.status === "done").length}/${today.length}</span></a>
    <a class="tree-item" href="#/projects"><span class="dot" style="background:var(--cyan)"></span><span class="t">Projets en cours</span><span class="n">${running.length}</span></a>
    ${next ? `<a class="tree-item" href="#/agenda"><span class="dot" style="background:var(--amber)"></span><span class="t">${esc(next.title)}</span><span class="n">${new Date(next.date + "T00:00").toLocaleDateString("fr-FR", { day: "numeric", month: "short" })}</span></a>` : ""}
  </div>`;
}

function route() {
  state.cleanup?.(); state.cleanup = null;
  const h = location.hash || "#/";
  $("#sidebar").classList.remove("open");
  const page = PILOT_ROUTES[h];
  if (page) {
    lastHash.pilot = h;
    state.current = null;
    setSpace("pilot");
    $(".app").classList.remove("ai-open");
    page();
    $$("[data-pnav]").forEach((b) => b.classList.toggle("active", `#/${b.dataset.pnav}` === h));
    renderPilotSummary();
    return;
  }
  lastHash.learn = h;
  setSpace("learn");
  const m = h.match(/^#\/note\/(.+)$/);
  if (m && DB.get(m[1])) {
    const target = DB.get(m[1]);
    if (target.formationId && target.formationId !== DB.getScope() && DB.getFormation(target.formationId)) setFormation(target.formationId, false);
    if (state.current !== m[1] && !target.content.trim()) state.mode = target.source?.kind === "pdf" ? "preview" : "edit";
    state.current = m[1];
    renderNote();
  } else if (h === "#/graph") {
    state.current = null;
    renderGraphView();
  } else if (h === "#/assistant") {
    state.current = null;
    renderAssistant();
  } else if (h === "#/quiz") {
    state.current = null;
    renderQuiz();
  } else if (h === "#/manage") {
    state.current = null;
    renderManage();
  } else {
    state.current = null;
    renderHome();
  }
  renderTabs();
  renderTree();
  syncAiPanel();
}

// ═════════════ Formations (onglets) ═════════════

const DEFAULT_FORMATIONS = ["Ma formation"];
const FKEY = "synapse.formation";

const curFormation = () => DB.getFormation(DB.getScope());

async function ensureFormations() {
  if (!DB.formations().length) {
    for (const name of DEFAULT_FORMATIONS) await DB.saveFormation(DB.createFormation(name));
  }
  let saved = null;
  try { saved = localStorage.getItem(FKEY); } catch {}
  DB.setScope(DB.getFormation(saved) ? saved : DB.formations()[0].id);
  // Les notes créées avant les onglets vont dans la première formation.
  for (const n of DB.everything()) {
    if (!DB.getFormation(n.formationId)) { n.formationId = DB.formations()[0].id; await DB.save(n); }
  }
}

function setFormation(id, navigate = true) {
  DB.setScope(id);
  try { localStorage.setItem(FKEY, id); } catch {}
  if (!navigate) return;
  // Si on regardait une note, on revient à l'accueil de la formation ; sinon on garde la vue.
  if (/^#\/note\//.test(location.hash)) go("#/"); else route();
}

function renderTabs() {
  const cur = DB.getScope();
  const count = (id) => DB.everything().filter((n) => n.formationId === id).length;
  $("#ftabs").innerHTML = DB.formations().map((f) => `
    <button class="ftab ${f.id === cur ? "on" : ""}" data-ftab="${f.id}" style="--fc:${f.color}" title="${esc(f.name)}">
      <span class="fdot"></span><span>${esc(f.name)}</span><span class="fcount">${count(f.id)}</span>
      <span class="fedit" data-fedit="${f.id}" title="Renommer / couleur / supprimer"><svg viewBox="0 0 24 24"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/></svg></span>
    </button>`).join("") +
    `<button class="ftab-add" id="addFormation" title="Ajouter une formation"><svg viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></svg></button>`;
  $$("[data-ftab]").forEach((b) => b.addEventListener("click", (e) => {
    if (e.target.closest("[data-fedit]")) return editFormation(b.dataset.ftab);
    if (b.dataset.ftab !== DB.getScope()) setFormation(b.dataset.ftab);
  }));
  $$("[data-ftab]").forEach((b) => b.addEventListener("dblclick", () => editFormation(b.dataset.ftab)));
  $("#addFormation").addEventListener("click", () => editFormation(null));
  $("#ftabs .ftab.on")?.scrollIntoView({ block: "nearest", inline: "nearest" });
}

function editFormation(id) {
  const f = id ? DB.getFormation(id) : null;
  const n = id ? DB.everything().filter((x) => x.formationId === id).length : 0;
  const others = DB.formations().filter((x) => x.id !== id);
  let color = f ? f.color : DB.FORMATION_COLORS[DB.formations().length % DB.FORMATION_COLORS.length];
  modal(`
    <div class="modal-head">${f ? "Modifier la formation" : "Nouvelle formation"}</div>
    <div class="modal-body">
      <div class="field"><label>Nom</label><input id="fName" value="${esc(f?.name || "")}" placeholder="ex : Rust, Data Science, Anglais…" maxlength="40" /></div>
      <div class="field"><label>Couleur</label><div class="color-row">${DB.FORMATION_COLORS.map((c) => `<button type="button" data-color="${c}" style="--c:${c}" class="${c === color ? "on" : ""}"></button>`).join("")}</div></div>
      ${f ? `<div class="divider"></div>
      <div class="field"><label>Ordre</label><div class="row"><button class="btn" id="fLeft" type="button">← Déplacer à gauche</button><button class="btn" id="fRight" type="button">Déplacer à droite →</button></div></div>
      <div class="divider"></div>
      <div class="field"><label>Supprimer</label>
        ${others.length ? `${n ? `<small>Cette formation contient ${n} note(s). Que faire d'elles ?</small>
          <select id="fMoveTo">${others.map((o) => `<option value="${o.id}">Les déplacer vers « ${esc(o.name)} »</option>`).join("")}<option value="__delete">Les supprimer définitivement</option></select>` : ""}
          <div class="row"><button class="btn danger" id="fDelete" type="button">Supprimer la formation</button></div>`
        : `<small>C'est ta seule formation : crée-en une autre avant de pouvoir la supprimer.</small>`}
      </div>` : ""}
    </div>
    <div class="modal-foot"><button class="btn" data-close>Annuler</button><button class="btn-primary" id="fSave">${f ? "Enregistrer" : "Créer"}</button></div>`);

  $$("[data-color]").forEach((b) => b.addEventListener("click", () => {
    color = b.dataset.color;
    $$("[data-color]").forEach((x) => x.classList.toggle("on", x === b));
  }));
  const save = async () => {
    const name = $("#fName").value.trim();
    if (!name) return toast("Donne un nom à la formation", true);
    const target = f || DB.createFormation(name);
    target.name = name;
    target.color = color;
    await DB.saveFormation(target);
    closeModal();
    if (f) { renderTabs(); route(); } else { toast(`Formation « ${name} » créée`); setFormation(target.id); go("#/"); }
  };
  $("#fSave").addEventListener("click", save);
  $("#fName").addEventListener("keydown", (e) => { if (e.key === "Enter") save(); });

  const move = async (dir) => {
    const list = DB.formations();
    const i = list.findIndex((x) => x.id === id);
    const j = i + dir;
    if (j < 0 || j >= list.length) return;
    [list[i].order, list[j].order] = [list[j].order, list[i].order];
    await DB.saveFormation(list[i]);
    await DB.saveFormation(list[j]);
    renderTabs();
  };
  $("#fLeft")?.addEventListener("click", () => move(-1));
  $("#fRight")?.addEventListener("click", () => move(1));

  $("#fDelete")?.addEventListener("click", async () => {
    const dest = $("#fMoveTo")?.value;
    if (dest === "__delete" && !confirm(`Supprimer définitivement les ${n} note(s) de « ${f.name} » ?`)) return;
    for (const note of DB.everything().filter((x) => x.formationId === id)) {
      if (dest === "__delete") { await DB.remove(note.id); state.ai.delete(note.id); }
      else { note.formationId = dest; await DB.save(note); }
    }
    await DB.removeFormation(id);
    state.agents.delete(id);
    closeModal();
    toast(`Formation « ${f.name} » supprimée`);
    if (DB.getScope() === id) setFormation(dest && dest !== "__delete" ? dest : DB.formations()[0].id);
    else route();
  });
}

// ═════════════ Sidebar ═════════════

function treeItem(n, count) {
  return `<button class="tree-item ${state.current === n.id ? "active" : ""}" data-open="${n.id}">
    <span class="dot" style="background:var(--c-${n.type})"></span>
    <span class="t">${esc(n.title || "Sans titre")}</span>${count ? `<span class="n">${count}</span>` : ""}
  </button>`;
}

function renderTree() {
  const all = DB.all().sort((a, b) => (a.title || "").localeCompare(b.title || "", "fr"));
  const cours = all.filter((n) => n.type === "cours").sort((a, b) => a.createdAt - b.createdAt);
  const loose = (t) => all.filter((n) => n.type === t && !(n.parentId && DB.get(n.parentId)));
  const openId = state.current && DB.get(state.current);
  const openCours = openId && (openId.type === "cours" ? openId.id : openId.parentId);

  let html = `<div class="tree-section"><div class="tree-label">Cours</div>`;
  if (!cours.length) html += `<div class="tree-empty">Aucun cours pour l'instant</div>`;
  for (const c of cours) {
    const kids = DB.children(c.id);
    html += treeItem(c, kids.length || "");
    if (kids.length && (openCours === c.id)) {
      html += `<div class="tree-children">${kids.map((k) => treeItem(k)).join("")}</div>`;
    }
  }
  html += `</div>`;
  for (const t of ["notion", "fiche"]) {
    const list = loose(t);
    if (!list.length) continue;
    html += `<div class="tree-section"><div class="tree-label">${t === "notion" ? "Notions libres" : "Fiches libres"}</div>${list.map((n) => treeItem(n)).join("")}</div>`;
  }
  $("#tree").innerHTML = html;
  $$(".nav-item[data-view]").forEach((b) => b.classList.toggle("active",
    (b.dataset.view === "home" && (location.hash === "#/" || !location.hash)) || (b.dataset.view === "graph" && location.hash === "#/graph") || (b.dataset.view === "assistant" && location.hash === "#/assistant") || (b.dataset.view === "quiz" && location.hash === "#/quiz") || (b.dataset.view === "manage" && location.hash === "#/manage")));
}

// ═════════════ Accueil ═════════════

function card(n) {
  const parent = n.parentId && DB.get(n.parentId);
  const text = n.content.replace(/[#>*_`\[\]]/g, "").slice(0, 200);
  return `<div class="card t-${n.type}" data-open="${n.id}">
    <span class="badge">${TYPE_LABEL[n.type]}</span>
    <h3>${esc(n.title || "Sans titre")}</h3>
    <p>${esc(text) || "<i>Vide</i>"}</p>
    <div class="meta">${parent ? `<span>↳ ${esc(parent.title)}</span>` : ""}<span>${dateFr(n.updatedAt)}</span></div>
  </div>`;
}

function renderHome() {
  setCrumbs([{ label: "Accueil" }]);
  $("#topActions").innerHTML = "";
  const all = DB.all();
  const count = (t) => all.filter((n) => n.type === t).length;
  const recent = [...all].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 9);
  $("#view").innerHTML = `
  <div class="home">
    <div class="hero">
      ${curFormation() ? `<div class="fname" style="--fc:${curFormation().color}"><i></i>${esc(curFormation().name)}</div>` : ""}
      <h1>Ton <span class="grad">second cerveau</span>.</h1>
      <p>Écris tes cours, relie les notions avec <code style="font-family:var(--font-mono);color:var(--accent)">[[double crochets]]</code>, retrouve tout avec <kbd>Ctrl K</kbd>, et demande à l'IA de décortiquer ce que tu ne comprends pas.</p>
    </div>
    <div class="stats">
      <div class="stat"><div class="v">${count("cours")}</div><div class="l"><i style="background:var(--c-cours)"></i>Cours</div></div>
      <div class="stat"><div class="v">${count("notion")}</div><div class="l"><i style="background:var(--c-notion)"></i>Notions</div></div>
      <div class="stat"><div class="v">${count("fiche")}</div><div class="l"><i style="background:var(--c-fiche)"></i>Fiches</div></div>
      <div class="stat"><div class="v">${DB.edges().length}</div><div class="l"><i style="background:var(--text-2)"></i>Connexions</div></div>
    </div>
    ${AI.hasKey() ? "" : `<div class="empty-state" style="padding:18px;margin-bottom:8px;text-align:left;display:flex;gap:14px;align-items:center;justify-content:space-between;flex-wrap:wrap">
      <span><b style="display:inline;margin:0">✦ Active l'IA</b> — ajoute ta clé Gemini <b style="display:inline;margin:0;color:var(--green)">gratuite</b> pour décortiquer tes cours et transformer tes PDF en fiches.</span>
      <button class="btn-primary" id="homeKey">Ajouter ma clé</button></div>`}
    <div class="section-title">Récemment modifié</div>
    ${recent.length ? `<div class="cards">${recent.map(card).join("")}</div>` : `
      <div class="empty-state"><b>C'est vide ici… pour l'instant.</b>Commence par créer ton premier cours.</div>
      <div class="quick-start">
        <button class="qs" data-new="cours"><span class="badge t-cours">Cours</span><b>Créer un cours</b><small>Une journée, un module : tout ce que tu notes en direct.</small></button>
        <button class="qs" data-new="notion"><span class="badge t-notion">Notion</span><b>Créer une notion</b><small>Un concept précis (ex : Closure, API REST) relié à tes cours.</small></button>
        <button class="qs" id="qsPdf"><span class="badge t-fiche">Fiche</span><b>Déposer un PDF</b><small>L'IA en fait une fiche synthèse rangée avec le reste.</small></button>
      </div>`}
  </div>`;
  $("#homeKey")?.addEventListener("click", openSettings);
  $("#qsPdf")?.addEventListener("click", () => $("#pdfInput").click());
}

// ═════════════ Graphe ═════════════

function renderGraphView() {
  setCrumbs([{ label: "Accueil", href: "#/" }, { label: "Graphe" }]);
  $("#topActions").innerHTML = "";
  if (!DB.all().length) {
    $("#view").innerHTML = `<div class="home"><div class="empty-state"><b>Pas encore de connexions</b>Crée des notes et relie-les avec [[...]] pour voir ton graphe grandir.</div></div>`;
    return;
  }
  state.cleanup = renderGraph($("#view"), (id) => go(`#/note/${id}`));
}

// ═════════════ Assistant (agent) ═════════════

const SUGGESTIONS = [
  ["Résumé de la semaine", "Résume-moi tout ce que j'ai vu ces 7 derniers jours, cours par cours."],
  ["Fiche de révision", "Fais-moi une fiche de révision complète sur mon dernier cours, puis enregistre-la comme fiche."],
  ["Quiz global", "Fais-moi un quiz de 8 questions qui mélange tous mes cours, réponses à la fin."],
  ["Mes points faibles", "Regarde l'ensemble de mes notes : quelles notions sont vides, floues ou mal reliées ? Que dois-je revoir en priorité ?"],
];

function renderAssistant() {
  setCrumbs([{ label: "Accueil", href: "#/" }, { label: "Assistant" }]);
  $("#topActions").innerHTML = ag().items.length
    ? `<button class="btn" id="agentReset"><svg viewBox="0 0 24 24"><path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5"/></svg><span class="lbl">Nouvelle conversation</span></button>` : "";
  $("#view").innerHTML = `
    <div class="agent">
      <div class="agent-thread" id="agentThread"></div>
      <form class="agent-input" id="agentForm">
        <textarea id="agentQ" rows="1" placeholder="Demande un résumé, un quiz, une fiche…"></textarea>
        <button class="btn-primary" id="agentSend">Envoyer</button>
      </form>
    </div>`;
  drawAgent();
  $("#agentReset")?.addEventListener("click", () => {
    ag().busy?.abort();
    state.agents.delete(DB.getScope());
    renderAssistant();
  });
  const q = $("#agentQ");
  q.addEventListener("input", () => { q.style.height = "auto"; q.style.height = Math.min(q.scrollHeight, 200) + "px"; });
  q.addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); $("#agentForm").requestSubmit(); } });
  $("#agentForm").addEventListener("submit", (e) => {
    e.preventDefault();
    const text = q.value.trim();
    if (!text) return;
    q.value = ""; q.style.height = "auto";
    askAgent(text);
  });
  q.focus();
}

function drawAgent() {
  const thread = $("#agentThread");
  if (!thread) return;
  const a = ag();
  $("#agentSend").disabled = !!a.busy;
  if (!a.items.length) {
    thread.innerHTML = `<div class="agent-hello">
      <div class="orb"></div>
      <h2>Ton assistant de révision</h2>
      <p>Il a accès à <b>tous</b> tes cours, notions et fiches : il cherche, lit et croise tes notes pour te faire des résumés, des quiz ou des fiches.</p>
      ${AI.hasKey() ? "" : `<p><button class="btn-primary" id="agentKey">Ajouter ma clé Gemini gratuite</button></p>`}
      <div class="suggestions">${SUGGESTIONS.map(([t, p], i) => `<button data-sugg="${i}"><b>${t}</b>${esc(p)}</button>`).join("")}</div>
    </div>`;
    $("#agentKey")?.addEventListener("click", openSettings);
    $$("[data-sugg]", thread).forEach((b) => b.addEventListener("click", () => askAgent(SUGGESTIONS[+b.dataset.sugg][1])));
    return;
  }
  thread.innerHTML = a.items.map((it) => {
    if (it.role === "user") return `<div class="msg user">${esc(it.text)}</div>`;
    const steps = it.steps.length ? `<div class="steps">${it.steps.map((s) => `<div class="st">${esc(s.label)}${s.openId ? ` · <a data-open="${s.openId}">ouvrir</a>` : ""}</div>`).join("")}</div>` : "";
    if (it.error) return `${steps}<div class="msg err">${esc(it.text)}</div>`;
    return `<div class="msg ai">${steps}${it.done
      ? `<div class="md" style="margin-top:${steps ? 10 : 0}px">${renderMd(it.text)}</div><div class="msg-actions"><button class="btn" data-acopy="${a.items.indexOf(it)}">Copier</button><button class="btn" data-asave="${a.items.indexOf(it)}">⧉ Enregistrer en fiche</button></div>`
      : `<div class="thinking"><i></i><i></i><i></i></div>`}</div>`;
  }).join("");
  wireLinks(thread);
  $$("[data-acopy]", thread).forEach((b) => b.addEventListener("click", () => navigator.clipboard?.writeText(a.items[+b.dataset.acopy].text).then(() => toast("Copié"))));
  $$("[data-asave]", thread).forEach((b) => b.addEventListener("click", async () => {
    const it = a.items[+b.dataset.asave];
    const q = a.items[a.items.indexOf(it) - 1]?.text || "Assistant";
    const m = it.text.match(/^\s*#{1,2}\s+(.+)$/m);
    const f = await DB.save(DB.create({ type: "fiche", title: (m ? m[1] : q.slice(0, 60)).trim(), content: it.text, tags: ["assistant"] }));
    toast("Fiche enregistrée");
    state.mode = "preview";
    go(`#/note/${f.id}`);
  }));
  thread.scrollTop = thread.scrollHeight;
}

async function askAgent(text) {
  const a = ag();
  if (a.busy) return;
  if (!AI.hasKey()) return openSettings();
  a.items.push({ role: "user", text });
  const answer = { role: "ai", text: "", steps: [], done: false };
  a.items.push(answer);
  a.busy = new AbortController();
  if (location.hash === "#/assistant") $("#topActions").innerHTML || renderAssistant();
  drawAgent();
  try {
    answer.text = await runAgent({
      conv: a.conv, userText: text, signal: a.busy.signal,
      onStep: ({ name, args, result }) => {
        answer.steps.push({
          label: describeStep(name, args),
          openId: name === "create_fiche" && result.ok ? result.id : null,
        });
        if (name === "create_fiche") renderTree();
        drawAgent();
      },
    });
  } catch (e) {
    console.error(e);
    answer.error = true;
    answer.text = AI.friendlyError(e);
  } finally {
    answer.done = true;
    a.busy = null;
    drawAgent();
  }
}

// ═════════════ Gérer : sélection multiple ═════════════
// Cocher plusieurs cours / chapitres / notes de la formation active, puis les supprimer ou les déplacer.

const manage = { selected: new Set(), filter: "" };

function renderManage() {
  setCrumbs([{ label: "Accueil", href: "#/" }, { label: "Gérer les notes" }]);
  const f = curFormation();
  const all = DB.all();
  const ids = new Set(all.map((n) => n.id));
  [...manage.selected].forEach((id) => { if (!ids.has(id)) manage.selected.delete(id); });
  const q = norm(manage.filter);
  const match = (n) => !q || norm(n.title).includes(q) || norm(n.source?.name || "").includes(q);
  const cours = all.filter((n) => n.type === "cours").sort((a, b) => a.createdAt - b.createdAt);
  const loose = all.filter((n) => n.type !== "cours" && !(n.parentId && DB.get(n.parentId)?.formationId === f.id));
  const groups = [...cours.map((c) => ({ c, items: DB.children(c.id).filter((n) => n.formationId === f.id) })), { c: null, items: loose }]
    .map((g) => ({ ...g, items: g.items.filter(match), show: !q || (g.c && match(g.c)) || g.items.some(match) }))
    .filter((g) => g.show && (g.c || g.items.length));
  const n = manage.selected.size;

  const row = (x) => `<label class="check m-item">
    <input type="checkbox" data-mid="${x.id}" ${manage.selected.has(x.id) ? "checked" : ""} />
    <span class="dot" style="background:var(--c-${x.type})"></span>
    <span class="m-title">${esc(x.title || "Sans titre")}</span>
    ${x.source?.kind === "pdf" ? `<small>📄${x.fiche ? " 📎" : x.content.trim() ? " ✦" : ""}</small>` : x.fiche ? "<small>📎</small>" : ""}
  </label>`;

  $("#topActions").innerHTML = "";
  $("#view").innerHTML = `
  <div class="home quiz">
    <div class="hero">
      <div class="fname" style="--fc:${f.color}"><i></i>${esc(f.name)}</div>
      <h1>🗂️ Gérer les notes</h1>
      <p>Coche ce que tu veux supprimer ou déplacer. Cocher un cours sélectionne aussi ses chapitres.</p>
    </div>
    <div class="m-bar">
      <input id="mFilter" placeholder="Filtrer par nom…" value="${esc(manage.filter)}" />
      <span class="quiz-sel">${n} sélectionné(s)</span>
      <button class="btn" id="mAll">${n ? "Tout décocher" : "Tout cocher"}</button>
      <button class="btn" id="mMove" ${n ? "" : "disabled"}>↪ Déplacer…</button>
      <button class="btn danger" id="mDel" ${n ? "" : "disabled"}>🗑 Supprimer</button>
    </div>
    <div class="quiz-groups">${groups.map((g) => `
      <div class="quiz-group">
        ${g.c ? `<div class="quiz-group-head">${row(g.c)}<small style="color:var(--muted)">${DB.children(g.c.id).length} élément(s)</small></div>` : `<div class="quiz-group-head"><span>Sans cours</span></div>`}
        <div class="m-children">${g.items.map(row).join("") || `<div class="conn-empty">Vide</div>`}</div>
      </div>`).join("") || `<div class="empty-state"><b>Rien ici</b>${q ? "Aucun résultat pour ce filtre." : "Cette formation est vide."}</div>`}</div>
  </div>`;

  $("#mFilter").addEventListener("input", (e) => {
    manage.filter = e.target.value;
    const pos = e.target.selectionStart;
    renderManage();
    const el = $("#mFilter");
    el.focus();
    el.setSelectionRange(pos, pos);
  });
  $$("[data-mid]").forEach((c) => c.addEventListener("change", () => {
    const x = DB.get(c.dataset.mid);
    const on = c.checked;
    const set = (id) => (on ? manage.selected.add(id) : manage.selected.delete(id));
    set(x.id);
    if (x.type === "cours") DB.children(x.id).forEach((k) => set(k.id));
    renderManage();
  }));
  $("#mAll").addEventListener("click", () => {
    if (manage.selected.size) manage.selected.clear();
    else groups.forEach((g) => { if (g.c) manage.selected.add(g.c.id); g.items.forEach((x) => manage.selected.add(x.id)); });
    renderManage();
  });
  $("#mDel").addEventListener("click", () => {
    const sel = [...manage.selected].map((id) => DB.get(id)).filter(Boolean);
    const pdfs = sel.filter((x) => x.source?.kind === "pdf").length;
    modal(`<div class="modal-head">Supprimer ${sel.length} élément(s) ?</div>
      <div class="modal-body"><p>Cette action est définitive${pdfs ? `, PDF et fiches compris (${pdfs} PDF)` : ""}.</p>
      ${sel.some((x) => x.type === "cours" && DB.children(x.id).some((k) => !manage.selected.has(k.id))) ? `<small style="color:var(--amber)">Les chapitres non cochés des cours supprimés seront gardés, sans cours.</small>` : ""}</div>
      <div class="modal-foot"><button class="btn" data-close>Annuler</button><button class="btn danger" id="mDelOk">Supprimer</button></div>`);
    $("#mDelOk").addEventListener("click", async () => {
      for (const x of sel) {
        if (x.type === "cours") for (const k of DB.children(x.id)) if (!manage.selected.has(k.id)) { k.parentId = null; await DB.save(k); }
        await DB.remove(x.id);
        state.ai.delete(x.id);
      }
      manage.selected.clear();
      closeModal();
      toast(`${sel.length} élément(s) supprimé(s)`);
      renderManage();
      renderTabs();
      renderTree();
    });
  });
  $("#mMove").addEventListener("click", () => {
    const sel = [...manage.selected].map((id) => DB.get(id)).filter(Boolean);
    const hasCours = sel.some((x) => x.type === "cours");
    const options = DB.formations().map((fo) => {
      const cs = DB.everything().filter((x) => x.type === "cours" && x.formationId === fo.id && !manage.selected.has(x.id)).sort((a, b) => a.createdAt - b.createdAt);
      return `<optgroup label="${esc(fo.name)}"><option value="${fo.id}|">${esc(fo.name)} — sans cours</option>
        ${hasCours ? "" : cs.map((c) => `<option value="${fo.id}|${c.id}">${esc(fo.name)} › ${esc(c.title || "Sans titre")}</option>`).join("")}</optgroup>`;
    }).join("");
    modal(`<div class="modal-head">Déplacer ${sel.length} élément(s)</div>
      <div class="modal-body">
        <div class="field"><label>Vers</label><select id="mTarget">${options}</select>
        ${hasCours ? `<small>La sélection contient des cours : ils sont déplacés dans la formation choisie, avec leurs chapitres.</small>` : ""}</div>
      </div>
      <div class="modal-foot"><button class="btn" data-close>Annuler</button><button class="btn-primary" id="mMoveOk">Déplacer</button></div>`);
    $("#mMoveOk").addEventListener("click", async () => {
      const [fid, cid] = $("#mTarget").value.split("|");
      for (const x of sel) {
        x.formationId = fid;
        if (x.type === "cours") {
          x.parentId = null;
          for (const k of DB.children(x.id)) { k.formationId = fid; await DB.save(k); }
        } else if (!(x.parentId && manage.selected.has(x.parentId))) {
          x.parentId = cid || null;
        }
        await DB.save(x);
      }
      manage.selected.clear();
      closeModal();
      toast(`${sel.length} élément(s) déplacé(s) vers « ${DB.getFormation(fid).name}${cid ? ` › ${DB.get(cid).title}` : ""} »`);
      renderManage();
      renderTabs();
      renderTree();
    });
  });
}

// ═════════════ Quiz ═════════════

const quiz = {
  selected: new Set(),  // ids des fiches choisies
  count: 10,
  difficulty: "mix",
  questions: null,      // quiz en cours
  i: 0,
  answers: [],          // index choisi pour chaque question
  busy: null,
};

const quizSources = () => DB.all().filter((n) => n.type !== "cours" || n.content.trim()).filter((n) => n.content.trim() || n.text || n.ficheText);

function renderQuiz() {
  setCrumbs([{ label: "Accueil", href: "#/" }, { label: "Quiz" }]);
  $("#topActions").innerHTML = "";
  // Garde seulement les fiches de la formation active.
  const ids = new Set(DB.all().map((n) => n.id));
  [...quiz.selected].forEach((id) => { if (!ids.has(id)) quiz.selected.delete(id); });
  if (quiz.questions && quiz.questions.formation !== DB.getScope()) quiz.questions = null;
  if (quiz.busy) return drawQuizLoading();
  if (quiz.questions) return quiz.i < quiz.questions.length ? drawQuestion() : drawQuizEnd();
  drawQuizSetup();
}

function drawQuizSetup() {
  const sources = quizSources();
  const cours = DB.all().filter((n) => n.type === "cours").sort((a, b) => a.createdAt - b.createdAt);
  const groups = [
    ...cours.map((c) => ({ c, items: sources.filter((n) => n.parentId === c.id || n.id === c.id) })),
    { c: null, items: sources.filter((n) => n.type !== "cours" && !(n.parentId && DB.get(n.parentId))) },
  ].filter((g) => g.items.length);
  const seen = [...quiz.selected].reduce((s, id) => s + (DB.get(id)?.quizAsked?.length || 0), 0);
  $("#view").innerHTML = `
  <div class="home quiz">
    <div class="hero">
      <div class="fname" style="--fc:${curFormation().color}"><i></i>${esc(curFormation().name)}</div>
      <h1>🎯 Quiz</h1>
      <p>Choisis les fiches à réviser : l'IA te pose des questions à chaque fois différentes, et se souvient de celles déjà posées pour ne jamais les répéter.</p>
    </div>
    ${groups.length ? `
    <div class="section-title">1. Fiches à réviser <span class="quiz-sel">${quiz.selected.size} sélectionnée(s)</span></div>
    <div class="quiz-groups">${groups.map((g, gi) => `
      <div class="quiz-group">
        <div class="quiz-group-head"><span>${g.c ? `<span class="badge t-cours">Cours</span> ${esc(g.c.title || "Sans titre")}` : "Sans cours"}</span>
          <button class="btn" data-qall="${gi}">${g.items.every((n) => quiz.selected.has(n.id)) ? "Tout retirer" : "Tout prendre"}</button></div>
        ${g.items.map((n) => `<label class="check quiz-item"><input type="checkbox" data-qid="${n.id}" ${quiz.selected.has(n.id) ? "checked" : ""} />
          <span class="dot" style="background:var(--c-${n.type})"></span><span>${esc(n.title || "Sans titre")}</span>
          ${n.quizAsked?.length ? `<small>${n.quizAsked.length} question(s) déjà vue(s)</small>` : ""}</label>`).join("")}
      </div>`).join("")}</div>
    <div class="section-title">2. Réglages</div>
    <div class="quiz-opts">
      <div><label>Nombre de questions</label><div class="chips">${[5, 10, 15, 20].map((n) => `<button data-qcount="${n}" class="${quiz.count === n ? "on" : ""}">${n}</button>`).join("")}</div></div>
      <div><label>Difficulté</label><div class="chips">${[["facile", "Facile"], ["moyen", "Moyen"], ["difficile", "Difficile"], ["mix", "Progressive"]].map(([k, v]) => `<button data-qdiff="${k}" class="${quiz.difficulty === k ? "on" : ""}">${v}</button>`).join("")}</div></div>
    </div>
    <div class="row" style="margin-top:22px;align-items:center">
      <button class="btn-ai" id="quizGo" ${quiz.selected.size ? "" : "disabled"}>🎯 Lancer le quiz</button>
      ${seen ? `<small style="color:var(--muted)">${seen} question(s) déjà vue(s) sur ces fiches : elles ne reviendront pas · <a id="quizReset" style="color:var(--cyan);cursor:pointer">remettre à zéro</a></small>` : ""}
    </div>`
    : `<div class="empty-state"><b>Rien à réviser pour l'instant</b>Écris des notes ou importe des PDF dans « ${esc(curFormation().name)} » pour pouvoir te faire interroger.</div>`}
  </div>`;

  $$("[data-qid]").forEach((c) => c.addEventListener("change", () => {
    c.checked ? quiz.selected.add(c.dataset.qid) : quiz.selected.delete(c.dataset.qid);
    drawQuizSetup();
  }));
  $$("[data-qall]").forEach((b) => b.addEventListener("click", () => {
    const items = groups[+b.dataset.qall].items;
    const all = items.every((n) => quiz.selected.has(n.id));
    items.forEach((n) => (all ? quiz.selected.delete(n.id) : quiz.selected.add(n.id)));
    drawQuizSetup();
  }));
  $$("[data-qcount]").forEach((b) => b.addEventListener("click", () => { quiz.count = +b.dataset.qcount; drawQuizSetup(); }));
  $$("[data-qdiff]").forEach((b) => b.addEventListener("click", () => { quiz.difficulty = b.dataset.qdiff; drawQuizSetup(); }));
  $("#quizGo")?.addEventListener("click", startQuiz);
  $("#quizReset")?.addEventListener("click", async () => {
    for (const id of quiz.selected) { const n = DB.get(id); if (n?.quizAsked) { n.quizAsked = []; await DB.save(n); } }
    toast("Historique des questions remis à zéro");
    drawQuizSetup();
  });
}

function drawQuizLoading() {
  $("#view").innerHTML = `<div class="home quiz"><div class="quiz-card" style="text-align:center">
    <div class="thinking" style="justify-content:center"><i></i><i></i><i></i></div>
    <p style="color:var(--text-2)">L'IA prépare ${quiz.count} nouvelles questions…</p>
    <button class="btn" id="quizCancel">Annuler</button></div></div>`;
  $("#quizCancel").addEventListener("click", () => quiz.busy?.abort());
}

async function startQuiz() {
  if (!AI.hasKey()) return openSettings();
  const notes = [...quiz.selected].map((id) => DB.get(id)).filter(Boolean);
  if (!notes.length) return;
  quiz.busy = new AbortController();
  drawQuizLoading();
  try {
    const avoid = notes.flatMap((n) => n.quizAsked || []);
    const questions = await AI.generateQuiz({ notes, count: quiz.count, difficulty: quiz.difficulty, avoid, signal: quiz.busy.signal });
    if (!questions.length) throw new Error("Aucune question nouvelle générée. Réessaie, ou remets l'historique à zéro.");
    // Mémorise les questions sur leur fiche source pour ne plus jamais les reposer.
    for (const q of questions) {
      const src = notes.find((n) => norm(n.title) === norm(q.source)) || notes[0];
      src.quizAsked = [...(src.quizAsked || []), q.question].slice(-200);
      q.noteId = src.id;
    }
    for (const n of notes) await DB.save(n);
    questions.formation = DB.getScope();
    Object.assign(quiz, { questions, i: 0, answers: [] });
  } catch (e) {
    console.error(e);
    if (!quiz.busy?.signal.aborted) toast(AI.friendlyError(e), true);
  } finally {
    quiz.busy = null;
    if (location.hash === "#/quiz") renderQuiz();
  }
}

function drawQuestion() {
  const q = quiz.questions[quiz.i];
  const picked = quiz.answers[quiz.i];
  const answered = picked !== undefined;
  const score = quiz.answers.filter((a, i) => a === quiz.questions[i].answer).length;
  const src = DB.get(q.noteId);
  if (!answered) $("#view").scrollTop = 0;
  $("#view").innerHTML = `
  <div class="home quiz">
    <div class="quiz-top"><span>Question <b>${quiz.i + 1}</b> / ${quiz.questions.length}</span><span>Score : <b>${score}</b></span>
      <button class="btn" id="quizQuit">Arrêter</button></div>
    <div class="progress" style="animation:none"><i style="animation:none;width:${((quiz.i + (answered ? 1 : 0)) / quiz.questions.length) * 100}%"></i></div>
    <div class="quiz-card">
      <div class="quiz-q md">${renderMd(q.question)}</div>
      <div class="quiz-choices">${q.choices.map((c, i) => {
        const cls = !answered ? "" : i === q.answer ? "good" : i === picked ? "bad" : "dim";
        return `<button class="quiz-choice ${cls}" data-choice="${i}" ${answered ? "disabled" : ""}><kbd>${i + 1}</kbd><span class="md">${renderMd(c)}</span></button>`;
      }).join("")}</div>
      ${answered ? `<div class="quiz-expl ${picked === q.answer ? "good" : "bad"}">
        <b>${picked === q.answer ? "✓ Bonne réponse !" : "✗ Raté"}</b>
        <div class="md">${renderMd(q.explanation)}</div>
        ${src ? `<small>Source : <a data-open="${src.id}">${esc(src.title)}</a></small>` : ""}
      </div>
      <div class="row" style="justify-content:flex-end;margin-top:14px"><button class="btn-primary" id="quizNext">${quiz.i + 1 < quiz.questions.length ? "Question suivante →" : "Voir mon score"}</button></div>` : ""}
    </div>
  </div>`;
  $$("[data-choice]").forEach((b) => b.addEventListener("click", () => { quiz.answers[quiz.i] = +b.dataset.choice; drawQuestion(); }));
  $("#quizNext")?.addEventListener("click", () => { quiz.i++; renderQuiz(); });
  $("#quizNext")?.focus();
  $("#quizQuit").addEventListener("click", () => { quiz.questions = null; renderQuiz(); });
}

function drawQuizEnd() {
  const qs = quiz.questions;
  const score = quiz.answers.filter((a, i) => a === qs[i].answer).length;
  const pct = Math.round((score / qs.length) * 100);
  const wrong = qs.map((q, i) => ({ q, a: quiz.answers[i] })).filter((x) => x.a !== x.q.answer);
  $("#view").innerHTML = `
  <div class="home quiz">
    <div class="quiz-card" style="text-align:center">
      <div class="quiz-score" style="--p:${pct}">${pct}%</div>
      <h2 style="font:700 22px var(--font-head);margin:10px 0 4px">${score} / ${qs.length} ${pct >= 80 ? "🔥 Excellent !" : pct >= 50 ? "👍 Pas mal !" : "💪 On révise et on recommence"}</h2>
      <p style="color:var(--muted);margin:0 0 18px">Le prochain quiz aura de nouvelles questions.</p>
      <div class="row" style="justify-content:center">
        <button class="btn-ai" id="quizAgain">🔁 Nouveau quiz sur ces fiches</button>
        <button class="btn" id="quizChange">Changer de fiches</button>
      </div>
    </div>
    ${wrong.length ? `<div class="section-title">À revoir (${wrong.length})</div>
    <div class="quiz-review">${wrong.map(({ q, a }) => `<div class="quiz-card">
      <div class="md"><b>${renderMd(q.question)}</b></div>
      <p style="margin:8px 0 4px;color:var(--red)">Ta réponse : ${esc(q.choices[a] ?? "—")}</p>
      <p style="margin:0 0 8px;color:var(--green)">Bonne réponse : ${esc(q.choices[q.answer])}</p>
      <div class="md" style="font-size:14px">${renderMd(q.explanation)}</div>
      ${DB.get(q.noteId) ? `<small style="color:var(--muted)">Source : <a data-open="${q.noteId}" style="color:var(--cyan);cursor:pointer">${esc(DB.get(q.noteId).title)}</a></small>` : ""}
    </div>`).join("")}</div>` : ""}
  </div>`;
  $("#quizAgain").addEventListener("click", () => { quiz.questions = null; startQuiz(); });
  $("#quizChange").addEventListener("click", () => { quiz.questions = null; renderQuiz(); });
}

// ═════════════ Note ═════════════

function setCrumbs(items) {
  $("#crumbs").innerHTML = items.map((it, i) =>
    (i ? `<span class="sep">/</span>` : "") +
    (it.href ? `<a href="${it.href}">${esc(it.label)}</a>` : `<span class="cur">${esc(it.label)}</span>`)
  ).join("");
}

let saveTimer;
function scheduleSave(note, full = false) {
  $("#saveState").textContent = "Enregistrement…";
  $("#saveState").classList.add("saving");
  clearTimeout(saveTimer);
  saveTimer = setTimeout(async () => {
    await DB.save(note);
    const s = $("#saveState");
    if (s) { s.textContent = "Enregistré"; s.classList.remove("saving"); }
    if (full) renderTree();
  }, 400);
}

function renderNote() {
  const note = DB.get(state.current);
  const parent = note.parentId && DB.get(note.parentId);
  setCrumbs([
    { label: "Accueil", href: "#/" },
    ...(parent ? [{ label: parent.title || "Sans titre", href: `#/note/${parent.id}` }] : []),
    { label: note.title || "Sans titre" },
  ]);
  $("#topActions").innerHTML = `
    <button class="btn" id="ficheBtn" title="Importer ma propre fiche synthèse (Markdown, Word, PDF…)">📎<span class="lbl">Ma fiche</span></button>
    <button class="btn" id="quizNote" title="Quiz sur cette fiche">🎯<span class="lbl">Quiz</span></button>
    <button class="btn-ai" id="aiOpen"><span>✦</span><span class="lbl">Décortiquer</span></button>
    <button class="icon-btn" id="exportMd" title="Télécharger en Markdown"><svg viewBox="0 0 24 24"><path d="M12 3v12m-5-5 5 5 5-5M5 21h14"/></svg></button>
    <button class="icon-btn" id="delNote" title="Supprimer"><svg viewBox="0 0 24 24"><path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/></svg></button>`;

  const cours = DB.all().filter((n) => n.type === "cours" && n.id !== note.id).sort((a, b) => a.createdAt - b.createdAt);
  const missing = DB.outgoingTitles(note).filter((t) => !DB.byTitle(t));

  $("#view").innerHTML = `
  <article class="note">
    <div class="note-head">
      <div class="note-meta">
        <span class="badge t-${note.type}">${TYPE_LABEL[note.type]}</span>
        <span>Créé le ${dateFr(note.createdAt)}</span><span>·</span>
        <span class="save-state" id="saveState">Enregistré</span>
      </div>
      <input class="note-title" id="title" value="${esc(note.title)}" placeholder="Titre de la ${TYPE_LABEL[note.type].toLowerCase()}…" />
    </div>
    <div class="props">
      <label>Type</label>
      <select id="ptype">${Object.entries(TYPE_LABEL).map(([k, v]) => `<option value="${k}" ${k === note.type ? "selected" : ""}>${v}</option>`).join("")}</select>
      ${note.type !== "cours" ? `<label>Cours</label>
      <select id="pparent"><option value="">— Aucun —</option>${cours.map((c) => `<option value="${c.id}" ${c.id === note.parentId ? "selected" : ""}>${esc(c.title || "Sans titre")}</option>`).join("")}</select>` : ""}
      <label>Formation</label>
      <select id="pformation">${DB.formations().map((f) => `<option value="${f.id}" ${f.id === note.formationId ? "selected" : ""}>${esc(f.name)}</option>`).join("")}</select>
      <label>Tags</label>
      <div class="tags" id="tags">${note.tags.map((t, i) => `<span class="tag">#${esc(t)}<button data-rmtag="${i}">×</button></span>`).join("")}
        <input id="tagInput" placeholder="+ ajouter un tag" style="width:140px" /></div>
    </div>
    ${note.source?.kind === "pdf" ? `<div class="pdf-box">
      <div class="pdf-bar">
        <span class="name">📄 <b>${esc(note.source.name)}</b>${note.source.pages ? ` · ${note.source.pages} pages` : ""}</span>
        <button class="btn" id="pdfView">Afficher le PDF</button>
        ${note.text ? `<button class="btn" id="pdfTextBtn">Texte extrait</button>` : ""}
        <button class="${hasFiche(note) ? "btn" : "btn-ai"}" id="pdfGen">✦ ${note.fiche ? "Fiche IA" : note.content.trim() ? "Régénérer la fiche" : "Générer la fiche"}</button>
      </div>
      <div id="pdfSlot"></div>
    </div>` : note.source ? `<div class="source-box">📄 Importé depuis <b style="color:var(--text-2)">${esc(note.source.path || note.source.name)}</b></div>` : ""}
    ${note.fiche ? `<div class="fiche-box"><span>📎 Ma fiche : <b>${esc(note.fiche.name)}</b></span>
      ${note.fiche.kind === "pdf" && note.content.trim() ? `<button class="btn" id="ficheView">Afficher</button>` : ""}
      <button class="btn" id="ficheReplace">Remplacer</button><button class="btn danger" id="ficheRemove">Retirer</button></div>` : ""}
    ${note.type === "cours" && pendingFiches(note.id).length ? `<div class="row" style="margin-top:14px"><button class="btn-ai" id="genModule">✦ Générer les fiches IA des ${pendingFiches(note.id).length} chapitre(s) restants</button></div>` : ""}
    <div class="editor-tabs">
      <button data-mode="edit" class="${state.mode === "edit" ? "on" : ""}">✎ Écrire</button>
      <button data-mode="preview" class="${state.mode === "preview" ? "on" : ""}">◉ Lire</button>
      <span class="hint">Markdown · <code>[[Notion]]</code> pour relier · <kbd>Ctrl E</kbd> bascule</span>
    </div>
    <div id="body"></div>
    ${missing.length ? `<div class="row" style="margin-top:16px"><button class="btn" id="createMissing">＋ ${missing.length > 1 ? `Créer les ${missing.length} notions manquantes` : "Créer la notion manquante"}</button></div>` : ""}
    <div class="connections">${connections(note)}</div>
  </article>`;

  renderBody(note);

  $("#title").addEventListener("input", (e) => {
    note.title = e.target.value;
    scheduleSave(note, true);
  });
  $("#title").addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); setMode("edit"); $("#editor")?.focus(); } });
  $("#ptype").addEventListener("change", async (e) => {
    note.type = e.target.value;
    if (note.type === "cours") note.parentId = null;
    await DB.save(note); route();
  });
  $("#pformation").addEventListener("change", async (e) => {
    const fid = e.target.value;
    note.formationId = fid;
    // Un cours emmène ses notes avec lui ; une note quitte son cours s'il reste dans l'autre formation.
    if (note.type === "cours") for (const k of DB.children(note.id)) { k.formationId = fid; await DB.save(k); }
    else if (note.parentId && DB.get(note.parentId)?.formationId !== fid) note.parentId = null;
    await DB.save(note);
    toast(`Déplacé vers « ${DB.getFormation(fid).name} »`);
    setFormation(fid, false);
    route();
  });
  $("#pparent")?.addEventListener("change", async (e) => {
    note.parentId = e.target.value || null;
    await DB.save(note); route();
  });
  $("#tagInput").addEventListener("keydown", async (e) => {
    if (e.key === "Enter" || e.key === ",") {
      e.preventDefault();
      const v = e.target.value.trim().replace(/^#/, "");
      if (v && !note.tags.includes(v)) { note.tags.push(v); await DB.save(note); renderNote(); $("#tagInput").focus(); }
    }
  });
  $$("[data-rmtag]").forEach((b) => b.addEventListener("click", async () => {
    note.tags.splice(+b.dataset.rmtag, 1); await DB.save(note); renderNote();
  }));
  $$(".editor-tabs [data-mode]").forEach((b) => b.addEventListener("click", () => setMode(b.dataset.mode)));
  $("#createMissing")?.addEventListener("click", async () => {
    const parentId = note.type === "cours" ? note.id : note.parentId;
    for (const t of missing) await DB.save(DB.create({ type: "notion", title: t, parentId }));
    toast(`${missing.length} notion(s) créée(s)`);
    route();
  });
  $("#aiOpen").addEventListener("click", () => toggleAi(true));
  $("#delNote").addEventListener("click", () => confirmDelete(note));
  $("#quizNote").addEventListener("click", () => {
    quiz.selected = new Set(note.type === "cours" ? [note.id, ...DB.children(note.id).filter((n) => n.content.trim() || n.text || n.ficheText).map((n) => n.id)] : [note.id]);
    if (!note.content.trim() && !note.text && !note.ficheText && note.type !== "cours") return toast("Cette note est vide : rien à demander", true);
    quiz.questions = null;
    go("#/quiz");
  });
  const pickFiche = async () => {
    if (hasFiche(note) && !confirm("Cette page a déjà une fiche. La remplacer par ton fichier ?")) return;
    const file = await pickFile(FICHE_ACCEPT);
    if (!file) return;
    try {
      await attachFiche(note, file);
      toast("Fiche importée 📎");
      state.mode = "preview";
      route();
    } catch (e) {
      console.error(e);
      toast(`Impossible de lire ${file.name}`, true);
    }
  };
  $("#ficheBtn").addEventListener("click", pickFiche);
  $("#ficheReplace")?.addEventListener("click", pickFiche);
  $("#ficheRemove")?.addEventListener("click", async () => {
    if (!confirm(`Retirer la fiche « ${note.fiche.name} » de cette page ?`)) return;
    await detachFiche(note);
    toast("Fiche retirée");
    route();
  });
  $("#ficheView")?.addEventListener("click", () => showFichePdf(note, $("#body")));
  $("[data-select-kids]")?.addEventListener("click", () => {
    manage.selected = new Set(DB.children(note.id).map((k) => k.id));
    manage.filter = "";
    go("#/manage");
  });
  $("#genModule")?.addEventListener("click", () => enqueueFiches(pendingFiches(note.id).map((n) => n.id)));
  $("#pdfGen")?.addEventListener("click", () => {
    if (queue.current === note.id || queue.ids.includes(note.id)) return toast("Déjà en cours de génération");
    enqueueFiches([note.id]);
  });
  let pdfUrl;
  $("#pdfView")?.addEventListener("click", async () => {
    const slot = $("#pdfSlot");
    if (slot.dataset.v === "pdf") { slot.innerHTML = ""; slot.dataset.v = ""; $("#pdfView").textContent = "Afficher le PDF"; return; }
    const blob = await DB.getFile(note.id);
    if (!blob) return toast("Le PDF original n'est pas sur cet appareil (importé depuis une sauvegarde)", true);
    if (pdfUrl) URL.revokeObjectURL(pdfUrl);
    pdfUrl = URL.createObjectURL(new Blob([blob], { type: "application/pdf" }));
    slot.innerHTML = `<iframe class="pdf-frame" src="${pdfUrl}" title="${esc(note.source.name)}"></iframe>`;
    slot.dataset.v = "pdf";
    $("#pdfView").textContent = "Masquer le PDF";
  });
  $("#pdfTextBtn")?.addEventListener("click", () => {
    const slot = $("#pdfSlot");
    if (slot.dataset.v === "text") { slot.innerHTML = ""; slot.dataset.v = ""; return; }
    slot.innerHTML = `<div class="pdf-text">${esc(note.text)}</div>`;
    slot.dataset.v = "text";
    $("#pdfView").textContent = "Afficher le PDF";
  });
  $("#exportMd").addEventListener("click", () => download(`${slug(note.title)}.md`, `# ${note.title}\n\n${note.content}`, "text/markdown"));
}

function connections(note) {
  const kids = DB.children(note.id);
  const out = DB.outgoing(note);
  const back = DB.backlinks(note);
  const list = (arr, empty) => arr.length ? `<div class="conn-list">${arr.map((n) => treeItem(n)).join("")}</div>` : `<div class="conn-empty">${empty}</div>`;
  let html = "";
  if (note.type === "cours") html += `<div class="conn-box" style="grid-column:1/-1"><h4 style="display:flex;justify-content:space-between">Dans ce cours · ${kids.length}${kids.length ? `<a data-select-kids="${note.id}" style="color:var(--cyan);cursor:pointer;text-transform:none;letter-spacing:0;font-weight:500">Sélectionner…</a>` : ""}</h4>${list(kids, "Ajoute des notions ou fiches à ce cours avec les boutons + de la barre latérale.")}</div>`;
  html += `<div class="conn-box"><h4>Liens sortants · ${out.length}</h4>${list(out, "Écris [[Nom]] pour relier une autre note.")}</div>`;
  html += `<div class="conn-box"><h4>Mentionnée dans · ${back.length}</h4>${list(back, "Aucune note ne pointe encore ici.")}</div>`;
  return html;
}

async function setMode(mode) {
  state.mode = mode;
  const note = DB.get(state.current);
  if (mode === "preview") {
    // Enregistre tout de suite et redessine la page pour mettre à jour les liens.
    clearTimeout(saveTimer);
    await DB.save(note);
    renderNote();
    renderTree();
    return;
  }
  $$(".editor-tabs [data-mode]").forEach((b) => b.classList.toggle("on", b.dataset.mode === mode));
  renderBody(note);
  $("#editor")?.focus();
}

function renderBody(note) {
  const body = $("#body");
  if (state.mode === "edit") {
    body.innerHTML = `<textarea class="editor" id="editor" spellcheck="true" placeholder="Écris ton cours ici…

## Titre de section
- une idée
- un lien vers une [[Notion]]

\`\`\`js
console.log('du code');
\`\`\`"></textarea><div id="linkSuggest"></div>`;
    const ed = $("#editor");
    ed.value = note.content;
    ed.style.height = Math.max(ed.scrollHeight + 4, window.innerHeight * 0.55) + "px";
    ed.addEventListener("input", () => {
      note.content = ed.value;
      scheduleSave(note, true);
      if (ed.scrollHeight > ed.clientHeight) ed.style.height = ed.scrollHeight + 4 + "px";
      suggestLinks(ed);
    });
    ed.addEventListener("keydown", (e) => {
      if (handleSuggestKeys(e, ed)) return;
      if (e.key === "Tab") {
        e.preventDefault();
        ed.setRangeText("  ", ed.selectionStart, ed.selectionEnd, "end");
        ed.dispatchEvent(new Event("input"));
      }
    });
    ed.addEventListener("blur", () => setTimeout(() => { const b = $("#linkSuggest"); if (b) b.innerHTML = ""; }, 150));
  } else {
    if (!note.content.trim() && note.fiche?.kind === "pdf") return showFichePdf(note, body);
    body.innerHTML = note.content.trim()
      ? `<div class="md">${renderMd(note.content)}</div>`
      : note.source?.kind === "pdf"
        ? `<div class="empty-state"><b>Fiche synthèse pas encore faite</b>Le texte du PDF est déjà cherchable et l'assistant peut le lire. Importe ta propre fiche avec <b style="display:inline">📎 Ma fiche</b>, fais-la générer avec « ✦ Générer la fiche », ou <a style="color:var(--cyan);cursor:pointer" id="emptyBody">écris-la toi-même</a>.</div>`
        : `<div class="empty-state" style="cursor:pointer" id="emptyBody"><b>Page vide</b>Clique pour commencer à écrire.</div>`;
    wireLinks(body);
    $("#emptyBody")?.addEventListener("click", () => setMode("edit"));
  }
}

async function showFichePdf(note, el) {
  const blob = await DB.getFile(`${note.id}:fiche`);
  if (!blob) {
    el.innerHTML = `<div class="empty-state"><b>Ta fiche PDF n'est pas sur cet appareil</b>Réimporte-la avec 📎 Ma fiche.</div>`;
    return;
  }
  const url = URL.createObjectURL(new Blob([blob], { type: "application/pdf" }));
  el.innerHTML = `<iframe class="pdf-frame" style="border-radius:var(--radius);border:1px solid var(--border-soft)" src="${url}" title="${esc(note.fiche.name)}"></iframe>`;
}

function pickFile(accept) {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = accept;
    input.addEventListener("change", () => resolve(input.files[0] || null));
    input.click();
  });
}

// Autocomplétion des [[liens]] pendant la frappe
let sugg = { items: [], sel: 0, start: 0 };
function suggestLinks(ed) {
  const box = $("#linkSuggest");
  const before = ed.value.slice(0, ed.selectionStart);
  const m = before.match(/\[\[([^\]\n]{0,60})$/);
  if (!m) { box.innerHTML = ""; sugg.items = []; return; }
  const q = norm(m[1]);
  const cur = DB.get(state.current);
  sugg.items = DB.all().filter((n) => n.id !== cur.id && n.title && norm(n.title).includes(q)).slice(0, 7);
  sugg.start = ed.selectionStart - m[1].length;
  sugg.sel = 0;
  sugg.query = m[1];
  drawSuggest(ed);
}
function drawSuggest(ed) {
  const box = $("#linkSuggest");
  const create = sugg.query?.trim() && !DB.byTitle(sugg.query) ? [{ id: "__new", title: sugg.query.trim(), type: "notion", isNew: true }] : [];
  const items = [...sugg.items, ...create];
  sugg.all = items;
  if (!items.length) { box.innerHTML = ""; return; }
  box.innerHTML = `<div class="palette" style="max-width:420px;margin-top:6px"><div class="palette-results" style="max-height:260px">${items.map((n, i) =>
    `<div class="result t-${n.type} ${i === sugg.sel ? "sel" : ""}" data-i="${i}"><span class="dot"></span><div><div class="rt">${n.isNew ? "Nouveau lien : " : ""}${esc(n.title)}</div></div></div>`).join("")}</div></div>`;
  $$(".result", box).forEach((r) => r.addEventListener("mousedown", (e) => { e.preventDefault(); pickSuggest(ed, +r.dataset.i); }));
}
function pickSuggest(ed, i) {
  const n = sugg.all[i];
  ed.setRangeText(`${n.title}]]`, sugg.start, ed.selectionStart, "end");
  sugg.items = []; sugg.all = [];
  $("#linkSuggest").innerHTML = "";
  ed.dispatchEvent(new Event("input"));
}
function handleSuggestKeys(e, ed) {
  if (!sugg.all?.length || !$("#linkSuggest").innerHTML) return false;
  if (e.key === "ArrowDown") { sugg.sel = (sugg.sel + 1) % sugg.all.length; drawSuggest(ed); }
  else if (e.key === "ArrowUp") { sugg.sel = (sugg.sel - 1 + sugg.all.length) % sugg.all.length; drawSuggest(ed); }
  else if (e.key === "Enter" || e.key === "Tab") pickSuggest(ed, sugg.sel);
  else if (e.key === "Escape") $("#linkSuggest").innerHTML = "";
  else return false;
  e.preventDefault();
  return true;
}

// ═════════════ Création / suppression ═════════════

async function newNote(type) {
  const cur = DB.get(state.current);
  const parentId = type === "cours" ? null : cur ? (cur.type === "cours" ? cur.id : cur.parentId) : null;
  const n = await DB.save(DB.create({ type, parentId }));
  state.mode = "edit";
  go(`#/note/${n.id}`);
  setTimeout(() => $("#title")?.focus(), 30);
}

function confirmDelete(note) {
  const kids = DB.children(note.id);
  modal(`
    <div class="modal-head">Supprimer « ${esc(note.title || "Sans titre")} » ?</div>
    <div class="modal-body"><p>Cette action est définitive.</p>
      ${kids.length ? `<label class="check"><input type="checkbox" id="delKids" checked /> Supprimer aussi ses ${kids.length} chapitre(s) / note(s), avec leurs PDF et leurs fiches</label>
      <small style="color:var(--muted)">Décoche pour les garder (ils deviennent des notes sans cours).</small>` : ""}</div>
    <div class="modal-foot"><button class="btn" data-close>Annuler</button><button class="btn danger" id="doDel">Supprimer</button></div>`);
  $("#doDel").addEventListener("click", async () => {
    const withKids = $("#delKids")?.checked;
    for (const k of kids) {
      if (withKids) { await DB.remove(k.id); state.ai.delete(k.id); }
      else { k.parentId = null; await DB.save(k); }
    }
    await DB.remove(note.id);
    state.ai.delete(note.id);
    closeModal();
    toast("Note supprimée");
    go("#/");
  });
}

// ═════════════ Recherche ═════════════

let searchFilter = "all", searchSel = 0, searchList = [];
function openSearch() {
  $("#searchOverlay").hidden = false;
  const inp = $("#searchInput");
  inp.value = "";
  runSearch();
  setTimeout(() => inp.focus(), 10);
}
function closeSearch() { $("#searchOverlay").hidden = true; }
function runSearch() {
  searchList = search($("#searchInput").value, searchFilter, state.searchAll);
  searchSel = 0;
  drawSearch();
}
function drawSearch() {
  const box = $("#searchResults");
  if (!searchList.length) {
    box.innerHTML = `<div class="result-empty">${DB.all().length ? "Aucun résultat" : "Ta base est vide : crée une première note !"}</div>`;
    return;
  }
  box.innerHTML = searchList.map((r, i) => {
    const p = r.note.parentId && DB.get(r.note.parentId);
    const f = state.searchAll && DB.getFormation(r.note.formationId);
    return `<div class="result t-${r.note.type} ${i === searchSel ? "sel" : ""}" data-i="${i}">
      <span class="dot"></span>
      <div style="min-width:0"><div class="rt">${r.titleHtml} <span class="badge" style="margin-left:6px">${TYPE_LABEL[r.note.type]}</span>${p ? ` <span style="color:var(--muted);font-size:12px">↳ ${esc(p.title)}</span>` : ""}${f ? ` <span class="fbadge" style="--fc:${f.color};margin-left:6px"><i></i>${esc(f.name)}</span>` : ""}</div>
      <div class="rs">${r.snippet}</div></div></div>`;
  }).join("");
  $$(".result", box).forEach((el) => el.addEventListener("click", () => pickSearch(+el.dataset.i)));
  box.querySelector(".sel")?.scrollIntoView({ block: "nearest" });
}
function pickSearch(i) {
  const r = searchList[i];
  if (!r) return;
  closeSearch();
  state.mode = "preview";
  go(`#/note/${r.note.id}`);
}

// ═════════════ Panneau IA ═════════════

function aiSession(id) {
  if (!state.ai.has(id)) state.ai.set(id, { history: [], items: [] });
  return state.ai.get(id);
}

function toggleAi(open) {
  $(".app").classList.toggle("ai-open", open);
  $("#aiPanel").setAttribute("aria-hidden", String(!open));
  if (open) syncAiPanel();
}

function syncAiPanel() {
  if (!$(".app").classList.contains("ai-open")) return;
  const note = DB.get(state.current);
  if (!note) {
    $("#aiContext").innerHTML = "Ouvre un cours ou une note pour que l'IA l'analyse.";
    $("#aiThread").innerHTML = `<div class="ai-empty">Aucune note sélectionnée.</div>`;
    $$("#aiModes button, #aiSend").forEach((b) => (b.disabled = true));
    return;
  }
  $$("#aiModes button, #aiSend").forEach((b) => (b.disabled = !!state.aiBusy));
  const parent = note.parentId && DB.get(note.parentId);
  $("#aiContext").innerHTML = `Analyse : <b>${esc(note.title || "Sans titre")}</b>${parent ? ` · avec le cours <b>${esc(parent.title)}</b>` : ""}`;
  const s = aiSession(note.id);
  const thread = $("#aiThread");
  if (!s.items.length) {
    thread.innerHTML = `<div class="ai-empty">${AI.hasKey()
      ? "Choisis un mode ci-dessus ou pose ta question.<br/>L'IA lit ta note (et son cours parent) pour te répondre."
      : `Pour utiliser l'IA, ajoute ta clé Gemini (gratuite, 1 minute à créer).<br/><br/><button class="btn-primary" id="aiKey">Ajouter ma clé</button>`}</div>`;
    $("#aiKey")?.addEventListener("click", openSettings);
    return;
  }
  thread.innerHTML = s.items.map((it, i) => it.role === "user"
    ? `<div class="msg user">${esc(it.text)}</div>`
    : it.error ? `<div class="msg err">${esc(it.text)}</div>`
    : `<div class="msg ai"><div class="md">${renderMd(it.text)}</div>${it.done ? `<div class="msg-actions">
        <button class="btn" data-append="${i}">＋ Ajouter à la note</button>
        <button class="btn" data-fiche="${i}">⧉ En faire une fiche</button>
        <button class="btn" data-copy="${i}">Copier</button></div>` : `<div class="thinking"><i></i><i></i><i></i></div>`}</div>`
  ).join("");
  wireLinks(thread);
  $$("[data-append]", thread).forEach((b) => b.addEventListener("click", async () => {
    const it = s.items[+b.dataset.append];
    note.content = `${note.content.trimEnd()}\n\n---\n\n${it.text}\n`;
    await DB.save(note);
    toast("Ajouté à la note");
    if (state.current === note.id) renderNote();
  }));
  $$("[data-fiche]", thread).forEach((b) => b.addEventListener("click", async () => {
    const it = s.items[+b.dataset.fiche];
    const label = it.label || "Explication";
    const f = await DB.save(DB.create({
      type: "fiche",
      title: `${label} — ${note.title || "Sans titre"}`,
      content: `Fiche générée à partir de [[${note.title}]].\n\n${it.text}`,
      parentId: note.type === "cours" ? note.id : note.parentId,
    }));
    toast("Fiche créée");
    state.mode = "preview";
    go(`#/note/${f.id}`);
  }));
  $$("[data-copy]", thread).forEach((b) => b.addEventListener("click", () => {
    navigator.clipboard?.writeText(s.items[+b.dataset.copy].text).then(() => toast("Copié"));
  }));
  thread.scrollTop = thread.scrollHeight;
}

async function askAi({ mode, question }) {
  const note = DB.get(state.current);
  if (!note || state.aiBusy) return;
  if (!AI.hasKey()) return openSettings();
  const s = aiSession(note.id);
  const parent = note.parentId && DB.get(note.parentId);
  const label = mode ? AI.MODE_LABELS[mode] : null;
  s.items.push({ role: "user", text: label || question });
  const answer = { role: "ai", text: "", done: false, label: label || "Réponse" };
  s.items.push(answer);
  state.aiBusy = new AbortController();
  syncAiPanel();

  let pending = false;
  try {
    const ctx = AI.contextBlock(note, parent, [...DB.outgoing(note), ...DB.backlinks(note)]);
    const { text, sent } = await AI.ask({
      context: ctx, history: s.history, mode, question, signal: state.aiBusy.signal,
      onText: (t) => {
        answer.text = t;
        if (pending) return;
        pending = true;
        requestAnimationFrame(() => { pending = false; if (state.current === note.id) syncAiPanel(); });
      },
    });
    answer.text = text;
    s.history.push(sent, { role: "assistant", text });
  } catch (e) {
    console.error(e);
    answer.error = true;
    answer.text = AI.friendlyError(e);
  } finally {
    answer.done = true;
    state.aiBusy = null;
    if (state.current === note.id) syncAiPanel();
  }
}

// ═════════════ Import de PDF et de dossiers ═════════════
// Un dossier "Formation / Module / Chapter 1.pdf" devient : onglet Formation › cours Module › fiches Chapter 1, 2, 3…
// Le texte des PDF est extrait localement (gratuit) ; les fiches IA se génèrent ensuite, une par une.

const natural = (a, b) => a.localeCompare(b, "fr", { numeric: true, sensitivity: "base" });
const stripExt = (name) => name.replace(/\.[^.]+$/, "");
const isPdf = (f) => f.type === "application/pdf" || /\.pdf$/i.test(f.name);

// Parcourt un dossier glissé-déposé (API FileSystemEntry).
async function walkEntry(entry, prefix = "") {
  if (entry.isFile) {
    const file = await new Promise((res, rej) => entry.file(res, rej));
    return [{ file, path: prefix + file.name }];
  }
  const reader = entry.createReader();
  const out = [];
  for (;;) {
    const batch = await new Promise((res, rej) => reader.readEntries(res, rej));
    if (!batch.length) break;
    for (const e of batch) out.push(...(await walkEntry(e, prefix + entry.name + "/")));
  }
  return out;
}

async function filesFromDrop(dt) {
  const entries = [...(dt.items || [])].map((i) => i.webkitGetAsEntry?.()).filter(Boolean);
  if (entries.length) {
    const lists = await Promise.all(entries.map((e) => walkEntry(e)));
    return lists.flat();
  }
  return [...dt.files].map((file) => ({ file, path: file.name }));
}

// L'utilisateur dit ce que contient le dossier (plusieurs formations, une formation, un module)
// et vers quelle formation l'importer : rien n'est deviné à partir de l'onglet actif.
//   multi  : Racine / Formation / Module / … / fichier
//   one    : Formation(racine) / Module / … / fichier
//   module : Module(racine) / … / fichier
//   files  : fichiers seuls
// Les sous-dossiers plus profonds sont rangés dans le module ; un sous-dossier "Fiches" contient les fiches.
const IMPORT_MODES = {
  multi: "Plusieurs formations",
  one: "Une formation",
  module: "Un module",
};

const findFormation = (name) => DB.formations().find((f) => norm(f.name) === norm(name));
const findCours = (fid, title) => DB.everything().find((n) => n.type === "cours" && n.formationId === fid && norm(n.title) === norm(title));
const segsOf = (e) => e.path.split("/").slice(0, -1).filter((d) => !FICHE_DIR.test(d));
const inFicheDir = (e) => e.path.split("/").slice(0, -1).some((d) => FICHE_DIR.test(d));

function guessImport(entries) {
  const segs = entries.map(segsOf);
  const depth = Math.max(0, ...segs.map((s) => s.length));
  if (!depth) return { mode: "files", dest: DB.getScope() };
  const root = segs.find((s) => s.length)?.[0] || "";
  const rootF = findFormation(root);
  if (rootF) return { mode: "one", dest: rootF.id };
  if (segs.some((s) => s[1] && findFormation(s[1]))) return { mode: "multi", dest: DB.getScope() };
  if (depth >= 3) return { mode: "multi", dest: DB.getScope() };
  if (depth === 2) return { mode: "one", dest: "__new" };
  return { mode: "module", dest: DB.getScope() };
}

// Regroupe les fichiers par (formation, module) selon les réglages choisis.
function planImport(entries, { mode, dest, looseCoursId }) {
  const groups = new Map();
  for (const e of entries) {
    const segs = segsOf(e);
    let fname = null, fid = null, mname = null;
    if (mode === "multi" && segs.length >= 2) {
      fname = segs[1];
      fid = findFormation(fname)?.id || null;
      mname = segs[2] ?? null;
    } else {
      if (dest === "__new") fname = segs[0] || "Nouvelle formation";
      else fid = dest;
      if (mode === "multi") mname = null; // fichier posé directement à la racine
      else if (mode === "one") mname = segs[1] ?? null;
      else if (mode === "module") mname = segs[0] ?? null;
    }
    if (fid) fname = DB.getFormation(fid)?.name || fname;
    const key = `${fid || "new:" + norm(fname)}\u0000${mname ? norm(mname) : ""}`;
    if (!groups.has(key)) groups.set(key, { fid, fname, mname, chapters: [], fiches: [] });
    const isChapter = isPdf(e.file) && !inFicheDir(e) && !looksLikeFiche(e.file.name);
    groups.get(key)[isChapter ? "chapters" : "fiches"].push(e);
  }
  const list = [...groups.values()];
  for (const g of list) {
    g.chapters.sort((a, b) => natural(a.path, b.path));
    g.fiches.sort((a, b) => natural(a.path, b.path));
    const cours = g.fid && g.mname ? findCours(g.fid, g.mname) : !g.mname && looseCoursId ? DB.get(looseCoursId) : null;
    g.coursExists = !!(cours && g.mname);
    const existing = cours ? DB.children(cours.id) : [];
    const keys = new Set([...g.chapters.map((e) => chapKey(e.file.name)), ...existing.map((n) => chapKey(n.title))]);
    g.fiches.forEach((e) => { e.match = keys.has(chapKey(e.file.name)); });
  }
  return list.sort((a, b) => natural(a.fname || "", b.fname || "") || natural(a.mname || "", b.mname || ""));
}

function startImport(rawEntries) {
  const entries = rawEntries.filter((e) => !e.path.split("/").some((p) => p.startsWith(".")) && isFicheFile(e.file.name));
  if (!entries.length) return toast("Aucun fichier compatible (PDF, Markdown, texte, HTML, Word)", true);
  const tooBig = entries.filter((e) => isPdf(e.file) && e.file.size > AI.maxPdfBytes());
  const cur = DB.get(state.current);
  const opts = { ...guessImport(entries), looseCoursId: cur ? (cur.type === "cours" ? cur.id : cur.parentId) : null };
  const root = segsOf(entries.find((e) => segsOf(e).length) || { path: "" })[0] || "";

  const draw = () => {
    const plan = planImport(entries, opts);
    const isFiles = opts.mode === "files";
    $("#impMode").hidden = isFiles;
    $$("[data-imode]").forEach((b) => b.classList.toggle("on", b.dataset.imode === opts.mode));
    $("#impDestRow").hidden = opts.mode === "multi";
    $("#impDest").innerHTML = DB.formations().map((f) => `<option value="${f.id}" ${opts.dest === f.id ? "selected" : ""}>${esc(f.name)}</option>`).join("")
      + (opts.mode === "one" && root ? `<option value="__new" ${opts.dest === "__new" ? "selected" : ""}>＋ Nouvel onglet « ${esc(root)} »</option>` : "");
    if (opts.dest === "__new" && !(opts.mode === "one" && root)) opts.dest = DB.getScope();
    $("#impHint").innerHTML = {
      multi: `Chaque sous-dossier de <b>${esc(root)}</b> est une formation (rangée dans l'onglet du même nom), et chacun de ses sous-dossiers un module.`,
      one: `<b>${esc(root)}</b> est une formation : chacun de ses sous-dossiers devient un module.`,
      module: `<b>${esc(root)}</b> est un module : ses fichiers deviennent ses chapitres.`,
      files: `Les fichiers sont rangés dans la formation et le cours choisis.`,
    }[opts.mode];

    const destF = opts.dest !== "__new" ? DB.getFormation(opts.dest) : null;
    const coursList = destF ? DB.everything().filter((n) => n.type === "cours" && n.formationId === destF.id).sort((a, b) => a.createdAt - b.createdAt) : [];
    $("#importPlan").innerHTML = plan.map((g) => {
      const f = g.fid ? DB.getFormation(g.fid) : null;
      const matched = g.fiches.filter((e) => e.match);
      const others = g.fiches.filter((e) => !e.match);
      const parts = [
        g.chapters.length && `${g.chapters.length} chapitre(s)`,
        matched.length && `<span style="color:var(--green)">📎 ${matched.length} fiche(s) associée(s)</span>`,
        others.length && `${others.length} autre(s) fichier(s)`,
      ].filter(Boolean).join(" · ");
      return `<div class="imp-group">
        <div class="imp-path">
          <span class="fbadge" style="--fc:${f?.color || "var(--green)"}"><i></i>${esc(g.fname)}</span>${f ? `<span class="imp-ok">onglet existant</span>` : `<span class="imp-new">nouvel onglet</span>`}
          ${g.mname ? `<span class="sep">›</span><span class="badge t-cours">Module</span> ${esc(g.mname)}${g.coursExists ? `<span class="imp-ok">module existant</span>` : `<span class="imp-new">nouveau</span>`}`
            : `<span class="sep">›</span><select data-loose>${coursList.length ? "" : ""}<option value="">— Sans cours —</option>${coursList.map((c) => `<option value="${c.id}" ${c.id === opts.looseCoursId ? "selected" : ""}>${esc(c.title || "Sans titre")}</option>`).join("")}</select>`}
        </div>
        <div class="imp-files">${parts}<br/>${[...g.chapters, ...g.fiches].map((e) => `${e.match ? "📎 " : ""}${esc(e.file.name)}`).join(" · ")}</div>
      </div>`;
    }).join("");
    const nMatched = plan.reduce((s, g) => s + g.fiches.filter((e) => e.match).length, 0);
    $("#replaceRow").hidden = !nMatched;
  };

  modal(`
    <div class="modal-head">📁 Importer ${entries.length} fichier${entries.length > 1 ? "s" : ""}</div>
    <div class="modal-body">
      <div class="field" id="impMode"><label>Ce dossier contient</label>
        <div class="chips">${Object.entries(IMPORT_MODES).map(([k, v]) => `<button type="button" data-imode="${k}">${v}</button>`).join("")}</div>
        <small id="impHint"></small></div>
      <div class="field" id="impDestRow"><label>Formation de destination</label><select id="impDest"></select></div>
      <div class="field"><label>Aperçu : voici où tout va être rangé</label><div id="importPlan" class="imp-plan"></div></div>
      <small style="color:var(--muted)">Tes propres fiches (même nom que le chapitre, ex. <i>Chapter 1.md</i> ou <i>Chapter 1 - fiche.pdf</i>, ou dans un sous-dossier <i>Fiches</i>) sont attachées à leur chapitre 📎.</small>
      <label class="check" id="replaceRow"><input type="checkbox" id="replaceFiches" /> Remplacer les fiches déjà présentes sur ces chapitres</label>
      <label class="check"><input type="checkbox" id="genAi" ${AI.hasKey() ? "checked" : "disabled"} /> ✦ Générer une fiche IA pour les chapitres qui n'ont pas de fiche${AI.hasKey() ? "" : " (ajoute ta clé dans Réglages)"}</label>
      ${tooBig.length ? `<small style="color:var(--amber)">${tooBig.length} PDF dépasse${tooBig.length > 1 ? "nt" : ""} ${AI.maxPdfBytes() / 1024 / 1024} Mo : importé${tooBig.length > 1 ? "s" : ""} et cherchable${tooBig.length > 1 ? "s" : ""}, mais sans fiche IA.</small>` : ""}
      <div id="importProgress" hidden><div class="progress"><i></i></div><p style="margin-top:8px;font-size:12.5px;color:var(--muted)" id="importStatus"></p></div>
    </div>
    <div class="modal-foot"><button class="btn" data-close id="importCancel">Annuler</button><button class="btn-primary" id="importGo">Importer</button></div>`, { lock: true });
  draw();
  $$("[data-imode]").forEach((b) => b.addEventListener("click", () => {
    opts.mode = b.dataset.imode;
    if (opts.mode === "one" && !findFormation(root)) opts.dest = "__new";
    else if (opts.mode === "one") opts.dest = findFormation(root).id;
    draw();
  }));
  $("#impDest").addEventListener("change", (e) => { opts.dest = e.target.value; opts.looseCoursId = null; draw(); });
  $("#importPlan").addEventListener("change", (e) => { if (e.target.matches("[data-loose]")) opts.looseCoursId = e.target.value || null; });

  let cancelled = false;
  $("#importCancel").addEventListener("click", () => { cancelled = true; });
  $("#importGo").addEventListener("click", async () => {
    const plan = planImport(entries, opts);
    const genAi = $("#genAi").checked;
    const replace = $("#replaceFiches").checked;
    $("#importGo").disabled = true;
    $$("#modal button[data-imode], #impDest").forEach((x) => (x.disabled = true));
    $("#importProgress").hidden = false;
    const created = [], chaptersTouched = [];
    let skipped = 0, attached = 0, done = 0, firstTarget = null, firstFormation = null;
    const status = (e) => { $("#importStatus").textContent = `Lecture ${++done}/${entries.length} · ${e.path}`; };

    for (const g of plan) {
      if (cancelled) break;
      let f = g.fid ? DB.getFormation(g.fid) : findFormation(g.fname);
      if (!f) f = await DB.saveFormation(DB.createFormation(g.fname));
      let parentId = g.mname ? null : (opts.looseCoursId && DB.get(opts.looseCoursId)?.formationId === f.id ? opts.looseCoursId : null);
      if (g.mname) {
        parentId = (findCours(f.id, g.mname) || (await DB.save(DB.create({ type: "cours", title: g.mname, formationId: f.id })))).id;
      }
      firstFormation ??= f.id;
      firstTarget ??= parentId;
      const siblings = () => DB.everything().filter((n) => n.formationId === f.id && n.parentId === parentId);
      const base = siblings().length;
      // Chapitres déjà présents dans CE module de CETTE formation, par clé de nom.
      const byKey = new Map();
      siblings().forEach((n) => byKey.set(chapKey(n.title), n));

      for (const [i, e] of g.chapters.entries()) {
        if (cancelled) break;
        status(e);
        const already = siblings().find((n) => n.source?.kind === "pdf" && norm(n.source.name) === norm(e.file.name));
        if (already) { skipped++; byKey.set(chapKey(already.title), already); chaptersTouched.push(already.id); continue; }
        const note = DB.create({
          type: "fiche", title: stripExt(e.file.name), parentId, formationId: f.id, tags: ["pdf"],
          source: { kind: "pdf", name: e.file.name, path: e.path, size: e.file.size },
        });
        note.order = base + i;
        try {
          const { text, pages } = await extractText(e.file);
          note.text = text;
          note.source.pages = pages;
        } catch (err) {
          console.warn("Lecture PDF impossible", e.path, err);
          note.text = "";
        }
        await DB.saveFile(note.id, e.file);
        await DB.save(note);
        byKey.set(chapKey(note.title), note);
        created.push(note.id);
        chaptersTouched.push(note.id);
      }

      for (const [i, e] of g.fiches.entries()) {
        if (cancelled) break;
        status(e);
        try {
          const target = byKey.get(chapKey(e.file.name));
          if (target) {
            if (await attachFiche(target, e.file, { replace })) attached++; else skipped++;
            continue;
          }
          // Fichier sans chapitre correspondant : il devient une fiche à part dans le module.
          if (siblings().some((n) => n.source && norm(n.source.name) === norm(e.file.name))) { skipped++; continue; }
          const note = DB.create({
            type: "fiche", title: stripExt(e.file.name), parentId, formationId: f.id,
            source: { kind: "fichier", name: e.file.name, path: e.path, size: e.file.size },
          });
          note.order = base + g.chapters.length + i;
          await attachFiche(note, e.file);
          byKey.set(chapKey(note.title), note);
          created.push(note.id);
        } catch (err) {
          console.error(err);
          toast(`Impossible de lire ${e.file.name}`, true);
        }
      }
    }

    closeModal(true);
    toast([
      created.length && `${created.length} fichier(s) importé(s)`,
      attached && `📎 ${attached} fiche(s) attachée(s)`,
      skipped && `${skipped} déjà présent(s)`,
    ].filter(Boolean).join(" · ") || "Rien de nouveau à importer");
    if (firstFormation) setFormation(firstFormation, false);
    state.mode = "preview";
    if (created.length === 1 && !attached) go(`#/note/${created[0]}`);
    else if (firstTarget) go(`#/note/${firstTarget}`);
    else go("#/");
    const toGenerate = chaptersTouched.map((id) => DB.get(id)).filter((n) => n && !hasFiche(n) && (n.source?.size || 0) <= AI.maxPdfBytes()).map((n) => n.id);
    if (genAi && toGenerate.length) enqueueFiches(toGenerate);
  });
}

// ───────── File d'attente des fiches IA ─────────

const queue = { ids: [], running: false, done: 0, total: 0, ctrl: null, current: null };

function enqueueFiches(ids) {
  if (!AI.hasKey()) { toast("Ajoute ta clé IA dans Réglages", true); return openSettings(); }
  const fresh = ids.filter((id) => !queue.ids.includes(id) && id !== queue.current);
  queue.ids.push(...fresh);
  queue.total += fresh.length;
  drawQueue();
  if (!queue.running) processQueue();
}

async function generateFiche(note, signal) {
  const blob = await DB.getFile(note.id);
  if (!blob) throw new Error(`Le PDF original de « ${note.title} » n'est pas sur cet appareil.`);
  const md = await AI.pdfToFiche({
    file: new File([blob], note.source?.name || `${note.title}.pdf`, { type: "application/pdf" }),
    existingTitles: DB.everything().filter((n) => n.formationId === note.formationId).map((n) => n.title).filter(Boolean),
    signal,
  });
  note.content = md.trim();
  await DB.save(note);
}

async function processQueue() {
  queue.running = true;
  while (queue.ids.length) {
    const id = queue.ids.shift();
    const note = DB.get(id);
    if (!note) continue;
    queue.current = id;
    queue.ctrl = new AbortController();
    drawQueue(note);
    try {
      await generateFiche(note, queue.ctrl.signal);
      queue.done++;
      if (state.current === id || state.current === note.parentId) route();
    } catch (e) {
      if (queue.ctrl.signal.aborted) break;
      console.error(e);
      toast(`${note.title} : ${AI.friendlyError(e)}`, true);
      if (e?.status === 429 || e?.status === 400 || e?.status === 401 || e?.status === 403 || e?.message === "NO_KEY") break;
    }
    // Petite pause pour rester sous la limite de requêtes par minute du gratuit.
    if (queue.ids.length) await new Promise((r) => setTimeout(r, 4000));
  }
  const finished = queue.done;
  Object.assign(queue, { ids: [], running: false, done: 0, total: 0, ctrl: null, current: null });
  drawQueue();
  if (finished) toast(`✦ ${finished} fiche(s) synthèse générée(s)`);
}

function drawQueue(note) {
  let el = $("#queuePill");
  if (!queue.running && !queue.ids.length) { el?.remove(); return; }
  if (!el) {
    el = document.createElement("div");
    el.id = "queuePill";
    el.className = "queue-pill";
    document.body.appendChild(el);
  }
  el.innerHTML = `<div class="thinking"><i></i><i></i><i></i></div>
    <span>Fiches IA <b>${queue.done + 1}/${queue.total}</b>${note ? ` · ${esc(note.title)}` : ""}</span>
    <button class="btn" id="queueStop">Arrêter</button>`;
  $("#queueStop").addEventListener("click", () => { queue.ids = []; queue.ctrl?.abort(); toast("Génération arrêtée"); });
}

function pendingFiches(coursId) {
  return DB.children(coursId).filter((n) => n.source?.kind === "pdf" && !hasFiche(n));
}

// ═════════════ Réglages & sauvegarde ═════════════

function modelOptions(list, current) {
  const all = list.some((m) => m.id === current) || !current ? list : [{ id: current, label: current }, ...list];
  return all.map((m) => `<option value="${esc(m.id)}" ${m.id === current ? "selected" : ""}>${esc(m.label)}</option>`).join("");
}

function openSettings() {
  const s = AI.settings();
  modal(`
    <div class="modal-head">Réglages</div>
    <div class="modal-body">
      <div class="field"><label>Fournisseur d'IA</label>
        <select id="setProvider">${Object.entries(AI.PROVIDERS).map(([k, p]) => `<option value="${k}" ${k === s.provider ? "selected" : ""}>${p.label}</option>`).join("")}</select></div>
      <div id="provGemini" class="modal-body" style="padding:0">
        <div class="field"><label>Clé API Gemini (gratuite)</label>
          <input id="setGeminiKey" type="password" value="${esc(s.geminiKey)}" placeholder="AIza…" autocomplete="off" />
          <small>1. Va sur <a href="https://aistudio.google.com/apikey" target="_blank" rel="noopener">aistudio.google.com/apikey</a> avec ton compte Google · 2. « Create API key » · 3. colle-la ici. Pas de carte bancaire. La clé reste dans ce navigateur.</small></div>
        <div class="field"><label>Modèle</label>
          <div class="row" style="flex-wrap:nowrap"><select id="setGeminiModel" style="flex:1">${modelOptions(AI.GEMINI_MODELS, s.geminiModel)}</select>
          <button class="btn" id="loadModels" type="button">Charger mes modèles</button></div>
          <small>Le gratuit a un quota par jour : si tu l'atteins, passe sur un autre modèle ou attends le lendemain.</small></div>
      </div>
      <div id="provClaude" class="modal-body" style="padding:0">
        <div class="field"><label>Clé API Claude</label>
          <input id="setKey" type="password" value="${esc(s.apiKey)}" placeholder="sk-ant-…" autocomplete="off" />
          <small>Payant à l'usage. Crée-la sur <a href="https://console.anthropic.com/settings/keys" target="_blank" rel="noopener">console.anthropic.com</a>. Elle reste dans ce navigateur.</small></div>
        <div class="field"><label>Modèle</label>
          <select id="setModel">${modelOptions(AI.CLAUDE_MODELS, s.model)}</select></div>
      </div>
      <div class="divider"></div>
      <div class="field"><label>Météo du tableau de bord</label>
        <div class="row"><button class="btn" id="setWeather" type="button">🌤️ Choisir ma ville</button></div></div>
      <div class="divider"></div>
      <div class="field"><label>Sauvegarde</label>
        <small>Tes notes et ton suivi de projet sont stockés dans ce navigateur. Exporte régulièrement un fichier de sauvegarde (et pour passer d'un ordi à l'autre).</small>
        <div class="row" style="margin-top:6px">
          <button class="btn" id="exportJson">⬇ Exporter tout (.json)</button>
          <button class="btn" id="importJson">⬆ Importer…</button>
          <input type="file" id="importFile" accept="application/json,.json" hidden />
        </div></div>
      <div class="divider"></div>
      <div class="row"><button class="btn danger" id="wipe">Tout effacer</button></div>
    </div>
    <div class="modal-foot"><button class="btn" data-close>Fermer</button><button class="btn-primary" id="saveSet">Enregistrer</button></div>`);

  const syncProvider = () => {
    const p = $("#setProvider").value;
    $("#provGemini").hidden = p !== "gemini";
    $("#provClaude").hidden = p !== "claude";
  };
  syncProvider();
  $("#setProvider").addEventListener("change", syncProvider);
  $("#loadModels").addEventListener("click", async () => {
    const key = $("#setGeminiKey").value.trim();
    if (!key) return toast("Colle d'abord ta clé Gemini", true);
    const btn = $("#loadModels");
    btn.disabled = true; btn.textContent = "Chargement…";
    try {
      const list = await AI.listGeminiModels(key);
      const cur = $("#setGeminiModel").value;
      $("#setGeminiModel").innerHTML = modelOptions(list.length ? list : AI.GEMINI_MODELS, cur);
      toast(`${list.length} modèles disponibles · clé valide ✓`);
    } catch (e) {
      toast(e.status === 400 || e.status === 403 ? "Clé Gemini invalide" : AI.friendlyError(e), true);
    } finally {
      btn.disabled = false; btn.textContent = "Charger mes modèles";
    }
  });

  $("#saveSet").addEventListener("click", () => {
    AI.saveSettings({
      provider: $("#setProvider").value,
      geminiKey: $("#setGeminiKey").value.trim(),
      geminiModel: $("#setGeminiModel").value,
      apiKey: $("#setKey").value.trim(),
      model: $("#setModel").value,
    });
    closeModal();
    toast("Réglages enregistrés");
    route();
  });
  $("#setWeather").addEventListener("click", () => openWeatherSettings(route));
  $("#exportJson").addEventListener("click", () => {
    const data = { app: "synapse", version: 3, exportedAt: new Date().toISOString(), formations: DB.formations(), notes: DB.everything(), pilot: DB.pilot() };
    download(`synapse-sauvegarde-${new Date().toISOString().slice(0, 10)}.json`, JSON.stringify(data, null, 2), "application/json");
  });
  $("#importJson").addEventListener("click", () => $("#importFile").click());
  $("#importFile").addEventListener("change", async (e) => {
    const f = e.target.files[0];
    if (!f) return;
    try {
      const data = JSON.parse(await f.text());
      const notes = Array.isArray(data) ? data : data.notes || [];
      const pilotItems = Array.isArray(data.pilot) ? data.pilot.filter((x) => x.id && x.kind) : [];
      if (!Array.isArray(notes) || notes.some((n) => !n.id || !n.type) || (!notes.length && !pilotItems.length)) throw new Error();
      for (const x of pilotItems) await DB.savePilot(x);
      // Fusion : les notes importées remplacent celles qui ont le même id.
      const fmerged = new Map(DB.formations().map((x) => [x.id, x]));
      (Array.isArray(data.formations) ? data.formations : []).forEach((x) => x.id && x.name && fmerged.set(x.id, x));
      const merged = new Map(DB.everything().map((n) => [n.id, n]));
      notes.forEach((n) => {
        const fid = fmerged.has(n.formationId) ? n.formationId : DB.getScope();
        merged.set(n.id, { tags: [], content: "", title: "", parentId: null, ...n, formationId: fid });
      });
      await DB.replaceAll([...merged.values()], [...fmerged.values()]);
      closeModal();
      toast([notes.length && `${notes.length} note(s)`, pilotItems.length && `${pilotItems.length} élément(s) du suivi de projet`].filter(Boolean).join(" · ") + " importé(s)");
      go("#/");
    } catch {
      toast("Fichier de sauvegarde invalide", true);
    }
  });
  $("#wipe").addEventListener("click", () => {
    modal(`<div class="modal-head">Tout effacer ?</div>
      <div class="modal-body"><p>Toutes tes notes (${DB.everything().length}), dans toutes les formations, et tout ton suivi de projet (${DB.pilot().length} élément(s)) seront supprimés de ce navigateur. Exporte une sauvegarde avant si tu as un doute.</p></div>
      <div class="modal-foot"><button class="btn" data-close>Annuler</button><button class="btn danger" id="wipeOk">Oui, tout effacer</button></div>`);
    $("#wipeOk").addEventListener("click", async () => {
      await DB.replaceAll([]);
      await DB.clearFiles();
      await DB.clearPilot();
      state.ai.clear();
      state.agents.clear();
      closeModal(); toast("Base effacée"); go("#/");
    });
  });
}

// ═════════════ Utilitaires UI ═════════════

let modalLocked = false;
function modal(html, { lock = false } = {}) {
  modalLocked = lock;
  $("#modal").innerHTML = html;
  $("#modalOverlay").hidden = false;
  $$("[data-close]", $("#modal")).forEach((b) => b.addEventListener("click", () => closeModal(true)));
  setTimeout(() => $("#modal input:not([type=hidden]), #modal select")?.focus(), 20);
}
function closeModal(force = false) {
  if (modalLocked && !force) return;
  $("#modalOverlay").hidden = true;
  $("#modal").innerHTML = "";
}

function toast(msg, err = false) {
  const t = document.createElement("div");
  t.className = "toast" + (err ? " err" : "");
  t.textContent = msg;
  $("#toasts").appendChild(t);
  setTimeout(() => t.remove(), err ? 5000 : 2400);
}

function download(name, text, type) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([text], { type }));
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

const slug = (s) => (norm(s || "note").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "note");

// ═════════════ Note de bienvenue ═════════════

async function seed() {
  const c = await DB.save(DB.create({
    type: "cours", title: "Bienvenue dans Synapse",
    content: `Synapse range tout ce que tu apprends en **3 types de notes** reliées entre elles :

| Type | À quoi ça sert |
|---|---|
| **Cours** | Ce que tu notes pendant une journée / un module |
| **Notion** | Un concept précis, réutilisable : [[Variable]], [[Fonction]]… |
| **Fiche** | Une synthèse de révision (souvent générée depuis un PDF) |

## Relier les idées
Écris un nom entre double crochets pour créer un lien : [[Fonction]].
Un lien **orange** pointe vers une note qui n'existe pas encore : clique dessus pour la créer.
Chaque note affiche en bas ses *liens sortants* et les notes qui la *mentionnent*.

## Retrouver
<kbd>Ctrl K</kbd> ouvre la recherche (insensible aux accents), dans la formation active ou dans toutes.

## Ranger par formation
Les **onglets** en haut séparent tes formations : chacune a ses cours, notions, fiches, son graphe et son assistant. Clique sur **+** pour en ajouter une, sur ✎ pour la renommer. Une note peut changer de formation depuis son champ *Formation*.

## Comprendre
Clique sur **✦ Décortiquer** en haut à droite : l'IA lit ta note et son cours, et peut l'expliquer en profondeur, simplement, avec des exemples, te faire un quiz, ou repérer ce qui manque.

## Importer tes PDF
Glisse un PDF ou **un dossier entier** n'importe où dans la fenêtre (ou boutons **PDF** / **Dossier**). Un dossier *Formation › Module › Chapter 1.pdf…* recrée la même arborescence : onglet, module, puis un chapitre par PDF. Le texte est lu tout de suite (cherchable, lisible par l'assistant) et l'IA peut en faire une **fiche synthèse**.

## S'entraîner
La page **Quiz** génère des questions sur les fiches de ton choix, jamais les mêmes d'une fois sur l'autre.`,
  }));
  await DB.save(DB.create({
    type: "notion", title: "Fonction", parentId: c.id,
    content: `Un bloc de code réutilisable qui prend des **paramètres** et renvoie un **résultat**.

\`\`\`js
function double(n) {
  return n * 2;
}
double(21); // 42
\`\`\`

Elle peut lire une [[Variable]] de son environnement.`,
  }));
}

// ═════════════ Démarrage ═════════════

async function init() {
  await DB.openDB();
  await ensureFormations();
  initPilot({ modal, closeModal, toast, go, setCrumbs, renderMd });
  if (!DB.everything().length && !localStorage.getItem("synapse.seeded")) {
    await seed();
    try { localStorage.setItem("synapse.seeded", "1"); } catch {}
  }

  document.addEventListener("click", (e) => {
    const o = e.target.closest("[data-open]");
    if (o) { state.mode = "preview"; go(`#/note/${o.dataset.open}`); }
    const n = e.target.closest("[data-new]");
    if (n) newNote(n.dataset.new);
  });
  $$(".nav-item[data-view]").forEach((b) => b.addEventListener("click", () => go(b.dataset.view === "home" ? "#/" : `#/${b.dataset.view}`)));
  $$("[data-pnav]").forEach((b) => b.addEventListener("click", () => go(`#/${b.dataset.pnav}`)));
  $$(".space-tab").forEach((b) => b.addEventListener("click", () => go(lastHash[b.dataset.space])));
  $("#quickTask").addEventListener("submit", async (e) => {
    e.preventDefault();
    const input = $("#quickTask input");
    const title = input.value.trim();
    if (!title) return;
    await DB.savePilot({ kind: "task", title, description: "", status: "todo", period: "today" });
    input.value = "";
    toast("Tâche ajoutée pour aujourd'hui");
    route();
  });
  $("#openSearch").addEventListener("click", openSearch);
  $("#settingsBtn").addEventListener("click", openSettings);
  $("#menuBtn").addEventListener("click", () => $("#sidebar").classList.toggle("open"));
  $("#pdfBtn").addEventListener("click", () => $("#pdfInput").click());
  $("#pdfInput").addEventListener("change", (e) => {
    startImport([...e.target.files].map((file) => ({ file, path: file.name })));
    e.target.value = "";
  });
  $("#dirBtn").addEventListener("click", () => $("#dirInput").click());
  $("#dirInput").addEventListener("change", (e) => {
    startImport([...e.target.files].map((file) => ({ file, path: file.webkitRelativePath || file.name })));
    e.target.value = "";
  });

  // Recherche
  $("#searchInput").addEventListener("input", runSearch);
  $("#searchInput").addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown") { e.preventDefault(); searchSel = Math.min(searchSel + 1, searchList.length - 1); drawSearch(); }
    if (e.key === "ArrowUp") { e.preventDefault(); searchSel = Math.max(searchSel - 1, 0); drawSearch(); }
    if (e.key === "Enter") { e.preventDefault(); pickSearch(searchSel); }
  });
  $("#searchScope").addEventListener("click", () => {
    state.searchAll = !state.searchAll;
    $("#searchScope").textContent = state.searchAll ? "Toutes les formations" : "Cette formation";
    $("#searchScope").classList.toggle("on", state.searchAll);
    runSearch(); $("#searchInput").focus();
  });
  $$("#searchFilters button[data-f]").forEach((b) => b.addEventListener("click", () => {
    searchFilter = b.dataset.f;
    $$("#searchFilters button[data-f]").forEach((x) => x.classList.toggle("on", x === b));
    runSearch(); $("#searchInput").focus();
  }));
  $("#searchOverlay").addEventListener("mousedown", (e) => { if (e.target.id === "searchOverlay") closeSearch(); });
  $("#modalOverlay").addEventListener("mousedown", (e) => { if (e.target.id === "modalOverlay") closeModal(); });

  // IA
  $("#aiClose").addEventListener("click", () => toggleAi(false));
  $$("#aiModes button").forEach((b) => b.addEventListener("click", () => askAi({ mode: b.dataset.mode })));
  $("#aiForm").addEventListener("submit", (e) => {
    e.preventDefault();
    const q = $("#aiQuestion").value.trim();
    if (!q) return;
    $("#aiQuestion").value = "";
    askAi({ question: q });
  });
  $("#aiQuestion").addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); $("#aiForm").requestSubmit(); }
  });

  // Raccourcis clavier
  document.addEventListener("keydown", (e) => {
    const mod = e.ctrlKey || e.metaKey;
    if (mod && e.key.toLowerCase() === "k") { e.preventDefault(); $("#searchOverlay").hidden ? openSearch() : closeSearch(); }
    else if (mod && e.key.toLowerCase() === "e" && state.current) { e.preventDefault(); setMode(state.mode === "edit" ? "preview" : "edit"); }
    else if (location.hash === "#/quiz" && /^[1-9]$/.test(e.key) && !e.target.closest?.("input, textarea")) {
      $(`[data-choice="${+e.key - 1}"]:not(:disabled)`)?.click();
    }
    else if (e.key === "Escape") {
      if (!$("#searchOverlay").hidden) closeSearch();
      else if (!$("#modalOverlay").hidden) closeModal();
    }
  });

  // Glisser-déposer de PDF
  let dragDepth = 0;
  const hasFiles = (e) => [...(e.dataTransfer?.types || [])].includes("Files");
  window.addEventListener("dragenter", (e) => { if (!hasFiles(e)) return; e.preventDefault(); dragDepth++; $("#dropzone").hidden = false; });
  window.addEventListener("dragover", (e) => { if (hasFiles(e)) e.preventDefault(); });
  window.addEventListener("dragleave", () => { dragDepth = Math.max(0, dragDepth - 1); if (!dragDepth) $("#dropzone").hidden = true; });
  window.addEventListener("drop", (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault(); dragDepth = 0; $("#dropzone").hidden = true;
    filesFromDrop(e.dataTransfer).then(startImport).catch((err) => { console.error(err); toast("Impossible de lire ces fichiers", true); });
  });

  window.addEventListener("hashchange", route);
  route();
}

init().catch((e) => {
  console.error(e);
  document.body.innerHTML = `<div style="padding:40px;color:#f87171;font-family:sans-serif">Impossible de démarrer Synapse : ${esc(e.message)}<br/>Ouvre le site via un serveur web (voir README), pas en double-cliquant le fichier.</div>`;
});
