// IA : appels directs depuis le navigateur (clés stockées sur cet appareil uniquement).
// Deux fournisseurs : Google Gemini (offre gratuite, par défaut) ou Claude (payant, optionnel).

export const PROVIDERS = {
  gemini: { label: "Google Gemini — gratuit", keyUrl: "https://aistudio.google.com/apikey", keyHint: "AIza…" },
  claude: { label: "Claude (Anthropic) — payant à l'usage", keyUrl: "https://console.anthropic.com/settings/keys", keyHint: "sk-ant-…" },
};

export const GEMINI_MODELS = [
  { id: "gemini-flash-lite-latest", label: "Gemini Flash-Lite — le plus de requêtes gratuites/jour (recommandé)" },
  { id: "gemini-flash-latest", label: "Gemini Flash — plus fort, mais quota gratuit plus petit" },
];

export const CLAUDE_MODELS = [
  { id: "claude-opus-5-5", label: "Claude Opus 5.5 — le plus fort" },
  { id: "claude-sonnet-5-5", label: "Claude Sonnet 5.5 — rapide et solide" },
  { id: "claude-haiku-5-5", label: "Claude Haiku 5.5 — ultra rapide, très économique" },
];

const KEY = "synapse.settings";
const DEFAULTS = { provider: "gemini", geminiKey: "", geminiModel: GEMINI_MODELS[0].id, apiKey: "", model: CLAUDE_MODELS[0].id };

export function settings() {
  try {
    return { ...DEFAULTS, ...JSON.parse(localStorage.getItem(KEY) || "{}") };
  } catch {
    return { ...DEFAULTS };
  }
}

export function saveSettings(s) {
  try { localStorage.setItem(KEY, JSON.stringify({ ...settings(), ...s })); } catch {}
}

export const hasKey = () => {
  const s = settings();
  return s.provider === "claude" ? !!s.apiKey : !!s.geminiKey;
};

// Taille max d'un PDF envoyé directement dans la requête.
export const maxPdfBytes = () => (settings().provider === "claude" ? 24 : 18) * 1024 * 1024;

const SYSTEM = `Tu es le tuteur personnel d'un·e étudiant·e en formation tech, intégré à son application de notes "Synapse".
Tu réponds toujours en français, en Markdown propre (titres ##, listes, tableaux, blocs de code avec le langage).
Ton but : faire vraiment comprendre, pas réciter. Pars de ce que l'étudiant·e a écrit, corrige les erreurs avec tact,
donne l'intuition avant le formalisme, utilise des analogies et des exemples de code courts et exécutables quand c'est pertinent.
Quand tu mentionnes une notion qui mérite sa propre fiche, écris-la sous forme de lien wiki [[Nom de la notion]].`;

class AIError extends Error {
  constructor(message, status) { super(message); this.status = status; }
}

// messages : [{ role: "user" | "assistant", text, pdf?: base64 }]
// Lance un stream, appelle onText(texteComplet) à chaque morceau, retourne le texte final.
async function run(opts) {
  if (!hasKey()) throw new Error("NO_KEY");
  return settings().provider === "claude" ? runClaude(opts) : runGemini(opts);
}

// ───────── Gemini (REST + SSE) ─────────

