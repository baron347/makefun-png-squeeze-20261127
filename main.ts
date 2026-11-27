// png-squeeze-01: a lossless PNG encoder that answers every instance of a set
// with the smallest PNG it can find, in one deterministic run.
//
// The entry reads each /input/<id>/image.png (a 1280x720 RGBA screenshot), picks
// the best lossless form for it (palette, grey, grey+alpha, RGB or RGBA, with a
// tRNS key when one transparent value covers every non-opaque pixel), chooses
// each row's PNG filter from a screened set (fixed None/Paeth, fewest-distinct-
// pairs, minimum-sum and, for grey, per-row brute force weighed by zlib), then
// writes the filtered stream with the smallest of several zlib level-9 encodings
// (single stream, or split into 2/4/8/16 row-aligned blocks flushed so every
// block gets fresh Huffman tables while the 32 KiB window is shared).
//
// Everything is decided by measured bytes, never by the clock, so two runs on
// one set write the same bytes. Node 22 built-ins only; no network, no files
// outside /input, /output and /bot.
//
// SPDX-License-Identifier: MIT

import { constants, createDeflateRaw, deflateSync, inflateSync } from 'node:zlib';
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const INPUT = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const OUTPUT = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';
const WIDTH = 1280;
const HEIGHT = 720;

