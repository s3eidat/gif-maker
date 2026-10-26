/* GIF89a encoder for GIF Maker: palette quantisation (median cut / octree), Floyd–Steinberg dithering, LZW.
   Written for S3eidat Tools. Pure functions on RGBA arrays; no DOM, no network. Exposed as window.GifKit. */
(function () {
  "use strict";

  // ---------- colour histogram (5 bits per channel) with exact 8-bit sums ----------
  function Histogram() {
    this.count = new Uint32Array(32768);
    this.r = new Float64Array(32768); this.g = new Float64Array(32768); this.b = new Float64Array(32768);
  }
  Histogram.prototype.add = function (rgba, step) {
    const c = this.count, R = this.r, G = this.g, B = this.b, s = (step || 1) * 4;
    for (let i = 0; i < rgba.length; i += s) {
      const r = rgba[i], g = rgba[i + 1], b = rgba[i + 2], k = (r >> 3) << 10 | (g >> 3) << 5 | (b >> 3);
      c[k]++; R[k] += r; G[k] += g; B[k] += b;
    }
    return this;
  };
  Histogram.prototype.bins = function () {
    const out = [];
    for (let k = 0; k < 32768; k++) if (this.count[k]) out.push({ k, n: this.count[k], r: this.r[k], g: this.g[k], b: this.b[k], q: [k >> 10, (k >> 5) & 31, k & 31] });
    return out;
  };
  function mean(list) {
    let n = 0, r = 0, g = 0, b = 0;
    list.forEach(e => { n += e.n; r += e.r; g += e.g; b += e.b; });
    return [Math.round(r / n), Math.round(g / n), Math.round(b / n)];
  }

  // ---------- median cut ----------
  function medianCut(hist, maxColors) {
    const bins = hist.bins();
    if (!bins.length) return [[0, 0, 0]];
    if (bins.length <= maxColors) return bins.map(e => mean([e]));
    function box(list) {
      const lo = [31, 31, 31], hi = [0, 0, 0]; let n = 0;
      list.forEach(e => { for (let c = 0; c < 3; c++) { if (e.q[c] < lo[c]) lo[c] = e.q[c]; if (e.q[c] > hi[c]) hi[c] = e.q[c]; } n += e.n; });
      const rng = [hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]], axis = rng.indexOf(Math.max.apply(null, rng));
      return { list, n, axis, range: rng[axis] };
    }
    const boxes = [box(bins)];
    while (boxes.length < maxColors) {
      let best = -1, score = -1;
      boxes.forEach((b, i) => { if (b.list.length > 1 && b.range > 0) { const s = b.n * b.range; if (s > score) { score = s; best = i; } } });
      if (best < 0) break;
      const b = boxes[best], ax = b.axis;
      b.list.sort((u, v) => u.q[ax] - v.q[ax]);
      let half = b.n / 2, acc = 0, cut = 1;
      for (let i = 0; i < b.list.length - 1; i++) { acc += b.list[i].n; if (acc >= half) { cut = i + 1; break; } cut = i + 1; }
      boxes.splice(best, 1, box(b.list.slice(0, cut)), box(b.list.slice(cut)));
    }
    return boxes.map(b => mean(b.list));
  }

  // ---------- octree ----------
  function octree(hist, maxColors) {
    const bins = hist.bins();
    if (!bins.length) return [[0, 0, 0]];
    if (bins.length <= maxColors) return bins.map(e => mean([e]));
    const levels = [[], [], [], [], [], [], [], []];
    let leaves = 0;
    function node(level) { const n = { kids: null, leaf: level === 8, n: 0, r: 0, g: 0, b: 0, level }; if (!n.leaf && level > 0) levels[level].push(n); return n; }
    const root = node(0);
    bins.forEach(e => {
      const c = mean([e]);
      let cur = root;
      for (let lv = 0; lv < 8; lv++) {
        if (cur.leaf) break;
        const bit = 7 - lv, i = ((c[0] >> bit) & 1) << 2 | ((c[1] >> bit) & 1) << 1 | ((c[2] >> bit) & 1);
        if (!cur.kids) cur.kids = new Array(8);
        if (!cur.kids[i]) { cur.kids[i] = node(lv + 1); if (cur.kids[i].leaf) leaves++; }
        cur = cur.kids[i];
      }
      cur.n += e.n; cur.r += e.r; cur.g += e.g; cur.b += e.b;
    });
    // merge the least-used deepest nodes until the leaf count fits
    for (let lv = 7; lv > 0 && leaves > maxColors; lv--) {
      const list = levels[lv].sort((a, b) => sum(a) - sum(b));
      for (let j = 0; j < list.length && leaves > maxColors; j++) {
        const nd = list[j]; if (nd.leaf || !nd.kids) continue;
        let kids = 0;
        nd.kids.forEach(k => { if (k) { nd.n += k.n; nd.r += k.r; nd.g += k.g; nd.b += k.b; kids++; } });
        nd.kids = null; nd.leaf = true; leaves -= kids - 1;
      }
    }
    function sum(nd) { if (nd.leaf || !nd.kids) return nd.n; let s = 0; nd.kids.forEach(k => { if (k) s += sum(k); }); nd._s = s; return s; }
    const pal = [];
    (function walk(nd) { if (nd.leaf || !nd.kids) { if (nd.n) pal.push([Math.round(nd.r / nd.n), Math.round(nd.g / nd.n), Math.round(nd.b / nd.n)]); return; } nd.kids.forEach(k => { if (k) walk(k); }); })(root);
    return pal.slice(0, maxColors);
  }

  // ---------- map pixels to palette (optionally Floyd–Steinberg) ----------
  function makeLookup(pal) {
    const cache = new Int16Array(1 << 18).fill(-1), n = pal.length, P = pal;
    return function (r, g, b) {
      const key = (r >> 2) << 12 | (g >> 2) << 6 | (b >> 2);
      let v = cache[key];
      if (v >= 0) return v;
      let best = 0, bd = Infinity;
      for (let i = 0; i < n; i++) {
        const p = P[i], dr = p[0] - r, dg = p[1] - g, db = p[2] - b, d = 2 * dr * dr + 4 * dg * dg + 3 * db * db;
        if (d < bd) { bd = d; best = i; if (!d) break; }
      }
      cache[key] = best;
      return best;
    };
  }
  function mapPixels(rgba, w, h, pal, dither) {
    const out = new Uint8Array(w * h), find = makeLookup(pal);
    if (!dither) {
      for (let i = 0, j = 0; j < out.length; i += 4, j++) out[j] = find(rgba[i], rgba[i + 1], rgba[i + 2]);
      return out;
    }
    let cur = new Float32Array((w + 2) * 3), nxt = new Float32Array((w + 2) * 3);
    for (let y = 0; y < h; y++) {
      const ltr = (y & 1) === 0, dir = ltr ? 1 : -1;
      nxt.fill(0);
      for (let s = 0; s < w; s++) {
        const x = ltr ? s : w - 1 - s, i = (y * w + x) * 4, e = (x + 1) * 3;
        const r = clamp(rgba[i] + cur[e]), g = clamp(rgba[i + 1] + cur[e + 1]), b = clamp(rgba[i + 2] + cur[e + 2]);
        const idx = find(r, g, b), p = pal[idx];
        out[y * w + x] = idx;
        const er = r - p[0], eg = g - p[1], eb = b - p[2];
        const f = (x + 1 + dir) * 3, bk = (x + 1 - dir) * 3;
        cur[f] += er * 7 / 16; cur[f + 1] += eg * 7 / 16; cur[f + 2] += eb * 7 / 16;
        nxt[bk] += er * 3 / 16; nxt[bk + 1] += eg * 3 / 16; nxt[bk + 2] += eb * 3 / 16;
        nxt[e] += er * 5 / 16; nxt[e + 1] += eg * 5 / 16; nxt[e + 2] += eb * 5 / 16;
        nxt[f] += er / 16; nxt[f + 1] += eg / 16; nxt[f + 2] += eb / 16;
      }
      const t = cur; cur = nxt; nxt = t;
    }
    return out;
  }
  function clamp(v) { return v < 0 ? 0 : v > 255 ? 255 : Math.round(v); }

  // ---------- byte writer + LZW ----------
  function Bytes() { this.chunks = []; this.buf = new Uint8Array(65536); this.pos = 0; this.size = 0; }
  Bytes.prototype.byte = function (b) {
    if (this.pos === this.buf.length) { this.chunks.push(this.buf); this.buf = new Uint8Array(65536); this.pos = 0; }
    this.buf[this.pos++] = b; this.size++;
  };
  Bytes.prototype.bytes = function (arr) { for (let i = 0; i < arr.length; i++) this.byte(arr[i]); };
  Bytes.prototype.u16 = function (v) { this.byte(v & 255); this.byte((v >> 8) & 255); };
  Bytes.prototype.str = function (s) { for (let i = 0; i < s.length; i++) this.byte(s.charCodeAt(i)); };
  Bytes.prototype.parts = function () { return this.chunks.concat([this.buf.subarray(0, this.pos)]); };

  function lzw(out, indices, minCode) {
    const clear = 1 << minCode, eoi = clear + 1;
    let size = minCode + 1, next = eoi + 1, dict = new Map(), acc = 0, nbits = 0;
    const block = new Uint8Array(255); let bl = 0;
    function put(b) { block[bl++] = b; if (bl === 255) { out.byte(255); out.bytes(block); bl = 0; } }
    function emit(code) { acc |= code << nbits; nbits += size; while (nbits >= 8) { put(acc & 255); acc >>>= 8; nbits -= 8; } }
    out.byte(minCode);
    emit(clear);
    let prefix = indices[0];
    for (let i = 1; i < indices.length; i++) {
      const k = indices[i], key = prefix << 8 | k, v = dict.get(key);
      if (v !== undefined) { prefix = v; continue; }
      emit(prefix);
      if (next === 4096) { emit(clear); dict = new Map(); next = eoi + 1; size = minCode + 1; }
      else { if (next >= 1 << size) size++; dict.set(key, next++); }
      prefix = k;
    }
    emit(prefix); emit(eoi);
    if (nbits > 0) put(acc & 255);
    if (bl) { out.byte(bl); out.bytes(block.subarray(0, bl)); }
    out.byte(0);
  }

  function palBits(n) { let b = 1; while ((1 << b) < n) b++; return b; }
  function writePalette(out, pal, bits) { for (let i = 0; i < 1 << bits; i++) { const p = pal[i] || [0, 0, 0]; out.byte(p[0]); out.byte(p[1]); out.byte(p[2]); } }

  /* Streaming encoder.
     opts: {width, height, loop: 0 = forever | -1 = play once | n = repeat n extra times, globalPalette: [[r,g,b]...] | null} */
  function Encoder(opts) {
    this.w = opts.width; this.h = opts.height; this.out = new Bytes(); this.frames = 0;
    this.gpal = opts.globalPalette || null;
    const o = this.out;
    o.str("GIF89a"); o.u16(this.w); o.u16(this.h);
    if (this.gpal) { this.gbits = palBits(this.gpal.length); o.byte(0x80 | 0x70 | (this.gbits - 1)); } else o.byte(0x70);
    o.byte(0); o.byte(0);
    if (this.gpal) writePalette(o, this.gpal, this.gbits);
    if (opts.loop !== -1) { o.byte(0x21); o.byte(0xFF); o.byte(11); o.str("NETSCAPE2.0"); o.byte(3); o.byte(1); o.u16(Math.max(0, Math.min(65535, opts.loop | 0))); o.byte(0); }
  }
  // indices: Uint8Array(w*h); pal: local palette or null to use the global one; delayMs
  Encoder.prototype.addFrame = function (indices, pal, delayMs) {
    const o = this.out, cs = Math.max(2, Math.round(delayMs / 10));
    o.byte(0x21); o.byte(0xF9); o.byte(4); o.byte(1 << 2); o.u16(cs); o.byte(0); o.byte(0);
    o.byte(0x2C); o.u16(0); o.u16(0); o.u16(this.w); o.u16(this.h);
    let bits;
    if (pal) { bits = palBits(pal.length); o.byte(0x80 | (bits - 1)); writePalette(o, pal, bits); }
    else { bits = this.gbits; o.byte(0); }
    lzw(o, indices, Math.max(2, bits));
    this.frames++;
  };
  Encoder.prototype.finish = function () { this.out.byte(0x3B); return this.out.parts(); };

  // ---------- tiny GIF reader (used by the self-test to check what we wrote) ----------
  function parse(bytes) {
    const b = bytes; let p = 0;
    const sig = String.fromCharCode.apply(null, b.subarray(0, 6)); p = 6;
    const w = b[p] | b[p + 1] << 8, h = b[p + 2] | b[p + 3] << 8, f = b[p + 4]; p += 7;
    let gct = null;
    if (f & 0x80) { const n = 1 << ((f & 7) + 1); gct = []; for (let i = 0; i < n; i++) gct.push([b[p + i * 3], b[p + i * 3 + 1], b[p + i * 3 + 2]]); p += n * 3; }
    const frames = []; let loop = null, delay = 0, ended = false;
    function subBlocks() { const parts = []; while (b[p]) { parts.push(b.subarray(p + 1, p + 1 + b[p])); p += b[p] + 1; } p++; return parts; }
    while (p < b.length) {
      const t = b[p++];
      if (t === 0x21) {
        const label = b[p++];
        if (label === 0xF9) { delay = (b[p + 2] | b[p + 3] << 8) * 10; p += 6; }
        else { const parts = subBlocks(); if (label === 0xFF && parts.length > 1 && String.fromCharCode.apply(null, parts[0]) === "NETSCAPE2.0") loop = parts[1][1] | parts[1][2] << 8; }
      } else if (t === 0x2C) {
        const fw = b[p + 4] | b[p + 5] << 8, fh = b[p + 6] | b[p + 7] << 8, ff = b[p + 8]; p += 9;
        let pal = gct;
        if (ff & 0x80) { const n = 1 << ((ff & 7) + 1); pal = []; for (let i = 0; i < n; i++) pal.push([b[p + i * 3], b[p + i * 3 + 1], b[p + i * 3 + 2]]); p += n * 3; }
        const minCode = b[p++], parts = subBlocks();
        const len = parts.reduce((s, x) => s + x.length, 0), data = new Uint8Array(len); let o = 0;
        parts.forEach(x => { data.set(x, o); o += x.length; });
        frames.push({ w: fw, h: fh, pal, delay, minCode, data });
      } else if (t === 0x3B) { ended = true; break; }
      else break;
    }
    return { sig, w, h, gct, loop, frames, ended };
  }
  function lzwDecode(minCode, data, npix) {
    const clear = 1 << minCode, eoi = clear + 1, out = new Uint8Array(npix);
    let table, size, prev, o = 0, pos = 0, acc = 0, nbits = 0;
    function reset() { table = []; for (let i = 0; i < clear; i++) table.push([i]); table.push(null, null); size = minCode + 1; prev = null; }
    reset();
    for (;;) {
      while (nbits < size && pos < data.length) { acc |= data[pos++] << nbits; nbits += 8; }
      if (nbits < size) break;
      const code = acc & ((1 << size) - 1); acc >>>= size; nbits -= size;
      if (code === clear) { reset(); continue; }
      if (code === eoi) break;
      let entry;
      if (code < table.length && table[code]) entry = table[code];
      else if (code === table.length && prev) entry = prev.concat([prev[0]]);
      else throw new Error("bad LZW code " + code);
      for (let i = 0; i < entry.length && o < npix; i++) out[o++] = entry[i];
      if (prev && table.length < 4096) table.push(prev.concat([entry[0]]));
      prev = entry;
      if (table.length === 1 << size && size < 12) size++;
    }
    return { pixels: out, filled: o };
  }

  window.GifKit = { Histogram, medianCut, octree, mapPixels, Encoder, parse, lzwDecode };
})();
