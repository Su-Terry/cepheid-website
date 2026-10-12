/* The results-first story: the hero wall (S0-S2) and the scale story (S3), both driven by
   native scroll. Scroll only sets a TARGET progress; every animation frame the rendered
   progress eases toward it (critically damped, 150 ms), and nothing touches geometry from a
   scroll event.

   HERO WALL. Ten cells (rows 0-1 of each family's seeded draw), grouped as training families |
   held out (zero-shot). Motion runs on a clock: every cell loops its range (meta.hero_range)
   forwards and backwards from page load, always visible. Scroll drives only the reveal (hero
   progress p: 0 at scroll 0, eased): the observed points alone, then the surface fills in from
   them over the whole cell (graph hops from the observed vertices) -- the exported prediction.
   Two render paths, chosen once at startup by Viewer.Stage.path (and logged):
     gpu  - frames live in float (or half-float) data textures and the vertex shader fetches and
            blends them; per frame only uniforms change;
     cpu  - no float/vertex textures: the current blended displacement is written into a vertex
            attribute on the CPU each frame (the v3 approach); same shaders otherwise.
   The wall loads before the reveal may start, but never waits forever: every file has a
   timeout, a cell that fails is left empty, the reveal starts with the cells that loaded, and a
   visible line says how many failed.

   SCALE STORY. Five families side by side, one motion-matched frame pair each at 2% observed
   (chosen offline so the whole motion |F| is similar relative to each body; the rule is in the
   wall manifest). Each camera looks along the direction with the largest silhouette of that mesh
   (cloth: ~30 degrees above its mean normal) and is fitted to the mesh plus every arrow tip.
   Scroll-scrubbed by the section progress p (eased): step 1 (p < 0.25) draws R = F - H under ONE
   magnification for all five, the meshes coloured by |R| / body on one shared scale; over
   p = 0.25..0.75 each family in turn morphs arrows and colour to R / s-hat (one display scale,
   colour |R / s-hat| on one shared scale); step 2 holds from p = 0.75. 150 arrows per mesh (cloth: the
   first 60 of the same farthest-point order, so the arrows leave the cloth's colour readable; the
   clipping and the magnifications are computed on all 150 as before); arrows longer than the mesh's 95th percentile are drawn at it with a lighter tip. */
