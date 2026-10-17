// Lecture locale des PDF (pdf.js) : extrait le texte sans IA, donc sans quota.
// Le texte rend le PDF cherchable et lisible par l'assistant immédiatement.

const BASE = "https://cdn.jsdelivr.net/npm/pdfjs-dist@5.4.624/build/";
let lib;

async function pdfjs() {
  if (lib) return lib;
  lib = await import(BASE + "pdf.min.mjs");
  // Un worker venant d'un autre domaine est bloqué : on l'enveloppe dans un blob local.
  const shim = URL.createObjectURL(new Blob([`import "${BASE}pdf.worker.min.mjs";`], { type: "text/javascript" }));
  lib.GlobalWorkerOptions.workerPort = new Worker(shim, { type: "module" });
  return lib;
}

export async function extractText(blob) {
  const { getDocument } = await pdfjs();
  const doc = await getDocument({ data: new Uint8Array(await blob.arrayBuffer()) }).promise;
  const pages = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const content = await page.getTextContent();
    let text = "";
    for (const item of content.items) {
      if (!("str" in item)) continue;
      text += item.str + (item.hasEOL ? "\n" : " ");
    }
    pages.push(text.replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim());
    page.cleanup();
  }
  const pageCount = doc.numPages;
  await doc.destroy();
  const text = pages.map((t, i) => (t ? `--- Page ${i + 1} ---\n${t}` : "")).filter(Boolean).join("\n\n");
  return { text, pages: pageCount };
}
