// Agent : une IA qui a accès à toute ta base de notes via des outils
// (lister, chercher, lire, créer une fiche) et enchaîne les étapes toute seule.

import * as DB from "./db.js";
import { search } from "./search.js";
import { settings, hasKey } from "./ai.js";

const MAX_STEPS = 12;

const SYSTEM_BASE = `Tu es l'assistant de révision d'un·e étudiant·e en formation tech, intégré à son application de notes "Synapse".
Tu as accès à TOUTE sa base de notes via des outils : des cours (ce qui a été noté pendant une journée/un module),
des notions (concepts précis) et des fiches (synthèses). Les cours (souvent des modules) contiennent des notions et des fiches.
Certaines fiches sont des chapitres importés en PDF : read_note renvoie alors le texte du PDF (pdf_text), même si la synthèse n'est pas encore écrite.

Méthode :
- Avant de répondre sur le contenu des cours, va LIRE les notes concernées avec les outils (list_notes, search_notes, read_note).
  Ne devine jamais ce qu'il y a dans ses notes.
- Pour un résumé d'un cours, lis le cours ET ses notions/fiches.
- Appuie-toi d'abord sur ses notes ; si tu ajoutes des connaissances extérieures pour compléter ou corriger, signale-le ("En complément :").
- N'appelle create_fiche que si l'étudiant·e demande explicitement de créer / enregistrer / sauvegarder une fiche.

Réponds toujours en français, en Markdown clair (titres ##, listes, tableaux, blocs de code).
Quand tu cites une note de sa base, écris son titre exact entre double crochets, ex : [[Fonction]], pour qu'il soit cliquable.
`;

// La formation active (onglet) délimite les notes que l'agent voit.
function systemPrompt() {
  const f = DB.getFormation(DB.getScope());
  return `${SYSTEM_BASE}
Formation active : « ${f?.name || "?"} ». Les outils ne voient que les notes de cette formation : réponds dans ce cadre.
Date du jour : ${new Date().toLocaleDateString("fr-FR", { weekday: "long", day: "numeric", month: "long", year: "numeric" })}.`;
}

// ───────── Outils ─────────

const TOOLS = [
  {
    name: "list_notes",
    description: "Liste les notes de la base (titre, id, type, cours parent, dates, taille). Utile pour avoir une vue d'ensemble ou trouver les notes d'un cours ou d'une période.",
    parameters: {
      type: "object",
      properties: {
        type: { type: "string", enum: ["cours", "notion", "fiche", "all"], description: "Filtrer par type (défaut : all)" },
        course_id: { type: "string", description: "Ne garder que les notes rattachées à ce cours (id)" },
      },
    },
  },
  {
    name: "search_notes",
    description: "Recherche plein texte dans les titres, tags et contenus. Renvoie les meilleures notes avec un extrait.",
    parameters: {
      type: "object",
      properties: { query: { type: "string", description: "Mots-clés à chercher" } },
      required: ["query"],
    },
  },
  {
    name: "read_note",
    description: "Lit le contenu complet d'une note (Markdown), avec ses liens et, pour un cours, la liste de ses notes enfants.",
    parameters: {
      type: "object",
      properties: { id: { type: "string", description: "id de la note (obtenu via list_notes ou search_notes)" } },
      required: ["id"],
    },
  },
  {
    name: "create_fiche",
    description: "Crée une nouvelle fiche dans la base. Seulement si l'étudiant·e le demande explicitement.",
    parameters: {
      type: "object",
      properties: {
        title: { type: "string", description: "Titre de la fiche" },
        content: { type: "string", description: "Contenu Markdown complet de la fiche" },
        course_id: { type: "string", description: "id du cours où ranger la fiche (optionnel)" },
      },
      required: ["title", "content"],
    },
  },
];

const day = (t) => new Date(t).toISOString().slice(0, 10);
const titleOf = (id) => DB.get(id)?.title || null;

