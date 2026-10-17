// Graphe des connexions : simulation de forces minimaliste sur <canvas>.

import * as DB from "./db.js";

const COLORS = { cours: "#a78bfa", notion: "#22d3ee", fiche: "#f472b6" };

export function renderGraph(container, onOpen) {
  container.innerHTML = `
    <div class="graph-wrap">
      <canvas></canvas>
      <div class="graph-legend">
        <span><i style="background:${COLORS.cours}"></i>Cours</span>
        <span><i style="background:${COLORS.notion}"></i>Notions</span>
        <span><i style="background:${COLORS.fiche}"></i>Fiches</span>
      </div>
      <div class="graph-hint">Clique sur un point pour ouvrir · glisse pour déplacer · molette pour zoomer</div>
    </div>`;
  const canvas = container.querySelector("canvas");
  const ctx = canvas.getContext("2d");
  const notes = DB.all();
  const edges = DB.edges();

  const deg = new Map();
  edges.forEach((e) => {
    deg.set(e.source, (deg.get(e.source) || 0) + 1);
    deg.set(e.target, (deg.get(e.target) || 0) + 1);
  });

  const nodes = notes.map((n, i) => {
    const a = (i / Math.max(notes.length, 1)) * Math.PI * 2;
    const r = 120 + Math.random() * 80;
    return {
      id: n.id, note: n, x: Math.cos(a) * r, y: Math.sin(a) * r, vx: 0, vy: 0,
      r: (n.type === "cours" ? 9 : 6) + Math.min(deg.get(n.id) || 0, 10) * 0.8,
    };
  });
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const links = edges.map((e) => ({ ...e, s: byId.get(e.source), t: byId.get(e.target) })).filter((l) => l.s && l.t);

  let W = 0, H = 0, dpr = 1;
  const view = { x: 0, y: 0, k: 1 };
  let hover = null, drag = null, pan = null, alpha = 1, raf;

  function resize() {
    dpr = window.devicePixelRatio || 1;
    W = canvas.clientWidth; H = canvas.clientHeight;
    canvas.width = W * dpr; canvas.height = H * dpr;
  }
  resize();
  const ro = new ResizeObserver(() => { resize(); draw(); });
  ro.observe(canvas);

  function step() {
    // Répulsion
    for (let i = 0; i < nodes.length; i++) {
      for (let j = i + 1; j < nodes.length; j++) {
        const a = nodes[i], b = nodes[j];
        let dx = b.x - a.x, dy = b.y - a.y;
        let d2 = dx * dx + dy * dy || 0.01;
        if (d2 > 250000) continue;
        const f = (1400 / d2) * alpha;
        const d = Math.sqrt(d2);
        dx /= d; dy /= d;
        a.vx -= dx * f; a.vy -= dy * f; b.vx += dx * f; b.vy += dy * f;
      }
    }
    // Ressorts
    for (const l of links) {
      const dx = l.t.x - l.s.x, dy = l.t.y - l.s.y;
      const d = Math.sqrt(dx * dx + dy * dy) || 1;
      const target = l.kind === "parent" ? 70 : 100;
      const f = ((d - target) / d) * 0.04 * alpha;
      l.s.vx += dx * f; l.s.vy += dy * f; l.t.vx -= dx * f; l.t.vy -= dy * f;
    }
    // Gravité vers le centre + amortissement
    for (const n of nodes) {
      if (n === drag) continue;
      n.vx -= n.x * 0.006 * alpha; n.vy -= n.y * 0.006 * alpha;
      n.vx *= 0.85; n.vy *= 0.85;
      n.x += n.vx; n.y += n.vy;
    }
    alpha = Math.max(alpha * 0.992, 0.02);
  }

  function draw() {
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);
    ctx.translate(W / 2 + view.x, H / 2 + view.y);
    ctx.scale(view.k, view.k);

    const near = hover ? new Set(links.filter((l) => l.s === hover || l.t === hover).flatMap((l) => [l.s, l.t])) : null;

    for (const l of links) {
      const on = hover && (l.s === hover || l.t === hover);
      ctx.strokeStyle = on ? "rgba(231,233,240,.7)" : l.kind === "parent" ? "rgba(167,139,250,.28)" : "rgba(125,132,154,.28)";
      ctx.lineWidth = (on ? 1.6 : 1) / view.k;
      ctx.beginPath(); ctx.moveTo(l.s.x, l.s.y); ctx.lineTo(l.t.x, l.t.y); ctx.stroke();
    }
    for (const n of nodes) {
      const c = COLORS[n.note.type];
      const dim = near && !near.has(n) && n !== hover;
      ctx.globalAlpha = dim ? 0.25 : 1;
      ctx.shadowColor = c; ctx.shadowBlur = n === hover ? 18 : 8;
      ctx.fillStyle = c;
      ctx.beginPath(); ctx.arc(n.x, n.y, n.r, 0, Math.PI * 2); ctx.fill();
      ctx.shadowBlur = 0;
      if (view.k > 0.6 || n === hover || n.note.type === "cours") {
        ctx.fillStyle = dim ? "rgba(180,185,201,.4)" : "#d6d9e3";
        ctx.font = `${(n === hover ? 13 : 11.5) / Math.max(view.k, 0.7)}px Inter, sans-serif`;
        ctx.textAlign = "center";
        const label = n.note.title || "Sans titre";
        ctx.fillText(label.length > 32 ? label.slice(0, 30) + "…" : label, n.x, n.y + n.r + 14 / Math.max(view.k, 0.7));
      }
      ctx.globalAlpha = 1;
    }
  }

  function loop() {
    step(); draw();
    raf = requestAnimationFrame(loop);
  }
  loop();

  const toWorld = (e) => {
    const r = canvas.getBoundingClientRect();
    return { x: (e.clientX - r.left - W / 2 - view.x) / view.k, y: (e.clientY - r.top - H / 2 - view.y) / view.k };
  };
  const pick = (p) => {
    for (let i = nodes.length - 1; i >= 0; i--) {
      const n = nodes[i];
      if ((n.x - p.x) ** 2 + (n.y - p.y) ** 2 < (n.r + 4) ** 2) return n;
    }
    return null;
  };

  let moved = false;
  canvas.addEventListener("pointerdown", (e) => {
    canvas.setPointerCapture(e.pointerId);
    moved = false;
    const n = pick(toWorld(e));
    if (n) drag = n; else pan = { x: e.clientX - view.x, y: e.clientY - view.y };
    canvas.classList.add("dragging");
  });
  canvas.addEventListener("pointermove", (e) => {
    const p = toWorld(e);
    if (drag) { drag.x = p.x; drag.y = p.y; drag.vx = drag.vy = 0; alpha = Math.max(alpha, 0.3); moved = true; }
    else if (pan) { view.x = e.clientX - pan.x; view.y = e.clientY - pan.y; moved = true; }
    else { hover = pick(p); canvas.style.cursor = hover ? "pointer" : "grab"; }
  });
  canvas.addEventListener("pointerup", () => {
    if (drag && !moved) onOpen(drag.id);
    drag = null; pan = null;
    canvas.classList.remove("dragging");
  });
  canvas.addEventListener("wheel", (e) => {
    e.preventDefault();
    const k = Math.min(3, Math.max(0.2, view.k * (e.deltaY < 0 ? 1.1 : 0.9)));
    view.k = k;
  }, { passive: false });

  return () => { cancelAnimationFrame(raf); ro.disconnect(); };
}
