// Fiches synthèse "maison" : on attache ses propres fiches (Markdown, texte, HTML, Word ou PDF)
// à un chapitre, au lieu de les faire générer par l'IA.

import * as DB from "./db.js";
import { extractText } from "./pdf.js";
import { norm } from "./search.js";

export const FICHE_ACCEPT = ".md,.markdown,.txt,.html,.htm,.docx,.pdf";
export const isFicheFile = (name) => /\.(md|markdown|txt|html?|docx|pdf)$/i.test(name);

// Mots qui signalent qu'un fichier est une fiche et pas le cours lui-même.
const FICHE_WORDS = /\b(fiches?|synth[eè]ses?|r[eé]sum[eé]s?|summar(?:y|ies)|revisions?|cheat ?sheets?|notes?)\b/gi;
export const FICHE_DIR = /^(fiches?|synth[eè]ses?|r[eé]sum[eé]s?|summar(?:y|ies)|revisions?)$/i;

// Clé de correspondance : "Chapter 1 - Fiche.md" et "Chapter 1.pdf" donnent toutes les deux "chapter 1".
export function chapKey(name) {
  return norm(name.replace(/\.[^.]+$/, "").replace(FICHE_WORDS, " ")).replace(/[^a-z0-9]+/g, " ").trim();
}

export function looksLikeFiche(name) {
  FICHE_WORDS.lastIndex = 0;
  return FICHE_WORDS.test(name.replace(/\.[^.]+$/, ""));
}

let mammothLoading;
function mammoth() {
  if (window.mammoth) return Promise.resolve(window.mammoth);
  mammothLoading ??= new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = "https://cdn.jsdelivr.net/npm/mammoth@1.12.3/mammoth.browser.min.js";
    s.onload = () => resolve(window.mammoth);
    s.onerror = () => reject(new Error("Impossible de charger le lecteur Word"));
    document.head.appendChild(s);
  });
  return mammothLoading;
}

// Attache le fichier à la note. Retourne false si la note a déjà une fiche et replace = false.
export async function attachFiche(note, file, { replace = true } = {}) {
  if (!replace && hasFiche(note)) return false;
  const name = file.name;
  if (/\.pdf$/i.test(name)) {
    await DB.saveFile(`${note.id}:fiche`, file);
    let text = "";
    try { text = (await extractText(file)).text; } catch (e) { console.warn("Lecture de la fiche PDF impossible", e); }
    note.fiche = { name, kind: "pdf" };
    note.ficheText = text;
  } else {
    let content;
    if (/\.docx$/i.test(name)) {
      const m = await mammoth();
      content = (await m.convertToHtml({ arrayBuffer: await file.arrayBuffer() })).value;
    } else if (/\.html?$/i.test(name)) {
      const doc = new DOMParser().parseFromString(await file.text(), "text/html");
      doc.querySelectorAll("script, style, link, meta").forEach((el) => el.remove());
      content = doc.body.innerHTML.trim();
    } else {
      content = await file.text();
    }
    note.content = content.trim();
    note.fiche = { name, kind: "texte" };
    delete note.ficheText;
  }
  note.tags = [...new Set([...(note.tags || []), "ma-fiche"])];
  await DB.save(note);
  return true;
}

export function hasFiche(note) {
  return !!(note.fiche || note.content.trim());
}

export async function detachFiche(note) {
  if (note.fiche?.kind === "pdf") {
    await DB.removeFile(`${note.id}:fiche`);
  } else if (note.fiche) {
    note.content = "";
  }
  delete note.fiche;
  delete note.ficheText;
  note.tags = (note.tags || []).filter((t) => t !== "ma-fiche");
  await DB.save(note);
}