async function execTool(name, args = {}) {
  switch (name) {
    case "list_notes": {
      let list = DB.all();
      if (args.type && args.type !== "all") list = list.filter((n) => n.type === args.type);
      if (args.course_id) list = list.filter((n) => n.parentId === args.course_id || n.id === args.course_id);
      return {
        count: list.length,
        notes: list
          .sort(DB.byOrder)
          .slice(0, 300)
          .map((n) => ({
            id: n.id, title: n.title || "Sans titre", type: n.type,
            course: n.parentId ? titleOf(n.parentId) : null, course_id: n.parentId,
            created: day(n.createdAt), updated: day(n.updatedAt), chars: n.content.length, tags: n.tags,
            pdf: n.source?.kind === "pdf" ? n.source.name : undefined,
            synthesized: n.source?.kind === "pdf" ? !!(n.content.trim() || n.fiche) : undefined,
          })),
      };
    }
    case "search_notes": {
      const strip = (h) => h.replace(/<\/?mark>/g, "").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"');
      return {
        results: search(args.query || "").slice(0, 10).map((r) => ({
          id: r.note.id, title: r.note.title, type: r.note.type,
          course: r.note.parentId ? titleOf(r.note.parentId) : null, snippet: strip(r.snippet),
        })),
      };
    }
    case "read_note": {
      const n = DB.get(args.id) || DB.byTitle(args.id || "");
      if (!n) return { error: "Note introuvable. Utilise list_notes ou search_notes pour trouver l'id." };
      return {
        id: n.id, title: n.title, type: n.type, tags: n.tags,
        course: n.parentId ? titleOf(n.parentId) : null,
        created: day(n.createdAt), updated: day(n.updatedAt),
        content: n.content.length > 40000 ? n.content.slice(0, 40000) + "\n…(tronqué)" : n.content,
        pdf_file: n.source?.kind === "pdf" ? n.source.name : undefined,
        my_fiche: n.fiche ? n.fiche.name : undefined,
        my_fiche_text: n.ficheText ? n.ficheText.slice(0, 60000) : undefined,
        pdf_text: n.text ? (n.text.length > 60000 ? n.text.slice(0, 60000) + "\n…(tronqué)" : n.text) : undefined,
        links_to: DB.outgoing(n).map((o) => ({ id: o.id, title: o.title })),
        mentioned_in: DB.backlinks(n).map((o) => ({ id: o.id, title: o.title })),
        children: n.type === "cours" ? DB.children(n.id).map((c) => ({ id: c.id, title: c.title, type: c.type })) : undefined,
      };
    }
    case "create_fiche": {
      const parentId = args.course_id && DB.get(args.course_id)?.type === "cours" ? args.course_id : null;
      const f = await DB.save(DB.create({ type: "fiche", title: args.title || "Fiche", content: args.content || "", parentId, tags: ["assistant"] }));
      return { ok: true, id: f.id, title: f.title };
    }
    default:
      return { error: `Outil inconnu : ${name}` };
  }
}

// Description lisible d'une étape, affichée dans le chat.
export function describeStep(name, args = {}) {
  switch (name) {
    case "list_notes": return `🗂️ Parcourt ${args.course_id ? `le cours « ${titleOf(args.course_id) || "?"} »` : args.type && args.type !== "all" ? `les ${args.type}s` : "toute la base"}`;
    case "search_notes": return `🔎 Cherche « ${args.query} »`;
    case "read_note": return `📖 Lit « ${titleOf(args.id) || args.id} »`;
    case "create_fiche": return `✍️ Crée la fiche « ${args.title} »`;
    default: return name;
  }
}

// ───────── Boucle d'agent ─────────
// conv : état de conversation propre au fournisseur (gardé entre les messages).
// onStep({ name, args, result }) est appelé à chaque outil utilisé.

export async function runAgent({ conv, userText, onStep, signal }) {
  if (!hasKey()) throw new Error("NO_KEY");
  return settings().provider === "claude"
    ? claudeLoop({ conv, userText, onStep, signal })
    : geminiLoop({ conv, userText, onStep, signal });
}

