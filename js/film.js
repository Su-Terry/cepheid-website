/* Applications: two stacked film blocks, each its own Film with its own switcher (arrows, tabs,
   swipe, arrow keys): "Video" (DAVIS point tracks completed) and "Robot" (Isaac Lab / Newton
   soft-bar simulations completed from robot points); a block shows the strips whose kind matches
   its data-kind. Scroll-scrubbed: section progress p (eased like the rest of the page) picks a
   fractional frame u of the CURRENT strip; the large view shows the nearest frame (no blending)
   and the thumbnail strip slides so frame u sits at its centre. Switching keeps p, so the new strip
   opens at the same point of its own timeline. A strip's frames load only when it is selected and
   the section is near. */
(function () {
  "use strict";
  const EASE = 0.15;
  function damp(st, target, dt) {
    if (dt <= 0) return st.v;
    const w = 2 / EASE, x = w * dt, e = 1 / (1 + x + 0.48 * x * x + 0.235 * x * x * x);
    const ch = st.v - target, tmp = (st.vel + w * ch) * dt;
    st.vel = (st.vel - w * tmp) * e;
    let out = target + (ch + tmp) * e;
    if ((target - st.v > 0) === (out > target)) { out = target; st.vel = 0; }
    st.v = out;
    return out;
  }
  const pad3 = function (k) { return String(k).padStart(3, "0"); };

  function Film(root) {
    this.root = root;
    const kind = root.getAttribute("data-kind");
    this.strips = window.__apps.filter(function (s) { return s.kind === kind; });
    this.stage = root.querySelector(".film-stage");
    this.main = root.querySelector(".film-main");
    this.fa = root.querySelector(".fa");
    // two images: the next frame decodes in the back one and only then comes to the front
    this.fb = document.createElement("img");
    this.fb.alt = ""; this.fb.decoding = "async"; this.fb.className = "fb";
    this.fa.classList.add("front");
    this.fa.parentNode.appendChild(this.fb);
    this.imgs = [this.fa, this.fb]; this.front = 0;
    this.track = root.querySelector(".film-track");
    this.tabsEl = root.querySelector(".film-tabs");
    this.legends = Array.prototype.slice.call(root.querySelectorAll(".film-legend"));
    this.captions = Array.prototype.slice.call(root.querySelectorAll(".film-caption"));
    this.place = root.querySelector(".film-place");   // davis9: per-clip placement credit (Video block only)
    this.stamp = window.__build ? "?v=" + window.__build : "";
    this.pr = { v: 0, vel: 0 };
    this.near = false;
    this.cache = {};
    const self = this;
    this.tabs = this.strips.map(function (s, i) {
      const b = document.createElement("button");
      b.type = "button"; b.className = "ftab"; b.setAttribute("role", "tab");
      b.textContent = s.label;
      b.addEventListener("click", function () { self.select(i); });
      self.tabsEl.appendChild(b);
      return b;
    });
    root.querySelector(".film-prev").addEventListener("click", function () { self.step(-1); });
    root.querySelector(".film-next").addEventListener("click", function () { self.step(1); });
    this.tabsEl.addEventListener("keydown", function (e) {
      if (e.key === "ArrowLeft" || e.key === "ArrowRight") { e.preventDefault(); self.step(e.key === "ArrowLeft" ? -1 : 1); self.tabs[self.cur].focus(); }
    });
    // swipe on the large view: a mostly-horizontal drag of 40 px or more switches
    let sx = null, sy = null;
    this.main.addEventListener("touchstart", function (e) { const t = e.touches[0]; sx = t.clientX; sy = t.clientY; }, { passive: true });
    this.main.addEventListener("touchend", function (e) {
      if (sx === null) return;
      const t = e.changedTouches[0], dx = t.clientX - sx, dy = t.clientY - sy;
      sx = null;
      if (Math.abs(dx) >= 40 && Math.abs(dx) > 1.5 * Math.abs(dy)) self.step(dx < 0 ? 1 : -1);
    }, { passive: true });
    new IntersectionObserver(function (es) {
      self.near = es[0].isIntersecting;
      if (self.near) self.load(self.cur);
    }, { rootMargin: "1200px 0px" }).observe(root);
    this.select(0);
    const loop = function (now) {
      requestAnimationFrame(loop);
      const dt = self.last ? Math.min((now - self.last) / 1000, 0.1) : 0;
      self.last = now;
      self.tick(dt);
    };
    requestAnimationFrame(loop);
  }

  Film.prototype.src = function (s, k, thumb) {
    // davis9: a strip may name its own asset directory (s.base); without one it is assets/apps/<id>/ as before
    // hr: asset version (s.av, set per strip in the index) appended after the build stamp so replaced frames are refetched
    return (s.base || "assets/apps/" + s.id + "/") + (thumb ? "t_" : "f_") + pad3(k) + ".webp" + this.stamp +
      (s.av ? (this.stamp ? "&" : "?") + "a=" + s.av : "");
  };

  Film.prototype.step = function (d) {
    this.select((this.cur + d + this.strips.length) % this.strips.length);
  };

  Film.prototype.select = function (i) {
    this.cur = i;
    const s = this.strips[i], self = this;
    this.tabs.forEach(function (b, j) {
      b.setAttribute("aria-selected", String(j === i));
      b.tabIndex = j === i ? 0 : -1;
    });
    const on = this.tabs[i];
    this.tabsEl.scrollTo({ left: on.offsetLeft - (this.tabsEl.clientWidth - on.offsetWidth) / 2, behavior: "smooth" });
    this.main.style.aspectRatio = s.width + " / " + s.height;
    this.main.style.setProperty("--ar", (s.width / s.height).toFixed(4));
    this.legends.forEach(function (el) { el.hidden = el.getAttribute("data-for") !== s.kind; });
    this.captions.forEach(function (el) { el.hidden = el.getAttribute("data-for") !== (s.caption || s.kind); });
    if (this.place) {
      this.place.textContent = "";
      if (s.place) {
        const ln = document.createElement("a");
        ln.href = s.place.url; ln.textContent = s.place.name; ln.target = "_blank"; ln.rel = "noopener";
        this.place.appendChild(document.createTextNode("Frame-0 mesh placed by "));
        this.place.appendChild(ln);
        if (s.tracks) {   // davis4d: the tracker whose 3D tracks drive the completion
          const lt = document.createElement("a");
          lt.href = s.tracks.url; lt.textContent = s.tracks.name; lt.target = "_blank"; lt.rel = "noopener";
          this.place.appendChild(document.createTextNode(" · 3D point tracks by "));
          this.place.appendChild(lt);
        }
      }
      this.place.hidden = !s.place;
    }
    // thumbnails for this strip
    this.track.textContent = "";
    this.thumbs = [];
    for (let k = 0; k < s.n; k++) {
      const im = document.createElement("img");
      im.alt = ""; im.decoding = "async";
      im.style.aspectRatio = s.width + " / " + s.height;
      this.track.appendChild(im);
      this.thumbs.push(im);
    }
    this.on = undefined;
    this.shown = [-1, -1];
    // the previous clip's frame stays on screen (dimmed) until the new clip's frame is decoded
    if (this.imgs[this.front].getAttribute("src")) this.main.classList.add("switching");
    this.main.setAttribute("aria-label", s.label);
    if (this.near) this.load(i);
  };

  Film.prototype.load = function (i) {
    const s = this.strips[i], self = this;
    if (!this.cache[s.id]) {
      this.cache[s.id] = [];
      for (let k = 0; k < s.n; k++) { const im = new Image(); im.decoding = "async"; im.src = this.src(s, k, false); this.cache[s.id].push(im); }
    }
    if (i === this.cur) this.thumbs.forEach(function (im, k) { if (!im.src) im.src = self.src(s, k, true); });
  };

  Film.prototype.tick = function (dt) {
    const r = this.root.getBoundingClientRect();
    const s = this.strips[this.cur], frames = this.cache[s.id];
    if (r.bottom < 0 || r.top > window.innerHeight || !frames) return;
    const top = parseFloat(getComputedStyle(this.stage).top) || 0;
    const target = Math.min(1, Math.max(0, (top - r.top) / Math.max(1, r.height - this.stage.offsetHeight)));
    const p = damp(this.pr, target, dt), n = s.n;
    // the nearest frame, no blending between frames (a blend of two frames doubles every point)
    const u = p * (n - 1), i0 = Math.min(n - 1, Math.round(u));
    // show frame i0 only once it is decoded; until then the frame on screen stays (no blank frame)
    if (this.shown[0] !== i0) {
      const im = frames[i0];
      if (im.complete && im.naturalWidth > 0) {
        const self = this, back = this.imgs[1 - this.front], key = im.src;
        this.shown[0] = i0;
        if (back.dataset.k !== key) {
          back.dataset.k = key; back.src = key;
          const show = function () {
            if (back.dataset.k !== key || back.classList.contains("front")) return;
            back.classList.add("front"); self.imgs[self.front].classList.remove("front");
            self.front = 1 - self.front; self.main.classList.remove("switching");
          };
          (back.decode ? back.decode() : Promise.resolve()).then(show, show);
        }
      }
    }
    // the strip: as wide as its frames (centred) when they fit, otherwise it slides with frame u at
    // the centre but never past either end (no empty rail beside the first or last frame)
    const t0 = this.thumbs[0], gap = 6, step = t0.offsetWidth + gap, n1 = this.thumbs.length;
    const trackW = n1 * step - gap, strip = this.track.parentElement;
    const room = this.stage.clientWidth - parseFloat(getComputedStyle(this.stage).paddingLeft) - parseFloat(getComputedStyle(this.stage).paddingRight);
    let tx;
    if (trackW + 24 <= room) {
      strip.style.width = (trackW + 24) + "px";
      tx = 12;
    } else {
      strip.style.width = "";
      const W = strip.clientWidth;
      tx = Math.min(12, Math.max(W - 12 - trackW, W / 2 - (u * step + t0.offsetWidth / 2)));
    }
    this.track.style.transform = "translateX(" + tx.toFixed(1) + "px)";
    const on = Math.round(u);
    if (this.on !== on) {
      if (this.on !== undefined && this.thumbs[this.on]) this.thumbs[this.on].classList.remove("on");
      this.thumbs[on].classList.add("on");
      this.on = on;
    }
    this.p = p;
  };

  window.Film = Film;
})();