async function runGemini({ messages, onText, signal }) {
  const { geminiKey, geminiModel } = settings();
  const contents = messages.map((m) => ({
    role: m.role === "assistant" ? "model" : "user",
    parts: [
      ...(m.pdf ? [{ inline_data: { mime_type: "application/pdf", data: m.pdf } }] : []),
      { text: m.text },
    ],
  }));
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(geminiModel)}:streamGenerateContent?alt=sse`,
    {
      method: "POST",
      signal,
      headers: { "content-type": "application/json", "x-goog-api-key": geminiKey },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: SYSTEM }] },
        contents,
        generationConfig: { maxOutputTokens: 32768 },
      }),
    }
  );
  if (!res.ok) {
    let msg = "";
    try { msg = (await res.json())?.error?.message || ""; } catch {}
    throw new AIError(msg, res.status);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "", text = "", finish = null, blocked = null;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const lines = buf.split(/\r?\n/);
    buf = lines.pop();
    for (const line of lines) {
      if (!line.startsWith("data:")) continue;
      let chunk;
      try { chunk = JSON.parse(line.slice(5)); } catch { continue; }
      blocked = chunk.promptFeedback?.blockReason || blocked;
      const cand = chunk.candidates?.[0];
      if (cand?.finishReason) finish = cand.finishReason;
      const parts = cand?.content?.parts || [];
      // Ignore les "pensées" internes du modèle, ne garde que la réponse.
      const delta = parts.filter((p) => p.text && !p.thought).map((p) => p.text).join("");
      if (delta) { text += delta; onText?.(text); }
    }
  }
  if (blocked || (!text && ["SAFETY", "PROHIBITED_CONTENT", "BLOCKLIST", "RECITATION"].includes(finish))) {
    throw new Error("Gemini a bloqué cette demande (filtre de sécurité). Reformule ta question.");
  }
  if (!text) throw new Error("Réponse vide de Gemini. Réessaie, ou change de modèle dans Réglages.");
  if (finish === "MAX_TOKENS") text += "\n\n_(réponse coupée : trop longue)_";
  return text;
}

// Liste les modèles Gemini accessibles avec la clé (pour le menu des réglages).
export async function listGeminiModels(key) {
  const res = await fetch("https://generativelanguage.googleapis.com/v1beta/models?pageSize=200", {
    headers: { "x-goog-api-key": key },
  });
  if (!res.ok) throw new AIError("", res.status);
  const data = await res.json();
  return (data.models || [])
    .filter((m) => m.supportedGenerationMethods?.includes("generateContent") && /gemini/i.test(m.name) && !/embedding|image|tts|audio|live/i.test(m.name))
    .map((m) => ({ id: m.name.replace(/^models\//, ""), label: m.displayName || m.name }));
}

// ───────── Claude (SDK officiel, chargé seulement si utilisé) ─────────

async function runClaude({ messages, effort = "medium", onText, signal }) {
  const { default: Anthropic } = await import("https://cdn.jsdelivr.net/npm/@anthropic-ai/sdk@0.131.0/+esm");
  const { apiKey, model } = settings();
  const c = new Anthropic({ apiKey, dangerouslyAllowBrowser: true });
  const params = {
    model,
    max_tokens: 64000,
    system: SYSTEM,
    messages: messages.map((m) => ({
      role: m.role,
      content: m.pdf
        ? [{ type: "document", source: { type: "base64", media_type: "application/pdf", data: m.pdf } }, { type: "text", text: m.text }]
        : m.text,
    })),
    output_config: { effort },
  };
  // Opus et Sonnet : si un filtre de sécurité refuse à tort, l'API relance sur un autre modèle.
  const stream = model !== "claude-haiku-5-5"
    ? c.beta.messages.stream({ ...params, betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" }, { signal })
    : c.messages.stream(params, { signal });

  let text = "";
  stream.on("text", (delta) => { text += delta; onText?.(text); });
  const msg = await stream.finalMessage();
  if (msg.stop_reason === "refusal") throw new Error("L'IA a refusé cette demande. Reformule ta question ou essaie un autre modèle.");
  if (msg.stop_reason === "max_tokens") text += "\n\n_(réponse coupée : trop longue)_";
  return text;
}

// ───────── Erreurs lisibles ─────────

export function friendlyError(e) {
  const gem = settings().provider !== "claude";
  if (e?.message === "NO_KEY") return `Ajoute ta clé ${gem ? "Gemini (gratuite)" : "Claude"} dans Réglages pour utiliser l'IA.`;
  if (e?.name === "AbortError") return "Annulé.";
  const s = e?.status;
  if (s === 400 && gem && /api key/i.test(e.message)) return "Clé Gemini invalide. Vérifie-la dans Réglages.";
  if (s === 401 || (s === 403 && !gem)) return "Clé API invalide. Vérifie-la dans Réglages.";
  if (s === 403) return "Clé refusée par Google (API non activée ou clé restreinte). Recrée une clé sur aistudio.google.com.";
  if (s === 404) return "Ce modèle n'existe pas ou plus. Dans Réglages, clique « Charger mes modèles » et choisis-en un autre.";
  if (s === 429) return gem
    ? "Quota gratuit atteint pour ce modèle. Attends un peu (le quota se recharge chaque minute / chaque jour) ou choisis un autre modèle (ex : Flash-Lite) dans Réglages."
    : "Trop de requêtes ou crédit épuisé. Vérifie ton solde sur console.anthropic.com.";
  if (s === 413) return "Fichier trop volumineux pour l'IA.";
  if (s >= 500) return "Le service d'IA est momentanément indisponible. Réessaie dans un instant.";
  return e?.message || "Erreur inconnue.";
}

