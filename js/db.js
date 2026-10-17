// Stockage local (IndexedDB) + cache mémoire.
// Toutes les notes vivent dans le navigateur : rien à héberger côté serveur.
//
// Chaque note appartient à une formation (onglet). DB.all() ne renvoie que les notes
// de la formation active (setScope) ; DB.everything() renvoie tout.

const DB_NAME = "synapsev2";
const STORE = "notes";
const FSTORE = "formations";
const FILES = "files"; // PDF originaux (Blob), indexés par id de note
const PILOT = "pilot"; // tableau de bord : tâches, projets, agenda, bloc-notes, post-its
let db;
const cache = new Map();
const fcache = new Map();
const pcache = new Map();
let scope = null;

function req(r) {
  return new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

export async function openDB() {
  db = await new Promise((resolve, reject) => {
    const r = indexedDB.open(DB_NAME, 4);
    r.onupgradeneeded = () => {
      const d = r.result;
      if (!d.objectStoreNames.contains(STORE)) d.createObjectStore(STORE, { keyPath: "id" });
      if (!d.objectStoreNames.contains(FSTORE)) d.createObjectStore(FSTORE, { keyPath: "id" });
      if (!d.objectStoreNames.contains(FILES)) d.createObjectStore(FILES);
      if (!d.objectStoreNames.contains(PILOT)) d.createObjectStore(PILOT, { keyPath: "id" });
    };
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
  (await req(db.transaction(STORE).objectStore(STORE).getAll())).forEach((n) => cache.set(n.id, n));
  (await req(db.transaction(FSTORE).objectStore(FSTORE).getAll())).forEach((f) => fcache.set(f.id, f));
  (await req(db.transaction(PILOT).objectStore(PILOT).getAll())).forEach((x) => pcache.set(x.id, x));
  // Demande au navigateur de ne pas effacer les données en cas de manque d'espace.
  navigator.storage?.persist?.().catch(() => {});
}

export const uid = () =>
  Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

// ───────── Formations ─────────

export const FORMATION_COLORS = ["#a78bfa", "#22d3ee", "#f472b6", "#34d399", "#fbbf24", "#fb7185", "#60a5fa", "#c084fc"];

export function formations() {
  return [...fcache.values()].sort((a, b) => a.order - b.order);
}

export function getFormation(id) {
  return fcache.get(id);
}

export async function saveFormation(f) {
  fcache.set(f.id, f);
  await req(db.transaction(FSTORE, "readwrite").objectStore(FSTORE).put(f));
  return f;
}

export function createFormation(name) {
  const list = formations();
  const order = list.length ? Math.max(...list.map((f) => f.order)) + 1 : 0;
  return { id: uid(), name, color: FORMATION_COLORS[list.length % FORMATION_COLORS.length], order, createdAt: Date.now() };
}

export async function removeFormation(id) {
  fcache.delete(id);
  await req(db.transaction(FSTORE, "readwrite").objectStore(FSTORE).delete(id));
}

export function setScope(id) { scope = id; }
export function getScope() { return scope; }

// ───────── Notes ─────────

export function everything() {
  return [...cache.values()];
}

export function all() {
  const list = everything();
  return scope ? list.filter((n) => n.formationId === scope) : list;
}

export function get(id) {
  return cache.get(id);
}

// Cherche d'abord dans la formation active, puis partout.
export function byTitle(title) {
  const t = title.trim().toLowerCase();
  const match = (n) => n.title.trim().toLowerCase() === t;
  return all().find(match) || everything().find(match);
}

export async function save(note) {
  note.updatedAt = Date.now();
  cache.set(note.id, note);
  await req(db.transaction(STORE, "readwrite").objectStore(STORE).put(note));
  return note;
}

export async function remove(id) {
  cache.delete(id);
  await req(db.transaction(STORE, "readwrite").objectStore(STORE).delete(id));
  await req(db.transaction(FILES, "readwrite").objectStore(FILES).delete(id));
  await req(db.transaction(FILES, "readwrite").objectStore(FILES).delete(`${id}:fiche`));
}

// ───────── Fichiers (PDF originaux) ─────────

export async function saveFile(id, blob) {
  await req(db.transaction(FILES, "readwrite").objectStore(FILES).put(blob, id));
}

export async function getFile(id) {
  return req(db.transaction(FILES).objectStore(FILES).get(id));
}

export async function removeFile(id) {
  await req(db.transaction(FILES, "readwrite").objectStore(FILES).delete(id));
}

export async function clearFiles() {
  await req(db.transaction(FILES, "readwrite").objectStore(FILES).clear());
}

export function create({ type = "notion", title = "", content = "", parentId = null, tags = [], source = null, formationId = scope } = {}) {
  const now = Date.now();
  return { id: uid(), type, title, content, parentId, tags, source, formationId, createdAt: now, updatedAt: now };
}

export async function replaceAll(notes, formationList = formations()) {
  const tx = db.transaction([STORE, FSTORE], "readwrite");
  const store = tx.objectStore(STORE);
  const fstore = tx.objectStore(FSTORE);
  store.clear();
  fstore.clear();
  notes.forEach((n) => store.put(n));
  formationList.forEach((f) => fstore.put(f));
  await new Promise((res, rej) => { tx.oncomplete = res; tx.onerror = () => rej(tx.error); });
  cache.clear();
  fcache.clear();
  notes.forEach((n) => cache.set(n.id, n));
  formationList.forEach((f) => fcache.set(f.id, f));
}

// ───────── Liens ─────────
// Une note est reliée à une autre par : [[Titre]] dans le texte, ou le champ parentId (cours parent).

const LINK_RE = /\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g;

export function outgoingTitles(note) {
  const out = new Set();
  for (const m of note.content.matchAll(LINK_RE)) out.add(m[1].trim());
  return [...out];
}

export function outgoing(note) {
  return outgoingTitles(note).map(byTitle).filter(Boolean).filter((n) => n.id !== note.id);
}

export function backlinks(note) {
  const t = note.title.trim().toLowerCase();
  if (!t) return [];
  return all().filter(
    (n) => n.id !== note.id && outgoingTitles(n).some((x) => x.toLowerCase() === t)
  );
}

// Ordre choisi par l'utilisateur (champ "order"), sinon ordre de création : les nouveautés arrivent en dernier.
export const byOrder = (a, b) => (a.order ?? a.createdAt) - (b.order ?? b.createdAt) || a.createdAt - b.createdAt;

export function children(id) {
  return everything().filter((n) => n.parentId === id).sort(byOrder);
}

// Enregistre un nouvel ordre pour une liste de notes (cours d'une formation, ou chapitres d'un cours).
export async function reorder(list) {
  for (const [i, n] of list.entries()) {
    if (n.order === i) continue;
    n.order = i;
    cache.set(n.id, n);
    await req(db.transaction(STORE, "readwrite").objectStore(STORE).put(n));
  }
}

export function edges() {
  const inScope = new Set(all().map((n) => n.id));
  const list = [];
  const seen = new Set();
  const add = (a, b, kind) => {
    if (!inScope.has(a) || !inScope.has(b)) return;
    const k = [a, b].sort().join("|");
    if (seen.has(k)) return;
    seen.add(k);
    list.push({ source: a, target: b, kind });
  };
  for (const n of all()) {
    if (n.parentId) add(n.parentId, n.id, "parent");
    for (const o of outgoing(n)) add(n.id, o.id, "link");
  }
  return list;
}

// ───────── Tableau de bord (pilotage) ─────────
// Un seul magasin pour tout : chaque élément a un "kind" (task, project, event, memo, postit).

export function pilot(kind) {
  const list = [...pcache.values()];
  return kind ? list.filter((x) => x.kind === kind) : list;
}

export function getPilot(id) {
  return pcache.get(id);
}

export async function savePilot(item) {
  item.updatedAt = Date.now();
  item.createdAt ??= item.updatedAt;
  item.id ??= uid();
  pcache.set(item.id, item);
  await req(db.transaction(PILOT, "readwrite").objectStore(PILOT).put(item));
  return item;
}

export async function removePilot(id) {
  pcache.delete(id);
  await req(db.transaction(PILOT, "readwrite").objectStore(PILOT).delete(id));
}

export async function clearPilot() {
  pcache.clear();
  await req(db.transaction(PILOT, "readwrite").objectStore(PILOT).clear());
}