async function geminiLoop({ conv, userText, onStep, signal }) {
  const { geminiKey, geminiModel } = settings();
  conv.gemini ??= [];
  const contents = conv.gemini;
  contents.push({ role: "user", parts: [{ text: userText }] });

  for (let step = 0; step < MAX_STEPS; step++) {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(geminiModel)}:generateContent`,
      {
        method: "POST", signal,
        headers: { "content-type": "application/json", "x-goog-api-key": geminiKey },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: systemPrompt() }] },
          contents,
          tools: [{ functionDeclarations: TOOLS }],
          generationConfig: { maxOutputTokens: 32768 },
        }),
      }
    );
    if (!res.ok) {
      let msg = "";
      try { msg = (await res.json())?.error?.message || ""; } catch {}
      contents.pop(); // pour pouvoir réessayer proprement
      throw Object.assign(new Error(msg), { status: res.status });
    }
    const data = await res.json();
    const cand = data.candidates?.[0];
    const content = cand?.content;
    if (!content?.parts?.length) {
      contents.pop();
      if (data.promptFeedback?.blockReason || /SAFETY|PROHIBITED/.test(cand?.finishReason || ""))
        throw new Error("Gemini a bloqué cette demande (filtre de sécurité). Reformule.");
      throw new Error("Réponse vide de Gemini. Réessaie.");
    }
    // On renvoie le tour du modèle tel quel (il peut contenir des signatures de pensée nécessaires).
    contents.push({ role: "model", parts: content.parts });

    const calls = content.parts.filter((p) => p.functionCall);
    if (!calls.length) {
      return content.parts.filter((p) => p.text && !p.thought).map((p) => p.text).join("");
    }
    const responses = [];
    for (const p of calls) {
      const { name, args } = p.functionCall;
      const result = await execTool(name, args || {});
      onStep?.({ name, args: args || {}, result });
      responses.push({ functionResponse: { name, response: result } });
    }
    contents.push({ role: "user", parts: responses });
  }
  return "_(J'ai atteint la limite d'étapes. Précise ta demande, par exemple en nommant le cours.)_";
}

async function claudeLoop({ conv, userText, onStep, signal }) {
  const { default: Anthropic } = await import("https://cdn.jsdelivr.net/npm/@anthropic-ai/sdk@0.131.0/+esm");
  const { apiKey, model } = settings();
  const c = new Anthropic({ apiKey, dangerouslyAllowBrowser: true });
  conv.claude ??= [];
  const messages = conv.claude;
  messages.push({ role: "user", content: userText });
  const tools = TOOLS.map((t) => ({ name: t.name, description: t.description, input_schema: t.parameters }));

  for (let step = 0; step < MAX_STEPS; step++) {
    let msg;
    try {
      const params = { model, max_tokens: 32000, system: systemPrompt(), tools, messages, output_config: { effort: "medium" } };
      msg = model !== "claude-haiku-5-5"
        ? await c.beta.messages.create({ ...params, betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" }, { signal })
        : await c.messages.create(params, { signal });
    } catch (e) {
      if (messages.at(-1)?.role === "user" && typeof messages.at(-1).content === "string") messages.pop();
      throw e;
    }
    if (msg.stop_reason === "refusal") throw new Error("L'IA a refusé cette demande. Reformule.");
    messages.push({ role: "assistant", content: msg.content });
    const uses = msg.content.filter((b) => b.type === "tool_use");
    if (msg.stop_reason !== "tool_use" || !uses.length) {
      return msg.content.filter((b) => b.type === "text").map((b) => b.text).join("");
    }
    const results = [];
    for (const u of uses) {
      const result = await execTool(u.name, u.input || {});
      onStep?.({ name: u.name, args: u.input || {}, result });
      results.push({ type: "tool_result", tool_use_id: u.id, content: JSON.stringify(result), is_error: !!result.error });
    }
    messages.push({ role: "user", content: results });
  }
  return "_(J'ai atteint la limite d'étapes. Précise ta demande, par exemple en nommant le cours.)_";
}
