// Shared site runtime: API base resolution + ambient starfield + scroll reveal.
(function () {
  document.documentElement.dataset.theme = "dark";
  // Where the Oculopus node API lives. ?api=http://host:port overrides (persisted);
  // otherwise default to the node's own origin when it serves this site, else the
  // public node. The data pages' boot gate needs a non-empty value.
  const q = new URLSearchParams(location.search).get("api");
  if (q !== null) {
    if (q === "") localStorage.removeItem("oc-api");
    // Only accept a well-formed http(s) origin, and store the origin alone — a ?api=
    // value is attacker-supplied (link the victim clicks) and gets persisted, so never
    // trust its scheme or let it carry a path/query.
    else { try { const u = new URL(q); if (u.protocol === "http:" || u.protocol === "https:") localStorage.setItem("oc-api", u.origin); } catch { /* ignore a malformed ?api= */ } }
  }
  const stored = localStorage.getItem("oc-api");
  const selfServed = /(^|\.)api\.oculopus\.xyz$/.test(location.hostname)
    || location.hostname === "localhost" || location.hostname === "127.0.0.1";
  window.OC_API = stored !== null ? stored : (selfServed ? location.origin : "https://api.oculopus.xyz");
})();

// ------------------------------------------------------------- ambient starfield
// Needs a <canvas id="dots"> in the page. Segmented white + blue twinkling stars
// with a gentle cursor bloom; scrolls with the document.
function ocStarfield() {
  const cv = document.getElementById("dots"); if (!cv) return;
  const ctx = cv.getContext("2d");
  const dpr = Math.min(devicePixelRatio || 1, 2);
  const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
  let W, H, dots, sy = scrollY, mtx = -9999, mty = -9999, mx = -9999, my = -9999;
  function build() {
    W = cv.width = innerWidth * dpr; H = cv.height = innerHeight * dpr;
    cv.style.width = innerWidth + "px"; cv.style.height = innerHeight + "px";
    const docH = Math.max(document.body.scrollHeight, innerHeight) * dpr;
    const bands = Math.max(5, Math.round(docH / (380 * dpr)));
    dots = [];
    for (let b = 0; b < bands; b++) {
      if (Math.random() < 0.12) continue;
      const cy = (b + 0.5) / bands * docH + (Math.random() - 0.5) * 240 * dpr;
      const count = 14 + (Math.random() * 18 | 0);
      for (let i = 0; i < count; i++) dots.push({
        x: Math.random() * W, docY: cy + (Math.random() - 0.5) * 300 * dpr,
        r: (Math.random() * 1.0 + 0.5) * dpr, ph: Math.random() * 6.283,
        sp: 0.3 + Math.random() * 0.55, blue: Math.random() < 0.35
      });
    }
  }
  addEventListener("resize", build);
  addEventListener("scroll", () => { sy = scrollY; }, { passive: true });
  addEventListener("pointermove", e => { mtx = e.clientX * dpr; mty = e.clientY * dpr; }, { passive: true });
  addEventListener("load", build); build();
  const col = (blue, a) => blue ? `rgba(120,180,255,${a})` : `rgba(255,255,255,${a})`;
  const R = 165 * dpr; let t = 0;
  function frame() {
    if (!W) build();
    t += reduced ? 0 : 0.013;
    mx += (mtx - mx) * 0.05; my += (mty - my) * 0.05;
    ctx.clearRect(0, 0, W, H);
    const off = sy * dpr;
    for (const d of dots) {
      const y = d.docY - off;
      if (y < -40 || y > H + 40) continue;
      const tw = 0.26 + 0.26 * Math.sin(t * d.sp + d.ph);
      let a = tw, r = d.r;
      const dist = Math.hypot(d.x - mx, y - my);
      if (dist < R) { const k = 1 - dist / R; a = Math.min(1, a + k * 0.55); r = d.r * (1 + k * 1.5); }
      ctx.beginPath(); ctx.arc(d.x, y, r, 0, 6.2832); ctx.fillStyle = col(d.blue, a); ctx.fill();
      if (a > 0.55) {
        const g = (a - 0.55) / 0.45, len = r * (3 + g * 6);
        ctx.fillStyle = col(d.blue, g * 0.42);
        ctx.beginPath();
        ctx.moveTo(d.x, y - len); ctx.lineTo(d.x + r * 0.55, y); ctx.lineTo(d.x, y + len); ctx.lineTo(d.x - r * 0.55, y); ctx.closePath();
        ctx.moveTo(d.x - len, y); ctx.lineTo(d.x, y - r * 0.55); ctx.lineTo(d.x + len, y); ctx.lineTo(d.x, y + r * 0.55); ctx.closePath();
        ctx.fill();
      }
    }
    requestAnimationFrame(frame);
  }
  frame();
}

// scroll reveal (re-triggers on re-entry) + saber light through .flow nodes
function ocReveal() {
  const io = new IntersectionObserver(es => es.forEach(e => e.target.classList.toggle("in", e.isIntersecting)), { threshold: .12 });
  document.querySelectorAll(".rv").forEach((el, i) => { el.style.transitionDelay = (i % 3 * 60) + "ms"; io.observe(el); });
  document.querySelectorAll(".flow .node").forEach((n, i) => { n.style.animationDelay = (i * 0.7) + "s"; });
}

document.addEventListener("DOMContentLoaded", () => { ocReveal(); });