/* ---------------- PNG primitives: CRC-32, Adler-32, chunks ---------------- */

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(bytes, start = 0, end = bytes.length) {
  let c = -1;
  for (let i = start; i < end; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function adler32(bytes) {
  let a = 1, b = 0;
  for (let i = 0; i < bytes.length;) {
    const end = Math.min(bytes.length, i + 5552);
    for (; i < end; i++) { a += bytes[i]; b += a; }
    a %= 65521; b %= 65521;
  }
  return ((b << 16) | a) >>> 0;
}

const ascii = (s) => Uint8Array.from(s, (ch) => ch.charCodeAt(0));

function pngOf(chunks) {
  let size = 8;
  for (const [, data] of chunks) size += 12 + data.length;
  const out = new Uint8Array(size);
  const view = new DataView(out.buffer);
  out.set([137, 80, 78, 71, 13, 10, 26, 10], 0);
  let at = 8;
  for (const [type, data] of chunks) {
    view.setUint32(at, data.length);
    out.set(ascii(type), at + 4);
    out.set(data, at + 8);
    view.setUint32(at + 8 + data.length, crc32(out, at + 4, at + 8 + data.length));
    at += 12 + data.length;
  }
  return out;
}

function ihdrOf(width, height, colourType) {
  const d = new Uint8Array(13);
  new DataView(d.buffer).setUint32(0, width);
  new DataView(d.buffer).setUint32(4, height);
  d[8] = 8;
  d[9] = colourType;
  return d;
}

/* ---------------- PNG decoding: stored input to RGBA ---------------- */

const CHANNELS = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };

function paeth(a, b, c) {
  const p = a + b - c;
  const pa = p > a ? p - a : a - p;
  const pb = p > b ? p - b : b - p;
  const pc = p > c ? p - c : c - p;
  if (pa <= pb && pa <= pc) return a;
  return pb <= pc ? b : c;
}

function decodePng(bytes) {
  if (bytes.length < 8 || bytes[0] !== 137 || bytes[1] !== 80 || bytes[2] !== 78 || bytes[3] !== 71) {
    throw new Error('not a PNG signature');
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let at = 8;
  let header = null, palette = null, trns = null;
  const idat = [];
  let ended = false;
  while (at < bytes.length) {
    if (ended) throw new Error('bytes after IEND');
    const len = view.getUint32(at);
    const type = String.fromCharCode(bytes[at + 4], bytes[at + 5], bytes[at + 6], bytes[at + 7]);
    if (!['IHDR', 'PLTE', 'tRNS', 'IDAT', 'IEND'].includes(type)) throw new Error('unread chunk ' + type);
    if (crc32(bytes, at + 4, at + 8 + len) !== view.getUint32(at + 8 + len)) throw new Error(type + ' CRC');
    const data = bytes.subarray(at + 8, at + 8 + len);
    at += 12 + len;
    if (type === 'IHDR') {
      const dv = new DataView(data.buffer, data.byteOffset, 13);
      header = { width: dv.getUint32(0), height: dv.getUint32(4), depth: data[8], colourType: data[9] };
      if (header.depth !== 8 || !Object.hasOwn(CHANNELS, header.colourType)) throw new Error('unsupported IHDR');
    } else if (type === 'PLTE') palette = data;
    else if (type === 'tRNS') trns = data;
    else if (type === 'IDAT') idat.push(data);
    else ended = true;
  }
  if (!ended || idat.length === 0) throw new Error('truncated PNG');
  const { width, height, colourType } = header;
  const bpp = CHANNELS[colourType];
  const stride = width * bpp;
  const raw = inflateSync(idat.length === 1 ? idat[0] : Buffer.concat(idat));
  if (raw.length !== height * (stride + 1)) throw new Error('IDAT length');
  const samples = new Uint8Array(height * stride);
  for (let y = 0; y < height; y++) {
    const ft = raw[y * (stride + 1)];
    if (ft > 4) throw new Error('bad filter ' + ft);
    const src = y * (stride + 1) + 1;
    const o = y * stride;
    const p = o - stride;
    if (ft === 0) samples.set(raw.subarray(src, src + stride), o);
    else if (ft === 1) for (let i = 0; i < stride; i++) samples[o + i] = raw[src + i] + (i >= bpp ? samples[o + i - bpp] : 0);
    else if (ft === 2) for (let i = 0; i < stride; i++) samples[o + i] = raw[src + i] + (y > 0 ? samples[p + i] : 0);
    else if (ft === 3) for (let i = 0; i < stride; i++) samples[o + i] = raw[src + i] + (((i >= bpp ? samples[o + i - bpp] : 0) + (y > 0 ? samples[p + i] : 0)) >> 1);
    else for (let i = 0; i < stride; i++) {
      const a = i >= bpp ? samples[o + i - bpp] : 0;
      const b = y > 0 ? samples[p + i] : 0;
      const c = y > 0 && i >= bpp ? samples[p + i - bpp] : 0;
      samples[o + i] = raw[src + i] + paeth(a, b, c);
    }
  }
  const n = width * height;
  const rgba = new Uint8Array(n * 4);
  if (colourType === 6) rgba.set(samples);
  else if (colourType === 2) {
    const key = trns === null ? -1 : (trns[1] << 16) | (trns[3] << 8) | trns[5];
    for (let i = 0, s = 0, d = 0; i < n; i++, s += 3, d += 4) {
      rgba[d] = samples[s]; rgba[d + 1] = samples[s + 1]; rgba[d + 2] = samples[s + 2];
      rgba[d + 3] = ((samples[s] << 16) | (samples[s + 1] << 8) | samples[s + 2]) === key ? 0 : 255;
    }
  } else if (colourType === 0) {
    const key = trns === null ? -1 : trns[1];
    for (let i = 0, d = 0; i < n; i++, d += 4) {
      const g = samples[i];
      rgba[d] = rgba[d + 1] = rgba[d + 2] = g;
      rgba[d + 3] = g === key ? 0 : 255;
    }
  } else if (colourType === 4) {
    for (let i = 0, s = 0, d = 0; i < n; i++, s += 2, d += 4) {
      rgba[d] = rgba[d + 1] = rgba[d + 2] = samples[s];
      rgba[d + 3] = samples[s + 1];
    }
  } else {
    const entries = palette.length / 3;
    for (let i = 0, d = 0; i < n; i++, d += 4) {
      const e = samples[i];
      if (e >= entries) throw new Error('palette index out of range');
      rgba[d] = palette[e * 3]; rgba[d + 1] = palette[e * 3 + 1]; rgba[d + 2] = palette[e * 3 + 2];
      rgba[d + 3] = trns !== null && e < trns.length ? trns[e] : 255;
    }
  }
  return { width, height, rgba };
}

/* ---------------- Filtering ---------------- */

function filterRow(type, cur, prev, bpp, out) {
  const n = cur.length;
  if (type === 0) out.set(cur);
  else if (type === 1) for (let i = 0; i < n; i++) out[i] = cur[i] - (i >= bpp ? cur[i - bpp] : 0);
  else if (type === 2) for (let i = 0; i < n; i++) out[i] = cur[i] - (prev === null ? 0 : prev[i]);
  else if (type === 3) for (let i = 0; i < n; i++) out[i] = cur[i] - (((i >= bpp ? cur[i - bpp] : 0) + (prev === null ? 0 : prev[i])) >> 1);
  else for (let i = 0; i < n; i++) {
    const a = i >= bpp ? cur[i - bpp] : 0;
    const b = prev === null ? 0 : prev[i];
    const c = prev !== null && i >= bpp ? prev[i - bpp] : 0;
    out[i] = cur[i] - paeth(a, b, c);
  }
}

function signedSum(row) {
  let s = 0;
  for (let i = 0; i < row.length; i++) {
    const v = row[i];
    s += v < 128 ? v : 256 - v;
  }
  return s;
}

function pairsOf(row, seen, stamp) {
  let n = 0;
  for (let i = 1; i < row.length; i++) {
    const pair = (row[i - 1] << 8) | row[i];
    if (seen[pair] !== stamp) { seen[pair] = stamp; n++; }
  }
  return n;
}

// Filter `samples` (height rows of width*bpp) by `choice`: a fixed filter 0-4,
// or 'minsum' (least signed sum), 'pairs' (fewest distinct byte pairs), or
// 'brute' (each row's five filters weighed by a level-4 zlib run after the
// 32 KiB written before it). Returns the filtered stream (filter byte + row).
function filtered(samples, width, height, bpp, choice) {
  const stride = width * bpp;
  const raw = new Uint8Array(height * (stride + 1));
  const trial = Array.from({ length: 5 }, () => new Uint8Array(stride + 1));
  for (let t = 0; t < 5; t++) trial[t][0] = t;
  const seen = new Uint32Array(65536);
  let stamp = 0;
  for (let y = 0; y < height; y++) {
    const cur = samples.subarray(y * stride, (y + 1) * stride);
    const prev = y === 0 ? null : samples.subarray((y - 1) * stride, y * stride);
    const at = y * (stride + 1);
    if (typeof choice === 'number') {
      raw[at] = choice;
      filterRow(choice, cur, prev, bpp, raw.subarray(at + 1, at + 1 + stride));
      continue;
    }
    const before = raw.subarray(Math.max(0, at - 32768), at);
    let type = 0, best = Infinity;
    for (let t = 0; t < 5; t++) {
      filterRow(t, cur, prev, bpp, trial[t].subarray(1));
      let cost;
      if (choice === 'minsum') cost = signedSum(trial[t].subarray(1));
      else if (choice === 'pairs') cost = pairsOf(trial[t].subarray(1), seen, ++stamp);
      else cost = deflateSync(trial[t], before.length === 0
        ? { level: 4, memLevel: 9 }
        : { level: 4, memLevel: 9, dictionary: before }).length;
      if (cost < best) { best = cost; type = t; }
    }
    raw.set(trial[type], at);
  }
  return raw;
}

/* ---------------- Image analysis and forms ---------------- */

function analyse(rgba) {
  const n = rgba.length >>> 2;
  const u32 = rgba.byteOffset % 4 === 0
    ? new Uint32Array(rgba.buffer, rgba.byteOffset, n)
    : new Uint32Array(rgba.slice().buffer);
  let opaque = true, grey = true;
  const counts = new Map();
  let many = false;
  for (let i = 0, d = 0; i < n; i++, d += 4) {
    if (rgba[d + 3] !== 255) opaque = false;
    if (rgba[d] !== rgba[d + 1] || rgba[d] !== rgba[d + 2]) grey = false;
    if (!many) {
      const c = u32[i];
      const k = counts.get(c);
      if (k === undefined) {
        if (counts.size === 256) many = true;
        else counts.set(c, 1);
      } else counts.set(c, k + 1);
    }
  }
  const colours = many ? null : [...counts.keys()].map((c) => {
    const b = new Uint8Array(Uint32Array.of(c).buffer);
    return { rgba: [b[0], b[1], b[2], b[3]], word: c, count: counts.get(c) };
  });
  return { opaque, grey, colours };
}

// The one fully transparent value (grey or RGB) the image may key by tRNS
// instead of an alpha channel, or null when there is none.
function transparentKey(rgba, grey) {
  let key = -1;
  for (let d = 0; d < rgba.length; d += 4) {
    const a = rgba[d + 3];
    if (a === 255) continue;
    if (a !== 0) return null;
    const v = grey ? rgba[d] : (rgba[d] << 16) | (rgba[d + 1] << 8) | rgba[d + 2];
    if (key === -1) key = v;
    else if (key !== v) return null;
  }
  if (key === -1) return null;
  for (let d = 0; d < rgba.length; d += 4) {
    if (rgba[d + 3] !== 255) continue;
    const v = grey ? rgba[d] : (rgba[d] << 16) | (rgba[d + 1] << 8) | rgba[d + 2];
    if (v === key) return null;
  }
  return key;
}

function samplesOf(rgba, ct) {
  const n = rgba.length >>> 2;
  if (ct === 6) return rgba;
  const ch = ct === 0 ? 1 : ct === 4 ? 2 : 3;
  const out = new Uint8Array(n * ch);
  for (let i = 0, d = 0, s = 0; i < n; i++, d += 4, s += ch) {
    if (ct === 0) out[s] = rgba[d];
    else if (ct === 4) { out[s] = rgba[d]; out[s + 1] = rgba[d + 3]; }
    else { out[s] = rgba[d]; out[s + 1] = rgba[d + 1]; out[s + 2] = rgba[d + 2]; }
  }
  return out;
}

// Morton (Z-order) code of an RGB triple, for palette ordering.
function morton(r, g, b) {
  let m = 0;
  for (let i = 7; i >= 0; i--) m = (m << 3) | (((r >> i) & 1) << 2) | (((g >> i) & 1) << 1) | ((b >> i) & 1);
  return m;
}

function paletteForm(rgba, colours, order) {
  const lum = (c) => 299 * c.rgba[0] + 587 * c.rgba[1] + 114 * c.rgba[2];
  const u32 = rgba.byteOffset % 4 === 0
    ? new Uint32Array(rgba.buffer, rgba.byteOffset, rgba.length >>> 2)
    : new Uint32Array(rgba.slice().buffer);
  const first = new Map();
  for (let i = 0; i < u32.length; i++) if (!first.has(u32[i])) first.set(u32[i], i);
  const entries = [...colours].sort((x, y) => {
    const ta = x.rgba[3] === 255 ? 1 : 0, tb = y.rgba[3] === 255 ? 1 : 0;
    if (ta !== tb) return ta - tb;
    if (ta === 0 && x.rgba[3] !== y.rgba[3]) return x.rgba[3] - y.rgba[3];
    if (order === 'luminance') return lum(x) - lum(y) || x.word - y.word;
    if (order === 'first') return first.get(x.word) - first.get(y.word);
    if (order === 'morton') return morton(x.rgba[0], x.rgba[1], x.rgba[2]) - morton(y.rgba[0], y.rgba[1], y.rgba[2]);
    return y.count - x.count || x.word - y.word; // 'count'
  });
  const index = new Map(entries.map((c, i) => [c.word, i]));
  const plte = new Uint8Array(entries.length * 3);
  let transparent = 0;
  entries.forEach((c, i) => {
    plte[i * 3] = c.rgba[0]; plte[i * 3 + 1] = c.rgba[1]; plte[i * 3 + 2] = c.rgba[2];
    if (c.rgba[3] !== 255) transparent = i + 1;
  });
  const trns = transparent === 0 ? null : Uint8Array.from(entries.slice(0, transparent), (c) => c.rgba[3]);
  const indices = new Uint8Array(u32.length);
  for (let i = 0; i < u32.length; i++) indices[i] = index.get(u32[i]);
  return { colourType: 3, bpp: 1, samples: indices, plte, trns };
}

// The forms an image can be written in: palette orders when it holds at most
// 256 colours, else (or also, when grey) the channel form with a tRNS key
// where one exists. A non-grey palette image is never tried as RGB: a palette
// holds it in a third of the bytes or less.
function formsOf(rgba) {
  const { opaque, grey, colours } = analyse(rgba);
  const forms = [];
  if (colours !== null) {
    for (const order of ['count', 'luminance', 'first', 'morton']) {
      forms.push(paletteForm(rgba, colours, order));
    }
    if (!grey) return forms;
  }
  const key = opaque ? null : transparentKey(rgba, grey);
  let ct, trns = null;
  if (grey) {
    ct = opaque || key !== null ? 0 : 4;
    if (key !== null) trns = Uint8Array.of(0, key);
  } else {
    ct = opaque || key !== null ? 2 : 6;
    if (key !== null) trns = Uint8Array.of(0, key >>> 16, 0, (key >>> 8) & 0xff, 0, key & 0xff);
  }
  const bpp = { 0: 1, 2: 3, 4: 2, 6: 4 }[ct];
  forms.push({ colourType: ct, bpp, samples: samplesOf(rgba, ct), plte: null, trns });
  return forms;
}

// The filter choices each form is screened with.
function filtersFor(form) {
  if (form.colourType === 3) return [0];
  if (form.colourType === 0 || form.colourType === 4) return [0, 4, 'pairs', 'brute'];
  return [0, 4, 'pairs'];
}

const chunkOverhead = (form) =>
  (form.plte === null ? 0 : 12 + form.plte.length) + (form.trns === null ? 0 : 12 + form.trns.length) + 57;

const SCREEN = { level: 6, memLevel: 8, strategy: constants.Z_DEFAULT_STRATEGY };
const Z9 = { level: 9, memLevel: 9, strategy: constants.Z_DEFAULT_STRATEGY };
const Z9F = { level: 9, memLevel: 9, strategy: constants.Z_FILTERED };

/* ---------------- Deflate: single stream and row-aligned splits ---------------- */

// One zlib stream of `data`, split into `n` row-aligned pieces; every piece but
// the last is flushed with Z_SYNC_FLUSH, so each piece gets fresh Huffman
// tables while the 32 KiB window stays shared across pieces.
function chunkedDeflate(data, rowLen, n, strategy) {
  return new Promise((resolve, reject) => {
    const dz = createDeflateRaw({ level: 9, memLevel: 9, strategy });
    const parts = [];
    dz.on('data', (c) => parts.push(c));
    dz.on('error', reject);
    dz.on('end', () => {
      const raw = Buffer.concat(parts);
      const out = Buffer.alloc(2 + raw.length + 4);
      out[0] = 0x78; out[1] = 0x9c;
      raw.copy(out, 2);
      out.writeUInt32BE(adler32(data), 2 + raw.length);
      resolve(out);
    });
    const per = Math.ceil(HEIGHT / n);
    const writePiece = (k) => {
      if (k >= n) { dz.end(); return; }
      const from = k * per * rowLen;
      const to = Math.min(data.length, (k + 1) * per * rowLen);
      if (to <= from) { dz.end(); return; }
      dz.write(data.subarray(from, to), () => {
        if (k < n - 1) dz.flush(constants.Z_SYNC_FLUSH, () => writePiece(k + 1));
        else dz.end();
      });
    };
    writePiece(0);
  });
}

// The smallest zlib stream of the filtered `data`: single streams at level 9
// (default and filtered strategy) and row-aligned splits of 2/4/8/16 pieces.
async function bestZlib(data, rowLen) {
  let best = null;
  const consider = (stream) => {
    if (best === null || stream.length < best.length) best = stream;
  };
  consider(deflateSync(data, Z9));
  consider(deflateSync(data, Z9F));
  for (const n of [2, 4, 8, 16]) consider(await chunkedDeflate(data, rowLen, n, constants.Z_DEFAULT_STRATEGY));
  consider(await chunkedDeflate(data, rowLen, 8, constants.Z_FILTERED));
  consider(await chunkedDeflate(data, rowLen, 16, constants.Z_FILTERED));
  return best;
}

function pngOfForm(width, height, form, idat) {
  const chunks = [['IHDR', ihdrOf(width, height, form.colourType)]];
  if (form.plte !== null) chunks.push(['PLTE', form.plte]);
  if (form.trns !== null) chunks.push(['tRNS', form.trns]);
  chunks.push(['IDAT', idat]);
  chunks.push(['IEND', new Uint8Array(0)]);
  return pngOf(chunks);
}

/* ---------------- Main: one deterministic run over the set ---------------- */

async function main() {
  for (const id of readdirSync(INPUT).sort()) {
    const image = decodePng(new Uint8Array(readFileSync(join(INPUT, id, 'image.png'))));
    if (image.width !== WIDTH || image.height !== HEIGHT) throw new Error(id + ': not 1280x720');
    // Screen every form and filter choice at level 6; keep the smallest.
    let best = null;
    for (const form of formsOf(image.rgba)) {
      const size = HEIGHT * (WIDTH * form.bpp + 1);
      for (const choice of filtersFor(form)) {
        const data = filtered(form.samples, WIDTH, HEIGHT, form.bpp, choice);
        const bytes = deflateSync(data, SCREEN).length + chunkOverhead(form);
        if (best === null || bytes < best.bytes) best = { form, data, bytes };
      }
    }
    // Re-encode the winner's filtered stream with the best level-9 variant.
    const rowLen = WIDTH * best.form.bpp + 1;
    const zlib = await bestZlib(best.data, rowLen);
    mkdirSync(join(OUTPUT, id), { recursive: true });
    writeFileSync(join(OUTPUT, id, 'image.png'), pngOfForm(WIDTH, HEIGHT, best.form, zlib));
  }
}

main().catch((err) => {
  console.error(err && err.stack ? err.stack : String(err));
  process.exit(1);
});
