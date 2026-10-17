// Recherche plein texte : insensible aux accents et à la casse, plusieurs mots,
// titre > tags > contenu, avec extrait surligné.

import * as DB from "./db.js";

export const norm = (s) =>
  (s || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();

const esc = (s) =>
  s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

function plain(md) {
  return md
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (_, a, b) => b || a)
    .replace(/[#>*_`~\-|]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function highlight(text, terms) {
  let html = esc(text);
  for (const t of terms) {
    if (!t) continue;
    // Surligne sans tenir compte des accents en cherchant dans la version normalisée.
    const n = norm(html);
    let out = "", i = 0, idx;
    while ((idx = n.indexOf(t, i)) !== -1) {
      out += html.slice(i, idx) + "<mark>" + html.slice(idx, idx + t.length) + "</mark>";
      i = idx + t.length;
    }
    html = out + html.slice(i);
  }
  return html;
}

export function search(query, filter = "all", everywhere = false) {
  const terms = norm(query).split(/\s+/).filter(Boolean);
  let notes = everywhere ? DB.everything() : DB.all();
  if (filter !== "all") notes = notes.filter((n) => n.type === filter);

  if (!terms.length) {
    return notes
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, 30)
      .map((n) => ({ note: n, snippet: esc(plain(n.content).slice(0, 140)), titleHtml: esc(n.title || "Sans titre") }));
  }

  const results = [];
  for (const n of notes) {
    const title = norm(n.title);
    const tags = norm(n.tags.join(" "));
    const body = plain([n.content, n.ficheText, n.text].filter(Boolean).join(" "));
    const nb = norm(body);
    let score = 0;
    let ok = true;
    for (const t of terms) {
      let s = 0;
      if (title === t) s += 40;
      if (title.startsWith(t)) s += 15;
      if (title.includes(t)) s += 20;
      if (tags.includes(t)) s += 10;
      const c = nb.split(t).length - 1;
      if (c) s += Math.min(c, 10) * 2;
      if (!s) { ok = false; break; }
      score += s;
    }
    if (!ok) continue;
    // Extrait autour de la première occurrence dans le contenu.
    const first = nb.indexOf(terms[0]);
    const start = Math.max(0, first - 50);
    const raw = first >= 0 ? (start ? "…" : "") + body.slice(start, start + 170) + "…" : body.slice(0, 140);
    results.push({
      note: n,
      score: score + n.updatedAt / 1e14,
      snippet: highlight(raw, terms),
      titleHtml: highlight(n.title || "Sans titre", terms),
    });
  }
  return results.sort((a, b) => b.score - a.score).slice(0, 40);
}
