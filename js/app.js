(function () {
  "use strict";

  /* Every section starts on its own: one that throws logs the error, shows a line in its own
     section, and leaves the rest of the page working. */
  function guard(name, sectionId, fn) {
    try {
      return fn();
    } catch (e) {
      console.error("[" + name + "] " + (e && e.stack ? e.stack : e));
      const sec = sectionId && document.getElementById(sectionId);
      if (sec) {
        const p = document.createElement("p");
        p.className = "sec-error";
        p.setAttribute("role", "alert");
        p.textContent = "This section could not start: " + (e && e.message ? e.message : e);
        sec.insertBefore(p, sec.firstChild);
      }
      return null;
    }
  }

  // the theme toggle: remembered for the session; the renderer reads its colours at start, so
  // the page reloads in place (the browser keeps the scroll position)
  guard("theme", null, function () {
    const b = document.querySelector(".theme-toggle");
    if (!b) return;
    b.addEventListener("click", function () {
      const next = document.documentElement.getAttribute("data-theme") === "dark" ? "light" : "dark";
      try { sessionStorage.setItem("theme", next); } catch (e) { /* private mode: this load only */ }
      const url = location.pathname + location.search.replace(/([?&])theme=[a-z]+&?/, "$1").replace(/[?&]$/, "") + location.hash;
      history.replaceState(null, "", url);
      location.reload();
    });
  });

  guard("film", "applications", function () {
    if (!(window.__apps || []).length || !window.Film) return;
    window.__films = Array.prototype.map.call(document.querySelectorAll("#applications .film"),
      function (f) { return new window.Film(f); });
  });

  const V = window.Viewer;
  const hasGL = guard("renderer", "story", function () { V.Stage.init(); return true; });
  if (!hasGL) {
    // no WebGL: the 3D sections say so; text, the film strips and BibTeX stay as they are
    ["method", "explore"].forEach(function (id) {
      const sec = document.getElementById(id);
      if (!sec) return;
      const p = document.createElement("p");
      p.className = "sec-error";
      p.textContent = "3D views need WebGL, which this browser did not provide.";
      sec.insertBefore(p, sec.firstChild);
    });
    return;
  }

  // S0-S2: the wall; S3: the scale story
  guard("wall", "story", function () {
    const hero = document.getElementById("story");
    if (hero && (window.__wallIndex || []).length) window.__story = new window.Story.Hero(hero);
  });
  // the method figure: click opens a lightbox (click anywhere or Escape closes it)
  guard("lightbox", null, function () {
    let box = null;
    const close = function () { if (box) { box.remove(); box = null; } };
    document.querySelectorAll("img.paper-fig").forEach(function (im) {
      im.addEventListener("click", function () {
        close();
        box = document.createElement("div");
        box.className = "lightbox";
        box.setAttribute("role", "dialog");
        box.setAttribute("aria-label", im.alt || "Figure");
        const big = document.createElement("img");
        big.src = im.currentSrc || im.src; big.alt = im.alt;
        // the SVG is sized to the viewport by its aspect ratio (vector, re-rendered at that size);
        // never capped at its intrinsic size and never a scaled bitmap
        const ar = (im.naturalWidth || im.width) / (im.naturalHeight || im.height);
        big.style.width = "min(96vw, " + (92 * ar).toFixed(3) + "vh)";
        big.style.height = "auto";
        box.appendChild(big);
        box.addEventListener("click", close);
        document.body.appendChild(box);
      });
    });
    document.addEventListener("keydown", function (e) { if (e.key === "Escape") close(); });
  });

  // the applications film strips are images: they start with or without WebGL

  guard("contrib", "contrib", function () {
    const k = document.getElementById("contrib");
    if (k && (window.__contribIndex || []).length && window.Contrib) window.__contrib = new window.Contrib(k);
  });
  guard("scale", "method", function () {
    const method = document.getElementById("method");
    if (method && (window.__storyIndex || []).length) window.__method = new window.Story.Method(method);
  });

  // Explore: one card, one family at a time; switching tabs releases the previous clip
  guard("explore", "explore", function () {
    // the supplementary clips, five methods each (js/explore5.js)
    const card = new window.Explore5(document.getElementById("family-card"), document.getElementById("family-tabs"),
                                     window.__x25Index || []);
    window.__explore = card;
  });
})();
