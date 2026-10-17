// Vitrine des certificats et diplômes : un mur des réussites, avec aperçu, plein écran et lien de vérification.
// Les infos sont dans le magasin "pilot" (kind: "cert"), le fichier original dans "files" (clé "cert:<id>").

import * as DB from "./db.js";
import { renderFirstPage } from "./pdf.js";

let ui;
export function initCerts(helpers) { ui = helpers; }

const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (s = "") => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

const certs = () => DB.pilot("cert").sort((a, b) => (b.date || "").localeCompare(a.date || "") || b.createdAt - a.createdAt);
const fileKey = (id) => `cert:${id}`;
const dateFr = (s) => s ? new Date(s + "T00:00").toLocaleDateString("fr-FR", { day: "numeric", month: "long", year: "numeric" }) : "";
const isPdfFile = (f) => f.type === "application/pdf" || /\.pdf$/i.test(f.name || "");
let filter = "all";

// Aperçu léger (JPEG) affiché dans la vitrine.
async function makeThumb(file) {
  if (isPdfFile(file)) return renderFirstPage(file, 720);
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = url; });
    const w = Math.min(900, img.naturalWidth);
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = Math.round(img.naturalHeight * (w / img.naturalWidth));
    canvas.getContext("2d").drawImage(img, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL("image/jpeg", 0.85);
  } finally {
    URL.revokeObjectURL(url);
  }
}