// ───────── Décortiquer un cours ─────────

const MODE_PROMPTS = {
  deep: `Décortique ce contenu EN PROFONDEUR :
1. L'idée centrale en 2 phrases.
2. Chaque concept important, un par un : ce que c'est, pourquoi ça existe, comment ça marche sous le capot.
3. Les liens entre ces concepts (qu'est-ce qui dépend de quoi).
4. Un exemple complet commenté.
5. Les erreurs et confusions classiques.
6. Un résumé en 5 points à retenir.`,
  simple: `Explique ce contenu comme à quelqu'un qui débute totalement : zéro jargon non expliqué, une analogie de la vie quotidienne par concept, phrases courtes. Termine par "En une phrase :" et le résumé ultra court.`,
  examples: `Donne 3 exemples concrets et progressifs (facile → réaliste, type projet de formation) qui illustrent ce contenu. Pour chacun : le contexte, le code ou la démarche commentée, et ce que ça montre.`,
  quiz: `Crée un quiz de révision sur ce contenu : 6 questions (QCM, vrai/faux, et 2 questions ouvertes "explique pourquoi"), de difficulté croissante. Mets les réponses avec une courte explication à la fin, sous un titre "## Réponses".`,
  gaps: `Analyse ces notes comme un·e formateur·rice : qu'est-ce qui est faux, flou ou incomplet ? Quelles notions importantes manquent pour bien maîtriser le sujet ? Propose les compléments à ajouter, prêts à copier.`,
};

export const MODE_LABELS = {
  deep: "Décortique en profondeur",
  simple: "Explique simplement",
  examples: "Exemples concrets",
  quiz: "Quiz moi",
  gaps: "Ce qui manque dans mes notes",
};

export function contextBlock(note, parent, linked) {
  let ctx = `<note type="${note.type}" titre="${note.title || "Sans titre"}">\n${note.content || "(vide)"}\n</note>`;
  if (note.ficheText) ctx += `\n\n<ma_fiche fichier="${note.fiche?.name || ""}">\n${note.ficheText.slice(0, 60000)}\n</ma_fiche>`;
  if (note.text) ctx += `\n\n<texte_du_pdf fichier="${note.source?.name || ""}">\n${note.text.slice(0, 80000)}\n</texte_du_pdf>`;
  if (parent) ctx += `\n\n<cours_parent titre="${parent.title}">\n${parent.content.slice(0, 20000)}\n</cours_parent>`;
  if (linked.length) ctx += `\n\nNotions reliées dans ses notes : ${linked.map((n) => n.title).join(", ")}.`;
  return ctx;
}

// history : [{role, text}] déjà échangés sur cette note.
export async function ask({ context, history, mode, question, onText, signal }) {
  const instruction = mode ? MODE_PROMPTS[mode] : question;
  const messages = [];
  if (!history.length) {
    messages.push({ role: "user", text: `Voici le contenu de mes notes :\n\n${context}\n\n${instruction}` });
  } else {
    // Le contexte est dans le premier message ; on enchaîne la conversation.
    messages.push(...history, { role: "user", text: instruction });
  }
  const text = await run({ messages, effort: mode === "deep" ? "high" : "medium", onText, signal });
  return { text, sent: messages[messages.length - 1] };
}

// ───────── PDF → fiche ─────────

function toBase64(buf) {
  const bytes = new Uint8Array(buf);
  let bin = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) bin += String.fromCharCode(...bytes.subarray(i, i + chunk));
  return btoa(bin);
}

