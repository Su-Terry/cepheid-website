/* Rendering primitives + the comparison card.

   One WebGL renderer for the whole page: the fixed #stage canvas is drawn over the page and
   every 3D panel (.view) is rendered into its own scissor rectangle; hidden or off-screen
   views are skipped. */
(function () {
  "use strict";

  /* Theme: every colour the renderer uses comes from the CSS design tokens (css/site.css:
     :root and :root[data-theme="dark"]), read once at startup. */
  const CSSV = getComputedStyle(document.documentElement);
  function tok(name, fallback) {
    const v = CSSV.getPropertyValue(name).trim();
    return v || fallback;
  }
  function tokHex(name, fallback) { return new THREE.Color(tok(name, fallback)).getHex(); }
  const THEME = {
    dark: document.documentElement.getAttribute("data-theme") === "dark",
    stage: tokHex("--stage-bg", "#f4f5f8"),
    cell: tok("--cell-bg", "#f0f1f4") === "transparent" ? tokHex("--page", "#fbfbfc") : tokHex("--cell-bg", "#f0f1f4"),
    edge: tokHex("--edge", "#8d939e"), arrow: tokHex("--arrow", "#ad7a5c"),
    arrowTip: tokHex("--arrow-tip", "#e3cdbf"), hemiGround: tokHex("--hemi-ground", "#9a9fa8"),
  };
  const BG = THEME.stage;
  THEME.page = tokHex("--page", "#fbfbfc");
  // a look (data-look) may make the wall tiles transparent (the page shows through) and set the
  // lighting: hemisphere sky/ground/intensity, key intensity, and a rim term (lighting only)
  THEME.cellClear = tok("--cell-bg", "#f0f1f4") === "transparent" ? null : THEME.cell;
  THEME.sky = tokHex("--light-sky", "#ffffff");
  THEME.hemi = parseFloat(tok("--light-hemi", "0.62"));
  THEME.key = parseFloat(tok("--light-key", "0.62"));
  THEME.rim = parseFloat(tok("--rim", "0"));
  THEME.rimCol = tokHex("--rim-col", "#ffffff");
  // the 3D stages' own background (null: the page shows through), material tuning, observed-point
  // red, floor grid and contact shadow strength -- all per theme
  THEME.stage3d = tok("--stage-3d", "transparent") === "transparent" ? null : tokHex("--stage-3d", "#24272c");
  THEME.matDim = parseFloat(tok("--mat-dim", "1")); THEME.matSat = parseFloat(tok("--mat-sat", "1"));
  THEME.obsRgb = tok("--obs-rgb", "0.824, 0.227, 0.180").split(",").map(parseFloat);
  THEME.gridRgb = tok("--grid-rgb", "0.07, 0.08, 0.10").split(",").map(parseFloat);
  THEME.gridAlpha = parseFloat(tok("--grid-alpha", "0.07"));
  THEME.shadowAlpha = parseFloat(tok("--shadow-alpha", "0.2"));
  /* the theme's material tuning: value x matDim, saturation x matSat (1, 1 in light) */
  function tune(rgb) {
    const l = 0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2];
    return rgb.map(function (c) { return (l + (c - l) * THEME.matSat) * THEME.matDim; });
  }
  THEME.tune = tune;
  /* a full-viewport quad in the page colour: draws a view's fade (WebGL ignores CSS opacity) */
  const FADE = (function () {
    const scene = new THREE.Scene(), cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    const mat = new THREE.MeshBasicMaterial({ color: THEME.page, transparent: true, opacity: 0, depthTest: false, depthWrite: false });
    scene.add(new THREE.Mesh(new THREE.PlaneGeometry(2, 2), mat));
    return { scene: scene, cam: cam, mat: mat };
  })();
  const GREY = [0.74, 0.76, 0.8];
  const EDGE_HEX = THEME.edge;             // point sets: graph edges
  // the heatmap ramp, per theme (light: YlGnBu, no red, so the red observed points stay
  // distinct; dark: a quiet near-background blue rising to a bright amber)
  const HEAT_HEX = [0, 1, 2, 3, 4].map(function (i) { return tok("--heat-" + i, ["#fbf7d4", "#c7e9b4", "#41b6c4", "#225ea8", "#0b1f5c"][i]); });
  const HEAT = HEAT_HEX.map(function (h) { const c = new THREE.Color(h); return [c.r, c.g, c.b]; });
  const HEAT_CSS = "linear-gradient(90deg," + HEAT_HEX.join(",") + ")";
  const FILL = 0.8;            // the object spans ~80% of the view along its tighter axis
  const PHONE = window.matchMedia ? window.matchMedia("(max-width: 767px)").matches : false;
  const DPR = Math.min(window.devicePixelRatio || 1, PHONE ? 1.5 : 2);
  const COARSE = window.matchMedia ? window.matchMedia("(pointer: coarse)").matches : false;

  function heat(x, out, o) {
    x = Math.min(Math.max(x, 0), 1) * (HEAT.length - 1);
    const i = Math.min(Math.floor(x), HEAT.length - 2), f = x - i, a = HEAT[i], b = HEAT[i + 1];
    out[o] = a[0] + (b[0] - a[0]) * f;
    out[o + 1] = a[1] + (b[1] - a[1]) * f;
    out[o + 2] = a[2] + (b[2] - a[2]) * f;
  }

  /* ------------------------------------------------------------------ appearance
     Per family, the best available (see the site README): Franka is drawn with its URDF
     visual meshes (material colours; each link posed by a rigid fit to the points); cloth uses
     its 2D material coordinates as UVs with a plain procedural fabric; families with no
     appearance data get one muted matte colour each. All get a subtle cavity AO. The error
     heatmap overrides all of it. */
  const FAMILY_RGB = {
    dt4d: [0.74, 0.66, 0.55],        // sand
    amass: [0.76, 0.62, 0.56],       // clay
    cape: [0.76, 0.62, 0.56],
    genbot: [0.55, 0.62, 0.60],      // sage slate
    franka: [0.80, 0.81, 0.82],      // (points only in heatmap mode; the meshes carry materials)
    flag: [0.95, 0.95, 0.95],        // the fabric texture carries the hue
  };
  const APPEAR_EXTRAS = { franka: ["link", "link0pose"], flag: ["uv"] };
  function extrasFor(entry) { return APPEAR_EXTRAS[entry && entry.family] || []; }

  /* cavity AO at the rest shape: a vertex whose neighbours sit above it along its normal is in
     a crease and gets darker (at most AO_MAX); flat and convex areas are untouched */
  const AO_MAX = 0.28;
  function cavityAO(rest, faces, N) {
    const nrm = new Float32Array(N * 3), sum = new Float32Array(N * 3), cnt = new Float32Array(N), el = new Float32Array(N);
    for (let f = 0; f < faces.length; f += 3) {
      const a = faces[f], b = faces[f + 1], c = faces[f + 2];
      const ux = rest[b * 3] - rest[a * 3], uy = rest[b * 3 + 1] - rest[a * 3 + 1], uz = rest[b * 3 + 2] - rest[a * 3 + 2];
      const vx = rest[c * 3] - rest[a * 3], vy = rest[c * 3 + 1] - rest[a * 3 + 1], vz = rest[c * 3 + 2] - rest[a * 3 + 2];
      const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
      [a, b, c].forEach(function (v, k) {
        nrm[v * 3] += nx; nrm[v * 3 + 1] += ny; nrm[v * 3 + 2] += nz;
        const o1 = [a, b, c][(k + 1) % 3], o2 = [a, b, c][(k + 2) % 3];
        for (let d = 0; d < 3; d++) sum[v * 3 + d] += rest[o1 * 3 + d] + rest[o2 * 3 + d];
        cnt[v] += 2;
        el[v] += Math.hypot(rest[o1 * 3] - rest[v * 3], rest[o1 * 3 + 1] - rest[v * 3 + 1], rest[o1 * 3 + 2] - rest[v * 3 + 2]);
      });
    }
    const ao = new Float32Array(N).fill(1);
    for (let v = 0; v < N; v++) {
      if (!cnt[v]) continue;
      const L = Math.hypot(nrm[v * 3], nrm[v * 3 + 1], nrm[v * 3 + 2]) || 1, e = el[v] / (cnt[v] / 2) || 1;
      let c = 0;
      for (let d = 0; d < 3; d++) c += nrm[v * 3 + d] / L * (sum[v * 3 + d] / cnt[v] - rest[v * 3 + d]);
      ao[v] = 1 - AO_MAX * Math.min(1, Math.max(0, 2.5 * c / e));
    }
    return ao;
  }

  /* base colour per vertex (family colour x AO), and the UVs when the clip has them */
  function appearanceOf(clip, rest, topo) {
    const N = clip.N, fam = (clip.meta && clip.meta.family) || (clip.entry && clip.entry.family);
    let rgb = THEME.tune(FAMILY_RGB[fam] || GREY);
    if (fam === "franka" && !THEME.dark) rgb = rgb.map(function (x) { return x * ROBOT_SHELL; });   // as the Panda shells (fix_v22 M)
    const faces = clip.meta.topology === "faces" ? (topo || clip.topo) : null;
    const ao = faces ? cavityAO(rest || clip.rest, faces, N) : null;
    const base = new Float32Array(N * 3);
    for (let v = 0; v < N; v++) for (let a = 0; a < 3; a++) base[v * 3 + a] = rgb[a] * (ao ? ao[v] : 1);
    const ex = clip.extra || {};
    const uv = ex.uv ? new Float32Array(ex.uv.buffer, ex.uv.byteOffset, ex.uv.length) : null;
    return { family: fam, base: base, uv: uv };
  }

  /* a plain woven fabric (no text, no logo), drawn once on a 512 px canvas */
  let FABRIC = null;
  function fabricTexture() {
    if (FABRIC) return FABRIC;
    const S = 512, cv = document.createElement("canvas");
    cv.width = cv.height = S;
    const g = cv.getContext("2d");
    g.fillStyle = "rgb(112,134,165)";                    // dusty blue
    g.fillRect(0, 0, S, S);
    let seed = 7;
    const rnd = function () { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
    for (let i = 0; i < S; i += 4) {                     // warp and weft threads
      g.fillStyle = "rgba(255,255,255," + (0.05 + 0.05 * rnd()).toFixed(3) + ")";
      g.fillRect(i, 0, 2, S);
      g.fillStyle = "rgba(0,0,0," + (0.04 + 0.04 * rnd()).toFixed(3) + ")";
      g.fillRect(0, i + 2, S, 2);
    }
    for (let k = 0; k < 6000; k++) {                     // slub
      g.fillStyle = "rgba(255,255,255," + (0.05 * rnd()).toFixed(3) + ")";
      g.fillRect(rnd() * S, rnd() * S, 1 + 3 * rnd(), 1);
    }
    FABRIC = new THREE.CanvasTexture(cv);
    FABRIC.wrapS = FABRIC.wrapT = THREE.RepeatWrapping;
    FABRIC.repeat.set(3, 3);
    FABRIC.anisotropy = 4;
    return FABRIC;
  }

  /* ---- rigid fit (Horn's quaternion method): R, t minimising |R a + t - b| over a subset */
  function jacobiMaxEig(M) {                             // symmetric 4x4 -> eigenvector of the largest eigenvalue
    const A = M.map(function (r) { return r.slice(); }), V = [[1, 0, 0, 0], [0, 1, 0, 0], [0, 0, 1, 0], [0, 0, 0, 1]];
    for (let sweep = 0; sweep < 30; sweep++) {
      let off = 0;
      for (let p = 0; p < 4; p++) for (let q = p + 1; q < 4; q++) off += A[p][q] * A[p][q];
      if (off < 1e-24) break;
      for (let p = 0; p < 4; p++) for (let q = p + 1; q < 4; q++) {
        if (Math.abs(A[p][q]) < 1e-30) continue;
        const th = (A[q][q] - A[p][p]) / (2 * A[p][q]);
        const t = (th >= 0 ? 1 : -1) / (Math.abs(th) + Math.sqrt(th * th + 1)), c = 1 / Math.sqrt(t * t + 1), s = t * c;
        for (let k = 0; k < 4; k++) {
          const akp = A[k][p], akq = A[k][q];
          A[k][p] = c * akp - s * akq; A[k][q] = s * akp + c * akq;
        }
        for (let k = 0; k < 4; k++) {
          const apk = A[p][k], aqk = A[q][k];
          A[p][k] = c * apk - s * aqk; A[q][k] = s * apk + c * aqk;
        }
        for (let k = 0; k < 4; k++) {
          const vkp = V[k][p], vkq = V[k][q];
          V[k][p] = c * vkp - s * vkq; V[k][q] = s * vkp + c * vkq;
        }
      }
    }
    let b = 0;
    for (let i = 1; i < 4; i++) if (A[i][i] > A[b][b]) b = i;
    return [V[0][b], V[1][b], V[2][b], V[3][b]];
  }
  function fitRigid(A, B, idx, out) {
    let ax = 0, ay = 0, az = 0, bx = 0, by = 0, bz = 0;
    const n = idx.length;
    for (let k = 0; k < n; k++) {
      const i = idx[k] * 3;
      ax += A[i]; ay += A[i + 1]; az += A[i + 2]; bx += B[i]; by += B[i + 1]; bz += B[i + 2];
    }
    ax /= n; ay /= n; az /= n; bx /= n; by /= n; bz /= n;
    let Sxx = 0, Sxy = 0, Sxz = 0, Syx = 0, Syy = 0, Syz = 0, Szx = 0, Szy = 0, Szz = 0;
    for (let k = 0; k < n; k++) {
      const i = idx[k] * 3;
      const x = A[i] - ax, y = A[i + 1] - ay, z = A[i + 2] - az, X = B[i] - bx, Y = B[i + 1] - by, Z = B[i + 2] - bz;
      Sxx += x * X; Sxy += x * Y; Sxz += x * Z; Syx += y * X; Syy += y * Y; Syz += y * Z; Szx += z * X; Szy += z * Y; Szz += z * Z;
    }
    const q = jacobiMaxEig([
      [Sxx + Syy + Szz, Syz - Szy, Szx - Sxz, Sxy - Syx],
      [Syz - Szy, Sxx - Syy - Szz, Sxy + Syx, Szx + Sxz],
      [Szx - Sxz, Sxy + Syx, -Sxx + Syy - Szz, Syz + Szy],
      [Sxy - Syx, Szx + Sxz, Syz + Szy, -Sxx - Syy + Szz]]);
    const quat = new THREE.Quaternion(q[1], q[2], q[3], q[0]).normalize();
    out = out || new THREE.Matrix4();
    out.makeRotationFromQuaternion(quat);
    const c = new THREE.Vector3(ax, ay, az).applyQuaternion(quat);
    out.setPosition(bx - c.x, by - c.y, bz - c.z);
    return out;
  }

  /* ---- the Panda visual meshes (loaded once, shared) */
  const ROBOT_SHELL = 0.68;
  let PANDA = null;
  function panda() {
    if (PANDA) return PANDA;
    PANDA = (async function () {
      if (!window.__pandaVisual) await ClipData.loadScriptOnce("assets/robots/panda/visual.meta.js");
      const meta = window.__pandaVisual;
      const buf = await ClipData.loadBin("panda", "visual.bin", "assets/robots/");
      let o = 0;
      const groups = meta.groups.map(function (g) {
        const q = new Uint16Array(buf, o, g.n_vertices * 3); o += g.n_vertices * 6;
        const f = new Uint16Array(buf, o, g.n_faces * 3); o += g.n_faces * 6;
        const P = new Float32Array(g.n_vertices * 3);
        for (let i = 0; i < P.length; i++) { const a = i % 3; P[i] = g.lo[a] + q[i] / 65535 * (g.hi[a] - g.lo[a]); }
        const geo = new THREE.BufferGeometry();
        geo.setAttribute("position", new THREE.BufferAttribute(P, 3));
        geo.setIndex(new THREE.BufferAttribute(new Uint16Array(f), 1));
        geo.computeVertexNormals();
        // the meshes' pure white is toned down a little (nothing on the page is pure white)
        const col = THEME.tune(g.color.map(function (x) { return Math.min(x, 0.9); }));
        return { link: meta.links.indexOf(g.link), geometry: geo, color: col };
      });
      return { links: meta.links, groups: groups };
    })();
    return PANDA;
  }

  /* one posed Panda: link k is drawn at (rigid fit of the rest points to the current points)
     x (the link's rest pose); the fixed base stays at identity */
  function Robot(scene, data, pose0, link, N) {
    const self = this;
    this.T0 = [];
    for (let k = 0; k < data.links.length; k++) {
      const r = pose0.subarray(k * 12, k * 12 + 12);
      this.T0.push(new THREE.Matrix4().set(r[0], r[1], r[2], r[3], r[4], r[5], r[6], r[7], r[8], r[9], r[10], r[11], 0, 0, 0, 1));
    }
    this.idx = data.links.map(function () { return []; });
    for (let v = 0; v < N; v++) if (link[v] < this.idx.length) this.idx[link[v]].push(v);
    this.meshes = data.groups.map(function (g) {
      // light theme: the near-white shells are drawn a mid grey (x ROBOT_SHELL; dark parts unchanged) so the arm
      // holds the other meshes' contrast against the light page (material only; fix_v22 M)
      const lum = 0.3 * g.color[0] + 0.59 * g.color[1] + 0.11 * g.color[2], k = lum > 0.5 && !THEME.dark ? ROBOT_SHELL : 1;
      const m = new THREE.Mesh(g.geometry, new THREE.MeshLambertMaterial({ color: new THREE.Color(g.color[0] * k, g.color[1] * k, g.color[2] * k * 1.03) }));
      m.matrixAutoUpdate = false;
      m.userData.link = g.link;
      if (g.link >= 0) m.matrix.copy(self.T0[g.link]);
      scene.add(m);
      return m;
    });
    this.M = new THREE.Matrix4();
    this.shown = true;
  }
  Robot.prototype.pose = function (rest, pos) {
    const self = this;
    this.idx.forEach(function (ids, k) {
      if (ids.length < 3) return;
      fitRigid(rest, pos, ids, self.M);
      self.meshes.forEach(function (m) { if (m.userData.link === k) m.matrix.multiplyMatrices(self.M, self.T0[k]); });
    });
    this.meshes.forEach(function (m) { m.matrixWorldNeedsUpdate = true; });
    if (this.mirrors) this.mirrors.forEach(function (m, i) { m.matrix.multiplyMatrices(self.mirrorM, self.meshes[i].matrix); });
  };
  Robot.prototype.enableMirror = function (scene, M) {
    const self = this;
    this.mirrorM = M;
    this.mirrors = this.meshes.map(function (m) { const r = mirrorOf(m, new THREE.Matrix4().multiplyMatrices(M, m.matrix)); scene.add(r); return r; });
    this.mirrors.forEach(function (r, i) { r.visible = self.meshes[i].visible; });
  };
  Robot.prototype.visible = function (on) {
    this.shown = on;
    this.meshes.forEach(function (m) { m.visible = on; });
    if (this.mirrors) this.mirrors.forEach(function (m) { m.visible = on; });
  };
  /* per-link opacity (the wall's fill): a[k] in [0,1]; the base follows link 0 */
  Robot.prototype.opacity = function (a) {
    this.meshes.forEach(function (m) {
      const x = a[Math.max(0, m.userData.link)];
      m.visible = this.shown && x > 0.02;
      const tr = x < 0.999;
      if (m.material.transparent !== tr) { m.material.transparent = tr; m.material.needsUpdate = true; }
      m.material.opacity = x;
    }, this);
  };

  /* ------------------------------------------------------------------ stage */
  const Stage = {
    renderer: null, canvas: null, views: new Set(), tickers: new Set(), last: 0, path: null,
    /* Throws if WebGL is unavailable. Otherwise picks the wall's render path once and logs it:
       gpu-float (vertex textures + float textures: WebGL2, or WebGL1 with OES_texture_float),
       gpu-half (vertex textures + half-float textures only) or cpu (neither). ?render=<path>
       forces one, for testing. */
    init: function () {
      this.canvas = document.getElementById("stage");
      try {
        this.renderer = new THREE.WebGLRenderer({ canvas: this.canvas, antialias: true, alpha: true });
      } catch (e) {
        this.path = "none";
        throw new Error("WebGL is not available (" + (e && e.message ? e.message : e) + ")");
      }
      const caps = this.renderer.capabilities, ext = this.renderer.extensions;
      const vt = caps.maxVertexTextures > 0;
      const fl = caps.isWebGL2 || ext.has("OES_texture_float");
      const hf = caps.isWebGL2 || ext.has("OES_texture_half_float");
      const m = /[?&]render=(cpu|gpu-float|gpu-half)\b/.exec(location.search);
      this.path = m ? m[1] : vt && fl ? "gpu-float" : vt && hf ? "gpu-half" : "cpu";
      console.info("[render] path " + this.path + " · " + (caps.isWebGL2 ? "WebGL2" : "WebGL1") +
                   " · vertex textures " + caps.maxVertexTextures + " · float textures " + fl +
                   " · half-float textures " + hf + (m ? " (forced by ?render=)" : ""));
      this.renderer.setPixelRatio(DPR);
      this.renderer.setClearColor(0x000000, 0);
      const self = this;
      function loop(now) {
        requestAnimationFrame(loop);
        const dt = self.last ? Math.min((now - self.last) / 1000, 0.1) : 0;
        self.last = now;
        // frame-time recorder, armed by the headless checks only (window.__ft = [])
        if (window.__ft && self.last0) window.__ft.push(now - self.last0);
        self.last0 = now;
        // a ticker that throws is logged once and dropped; the others and the draw go on
        self.tickers.forEach(function (f) {
          try { f(dt); } catch (e) { console.error("[tick] " + (e && e.stack ? e.stack : e)); self.tickers.delete(f); }
        });
        try { self.draw(); } catch (e) {
          if (!self.drawFailed) console.error("[draw] " + (e && e.stack ? e.stack : e));
          self.drawFailed = true;
        }
      }
      requestAnimationFrame(loop);
    },
    draw: function () {
      const r = this.renderer, w = document.documentElement.clientWidth, h = window.innerHeight;
      // nothing on screen: leave the canvas cleared and skip the frame entirely
      let any = false;
      this.views.forEach(function (v) {
        if (any || !v.ready || !v.el.isConnected || v.el.offsetParent === null) return;
        const b = v.el.getBoundingClientRect();
        if (b.width >= 2 && b.height >= 2 && b.bottom >= 0 && b.top <= h && b.right >= 0 && b.left <= w) any = true;
      });
      if (!any) {
        if (this.drewLast) { r.setScissorTest(false); r.setClearColor(0x000000, 0); r.clear(); this.drewLast = false; }
        return;
      }
      this.drewLast = true;
      const size = r.getSize(new THREE.Vector2());
      if (size.x !== w || size.y !== h) r.setSize(w, h, false);
      this.canvas.style.width = w + "px";
      this.canvas.style.height = h + "px";
      r.setScissorTest(false);
      r.setClearColor(0x000000, 0);
      r.clear();
      r.setScissorTest(true);
      this.views.forEach(function (v) {
        if (!v.ready || !v.el.isConnected || v.el.offsetParent === null) return;
        const b = v.el.getBoundingClientRect();
        if (b.width < 2 || b.height < 2 || b.bottom < 0 || b.top > h || b.right < 0 || b.left > w) return;
        if (v.fade !== undefined && v.fade < 0.02) return;            // faded out: nothing to draw
        const y = h - b.bottom;
        r.setViewport(b.left, y, b.width, b.height);
        r.setScissor(b.left, y, b.width, b.height);
        if (v.bg === null) r.setClearColor(0x000000, 0);                 // the page shows through
        else r.setClearColor(v.bg === undefined ? BG : v.bg, 1);
        r.clear();
        const aspect = b.width / b.height;
        if (v.fit && Math.abs(aspect - (v.fitAspect || 0)) > 0.01) v.fit(aspect);
        v.camera.aspect = aspect;
        v.camera.updateProjectionMatrix();
        if (v.key) v.key.position.copy(v.camera.position);
        if (v.beforeRender) v.beforeRender(b);
        r.render(v.scene, v.camera);
        if (v.fade !== undefined && v.fade < 0.999) {                  // fade toward the page colour
          FADE.mat.opacity = 1 - v.fade;
          const ac = r.autoClear;
          r.autoClear = false;
          r.render(FADE.scene, FADE.cam);
          r.autoClear = ac;
        }
      });
      r.setScissorTest(false);
    },
  };

  function makeScene() {
    const scene = new THREE.Scene();
    scene.add(new THREE.HemisphereLight(THEME.sky, THEME.hemiGround, THEME.hemi));   // fill
    const key = new THREE.DirectionalLight(0xffffff, THEME.key);           // key, follows the camera
    scene.add(key);
    return { scene: scene, key: key };
  }

  function disposeScene(scene) {
    const kill = [];
    scene.traverse(function (o) { if (o.geometry || o.material) kill.push(o); });
    kill.forEach(function (o) {
      if (o.geometry) o.geometry.dispose();
      if (o.material) o.material.dispose();
      if (o.parent) o.parent.remove(o);
    });
  }

  /* bounding box of rest + every frame of the given fields (all methods, so nothing clips) */
  function clipBox(clip, fields) {
    const N = clip.N, rest = clip.rest;
    const lo = new THREE.Vector3(Infinity, Infinity, Infinity);
    const hi = new THREE.Vector3(-Infinity, -Infinity, -Infinity);
    fields.forEach(function (F) {
      const T = F.length / (N * 3);
      const step = Math.max(1, Math.floor(T * N / 150000));
      for (let v = 0; v < T * N; v += step) {
        const i = (v % N) * 3, j = v * 3;
        const x = rest[i] + F[j], y = rest[i + 1] + F[j + 1], z = rest[i + 2] + F[j + 2];
        if (x < lo.x) lo.x = x; if (y < lo.y) lo.y = y; if (z < lo.z) lo.z = z;
        if (x > hi.x) hi.x = x; if (y > hi.y) hi.y = y; if (z > hi.z) hi.z = z;
      }
    });
    return { lo: lo, hi: hi };
  }

  function viewDir(entry) {
    const cam = entry.camera;
    const up = cam ? new THREE.Vector3().fromArray(cam.up)
                   : entry.up === "y" ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(0, 0, 1);
    const dir = cam ? new THREE.Vector3().fromArray(cam.dir)
                    : entry.up === "y" ? new THREE.Vector3(0.55, 0.35, 1.0)
                                       : new THREE.Vector3(1.0, -1.1, 0.45);
    return { up: up.normalize(), dir: dir.normalize() };
  }

  /* Place the camera on `dir` so every corner of the box projects inside FILL of the view. */
  function fitBox(camera, box, up, dir, aspect, fill) {
    fill = fill || FILL;
    const c = box.lo.clone().add(box.hi).multiplyScalar(0.5);
    const fwd = dir.clone().negate();
    const right = new THREE.Vector3().crossVectors(fwd, up).normalize();
    const upv = new THREE.Vector3().crossVectors(right, fwd).normalize();
    const tv = Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)) * fill;
    const th = tv * aspect;
    let dist = 0;
    for (let k = 0; k < 8; k++) {
      const p = new THREE.Vector3(k & 1 ? box.hi.x : box.lo.x, k & 2 ? box.hi.y : box.lo.y,
                                  k & 4 ? box.hi.z : box.lo.z).sub(c);
      const need = p.dot(dir) + Math.max(Math.abs(p.dot(right)) / th, Math.abs(p.dot(upv)) / tv);
      if (need > dist) dist = need;
    }
    camera.up.copy(up);
    camera.position.copy(c).addScaledVector(dir, dist);
    camera.near = dist / 100;
    camera.far = dist * 20;
    camera.lookAt(c);
    return { center: c, dist: dist };
  }

  /* soft contact shadow: a radial-gradient disc under the box, perpendicular to up */
  let SHADOW_TEX = null;
  function shadowTexture() {
    if (SHADOW_TEX) return SHADOW_TEX;
    const cv = document.createElement("canvas");
    cv.width = cv.height = 128;
    const g = cv.getContext("2d");
    const gr = g.createRadialGradient(64, 64, 0, 64, 64, 64);
    const sa = THEME.shadowAlpha;
    gr.addColorStop(0, "rgba(20,24,33," + sa + ")");
    gr.addColorStop(0.55, "rgba(20,24,33," + (sa * 0.35).toFixed(3) + ")");
    gr.addColorStop(1, "rgba(20,24,33,0)");
    g.fillStyle = gr;
    g.fillRect(0, 0, 128, 128);
    SHADOW_TEX = new THREE.CanvasTexture(cv);
    return SHADOW_TEX;
  }
  /* opts (fix_v22 A4): level -- the floor's height along `up` (default: just under the box); behind --
     the floor is drawn before the subject and writes no depth, so it can never cover any part of it */
  function floorAt(c, up, hUp, opts) {
    return opts && opts.level !== undefined ? c.clone().addScaledVector(up, opts.level - c.dot(up)) : c.clone().addScaledVector(up, -hUp * 1.004);
  }
  function behind(mat) {                                   // opaque pass (drawn first by renderOrder), still alpha-blended
    mat.transparent = false; mat.depthWrite = false;
    mat.blending = THREE.CustomBlending; mat.blendEquation = THREE.AddEquation;
    mat.blendSrc = THREE.SrcAlphaFactor; mat.blendDst = THREE.OneMinusSrcAlphaFactor;
    mat.blendSrcAlpha = THREE.OneFactor; mat.blendDstAlpha = THREE.OneMinusSrcAlphaFactor;   // as NormalBlending (the canvas is transparent)
    mat.blendEquationAlpha = THREE.AddEquation;
    return mat;
  }
  function addShadow(scene, box, up, opts) {
    const c = box.lo.clone().add(box.hi).multiplyScalar(0.5);
    const half = box.hi.clone().sub(box.lo).multiplyScalar(0.5);
    const hUp = Math.abs(half.x * up.x) + Math.abs(half.y * up.y) + Math.abs(half.z * up.z);
    const span = half.length() * 1.3;
    const mat = new THREE.MeshBasicMaterial({ map: shadowTexture(), transparent: true, depthWrite: false });
    if (opts && opts.behind) behind(mat);
    const m = new THREE.Mesh(new THREE.PlaneGeometry(span, span * 0.55), mat);
    m.position.copy(floorAt(c, up, hUp, opts));
    m.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), up);
    m.renderOrder = opts && opts.behind ? -10 : -1;
    m.userData.floor = true;
    scene.add(m);
    const g = opts && opts.grid === false ? null : floorGrid(scene, box, up, opts);
    return opts && opts.behind ? [m, g].filter(Boolean) : m;
  }

  /* a very faint perspective floor grid under the model, on the same floor plane as its contact
     shadow, fading out with distance: motion and translation read against it (styling only) */
  function floorGrid(scene, box, up, opts) {
    const c = box.lo.clone().add(box.hi).multiplyScalar(0.5);
    const half = box.hi.clone().sub(box.lo).multiplyScalar(0.5);
    const hUp = Math.abs(half.x * up.x) + Math.abs(half.y * up.y) + Math.abs(half.z * up.z);
    const diag = half.length() * 2, R = diag * 1.6, cell = diag / 9;
    const mat = new THREE.ShaderMaterial({
      uniforms: { uCol: { value: new THREE.Vector3().fromArray(THEME.gridRgb) }, uA: { value: THEME.gridAlpha },
                  uCell: { value: cell }, uR: { value: R } },
      vertexShader: "varying vec2 vP; void main(){ vP = position.xy; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }",
      fragmentShader: ["uniform vec3 uCol; uniform float uA; uniform float uCell; uniform float uR; varying vec2 vP;",
        "void main(){ vec2 q = vP / uCell; vec2 g = abs(fract(q - 0.5) - 0.5) / max(fwidth(q), vec2(1e-5));",
        "  float line = 1.0 - min(min(g.x, g.y), 1.0);",
        "  float fade = 1.0 - smoothstep(0.25 * uR, uR, length(vP));",
        "  gl_FragColor = vec4(uCol, uA * line * fade); }"].join("\n"),
      transparent: true, depthWrite: false, side: THREE.DoubleSide });
    mat.extensions.derivatives = true;
    if (opts && opts.behind) behind(mat);
    const g = new THREE.Mesh(new THREE.PlaneGeometry(2 * R, 2 * R), mat);
    g.position.copy(floorAt(c, up, hUp, opts));
    g.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), up);
    g.renderOrder = opts && opts.behind ? -11 : -1.5;
    g.userData.floor = true;
    scene.add(g);
    return g;
  }

  /* The Explore stage: a floor at the clip's lowest point along `up` -- a disc in the page
     colour that dims the mirrored body under it toward its rim (a faint reflection) -- and the
     reflection matrix across that plane. */
  function stageFloor(scene, box, up) {
    const c = box.lo.clone().add(box.hi).multiplyScalar(0.5);
    const half = box.hi.clone().sub(box.lo).multiplyScalar(0.5);
    const hUp = Math.abs(half.x * up.x) + Math.abs(half.y * up.y) + Math.abs(half.z * up.z);
    const P0 = c.clone().addScaledVector(up, -hUp * 1.004);
    const R = half.length() * 2.2;
    const disc = new THREE.Mesh(new THREE.CircleGeometry(R, 64), new THREE.ShaderMaterial({
      uniforms: { uCol: { value: new THREE.Color(THEME.stage3d !== null ? THEME.stage3d : THEME.page) } },
      vertexShader: "varying vec2 vP; void main(){ vP = position.xy; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }",
      fragmentShader: "uniform vec3 uCol; varying vec2 vP; void main(){ float r = length(vP) / " + R.toFixed(6) + ";" +
        " float a = mix(0.62, 1.0, smoothstep(0.08, 0.55, r)) * (1.0 - smoothstep(0.8, 1.0, r)); gl_FragColor = vec4(uCol, a); }",
      transparent: true, depthWrite: false, side: THREE.DoubleSide }));
    disc.position.copy(P0);
    disc.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), up);
    disc.renderOrder = -2;
    scene.add(disc);
    const n = up.clone().normalize();
    const H = new THREE.Matrix4().set(
      1 - 2 * n.x * n.x, -2 * n.x * n.y, -2 * n.x * n.z, 0,
      -2 * n.y * n.x, 1 - 2 * n.y * n.y, -2 * n.y * n.z, 0,
      -2 * n.z * n.x, -2 * n.z * n.y, 1 - 2 * n.z * n.z, 0,
      0, 0, 0, 1);
    return new THREE.Matrix4().makeTranslation(P0.x, P0.y, P0.z).multiply(H)
      .multiply(new THREE.Matrix4().makeTranslation(-P0.x, -P0.y, -P0.z));
  }
  const MIRROR_OPACITY = 0.16;
  function mirrorOf(obj, M) {
    const mat = obj.material.clone();
    mat.transparent = true; mat.opacity = (mat.opacity || 1) * MIRROR_OPACITY; mat.depthWrite = false;
    if ("side" in mat) mat.side = THREE.DoubleSide;
    const m = obj.isPoints ? new THREE.Points(obj.geometry, mat) : obj.isLineSegments ? new THREE.LineSegments(obj.geometry, mat)
                           : new THREE.Mesh(obj.geometry, mat);
    m.matrixAutoUpdate = false;
    m.matrix.copy(M);
    m.renderOrder = -3;
    m.frustumCulled = false;
    return m;
  }

  /* round, screen-space observed markers (a red disc with a thin white rim) */
  function markerMaterial(px) {
    return new THREE.ShaderMaterial({
      uniforms: { size: { value: px * DPR } },
      vertexShader: "uniform float size; void main(){ gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); gl_PointSize = size; }",
      fragmentShader: "void main(){ vec2 p = gl_PointCoord - 0.5; float r = length(p); if (r > 0.5) discard; vec3 c = r > 0.36 ? vec3(1.0) : vec3(" + THEME.obsRgb.map(function (x) { return x.toFixed(4); }).join(",") + "); gl_FragColor = vec4(c, 1.0); }",
      depthTest: true,
    });
  }
  function markerPx(n) { return n <= 20 ? 6 : n <= 100 ? 5 : n <= 500 ? 4 : 3; }

  /* Surface / edge set / point set of one view, plus its observed markers. */
  function Body(clip, scene, opts) {
    opts = opts || {};
    const N = clip.N;
    this.clip = clip;
    this.pos = new Float32Array(N * 3);
    this.col = new Float32Array(N * 3);
    const g = new THREE.BufferGeometry();
    this.posAttr = new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage);
    this.colAttr = new THREE.BufferAttribute(this.col, 3).setUsage(THREE.DynamicDrawUsage);
    g.setAttribute("position", this.posAttr);
    g.setAttribute("color", this.colAttr);
    this.faces = clip.meta.topology === "faces";
    this.objects = [];
    this.app = appearanceOf(clip);
    if (this.faces && this.app.uv) g.setAttribute("uv", new THREE.BufferAttribute(this.app.uv, 2));
    if (this.faces) {
      g.setIndex(new THREE.BufferAttribute(clip.topo, 1));
      this.mat = new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide,
        transparent: !!opts.opacity, opacity: opts.opacity || 1, depthWrite: !opts.opacity,
        // a translucent ghost sits BEHIND coincident geometry, so where it matches the solid
        // surface it does not z-fight; it shows only where it differs
        polygonOffset: true, polygonOffsetFactor: opts.opacity ? 8 : 1, polygonOffsetUnits: opts.opacity ? 8 : 1 });
      this.objects.push(new THREE.Mesh(g, this.mat));
    } else {
      if (clip.topo) {
        g.setIndex(new THREE.BufferAttribute(clip.topo, 1));
        // the edges are one constant grey, thin; the points carry the colour (grey or heat)
        this.objects.push(new THREE.LineSegments(g, new THREE.LineBasicMaterial({
          color: EDGE_HEX, transparent: true, opacity: opts.opacity ? opts.opacity * 0.7 : 0.7 })));
      }
      const gp = new THREE.BufferGeometry();
      gp.setAttribute("position", this.posAttr);
      gp.setAttribute("color", this.colAttr);
      this.objects.push(new THREE.Points(gp, new THREE.PointsMaterial({
        vertexColors: true, size: (opts.pointPx || 2.6) * DPR, sizeAttenuation: false,
        transparent: !!opts.opacity, opacity: opts.opacity || 1 })));
    }
    this.objects.forEach(function (o) { scene.add(o); });
    this.geom = g;
    this.obsGeom = new THREE.BufferGeometry();
    this.obsMat = markerMaterial(5);
    this.obsPts = new THREE.Points(this.obsGeom, this.obsMat);
    this.obsPts.renderOrder = 2;
    this.obsPts.visible = false;
    this.obs = null;
    if (!opts.noObs) scene.add(this.obsPts);
    // Franka: its URDF visual meshes stand in for the points (the heatmap brings the points back)
    const ex = clip.extra || {};
    if (ex.link && ex.link0pose && !opts.opacity && !opts.noRobot) {
      const self = this;
      panda().then(function (data) {
        const pose0 = new Float32Array(ex.link0pose.buffer, ex.link0pose.byteOffset, ex.link0pose.length);
        self.robot = new Robot(scene, data, pose0, ex.link, N);
        if (self.mirrorM) self.robot.enableMirror(scene, self.mirrorM);
        self.applyLook();
        self.robot.pose(clip.rest, self.pos);
      }).catch(function (e) { console.error("[robot] " + (e && e.message ? e.message : e)); });
    }
  }
  /* a faint reflection across the stage floor (Explore) */
  Body.prototype.enableMirror = function (scene, M) {
    this.mirrorM = M;
    this.mirrors = this.objects.map(function (o) { const m = mirrorOf(o, M); scene.add(m); return m; });
    if (this.robot) this.robot.enableMirror(scene, M);
    this.applyLook();
  };
  /* appearance vs heatmap: the robot meshes and the fabric show only without the heatmap */
  Body.prototype.applyLook = function () {
    const heat = !!this.heatShown, on = this.shown !== false;
    if (this.robot) {
      this.robot.visible(!heat && on);
      this.objects.forEach(function (o) { o.visible = heat && on; });
    }
    if (this.mirrors) {
      const objs = this.objects;
      this.mirrors.forEach(function (m, i) { m.visible = objs[i].visible; m.material.map = objs[i].material.map || null; });
    }
    if (this.mat && this.app.uv) {
      const want = heat ? null : fabricTexture();
      if (this.mat.map !== want) { this.mat.map = want; this.mat.needsUpdate = true; }
    }
  };
  Body.prototype.setObs = function (obs, visible) {
    this.obs = obs;
    this.obsPos = new Float32Array(obs.length * 3);
    this.obsAttr = new THREE.BufferAttribute(this.obsPos, 3).setUsage(THREE.DynamicDrawUsage);
    this.obsGeom.setAttribute("position", this.obsAttr);
    this.obsMat.uniforms.size.value = markerPx(obs.length) * DPR;
    this.obsPts.visible = visible !== false;
  };
  Body.prototype.visible = function (on) {
    this.shown = on;
    this.objects.forEach(function (o) { o.visible = on; });
    if (this.robot) this.applyLook();
  };
  /* write rest + field[t] (optionally weighted per vertex); markers follow `obsField` if given */
  Body.prototype.pose = function (field, t, weight, obsField) {
    const N = this.clip.N, rest = this.clip.rest, o = t * N * 3, p = this.pos;
    if (weight) {
      for (let v = 0, i = 0; v < N; v++, i += 3) {
        const w = weight[v];
        p[i] = rest[i] + w * field[o + i];
        p[i + 1] = rest[i + 1] + w * field[o + i + 1];
        p[i + 2] = rest[i + 2] + w * field[o + i + 2];
      }
    } else {
      for (let i = 0; i < N * 3; i++) p[i] = rest[i] + field[o + i];
    }
    this.posAttr.needsUpdate = true;
    if (this.faces) this.geom.computeVertexNormals();
    if (this.obs) {
      const src = obsField || field;
      for (let k = 0; k < this.obs.length; k++) {
        const v = this.obs[k] * 3;
        for (let a = 0; a < 3; a++) this.obsPos[k * 3 + a] = rest[v + a] + src[o + v + a];
      }
      this.obsAttr.needsUpdate = true;
      this.obsGeom.computeBoundingSphere();
    }
    this.geom.computeBoundingSphere();
    if (this.robot) this.robot.pose(this.clip.rest, this.pos);
  };
  /* colours: err [T*N] at frame t over vmax, or neutral grey when err is null / vmax 0 */
  Body.prototype.paint = function (err, t, vmax, rgb) {
    const N = this.clip.N, c = this.col;
    if (err && vmax > 0) {
      const eo = t * N;
      for (let v = 0; v < N; v++) heat(err[eo + v] / vmax, c, v * 3);
      this.heatShown = true;
    } else if (rgb) {
      for (let v = 0; v < N; v++) { c[v * 3] = rgb[0]; c[v * 3 + 1] = rgb[1]; c[v * 3 + 2] = rgb[2]; }
      this.heatShown = false;
    } else {
      c.set(this.app.base);                            // the family's appearance
      this.heatShown = false;
    }
    this.colAttr.needsUpdate = true;
    this.applyLook();
  };

  /* Instanced arrows (cylinder shaft + cone head), thick enough to read at any view size. */
  function Arrows(scene, max, color) {
    this.max = max;
    this.shaft = new THREE.InstancedMesh(new THREE.CylinderGeometry(1, 1, 1, 8, 1, false),
      new THREE.MeshLambertMaterial({ color: color }), max);
    this.head = new THREE.InstancedMesh(new THREE.ConeGeometry(1, 1, 10),
      new THREE.MeshLambertMaterial({ color: color }), max);
    this.shaft.count = this.head.count = 0;
    this.baseHex = color;
    this.head.setColorAt(0, new THREE.Color(color));      // allocates instanceColor
    for (let i = 1; i < max; i++) this.head.setColorAt(i, new THREE.Color(color));
    this.head.material.color.setHex(0xffffff);             // instance colour carries the tint
    this.shaft.frustumCulled = this.head.frustumCulled = false;
    scene.add(this.shaft);
    scene.add(this.head);
  }
  /* starts, vecs: flat [n*3]; radius in world units */
  Arrows.prototype.set = function (starts, vecs, radius, clipped, tipHex) {
    const n = Math.min(this.max, starts.length / 3);
    const m = new THREE.Matrix4(), q = new THREE.Quaternion(), s = new THREE.Vector3();
    const Y = new THREE.Vector3(0, 1, 0), d = new THREE.Vector3(), p = new THREE.Vector3();
    let k = 0;
    for (let i = 0; i < n; i++) {
      d.set(vecs[i * 3], vecs[i * 3 + 1], vecs[i * 3 + 2]);
      const L = d.length();
      if (!(L > radius * 0.6)) continue;
      d.divideScalar(L);
      q.setFromUnitVectors(Y, d);
      const hl = 0.25 * L, sl = L - hl;                   // cone head = a quarter of the arrow
      p.set(starts[i * 3], starts[i * 3 + 1], starts[i * 3 + 2]).addScaledVector(d, sl / 2);
      m.compose(p, q, s.set(radius, Math.max(sl, 1e-9), radius));
      this.shaft.setMatrixAt(k, m);
      p.set(starts[i * 3], starts[i * 3 + 1], starts[i * 3 + 2]).addScaledVector(d, sl + hl / 2);
      const hr = Math.min(radius * 2.2, 0.5 * hl);
      m.compose(p, q, s.set(hr, hl, hr));
      this.head.setMatrixAt(k, m);
      if (clipped) this.head.setColorAt(k, new THREE.Color(clipped[i] ? (tipHex || 0xf2c3a4) : this.baseHex));
      k++;
    }
    this.shaft.count = this.head.count = k;
    this.shaft.instanceMatrix.needsUpdate = this.head.instanceMatrix.needsUpdate = true;
    if (clipped && this.head.instanceColor) this.head.instanceColor.needsUpdate = true;
  };
  Arrows.prototype.setColor = function (hex) {
    this.baseHex = hex;
    this.shaft.material.color.setHex(hex);
    for (let i = 0; i < this.max; i++) this.head.setColorAt(i, new THREE.Color(hex));
    this.head.instanceColor.needsUpdate = true;
  };
  Arrows.prototype.visible = function (on) { this.shaft.visible = this.head.visible = on; };

  /* Touch: a viewer rotates only after a tap activates it, so a swipe over it scrolls. */
  function touchGuard(wrap, controls) {
    if (!COARSE) return;
    controls.enabled = false;
    wrap.classList.add("tap-to-rotate");
    const reset = function () { wrap.style.touchAction = "pan-y"; };
    reset();
    let x0 = 0, y0 = 0, t0 = 0;
    wrap.addEventListener("pointerdown", function (e) { x0 = e.clientX; y0 = e.clientY; t0 = Date.now(); });
    wrap.addEventListener("pointerup", function (e) {
      if (controls.enabled) return;
      if (Math.hypot(e.clientX - x0, e.clientY - y0) < 8 && Date.now() - t0 < 400) {
        controls.enabled = true;
        wrap.style.touchAction = "none";
        wrap.classList.add("active");
      }
    });
    document.addEventListener("pointerdown", function (e) {
      if (controls.enabled && !wrap.contains(e.target)) {
        controls.enabled = false;
        reset();
        wrap.classList.remove("active");
      }
    });
    // OrbitControls writes touch-action on its own element when constructed; keep ours
    setTimeout(reset, 0);
  }

  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
  }
  function segButtons(parent, items, onPick) {
    const seg = el("div", "seg");
    const btns = items.map(function (it) {
      const b = el("button", null, it.label);
      b.type = "button";
      b.setAttribute("aria-pressed", "false");
      b.addEventListener("click", function () { onPick(it.value); });
      seg.appendChild(b);
      return { b: b, v: it.value };
    });
    parent.appendChild(seg);
    return {
      el: seg,
      set: function (v) { btns.forEach(function (x) { x.b.setAttribute("aria-pressed", String(x.v === v)); }); },
    };
  }
  function toggle(parent, label, on, cb) {
    const l = el("label", "toggle");
    const i = el("input");
    i.type = "checkbox";
    i.checked = on;
    i.addEventListener("change", function () { cb(i.checked); });
    l.appendChild(i);
    l.appendChild(document.createTextNode(label));
    parent.appendChild(l);
    return i;
  }
  const fmtInt = function (n) { return n.toLocaleString("en-US"); };
  function densLabel(k) { return k.endsWith("v") ? k.slice(0, -1) + " vertices" : k.replace("p", ".") + "%"; }
  function densFrac(k, N) { return k.endsWith("v") ? parseInt(k, 10) / N : parseFloat(k.replace("p", ".")) / 100; }
  const KIND_LABEL = { seq: "Sequence", pair: "Frame pair", chain: "Figure 1 chain" };
  const SOURCE = { dt4d: "DT4D", amass: "AMASS", cape: "CAPE", franka: "Franka", flag: "Flag", genbot: "GenBot1K" };
  const BASE_FPS = { seq: 12.5, chain: 10, pair: 1 };

  /* p98 of the pooled ours + harmonic error over every frame and loaded density */
  function vmaxOf(clip) {
    const all = [];
    Object.keys(clip.dens).forEach(function (k) { all.push(clip.dens[k].oursErr, clip.dens[k].harmonicErr); });
    const total = all.reduce(function (s, a) { return s + a.length; }, 0);
    const step = Math.max(1, Math.floor(total / 300000));
    const s = [];
    all.forEach(function (a) { for (let i = 0; i < a.length; i += step) s.push(a[i]); });
    s.sort(function (a, b) { return a - b; });
    return s[Math.min(s.length - 1, Math.floor(0.98 * s.length))] || 1e-9;
  }

  /* ------------------------------------------------------------------ comparison card */
  const VIEW_NAMES = ["Ground truth", "Harmonic extension", "Ours"];

  function CompareCard(root, opts) {
    this.opts = opts;
    this.clip = null;
    this.entry = null;
    this.key = null;
    this.frame = 0;
    this.acc = 0;
    this.playing = false;
    this.speed = 1;
    this.heatOn = !!opts.heat;
    this.obsOn = true;
    this.token = 0;
    this.visible = false;
    this.pending = null;
    const self = this;
    const card = el("div", "card compare");
    this.card = card;

    if (opts.clipButtons) {
      const r = el("div", "row");
      r.appendChild(el("span", "seg-label", "Clip"));
      this.clipSeg = segButtons(r, [], function () {});
      this.clipRow = r;
      card.appendChild(r);
    }
    const dr = el("div", opts.densityMode === "slider" ? "slider-row" : "row");
    dr.appendChild(el("span", "seg-label", "Observed"));
    this.densRow = dr;
    card.appendChild(dr);

    // one viewport at a time below 768 px (the tabs are hidden by CSS above that)
    const mt = el("div", "row view-tabs");
    this.viewSeg = segButtons(mt, [{ label: "GT", value: 0 }, { label: "Harmonic", value: 1 },
                                   { label: "Ours", value: 2 }],
                              function (i) { self.setMobileView(i); });
    card.appendChild(mt);

    const views = el("div", "views");
    this.viewsEl = views;
    this.camera = new THREE.PerspectiveCamera(30, 0.8, 0.01, 100);
    this.controls = new THREE.OrbitControls(this.camera, views);
    this.controls.enableDamping = false;
    touchGuard(views, this.controls);
    // a plain wheel scrolls the page; Ctrl/Cmd + wheel zooms (runs before OrbitControls' listener)
    views.addEventListener("wheel", function (e) {
      if (!e.ctrlKey && !e.metaKey) e.stopImmediatePropagation();
    }, { capture: true });
    this.views = VIEW_NAMES.map(function (name, i) {
      const cell = el("div", "vcell");
      cell.dataset.view = i;
      cell.appendChild(el("div", "vlabel", name));
      const v = el("div", "view");
      cell.appendChild(v);
      views.appendChild(cell);
      const s = makeScene();
      const view = { el: v, scene: s.scene, key: s.key, camera: self.camera, ready: false, body: null, bg: THEME.stage3d };
      view.fit = function (aspect) { self.fit(aspect); };
      Stage.views.add(view);
      return view;
    });
    card.appendChild(views);
    this.setMobileView(2);
    // callout (a billboarded label with a leader line) on the ground-truth view: observed points
    const co = el("div", "callout");
    co.innerHTML = '<svg aria-hidden="true"><line /></svg><span>observed points</span>';
    this.views[0].el.appendChild(co);
    this.callout = co;
    this.views[0].beforeRender = function (b) { self.placeCallout(b); };
    // the region where harmonic extension's error is largest in this clip: labelled on the
    // harmonic view, a plain ring at the same vertex on ours
    const ce = el("div", "callout err");
    ce.innerHTML = '<svg aria-hidden="true"><line /></svg><div class="anchor-dot"></div><span>largest harmonic error</span>';
    this.views[1].el.appendChild(ce);
    const cr = el("div", "callout ring");
    cr.innerHTML = '<svg aria-hidden="true"><line /></svg><div class="ring-dot"></div><span></span>';
    this.views[2].el.appendChild(cr);
    this.errCallouts = [ce, cr];
    this.views[1].beforeRender = function (b) { self.placeErr(0, b); };
    this.views[2].beforeRender = function (b) { self.placeErr(1, b); };

    if (opts.timeline) {
      const tl = el("div", "timeline");
      this.playBtn = el("button", "btn", "Play");
      this.playBtn.type = "button";
      this.playBtn.addEventListener("click", function () { self.setPlaying(!self.playing); });
      tl.appendChild(this.playBtn);
      this.scrub = el("input");
      this.scrub.type = "range";
      this.scrub.min = 0;
      this.scrub.value = 0;
      this.scrub.setAttribute("aria-label", "Frame");
      this.scrub.addEventListener("input", function () { self.setPlaying(false); self.setFrame(+self.scrub.value); });
      tl.appendChild(this.scrub);
      this.readout = el("span", "frame-readout");
      tl.appendChild(this.readout);
      tl.appendChild(el("span", "seg-label", "Speed"));
      this.speedSeg = segButtons(tl, [0.25, 0.5, 1, 2].map(function (s) { return { label: s + "×", value: s }; }),
                                 function (s) { self.speed = s; self.speedSeg.set(s); });
      this.speedSeg.set(1);
      card.appendChild(tl);
    }

    const tg = el("div", "row");
    tg.style.marginTop = "12px";
    this.heatBox = toggle(tg, "Error heatmap", this.heatOn, function (on) { self.heatOn = on; self.legend.hidden = !on; self.redraw(); });
    this.obsBox = toggle(tg, "Show observed", true, function (on) { self.setObsVisible(on); });
    card.appendChild(tg);
    this.legend = el("div", "legend");
    this.legend.hidden = !this.heatOn;
    card.appendChild(this.legend);
    this.info = el("div", "info");
    card.appendChild(this.info);
    root.appendChild(card);

    Stage.tickers.add(function (dt) { self.tick(dt); });
    new IntersectionObserver(function (es) {
      self.visible = es[0].isIntersecting;
      if (self.visible && self.pending) { const p = self.pending; self.pending = null; self.load(p.entry, p.key); }
    }, { rootMargin: "300px 0px" }).observe(card);
  }

  CompareCard.prototype.setMobileView = function (i) {
    this.viewSeg.set(i);
    this.viewsEl.dataset.mobileView = i;
  };

  CompareCard.prototype.setEntries = function (entries) {
    const self = this;
    this.entries = entries;
    if (this.clipSeg) {
      this.clipRow.removeChild(this.clipSeg.el);
      this.clipSeg = segButtons(this.clipRow, entries.map(function (e) {
        const mixed = entries.some(function (x) { return x.family !== e.family; });
        return { label: KIND_LABEL[e.kind] + (mixed ? " · " + SOURCE[e.family] : ""), value: e.folder }; }),
        function (f) { self.request(entries.find(function (e) { return e.folder === f; })); });
    }
    this.request(entries[0]);
  };

  CompareCard.prototype.request = function (entry, key) {
    this.release();
    this.entry = entry;
    this.key = key || (entry.keys.indexOf("2") >= 0 ? "2" : entry.keys[0]);
    if (this.clipSeg) this.clipSeg.set(entry.folder);
    this.buildDensity(entry);
    this.views.forEach(function (v) { v.el.classList.add("loading"); });
    this.info.textContent = "";
    if (this.visible) this.load(entry, this.key);
    else this.pending = { entry: entry, key: this.key };
  };

  CompareCard.prototype.buildDensity = function (entry) {
    const self = this, dr = this.densRow;
    while (dr.children.length > 1) dr.removeChild(dr.lastChild);
    if (this.opts.densityMode === "slider") {
      const s = el("input");
      s.type = "range"; s.min = 0; s.max = entry.keys.length - 1; s.step = 1;
      s.value = Math.max(0, entry.keys.indexOf(this.key));
      s.setAttribute("aria-label", "Observed density");
      const wrap = el("div");
      wrap.style.flex = "1 1 220px";
      wrap.appendChild(s);
      s.style.width = "100%";
      const ticks = el("div", "ticks");
      entry.keys.forEach(function (k) { ticks.appendChild(el("span", null, densLabel(k))); });
      wrap.appendChild(ticks);
      dr.appendChild(wrap);
      s.addEventListener("input", function () { self.setKey(entry.keys[+s.value]); });
      this.densSeg = { set: function (k) { s.value = entry.keys.indexOf(k); } };
    } else {
      this.densSeg = segButtons(dr, entry.keys.map(function (k) { return { label: densLabel(k), value: k }; }),
                                function (k) { self.setKey(k); });
    }
    this.densSeg.set(this.key);
  };

  CompareCard.prototype.fit = function (aspect) {
    if (!this.clip) return;
    const v = viewDir(this.entry);
    const f = fitBox(this.camera, this.box, v.up, v.dir, aspect);
    this.controls.target.copy(f.center);
    this.controls.update();
    this.views.forEach(function (w) { w.fitAspect = aspect; });
  };

  CompareCard.prototype.load = async function (entry, key) {
    const token = ++this.token;
    let clip;
    try {
      clip = await ClipData.loadClip(entry, entry.keys, extrasFor(entry));
    } catch (e) {
      if (token === this.token) this.info.textContent = "Could not load this clip.";
      return;
    }
    if (token !== this.token) return;
    this.clip = clip;
    this.vmax = vmaxOf(clip);
    const fields = [clip.gt];
    Object.keys(clip.dens).forEach(function (k) { fields.push(clip.dens[k].ours, clip.dens[k].harmonic); });
    this.box = clipBox(clip, fields);
    const vd = viewDir(entry);
    const self = this;
    this.views.forEach(function (v) {
      v.body = new Body(clip, v.scene);
      addShadow(v.scene, self.box, vd.up);
      v.body.enableMirror(v.scene, stageFloor(v.scene, self.box, vd.up));
      v.fitAspect = 0;
      v.ready = true;
      v.el.classList.remove("loading");
    });
    this.frame = this.opts.frame !== null && this.opts.frame !== undefined ? Math.min(this.opts.frame, clip.T - 1) : 0;
    if (this.scrub) { this.scrub.max = clip.T - 1; this.scrub.value = this.frame; }
    this.setKey(key);
    this.setPlaying(this.opts.timeline && clip.T > 1);
    this.legend.innerHTML = "";
    this.legend.appendChild(document.createTextNode("low"));
    const bar = el("span", "bar");
    bar.style.background = HEAT_CSS;
    this.legend.appendChild(bar);
    this.legend.appendChild(document.createTextNode("high · per-vertex |prediction − ground truth| (harmonic and ours share this scale)"));
  };

  CompareCard.prototype.setObsVisible = function (on) {
    this.obsOn = on;
    if (this.obsBox) this.obsBox.checked = on;
    this.views.forEach(function (v) { if (v.body) v.body.obsPts.visible = on; });
  };

  CompareCard.prototype.setKey = function (k) {
    this.key = k;
    if (this.densSeg) this.densSeg.set(k);
    if (!this.clip) return;
    const d = this.clip.dens[k], self = this, e = this.entry;
    // above 5% the markers cover the surface: hidden by default, one toggle away
    const on = densFrac(k, e.N) <= 0.05;
    this.views.forEach(function (v) { v.body.setObs(d.obs, on); });
    this.setObsVisible(on);
    this.findErrVertex();
    // the callout points at the highest observed vertex (along the clip's up axis)
    const up = viewDir(e).up, R = this.clip.rest;
    let best = -Infinity;
    this.calloutV = d.obs[0];
    for (let k = 0; k < d.obs.length; k++) {
      const v = d.obs[k], hgt = R[v * 3] * up.x + R[v * 3 + 1] * up.y + R[v * 3 + 2] * up.z;
      if (hgt > best) { best = hgt; this.calloutV = v; }
    }
    this.info.textContent = [SOURCE[e.family], KIND_LABEL[e.kind],
      e.topology === "edges" ? "points + graph edges" : "mesh",
      e.T + " frames", d.obs.length + " observed (" + densLabel(k) + ")", "units: " + e.units].join(" · ");
    this.redraw();
  };

  CompareCard.prototype.setFrame = function (f) { this.frame = f; this.redraw(); };

  /* the vertex whose harmonic error, averaged over the clip's frames and over its one-ring, is largest */
  CompareCard.prototype.findErrVertex = function () {
    const c = this.clip, d = c.dens[this.key], N = c.N, T = c.T, err = d.harmonicErr;
    if (!err) { this.errV = undefined; return; }
    const e = new Float64Array(N), t0 = T > 1 ? 1 : 0;
    for (let t = t0; t < T; t++) for (let v = 0; v < N; v++) e[v] += err[t * N + v];
    const sum = Float64Array.from(e), cnt = new Float64Array(N).fill(1), topo = c.topo;
    if (topo) {
      const k = c.meta.topology === "faces" ? 3 : 2;
      for (let f = 0; f < topo.length; f += k) for (let i = 0; i < k; i++) for (let j = 0; j < k; j++) if (i !== j) {
        sum[topo[f + i]] += e[topo[f + j]]; cnt[topo[f + i]] += 1;
      }
    }
    let best = -1;
    for (let v = 0; v < N; v++) { const m = sum[v] / cnt[v]; if (m > best) { best = m; this.errV = v; } }
  };
  /* is vertex v of `body` hidden from the camera (facing away / behind the surface)? A ray from the
     camera to the vertex against what is drawn: the body's surface, or the robot's link meshes */
  const RAY = new THREE.Raycaster();
  CompareCard.prototype.occluded = function (body, v) {
    const P = new THREE.Vector3(body.pos[v * 3], body.pos[v * 3 + 1], body.pos[v * 3 + 2]);
    const eye = this.camera.position, d = P.clone().sub(eye), dist = d.length();
    const targets = body.robot && body.robot.shown ? body.robot.meshes : (body.faces ? [body.objects[0]] : []);
    if (!targets.length) return false;
    targets.forEach(function (m) { m.updateMatrixWorld(); });
    RAY.set(eye, d.normalize()); RAY.near = 0; RAY.far = dist;
    const hit = RAY.intersectObjects(targets, false)[0];
    const diag = this.box ? this.box.hi.clone().sub(this.box.lo).length() : 1;
    return !!hit && hit.distance < dist - 0.01 * diag;
  };
  CompareCard.prototype.placeErr = function (i, b) {
    const co = this.errCallouts[i], body = this.views[i + 1].body;
    if (!body || this.errV === undefined) { co.style.display = "none"; return; }
    const v = this.errV, q = new THREE.Vector3(body.pos[v * 3], body.pos[v * 3 + 1], body.pos[v * 3 + 2]).project(this.camera);
    if (q.z > 1) { co.style.display = "none"; return; }
    const x = (q.x + 1) / 2 * b.width, y = (1 - q.y) / 2 * b.height;
    co.style.display = "";
    // the anchor is drawn dimmed when the vertex faces away; the label always stays visible
    co.classList.toggle("hidden-anchor", this.occluded(body, v));
    const line = co.firstChild.firstChild;
    if (i === 1) {                                    // ours: a ring at the same vertex
      const dot = co.querySelector(".ring-dot");
      dot.style.left = x + "px"; dot.style.top = y + "px";
      line.setAttribute("x1", x); line.setAttribute("y1", y); line.setAttribute("x2", x); line.setAttribute("y2", y);
      return;
    }
    const lw = 150, lh = 22, right = x + 34 + lw < b.width - 6;
    const lx = right ? x + 34 : x - 34 - lw, ly = Math.min(b.height - lh - 6, Math.max(6, y + 26));
    const dot = co.querySelector(".anchor-dot");
    dot.style.left = x + "px"; dot.style.top = y + "px";
    const span = co.querySelector("span");
    span.style.left = lx + "px"; span.style.top = ly + "px";
    line.setAttribute("x1", x); line.setAttribute("y1", y);
    line.setAttribute("x2", right ? lx : lx + lw); line.setAttribute("y2", ly + lh / 2);
  };

  CompareCard.prototype.placeCallout = function (b) {
    const co = this.callout, body = this.views[0].body;
    if (!body || !this.obsOn || this.calloutV === undefined) { co.style.display = "none"; return; }
    const v = this.calloutV, q = new THREE.Vector3(body.pos[v * 3], body.pos[v * 3 + 1], body.pos[v * 3 + 2]).project(this.camera);
    if (q.z > 1) { co.style.display = "none"; return; }
    const x = (q.x + 1) / 2 * b.width, y = (1 - q.y) / 2 * b.height;
    const lw = 118, lh = 22, right = x + 40 + lw < b.width - 6;
    const lx = right ? x + 40 : x - 40 - lw, ly = Math.max(6, y - 46);
    co.style.display = "";
    const span = co.lastChild, line = co.firstChild.firstChild;
    span.style.left = lx + "px"; span.style.top = ly + "px";
    line.setAttribute("x1", x); line.setAttribute("y1", y);
    line.setAttribute("x2", right ? lx : lx + lw); line.setAttribute("y2", ly + lh / 2);
  };

  CompareCard.prototype.redraw = function () {
    if (!this.clip) return;
    const c = this.clip, d = c.dens[this.key], t = this.frame, vm = this.heatOn ? this.vmax : 0;
    const B = this.views.map(function (v) { return v.body; });
    B[0].pose(c.gt, t); B[0].paint(null, t, 0);                     // ground truth: always neutral
    B[1].pose(d.harmonic, t, null, c.gt); B[1].paint(d.harmonicErr, t, vm);
    B[2].pose(d.ours, t, null, c.gt); B[2].paint(d.oursErr, t, vm);
    if (this.scrub) this.scrub.value = t;
    if (this.readout) this.readout.textContent = "frame " + (t + 1) + " / " + c.T;
  };

  CompareCard.prototype.setPlaying = function (p) {
    this.playing = !!p;
    if (this.playBtn) this.playBtn.textContent = this.playing ? "Pause" : "Play";
  };

  CompareCard.prototype.tick = function (dt) {
    if (!this.playing || !this.clip || !this.visible || this.clip.T < 2) return;
    this.acc += dt * BASE_FPS[this.entry.kind] * this.speed;
    if (this.acc >= 1) {
      const n = Math.floor(this.acc);
      this.acc -= n;
      this.setFrame((this.frame + n) % this.clip.T);
    }
  };

  CompareCard.prototype.release = function () {
    this.token++;
    this.setPlaying(false);
    this.views.forEach(function (v) {
      v.ready = false;
      if (v.body) { disposeScene(v.scene); v.body = null; }
    });
    this.clip = null;
  };

  window.Viewer = {
    Stage: Stage, CompareCard: CompareCard, Body: Body, Arrows: Arrows, makeScene: makeScene,
    disposeScene: disposeScene, clipBox: clipBox, viewDir: viewDir, fitBox: fitBox,
    addShadow: addShadow, markerPx: markerPx, heat: heat, HEAT_CSS: HEAT_CSS, el: el,
    segButtons: segButtons, toggle: toggle, densLabel: densLabel, SOURCE: SOURCE, GREY: GREY,
    vmaxOf: vmaxOf, DPR: DPR, PHONE: PHONE, THEME: THEME, appearanceOf: appearanceOf, fabricTexture: fabricTexture,
    extrasFor: extrasFor, panda: panda, stageFloor: stageFloor, touchGuard: touchGuard, markerPx: markerPx, Robot: Robot, fitRigid: fitRigid, FAMILY_RGB: FAMILY_RGB,
  };
})();