(function () {
  "use strict";
  const V = window.Viewer;
  const FAMILY_ORDER = ["dt4d", "amass", "franka", "flag", "genbot"];
  const TRAIL = 10, EASE = 0.15, HI_DECAY = 0.1;
  const LABELS_AT = 0.7, CUE_PX = 8;
  // the wall cameras: every corner of the clip's whole-playback box inside this share of the cell (was 0.9)
  const WALL_FILL = 0.985;
  // the hero: motion loops on a clock; scroll drives only the reveal (points only -> surface)
  const ROBOT_FILL = 0.86;
  const SUBJECT_FILL = 0.86;                      // fix_v22 B: every wall subject's larger extent / the cell's shorter side                        // wall Panda: fit fill                       // wall Panda shell tone (x its own white)
  const WALL_FPS = 10, REVEAL_A = 0.12, REVEAL_B = 0.55, HERO_ROWS = 2;
  const N_ARROWS = 150, ARROWS_DRAWN = { flag: 60 }, ARROW_R = 0.0072, ARROW_FRAC = 0.15, LOAD_POOL = 4, FIT_FILL = 0.9;
  const MORPH_A = 0.25, MORPH_STEP = 0.075, MORPH_LEN = 0.2;
  const R_HEX = V.THEME.arrow, TIP_HEX = V.THEME.arrowTip;              // arrows: lower saturation

  function smooth(x) { x = Math.min(Math.max(x, 0), 1); return x * x * (3 - 2 * x); }
  function pct(a, q) { const s = Array.from(a).sort(function (x, y) { return x - y; }); return s[Math.floor(q * (s.length - 1))] || 0; }


  /* critically damped approach of state.v to target (SmoothDamp), once per animation frame */
  function damp(state, target, dt) {
    if (dt <= 0) return state.v;
    const w = 2 / EASE, x = w * dt, e = 1 / (1 + x + 0.48 * x * x + 0.235 * x * x * x);
    const ch = state.v - target, tmp = (state.vel + w * ch) * dt;
    state.vel = (state.vel - w * tmp) * e;
    let out = target + (ch + tmp) * e;
    if ((target - state.v > 0) === (out > target)) { out = target; state.vel = 0; }
    state.v = out;
    return out;
  }

  /* farthest-point sample of k vertices among `cand` (indices), on positions P [N*3] */
  function fpsIdx(P, cand, k) {
    const n = cand.length;
    if (n <= k) return cand.slice();
    const d = new Float64Array(n).fill(Infinity), out = [];
    let cx = 0, cy = 0, cz = 0;
    cand.forEach(function (v) { cx += P[v * 3]; cy += P[v * 3 + 1]; cz += P[v * 3 + 2]; });
    cx /= n; cy /= n; cz /= n;
    let cur = 0, best = -1;
    cand.forEach(function (v, i) {
      const r = Math.pow(P[v * 3] - cx, 2) + Math.pow(P[v * 3 + 1] - cy, 2) + Math.pow(P[v * 3 + 2] - cz, 2);
      if (r > best) { best = r; cur = i; }
    });
    for (let s = 0; s < k; s++) {
      out.push(cand[cur]);
      const px = P[cand[cur] * 3], py = P[cand[cur] * 3 + 1], pz = P[cand[cur] * 3 + 2];
      let far = -1, fi = 0;
      for (let i = 0; i < n; i++) {
        const v = cand[i];
        const r = Math.pow(P[v * 3] - px, 2) + Math.pow(P[v * 3 + 1] - py, 2) + Math.pow(P[v * 3 + 2] - pz, 2);
        if (r < d[i]) d[i] = r;
        if (d[i] > far) { far = d[i]; fi = i; }
      }
      cur = fi;
    }
    return out;
  }

  const VIR = [[0.267, 0.005, 0.329], [0.231, 0.322, 0.545], [0.128, 0.567, 0.551], [0.369, 0.789, 0.383], [0.993, 0.906, 0.144]];
  function viridis(x, out) {
    x = Math.min(Math.max(x, 0), 1) * 4;
    const i = Math.min(Math.floor(x), 3), f = x - i, a = VIR[i], b = VIR[i + 1];
    for (let c = 0; c < 3; c++) out[c] = a[c] + (b[c] - a[c]) * f;
  }

  /* ------------------------------------------------------------------ wall shaders
     One source, two paths: GPU fetches frames from the data textures; CPU reads the current
     blended displacement from attributes (aD: prediction, aG: ground truth at an observed
     vertex) and the current drift from a uniform (uDr). Trails on the CPU path get their final
     positions directly (TRAIL_CPU_VS). */
  function shaders(gpu) {
    const H = gpu ? [
      "uniform sampler2D uOurs; uniform sampler2D uGt; uniform sampler2D uDrift;",
      "uniform float uN; uniform float uT; uniform float uT0; uniform float uT1; uniform float uFrac; uniform float uP;",
      "vec3 fetchF(sampler2D tex, float i, float t) { return texture2D(tex, vec2((i + 0.5) / uN, (t + 0.5) / uT)).xyz; }",
      "vec3 driftAt(float t) { return texture2D(uDrift, vec2((t + 0.5) / uT, 0.5)).xyz; }",
      "vec3 oursNow(float i) { return mix(fetchF(uOurs, i, uT0), fetchF(uOurs, i, uT1), uFrac); }",
      "vec3 gtNow(float i) { return mix(fetchF(uGt, i, uT0), fetchF(uGt, i, uT1), uFrac); }",
      "vec3 driftNow() { return mix(driftAt(uT0), driftAt(uT1), uFrac); }",
      "attribute float aIdx;", ""].join("\n") : [
      "uniform float uP; uniform vec3 uDr; attribute vec3 aD; attribute vec3 aG;",
      "vec3 oursNow(float i) { return aD; }",
      "vec3 gtNow(float i) { return aG; }",
      "vec3 driftNow() { return uDr; }",
      "const float aIdx = 0.0;", ""].join("\n");
    return {
      SURF_VS: H + [
        "attribute float aHop; attribute vec3 aBase; varying vec3 vPos; varying float vHop; varying vec3 vBase;",
        "#ifdef USE_UV",
        "attribute vec2 aUv; varying vec2 vUv;",
        "#endif",
        "void main() {",
        "  vec4 mv = modelViewMatrix * vec4(position + uP * oursNow(aIdx), 1.0);",
        "  vPos = mv.xyz; vHop = aHop; vBase = aBase; gl_Position = projectionMatrix * mv;",
        "#ifdef USE_UV",
        "  vUv = aUv;",
        "#endif",
        "}"].join("\n"),
      EDGE_VS: H + [
        "attribute float aHop; varying float vHop;",
        "void main() {",
        "  gl_Position = projectionMatrix * modelViewMatrix * vec4(position + uP * oursNow(aIdx), 1.0);",
        "  vHop = aHop;",
        "}"].join("\n"),
      PTS_VS: H + [
        "attribute float aHop; uniform float uPx; varying float vHop;",
        "void main() {",
        "  gl_Position = projectionMatrix * modelViewMatrix * vec4(position + uP * oursNow(aIdx), 1.0);",
        "  gl_PointSize = uPx; vHop = aHop;",
        "}"].join("\n"),
      OBS_VS: H + [
        "uniform float uPx;",
        "void main() {",
        "  gl_Position = projectionMatrix * modelViewMatrix * vec4(position + gtNow(aIdx) - (1.0 - uP) * driftNow(), 1.0);",
        "  gl_PointSize = uPx;",
        "}"].join("\n"),
      TRAIL_VS: gpu ? H + [
        "attribute float aBack; attribute vec4 aCol; uniform float uUseGt; uniform float uDir; varying vec4 vCol;",
        "void main() {",
        "  float tt = clamp(uT0 - uDir * aBack, 0.0, uT - 1.0);",
        "  vec3 f = uUseGt > 0.5 ? fetchF(uGt, aIdx, tt) : fetchF(uOurs, aIdx, tt);",
        "  gl_Position = projectionMatrix * modelViewMatrix * vec4(position + f - (1.0 - uP) * driftAt(tt), 1.0);",
        "  vCol = aCol;",
        "}"].join("\n") : [
        "attribute vec4 aCol; varying vec4 vCol;",
        "void main() { gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); vCol = aCol; }"].join("\n"),
    };
  }
  const SURF_FS = [
    "uniform float uFront; uniform float uHi; uniform float uGreyMix; uniform float uRim; uniform vec3 uRimCol; uniform vec3 uBg;",
    "varying vec3 vPos; varying float vHop; varying vec3 vBase;",
    "#ifdef USE_UV",
    "uniform sampler2D uMap; uniform vec2 uRep; varying vec2 vUv;",
    "#endif",
    "void main() {",
    "  vec3 n = normalize(cross(dFdx(vPos), dFdy(vPos)));",
    "  float l = 0.5 + 0.5 * abs(n.z) + 0.08 * n.y;",
    // The surface is drawn WHOLE from the first moment of the reveal (before: fragments not yet reached by the
    // fill were discarded per pixel, so the surface showed as torn patches growing from the observed points).
    // Not yet reached = a pale shaded ghost of the same shape; the fill front turns it into the family's
    // appearance. The ghost rises from the cell background over the reveal's first tenth, so it does not pop.
    "  if (uFront <= -0.0999) discard;              // before the reveal: the observed points only",
    "  float fill = smoothstep(vHop - 0.1, vHop + 0.02, uFront);",
    "  vec3 base = mix(vBase, vec3(0.74, 0.76, 0.8), uGreyMix);   // the family's appearance (colour x AO)",
    "#ifdef USE_UV",
    "  base *= texture2D(uMap, vUv * uRep).rgb;",
    "#endif",
    "  vec3 lit = base * l + uRimCol * uRim * pow(1.0 - abs(n.z), 3.0);   // the look's rim light (lighting only)",
    "  float g = smoothstep(-0.1, 0.02, uFront);",
    "  vec3 ghost = mix(uBg, mix(vec3(dot(lit, vec3(0.3, 0.59, 0.11))), lit, 0.35), 0.42 * g);",
    "  vec3 c = mix(ghost, lit, fill);",
    "  float hi = uHi * 0.15 * step(vHop - 0.02, uFront) * (1.0 - smoothstep(0.0, 0.15, uFront - vHop));",
    "  gl_FragColor = vec4(mix(c, vec3(1.0, 0.97, 0.92), hi), 1.0);",
    "}"].join("\n");
  const EDGE_FS = ["uniform vec3 uEdge; uniform float uFront; varying float vHop;",
    "void main() { float fill = smoothstep(vHop - 0.1, vHop + 0.02, uFront); if (fill < 0.02) discard;",
    "  gl_FragColor = vec4(uEdge, 0.7 * fill); }"].join("\n");
  const PTS_FS = [
    "uniform vec3 uGrey; uniform float uFront; varying float vHop;",
    "void main() { vec2 q = gl_PointCoord - 0.5; if (dot(q, q) > 0.25) discard;",
    "  float fill = smoothstep(vHop - 0.1, vHop + 0.02, uFront); if (fill < 0.02) discard;",
    "  gl_FragColor = vec4(uGrey * mix(1.0, 0.88, fill), 1.0); }"].join("\n");
  const OBS_FS = [
    "void main() { vec2 q = gl_PointCoord - 0.5; float r = length(q); if (r > 0.5) discard;",
    "  gl_FragColor = vec4(r > 0.36 ? vec3(1.0) : vec3(" + V.THEME.obsRgb.map(function (x) { return x.toFixed(4); }).join(", ") + "), 1.0); }"].join("\n");
  const TRAIL_FS = "varying vec4 vCol; void main() { gl_FragColor = vCol; }";

  /* frames [T,N,3] -> an N x T RGBA texture, float or half float */
  function dataTex(field, N, T, half) {
    const n = N * T * 4;
    const a = half ? new Uint16Array(n) : new Float32Array(n);
    const conv = half ? THREE.DataUtils.toHalfFloat : null;
    for (let t = 0; t < T; t++) for (let v = 0; v < N; v++) {
      const o = (t * N + v) * 4, i = (t * N + v) * 3;
      for (let c = 0; c < 3; c++) a[o + c] = conv ? conv(field[i + c]) : field[i + c];
      if (conv) a[o + 3] = conv(1);
    }
    const tex = new THREE.DataTexture(a, N, T, THREE.RGBAFormat, half ? THREE.HalfFloatType : THREE.FloatType);
    tex.magFilter = tex.minFilter = THREE.NearestFilter;
    tex.needsUpdate = true;
    return tex;
  }

  /* ================================================================== the hero */
  function Hero(root) {
    this.root = root;
    this.steps = Array.from(root.querySelectorAll(".step"));
    this.wallEl = root.querySelector(".wall");
    this.loadEl = root.querySelector(".wall-loading");
    this.errEl = root.querySelector(".wall-error");
    this.cueEl = root.querySelector(".scroll-cue");
    this.cells = [];
    this.target = 0;
    this.p = { v: 0, vel: 0 };
    this.act = 0;
    this.phone = V.PHONE;
    this.gpu = V.Stage.path !== "cpu";
    this.half = V.Stage.path === "gpu-half";
    this.sh = shaders(this.gpu);
    this.step = "hero"; this.progress = 0;
    const self = this;
    this.buildWall();
    this.loadAll();
    if (this.cueEl) this.cueEl.addEventListener("click", function () {
      const s = root.querySelector('.step[data-step="reveal"]');
      const top = s.getBoundingClientRect().top + window.scrollY - 0.5 * window.innerHeight + 2;
      window.scrollTo({ top: top, behavior: "smooth" });
    });
    V.Stage.tickers.add(function (dt) { self.tick(dt); });
  }

  Hero.prototype.buildWall = function () {
    const grid = this.wallEl.querySelector(".wall-grid");
    let idx = window.__wallIndex || [];
    // PREVIEW ONLY (fix_v22 review, not for shipping): ?legged=swap draws the replacement candidate in the
    // Gendog224 cell; ?legged=keep (default) draws the wall as drawn. Remove with window.__wallSwap before release.
    if (window.__wallSwap && new URLSearchParams(location.search).get("legged") === "swap") {
      const sw = window.__wallSwap;
      idx = idx.map(function (e) { return e.folder === "genbot_Gendog224-t1448_wall" ? sw : e; });
    }
    const self = this;
    FAMILY_ORDER.forEach(function (fam, ci) {
      if (ci === 0) grid.appendChild(V.el("div", "grp-inline", "Training families"));
      if (ci === 3) {
        grid.appendChild(V.el("div", "wall-divider"));
        grid.appendChild(V.el("div", "grp-inline", "Held out · zero-shot"));
      }
      const col = V.el("div", "wcol");
      col.dataset.family = fam;
      if (ci >= 3) col.classList.add("held");
      const head = V.el("div", "wcol-head wlabel");
      const name = { dt4d: ["Animal", "DT4D"], amass: ["Human", "AMASS"], franka: ["Robot Arm", "Franka"],
                     flag: ["Cloth", "Flag"], genbot: ["Legged Robot", "GenBot1K"] }[fam];
      head.appendChild(V.el("b", null, name[0]));
      head.appendChild(V.el("span", null, name[1]));
      col.appendChild(head);
      idx.filter(function (e) { return e.family === fam; }).slice(0, self.phone ? HERO_ROWS : 4).forEach(function (e, ri) {
        const cell = V.el("div", "wcell");
        cell.dataset.row = ri;
        const v = V.el("div", "view wview loading");
        cell.appendChild(v);
        const lab = V.el("div", "cell-label wlabel", "");
        cell.appendChild(lab);
        col.appendChild(cell);
        const s = V.makeScene();
        const cam = new THREE.PerspectiveCamera(30, 1, 0.01, 100);
        const view = { el: v, scene: s.scene, key: s.key, camera: cam, ready: false, bg: V.THEME.cellClear };
        V.Stage.views.add(view);
        self.cells.push({ entry: e, view: view, cam: cam, fam: fam, row: ri, label: lab });
      });
      grid.appendChild(col);
    });
    this.fitRows();
  };
  /* fix_v22 r3: desktop builds all four drawn clips per family, then keeps the fourth row only when the wall,
     with its caption, still ends above the scroll cue on the pinned stage (4:3 cells, never stretched); otherwise
     three. Cells dropped here are never loaded. The caption says how many rows are shown. On resize a built fourth
     row is hidden or shown again by the same test. */
  Hero.prototype.rowsFit = function () {
    const st = this.root.querySelector(".sticky"), rule = this.wallEl.querySelector(".wall-rule");
    if (!st || !rule) return true;
    const s = st.getBoundingClientRect(), r = rule.getBoundingClientRect();
    const cue = this.cueEl ? this.cueEl.getBoundingClientRect() : null;
    const room = s.height - (cue && cue.height ? window.innerHeight - cue.top + 6 : 0);
    return r.bottom - s.top <= room;
  };
  Hero.prototype.caption = function (n) {
    const sp = this.wallEl.querySelector(".wall-rule span");
    if (sp) sp.textContent = " · showing " + n + " per family";
  };
  /* fix_v22 r4: whole rows only. Every frame the wall shows the most rows (of those built) whose caption line still
     ends above the scroll cue (and the window's bottom), measured on the layout on screen: at scroll 0 under the
     title fewer rows fit than once the stage is pinned. A row that does not fit is not drawn at all (display:
     none); a row that starts to fit fades in over FADE_MS, and one that stops fitting fades out (it stays in the
     layout while it fades, so nothing below it jumps until it is gone). The caption states the rows shown. */
  const FADE_MS = 300, ROW_SLACK = 4;
  Hero.prototype.updateRows = function () {
    if (this.phone || !this.builtRows || !this.cells.length) return;
    const self = this, B = this.builtRows, now = performance.now();
    if (!this.rowState) {                            // per row: { on, a (0..1), t0 }
      this.rowState = [];
      for (let k = 0; k < B; k++) this.rowState.push({ on: true, a: 1, gone: false });
    }
    const rule = this.wallEl.querySelector(".wall-rule").getBoundingClientRect();
    const cue = this.cueEl && !this.cueEl.classList.contains("gone") ? this.cueEl.getBoundingClientRect() : null;
    const limit = Math.min(window.innerHeight, cue && cue.height ? cue.top : window.innerHeight) - 10;
    if (!this.pitch) {
      const a = this.cells.find(function (c) { return c.row === 0; }), b = this.cells.find(function (c) { return c.row === 1; });
      if (a && b) this.pitch = b.view.el.parentNode.getBoundingClientRect().top - a.view.el.parentNode.getBoundingClientRect().top;
      if (!this.pitch) return;
    }
    const inLayout = this.rowState.filter(function (r) { return !r.gone; }).length;
    let R = 1;
    for (let r = 1; r <= B; r++) {
      const slack = this.shownRows !== undefined && r <= this.shownRows ? ROW_SLACK : 0;   // hysteresis
      if (rule.bottom + (r - inLayout) * this.pitch <= limit + slack) R = r;
    }
    const first = this.shownRows === undefined;
    if (R !== this.shownRows) { this.shownRows = R; this.caption(R); }
    this.rowState.forEach(function (st, k) {
      const want = k < R;
      if (want !== st.on) { st.on = want; st.t0 = now; st.a0 = st.a; if (want) st.gone = false; }
      const target = want ? 1 : 0;
      if (first) st.a = target;
      else if (st.a !== target) {
        const u = Math.min(1, (now - st.t0) / FADE_MS);
        st.a = st.a0 + (target - st.a0) * u;
      }
      if (!want && st.a <= 0) st.gone = true;
      self.cells.forEach(function (c) {
        if (c.row !== k) return;
        const cell = c.view.el.parentNode;
        cell.classList.toggle("row-off", st.gone);
        c.view.fade = st.a >= 1 ? undefined : st.a;
        cell.style.opacity = st.a >= 1 ? "" : String(st.a);    // the cell's own labels follow the 3D fade
      });
    });
  };
  Hero.prototype.fitRows = function () {
    const self = this, wall = this.wallEl;
    const caption = function (n) { self.caption(n); };
    if (this.phone) { caption(HERO_ROWS); return; }
    wall.dataset.rows = "4";
    if (!this.rowsFit()) {
      if (!this.ready && !this.loadStarted) {         // at build: drop the fourth row (never loaded)
        this.cells = this.cells.filter(function (c) {
          if (c.row < 3) return true;
          V.Stage.views.delete(c.view); c.view.el.parentNode.remove(); return false;
        });
      }
      wall.dataset.rows = "3";
    }
    const n = this.cells.some(function (c) { return c.row === 3; }) && wall.dataset.rows === "4" ? 4 : 3;
    this.builtRows = n;
    if (this.shownRows === undefined) caption(n);
    if (!this.rowsListen) {
      this.rowsListen = true;
      let tq = 0;
      window.addEventListener("resize", function () { clearTimeout(tq); tq = setTimeout(function () { self.fitRows(); }, 150); });
    }
  };

  /* the whole wall (phones: the two rows they show) before the reveal may start; a cell that
     fails (error or timeout) is left empty and never blocks the others */
  Hero.prototype.loadAll = function () {
    const self = this;
    this.loadStarted = true;
    const want = this.cells;
    let done = 0;
    const failed = [];
    const bar = this.loadEl.querySelector(".bar span"), txt = this.loadEl.querySelector(".txt");
    const show = function () { bar.style.width = (100 * done / want.length) + "%"; txt.textContent = "loading " + done + " / " + want.length; };
    show();
    // at most LOAD_POOL cells in flight, so a file's time in the browser's queue never counts
    // toward its stall timer
    const queue = want.slice();
    const worker = function () {
      const c = queue.shift();
      if (!c) return Promise.resolve();
      return self.loadCell(c).catch(function (err) {
        failed.push(c);
        console.error("[wall] " + c.entry.folder + ": " + (err && err.message ? err.message : err));
        c.view.el.classList.remove("loading");
        c.view.el.classList.add("failed");
      }).then(function () { done++; show(); return worker(); });
    };
    const pool = [];
    for (let i = 0; i < LOAD_POOL; i++) pool.push(worker());
    return Promise.all(pool).then(function () {
      self.ready = true;
      self.failed = failed.length;
      self.loadEl.classList.add("done");
      if (failed.length && self.errEl) {
        self.errEl.textContent = failed.length + " of " + want.length + " clips could not be loaded; the reveal shows the others.";
        self.errEl.hidden = false;
      }
    });
  };

  Hero.prototype.loadCell = async function (c) {
    const clip = await ClipData.loadClip(c.entry, ["2"], ["hops", "trail"].concat(V.extrasFor(c.entry)), ["ours"], true);   // a clip's files in parallel
    const N = clip.N, T = clip.T, d = clip.dens["2"], rest = clip.rest, sc = c.view.scene;
    const gpu = this.gpu, SH = this.sh;
    c.T = T; c.N = N; c.clip = clip;
    const hr = clip.meta.hero_range || [0, T - 1];      // the part of the clip the scroll plays
    c.k0 = hr[0]; c.k1 = hr[1];
    c.pEnd = clip.meta.hero_scroll_end || 1;            // a slow cell plays over a shorter scroll range
    // drift: each frame's mean observed displacement
    const drift = new Float32Array(T * 3);
    for (let t = 0; t < T; t++) {
      for (let k = 0; k < d.obs.length; k++) {
        const i = t * N * 3 + d.obs[k] * 3;
        for (let a = 0; a < 3; a++) drift[t * 3 + a] += clip.gt[i + a];
      }
      for (let a = 0; a < 3; a++) drift[t * 3 + a] /= Math.max(1, d.obs.length);
    }
    c.drift = drift;
    const U = {
      uN: { value: N }, uT: { value: T }, uT0: { value: 0 }, uT1: { value: 0 }, uFrac: { value: 0 },
      uP: { value: 0 }, uFront: { value: -0.2 }, uHi: { value: 0 }, uDir: { value: 1 }, uDr: { value: new THREE.Vector3() },
      uGreyMix: { value: 0 }, uRim: { value: V.THEME.rim }, uRimCol: { value: new THREE.Color(V.THEME.rimCol) },
      uGrey: { value: new THREE.Color().fromArray(V.GREY) }, uEdge: { value: new THREE.Color(V.THEME.edge) },
      uBg: { value: new THREE.Color(V.THEME.cellClear !== null ? V.THEME.cellClear : V.THEME.page) },
      uPx: { value: 2.6 * V.DPR }, uUseGt: { value: 0 },
    };
    if (gpu) {
      const d4 = new Float32Array(T * 3);
      d4.set(drift);
      U.uOurs = { value: dataTex(d.ours, N, T, this.half) };
      U.uGt = { value: dataTex(clip.gt, N, T, this.half) };
      U.uDrift = { value: dataTex(d4, T, 1, this.half) };
    }
    c.U = U;
    // graph hops -> fill delay in 0..1 (unreachable = last)
    const h = clip.extra.hops;
    let mx = 0;
    for (let v = 0; v < N; v++) if (h[v] !== 4294967295 && h[v] > mx) mx = h[v];
    const hop = new Float32Array(N), idx = new Float32Array(N);
    for (let v = 0; v < N; v++) { hop[v] = h[v] === 4294967295 ? 1 : (mx ? h[v] / (mx + 1) : 0); idx[v] = v; }
    // frame the frames this cell actually plays (its hero range), not the whole exported clip
    const a0 = c.k0 * N * 3, a1 = (c.k1 + 1) * N * 3;
    const box = V.clipBox(clip, [clip.gt.subarray(a0, a1), d.ours.subarray(a0, a1)]);
    // camera follows a travelling body sideways (as the supplementary videos re-centre bodies): when the
    // observed points' horizontal drift over the played range exceeds a quarter of the body's own size, the
    // fit uses the body with that drift removed and the camera moves with the drift at play time. Display only.
    const upv = V.viewDir(c.entry).up, hz = function (t) {
      const x = drift[t * 3], y = drift[t * 3 + 1], z = drift[t * 3 + 2], u = x * upv.x + y * upv.y + z * upv.z;
      return new THREE.Vector3(x - u * upv.x, y - u * upv.y, z - u * upv.z);
    };
    let hmin = null, hmax = null, bodyD = 0;
    for (let t = c.k0; t <= c.k1; t++) {
      const hv = hz(t);
      hmin = hmin ? hmin.min(hv) : hv.clone(); hmax = hmax ? hmax.max(hv) : hv.clone();
      const lo = new THREE.Vector3(1e9, 1e9, 1e9), hi = new THREE.Vector3(-1e9, -1e9, -1e9), v = new THREE.Vector3();
      for (let i = 0; i < N; i += 2) { v.set(rest[i * 3] + d.ours[(t * N + i) * 3], rest[i * 3 + 1] + d.ours[(t * N + i) * 3 + 1], rest[i * 3 + 2] + d.ours[(t * N + i) * 3 + 2]); lo.min(v); hi.max(v); }
      bodyD = Math.max(bodyD, hi.distanceTo(lo));
    }
    // (bodies only: a flag is pinned to its pole, and its mean motion is flapping, not travel)
    c.track = c.entry.family !== "flag" && c.entry.family !== "franka" && hmax.distanceTo(hmin) > 0.25 * bodyD;
    let fitBox_ = box;
    if (c.track) {
      c.hz = hz;
      const lo = new THREE.Vector3(1e9, 1e9, 1e9), hi = new THREE.Vector3(-1e9, -1e9, -1e9), v = new THREE.Vector3();
      for (let t = c.k0; t <= c.k1; t++) {
        const o = hz(t);
        for (let i = 0; i < N; i++) {
          v.set(rest[i * 3] + d.ours[(t * N + i) * 3] - o.x, rest[i * 3 + 1] + d.ours[(t * N + i) * 3 + 1] - o.y, rest[i * 3 + 2] + d.ours[(t * N + i) * 3 + 2] - o.z);
          lo.min(v); hi.max(v);
        }
      }
      fitBox_ = { lo: lo, hi: hi };
    }
    const sphere = new THREE.Sphere(box.lo.clone().add(box.hi).multiplyScalar(0.5), box.hi.clone().sub(box.lo).length());
    // CPU path: one shared attribute holding the current blended prediction
    c.aD = gpu ? null : new THREE.BufferAttribute(new Float32Array(N * 3), 3);
    const geom = function () {
      const g = new THREE.BufferGeometry();
      g.setAttribute("position", new THREE.BufferAttribute(new Float32Array(rest), 3));
      g.setAttribute("aIdx", new THREE.BufferAttribute(idx, 1));
      g.setAttribute("aHop", new THREE.BufferAttribute(hop, 1));
      if (!gpu) { g.setAttribute("aD", c.aD); g.setAttribute("aG", c.aD); }
      g.boundingSphere = sphere;
      return g;
    };
    const app = V.appearanceOf(clip);
    const mat = function (vs, fs, extra) {
      return new THREE.ShaderMaterial(Object.assign({ uniforms: U, vertexShader: vs, fragmentShader: fs }, extra || {}));
    };
    if (clip.meta.topology === "faces") {
      const g = geom();
      g.setIndex(new THREE.BufferAttribute(clip.topo, 1));
      g.setAttribute("aBase", new THREE.BufferAttribute(app.base, 3));
      const m = mat(SH.SURF_VS, SURF_FS, { side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1 });
      if (app.uv) {                                    // cloth: its material coordinates, a plain fabric
        g.setAttribute("aUv", new THREE.BufferAttribute(app.uv, 2));
        m.defines = { USE_UV: "" };
        U.uMap = { value: V.fabricTexture() };
        U.uRep = { value: new THREE.Vector2(3, 3) };
      }
      m.extensions.derivatives = true;
      sc.add(new THREE.Mesh(g, m));
    } else {
      const ge = geom();
      ge.setIndex(new THREE.BufferAttribute(clip.topo, 1));
      const edges = new THREE.LineSegments(ge, mat(SH.EDGE_VS, EDGE_FS, { transparent: true }));
      const pts = new THREE.Points(geom(), mat(SH.PTS_VS, PTS_FS));
      sc.add(edges); sc.add(pts);
      // Franka: its URDF visual meshes stand in for the point set; each link fades in when the
      // fill front reaches the link's vertices, posed by a rigid fit to the drawn points
      if (clip.extra.link && clip.extra.link0pose) {
        c.pos = new Float32Array(N * 3);
        c.linkHop = [];
        V.panda().then(function (data) {
          const ex = clip.extra;
          const pose0 = new Float32Array(ex.link0pose.buffer, ex.link0pose.byteOffset, ex.link0pose.length);
          c.robot = new V.Robot(sc, data, pose0, ex.link, N);
          c.robot.idx.forEach(function (ids, k) {
            let h = 0;
            ids.forEach(function (v) { h += hop[v]; });
            c.linkHop[k] = ids.length ? h / ids.length : 0;
          });
          edges.visible = pts.visible = false;
          c.view.fitAspect = 0;                          // refit with the robot meshes in the box
          // fix_v22 A4: the Panda's visual meshes reach below the points (its base): lower the floor to them
          const up = V.viewDir(c.entry).up, q = new THREE.Vector3(), P = new Float32Array(N * 3);
          let lo = Infinity;
          for (let t = c.k0; t <= c.k1; t += 2) {
            for (let i = 0; i < N * 3; i++) P[i] = rest[i] + d.ours[t * N * 3 + i];
            c.robot.pose(rest, P);
            c.robot.meshes.forEach(function (m) {
              m.updateMatrixWorld(true);
              const A = m.geometry.attributes.position;
              for (let i = 0; i < A.count; i++) lo = Math.min(lo, q.fromBufferAttribute(A, i).applyMatrix4(m.matrixWorld).dot(up));
            });
          }
          if (lo < c.floorH && c.floor) { const dd = lo - c.floorH; c.floor.forEach(function (o) { o.position.addScaledVector(up, dd); }); c.floorH = lo; }
        }).catch(function (e) { console.error("[robot] " + (e && e.message ? e.message : e)); });
      }
    }
    // observed markers: the true observed motion, drift removed before the reveal
    const no = d.obs.length, og = new THREE.BufferGeometry(), op = new Float32Array(no * 3), oi = new Float32Array(no);
    for (let k = 0; k < no; k++) { oi[k] = d.obs[k]; for (let a = 0; a < 3; a++) op[k * 3 + a] = rest[d.obs[k] * 3 + a]; }
    og.setAttribute("position", new THREE.BufferAttribute(op, 3));
    og.setAttribute("aIdx", new THREE.BufferAttribute(oi, 1));
    if (!gpu) {
      c.aGo = new THREE.BufferAttribute(new Float32Array(no * 3), 3);
      og.setAttribute("aG", c.aGo);
      og.setAttribute("aD", c.aGo);
    }
    og.boundingSphere = sphere;
    const Uo = Object.assign({}, U, { uPx: { value: (no <= 100 ? 4.5 : 3.5) * V.DPR } });
    const obsPts = new THREE.Points(og, new THREE.ShaderMaterial({ uniforms: Uo, vertexShader: SH.OBS_VS, fragmentShader: OBS_FS }));
    obsPts.renderOrder = 3;
    sc.add(obsPts);
    c.obsPts = obsPts;
    // trails: the observed points' own (before the reveal) and 60 predicted vertices (after)
    const segs = TRAIL - 1;
    const makeTrail = function (verts, colOf, useGt) {
      const n = verts.length, P = new Float32Array(n * segs * 2 * 3), I = new Float32Array(n * segs * 2),
            B = new Float32Array(n * segs * 2), C = new Float32Array(n * segs * 2 * 4), rgb = [0, 0, 0];
      verts.forEach(function (v, k) {
        colOf(k, rgb);
        for (let s = 0; s < segs; s++) for (let e = 0; e < 2; e++) {
          const q = (k * segs + s) * 2 + e;
          for (let a = 0; a < 3; a++) P[q * 3 + a] = rest[v * 3 + a];
          I[q] = v;
          B[q] = segs - s - e;                             // frames back from the current one
          C[q * 4] = rgb[0]; C[q * 4 + 1] = rgb[1]; C[q * 4 + 2] = rgb[2];
          C[q * 4 + 3] = 0.15 + 0.65 * (s + e) / segs;
        }
      });
      const tg = new THREE.BufferGeometry();
      tg.setAttribute("position", new THREE.BufferAttribute(P, 3));
      tg.setAttribute("aIdx", new THREE.BufferAttribute(I, 1));
      tg.setAttribute("aBack", new THREE.BufferAttribute(B, 1));
      tg.setAttribute("aCol", new THREE.BufferAttribute(C, 4));
      tg.boundingSphere = sphere;
      const Ut = Object.assign({}, U, { uUseGt: { value: useGt ? 1 : 0 } });
      const L = new THREE.LineSegments(tg, new THREE.ShaderMaterial({ uniforms: Ut, vertexShader: SH.TRAIL_VS,
        fragmentShader: TRAIL_FS, transparent: true, depthWrite: false }));
      L.userData = { verts: verts, I: I, B: B, useGt: useGt };
      sc.add(L);
      return L;
    };
    c.obsTrails = makeTrail(Array.from(d.obs), function (k, o) { o[0] = 0.82; o[1] = 0.23; o[2] = 0.18; }, true);
    const trail = Array.from(clip.extra.trail), nt = trail.length, mean = [0, 0, 0];
    trail.forEach(function (v) { for (let a = 0; a < 3; a++) mean[a] += rest[v * 3 + a] / nt; });
    const cov = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
    trail.forEach(function (v) {
      const q = [rest[v * 3] - mean[0], rest[v * 3 + 1] - mean[1], rest[v * 3 + 2] - mean[2]];
      for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) cov[i][j] += q[i] * q[j];
    });
    let ax = [1, 0.7, 0.3];
    for (let it = 0; it < 40; it++) {
      const n = [0, 0, 0];
      for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) n[i] += cov[i][j] * ax[j];
      const L = Math.hypot(n[0], n[1], n[2]) || 1;
      ax = [n[0] / L, n[1] / L, n[2] / L];
    }
    const proj = trail.map(function (v) { return (rest[v * 3] - mean[0]) * ax[0] + (rest[v * 3 + 1] - mean[1]) * ax[1] + (rest[v * 3 + 2] - mean[2]) * ax[2]; });
    const lo = Math.min.apply(null, proj), hi = Math.max.apply(null, proj);
    c.predTrails = makeTrail(trail, function (k, o) { viridis((proj[k] - lo) / (hi - lo || 1), o); }, false);
    c.predTrails.visible = false;
    // every uniform object that must follow the frame / progress
    c.Us = [U, Uo, c.obsTrails.material.uniforms, c.predTrails.material.uniforms];
    const vd = V.viewDir(c.entry);
    // fix_v22 A4: the floor at the lowest drawn vertex of the played range (ours and the observed ground truth,
    // every frame, every vertex), drawn behind the subject (it can never cover it)
    let fl = Infinity;
    for (let t = c.k0; t <= c.k1; t++) for (let i = 0; i < N; i++) {
      const j = (t * N + i) * 3;
      fl = Math.min(fl, (rest[i * 3] + d.ours[j]) * vd.up.x + (rest[i * 3 + 1] + d.ours[j + 1]) * vd.up.y + (rest[i * 3 + 2] + d.ours[j + 2]) * vd.up.z,
                        (rest[i * 3] + clip.gt[j]) * vd.up.x + (rest[i * 3 + 1] + clip.gt[j + 1]) * vd.up.y + (rest[i * 3 + 2] + clip.gt[j + 2]) * vd.up.z);
    }
    c.floorH = fl;
    c.floor = V.addShadow(sc, box, vd.up, { level: fl, behind: true });
    if (c.track) {                                        // fix_v22 r7b: a tracked body's contact shadow sits under the body
      // (its drift-removed box), sized to it, and moves with the drift in tick; the grid stays put
      const fc = fitBox_.lo.clone().add(fitBox_.hi).multiplyScalar(0.5);
      c.shadowBase = fc.addScaledVector(vd.up, fl - fc.dot(vd.up));
      c.floor[0].scale.setScalar(fitBox_.hi.clone().sub(fitBox_.lo).length() / Math.max(1e-9, box.hi.clone().sub(box.lo).length()));
      c.floor[0].position.copy(c.shadowBase);
    }
    c.view.fit = function (aspect) {
      // Franka: frame the posed robot meshes too (its visual base reaches below the points)
      let fb = fitBox_;
      if (c.robot) {
        // Franka: fitted on what is drawn -- the posed Panda meshes at 8 frames of the played range, projected
        // (box corners overstate a thin arm's silhouette, which left it small in its cell)
        const pts = [], v = new THREE.Vector3(), P = new Float32Array(N * 3), dd = d.ours;
        for (let j = 0; j < 8; j++) {
          const t = Math.round(c.k0 + (c.k1 - c.k0) * j / 7);
          for (let i = 0; i < N * 3; i++) P[i] = rest[i] + dd[t * N * 3 + i];
          c.robot.pose(rest, P);
          c.robot.meshes.forEach(function (m) {
            m.updateMatrixWorld(true);
            const A = m.geometry.attributes.position;
            for (let i = 0; i < A.count; i += 5) { v.fromBufferAttribute(A, i).applyMatrix4(m.matrixWorld); pts.push(v.x, v.y, v.z); }
          });
        }
        fitPoints(c.cam, Float32Array.from(pts), vd.dir, vd.up, aspect, SUBJECT_FILL, true);
        const fwd = new THREE.Vector3(); c.cam.getWorldDirection(fwd);
        c.camBase = { pos: c.cam.position.clone(), tgt: c.cam.position.clone().add(fwd) };
        c.view.fitAspect = aspect;
        return;
      }
      // fix_v22 B: fitted on what is drawn -- the surface / points of the played range, projected (every 2nd
      // frame, every 2nd vertex; drift removed for a tracked cell) -- with its larger extent SUBJECT_FILL of the
      // cell's shorter side, the same for every cell (was: the 3D box corners within WALL_FILL of the limiting
      // side, which left wide subjects at a third of a tall cell). Camera only; the drawn positions are untouched.
      void fb;
      const pts = [];
      for (let t = c.k0; t <= c.k1; t += 2) {
        const o = c.track ? c.hz(t) : null;
        for (let i = 0; i < N; i += 2) {
          const j = (t * N + i) * 3;
          pts.push(rest[i * 3] + d.ours[j] - (o ? o.x : 0), rest[i * 3 + 1] + d.ours[j + 1] - (o ? o.y : 0), rest[i * 3 + 2] + d.ours[j + 2] - (o ? o.z : 0));
        }
      }
      fitPoints(c.cam, Float32Array.from(pts), vd.dir, vd.up, aspect, SUBJECT_FILL, true);
      const fwd = new THREE.Vector3(); c.cam.getWorldDirection(fwd);
      c.camBase = { pos: c.cam.position.clone(), tgt: c.cam.position.clone().add(fwd) };
      c.view.fitAspect = aspect;
    };
    c.label.textContent = "2% observed";
    c.view.ready = true;
    c.view.el.classList.remove("loading");
  };

  /* CPU path: write the current blended displacements (and the trails) into the attributes */
  Hero.prototype.cpuFrame = function (c, t0, t1, fr, p, dir) {
    const clip = c.clip, N = c.N, T = c.T, d = clip.dens["2"], ours = d.ours, gt = clip.gt, rest = clip.rest;
    const D = c.aD.array, o0 = t0 * N * 3, o1 = t1 * N * 3;
    for (let i = 0; i < N * 3; i++) D[i] = ours[o0 + i] + fr * (ours[o1 + i] - ours[o0 + i]);
    c.aD.needsUpdate = true;
    const G = c.aGo.array;
    for (let k = 0; k < d.obs.length; k++) for (let a = 0; a < 3; a++) {
      const v = d.obs[k] * 3 + a;
      G[k * 3 + a] = gt[o0 + v] + fr * (gt[o1 + v] - gt[o0 + v]);
    }
    c.aGo.needsUpdate = true;
    const dr = c.drift;
    c.U.uDr.value.set(dr[t0 * 3] + fr * (dr[t1 * 3] - dr[t0 * 3]), dr[t0 * 3 + 1] + fr * (dr[t1 * 3 + 1] - dr[t0 * 3 + 1]),
                      dr[t0 * 3 + 2] + fr * (dr[t1 * 3 + 2] - dr[t0 * 3 + 2]));
    const L = c.obsTrails.visible ? c.obsTrails : c.predTrails, u = L.userData, P = L.geometry.attributes.position.array;
    const F = u.useGt ? gt : ours;
    for (let q = 0; q < u.I.length; q++) {
      const v = u.I[q], tt = Math.min(T - 1, Math.max(0, Math.round(t0 - dir * u.B[q])));
      for (let a = 0; a < 3; a++)
        P[q * 3 + a] = rest[v * 3 + a] + F[(tt * N + v) * 3 + a] - (1 - p) * dr[tt * 3 + a];
    }
    L.geometry.attributes.position.needsUpdate = true;
  };

  /* Hero progress p in [0,1]: 0 at scroll 0 (no dead zone), 1 when the hero unpins. */
  /* Franka: the links follow the drawn points (rest + rr x the blended prediction) and fade in
     with the fill front */
  Hero.prototype.robotFrame = function (c, t0, t1, fr, rr) {
    const N = c.N, ours = c.clip.dens["2"].ours, rest = c.clip.rest, P = c.pos, o0 = t0 * N * 3, o1 = t1 * N * 3;
    for (let i = 0; i < N * 3; i++) P[i] = rest[i] + (ours[o0 + i] + fr * (ours[o1 + i] - ours[o0 + i]));
    c.robot.pose(rest, P);
    const front = rr * 1.2 - 0.1;
    c.robot.opacity(c.linkHop.map(function (h) { return smooth((front - (h - 0.1)) / 0.12); }));
  };

  Hero.prototype.readScroll = function () {
    const end = this.root.getBoundingClientRect().bottom + window.scrollY - window.innerHeight;
    this.target = Math.min(1, Math.max(0, window.scrollY / Math.max(1, end)));
  };

  function pingpong(u, T) {
    if (T < 2) return 0;
    const per = 2 * (T - 1), x = u % per;
    return x <= T - 1 ? x : per - x;
  }
  /* Motion runs on a clock (every cell loops its range forwards and backwards from page load,
     always visible); scroll drives only the reveal: the observed points alone, then the surface
     fills in from them over the whole cell -- the exported prediction, moving. */
  Hero.prototype.tick = function (dt) {
    const r = this.root.getBoundingClientRect(), h = window.innerHeight;
    // fix_v22 r4: the cue stays while the hero is on screen (at scroll 0 and pinned); it goes once the hero ends
    if (this.cueEl) this.cueEl.classList.toggle("gone", r.bottom < window.innerHeight * 1.02 || window.scrollY < -CUE_PX);
    this.updateRows();
    this.time = (this.time || 0) + dt * WALL_FPS;
    if (r.bottom < 0 || r.top > h) return;
    this.readScroll();
    const prev = this.p.v;
    const p = damp(this.p, this.target, dt);
    const rv = smooth((p - REVEAL_A) / (REVEAL_B - REVEAL_A));
    const rr = rv > 0.9995 ? 1 : rv < 5e-4 ? 0 : rv;
    this.step = p < REVEAL_A ? "hero" : p < LABELS_AT ? "reveal" : "labels";
    this.wallEl.classList.toggle("labels-on", p >= LABELS_AT);
    this.act = Math.abs(p - prev) > 1e-4 ? 1 : (this.act || 0) * Math.exp(-dt / HI_DECAY);
    const self = this;
    this.cells.forEach(function (c) {
      if (!c.Us) return;
      const L = c.k1 - c.k0, per = 2 * Math.max(1, L), x = self.time % per, dir = x <= L ? 1 : -1;
      const f = c.k0 + pingpong(self.time, L + 1), t0 = Math.min(Math.floor(f), c.T - 1), t1 = Math.min(t0 + 1, c.T - 1);
      c.Us.forEach(function (U) {
        U.uT0.value = t0; U.uT1.value = t1; U.uFrac.value = f - t0; U.uDir.value = dir;
        U.uP.value = 1; U.uFront.value = rr * 1.2 - 0.1; U.uHi.value = rr > 0 && rr < 1 ? self.act : 0;
      });
      c.obsTrails.visible = rr < 1;
      c.predTrails.visible = rr >= 1;
      if (!self.gpu && c.view.el.offsetParent !== null) self.cpuFrame(c, t0, t1, f - t0, 1, dir);
      if (c.robot && c.view.el.offsetParent !== null) self.robotFrame(c, t0, t1, f - t0, rr);
      if (c.track && c.camBase) {
        const a = c.hz(t0), b = c.hz(t1), o = a.lerp(b, f - t0);
        c.cam.position.copy(c.camBase.pos).add(o);
        c.cam.lookAt(c.camBase.tgt.clone().add(o));
        // fix_v22 r7b: the contact shadow under the body (it was fixed at the centre of the whole travel, so it slid
        // away from a travelling body and made it read off-centre); the grid stays put
        if (c.floor && c.shadowBase) c.floor[0].position.copy(c.shadowBase).add(o);
      }
    });
  };

  /* ================================================================== the scale story */
  function clippedStd(a, q) {
    const s = Float64Array.from(a, Math.abs).sort();
    const c = s[Math.floor(q * (s.length - 1))];
    let m = 0;
    for (let i = 0; i < a.length; i++) m += Math.max(-c, Math.min(c, a[i]));
    m /= a.length;
    let v = 0;
    for (let i = 0; i < a.length; i++) { const x = Math.max(-c, Math.min(c, a[i])) - m; v += x * x; }
    return Math.sqrt(v / a.length);
  }

  // the per-mesh tag's fill while it is emphasised: a theme token (falls back to the old peach)
  const TAG_RGB = (getComputedStyle(document.documentElement).getPropertyValue("--tag-rgb") || "246,233,224").trim() || "246,233,224";
  function Method(root) {
    this.root = root;
    this.steps = Array.from(root.querySelectorAll(".mstep"));
    this.stageEl = root.querySelector(".method-stage");
    this.fiveEl = root.querySelector(".five");
    this.chipEl = root.querySelector(".story-chip");
    this.noteEl = root.querySelector(".story-note");
    this.panelEl = root.querySelector(".amp-panel");
    this.legendEl = root.querySelector(".scale-legend");
    this.tags = Array.from(root.querySelectorAll(".fcell .stag"));
    this.labels = this.steps.map(function (st) { return st.querySelector("h3").textContent; });
    this.step = this.steps[0].dataset.step; this.progress = 0;
    this.target = 0;                        // section progress p in [0,1] (from scroll)
    this.pe = { v: 0, vel: 0 };             // ... eased
    this.m = 0;
    this.manual = null;                     // the scrubber's alpha while it is being used
    // desktop: the two step cards read as one caption band inside the pinned stage (the originals stay
    // in the page as the scroll spacers and for screen readers; the band copies are aria-hidden)
    if (!V.PHONE) {
      const band = document.createElement("div");
      band.className = "mband"; band.setAttribute("aria-hidden", "true");
      this.bandCards = this.steps.map(function (st) {
        const c = document.createElement("div");
        c.className = "mband-card";
        c.innerHTML = st.querySelector(".story-card").innerHTML;
        band.appendChild(c);
        return c;
      });
      this.stageEl.appendChild(band);
      root.classList.add("banded");
    }
    this.scrubEl = root.querySelector(".amp-scrub");
    this.scrub = this.scrubEl ? this.scrubEl.querySelector("input") : null;
    const self = this;
    if (this.scrub) this.scrub.addEventListener("input", function () {
      let a = parseFloat(self.scrub.value);
      if (Math.abs(a - 1) < 0.06) { a = 1; self.scrub.value = "1"; }          // the detent
      self.manual = a; self.manualP = self.target;
    });
    new IntersectionObserver(function (es) {
      if (es[0].isIntersecting && !self.loading) self.load();
    }, { rootMargin: "900px 0px" }).observe(root);
    V.Stage.tickers.add(function (dt) { self.tick(dt); });
  }

  Method.prototype.load = function () {
    this.loading = true;
    const idx = window.__storyIndex || [];
    const self = this;
    this.story = {};
    return Promise.all(idx.map(function (e) {
      // fix_v22: the Franka pair also brings its link extras (link, link0pose) so its panel can draw the arm's link meshes
      return ClipData.loadClip(e, ["2"], e.family === "franka" ? V.extrasFor(e) : null, ["harmonic"]).then(function (c) {
        c.entry = e;
        self.story[e.family] = c;
      });
    })).then(function () {
      self.build();
      self.ready = true;
      self.drawn = null;
    }).catch(function (err) {
      console.error("[scale] " + (err && err.message ? err.message : err));
      self.noteEl.hidden = false;
      self.noteEl.textContent = "The 3D views could not be loaded.";
    });
  };

  /* Projected silhouette area of a posed mesh seen along `dir` (orthographic, a fixed world-size
     grid, so areas compare across directions). Faces are rasterized; a point set splats its
     vertices and edge midpoints. */
  function silhouette(P, N, faces, edges, dir, up, diag) {
    const fwd = dir.clone().negate().normalize();
    const right = new THREE.Vector3().crossVectors(fwd, up).normalize();
    const upv = new THREE.Vector3().crossVectors(right, fwd).normalize();
    let cx = 0, cy = 0, cz = 0;
    for (let v = 0; v < N; v++) { cx += P[v * 3]; cy += P[v * 3 + 1]; cz += P[v * 3 + 2]; }
    cx /= N; cy /= N; cz /= N;
    const G = 160, cell = 1.2 * diag / G, X = new Float32Array(N), Y = new Float32Array(N), grid = new Uint8Array(G * G);
    for (let v = 0; v < N; v++) {
      const a = P[v * 3] - cx, b = P[v * 3 + 1] - cy, c = P[v * 3 + 2] - cz;
      X[v] = (a * right.x + b * right.y + c * right.z) / cell + G / 2;
      Y[v] = (a * upv.x + b * upv.y + c * upv.z) / cell + G / 2;
    }
    const mark = function (x, y) { x = Math.round(x); y = Math.round(y); if (x >= 0 && y >= 0 && x < G && y < G) grid[y * G + x] = 1; };
    if (faces) {
      for (let f = 0; f < faces.length; f += 3) {
        const i0 = faces[f], i1 = faces[f + 1], i2 = faces[f + 2];
        const x0 = X[i0], y0 = Y[i0], x1 = X[i1], y1 = Y[i1], x2 = X[i2], y2 = Y[i2];
        const d = (x1 - x0) * (y2 - y0) - (x2 - x0) * (y1 - y0);
        const lx = Math.max(0, Math.floor(Math.min(x0, x1, x2))), hx = Math.min(G - 1, Math.ceil(Math.max(x0, x1, x2)));
        const ly = Math.max(0, Math.floor(Math.min(y0, y1, y2))), hy = Math.min(G - 1, Math.ceil(Math.max(y0, y1, y2)));
        mark(x0, y0); mark(x1, y1); mark(x2, y2);
        if (Math.abs(d) < 1e-9) continue;
        for (let y = ly; y <= hy; y++) for (let x = lx; x <= hx; x++) {
          const w1 = ((x - x0) * (y2 - y0) - (x2 - x0) * (y - y0)) / d, w2 = ((x1 - x0) * (y - y0) - (x - x0) * (y1 - y0)) / d;
          if (w1 >= 0 && w2 >= 0 && w1 + w2 <= 1) grid[y * G + x] = 1;
        }
      }
    } else {
      for (let v = 0; v < N; v++) for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) mark(X[v] + dx, Y[v] + dy);
      if (edges) for (let e = 0; e < edges.length; e += 2) mark((X[edges[e]] + X[edges[e + 1]]) / 2, (Y[edges[e]] + Y[edges[e + 1]]) / 2);
    }
    let n = 0;
    for (let k = 0; k < grid.length; k++) n += grid[k];
    return n;
  }

  /* Place `cam` on `dir` so the points pts [n*3] fill `fill` of the view in its limiting
     dimension (perspective, solved on the points themselves, not on box corners); returns the
     fill actually reached (max half-extent in NDC over x and y). */
  function fitPoints(cam, pts, dir, up, aspect, fill, shortSide) {
    const fwd = dir.clone().negate().normalize();
    const right = new THREE.Vector3().crossVectors(fwd, up).normalize();
    const upv = new THREE.Vector3().crossVectors(right, fwd).normalize();
    const n = pts.length / 3;
    let lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < n; i++) for (let a = 0; a < 3; a++) { lo[a] = Math.min(lo[a], pts[i * 3 + a]); hi[a] = Math.max(hi[a], pts[i * 3 + a]); }
    const c = new THREE.Vector3((lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2, (lo[2] + hi[2]) / 2);
    const tv = Math.tan(THREE.MathUtils.degToRad(cam.fov / 2)), th = tv * aspect;
    // shortSide (fix_v22 B): both extents within `fill` of the view's SHORTER side, so every subject's larger
    // extent is the same share of the cell whatever its own shape
    const cv = shortSide ? tv * Math.min(1, aspect) : tv, ch = shortSide ? cv : th;
    const q = new THREE.Vector3();
    let ox = 0, oy = 0, d = 1, reached = 0;
    for (let it = 0; it < 6; it++) {
      d = 0;
      for (let i = 0; i < n; i++) {
        q.set(pts[i * 3] - c.x, pts[i * 3 + 1] - c.y, pts[i * 3 + 2] - c.z);
        const x = q.dot(right) - ox, y = q.dot(upv) - oy, z = q.dot(fwd);
        d = Math.max(d, Math.abs(x) / (ch * fill) - z, Math.abs(y) / (cv * fill) - z);
      }
      const eye = c.clone().addScaledVector(right, ox).addScaledVector(upv, oy).addScaledVector(fwd, -d);
      cam.position.copy(eye);
      cam.up.copy(upv);
      cam.lookAt(eye.clone().add(fwd));
      cam.aspect = aspect;
      cam.near = Math.max(1e-4, d * 0.01); cam.far = d * 10;
      cam.updateProjectionMatrix(); cam.updateMatrixWorld();
      let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
      for (let i = 0; i < n; i++) {
        q.set(pts[i * 3], pts[i * 3 + 1], pts[i * 3 + 2]).project(cam);
        x0 = Math.min(x0, q.x); x1 = Math.max(x1, q.x); y0 = Math.min(y0, q.y); y1 = Math.max(y1, q.y);
      }
      reached = Math.max((x1 - x0) / 2, (y1 - y0) / 2);
      // re-centre on the projected extent (in camera-plane units at distance d)
      ox += (x0 + x1) / 2 * th * d; oy += (y0 + y1) / 2 * tv * d;
    }
    return reached;
  }

  /* fix_v22: the Franka panel draws the Panda link meshes (posed like Explore's) in place of its point cloud; every
     mesh vertex takes the heat colour of the nearest template point of its own link (the same colours the points had,
     on the same frozen scales), re-coloured whenever the panel repaints. The base (no template points) stays grey. */
  function heatShell(body, c, scene) {
    const N = c.N, ex = c.extra;
    body.objects.forEach(function (o) { if (o.isPoints) o.material.visible = false; });
    let robot = null, maps = [];
    const recolor = function () {
      if (!robot) return;
      robot.meshes.forEach(function (m, mi) {
        const mp = maps[mi], col = m.geometry.attributes.color.array;
        for (let v = 0; v < mp.length; v++) {
          if (mp[v] < 0) { col[v * 3] = 0.72; col[v * 3 + 1] = 0.74; col[v * 3 + 2] = 0.78; continue; }
          col[v * 3] = body.col[mp[v] * 3]; col[v * 3 + 1] = body.col[mp[v] * 3 + 1]; col[v * 3 + 2] = body.col[mp[v] * 3 + 2];
        }
        m.geometry.attributes.color.needsUpdate = true;
      });
    };
    const paint = body.paint;
    body.paint = function (err, t, vmax, rgb) { paint.call(body, err, t, vmax, rgb); recolor(); };
    // resolves to the posed link meshes' vertices (base included), for the panel's camera box (frfit)
    return V.panda().then(function (data) {
      const own = { links: data.links, groups: data.groups.map(function (g) { return { link: g.link, color: g.color, geometry: g.geometry.clone() }; }) };
      const pose0 = new Float32Array(ex.link0pose.buffer, ex.link0pose.byteOffset, ex.link0pose.length);
      robot = new V.Robot(scene, own, pose0, ex.link, N);
      const q = new THREE.Vector3();
      maps = robot.meshes.map(function (m) {
        const P = m.geometry.attributes.position.array, n = P.length / 3, k = m.userData.link;
        const ids = k >= 0 ? robot.idx[k] : [], mp = new Int32Array(n).fill(-1);
        m.geometry.setAttribute("color", new THREE.BufferAttribute(new Float32Array(n * 3), 3));
        m.material = new THREE.MeshLambertMaterial({ vertexColors: true });
        if (ids.length) for (let v = 0; v < n; v++) {
          q.set(P[v * 3], P[v * 3 + 1], P[v * 3 + 2]).applyMatrix4(robot.T0[k]);   // the link's rest pose = the template's rest frame
          let best = -1, bd = Infinity;
          for (const t of ids) { const dx = c.rest[t * 3] - q.x, dy = c.rest[t * 3 + 1] - q.y, dz = c.rest[t * 3 + 2] - q.z, dd = dx * dx + dy * dy + dz * dz; if (dd < bd) { bd = dd; best = t; } }
          mp[v] = best;
        }
        return mp;
      });
      robot.pose(c.rest, body.pos);
      recolor();
      // frfit: the drawn meshes in world space. The panel's pose is fixed (rest + H at frame 1; the scroll morph and the
      // slider change only colours and arrows), so this one pose is the union over everything the panel can show.
      const W = [], u = new THREE.Vector3();
      robot.meshes.forEach(function (m) {
        const P = m.geometry.attributes.position.array;
        for (let v = 0; v < P.length; v += 3) { u.set(P[v], P[v + 1], P[v + 2]).applyMatrix4(m.matrix); W.push(u.x, u.y, u.z); }
      });
      return Float32Array.from(W);
    }).catch(function (e) { console.error("[scale] franka shell: " + (e && e.message ? e.message : e)); return null; });
  }

  Method.prototype.build = function () {
    const self = this;
    this.five = [];
    this.fill = [];
    const cells = Array.from(this.fiveEl.querySelectorAll(".fcell"));
    const per = FAMILY_ORDER.map(function (fam) {
      const c = self.story[fam], d = c.dens["2"];
      const den = c.meta.densities.find(function (x) { return x.key === "2"; });
      const N = c.N, o = N * 3;                          // frame 1 of the pair: the completed frame
      const R = new Float64Array(N * 3);
      for (let i = 0; i < N * 3; i++) R[i] = c.gt[o + i] - d.harmonic[o + i];
      const box = V.clipBox(c, [c.gt]);
      const diag = box.hi.clone().sub(box.lo).length();
      const obs = new Set(Array.from(d.obs)), cand = [];
      for (let v = 0; v < N; v++) if (!obs.has(v)) cand.push(v);
      const sub = fpsIdx(c.rest, cand, N_ARROWS);
      const len = sub.map(function (v) { return Math.hypot(R[v * 3], R[v * 3 + 1], R[v * 3 + 2]); });
      const sHat = den.s_hat * den.normalizer;
      const mag = new Float32Array(N);
      for (let v = 0; v < N; v++) mag[v] = Math.hypot(R[v * 3], R[v * 3 + 1], R[v * 3 + 2]);
      return { c: c, d: d, R: R, box: box, diag: diag, sub: sub, len: len, cap: pct(len, 0.95),
               s: clippedStd(R, 0.995), sHat: sHat, mag: mag };
    });
    // fix_v22 freeze: the POOLED scales (both magnifications, both colour scales, the slider's) use frozen statistics
    // for any family listed in window.__methodFrozen.slot (assets_story2/method_frozen.js): the legged clip was
    // swapped, and its previous clip's cap / diag / s-hat / |R| keep every other panel and the slider as they were
    const FZ = (window.__methodFrozen && window.__methodFrozen.slot) || {};
    const pool = per.map(function (x, i) { const z = FZ[FAMILY_ORDER[i]]; return z ? { cap: z.cap, diag: z.diag, sHat: z.sHat, mag: Float32Array.from(z.mag) } : x; });   // |R| stored as float32, as in per
    // one common magnification per step: the family whose 95th-percentile arrow is longest
    // (relative to its body in step 1, relative to s-hat in step 2) draws it at ARROW_FRAC of its body
    const g1 = ARROW_FRAC / Math.max.apply(null, pool.map(function (x) { return x.cap / x.diag; }));
    const g2 = ARROW_FRAC / Math.max.apply(null, pool.map(function (x) { return x.cap / x.sHat; }));
    const b1 = per.map(function (x) { return x.s / x.diag; }), b2 = per.map(function (x) { return x.s / x.sHat; });
    // the amplitudes behind the two steps, kept for the checks (never displayed)
    this.amp = per.map(function (x, i) { return { family: FAMILY_ORDER[i], s_over_diag: b1[i], s_over_shat: b2[i] }; });
    // colour: |R| / body (step 1) and |R / s-hat| (step 2), each on ONE scale for all five: the
    // 95th percentile of the pooled per-vertex values maps to the top of the colormap
    const pool1 = [], pool2 = [];
    pool.forEach(function (x) { for (let v = 0; v < x.mag.length; v++) { pool1.push(x.mag[v] / x.diag); pool2.push(x.mag[v] / x.sHat); } });
    const vmax1 = pct(pool1, 0.95) || 1, vmax2 = pct(pool2, 0.95) || 1;
    this.scales = { g1: g1, g2: g2, vmax1: vmax1, vmax2: vmax2 };
    per.forEach(function (x, i) {
      const c = x.c, d = x.d, N = c.N, o = N * 3;
      const s = V.makeScene();
      const cam = new THREE.PerspectiveCamera(30, 1, 0.01, 100);
      const el = cells[i].querySelector(".view");
      const view = { el: el, scene: s.scene, key: s.key, camera: cam, ready: true, bg: V.THEME.stage3d };
      const isArm = FAMILY_ORDER[i] === "franka" && c.extra && c.extra.link && c.extra.link0pose;
      const body = new V.Body(c, s.scene, isArm ? { noRobot: true } : {});
      body.pose(d.harmonic, 1);
      const shellP = isArm ? heatShell(body, c, s.scene) : null;
      body.setObs(d.obs, true);
      const arr = new V.Arrows(s.scene, N_ARROWS, R_HEX);
      const n = x.sub.length;
      const starts = new Float32Array(n * 3), v1 = new Float32Array(n * 3), v2 = new Float32Array(n * 3);
      const rv = new Float32Array(n * 3);                                  // the clipped residual itself
      const clipped = new Uint8Array(n);
      x.sub.forEach(function (v, j) {
        const f = x.len[j] > x.cap ? x.cap / x.len[j] : 1;
        clipped[j] = x.len[j] > x.cap ? 1 : 0;
        for (let a = 0; a < 3; a++) {
          const r = x.R[v * 3 + a] * f;
          rv[j * 3 + a] = r;
          starts[j * 3 + a] = c.rest[v * 3 + a] + d.harmonic[o + v * 3 + a];     // from H ...
          v1[j * 3 + a] = r * g1;                                              // ... toward F
          v2[j * 3 + a] = r / x.sHat * x.diag * g2;
        }
      });
      // the view with the largest silhouette of the posed mesh (cloth: its camera, ~30 degrees
      // above the mean normal), then a tight fit on the mesh AND every arrow tip of both steps
      const Hp = new Float32Array(N * 3);
      for (let k = 0; k < N * 3; k++) Hp[k] = c.rest[k] + d.harmonic[o + k];
      const vd = V.viewDir(c.entry), up = vd.up;
      let best = vd.dir, bestA = -1;
      if (!c.entry.camera) {
        const e1 = new THREE.Vector3(1, 0, 0);
        if (Math.abs(e1.dot(up)) > 0.9) e1.set(0, 1, 0);
        e1.addScaledVector(up, -e1.dot(up)).normalize();
        const e2 = new THREE.Vector3().crossVectors(up, e1).normalize();
        const faces = c.meta.topology === "faces" ? c.topo : null, edges = faces ? null : c.topo;
        for (let az = 0; az < 360; az += 30) {
          const a = THREE.MathUtils.degToRad(az), el15 = THREE.MathUtils.degToRad(15);
          const dir = e1.clone().multiplyScalar(Math.cos(a) * Math.cos(el15)).addScaledVector(e2, Math.sin(a) * Math.cos(el15))
                        .addScaledVector(up, Math.sin(el15)).normalize();
          const A = silhouette(Hp, N, faces, edges, dir, up, x.diag);
          if (A > bestA) { bestA = A; best = dir; }
        }
      }
      const pts = new Float32Array(N * 3 + 2 * n * 3);
      pts.set(Hp);
      for (let j = 0; j < n * 3; j++) { pts[N * 3 + j] = starts[j] + v1[j]; pts[N * 3 + n * 3 + j] = starts[j] + v2[j]; }
      view.fit = function (aspect) {
        self.fill[i] = { family: FAMILY_ORDER[i], fill: fitPoints(cam, pts, best, up, aspect, FIT_FILL), aspect: aspect };
        view.fitAspect = aspect;
      };
      // frfit (Franka panel only): once its link meshes exist, the camera is fitted ONCE to the template points, every
      // arrow tip AND every posed mesh vertex (the grey base included); same fit rule, only the point set grows.
      if (shellP) shellP.then(function (X) {
        if (!X || !X.length) return;
        const all = new Float32Array(pts.length + X.length); all.set(pts); all.set(X, pts.length);
        view.fit = function (aspect) {
          self.fill[i] = { family: FAMILY_ORDER[i], fill: fitPoints(cam, all, best, up, aspect, FIT_FILL), aspect: aspect };
          view.fitAspect = aspect;
        };
        view.fitAspect = 0;                                              // the stage refits on its next frame
      });
      const vals = new Float32Array(2 * N);
      // display only: how many of the (farthest-point ordered) arrows are drawn, and the edge-graph
      // families (Franka) drawn as their coloured points alone, larger, without the grey edge lattice
      const nd = Math.min(n, ARROWS_DRAWN[FAMILY_ORDER[i]] || n), q3 = nd * 3;
      if (!body.faces) body.objects.forEach(function (o) {
        if (o.isLineSegments) o.material.visible = false;
        else if (o.isPoints) o.material.size = 4.2 * V.DPR;
      });
      self.five.push({ arr: arr, body: body, starts: starts.subarray(0, q3), v1: v1.subarray(0, q3), v2: v2.subarray(0, q3),
                       cur: new Float32Array(q3), clipped: clipped.subarray(0, nd),
                       radius: ARROW_R * x.diag, a: Float32Array.from(x.mag, function (m) { return m / x.diag / vmax1; }),
                       b: Float32Array.from(x.mag, function (m) { return m / x.sHat / vmax2; }), vals: vals, N: N, m: -1,
                       rv: rv.subarray(0, q3), diag: x.diag, sHat: x.sHat, cap: x.cap,
                       aRaw: Float32Array.from(x.mag, function (m) { return m / x.diag; }),
                       sorted: Float32Array.from(x.mag, function (m) { return m / x.diag; }).sort(),
                       // the slider's pooled scale uses the same (possibly frozen) statistics as above
                       pc: pool[i].cap, pd: pool[i].diag, ps: pool[i].sHat,
                       psorted: pool[i] === x ? null : Float32Array.from(pool[i].mag, function (m) { return m / pool[i].diag; }).sort() });
      V.Stage.views.add(view);
    });
    if (this.legendEl) this.legendEl.querySelector(".bar").style.background = V.HEAT_CSS;
  };

  Method.prototype.readScroll = function () {
    // section progress: 0 when the stage pins, 1 when it unpins
    const r = this.root.getBoundingClientRect();
    const top = parseFloat(getComputedStyle(this.stageEl).top) || 0;
    this.target = Math.min(1, Math.max(0, (top - r.top) / Math.max(1, r.height - this.stageEl.offsetHeight)));
    // the active step sits under the reading line: mid-screen on desktop, lower half on phones
    // (where the 3D takes the top half)
    const line = window.innerHeight * (V.PHONE ? 0.72 : 0.5);
    let el = this.steps[0], prog = 0;
    for (const s of this.steps) {
      const r = s.getBoundingClientRect();
      if (r.top <= line) { el = s; prog = Math.min(Math.max((line - r.top) / r.height, 0), 1); }
    }
    if (this.bandCards) {                                // desktop band: the step follows the progress
      el = this.target < 0.5 ? this.steps[0] : this.steps[1];
      prog = this.target < 0.5 ? this.target * 2 : (this.target - 0.5) * 2;
      const k = this.steps.indexOf(el);
      this.bandCards.forEach(function (c, j) { c.classList.toggle("on", j === k); });
    }
    if (el !== this.activeEl) {
      if (this.activeEl) this.activeEl.classList.remove("active");
      el.classList.add("active");
      this.activeEl = el;
    }
    this.step = el.dataset.step;
    this.progress = prog;
    if (V.PHONE) {                                       // phones: a card never covers the 3D
      const sb = this.root.querySelector(".method-stage").getBoundingClientRect().bottom;
      this.steps.forEach(function (st) {
        const c = st.querySelector(".story-card");
        c.style.setProperty("--vis", Math.min(1, Math.max(0, (c.getBoundingClientRect().top - sb + 40) / 40)).toFixed(3));
      });
    }
  };

  /* Section progress p (eased) sets the whole state; no clock. p 0..0.25 holds step 1; family i
     morphs R -> R / s-hat (arrows and colour together) over [0.25 + 0.075 i, 0.45 + 0.075 i];
     p 0.75..1 holds step 2. The panel's opacity and each tag's emphasis are functions of p. */
  Method.prototype.tick = function (dt) {
    const r = this.root.getBoundingClientRect();
    if (r.bottom < 0 || r.top > window.innerHeight) return;
    this.readScroll();
    if (!this.ready) return;
    const p = damp(this.pe, this.target, dt), self = this;
    this.p = p;
    if (this.manual !== null && Math.abs(this.target - this.manualP) > 0.03) { this.manual = null; this.lastAlpha = null; this.five.forEach(function (f) { f.m = -1; }); }
    if (this.manual !== null) { this.applyAlpha(this.manual); return; }
    this.chipEl.textContent = this.labels[p < 0.5 ? 0 : 1];                  // the persistent step label
    this.noteEl.hidden = false;
    this.noteEl.textContent = p < 0.5 ? "R · one magnification for all five · longest arrows clipped (light tip)"
                                      : "R / ŝ · one display scale for all five · longest arrows clipped (light tip)";
    const pan = smooth((p - 0.18) / 0.07);
    this.panelEl.style.opacity = pan.toFixed(3);
    this.panelEl.style.transform = "translateY(" + (6 * (1 - pan)).toFixed(2) + "px)";
    let mMin = 1;
    this.five.forEach(function (f, i) {
      const a0 = MORPH_A + MORPH_STEP * i;
      const m = smooth((p - a0) / MORPH_LEN);
      mMin = Math.min(mMin, m);
      const tag = self.tags[i], e = Math.sin(Math.PI * m);                  // emphasis peaks mid-morph
      tag.style.opacity = smooth(m * 4).toFixed(3);
      tag.style.transform = "scale(" + (1 + 0.3 * e).toFixed(3) + ")";
      tag.style.backgroundColor = "rgba(" + TAG_RGB + "," + (0.92 * e).toFixed(3) + ")";
      if (Math.abs(m - f.m) < 1e-4) return;
      f.m = m;
      for (let q = 0; q < f.cur.length; q++) f.cur[q] = f.v1[q] + m * (f.v2[q] - f.v1[q]);
      f.arr.set(f.starts, f.cur, f.radius, f.clipped, TIP_HEX);
      f.arr.visible(true);
      for (let v = 0; v < f.N; v++) f.vals[f.N + v] = f.a[v] + m * (f.b[v] - f.a[v]);
      f.body.paint(f.vals, 1, 1);
    });
    this.m = mMin;
    if (this.scrub) {                        // the scrubber shows where the scroll has put the state
      let mean = 0;
      this.five.forEach(function (f) { mean += Math.max(0, f.m); });
      mean /= this.five.length;
      if (document.activeElement !== this.scrub) this.scrub.value = mean.toFixed(3);
      this.scrubEl.classList.toggle("at-detent", mean > 0.97);
    }
  };

  /* The scrubber: every family's real residual times (body / s-hat)^alpha, renormalised to one
     display scale (arrows) and one colour scale (pooled 95th percentile). alpha = 0 is step 1
     exactly, alpha = 1 is step 2 exactly; other values only stretch or shrink the same data. */
  Method.prototype.applyAlpha = function (al) {
    if (this.lastAlpha === al) return;
    this.lastAlpha = al;
    const F = this.five, w = F.map(function (f) { return Math.pow(f.diag / f.sHat, al); });
    // pooled quantities use each slot's pooling statistics (identical to its own unless frozen; see build)
    const wp = F.map(function (f) { return Math.pow(f.pd / f.ps, al); }), S = F.map(function (f) { return f.psorted || f.sorted; });
    const G = ARROW_FRAC / Math.max.apply(null, F.map(function (f, i) { return f.pc * wp[i] / f.pd; }));
    // pooled 95th percentile of aRaw x w over all five, by bisection on the sorted copies
    let total = 0, hi = 0;
    F.forEach(function (f, i) { total += S[i].length; hi = Math.max(hi, S[i][S[i].length - 1] * wp[i]); });
    let lo = 0;
    for (let it = 0; it < 40; it++) {
      const t = (lo + hi) / 2;
      let cnt = 0;
      F.forEach(function (f, i) {
        const a = S[i], x = t / wp[i];
        let l = 0, r = a.length;
        while (l < r) { const m = (l + r) >> 1; if (a[m] <= x) l = m + 1; else r = m; }
        cnt += l;
      });
      if (cnt < 0.95 * total) lo = t; else hi = t;
    }
    const vmax = hi || 1;
    F.forEach(function (f, i) {
      for (let q = 0; q < f.cur.length; q++) f.cur[q] = f.rv[q] * w[i] * G;
      f.arr.set(f.starts, f.cur, f.radius, f.clipped, TIP_HEX);
      f.arr.visible(true);
      for (let v = 0; v < f.N; v++) f.vals[f.N + v] = f.aRaw[v] * w[i] / vmax;
      f.body.paint(f.vals, 1, 1);
    });
    const on = Math.abs(al - 1) < 1e-6;
    this.scrubEl.classList.toggle("at-detent", on);
    this.panelEl.style.opacity = on ? "1" : "0.35";
    this.tags.forEach(function (t) { t.style.opacity = on ? "1" : "0"; t.style.transform = ""; t.style.backgroundColor = ""; });
    this.chipEl.textContent = this.labels[al >= 0.5 ? 1 : 0];
  };

  window.Story = { Hero: Hero, Method: Method };
})();