export async function pdfToFiche({ file, existingTitles, extra, onText, signal }) {
  const data = toBase64(await file.arrayBuffer());
  const known = existingTitles.length
    ? `\nNotions/notes qui existent déjà dans ma base (réutilise exactement ces titres dans les liens quand c'est le même sujet) : ${existingTitles.slice(0, 300).join(" ; ")}.`
    : "";
  const prompt = `Transforme ce document PDF ("${file.name}") en FICHE SYNTHÈSE de révision.

Format exigé (Markdown) :
# <Titre clair de la fiche>

> L'essentiel en 2-3 phrases.

## Notions clés
- [[Nom de la notion]] — définition en une ligne (une puce par notion importante)

## Le cours, structuré
(sections ## / ### qui reprennent la logique du document, reformulée et condensée ; garde les définitions, règles, formules, et le code important dans des blocs de code)

## Exemples
## Pièges à éviter
## À retenir
(5 à 8 puces)

## Questions de révision
(5 questions, réponses dans un bloc <details><summary>Réponses</summary>…</details>)

Règles : sois fidèle au document, n'invente pas, n'omets aucune notion importante. Mets chaque notion clé en lien wiki [[...]] avec un nom court et réutilisable (ex : [[Closure]], [[Requête HTTP]]).${known}${extra ? `\n\nConsigne en plus : ${extra}` : ""}`;

  const messages = [{ role: "user", text: prompt, pdf: data }];
  return run({ messages, effort: "high", onText, signal });
}

// ───────── Quiz ─────────
// Questions à choix (QCM / vrai-faux) en JSON structuré, corrigées automatiquement.
// "avoid" contient les questions déjà posées : l'IA doit en inventer de nouvelles.

const ANGLES = [
  "définitions précises", "cas pratiques et mises en situation", "prédire le résultat d'un bout de code",
  "pièges et erreurs fréquentes", "comparer deux notions proches", "le pourquoi derrière une règle",
  "repérer l'erreur dans un exemple", "ordre des étapes d'un processus", "cas limites", "vocabulaire et syntaxe",
];

const shuffle = (arr) => {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
};

const QUIZ_SCHEMA_JSON = {
  type: "object",
  additionalProperties: false,
  required: ["questions"],
  properties: {
    questions: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["question", "choices", "answer", "explanation", "source"],
        properties: {
          question: { type: "string" },
          choices: { type: "array", items: { type: "string" } },
          answer: { type: "integer" },
          explanation: { type: "string" },
          source: { type: "string" },
        },
      },
    },
  },
};

const QUIZ_SCHEMA_GEMINI = {
  type: "OBJECT",
  required: ["questions"],
  properties: {
    questions: {
      type: "ARRAY",
      items: {
        type: "OBJECT",
        required: ["question", "choices", "answer", "explanation", "source"],
        properties: {
          question: { type: "STRING" },
          choices: { type: "ARRAY", items: { type: "STRING" } },
          answer: { type: "INTEGER" },
          explanation: { type: "STRING" },
          source: { type: "STRING" },
        },
      },
    },
  },
};

const DIFFICULTY = {
  facile: "faciles (vérifier les bases)",
  moyen: "de difficulté moyenne (comprendre, pas juste mémoriser)",
  difficile: "difficiles (application, cas pièges, raisonnement)",
  mix: "de difficulté croissante, du facile au difficile",
};

