/* Explore: the supplementary page's clips, five methods side by side -- ground truth, ours,
   harmonic, NSDP, DOMA -- as the videos lay them out: top row shape, bottom row per-vertex error, every
   view on one camera (orbiting any view moves all) and one playback clock, one error colour scale per clip
   across the bottom row (the video's own: p98 of ours + harmonic error); ground truth's bottom cell holds
   the colour bar (low / high), as the video's does. Every drawn position is a stored prediction of the shipped video (see each folder's
   meta.json "display"). Data per clip (assets/explore/<folder>/): mesh.bin, gt/ours/harmonic/nsdp/doma.bin
   (FIELD of position - rest), obs.bin, franka: obs_pos.bin (the observed points' own positions). */
(function () {
  "use strict";
  const V = window.Viewer, CD = window.ClipData, UV_BASE = "assets_explore_uv/";
  const METHODS = [["gt", "ground truth"], ["ours", "ours"], ["harmonic", "harmonic"], ["nsdp", "NSDP"], ["doma", "DOMA"]];
  const LABEL = {}; METHODS.forEach(function (m) { LABEL[m[0]] = m[1]; });
  const FPS = 12.5;                                 // the videos' rate: 12.5 shown steps per second

  const HALF = (function () {
    const t = new Float32Array(65536);
    for (let h = 0; h < 65536; h++) {
      const s = h & 0x8000 ? -1 : 1, e = (h >> 10) & 0x1f, f = h & 0x3ff;
      t[h] = e === 0 ? s * Math.pow(2, -14) * (f / 1024) : e === 31 ? (f ? NaN : s * Infinity) : s * Math.pow(2, e - 15) * (1 + f / 1024);
    }
    return t;
  })();
  function decodeField(buf, T, N) {               // FIELD: float32 translation [T,3] + float16 residual [T,N,3]
    const tr = new Float32Array(buf, 0, T * 3), r = new Uint16Array(buf, T * 12, T * N * 3), out = new Float32Array(T * N * 3);
    for (let t = 0; t < T; t++) {
      const a = tr[t * 3], b = tr[t * 3 + 1], c = tr[t * 3 + 2], o = t * N * 3;
      for (let i = 0; i < N * 3; i += 3) { out[o + i] = a + HALF[r[o + i]]; out[o + i + 1] = b + HALF[r[o + i + 1]]; out[o + i + 2] = c + HALF[r[o + i + 2]]; }
    }
    return out;
  }

  /* every clip file over http goes through fetchBuf: it fails if no bytes arrive for STALL_MS (the request is then
     aborted) or when the load it belongs to is superseded (its signal aborts). Nothing partial is ever kept: a
     buffer exists only once the whole body has arrived, and the server says no-store. */
  const HTTP = /^https?:$/.test(location.protocol), STAMP = window.__build ? "?v=" + window.__build : "";
  const STALL_MS = 15000;
  function fetchBuf(url, signal) {
    return new Promise(function (resolve, reject) {
      const ctl = new AbortController();
      let timer = 0, done = false;
      const fail = function (e) { if (done) return; done = true; clearTimeout(timer); ctl.abort(); reject(e); };
      const arm = function () { clearTimeout(timer); timer = setTimeout(function () { fail(new Error("stalled " + STALL_MS / 1000 + " s: " + url)); }, STALL_MS); };
      if (signal) {
        if (signal.aborted) { fail(new Error("superseded")); return; }
        signal.addEventListener("abort", function () { fail(new Error("superseded")); }, { once: true });
      }
      arm();
      fetch(url + STAMP, { signal: ctl.signal }).then(function (r) {
        if (!r.ok) throw new Error("HTTP " + r.status + ": " + url);
        arm();
        if (!r.body || !r.body.getReader) return r.arrayBuffer();
        const reader = r.body.getReader(), parts = [];
        let n = 0;
        const pump = function () {
          return reader.read().then(function (x) {
            if (x.done) {
              const out = new Uint8Array(n);
              let o = 0;
              parts.forEach(function (q) { out.set(q, o); o += q.length; });
              return out.buffer;
            }
            arm();                                      // progress: restart the stall timer
            parts.push(x.value); n += x.value.length;
            return pump();
          });
        };
        return pump();
      }).then(function (buf) { if (done) return; done = true; clearTimeout(timer); resolve(buf); }, fail);
    });
  }

  /* hover preload: one clip ahead at most, and never while a clip is still loading (it would compete with it for
     the browser's few connections). Resting the mouse on a thumbnail for HOVER_MS starts fetching that clip (mesh,
     observed set, ground truth and ours together, then the other three); leaving the thumbnail before clicking it
     aborts what has not arrived (what has arrived is kept until another thumbnail is preloaded); clicking adopts the
     preload as it stands (the loader requests whatever it lacks), and leaving after the click aborts nothing. */
  const HOVER_MS = 120;
  const NOPRE = function () { return { folder: null, ctl: null, bufs: {}, adopted: false }; };
  let pre = NOPRE();
  const FIRST = function (entry) { return ["mesh.bin", entry.family === "franka" ? "obs_pos.bin" : "obs.bin", "gt.bin", "ours.bin"]; };
  const REST = ["harmonic.bin", "nsdp.bin", "doma.bin"];
  function prefetch(entry) {
    if (!HTTP || !window.AbortController) return;
    if (pre.folder !== entry.folder) {
      if (pre.ctl && !pre.adopted) pre.ctl.abort();
      pre = NOPRE(); pre.folder = entry.folder;
    } else if (pre.adopted || (pre.ctl && !pre.ctl.signal.aborted)) return;
    const p = pre, ctl = new AbortController(), url = entry.base + entry.folder + "/";
    p.ctl = ctl;
    const one = function (n) {
      if (p.bufs[n]) return p.bufs[n];
      const q = fetchBuf(url + n, ctl.signal);
      p.bufs[n] = q;
      q.catch(function () { if (p.bufs[n] === q) delete p.bufs[n]; });   // aborted, stalled or failed: fetched again on demand
      return q;
    };
    CD.loadMeta(entry.folder, entry.base).catch(function () {});
    Promise.all(FIRST(entry).map(one)).then(function () { if (!ctl.signal.aborted && !p.adopted) REST.forEach(one); }, function () {});
  }
  function unhover(entry) {
    if (pre.folder === entry.folder && pre.ctl && !pre.adopted) pre.ctl.abort();
  }
  function adopt(entry) { if (pre.folder === entry.folder) pre.adopted = true; }
  function dropAdopted(entry) {                     // the adopted preload's clip is done with (loaded or superseded)
    if (pre.folder === entry.folder && pre.adopted) { if (pre.ctl) pre.ctl.abort(); pre = NOPRE(); }
  }
  function get(f, n, B, signal) {
    if (!HTTP || !window.AbortController) return CD.loadBin(f, n, B);
    if (pre.folder === f && pre.bufs[n]) return pre.bufs[n].catch(function () { return fetchBuf(B + f + "/" + n, signal); });
    return fetchBuf(B + f + "/" + n, signal);
  }

  /* one clip's load: meta, then mesh + observed set + ground truth + ours together, then the other three. Each
     method's field is fetched on its own: onField(m) when it is decoded, onFail(m) when it fails or stalls (m = "*"
     when the clip itself -- meta, mesh or observed set -- could not be read). field(m) fetches it again. */
  function Loader(entry, signal, onField, onFail, alive) {
    this.entry = entry; this.signal = signal; this.onField = onField; this.onFail = onFail; this.alive = alive;
    this.clip = null; this.fetched = {};
  }
  Loader.prototype.start = async function () {
    const entry = this.entry, B = entry.base, f = entry.folder, self = this;
    let meta, mesh, obs;
    try {
      meta = await CD.loadMeta(f, B);
      FIRST(entry).forEach(function (n) { const q = get(f, n, B, self.signal); q.catch(function () {}); self.fetched[n] = q; });
      mesh = await this.fetched["mesh.bin"];
      obs = await this.fetched[meta.obs_positions ? "obs_pos.bin" : "obs.bin"];
    } catch (e) {
      if (this.alive()) this.onFail("*", e);
      return;
    }
    if (!this.alive()) return;
    const N = meta.N, T = meta.T;
    const clip = this.clip = { entry: entry, meta: { topology: "faces", family: meta.family }, N: N, T: T,
                   rest: new Float32Array(mesh, 0, N * 3), topo: new Uint32Array(mesh, N * 12, meta.n_faces * 3), extra: {},
                   fields: {}, err: {}, vmax: meta.vmax };
    // cloth: the wall's fabric needs the flag's material coordinates (uv = its mesh_pos, as the wall's uv.bin).
    // fix_v22 preview: read from assets_explore_uv/ (for release, write uv.bin into the Explore flag folders).
    if (meta.family === "flag") {
      try { clip.extra.uv = new Float32Array(await get(f, "uv.bin", UV_BASE, this.signal)); } catch (e) { /* plain colour */ }
      if (!this.alive()) return;
    }
    if (meta.obs_positions) {                       // franka: the observed points are not display vertices
      const n = meta.n_obs, p0 = new Float32Array(obs, 0, n * 3), fld = decodeField(obs.slice(n * 12), T, n);
      clip.obsPos = new Float32Array(T * n * 3);
      for (let t = 0; t < T; t++) for (let i = 0; i < n * 3; i++) clip.obsPos[t * n * 3 + i] = p0[i] + fld[t * n * 3 + i];
      clip.nObs = n;
    } else {
      clip.obs = new Uint32Array(obs);
    }
    // ground truth and ours first; the other three are requested once both have arrived or failed
    await Promise.all([this.field("gt"), this.field("ours")]);
    if (!this.alive()) return;
    await Promise.all(["harmonic", "nsdp", "doma"].map(function (m) { return self.field(m); }));
  };
  Loader.prototype.errOf = function (m) {
    const c = this.clip, x = c.fields[m], gt = c.fields.gt, N = c.N, T = c.T, e = new Float32Array(T * N);
    for (let v = 0, j = 0; v < T * N; v++, j += 3) {
      const dx = x[j] - gt[j], dy = x[j + 1] - gt[j + 1], dz = x[j + 2] - gt[j + 2];
      e[v] = Math.sqrt(dx * dx + dy * dy + dz * dz);
    }
    c.err[m] = e;
  };
  Loader.prototype.field = function (m) {         // resolves once the field is in or has failed; never rejects
    const self = this, c = this.clip, n = m + ".bin", e = this.entry;
    const q = this.fetched[n] || get(e.folder, n, e.base, this.signal);
    delete this.fetched[n];                         // a retry fetches afresh
    return q.then(function (buf) {
      if (!self.alive()) return;
      c.fields[m] = decodeField(buf, c.T, c.N);
      if (m === "gt") Object.keys(c.fields).forEach(function (k) { if (k !== "gt" && !c.err[k]) self.errOf(k); });
      else if (c.fields.gt) self.errOf(m);
      self.onField(m, c);
    }, function (err) {
      if (self.alive()) self.onFail(m, err);
    });
  };

  function Explore5(root, tabsEl, index) {
    window.__x5 = this;              // a handle for the layout measurements
    const self = this, el = V.el;
    this.index = index;
    this.frame = 0; this.acc = 0; this.playing = false; this.speed = 1; this.obsOn = true;
    this.token = 0; this.visible = false; this.pending = null; this.clip = null;
    const card = el("div", "card compare x5");
    this.thumbs = el("div", "x5-thumbs");
    this.thumbs.setAttribute("role", "listbox");
    card.appendChild(this.thumbs);
    const views = el("div", "views x5-views x5-two");
    this.viewsEl = views;
    this.camera = new THREE.PerspectiveCamera(30, 0.8, 0.01, 100);
    this.zcam = new THREE.PerspectiveCamera(30, 0.8, 0.01, 100);   // the close-up row's camera (fix_v22 A2)
    this.controls = new THREE.OrbitControls(this.camera, views);
    this.controls.enableDamping = false;
    // rot3: a pole guard only, 1° from either pole of the clip's up axis (no flip at the poles); the camera may go
    // below the floor, which then fades out (floorFade)
    this.controls.minPolarAngle = THREE.MathUtils.degToRad(1); this.controls.maxPolarAngle = THREE.MathUtils.degToRad(179);
    V.touchGuard(views, this.controls);
    views.addEventListener("wheel", function (e) { if (!e.ctrlKey && !e.metaKey) e.stopImmediatePropagation(); }, { capture: true });
    const mkView = function (cell, kind, m) {
      const v = el("div", "view x5-" + kind);
      cell.appendChild(v);
      const s = V.makeScene();
      const view = { el: v, scene: s.scene, key: s.key, camera: self.camera, ready: false, body: null, bg: V.THEME.stage3d,
                     method: m, kind: kind };
      lighting(view);
      view.fit = function (aspect) { self.fit(aspect); };
      view.mk = mkMarker(v, m === "harmonic" && kind === "error");
      view.beforeRender = function (b) { self.placeMarker(view, b); self.light(view, self.camera, self.controls.target); self.floorFade(view); };
      if (!(m === "gt" && kind === "error")) {     // every view opens the close-up of all five columns (fix_v22 r3)
        const eb = el("button", "x5-enlarge"); eb.type = "button";
        eb.innerHTML = '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M2 6V2h4M10 2h4v4M14 10v4h-4M6 14H2v-4" fill="none" stroke="currentColor" stroke-width="1.6"/></svg>';
        eb.setAttribute("aria-label", "Close-up of all five at the largest harmonic error");
        eb.addEventListener("click", function (e) { e.stopPropagation(); self.openBig(m, eb); });
        v.appendChild(eb);
      }
      V.Stage.views.add(view);
      return view;
    };
    this.views = []; this.retryBtns = {}; this.failed = {};
    METHODS.forEach(function (m) {
      const cell = el("div", "vcell x5-cell");
      cell.dataset.method = m[0];
      cell.appendChild(el("div", "vlabel", m[1]));
      self.views.push(mkView(cell, "shape", m[0]));
      if (m[0] === "gt") {                           // the video's ground-truth error cell: the colour bar
        const lg = el("div", "x5-legendcell"), scale = el("div", "x5-scale");
        const bar = el("span", "bar"); bar.style.background = V.HEAT_CSS;
        lg.appendChild(el("div", "x5-legendlabel", "error"));
        scale.appendChild(el("span", "lo", "low")); scale.appendChild(bar); scale.appendChild(el("span", "hi", "high"));
        lg.appendChild(scale);
        // what the ring marks (the same vertex in every view of both rows)
        const key = el("div", "x5-markkey"); key.appendChild(el("span", "x5-markring"));
        key.appendChild(el("span", null, "largest harmonic error (whole clip)"));
        lg.appendChild(key);
        cell.appendChild(lg);
      } else {
        self.views.push(mkView(cell, "error", m[0]));
      }
      const rb = el("button", "x5-retry", "Retry"); rb.type = "button"; rb.hidden = true;
      rb.setAttribute("aria-label", "Retry loading " + m[1]);
      rb.addEventListener("click", function () { self.retry(m[0]); });
      cell.appendChild(rb);
      self.retryBtns[m[0]] = rb;
      views.appendChild(cell);
    });
    card.appendChild(views);
    this.buildBig(card, views);
    this.dots = el("div", "x5-dots");
    METHODS.forEach(function () { self.dots.appendChild(el("span")); });
    card.appendChild(this.dots);
    views.addEventListener("scroll", function () { self.markDot(); }, { passive: true });

    const tl = el("div", "timeline");
    this.playBtn = el("button", "btn", "Play"); this.playBtn.type = "button";
    this.playBtn.addEventListener("click", function () { self.setPlaying(!self.playing); });
    tl.appendChild(this.playBtn);
    this.scrub = el("input"); this.scrub.type = "range"; this.scrub.min = 0; this.scrub.value = 0;
    this.scrub.setAttribute("aria-label", "Frame");
    this.scrub.addEventListener("input", function () { self.setPlaying(false); self.setFrame(+self.scrub.value); });
    // fix_v22 r3: a mark on the track at the frame where harmonic's error at the ringed vertex peaks
    const sw = el("span", "x5-scrubwrap");
    sw.appendChild(this.scrub);
    this.peakMark = el("span", "x5-peak"); this.peakMark.hidden = true;
    this.peakMark.title = "largest harmonic error at the ringed vertex";
    sw.appendChild(this.peakMark);
    tl.appendChild(sw);
    tl.appendChild(el("span", "seg-label", "Speed"));
    this.speedSeg = V.segButtons(tl, [0.25, 0.5, 1, 2].map(function (s) { return { label: s + "×", value: s }; }),
                                 function (s) { self.speed = s; self.speedSeg.set(s); });
    this.speedSeg.set(1);
    this.obsBox = V.toggle(tl, "Show observed", true, function (on) { self.setObs(on); });
    card.appendChild(tl);
    this.timelineEl = tl;
    this.status = el("div", "info");
    card.appendChild(this.status);
    root.appendChild(card);

    const TABS = ["DT4D", "Human", "Franka", "Cloth", "Legged"];
    this.tabBtns = TABS.map(function (name) {
      const b = el("button", "tab", name);
      b.type = "button"; b.setAttribute("role", "tab");
      b.addEventListener("click", function () { self.selectTab(name); self.land(); });
      tabsEl.appendChild(b);
      return b;
    });
    V.Stage.tickers.add(function (dt) { self.tick(dt); });
    new IntersectionObserver(function (es) {
      self.visible = es[0].isIntersecting;
      if (self.visible && self.pending) { const p = self.pending; self.pending = null; self.load(p); }
    }, { rootMargin: "300px 0px" }).observe(card);
    this.selectTab(TABS[0]);
  }

  Explore5.prototype.selectTab = function (name) {
    const self = this, el = V.el;
    this.tabBtns.forEach(function (b) { b.setAttribute("aria-selected", String(b.textContent === name)); });
    this.entries = this.index.filter(function (e) { return e.tab === name; });
    this.thumbs.textContent = "";
    this.thumbBtns = this.entries.map(function (e, i) {
      const b = el("button", "x5-thumb"); b.type = "button";
      b.setAttribute("aria-label", "Clip " + (i + 1));
      const im = el("img"); im.alt = ""; im.loading = "lazy"; im.decoding = "async";
      im.src = e.base + e.folder + "/thumb.webp" + (window.__build ? "?v=" + window.__build : "");
      b.appendChild(im);
      b.addEventListener("click", function () { clearTimeout(self.hoverT); if (e === self.entry) return; adopt(e); self.request(e); });
      b.addEventListener("pointerenter", function (ev) {
        if (ev.pointerType !== "mouse") return;
        clearTimeout(self.hoverT);
        self.hoverT = setTimeout(function () { self.hovered = e; if (e !== self.entry && !self.busy) prefetch(e); }, HOVER_MS);
      });
      b.addEventListener("pointerleave", function (ev) {
        if (ev.pointerType !== "mouse") return;
        clearTimeout(self.hoverT);
        self.hovered = null;
        if (e !== self.entry) unhover(e);
      });
      self.thumbs.appendChild(b);
      return b;
    });
    this.request(this.entries[0]);
  };

  /* switching clips: the clip on screen stays (dimmed, still playing) until the new clip's ground truth and ours
     are decoded; then every view is swapped at once, ground truth and ours drawn, the other columns filling in as
     their fields arrive. A second click while waiting supersedes the first. */
  const DIM = 0.45;
  Explore5.prototype.request = function (entry) {
    this.closeBig(true);
    this.token++;
    if (this.loadCtl) this.loadCtl.abort();         // the superseded clip's downloads stop here
    if (this.entry && this.entry !== entry) dropAdopted(this.entry);
    this.failed = {}; this.showRetry();
    this.entry = entry;
    this.tClick = performance.now();
    const i = this.entries.indexOf(entry);
    this.thumbBtns.forEach(function (b, k) { b.setAttribute("aria-pressed", String(k === i)); });
    const shown = this.views.some(function (v) { return v.ready; });
    this.views.forEach(function (v) { if (v.ready) v.fade = DIM; else v.el.classList.add("loading"); });
    this.viewsEl.classList.toggle("x5-waiting", shown);
    this.status.textContent = "";
    if (this.visible) this.load(entry); else this.pending = entry;
  };
  /* where Skip to Explore lands: the section top just under the bar; a tab click brings the block there too */
  Explore5.prototype.land = function () {
    const sec = document.getElementById("explore");
    if (!sec) return;
    const want = parseFloat(getComputedStyle(sec).scrollMarginTop) || 0, top = sec.getBoundingClientRect().top;
    if (Math.abs(top - want) > 2) window.scrollTo({ top: window.scrollY + top - want, behavior: "smooth" });
  };

  /* one fixed camera per clip, shared by all ten views: the ground truth's box over every frame of the clip spans
     FIT_V of the view height (or FIT_H of its width, whichever binds first); the view direction is the video's
     projection lifted slightly. A baseline that flies off may leave the frame; nothing is shrunk for it. */
  const FIT_V = 0.86, FIT_H = 0.94;
  Explore5.prototype.fit = function (aspect) {
    if (!this.box) return;
    const c = (this.clip ? this.clip.entry : this.entry).camera, up = new THREE.Vector3().fromArray(c.up).normalize();
    const dir = new THREE.Vector3().fromArray(c.dir).normalize().addScaledVector(up, 0.18).normalize();
    const box = this.box, ctr = box.lo.clone().add(box.hi).multiplyScalar(0.5);
    const fwd = dir.clone().negate(), right = new THREE.Vector3().crossVectors(fwd, up).normalize();
    const upv = new THREE.Vector3().crossVectors(right, fwd).normalize();
    const cam = this.camera, tv = Math.tan(THREE.MathUtils.degToRad(cam.fov / 2)), th = tv * aspect;
    // fitted on the ground truth's own vertices (every frame, every 4th vertex), not the box corners: the projected
    // vertical extent is FIT_V of the view height unless the horizontal extent would exceed FIT_H of its width
    const G = this.gtPts;
    let dist = box.hi.clone().sub(box.lo).length() * 2, tgt = ctr.clone();
    const place = function () {
      cam.up.copy(up); cam.aspect = aspect; cam.position.copy(tgt).addScaledVector(dir, dist);
      cam.near = dist / 100; cam.far = dist * 20; cam.lookAt(tgt); cam.updateProjectionMatrix(); cam.updateMatrixWorld();
    };
    const q = new THREE.Vector3();
    for (let it = 0; it < 8; it++) {
      place();
      let x0 = 9, x1 = -9, y0 = 9, y1 = -9;
      for (let k = 0; k < G.length; k += 3) {
        q.set(G[k], G[k + 1], G[k + 2]).project(cam);
        if (q.x < x0) x0 = q.x; if (q.x > x1) x1 = q.x; if (q.y < y0) y0 = q.y; if (q.y > y1) y1 = q.y;
      }
      const sc = Math.max((y1 - y0) / (2 * FIT_V), (x1 - x0) / (2 * FIT_H));
      // re-centre on the projected extent (camera-plane units at distance dist)
      const hw = dist * tv, cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
      tgt.addScaledVector(right, cx * hw * aspect).addScaledVector(upv, cy * hw);
      dist *= sc;
    }
    place();
    const ctr2 = tgt;
    this.controls.target.copy(ctr2);
    this.controls.update();
    this.views.forEach(function (w) { w.fitAspect = aspect; });
  };

  Explore5.prototype.load = async function (entry) {
    const token = ++this.token, self = this;
    if (this.loadCtl) this.loadCtl.abort();
    const ctl = this.loadCtl = window.AbortController ? new AbortController() : null;
    this.t0 = performance.now(); this.tFirst = null; this.tAll = null;
    this.busy = true; this.failed = {}; this.showRetry();
    window.__x5Loaded = window.__x5Loaded || 0;
    const alive = function () { return token === self.token; };
    const ready = function (v) {
      const c = self.clip;
      v.body = new V.Body(c, v.scene);
      // fix_v22 A4: the floor sits at the lowest vertex any column draws (all frames, all five fields that have
      // arrived; lowered when a later field reaches below it) and is drawn behind the subject. No mirror image.
      v.floor = V.addShadow(v.scene, self.box, self.up, { level: self.floorH, behind: true });
      v.body.setObs(c.obs || new Uint32Array(c.nObs), self.obsOn);
      v.fitAspect = 0; v.ready = true; v.el.classList.remove("loading");
    };
    let swapped = false;
    const swap = function () {
      swapped = true;
      self.dispose();
      self.views.forEach(function (v) { v.el.classList.add("loading"); });
      self.viewsEl.classList.remove("x5-waiting");
      self.tSwap = performance.now() - (self.tClick || self.t0);
      window.__x5Swap = (window.__x5Swap || 0) + 1;
    };
    const settled = function () {                   // every field in or failed: the load is over
      const L = self.loader, c = L && L.clip;
      if (self.failed["*"]) return true;
      return !!c && METHODS.every(function (m) { return c.fields[m[0]] || self.failed[m[0]]; });
    };
    const after = function () {
      if (!settled()) return;
      self.busy = false;
      if (!Object.keys(self.failed).length) dropAdopted(entry);
      if (self.hovered && self.hovered !== self.entry) prefetch(self.hovered);   // the preload deferred by this load
    };
    const onField = function (m, c) {
      if (!alive()) return;
      if (!swapped) {
        if (!(c.fields.gt && c.fields.ours && c.err.ours)) return;   // the old clip stays until both are ready
        swap();
      }
      self.clip = c;
      if (c.fields[m] && m !== "*") self.lowerFloor(c, m);
      if (!self.box && c.fields.gt) {
        self.box = V.clipBox(c, [c.fields.gt]);       // the ground truth over every frame of the clip
        const N = c.N, T = c.T, gp = [];
        for (let t = 0; t < T; t++) for (let v = 0; v < N; v += 4) {
          const o = (t * N + v) * 3; gp.push(c.rest[v * 3] + c.fields.gt[o], c.rest[v * 3 + 1] + c.fields.gt[o + 1], c.rest[v * 3 + 2] + c.fields.gt[o + 2]);
        }
        self.gtPts = new Float32Array(gp);
        self.frame = Math.floor(c.T / 2);
        self.scrub.max = c.T - 1; self.scrub.value = self.frame;
      }
      if (self.markerV === undefined && c.err.harmonic) self.findMarker(c);
      self.views.forEach(function (v) {
        if (v.ready || !c.fields.gt || !c.fields[v.method]) return;
        if (v.kind === "error" && !c.err[v.method]) return;
        ready(v);
      });
      if (self.bigOpen) self.bigViews.forEach(function (v) {   // a field that arrives while the close-up is open
        if (!v.ready && c.fields[v.method] && (v.method === "gt" || c.err[v.method])) { v.ready = true; v.el.classList.remove("loading"); }
      });
      self.showRetry();
      self.redraw();
      const n = self.views.filter(function (v) { return v.ready; }).length;
      if (n && self.tFirst === null) { self.tFirst = performance.now() - self.t0; self.setPlaying(true); }
      if (n === self.views.length && self.tAll === null) { self.tAll = performance.now() - self.t0; self.loadMs = self.tAll; window.__x5Loaded++; }
      after();
    };
    // a field that fails or stalls: its column (every column, if it is the ground truth or the clip itself) gets a
    // Retry in place of "loading…"; a failure before the swap swaps anyway, so the old clip is not left dimmed
    const onFail = function (m, e) {
      if (!alive()) return;
      console.warn("[explore5] " + entry.folder + " " + m + ": " + (e && e.message ? e.message : e));
      self.failed[m] = true;
      if (!swapped) swap();
      if (self.loader.clip && !self.clip) self.clip = self.loader.clip;
      self.showRetry();
      after();
    };
    this.up = new THREE.Vector3().fromArray(entry.camera.up).normalize();
    this.floorH = undefined; this.floorOf = {};
    this.loader = new Loader(entry, ctl && ctl.signal, onField, onFail, alive);
    await this.loader.start();
  };
  Explore5.prototype.showRetry = function () {
    const F = this.failed, self = this;
    METHODS.forEach(function (m) {
      const k = m[0], blocked = !!(F["*"] || F[k] || (k !== "gt" && F.gt));
      const rb = self.retryBtns[k];
      if (rb) rb.hidden = !blocked;
      self.views.forEach(function (v) {
        if (v.method !== k || v.ready) return;
        v.el.classList.toggle("loading", !blocked);
        v.el.classList.toggle("x5-failed", blocked);
      });
    });
    this.status.textContent = F["*"] ? "Could not load this clip." : "";
  };
  Explore5.prototype.retry = function (m) {
    if (this.failed["*"] || !this.loader || !this.loader.clip) { this.load(this.entry); return; }
    const L = this.loader, F = this.failed;
    const todo = [m === "gt" || F.gt ? "gt" : null, F[m] ? m : null].filter(function (x, i, a) { return x && a.indexOf(x) === i; });
    this.busy = true;
    todo.forEach(function (k) { delete F[k]; });
    this.showRetry();
    todo.forEach(function (k) { L.field(k); });
  };

  Explore5.prototype.setObs = function (on) {
    this.obsOn = on;
    this.views.concat(this.bigViews || []).forEach(function (v) { if (v.body) v.body.obsPts.visible = on; });
  };

  Explore5.prototype.redraw = function () {
    const c = this.clip;
    if (!c) return;
    const t = this.frame;
    const pose = function (v) {
      const m = v.method, b = v.body;
      if (!v.ready || !b || !c.fields[m]) return;
      b.pose(c.fields[m], t, null, c.fields.gt);     // markers sit at the ground truth
      if (c.obsPos) {                                // franka: the observed points' own positions
        const n = c.nObs, o = t * n * 3;
        for (let i2 = 0; i2 < n * 3; i2++) b.obsPos[i2] = c.obsPos[o + i2];
        b.obsAttr.needsUpdate = true; b.obsGeom.computeBoundingSphere();
      }
      if (v.kind === "error" || (v.kind === "zoom" && m !== "gt")) b.paint(c.err[m], t, c.vmax);   // one scale: the error row's
      else b.paint(null, t, 0);
    };
    if (this.bigOpen) this.bigViews.forEach(pose); else this.views.forEach(pose);
    this.scrub.value = t;
  };
  Explore5.prototype.setFrame = function (f) { this.frame = f; this.redraw(); };
  Explore5.prototype.setPlaying = function (p) {
    this.playing = !!p; this.playBtn.textContent = this.playing ? "Pause" : "Play";
    if (this.bigPlay) this.bigPlay.textContent = this.playBtn.textContent;
  };
  Explore5.prototype.tick = function (dt) {
    if (!this.playing || !this.clip || !this.clip.fields.gt || !this.visible || this.clip.T < 2) return;
    this.acc += dt * FPS * this.speed;
    if (this.acc >= 1) { const n = Math.floor(this.acc); this.acc -= n; this.setFrame((this.frame + n) % this.clip.T); }
  };
  Explore5.prototype.markDot = function () {
    const w = this.viewsEl, cells = w.children;
    if (!cells.length) return;
    const k = Math.round(w.scrollLeft / Math.max(1, cells[0].offsetWidth));
    Array.prototype.forEach.call(this.dots.children, function (d, i) { d.classList.toggle("on", i === k); });
  };
  Explore5.prototype.dispose = function () {
    this.closeBig(true);
    this.markerV = undefined;
    this.views.forEach(function (v) {
      v.ready = false; v.fade = undefined; v.el.classList.remove("x5-failed");
      if (v.body) { V.disposeScene(v.scene); v.body = null; }
      v.floor = null;
      if (v.kind) v.scene.add(v.key.target);                // disposeScene leaves lights; keep the key's target
    });
    this.zR = 0; if (this.peakMark) this.peakMark.hidden = true;
    this.clip = null; this.box = null;
  };

  /* ---- fix_v22 A4: the floor. Its height along the view's up is the lowest vertex of every field that has
     arrived (every frame, every vertex; the rest pose plus the stored field, nothing else); a field that reaches
     lower moves the floor of every view down to it. The floor is drawn behind the subject (viewer.js addShadow
     {behind}), so it never covers any part of it. Scene change only: no vertex is moved. */
  Explore5.prototype.lowerFloor = function (c) {
    const up = this.up, self = this;
    Object.keys(c.fields).forEach(function (m) {
      if (self.floorOf[m] !== undefined) return;
      const F = c.fields[m], R = c.rest, N = c.N, ux = up.x, uy = up.y, uz = up.z;
      let lo = Infinity;
      for (let t = 0, j = 0; t < c.T; t++) for (let v = 0, i = 0; v < N; v++, i += 3, j += 3) {
        const h = (R[i] + F[j]) * ux + (R[i + 1] + F[j + 1]) * uy + (R[i + 2] + F[j + 2]) * uz;
        if (h < lo) lo = h;
      }
      self.floorOf[m] = lo;
      if (self.floorH === undefined || lo < self.floorH) {
        const d = self.floorH === undefined ? 0 : lo - self.floorH;
        self.floorH = lo;
        if (d) self.views.concat(self.bigOpen ? self.bigViews : []).forEach(function (v) { (v.floor || []).forEach(function (o) { o.position.addScaledVector(up, d); }); });
      }
    });
  };

  /* ---- rot3: the floor fades out when the camera goes below it. Elevation = the camera's angle above the floor
     plane, seen from the floor point under the orbit target (signed height along the clip's up over the horizontal
     distance); everything drawn as floor (viewer.js marks it userData.floor: shadow and grid) is scaled linearly
     from full at +2° to nothing at -2°, and back the same way. Alpha only: nothing moves. */
  Explore5.prototype.floorElev = function () {
    if (this.floorH === undefined) return 90;
    const up = this.up, off = this.camera.position.clone().sub(this.controls.target);
    const h = this.camera.position.dot(up) - this.floorH, horiz = off.addScaledVector(up, -off.dot(up)).length();
    return THREE.MathUtils.radToDeg(Math.atan2(h, horiz));
  };
  Explore5.prototype.floorFade = function (view) {
    const objs = [];
    view.scene.traverse(function (o) { if (o.userData.floor && o.material) objs.push(o); });
    if (!objs.length) return;
    const k = THREE.MathUtils.clamp((this.floorElev() + 2) / 4, 0, 1);
    objs.forEach(function (o) {
      const m = o.material, u = m.uniforms && m.uniforms.uA;
      if (o.userData.a0 === undefined) o.userData.a0 = u ? u.value : m.opacity;
      if (u) u.value = o.userData.a0 * k; else m.opacity = o.userData.a0 * k;
      o.visible = k > 0;
    });
  };

  /* ---- fix_v22 A3: contrast. The page's shared lights (a strong hemisphere fill plus a key at the eye) leave the
     surfaces flat and pale; Explore keeps the hemisphere as a weak fill and moves the key above and to the side of
     the eye, so the shape reads from its shading. Lighting only. */
  function lighting(view) {
    view.scene.children.forEach(function (o) { if (o.isHemisphereLight) o.intensity = V.THEME.hemi * 0.6; });
    view.key.intensity = V.THEME.key * 1.35;
    view.scene.add(view.key.target);
  }
  Explore5.prototype.light = function (view, cam, target) {
    if (!target) return;
    const d = cam.position.distanceTo(target), right = new THREE.Vector3().setFromMatrixColumn(cam.matrixWorld, 0);
    const upv = new THREE.Vector3().setFromMatrixColumn(cam.matrixWorld, 1);
    view.key.position.copy(cam.position).addScaledVector(right, -0.55 * d).addScaledVector(upv, 0.75 * d);
    view.key.target.position.copy(target);
    view.key.target.updateMatrixWorld();
  };

  /* ---- the close-up (fix_v22 r3, framing r4), opened by any enlarge button. All five columns on one camera that
     looks along the grid camera's current direction and follows the ringed vertex through the clip.
     Region: the ground-truth vertices within zR of the ringed vertex at its peak frame (the frame where harmonic's
     error there is largest); the same vertex set is drawn in every column (its faces only: a crop of the surface by
     vertex identity, chosen on the ground truth, never on error), so each column shows its own version of that patch.
       zR starts at clamp(ZK x harmonic's error at the vertex at its peak, ZMIN, ZMAX) x the ground truth's box
       (r6: ZMIN = ZMAX = 0.35, so every close-up starts at 0.35 x the diagonal)
       diagonal and grows while one part fills the view (see chooseZoom), to at most ZGROW x the diagonal.
     Fit: at the peak frame, the patch of all five columns (every loaded field) fits inside FIT of each panel in both
     directions (perspective, solved on the vertices); that distance and offset are kept, and the camera moves with
     the ringed vertex's ground-truth position at other frames (refitted when the view is orbited).
     Ground truth's outline: its silhouette only (the edge of its screen-space mask), drawn over every panel.
     Camera, crop and overlay only: every panel draws its own stored positions. */
  const ZK = 2.5, ZMIN = 0.35, ZMAX = 0.35, ZGROW = 0.5, PLANAR = 0.85, FIT = 0.86, VCOVER = 0.75;
  function components(c) {                         // connected components of the clip's mesh (union-find)
    if (c.comp) return c.comp;
    const N = c.N, par = new Int32Array(N), topo = c.topo;
    for (let i = 0; i < N; i++) par[i] = i;
    const find = function (x) { while (par[x] !== x) { par[x] = par[par[x]]; x = par[x]; } return x; };
    for (let f = 0; f < topo.length; f += 3) {
      const a = find(topo[f]), b = find(topo[f + 1]), d = find(topo[f + 2]);
      par[b] = a; par[find(d)] = a;
    }
    const comp = new Int32Array(N);
    for (let i = 0; i < N; i++) comp[i] = find(i);
    return (c.comp = comp);
  }
  Explore5.prototype.setupZoom = function (c) {
    const diag = this.box ? this.box.hi.clone().sub(this.box.lo).length() : 1, v = this.markerV, N = c.N, err = c.err.harmonic;
    let pk = 0, pe = -1;
    for (let t = 0; t < c.T; t++) { const e = err[t * N + v]; if (e > pe) { pe = e; pk = t; } }
    this.peakT = pk; this.peakErr = pe; this.zDiag = diag;
    const R = c.rest, G = c.fields.gt, o = pk * N * 3, topo = c.topo;
    const X = new Float32Array(N * 3);
    for (let i = 0; i < N * 3; i++) X[i] = R[i] + G[o + i];
    // ground-truth vertex normals at the peak frame
    const nrm = new Float32Array(N * 3);
    for (let f = 0; f < topo.length; f += 3) {
      const a = topo[f] * 3, b = topo[f + 1] * 3, d = topo[f + 2] * 3;
      const ux = X[b] - X[a], uy = X[b + 1] - X[a + 1], uz = X[b + 2] - X[a + 2], wx = X[d] - X[a], wy = X[d + 1] - X[a + 1], wz = X[d + 2] - X[a + 2];
      const nx = uy * wz - uz * wy, ny = uz * wx - ux * wz, nz = ux * wy - uy * wx;
      [a, b, d].forEach(function (k) { nrm[k] += nx; nrm[k + 1] += ny; nrm[k + 2] += nz; });
    }
    for (let i = 0; i < N; i++) { const l = Math.hypot(nrm[i * 3], nrm[i * 3 + 1], nrm[i * 3 + 2]) || 1; nrm[i * 3] /= l; nrm[i * 3 + 1] /= l; nrm[i * 3 + 2] /= l; }
    const comp = components(c);
    let big = 0; { const cnt = new Map(); for (let k = 0; k < N; k++) cnt.set(comp[k], (cnt.get(comp[k]) || 0) + 1); cnt.forEach(function (n) { big = Math.max(big, n); }); }
    this.zPre = { X: X, nrm: nrm, comp: comp, onePart: big >= 0.9 * N, P: new THREE.Vector3(X[v * 3], X[v * 3 + 1], X[v * 3 + 2]) };
    this.zR0 = Math.min(ZMAX * diag, Math.max(ZMIN * diag, ZK * pe));
    this.setPatch(this.zR0); this.zR = this.zR0; this.zChosen = false; this.zWhy = "";
    this.zTarget = new THREE.Vector3(); this.zFitKey = "";
    this.peakMark.hidden = c.T < 2;
    this.peakMark.style.setProperty("--f", (pk / Math.max(1, c.T - 1)).toFixed(4));
  };
  /* the patch for radius r: ground-truth vertices within r of the ringed vertex at the peak frame, and their faces */
  Explore5.prototype.setPatch = function (r) {
    const c = this.clip, N = c.N, X = this.zPre.X, P = this.zPre.P, topo = c.topo, sel = new Uint8Array(N);
    for (let i = 0; i < N; i++) { const dx = X[i * 3] - P.x, dy = X[i * 3 + 1] - P.y, dz = X[i * 3 + 2] - P.z; sel[i] = dx * dx + dy * dy + dz * dz <= r * r ? 1 : 0; }
    const pf = [];
    for (let f = 0; f < topo.length; f += 3) if (sel[topo[f]] && sel[topo[f + 1]] && sel[topo[f + 2]]) pf.push(topo[f], topo[f + 1], topo[f + 2]);
    this.zSel = sel; this.zPatch = Uint32Array.from(pf);
    this.zObs = c.obs ? Uint32Array.from(Array.prototype.filter.call(c.obs, function (k) { return sel[k]; })) : new Uint32Array(0);
  };
  /* the radius, chosen once when the close-up opens (it needs the view direction): from zR0, grow by x1.15 up to
     ZGROW x the diagonal while ONE part fills the view -- measured by drawing the ground-truth patch at the peak
     frame from the close-up camera with one flat colour per connected component and counting pixels:
       - stop when no component covers more than DOMINANT of the patch's visible pixels (two or more parts in view);
       - on a one-part mesh (one component holds 90% of the vertices: bodies, cloth) stop as soon as the patch's
         ground-truth normals are not nearly planar (mean |n . n_mean| < PLANAR), else grow (a flat sheet). */
  const DOMINANT = 0.6;
  Explore5.prototype.chooseZoom = function (aspect) {
    const c = this.clip, Z = this.zPre, r = V.Stage.renderer, diag = this.zDiag;
    if (!r) { this.zChosen = true; return; }
    const W = 160, H = Math.max(16, Math.round(160 / aspect));
    const rt = new THREE.WebGLRenderTarget(W, H), scene = new THREE.Scene(), buf = new Uint8Array(W * H * 4);
    const pos = new THREE.BufferAttribute(Z.X, 3), col = new Float32Array(c.N * 3), ids = new Map();
    for (let i = 0; i < c.N; i++) {
      let k = ids.get(Z.comp[i]); if (k === undefined) { k = ids.size + 1; ids.set(Z.comp[i], k); }
      col[i * 3] = (k & 255) / 255; col[i * 3 + 1] = ((k >> 8) & 255) / 255; col[i * 3 + 2] = 0;
    }
    const g = new THREE.BufferGeometry(); g.setAttribute("position", pos); g.setAttribute("color", new THREE.BufferAttribute(col, 3));
    const mesh = new THREE.Mesh(g, new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.DoubleSide })); mesh.frustumCulled = false;
    scene.add(mesh);
    const cam = this.zcam.clone(), main = this.camera, cc = r.getClearColor(new THREE.Color()), ca = r.getClearAlpha();
    const N = c.N, nrm = Z.nrm;
    let rad = this.zR0, why = "max";
    for (let it = 0; it < 30; it++) {
      this.setPatch(rad);
      g.setIndex(new THREE.BufferAttribute(this.zPatch, 1));
      this.fitZoom(aspect, true);
      const f = this.zFit, fwd = new THREE.Vector3(); main.getWorldDirection(fwd);
      const right = new THREE.Vector3().setFromMatrixColumn(main.matrixWorld, 0), upv = new THREE.Vector3().setFromMatrixColumn(main.matrixWorld, 1);
      cam.position.copy(Z.P).addScaledVector(right, f.ox).addScaledVector(upv, f.oy).addScaledVector(fwd, -f.d);
      cam.quaternion.copy(main.quaternion); cam.aspect = aspect; cam.near = f.d * 0.02; cam.far = f.d * 50;
      cam.updateProjectionMatrix(); cam.updateMatrixWorld();
      r.setRenderTarget(rt); r.setClearColor(0x000000, 1); r.clear(); r.render(scene, cam);
      r.readRenderTargetPixels(rt, 0, 0, W, H, buf); r.setRenderTarget(null);
      const cnt = new Map(); let tot = 0;
      for (let q = 0; q < W * H; q++) { const k = buf[q * 4] + 256 * buf[q * 4 + 1]; if (!k) continue; cnt.set(k, (cnt.get(k) || 0) + 1); tot++; }
      let top = 0; cnt.forEach(function (n) { top = Math.max(top, n); });
      const share = tot ? top / tot : 1;
      let pl = 1;
      if (Z.onePart) {
        let mx = 0, my = 0, mz = 0, n = 0;
        for (let i = 0; i < N; i++) if (this.zSel[i]) { mx += nrm[i * 3]; my += nrm[i * 3 + 1]; mz += nrm[i * 3 + 2]; n++; }
        const l = Math.hypot(mx, my, mz) || 1; mx /= l; my /= l; mz /= l; pl = 0;
        for (let i = 0; i < N; i++) if (this.zSel[i]) pl += Math.abs(nrm[i * 3] * mx + nrm[i * 3 + 1] * my + nrm[i * 3 + 2] * mz);
        pl /= Math.max(1, n);
      }
      this.zShare = share; this.zPlanar = pl;
      if (share <= DOMINANT) { why = "parts"; break; }
      if (Z.onePart && pl < PLANAR) { why = "curved"; break; }
      if (rad >= ZGROW * diag - 1e-9) { why = "max"; break; }
      rad = Math.min(ZGROW * diag, rad * 1.15);
    }
    r.setClearColor(cc, ca);
    rt.dispose(); g.dispose(); mesh.material.dispose();
    this.zR = rad; this.zWhy = why; this.zChosen = true; this.zFitKey = "";
  };
  /* distance and offset that fit the patch of every loaded column at the peak frame inside FIT of the panel */
  Explore5.prototype.fitZoom = function (aspect, gtOnly) {
    const c = this.clip, v = this.markerV, N = c.N, R = c.rest, pk = this.peakT, o = pk * N * 3, sel = this.zSel;
    const main = this.camera, fwd = new THREE.Vector3(); main.getWorldDirection(fwd);
    const right = new THREE.Vector3().setFromMatrixColumn(main.matrixWorld, 0), upv = new THREE.Vector3().setFromMatrixColumn(main.matrixWorld, 1);
    const G = c.fields.gt, P = new THREE.Vector3(R[v * 3] + G[o + v * 3], R[v * 3 + 1] + G[o + v * 3 + 1], R[v * 3 + 2] + G[o + v * 3 + 2]);
    const pts = [];
    METHODS.forEach(function (m) {
      const F = c.fields[m[0]]; if (!F || (gtOnly && m[0] !== "gt")) return;
      for (let i = 0; i < N; i++) if (sel[i]) pts.push(R[i * 3] + F[o + i * 3] - P.x, R[i * 3 + 1] + F[o + i * 3 + 1] - P.y, R[i * 3 + 2] + F[o + i * 3 + 2] - P.z);
    });
    const tv = Math.tan(THREE.MathUtils.degToRad(this.zcam.fov / 2)), th = tv * aspect;
    let ox = 0, oy = 0, d = 1;
    for (let it = 0; it < 8; it++) {
      d = 0;
      let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
      for (let k = 0; k < pts.length; k += 3) {
        const x = pts[k] * right.x + pts[k + 1] * right.y + pts[k + 2] * right.z - ox;
        const y = pts[k] * upv.x + pts[k + 1] * upv.y + pts[k + 2] * upv.z - oy;
        const z = -(pts[k] * fwd.x + pts[k + 1] * fwd.y + pts[k + 2] * fwd.z);      // toward the camera
        d = Math.max(d, Math.abs(x) / (th * FIT) + z, Math.abs(y) / (tv * FIT) + z);
      }
      for (let k = 0; k < pts.length; k += 3) {
        const x = pts[k] * right.x + pts[k + 1] * right.y + pts[k + 2] * right.z - ox;
        const y = pts[k] * upv.x + pts[k + 1] * upv.y + pts[k + 2] * upv.z - oy;
        const z = pts[k] * fwd.x + pts[k + 1] * fwd.y + pts[k + 2] * fwd.z, w = d + z;
        const sx = x / (w * th), sy = y / (w * tv);
        if (sx < x0) x0 = sx; if (sx > x1) x1 = sx; if (sy < y0) y0 = sy; if (sy > y1) y1 = sy;
      }
      ox += (x0 + x1) / 2 * th * d; oy += (y0 + y1) / 2 * tv * d;
    }
    // fix_v22 r7: the cloth. A flag is one thin open sheet; the region (radius 0.35 of the diagonal around a vertex
    // near its free edge) takes in nearly the sheet's whole height and is wider than tall, so the width-limited fit
    // in the portrait viewport leaves bands above and below where a sheet, unlike a body, has nothing to draw. For the
    // cloth, when the drawn meshes cover less than VCOVER of the viewport's height, the region is fitted by its
    // HEIGHT instead (the sides are cut by the viewport), centred as before but shifted, if needed, so the ringed
    // vertex stays inside the middle 80% of the width. Other families keep their fit unchanged.
    const ext = function () {
      let y0 = Infinity, y1 = -Infinity;
      for (let k = 0; k < pts.length; k += 3) {
        const y = pts[k] * upv.x + pts[k + 1] * upv.y + pts[k + 2] * upv.z - oy, z = pts[k] * fwd.x + pts[k + 1] * fwd.y + pts[k + 2] * fwd.z;
        const sy = y / ((d + z) * tv); if (sy < y0) y0 = sy; if (sy > y1) y1 = sy;
      }
      return [y0, y1];
    };
    // how much of the viewport's height the drawn meshes (every loaded column, whole mesh, at the peak frame) cover,
    // counting only what falls inside the viewport's width
    let cy0 = Infinity, cy1 = -Infinity;
    METHODS.forEach(function (m) {
      const F = c.fields[m[0]]; if (!F || (gtOnly && m[0] !== "gt")) return;
      for (let i = 0; i < N; i++) {
        const px = R[i * 3] + F[o + i * 3] - P.x, py = R[i * 3 + 1] + F[o + i * 3 + 1] - P.y, pz = R[i * 3 + 2] + F[o + i * 3 + 2] - P.z;
        const x = px * right.x + py * right.y + pz * right.z - ox, y = px * upv.x + py * upv.y + pz * upv.z - oy, w = d + px * fwd.x + py * fwd.y + pz * fwd.z;
        if (w <= 0 || Math.abs(x / (w * th)) > 1) continue;
        const sy = Math.max(-1, Math.min(1, y / (w * tv))); if (sy < cy0) cy0 = sy; if (sy > cy1) cy1 = sy;
      }
    });
    this.zCover = cy1 > cy0 ? (cy1 - cy0) / 2 : 0;
    const e0 = ext(); this.zVFill = (e0[1] - e0[0]) / 2;
    this.zByHeight = c.meta.family === "flag" && this.zCover < VCOVER;   // the open sheet only (bodies keep their fit)
    if (this.zByHeight) {
      for (let it = 0; it < 8; it++) {
        let dd = 0;
        for (let k = 0; k < pts.length; k += 3) {
          const y = pts[k] * upv.x + pts[k + 1] * upv.y + pts[k + 2] * upv.z - oy;
          const z = -(pts[k] * fwd.x + pts[k + 1] * fwd.y + pts[k + 2] * fwd.z);
          dd = Math.max(dd, Math.abs(y) / (tv * FIT) + z);
        }
        d = dd; const e = ext(); oy += (e[0] + e[1]) / 2 * tv * d;
      }
      const lim = 0.8 * th * d;                    // the vertex (at the origin of pts) within the middle 80% of the width
      ox = Math.max(-lim, Math.min(lim, ox));
    }
    this.zFit = { ox: ox, oy: oy, d: d };
  };
  Explore5.prototype.placeZoom = function (view, b) {
    const c = this.clip, v = this.markerV, cam = this.zcam;
    if (!c || v === undefined || !this.zR || !c.fields.gt) return;
    const t = this.frame, N = c.N, G = c.fields.gt, R = c.rest, o = t * N * 3, aspect = b.width / b.height, main = this.camera;
    const key = aspect.toFixed(3) + "|" + main.quaternion.toArray().map(function (x) { return x.toFixed(4); }).join(",") + "|" + Object.keys(c.fields).length;
    if (key !== this.zFitKey) { this.zFitKey = key; this.fitZoom(aspect); }
    const P = this.zTarget.set(R[v * 3] + G[o + v * 3], R[v * 3 + 1] + G[o + v * 3 + 1], R[v * 3 + 2] + G[o + v * 3 + 2]);
    const fwd = new THREE.Vector3(); main.getWorldDirection(fwd);
    const right = new THREE.Vector3().setFromMatrixColumn(main.matrixWorld, 0), upv = new THREE.Vector3().setFromMatrixColumn(main.matrixWorld, 1);
    const z = this.zFit;
    cam.position.copy(P).addScaledVector(right, z.ox).addScaledVector(upv, z.oy).addScaledVector(fwd, -z.d);
    cam.quaternion.copy(main.quaternion); cam.up.copy(main.up);
    cam.near = z.d * 0.02; cam.far = z.d * 50;
    cam.aspect = aspect; cam.updateProjectionMatrix(); cam.updateMatrixWorld();
    this.zTarget.copy(P);
    this.zoomMask(view, b);
  };
  const MASK_VS = "varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }";
  const MASK_FS = ["uniform sampler2D uMask; uniform vec2 uTx; uniform vec3 uCol; varying vec2 vUv;",
    "void main(){ float c = texture2D(uMask, vUv).r, lo = c, hi = c;",
    "  for (int i = 0; i < 8; i++) { float a = float(i) * 0.785398; float s = texture2D(uMask, vUv + uTx * vec2(cos(a), sin(a))).r; lo = min(lo, s); hi = max(hi, s); }",
    "  float e = hi - lo; if (e < 0.02) discard; gl_FragColor = vec4(uCol, 0.95 * e); }"].join("\n");
  Explore5.prototype.zoomMask = function (view, b) {
    const r = V.Stage.renderer, gv = this.bigViews[0];
    if (!r || !gv.body) return;
    const pr = r.getPixelRatio(), w = Math.max(2, Math.round(b.width * pr)), h = Math.max(2, Math.round(b.height * pr));
    let Z = this.zm;
    if (!Z) {
      Z = this.zm = { rt: new THREE.WebGLRenderTarget(w, h), scene: new THREE.Scene(),
                      mat: new THREE.MeshBasicMaterial({ color: 0xffffff, side: THREE.DoubleSide }), key: "" };
      Z.mesh = new THREE.Mesh(gv.body.geom, Z.mat); Z.mesh.frustumCulled = false; Z.scene.add(Z.mesh);
    }
    if (Z.rt.width !== w || Z.rt.height !== h) { Z.rt.setSize(w, h); Z.key = ""; }
    Z.mesh.geometry = gv.body.geom;
    if (!view.zOver) {                              // the outline overlay of this panel
      const q = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), new THREE.ShaderMaterial({
        uniforms: { uMask: { value: Z.rt.texture }, uTx: { value: new THREE.Vector2() },
                    uCol: { value: new THREE.Color(V.THEME.dark ? 0xf2f4f7 : 0x14181f) } },
        vertexShader: MASK_VS, fragmentShader: MASK_FS, transparent: true, depthTest: false, depthWrite: false }));
      q.frustumCulled = false; q.renderOrder = 20;
      view.scene.add(q); view.zOver = q;
    }
    view.zOver.material.uniforms.uTx.value.set(1.2 / w, 1.2 / h);
    const cam = this.zcam, key = this.frame + "|" + w + "x" + h + "|" + cam.matrixWorld.elements.map(function (x) { return x.toFixed(5); }).join(",");
    if (key === Z.key) return;
    Z.key = key;
    const cc = r.getClearColor(new THREE.Color()), ca = r.getClearAlpha();
    r.setRenderTarget(Z.rt);
    r.setClearColor(0x000000, 1); r.clear();
    r.render(Z.scene, cam);
    r.setRenderTarget(null);
    r.setClearColor(cc, ca);
  };

  /* fix_v22 r5: the viewport's rounded corners. The renderer's viewport and scissor are the view element's box, which
     is exactly the viewport's inner box (inside its border); the scissor is rectangular, so a last full-view pass
     erases (to transparent: the viewport's own CSS background and border show) whatever lies outside the inner box's
     rounded corners, antialiased over one device pixel. */
  const CORNER_FS = ["uniform vec2 uO; uniform vec2 uS; uniform float uR;",
    "void main(){ vec2 p = gl_FragCoord.xy - uO - 0.5 * uS; vec2 q = abs(p) - (0.5 * uS - vec2(uR));",
    "  float d = length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - uR;",
    "  float a = clamp(d + 0.5, 0.0, 1.0); if (a <= 0.0) discard; gl_FragColor = vec4(0.0, 0.0, 0.0, a); }"].join("\n");
  Explore5.prototype.cornerMask = function (view, b) {
    const r = V.Stage.renderer;
    if (!r || !view.body) return;
    if (!view.zCorner) {
      const q = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), new THREE.ShaderMaterial({
        uniforms: { uO: { value: new THREE.Vector2() }, uS: { value: new THREE.Vector2() }, uR: { value: 0 } },
        vertexShader: "void main(){ gl_Position = vec4(position.xy, 0.0, 1.0); }", fragmentShader: CORNER_FS,
        transparent: true, depthTest: false, depthWrite: false, blending: THREE.CustomBlending,
        blendEquation: THREE.AddEquation, blendSrc: THREE.ZeroFactor, blendDst: THREE.OneMinusSrcAlphaFactor,
        blendEquationAlpha: THREE.AddEquation, blendSrcAlpha: THREE.ZeroFactor, blendDstAlpha: THREE.OneMinusSrcAlphaFactor }));
      q.frustumCulled = false; q.renderOrder = 30;
      view.scene.add(q); view.zCorner = q;
    }
    const pr = r.getPixelRatio(), H = window.innerHeight, cs = getComputedStyle(view.frame);
    const rad = Math.max(0, (parseFloat(cs.borderTopLeftRadius) || 0) - (parseFloat(cs.borderTopWidth) || 0));
    const u = view.zCorner.material.uniforms;
    u.uO.value.set(b.left * pr, (H - b.bottom) * pr); u.uS.value.set(b.width * pr, b.height * pr); u.uR.value = rad * pr;
  };

  /* ---- the marker: where harmonic extension is worst in this clip. One vertex per clip, fixed for every frame:
     the vertex whose harmonic error (distance to the ground truth), averaged over all frames of the clip and then
     over its one-ring, is largest (as the earlier three-view card defined it). It is labelled "largest harmonic
     error · whole clip" on harmonic's error view and ringed at the same vertex in every other view; the dot and leader are
     dimmed and dashed when a ray from the camera hits the surface before the vertex. */
  function mkMarker(viewEl, labelled) {
    const co = V.el("div", "callout x5-mark " + (labelled ? "err" : "ring"));
    co.innerHTML = '<svg aria-hidden="true"><line /></svg>' + (labelled ? '<div class="anchor-dot"></div><span>largest harmonic error · whole clip</span>' : '<div class="ring-dot"></div>');
    co.style.display = "none";
    viewEl.appendChild(co);
    return co;
  }
  Explore5.prototype.findMarker = function (c) {
    const err = c.err.harmonic, N = c.N, T = c.T, e = new Float64Array(N);
    for (let t = 0; t < T; t++) for (let v = 0; v < N; v++) e[v] += err[t * N + v];
    const sum = Float64Array.from(e), cnt = new Float64Array(N).fill(1), topo = c.topo;
    for (let f = 0; f < topo.length; f += 3) for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) if (i !== j) {
      sum[topo[f + i]] += e[topo[f + j]]; cnt[topo[f + i]] += 1;
    }
    let best = -1, bv = 0;
    for (let v = 0; v < N; v++) { const m = sum[v] / cnt[v]; if (m > best) { best = m; bv = v; } }
    this.markerV = bv;
    this.setupZoom(c);
  };
  const RAY = new THREE.Raycaster();
  Explore5.prototype.occluded = function (body, P) {
    const target = body.objects[0];
    if (!target || !body.faces) return false;
    const eye = this.camera.position, d = P.clone().sub(eye), dist = d.length();
    target.updateMatrixWorld();
    RAY.set(eye, d.normalize()); RAY.near = 0; RAY.far = dist;
    const hit = RAY.intersectObject(target, false)[0];
    const diag = this.box ? this.box.hi.clone().sub(this.box.lo).length() : 1;
    return !!hit && hit.distance < dist - 0.01 * diag;
  };
  Explore5.prototype.placeMarker = function (view, b) {
    const co = view.mk, body = view.body, v = this.markerV;
    if (!co) return;
    if (!body || !view.ready || v === undefined) { co.style.display = "none"; return; }
    const P = new THREE.Vector3(body.pos[v * 3], body.pos[v * 3 + 1], body.pos[v * 3 + 2]), q = P.clone().project(this.camera);
    if (q.z > 1) { co.style.display = "none"; return; }
    const x = (q.x + 1) / 2 * b.width, y = (1 - q.y) / 2 * b.height;
    co.style.display = "";
    // the ray test is the costly part: every third frame per view is enough to follow the motion
    view.occN = (view.occN || 0) + 1;
    if (view.occN % 3 === 1 || view.occ === undefined) view.occ = this.occluded(body, P);
    co.classList.toggle("hidden-anchor", view.occ);
    const line = co.firstChild.firstChild;
    if (co.classList.contains("ring")) {
      const dot = co.querySelector(".ring-dot");
      dot.style.left = x + "px"; dot.style.top = y + "px";
      line.setAttribute("x1", x); line.setAttribute("y1", y); line.setAttribute("x2", x); line.setAttribute("y2", y);
      return;
    }
    const lw = 232, lh = 24, right = x + 22 + lw < b.width - 4, above = y - 22 - lh >= 4;   // above the vertex when it fits: off the body
    const lx = right ? x + 22 : Math.max(4, x - 22 - lw), ly = above ? y - 22 - lh : Math.min(b.height - lh - 4, y + 22);
    const dot = co.querySelector(".anchor-dot");
    dot.style.left = x + "px"; dot.style.top = y + "px";
    const span = co.querySelector("span");
    span.style.left = lx + "px"; span.style.top = ly + "px";
    line.setAttribute("x1", x); line.setAttribute("y1", y);
    line.setAttribute("x2", right ? lx : lx + lw); line.setAttribute("y2", ly + lh / 2);
  };

  /* ---- the close-up (fix_v22 r3; was: one method large beside ground truth and its error map). Any enlarge button
     (or a click on any view) opens all five columns together on the close-up camera (see placeZoom), the four
     methods coloured by their error on the error row's scale, ground truth in its own colour, ground truth's
     silhouette drawn over each. Opening jumps to the frame where harmonic's error at the ringed vertex peaks and
     pauses; Close, Esc or a click outside returns to the grid at the frame and play state it had. The playback bar
     below stays live (the close-up follows the vertex). It takes the grid's place, so the block keeps its height. */
  Explore5.prototype.buildBig = function (card, views) {
    const self = this, el = V.el;
    const big = el("div", "x5-big"); big.hidden = true;
    big.setAttribute("role", "dialog"); big.setAttribute("aria-modal", "true"); big.setAttribute("aria-labelledby", "x5-big-title");
    const head = el("div", "x5-bighead");
    const btn = function (cls, html, label, fn) {
      const b = el("button", "btn " + cls); b.type = "button"; b.innerHTML = html; b.setAttribute("aria-label", label);
      b.addEventListener("click", fn); head.appendChild(b); return b;
    };
    const title = el("div", "x5-bigtitle", "close-up · largest harmonic error"); title.id = "x5-big-title"; head.appendChild(title); this.bigTitle = title;
    this.bigPeak = btn("x5-bigpeak", "Peak frame", "Go to the frame of the largest harmonic error", function () { self.setPlaying(false); self.setFrame(self.peakT || 0); });
    this.bigPlay = btn("x5-bigplay", "Play", "Play or pause", function () { self.setPlaying(!self.playing); });
    btn("x5-bigclose", "Close &#215;", "Close the close-up", function () { self.closeBig(); });
    big.appendChild(head);
    const panels = el("div", "x5-bigpanels");
    this.bigViews = METHODS.map(function (m) {
      const cell = el("div", "x5-bigcell"), lab = el("div", "vlabel", m[1]);
      cell.appendChild(lab);
      // fix_v22 r5: each column is a visible viewport (rounded, bordered, own background); the 3D view fills its
      // inner box exactly, so the renderer's viewport and scissor are that box and the mesh is cut only there
      const vp = el("div", "x5-vp"), v = el("div", "view x5-zoom");
      vp.appendChild(v); cell.appendChild(vp);
      panels.appendChild(cell);
      const s = V.makeScene();
      const view = { el: v, frame: vp, scene: s.scene, key: s.key, camera: self.zcam, ready: false, body: null, bg: null,   // the viewport's own background shows
                     method: m[0], kind: "zoom", label: lab, big: true, mk: null };
      lighting(view);
      view.beforeRender = function (b) { self.placeZoom(view, b); self.light(view, self.zcam, self.zTarget); self.cornerMask(view, b); self.floorFade(view); };
      return view;
    });
    big.appendChild(panels);
    // the key: the error scale (the error row's) and the outline
    const key = el("div", "x5-bigkey"), bar = el("span", "bar"); bar.style.background = V.HEAT_CSS;
    key.appendChild(el("span", "lo", "error: low")); key.appendChild(bar); key.appendChild(el("span", "hi", "high"));
    const ol = el("span", "x5-markkey"); ol.appendChild(el("span", "x5-zoomline")); ol.appendChild(el("span", null, "ground-truth outline"));
    key.appendChild(ol);
    big.appendChild(key);
    views.parentNode.insertBefore(big, views.nextSibling);
    this.big = big; this.bigPanels = panels;
    this.bigControls = new THREE.OrbitControls(this.camera, panels);
    this.bigControls.enableDamping = false;
    this.bigControls.minPolarAngle = THREE.MathUtils.degToRad(1); this.bigControls.maxPolarAngle = THREE.MathUtils.degToRad(179);   // rot3, as the grid
    V.touchGuard(panels, this.bigControls);
    panels.addEventListener("wheel", function (e) { if (!e.ctrlKey && !e.metaKey) e.stopImmediatePropagation(); }, { capture: true });
    // a click (not a drag) on a grid view opens the close-up; on touch screens the corner button does
    let down = null;
    views.addEventListener("pointerdown", function (e) { down = e.pointerType === "mouse" ? [e.clientX, e.clientY, Date.now()] : null; });
    views.addEventListener("pointerup", function (e) {
      if (!down || Math.hypot(e.clientX - down[0], e.clientY - down[1]) > 4 || Date.now() - down[2] > 500) return;
      const hit = self.views.filter(function (v) {
        const r = v.el.getBoundingClientRect();
        return e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom;
      })[0];
      if (hit && hit.ready) self.openBig(hit.method, hit.el.querySelector(".x5-enlarge"));
    });
    big.addEventListener("keydown", function (e) {
      if (e.key === "Escape") { e.preventDefault(); self.closeBig(); }
      else if (e.key === "Tab") {                     // focus stays inside the dialog
        const f = Array.prototype.slice.call(head.querySelectorAll("button"));
        const i = f.indexOf(document.activeElement);
        if (e.shiftKey && i <= 0) { e.preventDefault(); f[f.length - 1].focus(); }
        else if (!e.shiftKey && i === f.length - 1) { e.preventDefault(); f[0].focus(); }
      }
    });
    document.addEventListener("pointerdown", function (e) {
      if (!self.bigOpen) return;
      if (big.contains(e.target) || (self.timelineEl && self.timelineEl.contains(e.target))) return;
      self.closeBig();
    }, true);
  };
  Explore5.prototype.openBig = function (m, opener) {
    const c = this.clip, self = this;
    if (!c || !c.fields.gt || !this.box || this.markerV === undefined || !this.zR) return;
    this.bigOpener = opener || null;
    if (!this.bigOpen) {
      this.bigSaved = { frame: this.frame, playing: this.playing, acc: this.acc };
      // five panels across the grid's width, the block keeps its height
      const gr = this.viewsEl.getBoundingClientRect();
      const phone = window.matchMedia("(max-width: 767px)").matches;
      this.big.hidden = false;
      this.card = this.card || this.viewsEl.parentNode;
      this.card.classList.add("x5-bigopen");
      const headH = this.big.firstChild.getBoundingClientRect().height + 10, labH = 24, keyH = 34, gap = 10;
      let w, h;
      if (phone) { w = this.bigPanels.getBoundingClientRect().width; h = w; }
      else {
        w = (gr.width - 4 * gap) / 5;
        h = Math.max(w * 0.9, Math.min(gr.height - headH - labH - keyH - 8, w * 1.35));
        this.big.style.height = gr.height + "px";
      }
      this.bigViews.forEach(function (v) { v.frame.style.width = Math.floor(w) + "px"; v.frame.style.height = Math.floor(h) + "px"; });
      if (!this.zChosen) this.chooseZoom(w / h);
      this.views.forEach(function (v) { v.savedFade = v.fade; v.fade = 0; });
      this.bigControls.target.copy(this.controls.target); this.bigControls.update();
      this.bigOpen = true;
      this.bigViews.forEach(function (v) {
        v.body = new V.Body(c, v.scene);
        v.body.setObs(c.obs || new Uint32Array(c.nObs), self.obsOn);         // r5: the whole mesh in every column
        v.ready = !!c.fields[v.method] && (v.method === "gt" || !!c.err[v.method]);
        v.el.classList.toggle("loading", !v.ready);
        V.Stage.views.add(v);
      });
    }
    this.setPlaying(false);
    this.setFrame(this.peakT || 0);
    this.big.querySelector(".x5-bigclose").focus({ preventScroll: true });
  };
  Explore5.prototype.closeBig = function (silent) {
    if (!this.bigOpen) return;
    this.bigOpen = false;
    this.bigViews.forEach(function (v) { V.Stage.views.delete(v); v.ready = false; if (v.body) { V.disposeScene(v.scene); v.body = null; } v.zOver = null; v.zCorner = null; v.scene.add(v.key.target); });
    if (this.zm) this.zm.key = "";
    this.big.hidden = true; this.big.style.height = "";
    this.card.classList.remove("x5-bigopen");
    this.views.forEach(function (v) { v.fade = v.savedFade; });
    this.controls.target.copy(this.bigControls.target); this.controls.update();
    const sv = this.bigSaved;
    if (sv && !silent) { this.frame = sv.frame; this.acc = sv.acc; this.setPlaying(sv.playing); }
    this.bigSaved = null;
    this.redraw();
    if (!silent && this.bigOpener) this.bigOpener.focus({ preventScroll: true });
  };

  window.Explore5 = Explore5;
})();
