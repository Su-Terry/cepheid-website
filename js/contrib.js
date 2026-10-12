/* The three contributions, each shown on ONE real clip (the elk frame pair at 2% observed, the
   same completion the site shows elsewhere): (1) harmonic extension H -- the elk posed by H,
   coloured by |H|, with the observed points it is built from; (2) amplitude recovery -- the same
   residual R = F - H drawn at its literal length on the body, and R / s-hat with one s-hat drawn
   as UNIT_FRAC of the body; (3) the flow-matching residual prior -- H and the completion
   F-hat = H + s-hat R-bar, each coloured by its error against the ground truth F on one shared
   scale, next to F itself. No clock: static views, drawn from the exported data only. */
(function () {
  "use strict";
  const V = window.Viewer;
  const N_ARROWS = 150, UNIT_FRAC = 0.05;

  function pct(a, q) { const s = Array.from(a).sort(function (x, y) { return x - y; }); return s[Math.floor(q * (s.length - 1))] || 0; }
  function fps(P, cand, k) {
    if (cand.length <= k) return cand.slice();
    const d = new Float64Array(cand.length).fill(Infinity), out = [];
    let cur = 0;
    for (let s = 0; s < k; s++) {
      out.push(cand[cur]);
      const v0 = cand[cur];
      let far = -1, fi = 0;
      for (let i = 0; i < cand.length; i++) {
        const v = cand[i], r = Math.pow(P[v * 3] - P[v0 * 3], 2) + Math.pow(P[v * 3 + 1] - P[v0 * 3 + 1], 2) + Math.pow(P[v * 3 + 2] - P[v0 * 3 + 2], 2);
        if (r < d[i]) d[i] = r;
        if (d[i] > far) { far = d[i]; fi = i; }
      }
      cur = fi;
    }
    return out;
  }

  function Contrib(root) {
    this.root = root;
    const self = this;
    this.entry = (window.__contribIndex || [])[0];
    this.views = Array.from(root.querySelectorAll(".cview .view")).map(function (el) {
      const s = V.makeScene();
      const view = { el: el, scene: s.scene, key: s.key, camera: new THREE.PerspectiveCamera(30, 0.75, 0.01, 100), ready: false, bg: V.THEME.stage3d };
      V.Stage.views.add(view);
      return view;
    });
    new IntersectionObserver(function (es) {
      if (es[0].isIntersecting && !self.loading) {
        self.loading = true;
        ClipData.loadClip(self.entry, ["2"], null, ["ours", "harmonic"]).then(function (c) { c.entry = self.entry; self.build(c); })
          .catch(function (e) { console.error("[contrib] " + (e && e.message ? e.message : e)); });
      }
    }, { rootMargin: "900px 0px" }).observe(root);
  }

  Contrib.prototype.build = function (c) {
    const N = c.N, o = N * 3, d = c.dens["2"], vd = V.viewDir(this.entry);
    const box = V.clipBox(c, [c.gt, d.harmonic, d.ours]);
    const diag = box.hi.clone().sub(box.lo).length();
    const fit = function (view) { view.fit = function (a) { V.fitBox(view.camera, box, vd.up, vd.dir, a, 0.9); view.fitAspect = a; }; view.ready = true; };
    const body = function (view, field, err, vmax) {
      const b = new V.Body(c, view.scene, {});
      b.setObs(d.obs, true);
      b.pose(field, 1, null, c.gt);
      b.paint(err, 1, vmax);
      V.addShadow(view.scene, box, vd.up);
      fit(view);
      return b;
    };
    // (1) H, coloured by |H|
    const hmag = new Float32Array(2 * N);
    for (let v = 0; v < N; v++) hmag[N + v] = Math.hypot(d.harmonic[o + v * 3], d.harmonic[o + v * 3 + 1], d.harmonic[o + v * 3 + 2]);
    body(this.views[0], d.harmonic, hmag, pct(hmag.subarray(N), 0.98) || 1);
    // (2) R at its literal length, and R / s-hat (one s-hat = UNIT_FRAC of the body)
    const den = c.meta.densities.find(function (x) { return x.key === "2"; });
    const sHat = den.s_hat * den.normalizer;
    const obs = new Set(Array.from(d.obs)), cand = [];
    for (let v = 0; v < N; v++) if (!obs.has(v)) cand.push(v);
    const sub = fps(c.rest, cand, N_ARROWS), n = sub.length;
    const starts = new Float32Array(n * 3), r1 = new Float32Array(n * 3), r2 = new Float32Array(n * 3), clipped = new Uint8Array(n);
    const len = sub.map(function (v) { return Math.hypot(c.gt[o + v * 3] - d.harmonic[o + v * 3], c.gt[o + v * 3 + 1] - d.harmonic[o + v * 3 + 1], c.gt[o + v * 3 + 2] - d.harmonic[o + v * 3 + 2]); });
    const cap = pct(len, 0.95);
    sub.forEach(function (v, j) {
      const f = len[j] > cap ? cap / len[j] : 1;
      clipped[j] = len[j] > cap ? 1 : 0;
      for (let a = 0; a < 3; a++) {
        const r = (c.gt[o + v * 3 + a] - d.harmonic[o + v * 3 + a]);
        starts[j * 3 + a] = c.rest[v * 3 + a] + d.harmonic[o + v * 3 + a];
        r1[j * 3 + a] = r;                                          // literal length
        r2[j * 3 + a] = r * f / sHat * UNIT_FRAC * diag;            // in units of s-hat
      }
    });
    [[this.views[1], r1, new Uint8Array(n)], [this.views[2], r2, clipped]].forEach(function (x) {
      body(x[0], d.harmonic, null, 0);
      const arr = new V.Arrows(x[0].scene, N_ARROWS, V.THEME.arrow);
      arr.set(starts, x[1], 0.0095 * diag, x[2], V.THEME.arrowTip);
      arr.visible(true);
    });
    // (3) H vs H + s-hat R-bar vs F: error against F on one shared scale
    const vmax = pct(d.harmonicErr.subarray(N), 0.98) || 1;
    body(this.views[3], d.harmonic, d.harmonicErr, vmax);
    body(this.views[4], d.ours, d.oursErr, vmax);
    body(this.views[5], c.gt, null, 0);
    // one low/high bar per coloured card (card 1: |H|, card 3: error against F); card 2 has no colour
    this.root.querySelectorAll(".contrib-legend .bar").forEach(function (bar) { bar.style.background = V.HEAT_CSS; });
    this.ready = true;
  };

  window.Contrib = Contrib;
})();