export function renderCerts() {
  ui.setCrumbs([{ label: "Accueil", href: "#/" }, { label: "Diplômes" }]);
  $("#topActions").innerHTML = `<button class="btn-primary" id="addCert">+ Ajouter</button>`;
  $("#addCert").addEventListener("click", () => certModal(null));

  const all = certs();
  const forms = DB.formations().filter((f) => all.some((c) => c.formationId === f.id));
  if (filter !== "all" && !forms.some((f) => f.id === filter)) filter = "all";
  const list = filter === "all" ? all : all.filter((c) => c.formationId === filter);
  const years = new Set(all.map((c) => (c.date || "").slice(0, 4)).filter(Boolean));
  const skills = new Set(all.flatMap((c) => c.skills || []));

  $("#view").innerHTML = `
  <div class="home wide certs">
    <div class="hero cert-hero">
      <div class="trophy">🏆</div>
      <div>
        <h1>Mes certificats & diplômes</h1>
        <p>${all.length ? `${all.length} réussite${all.length > 1 ? "s" : ""}${years.size ? ` · ${[...years].sort().join(", ")}` : ""}${skills.size ? ` · ${skills.size} compétence${skills.size > 1 ? "s" : ""}` : ""}. Bravo 👏` : "Ton mur des réussites : ajoute tes certificats et diplômes, en image ou en PDF."}</p>
      </div>
    </div>
    ${forms.length ? `<div class="chips cert-filters"><button data-cf="all" class="${filter === "all" ? "on" : ""}">Tous</button>${forms.map((f) => `<button data-cf="${f.id}" class="${filter === f.id ? "on" : ""}">${esc(f.name)}</button>`).join("")}</div>` : ""}
    ${list.length ? `<div class="cert-grid">${list.map((c) => {
      const f = c.formationId && DB.getFormation(c.formationId);
      return `<button class="cert-card" data-cert="${c.id}">
        <div class="cert-frame">${c.thumb ? `<img src="${c.thumb}" alt="${esc(c.title)}" loading="lazy" />` : `<div class="cert-placeholder">🎓</div>`}</div>
        <div class="cert-info">
          <b>${esc(c.title)}</b>
          <span>${esc(c.issuer || "")}${c.issuer && c.date ? " · " : ""}${dateFr(c.date)}</span>
          <div class="cert-tags">${f ? `<span class="fbadge" style="--fc:${f.color}"><i></i>${esc(f.name)}</span>` : ""}${(c.skills || []).slice(0, 4).map((s) => `<span class="tag">${esc(s)}</span>`).join("")}</div>
        </div>
      </button>`;
    }).join("")}</div>`
    : `<div class="empty-state cert-empty"><div style="font-size:46px">🎓</div><b>Aucun diplôme pour l'instant</b>Clique sur « + Ajouter » ou glisse ici l'image ou le PDF d'un certificat.</div>`}
  </div>`;

  $$("[data-cf]").forEach((b) => b.addEventListener("click", () => { filter = b.dataset.cf; renderCerts(); }));
  $$("[data-cert]").forEach((b) => b.addEventListener("click", () => viewCert(DB.getPilot(b.dataset.cert))));
}

// Ajout depuis un fichier glissé sur la page Diplômes.
export function addCertFromFile(file) {
  certModal(null, file);
}

function certModal(cert, presetFile = null) {
  const isNew = !cert;
  cert ||= { kind: "cert", title: "", issuer: "", date: "", formationId: DB.getScope(), url: "", skills: [] };
  let file = presetFile;
  ui.modal(`
    <div class="modal-head">${isNew ? "🏆 Ajouter un diplôme" : "Modifier le diplôme"}</div>
    <div class="modal-body">
      <div class="field"><label>Fichier (image ou PDF)</label>
        <div class="cert-drop" id="cDrop">${cert.thumb ? `<img src="${cert.thumb}" alt="" />` : ""}<span id="cDropText">${file ? esc(file.name) : cert.thumb ? "Cliquer pour remplacer" : "Cliquer ou glisser l'image / le PDF ici"}</span></div>
        <input type="file" id="cFile" accept="image/*,application/pdf" hidden /></div>
      <div class="field"><label>Intitulé</label><input id="cTitle" value="${esc(cert.title)}" placeholder="ex : Certificat Python, Titre RNCP Développeur web…" /></div>
      <div class="row" style="flex-wrap:nowrap">
        <div class="field" style="flex:1"><label>Délivré par</label><input id="cIssuer" value="${esc(cert.issuer || "")}" placeholder="ex : OpenClassrooms, DataCamp…" /></div>
        <div class="field" style="flex:1"><label>Date d'obtention</label><input type="date" id="cDate" value="${cert.date || ""}" /></div>
      </div>
      <div class="field"><label>Formation liée</label><select id="cForm"><option value="">— Aucune —</option>${DB.formations().map((f) => `<option value="${f.id}" ${cert.formationId === f.id ? "selected" : ""}>${esc(f.name)}</option>`).join("")}</select></div>
      <div class="field"><label>Compétences (séparées par des virgules)</label><input id="cSkills" value="${esc((cert.skills || []).join(", "))}" placeholder="ex : Python, Pandas, SQL" /></div>
      <div class="field"><label>Lien de vérification (optionnel)</label><input id="cUrl" value="${esc(cert.url || "")}" placeholder="https://…" /></div>
      <div id="cBusy" hidden><div class="progress"><i></i></div></div>
    </div>
    <div class="modal-foot">${isNew ? "" : `<button class="btn danger" id="cDel" style="margin-right:auto">Supprimer</button>`}<button class="btn" data-close>Annuler</button><button class="btn-primary" id="cSave">${isNew ? "Ajouter" : "Enregistrer"}</button></div>`);

  const setFile = (f) => {
    if (!f) return;
    if (!/^image\//.test(f.type) && !isPdfFile(f)) return ui.toast("Choisis une image ou un PDF", true);
    file = f;
    $("#cDropText").textContent = f.name;
    if (!$("#cTitle").value.trim()) $("#cTitle").value = f.name.replace(/\.[^.]+$/, "").replace(/[_-]+/g, " ");
  };
  if (presetFile) setFile(presetFile);
  $("#cDrop").addEventListener("click", () => $("#cFile").click());
  $("#cFile").addEventListener("change", (e) => setFile(e.target.files[0]));
  $("#cDrop").addEventListener("dragover", (e) => { e.preventDefault(); e.stopPropagation(); $("#cDrop").classList.add("over"); });
  $("#cDrop").addEventListener("dragleave", () => $("#cDrop").classList.remove("over"));
  $("#cDrop").addEventListener("drop", (e) => { e.preventDefault(); e.stopPropagation(); $("#cDrop").classList.remove("over"); setFile(e.dataTransfer.files[0]); });
  $("#cDel")?.addEventListener("click", () => deleteCert(cert));
  $("#cSave").addEventListener("click", async () => {
    const title = $("#cTitle").value.trim();
    if (!title) return ui.toast("Donne un intitulé au diplôme", true);
    $("#cSave").disabled = true;
    $("#cBusy").hidden = false;
    try {
      Object.assign(cert, {
        title, issuer: $("#cIssuer").value.trim(), date: $("#cDate").value, formationId: $("#cForm").value || null,
        url: $("#cUrl").value.trim(), skills: $("#cSkills").value.split(",").map((s) => s.trim()).filter(Boolean),
      });
      if (file) {
        cert.thumb = await makeThumb(file);
        cert.fileName = file.name;
        cert.fileType = isPdfFile(file) ? "pdf" : "image";
      }
      await DB.savePilot(cert);
      if (file) await DB.saveFile(fileKey(cert.id), file);
      ui.closeModal();
      ui.toast(isNew ? "Diplôme ajouté 🎉" : "Diplôme enregistré");
      renderCerts();
    } catch (e) {
      console.error(e);
      ui.toast("Impossible de lire ce fichier", true);
      $("#cSave").disabled = false;
      $("#cBusy").hidden = true;
    }
  });
}

async function viewCert(c) {
  const f = c.formationId && DB.getFormation(c.formationId);
  const blob = await DB.getFile(fileKey(c.id));
  const url = blob ? URL.createObjectURL(blob) : null;
  ui.modal(`
    <div class="cert-view">
      <div class="cert-view-media">${url && c.fileType === "pdf"
        ? `<iframe src="${url}" title="${esc(c.title)}"></iframe>`
        : url ? `<img src="${url}" alt="${esc(c.title)}" />`
        : c.thumb ? `<img src="${c.thumb}" alt="${esc(c.title)}" /><small>Fichier original absent de cet appareil (aperçu seulement)</small>`
        : `<div class="cert-placeholder big">🎓</div>`}</div>
      <div class="cert-view-info">
        <h2>${esc(c.title)}</h2>
        <p>${esc(c.issuer || "")}${c.issuer && c.date ? " · " : ""}${dateFr(c.date)}</p>
        <div class="cert-tags">${f ? `<span class="fbadge" style="--fc:${f.color}"><i></i>${esc(f.name)}</span>` : ""}${(c.skills || []).map((s) => `<span class="tag">${esc(s)}</span>`).join("")}</div>
        <div class="row" style="margin-top:14px">
          ${c.url ? `<a class="btn" href="${esc(c.url)}" target="_blank" rel="noopener">✓ Vérifier</a>` : ""}
          ${url ? `<a class="btn" href="${url}" download="${esc(c.fileName || c.title)}">⬇ Télécharger</a>` : ""}
          <button class="btn" id="cEdit">Modifier</button>
          <button class="btn" data-close style="margin-left:auto">Fermer</button>
        </div>
      </div>
    </div>`);
  $("#modal").classList.add("modal-wide");
  const cleanup = () => { $("#modal").classList.remove("modal-wide"); };
  $$("[data-close]", $("#modal")).forEach((b) => b.addEventListener("click", cleanup));
  $("#cEdit").addEventListener("click", () => { cleanup(); certModal(c); });
}

function deleteCert(c) {
  ui.modal(`<div class="modal-head">Supprimer « ${esc(c.title)} » ?</div>
    <div class="modal-body"><p>Le diplôme et son fichier seront supprimés de l'app.</p></div>
    <div class="modal-foot"><button class="btn" data-close>Annuler</button><button class="btn danger" id="cDelOk">Supprimer</button></div>`);
  $("#cDelOk").addEventListener("click", async () => {
    await DB.removePilot(c.id);
    await DB.removeFile(fileKey(c.id));
    ui.closeModal();
    ui.toast("Diplôme supprimé");
    renderCerts();
  });
}
