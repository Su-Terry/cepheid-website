/* Design layer: nav state (current section, scroll progress), one-time reveals, BibTeX copy.
   Presentation only: it reads the page and toggles classes; nothing here touches the 3D data. */
(function () {
  "use strict";
  const bar = document.querySelector(".navprog");
  const links = Array.prototype.slice.call(document.querySelectorAll(".topnav a"));
  const targets = links.map(function (a) { return document.querySelector(a.getAttribute("href")); });
  let ticking = false;
  function update() {
    ticking = false;
    const h = document.documentElement.scrollHeight - innerHeight;
    if (bar) bar.style.transform = "scaleX(" + (h > 0 ? Math.min(1, scrollY / h) : 0).toFixed(4) + ")";
    const line = innerHeight * 0.35;
    let on = -1;
    targets.forEach(function (t, i) { if (t && t.getBoundingClientRect().top <= line) on = i; });
    links.forEach(function (a, i) { a.classList.toggle("on", i === on); });
  }
  addEventListener("scroll", function () { if (!ticking) { ticking = true; requestAnimationFrame(update); } }, { passive: true });
  addEventListener("resize", update);
  update();
  // one-time reveal of headers and cards as they come into view
  const rv = Array.prototype.slice.call(document.querySelectorAll(".rv, .contrib-card, #explore .eyebrow, #explore .headline, #bibtex .card"));
  rv.forEach(function (el) { el.classList.add("rv"); });
  if ("IntersectionObserver" in window && !matchMedia("(prefers-reduced-motion: reduce)").matches) {
    const io = new IntersectionObserver(function (es) {
      es.forEach(function (e) { if (e.isIntersecting) { e.target.classList.add("in"); io.unobserve(e.target); } });
    }, { rootMargin: "0px 0px -8% 0px" });
    rv.forEach(function (el) { io.observe(el); });
  } else rv.forEach(function (el) { el.classList.add("in"); });
  // BibTeX: copy the entry
  const btn = document.querySelector(".copy-bib"), pre = document.querySelector("pre.bib");
  if (btn && pre) btn.addEventListener("click", function () {
    const done = function () { btn.textContent = "Copied"; setTimeout(function () { btn.textContent = "Copy"; }, 1600); };
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(pre.textContent).then(done, function () {});
    else { const r = document.createRange(); r.selectNodeContents(pre); const s = getSelection(); s.removeAllRanges(); s.addRange(r); }
  });
})();
/* the hero's group brackets: each over-bar spans exactly its columns' outer edges (three training
   families, two held out), measured from the built wall and kept in place on resize */
(function () {
  "use strict";
  function place() {
    const groups = document.querySelector(".wall-groups"), grid = document.querySelector(".wall-grid");
    if (!groups || !grid) return;
    const cols = grid.querySelectorAll(".wcol");
    if (cols.length < 5 || getComputedStyle(groups).display === "none") return;
    const g = groups.getBoundingClientRect();
    const span = function (a, b) { const l = cols[a].getBoundingClientRect().left, r = cols[b].getBoundingClientRect().right; return [l - g.left, r - l]; };
    [[".grp-train", span(0, 2)], [".grp-held", span(3, 4)]].forEach(function (x) {
      const el = groups.querySelector(x[0]); if (!el) return;
      el.style.left = x[1][0].toFixed(1) + "px"; el.style.width = x[1][1].toFixed(1) + "px";
    });
  }
  function wait() { if (document.querySelectorAll(".wall-grid .wcol").length >= 5) { place(); if ("ResizeObserver" in window) new ResizeObserver(place).observe(document.querySelector(".wall-grid")); } else setTimeout(wait, 100); }
  addEventListener("resize", place);
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", wait); else wait();
})();