// notes : [{ title, content, text }]
export async function generateQuiz({ notes, count = 10, difficulty = "mix", avoid = [], signal }) {
  if (!hasKey()) throw new Error("NO_KEY");
  const budget = Math.floor(120000 / Math.max(notes.length, 1));
  const material = notes.map((n) => {
    let body = [
      n.content,
      n.ficheText && `--- Ma fiche ---\n${n.ficheText}`,
      n.text && `--- Texte du PDF du cours ---\n${n.text}`,
    ].filter((x) => x && x.trim()).join("\n\n");
    // Pour un long document, on part d'un endroit au hasard pour varier les questions.
    if (body.length > budget) {
      const start = Math.floor(Math.random() * (body.length - budget));
      body = "…" + body.slice(start, start + budget) + "…";
    }
    return `<fiche titre="${n.title}">\n${body || "(vide)"}\n</fiche>`;
  }).join("\n\n");
  const angles = shuffle(ANGLES).slice(0, 3);
  const prompt = `Voici des fiches de cours :

${material}

Crée un quiz de ${count} questions ${DIFFICULTY[difficulty] || DIFFICULTY.mix}, en français, basées UNIQUEMENT sur ces fiches.
- Mélange QCM (4 choix) et vrai/faux (choix exactement ["Vrai", "Faux"]).
- "answer" = index (à partir de 0) de la bonne réponse dans "choices". Une seule bonne réponse, les mauvaises doivent être plausibles.
- "explanation" : 1 à 3 phrases qui expliquent pourquoi, utile pour réviser.
- "source" : le titre exact de la fiche d'où vient la question.
- Répartis les questions sur les différentes fiches et sur des parties variées de chaque fiche.
- Cette fois, privilégie ces angles : ${angles.join(", ")}.
- Graine d'aléatoire (pour varier) : ${Math.random().toString(36).slice(2, 8)}.
${avoid.length ? `\nQuestions DÉJÀ posées lors des quiz précédents : n'en repose AUCUNE, ni une reformulation qui teste la même chose. Trouve d'autres choses à demander.\n${avoid.slice(-150).map((q) => `- ${q}`).join("\n")}` : ""}`;

  const text = settings().provider === "claude" ? await quizClaude(prompt, signal) : await quizGemini(prompt, signal);
  let data;
  try { data = JSON.parse(text); } catch { throw new Error("Le quiz reçu est illisible. Réessaie."); }
  const seen = new Set(avoid.map((q) => q.trim().toLowerCase()));
  return (data.questions || [])
    .filter((q) => q.question && Array.isArray(q.choices) && q.choices.length >= 2 && q.answer >= 0 && q.answer < q.choices.length)
    .filter((q) => !seen.has(q.question.trim().toLowerCase()))
    .map((q) => {
      // Mélange l'ordre des choix (sauf vrai/faux) pour que la bonne réponse ne soit pas toujours au même endroit.
      if (q.choices.length === 2 && /^vrai$/i.test(q.choices[0])) return q;
      const order = shuffle(q.choices.map((_, i) => i));
      return { ...q, choices: order.map((i) => q.choices[i]), answer: order.indexOf(q.answer) };
    });
}

async function quizGemini(prompt, signal) {
  const { geminiKey, geminiModel } = settings();
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(geminiModel)}:generateContent`,
    {
      method: "POST", signal,
      headers: { "content-type": "application/json", "x-goog-api-key": geminiKey },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: SYSTEM }] },
        contents: [{ role: "user", parts: [{ text: prompt }] }],
        generationConfig: { responseMimeType: "application/json", responseSchema: QUIZ_SCHEMA_GEMINI, maxOutputTokens: 16384 },
      }),
    }
  );
  if (!res.ok) {
    let msg = "";
    try { msg = (await res.json())?.error?.message || ""; } catch {}
    throw new AIError(msg, res.status);
  }
  const data = await res.json();
  const parts = data.candidates?.[0]?.content?.parts || [];
  const text = parts.filter((p) => p.text && !p.thought).map((p) => p.text).join("");
  if (!text) throw new Error("Gemini n'a pas renvoyé de quiz. Réessaie.");
  return text;
}

async function quizClaude(prompt, signal) {
  const { default: Anthropic } = await import("https://cdn.jsdelivr.net/npm/@anthropic-ai/sdk@0.131.0/+esm");
  const { apiKey, model } = settings();
  const c = new Anthropic({ apiKey, dangerouslyAllowBrowser: true });
  const params = {
    model, max_tokens: 16000, system: SYSTEM,
    messages: [{ role: "user", content: prompt }],
    output_config: { effort: "low", format: { type: "json_schema", schema: QUIZ_SCHEMA_JSON } },
  };
  const msg = model !== "claude-haiku-5-5"
    ? await c.beta.messages.create({ ...params, betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" }, { signal })
    : await c.messages.create(params, { signal });
  if (msg.stop_reason === "refusal") throw new Error("L'IA a refusé de générer ce quiz.");
  return msg.content.filter((b) => b.type === "text").map((b) => b.text).join("");
}
