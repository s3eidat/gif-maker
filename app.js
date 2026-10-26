/* GIF Maker — frames are drawn with <canvas> and encoded by our own GIF89a encoder (gif.js). Nothing is uploaded. */
(function () {
  "use strict";
  const $ = S3.$, $$ = S3.$$, G = window.GifKit;
  const MAX_SRC = 1280, MAX_FRAMES = 400;
  const saved = S3.store("gifmaker") || {};
  const opt = Object.assign({ width: 480, loop: "0", fit: "contain", bg: "#ffffff", reverse: false, boomerang: false, dither: true, quant: "median", colors: "256", palMode: "shared", delay: 100 }, saved);
  let frames = [], nextId = 1, building = 0, outBlob = null, outUrl = null;

  function canvas(w, h) { const c = document.createElement("canvas"); c.width = Math.max(1, w); c.height = Math.max(1, h); return c; }
  function saveOpts() { S3.store("gifmaker", opt); }
  const tick = () => new Promise(r => setTimeout(r, 0));

  // ---------- frames ----------
  function capCanvas(src, w, h) {
    const k = Math.min(1, MAX_SRC / Math.max(w, h)), c = canvas(Math.round(w * k), Math.round(h * k)), x = c.getContext("2d");
    x.imageSmoothingQuality = "high"; x.drawImage(src, 0, 0, c.width, c.height);
    return c;
  }
  function addFrame(c, name, delay) {
    if (frames.length >= MAX_FRAMES) return false;
    const f = { id: nextId++, c, name, delay: delay || opt.delay };
    frames.push(f);
    return f;
  }
  function loadImage(file) {
    const url = URL.createObjectURL(file), img = new Image();
    img.src = url;
    return img.decode().then(() => { const c = capCanvas(img, img.naturalWidth, img.naturalHeight); URL.revokeObjectURL(url); return c; })
      .catch(() => { URL.revokeObjectURL(url); throw new Error(file.name + ": can't read this image"); });
  }
  async function addImages(files) {
    files = files.slice().sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
    const firstAdd = !frames.length;
    let added = 0;
    for (const f of files) {
      try { const c = await loadImage(f); if (!addFrame(c, f.name)) { S3.toast("Up to " + MAX_FRAMES + " frames", "error"); break; } added++; }
      catch (e) { S3.toast(e.message, "error"); }
    }
    if (added && firstAdd) { opt.palMode = "frame"; pressSeg($("#palMode"), "frame"); suggestWidth(); }
    renderFrames();
  }
  function suggestWidth() {
    if (!frames.length) return;
    const w = Math.min(480, frames[0].c.width);
    opt.width = w; $("#width").value = w;
  }

  const list = $("#frames");
  function renderFrames() {
    list.innerHTML = "";
    frames.forEach((f, i) => {
      const th = canvas(1, 1), k = Math.min(112 / f.c.width, 84 / f.c.height);
      th.width = Math.max(1, Math.round(f.c.width * k)); th.height = Math.max(1, Math.round(f.c.height * k));
      th.getContext("2d").drawImage(f.c, 0, 0, th.width, th.height);
      th.className = "gm-thumb";
      const li = S3.h("li", { "class": "gm-frame", draggable: "true", "data-id": f.id }, [
        S3.h("div", { "class": "gm-thumbbox checker" }, [th, S3.h("span", { "class": "gm-num", text: String(i + 1) })]),
        S3.h("label", { "class": "gm-delay", title: "Delay for this frame" }, [
          S3.h("input", { "class": "input", type: "number", min: "20", max: "10000", step: "10", value: String(f.delay), "aria-label": "Delay of frame " + (i + 1) + " in milliseconds", "data-delay": "1" }),
          S3.h("span", { text: "ms" })
        ]),
        S3.h("div", { "class": "gm-acts" }, [
          S3.h("button", { "class": "btn ghost small icon", "data-act": "left", "aria-label": "Move frame " + (i + 1) + " earlier", text: "◀", disabled: i === 0 }),
          S3.h("button", { "class": "btn ghost small icon", "data-act": "right", "aria-label": "Move frame " + (i + 1) + " later", text: "▶", disabled: i === frames.length - 1 }),
          S3.h("button", { "class": "btn ghost small icon", "data-act": "rm", "aria-label": "Remove frame " + (i + 1), html: '<svg class="i"><use href="#i-x"/></svg>' })
        ])
      ]);
      list.appendChild(li);
    });
    $("#framesEmpty").hidden = frames.length > 0;
    $("#clearFrames").disabled = !frames.length;
    $("#make").disabled = !frames.length || !!building;
    const total = frames.reduce((s, f) => s + f.delay, 0);
    $("#fcount").textContent = frames.length ? frames.length + " · " + (total / 1000).toFixed(2) + " s" : "";
    estimate();
  }
  function frameOf(el) { const li = el.closest(".gm-frame"); return li && frames.filter(f => f.id === +li.dataset.id)[0]; }
  list.addEventListener("click", e => {
    const b = e.target.closest("[data-act]"); if (!b) return;
    const f = frameOf(b), i = frames.indexOf(f); if (i < 0) return;
    if (b.dataset.act === "rm") frames.splice(i, 1);
    else { const j = b.dataset.act === "left" ? i - 1 : i + 1; if (j < 0 || j >= frames.length) return; frames.splice(i, 1); frames.splice(j, 0, f); }
    renderFrames();
    const again = list.querySelector('[data-id="' + f.id + '"] [data-act="' + b.dataset.act + '"]'); if (again && !again.disabled) again.focus();
  });
  list.addEventListener("change", e => {
    if (!e.target.dataset.delay) return;
    const f = frameOf(e.target); if (!f) return;
    f.delay = Math.max(20, Math.min(10000, Math.round(+e.target.value || 100)));
    e.target.value = f.delay; renderFrames();
  });
  let dragId = null;
  list.addEventListener("dragstart", e => { const li = e.target.closest(".gm-frame"); if (!li) return; dragId = +li.dataset.id; li.classList.add("is-drag"); e.dataTransfer.effectAllowed = "move"; e.dataTransfer.setData("text/plain", String(dragId)); });
  list.addEventListener("dragend", () => { dragId = null; $$(".gm-frame", list).forEach(x => x.classList.remove("is-drag", "is-over")); });
  list.addEventListener("dragover", e => { if (dragId == null) return; e.preventDefault(); const li = e.target.closest(".gm-frame"); $$(".gm-frame", list).forEach(x => x.classList.toggle("is-over", x === li)); });
  list.addEventListener("drop", e => {
    if (dragId == null) return; e.preventDefault();
    const li = e.target.closest(".gm-frame"); if (!li) return;
    const from = frames.findIndex(f => f.id === dragId), to = frames.findIndex(f => f.id === +li.dataset.id);
    if (from < 0 || to < 0 || from === to) return;
    const [f] = frames.splice(from, 1); frames.splice(to, 0, f); renderFrames();
  });

  // ---------- video ----------
  const video = $("#video");
  let videoUrl = null;
  function useVideo(file) {
    if (videoUrl) URL.revokeObjectURL(videoUrl);
    videoUrl = URL.createObjectURL(file); video.src = videoUrl;
    video.onloadedmetadata = async () => {
      // Browser-recorded WebM often has no duration in its header: seek far ahead once so the browser works it out.
      if (!isFinite(video.duration)) {
        await new Promise(res => { const t = setTimeout(res, 4000); video.addEventListener("durationchange", function f() { if (isFinite(video.duration)) { clearTimeout(t); video.removeEventListener("durationchange", f); res(); } }); video.currentTime = 1e7; });
        video.currentTime = 0;
      }
      if (!isFinite(video.duration)) { S3.toast("This video doesn't report its length; try another file", "error"); return; }
      $("#videoCtl").hidden = false;
      const d = video.duration || 0;
      $("#vStart").value = 0; $("#vEnd").value = Math.min(d, 3).toFixed(1); $("#vStart").max = $("#vEnd").max = d.toFixed(2);
      vInfo();
    };
    video.onerror = () => S3.toast("Your browser can't play this video format", "error");
  }
  function vRange() {
    const d = video.duration || 0, s = Math.max(0, Math.min(d, +$("#vStart").value || 0)), e = Math.max(s, Math.min(d, +$("#vEnd").value || 0)), fps = +$("#vFps").value;
    return { s, e, fps, n: Math.max(1, Math.floor((e - s) * fps + 1e-6)) };
  }
  function vInfo() {
    const r = vRange();
    $("#vInfo").textContent = video.videoWidth ? video.videoWidth + "×" + video.videoHeight + " · " + (video.duration || 0).toFixed(1) + " s · " + r.n + " frames" + (r.n > MAX_FRAMES ? " (max " + MAX_FRAMES + ")" : "") : "";
  }
  ["#vStart", "#vEnd", "#vFps"].forEach(s => $(s).addEventListener("input", vInfo));
  $("#setStart").addEventListener("click", () => { $("#vStart").value = video.currentTime.toFixed(2); vInfo(); });
  $("#setEnd").addEventListener("click", () => { $("#vEnd").value = video.currentTime.toFixed(2); vInfo(); });
  function seek(t) {
    return new Promise((res, rej) => {
      const done = () => { clear(); res(); }, fail = () => { clear(); rej(new Error("Seeking failed")); };
      const timer = setTimeout(done, 3000);
      function clear() { clearTimeout(timer); video.removeEventListener("seeked", done); video.removeEventListener("error", fail); }
      video.addEventListener("seeked", done); video.addEventListener("error", fail);
      video.currentTime = t;
    });
  }
  $("#extract").addEventListener("click", async () => {
    if (!video.videoWidth) return;
    const r = vRange(), n = Math.min(r.n, MAX_FRAMES), delay = Math.round(1000 / r.fps), btn = $("#extract");
    btn.disabled = true; video.pause();
    frames = []; renderFrames();
    try {
      for (let i = 0; i < n; i++) {
        btn.textContent = "Extracting " + (i + 1) + " / " + n + "…";
        await seek(r.s + i / r.fps);
        addFrame(capCanvas(video, video.videoWidth, video.videoHeight), "t=" + (r.s + i / r.fps).toFixed(2) + "s", delay);
      }
      opt.palMode = "shared"; pressSeg($("#palMode"), "shared"); suggestWidth(); saveOpts();
      S3.toast(n + " frames extracted");
    } catch (e) { S3.toast(e.message, "error"); }
    btn.disabled = false; btn.innerHTML = '<svg class="i"><use href="#i-grid"/></svg>Extract frames';
    renderFrames();
  });

  // ---------- GIF building ----------
  function outSize() {
    const f = frames[0]; if (!f) return { w: 0, h: 0 };
    const w = Math.max(16, Math.min(1600, Math.round(+opt.width || 480)));
    return { w, h: Math.max(1, Math.round(w * f.c.height / f.c.width)) };
  }
  function sequence() {
    let seq = frames.slice();
    if (opt.reverse) seq.reverse();
    // boomerang: play forwards then backwards, without repeating the two end frames (2 frames already ping-pong)
    if (opt.boomerang && seq.length > 2) seq = seq.concat(seq.slice(1, -1).reverse());
    return seq;
  }
  function renderFrame(f, w, h, fit, bg) {
    const c = canvas(w, h), x = c.getContext("2d");
    x.fillStyle = bg; x.fillRect(0, 0, w, h);
    const k = fit === "cover" ? Math.max(w / f.c.width, h / f.c.height) : Math.min(w / f.c.width, h / f.c.height);
    const dw = f.c.width * k, dh = f.c.height * k;
    x.imageSmoothingQuality = "high"; x.drawImage(f.c, (w - dw) / 2, (h - dh) / 2, dw, dh);
    return x.getImageData(0, 0, w, h).data;
  }
  // Size estimate: really encode one frame from the middle with the current settings, times the frame count.
  let estRun = 0;
  const estimate = S3.debounce(async function () {
    const s = outSize(), seq = sequence(), n = seq.length, my = ++estRun;
    if (!n) { $("#estimate").textContent = ""; return; }
    try {
      const one = await buildGif([seq[Math.floor(n / 2)]], Object.assign({}, opt, { w: s.w, h: s.h, palMode: "frame", loop: 0 }));
      if (my !== estRun) return;
      const hdr = 50, perFrame = Math.max(0, one.size - hdr);
      $("#estimate").textContent = "≈ " + S3.fmtBytes(hdr + perFrame * n) + " estimated";
    } catch (e) { $("#estimate").textContent = ""; }
  }, 300);
  // Pure build used by the UI and the self-test. seq: [{c: canvas, delay}], o: options. Returns Blob.
  async function buildGif(seq, o, onProgress, token) {
    const w = o.w, h = o.h, max = +o.colors, quant = o.quant === "octree" ? G.octree : G.medianCut;
    let gpal = null;
    if (o.palMode === "shared") {
      const hist = new G.Histogram(), step = Math.max(1, Math.floor(seq.length * w * h / 4e6));
      for (let i = 0; i < seq.length; i++) {
        hist.add(renderFrame(seq[i], w, h, o.fit, o.bg), step);
        if (onProgress && i % 8 === 0) { onProgress(i / seq.length * 0.15, "Building palette…"); await tick(); if (token && token !== building) throw new Error("cancelled"); }
      }
      gpal = quant(hist, max);
    }
    const enc = new G.Encoder({ width: w, height: h, loop: +o.loop, globalPalette: gpal });
    for (let i = 0; i < seq.length; i++) {
      const px = renderFrame(seq[i], w, h, o.fit, o.bg);
      const pal = gpal || quant(new G.Histogram().add(px, 1), max);
      enc.addFrame(G.mapPixels(px, w, h, pal, o.dither), gpal ? null : pal, seq[i].delay);
      if (onProgress) { onProgress((gpal ? 0.15 : 0) + (i + 1) / seq.length * (gpal ? 0.85 : 1), "Frame " + (i + 1) + " / " + seq.length); await tick(); if (token && token !== building) throw new Error("cancelled"); }
    }
    return new Blob(enc.finish(), { type: "image/gif" });
  }

  $("#make").addEventListener("click", async () => {
    if (!frames.length || building) return;
    const token = building = Date.now();
    const s = outSize(), seq = sequence();
    $("#make").disabled = true; $("#cancel").hidden = false; $("#prog").hidden = false;
    const t0 = performance.now();
    try {
      const blob = await buildGif(seq, Object.assign({}, opt, { w: s.w, h: s.h }), (p, msg) => { $("#progBar").style.width = Math.round(p * 100) + "%"; $("#progText").textContent = msg; }, token);
      if (token !== building) return;
      showOut(blob, s, seq, performance.now() - t0);
      S3.done();
    } catch (e) {
      if (e.message !== "cancelled") S3.toast("Could not make the GIF: " + e.message, "error");
      $("#progText").textContent = e.message === "cancelled" ? "Cancelled" : "";
    } finally {
      if (token === building) building = 0;
      $("#make").disabled = !frames.length; $("#cancel").hidden = true; $("#prog").hidden = true;
    }
  });
  $("#cancel").addEventListener("click", () => { building = 0; });
  function showOut(blob, s, seq, ms) {
    outBlob = blob;
    if (outUrl) URL.revokeObjectURL(outUrl);
    outUrl = URL.createObjectURL(blob);
    $("#out").src = outUrl; $("#outFig").hidden = false; $("#download").hidden = false; $("#outStats").hidden = false;
    const dur = seq.reduce((a, f) => a + Math.max(20, Math.round(f.delay / 10) * 10), 0);
    $("#outStats").innerHTML = [["size", S3.fmtBytes(blob.size)], ["pixels", s.w + "×" + s.h], ["frames", seq.length], ["seconds", (dur / 1000).toFixed(2)]]
      .map(a => '<div class="stat"><b>' + S3.esc(a[1]) + "</b><span>" + a[0] + "</span></div>").join("");
    $("#progText").textContent = "Done in " + (ms / 1000).toFixed(1) + " s";
  }
  $("#download").addEventListener("click", () => { if (outBlob) { S3.download(outBlob, "animation.gif"); S3.done(); } });

  // ---------- controls ----------
  function pressSeg(el, v) { $$("button", el).forEach(x => x.setAttribute("aria-pressed", String(x.dataset.v === v))); }
  function seg(el, key, after) {
    pressSeg(el, opt[key]);
    $$("button", el).forEach(b => b.addEventListener("click", () => { opt[key] = b.dataset.v; pressSeg(el, b.dataset.v); saveOpts(); estimate(); if (after) after(b.dataset.v); }));
  }
  seg($("#srcMode"), "src", v => { $("#dropImages").hidden = v !== "images"; $("#videoPane").hidden = v !== "video"; });
  opt.src = opt.src === "video" ? "video" : "images"; pressSeg($("#srcMode"), opt.src);
  $("#dropImages").hidden = opt.src !== "images"; $("#videoPane").hidden = opt.src !== "video";
  seg($("#fit"), "fit"); seg($("#quant"), "quant"); seg($("#palMode"), "palMode");
  [["#width", "width", "input"], ["#loop", "loop", "change"], ["#bg", "bg", "input"], ["#colors", "colors", "change"]].forEach(([s, k, ev]) => {
    const el = $(s); el.value = opt[k];
    el.addEventListener(ev, () => { opt[k] = el.value; saveOpts(); estimate(); });
  });
  ["reverse", "boomerang", "dither"].forEach(k => { const el = $("#" + k); el.checked = !!opt[k]; el.addEventListener("change", () => { opt[k] = el.checked; saveOpts(); estimate(); }); });
  $("#allDelay").value = opt.delay;
  $("#applyDelay").addEventListener("click", () => {
    const d = Math.max(20, Math.min(10000, Math.round(+$("#allDelay").value || 100)));
    opt.delay = d; saveOpts(); frames.forEach(f => { f.delay = d; }); renderFrames();
  });
  $("#clearFrames").addEventListener("click", () => { frames = []; renderFrames(); });
  S3.drop($("#dropImages"), addImages, { accept: "image/*", multiple: true });
  S3.drop($("#dropVideo"), fs => useVideo(fs[0]), { accept: "video/*,.mp4,.webm,.mov,.m4v,.ogv", multiple: false });
  document.addEventListener("paste", e => {
    const fs = Array.prototype.slice.call((e.clipboardData && e.clipboardData.files) || []).filter(f => /^image\//.test(f.type));
    if (fs.length) { e.preventDefault(); addImages(fs); }
  });
  renderFrames();

  // ---------- demo frames (drawn locally) ----------
  function demoFrame(i, n) {
    const W = 480, H = 300, c = canvas(W, H), x = c.getContext("2d"), t = i / n;
    const sky = x.createLinearGradient(0, 0, 0, H);
    sky.addColorStop(0, "#14204f"); sky.addColorStop(0.55, "#d85c7f"); sky.addColorStop(1, "#ffb56b");
    x.fillStyle = sky; x.fillRect(0, 0, W, H);
    const sunY = H * 0.35 + Math.sin(t * Math.PI * 2) * 40;
    x.fillStyle = "#ffe3a1"; x.beginPath(); x.arc(W * 0.5 + Math.cos(t * Math.PI * 2) * 120, sunY, 36, 0, Math.PI * 2); x.fill();
    x.fillStyle = "#2a2049"; x.beginPath(); x.moveTo(0, H);
    for (let k = 0; k <= 48; k++) x.lineTo(W * k / 48, H * 0.78 - Math.abs(Math.sin(k / 48 * 7 + t * Math.PI * 2)) * 34);
    x.lineTo(W, H); x.fill();
    x.fillStyle = "#151231"; x.fillRect(0, H * 0.9, W, H * 0.1);
    return c;
  }
  window.S3_DEMO = async function () {
    frames = [];
    for (let i = 0; i < 12; i++) addFrame(demoFrame(i, 12), "frame-" + (i + 1) + ".png", 90);
    opt.palMode = "shared"; pressSeg($("#palMode"), "shared"); opt.width = 360; $("#width").value = 360;
    renderFrames();
    $("#make").click();
    for (let i = 0; i < 100 && building; i++) await new Promise(r => setTimeout(r, 50));
  };

  // Self-test run by scripts/smoke.py: encode, parse our own bytes, decode LZW, and let the browser decode it too.
  window.S3_SELFTEST = async function () {
    const W = 40, H = 30;
    function solid(cols) { // cols: [left colour, right colour]
      const c = canvas(W, H), x = c.getContext("2d");
      x.fillStyle = cols[0]; x.fillRect(0, 0, W / 2, H); x.fillStyle = cols[1]; x.fillRect(W / 2, 0, W / 2, H);
      return { c, delay: 0 };
    }
    const spec = [["#ff0000", "#0000ff"], ["#00ff00", "#ffff00"], ["#ffffff", "#000000"]], delays = [100, 250, 500];
    const seq = spec.map((s, i) => Object.assign(solid(s), { delay: delays[i] }));
    const rgb = h => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
    async function check(o) {
      const blob = await buildGif(seq, Object.assign({ w: W, h: H, loop: 0, fit: "contain", bg: "#ffffff", colors: 256, dither: false }, o));
      const bytes = new Uint8Array(await blob.arrayBuffer()), g = G.parse(bytes);
      // header, frame count, loop and delays
      const head = g.sig === "GIF89a" && g.w === W && g.h === H && g.ended && g.frames.length === 3 && g.loop === 0 && g.frames.every((f, i) => f.delay === delays[i]);
      // every frame decodes (our LZW reader) to the exact two colours
      const pix = g.frames.every((f, i) => {
        const d = G.lzwDecode(f.minCode, f.data, W * H); if (d.filled !== W * H) return false;
        const L = f.pal[d.pixels[5 * W + 3]], R = f.pal[d.pixels[20 * W + 35]], el = rgb(spec[i][0]), er = rgb(spec[i][1]);
        return L.join() === el.join() && R.join() === er.join();
      });
      // and the browser itself decodes the first frame to the same colours
      const url = URL.createObjectURL(blob), img = new Image(); img.src = url; await img.decode();
      const c = canvas(W, H), x = c.getContext("2d"); x.drawImage(img, 0, 0); URL.revokeObjectURL(url);
      const a = x.getImageData(5, 10, 1, 1).data, b = x.getImageData(35, 10, 1, 1).data;
      const browser = img.naturalWidth === W && a[0] === 255 && a[1] === 0 && a[2] === 0 && b[0] === 0 && b[1] === 0 && b[2] === 255;
      return { ok: head && pix && browser, head, pix, browser, size: bytes.length };
    }
    const r1 = await check({ quant: "median", palMode: "shared" });
    const r2 = await check({ quant: "octree", palMode: "frame" });
    // LZW stress: a noisy 200x150 frame round-trips exactly (exercises code-size growth and table resets)
    const N = 200 * 150, idx = new Uint8Array(N); let s = 7;
    for (let i = 0; i < N; i++) { s = (s * 1103515245 + 12345) & 0x7fffffff; idx[i] = (s >> 8) % 7 === 0 ? (s >> 16) & 255 : (i >> 6) & 255; }
    const pal = []; for (let i = 0; i < 256; i++) pal.push([i, 255 - i, (i * 7) & 255]);
    const enc = new G.Encoder({ width: 200, height: 150, loop: -1, globalPalette: null }); enc.addFrame(idx, pal, 40);
    const p3 = G.parse(new Uint8Array(await new Blob(enc.finish()).arrayBuffer())), d3 = G.lzwDecode(p3.frames[0].minCode, p3.frames[0].data, N);
    let same = d3.filled === N; for (let i = 0; same && i < N; i++) if (d3.pixels[i] !== idx[i]) same = false;
    const r3 = same && p3.loop === null && p3.frames.length === 1;
    // dithering keeps the average colour of a flat mid-grey with a 2-colour palette
    const grey = new Uint8ClampedArray(64 * 64 * 4).fill(128), m = G.mapPixels(grey, 64, 64, [[0, 0, 0], [255, 255, 255]], true);
    const whites = m.reduce((a, v) => a + v, 0), r4 = Math.abs(whites / (64 * 64) - 128 / 255) < 0.03;
    return (r1.ok && r2.ok && r3 && r4) || { r1, r2, r3, r4, whites };
  };
})();
