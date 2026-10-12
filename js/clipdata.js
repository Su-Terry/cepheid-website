/* Clip loading and decoding. Layout (see any meta.json "layout"):
     mesh.bin   float32 rest [N,3], then uint32 faces [F,3] | edges [E,2]
     obs_k.bin  uint32 [n]
     FIELD      float32 translation [T,3], then float16 residual [T,N,3]
     gt.bin     FIELD, ground-truth displacement from rest
     ours_k.bin / harmonic_k.bin   FIELD of (method - gt)
   Over http(s) the .bin files are fetched; from file:// the sibling .js wrappers are
   injected as <script> tags, which is the one loading path file:// allows. Every request
   carries the build stamp (?v=, from index.html) so a cached file from an older build is never
   combined with a newer one; a file that stalls for FILE_TIMEOUT_MS is tried once more, then
   fails with an error naming it.
   Wall folders from v5 on (meta.gt_vertices === "observed") hold the ground truth at the
   observed vertices only and the prediction absolute. */
(function () {
  "use strict";

  const DEFAULT_BASE = "assets/clips/";
  const baseOf = function (entry) { return (entry && entry.base) || DEFAULT_BASE; };
  const HTTP = /^https?:$/.test(location.protocol);
  const FILE_TIMEOUT_MS = 20000;
  const STAMP = window.__build ? "?v=" + window.__build : "";

  /* A file fails if nothing arrives for FILE_TIMEOUT_MS (a STALL, not a total-time cap: a slow
     but moving download is never cut) or on a network error; it is then tried once more. */
  function withTimeout(p, what, ctl) {
    let timer;
    const t = new Promise(function (_, reject) {
      timer = setTimeout(function () {
        if (ctl) ctl.abort();
        reject(new Error("no data for " + FILE_TIMEOUT_MS / 1000 + " s: " + what));
      }, FILE_TIMEOUT_MS);
    });
    return Promise.race([p, t]).finally(function () { clearTimeout(timer); });
  }
  function getOnce(url) {
    const ctl = window.AbortController ? new AbortController() : null;
    let timer = null, fail = null;
    const stalled = new Promise(function (_, reject) { fail = reject; });
    const arm = function () {
      clearTimeout(timer);
      timer = setTimeout(function () {
        if (ctl) ctl.abort();
        fail(new Error("no data for " + FILE_TIMEOUT_MS / 1000 + " s: " + url));
      }, FILE_TIMEOUT_MS);
    };
    arm();
    const body = fetch(url + STAMP, ctl ? { signal: ctl.signal } : {}).then(function (r) {
      if (!r.ok) throw new Error("could not fetch " + url + " (" + r.status + ")");
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
          arm();                                        // progress: restart the stall timer
          parts.push(x.value); n += x.value.length;
          return pump();
        });
      };
      return pump();
    });
    return Promise.race([body, stalled]).finally(function () { clearTimeout(timer); });
  }
  function getBuf(url) {
    return getOnce(url).catch(function (e) {
      console.warn("[load] retrying once: " + (e && e.message ? e.message : e));
      return getOnce(url);
    });
  }
  function retryOnce(f) {
    return f().catch(function (e) {
      console.warn("[load] retrying once: " + (e && e.message ? e.message : e));
      return f();
    });
  }

  const HALF = (function () {
    const t = new Float32Array(65536);
    for (let h = 0; h < 65536; h++) {
      const s = h & 0x8000 ? -1 : 1;
      const e = (h >> 10) & 0x1f;
      const f = h & 0x3ff;
      if (e === 0) t[h] = s * Math.pow(2, -14) * (f / 1024);
      else if (e === 31) t[h] = f ? NaN : s * Infinity;
      else t[h] = s * Math.pow(2, e - 15) * (1 + f / 1024);
    }
    return t;
  })();

  function loadScript(src) {
    return new Promise(function (resolve, reject) {
      const s = document.createElement("script");
      s.src = src + STAMP;
      s.onload = function () { s.remove(); resolve(); };
      s.onerror = function () { s.remove(); reject(new Error("could not load " + src)); };
      document.head.appendChild(s);
    });
  }

  function b64ToBuffer(b64) {
    const bin = atob(b64);
    const n = bin.length;
    const u = new Uint8Array(n);
    for (let i = 0; i < n; i++) u[i] = bin.charCodeAt(i);
    return u.buffer;
  }

  async function loadBin(folder, name, BASE) {
    BASE = BASE || DEFAULT_BASE;
    if (HTTP) return await getBuf(BASE + folder + "/" + name);
    const key = folder + "/" + name;
    const src = BASE + folder + "/" + name.replace(/\.bin$/, ".js");
    await retryOnce(function () { return withTimeout(loadScript(src), src); });
    const b64 = window.__clip && window.__clip[key];
    if (b64 === undefined) throw new Error("wrapper did not define " + key);
    delete window.__clip[key];
    return b64ToBuffer(b64);
  }

  async function loadMeta(folder, BASE) {
    BASE = BASE || DEFAULT_BASE;
    window.__clipMeta = window.__clipMeta || {};
    if (!window.__clipMeta[folder]) {
      if (HTTP) {
        const buf = await getBuf(BASE + folder + "/meta.json");
        window.__clipMeta[folder] = JSON.parse(new TextDecoder().decode(buf));
      } else {
        const src = BASE + folder + "/meta.js";
        await retryOnce(function () { return withTimeout(loadScript(src), src); });
      }
      if (!window.__clipMeta[folder]) throw new Error("meta did not load: " + folder);
    }
    return window.__clipMeta[folder];
  }

  function decodeField(buf, T, N) {
    const tr = new Float32Array(buf, 0, T * 3);
    const r = new Uint16Array(buf, T * 12, T * N * 3);
    const out = new Float32Array(T * N * 3);
    for (let t = 0; t < T; t++) {
      const a = tr[t * 3], b = tr[t * 3 + 1], c = tr[t * 3 + 2];
      const o = t * N * 3;
      for (let i = 0; i < N * 3; i += 3) {
        out[o + i] = a + HALF[r[o + i]];
        out[o + i + 1] = b + HALF[r[o + i + 1]];
        out[o + i + 2] = c + HALF[r[o + i + 2]];
      }
    }
    return out;
  }

  /* field_encoding "increment" (chain folders): stored values are per-frame increments */
  function cumsum(x, T, N) {
    const n = N * 3;
    for (let t = 1; t < T; t++) {
      const o = t * n, p = o - n;
      for (let i = 0; i < n; i++) x[o + i] += x[p + i];
    }
    return x;
  }

  /* delta (method - gt) -> method field, and |delta| per vertex (the error the heatmap shows) */
  function applyDelta(gt, delta, T, N) {
    const out = new Float32Array(T * N * 3);
    const err = new Float32Array(T * N);
    for (let j = 0, v = 0; v < T * N; v++, j += 3) {
      const dx = delta[j], dy = delta[j + 1], dz = delta[j + 2];
      out[j] = gt[j] + dx;
      out[j + 1] = gt[j + 1] + dy;
      out[j + 2] = gt[j + 2] + dz;
      err[v] = Math.sqrt(dx * dx + dy * dy + dz * dz);
    }
    return { field: out, err: err };
  }

  /* entry: a row of window.__clipIndex. keys: density keys to load. */
  async function loadClip(entry, keys, extras, methods, parallel) {
    methods = methods || ["ours", "harmonic"];
    const folder = entry.folder, B = baseOf(entry);
    let loadBinB = function (f, n) { return loadBin(f, n, B); };
    /* parallel (opt-in; the hero wall passes true): every file this clip will read is requested at once, together
       with meta.json, instead of one after another. Parsing below is unchanged and awaits the files in the same
       order, so the result is the same. A file read twice (the observed set, obs_k.bin, on v5 wall folders) is
       fetched once and the second reader gets its own copy of the bytes. */
    if (parallel) {
      const want = ["mesh.bin", "gt.bin"];
      for (const k of keys) {
        want.push("obs_" + k + ".bin");
        if (methods.indexOf("ours") >= 0) want.push("ours_" + k + ".bin");
        if (methods.indexOf("harmonic") >= 0) want.push("harmonic_" + k + ".bin");
      }
      for (const n of (extras || [])) want.push(n + ".bin");
      const pre = {}, used = {};
      for (const n of want) if (!pre[n]) { pre[n] = loadBin(folder, n, B); pre[n].catch(function () {}); }
      loadBinB = function (f, n) {
        if (f !== folder || !pre[n]) return loadBin(f, n, B);
        if (used[n]) return pre[n].then(function (b) { return b.slice(0); });
        used[n] = true;
        return pre[n];
      };
    }
    const meta = await loadMeta(folder, B);
    const N = meta.N, T = meta.T;
    const meshBuf = await loadBinB(folder, "mesh.bin");
    const rest = new Float32Array(meshBuf, 0, N * 3);
    let topo = null;
    if (meta.topology === "faces") topo = new Uint32Array(meshBuf, N * 12, meta.n_faces * 3);
    else if (meta.topology === "edges") topo = new Uint32Array(meshBuf, N * 12, meta.n_edges * 2);
    const inc = meta.field_encoding === "increment";
    const dec = function (buf) { const x = decodeField(buf, T, N); return inc ? cumsum(x, T, N) : x; };
    const obsOnly = meta.gt_vertices === "observed", absolute = meta.method_fields === "absolute";
    let gt;
    if (obsOnly) {                                   // v5 wall: ground truth at the observed vertices
      const o0 = new Uint32Array(await loadBinB(folder, "obs_" + keys[0] + ".bin"));
      const g = decodeField(await loadBinB(folder, "gt.bin"), T, o0.length);
      gt = new Float32Array(T * N * 3);
      for (let t = 0; t < T; t++) for (let k = 0; k < o0.length; k++)
        for (let a = 0; a < 3; a++) gt[(t * N + o0[k]) * 3 + a] = g[(t * o0.length + k) * 3 + a];
    } else {
      gt = dec(await loadBinB(folder, "gt.bin"));
    }
    const dens = {};
    for (const k of keys) {
      const obs = new Uint32Array(await loadBinB(folder, "obs_" + k + ".bin"));
      const oursOf = async function () {
        const x = dec(await loadBinB(folder, "ours_" + k + ".bin"));
        return absolute ? { field: x, err: null } : applyDelta(gt, x, T, N);
      };
      const o = methods.indexOf("ours") >= 0 ? await oursOf() : {};
      const h = methods.indexOf("harmonic") >= 0 ? applyDelta(gt, dec(await loadBinB(folder, "harmonic_" + k + ".bin")), T, N) : {};
      dens[k] = { obs: obs, ours: o.field, oursErr: o.err, harmonic: h.field, harmonicErr: h.err };
    }
    const extra = {};
    for (const n of (extras || [])) extra[n] = new Uint32Array(await loadBinB(folder, n + ".bin"));
    return { entry: entry, meta: meta, N: N, T: T, rest: rest, topo: topo, gt: gt, dens: dens, extra: extra };
  }

  /* a plain script (file:// and http alike), injected once */
  const ONCE = {};
  function loadScriptOnce(src) {
    if (!ONCE[src]) ONCE[src] = retryOnce(function () { return withTimeout(loadScript(src), src); });
    return ONCE[src];
  }

  window.ClipData = { loadClip: loadClip, loadMeta: loadMeta, loadBin: loadBin, loadScriptOnce: loadScriptOnce };
})();
