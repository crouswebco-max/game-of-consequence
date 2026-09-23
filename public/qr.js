'use strict';
/**
 * A very small QR encoder — byte mode, versions 1-10, EC level L or M.
 *
 * Why not a library: the projector may be on a laptop with no internet at the
 * venue, and a join code that fails to render is a game that does not start.
 * This is the smallest thing that reliably produces a scannable code.
 *
 *   QR.matrix('http://192.168.1.4:7373/join')  -> array of arrays of 0|1
 *   QR.svg(text, { size, quiet, dark, light }) -> an <svg> string
 */
const QR = (() => {

  // ------------------------------------------------------------ GF(256)

  const EXP = new Uint8Array(512), LOG = new Uint8Array(256);
  for (let i = 0, x = 1; i < 255; i++) {
    EXP[i] = x; LOG[x] = i;
    x <<= 1; if (x & 0x100) x ^= 0x11d;      // the QR primitive polynomial
  }
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];

  const mul = (a, b) => (a === 0 || b === 0) ? 0 : EXP[LOG[a] + LOG[b]];

  /** Generator polynomial for `n` error-correction codewords. */
  function generator(n) {
    let poly = [1];
    for (let i = 0; i < n; i++) {
      const next = new Array(poly.length + 1).fill(0);
      for (let j = 0; j < poly.length; j++) {
        next[j] ^= poly[j];
        next[j + 1] ^= mul(poly[j], EXP[i]);
      }
      poly = next;
    }
    return poly;
  }

  function ecBytes(data, n) {
    const gen = generator(n);
    const buf = new Uint8Array(data.length + n);
    buf.set(data);
    for (let i = 0; i < data.length; i++) {
      const factor = buf[i];
      if (!factor) continue;
      for (let j = 0; j < gen.length; j++) buf[i + j] ^= mul(gen[j], factor);
    }
    return buf.slice(data.length);
  }

  // -------------------------------------------------- version capacity table

  /**
   * Per version 1-10, per EC level: [ecCodewordsPerBlock, group1Blocks,
   * group1DataCodewords, group2Blocks, group2DataCodewords].
   * Straight from the QR spec's block tables.
   */
  const BLOCKS = {
    L: {
      1: [7, 1, 19, 0, 0],    2: [10, 1, 34, 0, 0],   3: [15, 1, 55, 0, 0],
      4: [20, 1, 80, 0, 0],   5: [26, 1, 108, 0, 0],  6: [18, 2, 68, 0, 0],
      7: [20, 2, 78, 0, 0],   8: [24, 2, 97, 0, 0],   9: [30, 2, 116, 0, 0],
      10: [18, 2, 68, 2, 69]
    },
    M: {
      1: [10, 1, 16, 0, 0],   2: [16, 1, 28, 0, 0],   3: [26, 1, 44, 0, 0],
      4: [18, 2, 32, 0, 0],   5: [24, 2, 43, 0, 0],   6: [16, 4, 27, 0, 0],
      7: [18, 4, 31, 0, 0],   8: [22, 2, 38, 2, 39],  9: [22, 3, 36, 2, 37],
      10: [26, 4, 43, 1, 44]
    }
  };

  const totalData = (v, ec) => {
    const [, b1, d1, b2, d2] = BLOCKS[ec][v];
    return b1 * d1 + b2 * d2;
  };

  /** Centre coordinates of the alignment patterns, by version. */
  const ALIGN = {
    1: [], 2: [6, 18], 3: [6, 22], 4: [6, 26], 5: [6, 30],
    6: [6, 34], 7: [6, 22, 38], 8: [6, 24, 42], 9: [6, 26, 46], 10: [6, 28, 50]
  };

  /** Pre-computed BCH format strings for (ecLevel, mask). */
  const FORMAT_BITS = { L: 0b01, M: 0b00, Q: 0b11, H: 0b10 };
  function formatInfo(ec, mask) {
    const data = (FORMAT_BITS[ec] << 3) | mask;
    let rem = data << 10;
    for (let i = 14; i >= 10; i--) if (rem & (1 << i)) rem ^= 0b10100110111 << (i - 10);
    return ((data << 10) | rem) ^ 0b101010000010010;
  }

  function versionInfo(v) {
    let rem = v << 12;
    for (let i = 17; i >= 12; i--) if (rem & (1 << i)) rem ^= 0b1111100100101 << (i - 12);
    return (v << 12) | rem;
  }

  // ------------------------------------------------------------ bit stream

  class Bits {
    constructor() { this.bits = []; }
    push(value, len) { for (let i = len - 1; i >= 0; i--) this.bits.push((value >> i) & 1); }
    get length() { return this.bits.length; }
    bytes() {
      const out = new Uint8Array(Math.ceil(this.bits.length / 8));
      this.bits.forEach((b, i) => { if (b) out[i >> 3] |= 0x80 >> (i & 7); });
      return out;
    }
  }

  // --------------------------------------------------------------- the grid

  const MASKS = [
    (r, c) => (r + c) % 2 === 0,
    (r) => r % 2 === 0,
    (r, c) => c % 3 === 0,
    (r, c) => (r + c) % 3 === 0,
    (r, c) => (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0,
    (r, c) => ((r * c) % 2) + ((r * c) % 3) === 0,
    (r, c) => (((r * c) % 2) + ((r * c) % 3)) % 2 === 0,
    (r, c) => (((r + c) % 2) + ((r * c) % 3)) % 2 === 0
  ];

  function blank(size) {
    return {
      m: Array.from({ length: size }, () => new Int8Array(size).fill(-1)),
      fixed: Array.from({ length: size }, () => new Uint8Array(size))
    };
  }

  function placeFinder(g, size, r0, c0) {
    for (let r = -1; r <= 7; r++) {
      for (let c = -1; c <= 7; c++) {
        const r1 = r0 + r, c1 = c0 + c;
        if (r1 < 0 || c1 < 0 || r1 >= size || c1 >= size) continue;
        const on = (r >= 0 && r <= 6 && (c === 0 || c === 6)) ||
                   (c >= 0 && c <= 6 && (r === 0 || r === 6)) ||
                   (r >= 2 && r <= 4 && c >= 2 && c <= 4);
        g.m[r1][c1] = on ? 1 : 0;
        g.fixed[r1][c1] = 1;
      }
    }
  }

  function placeAlignment(g, size, version) {
    const centres = ALIGN[version];
    for (const r0 of centres) {
      for (const c0 of centres) {
        // Skip the three that would sit on a finder pattern.
        if ((r0 <= 8 && c0 <= 8) || (r0 <= 8 && c0 >= size - 9) || (r0 >= size - 9 && c0 <= 8)) continue;
        for (let r = -2; r <= 2; r++) {
          for (let c = -2; c <= 2; c++) {
            const on = Math.max(Math.abs(r), Math.abs(c)) !== 1;
            g.m[r0 + r][c0 + c] = on ? 1 : 0;
            g.fixed[r0 + r][c0 + c] = 1;
          }
        }
      }
    }
  }

  function build(version, ec, data) {
    const size = 17 + version * 4;
    const g = blank(size);

    placeFinder(g, size, 0, 0);
    placeFinder(g, size, 0, size - 7);
    placeFinder(g, size, size - 7, 0);

    // Timing patterns, laid before alignment so alignment can overwrite nothing
    // it should not — the spec has alignment take precedence where they meet.
    for (let i = 8; i < size - 8; i++) {
      const on = i % 2 === 0 ? 1 : 0;
      g.m[6][i] = on; g.fixed[6][i] = 1;
      g.m[i][6] = on; g.fixed[i][6] = 1;
    }

    placeAlignment(g, size, version);

    // The dark module, always set.
    g.m[size - 8][8] = 1; g.fixed[size - 8][8] = 1;

    // Reserve the format areas so data skips them.
    for (let i = 0; i < 9; i++) {
      if (!g.fixed[8][i]) { g.fixed[8][i] = 1; g.m[8][i] = 0; }
      if (!g.fixed[i][8]) { g.fixed[i][8] = 1; g.m[i][8] = 0; }
    }
    for (let i = 0; i < 8; i++) {
      g.fixed[8][size - 1 - i] = 1; g.m[8][size - 1 - i] = 0;
      g.fixed[size - 1 - i][8] = 1; g.m[size - 1 - i][8] = 0;
    }

    // Version information blocks, version 7 and up.
    if (version >= 7) {
      const vi = versionInfo(version);
      for (let i = 0; i < 18; i++) {
        const bit = (vi >> i) & 1;
        const r = Math.floor(i / 3), c = size - 11 + (i % 3);
        g.m[r][c] = bit; g.fixed[r][c] = 1;
        g.m[c][r] = bit; g.fixed[c][r] = 1;
      }
    }

    // Snake the data up and down the columns, right to left, skipping column 6.
    let bitIndex = 0;
    let upward = true;
    for (let right = size - 1; right > 0; right -= 2) {
      if (right === 6) right = 5;
      for (let step = 0; step < size; step++) {
        const row = upward ? size - 1 - step : step;
        for (let k = 0; k < 2; k++) {
          const col = right - k;
          if (g.fixed[row][col]) continue;
          const bit = bitIndex < data.length * 8
            ? (data[bitIndex >> 3] >> (7 - (bitIndex & 7))) & 1
            : 0;
          g.m[row][col] = bit;
          bitIndex++;
        }
      }
      upward = !upward;
    }
    return { g, size };
  }

  function applyMask(g, size, mask) {
    const out = g.m.map(row => Int8Array.from(row));
    const fn = MASKS[mask];
    for (let r = 0; r < size; r++) {
      for (let c = 0; c < size; c++) {
        if (g.fixed[r][c]) continue;
        if (fn(r, c)) out[r][c] ^= 1;
      }
    }
    return out;
  }

  function writeFormat(m, size, ec, mask) {
    const bits = formatInfo(ec, mask);

    // Copy one, wrapped around the top-left finder. Note the axes: the low
    // bits run DOWN column 8, the high bits run LEFT along row 8.
    for (let i = 0; i <= 5; i++) m[i][8] = (bits >> i) & 1;
    m[7][8] = (bits >> 6) & 1;
    m[8][8] = (bits >> 7) & 1;
    m[8][7] = (bits >> 8) & 1;
    for (let i = 9; i <= 14; i++) m[8][14 - i] = (bits >> i) & 1;

    // Copy two: low bits along row 8 from the right edge, high bits up
    // column 8 from the bottom.
    for (let i = 0; i <= 7; i++) m[8][size - 1 - i] = (bits >> i) & 1;
    for (let i = 8; i <= 14; i++) m[size - 15 + i][8] = (bits >> i) & 1;

    // The dark module, which always wins over whatever sat beneath it.
    m[size - 8][8] = 1;
  }

  /** The spec's four penalty rules, used to pick the least ugly mask. */
  function penalty(m, size) {
    let score = 0;

    const run = (get) => {
      for (let a = 0; a < size; a++) {
        let last = -1, len = 0;
        for (let b = 0; b < size; b++) {
          const v = get(a, b);
          if (v === last) { len++; } else { if (len >= 5) score += 3 + (len - 5); last = v; len = 1; }
        }
        if (len >= 5) score += 3 + (len - 5);
      }
    };
    run((r, c) => m[r][c]);
    run((c, r) => m[r][c]);

    for (let r = 0; r < size - 1; r++) {
      for (let c = 0; c < size - 1; c++) {
        const v = m[r][c];
        if (v === m[r][c + 1] && v === m[r + 1][c] && v === m[r + 1][c + 1]) score += 3;
      }
    }

    const PAT1 = [1, 0, 1, 1, 1, 0, 1, 0, 0, 0, 0];
    const PAT2 = [0, 0, 0, 0, 1, 0, 1, 1, 1, 0, 1];
    const hit = (get, a, b) => {
      for (const pat of [PAT1, PAT2]) {
        let ok = true;
        for (let i = 0; i < 11; i++) if (get(a, b + i) !== pat[i]) { ok = false; break; }
        if (ok) return true;
      }
      return false;
    };
    for (let r = 0; r < size; r++) {
      for (let c = 0; c + 11 <= size; c++) {
        if (hit((a, b) => m[a][b], r, c)) score += 40;
        if (hit((a, b) => m[b][a], r, c)) score += 40;
      }
    }

    let dark = 0;
    for (let r = 0; r < size; r++) for (let c = 0; c < size; c++) dark += m[r][c];
    const pct = (dark * 100) / (size * size);
    score += Math.floor(Math.abs(pct - 50) / 5) * 10;

    return score;
  }

  // --------------------------------------------------------------- encoding

  function encode(text, ecLevel) {
    const bytes = new TextEncoder().encode(text);

    let version = 0;
    for (let v = 1; v <= 10; v++) {
      const countBits = v <= 9 ? 8 : 16;
      const needed = 4 + countBits + bytes.length * 8;
      if (needed <= totalData(v, ecLevel) * 8) { version = v; break; }
    }
    if (!version) throw new Error('Too much data for this encoder (max version 10).');

    const capacity = totalData(version, ecLevel);
    const countBits = version <= 9 ? 8 : 16;

    const bits = new Bits();
    bits.push(0b0100, 4);                 // byte mode
    bits.push(bytes.length, countBits);
    for (const b of bytes) bits.push(b, 8);

    // Terminator, then pad to a byte, then the two alternating pad bytes.
    const room = capacity * 8 - bits.length;
    bits.push(0, Math.min(4, room));
    while (bits.length % 8) bits.bits.push(0);
    const raw = Array.from(bits.bytes());
    const PADS = [0xec, 0x11];
    for (let i = 0; raw.length < capacity; i++) raw.push(PADS[i % 2]);

    // Split into blocks, compute EC per block, then interleave both.
    const [ecPer, b1, d1, b2, d2] = BLOCKS[ecLevel][version];
    const dataBlocks = [], ecBlocks = [];
    let at = 0;
    for (let i = 0; i < b1; i++) { const blk = raw.slice(at, at + d1); at += d1; dataBlocks.push(blk); ecBlocks.push(ecBytes(Uint8Array.from(blk), ecPer)); }
    for (let i = 0; i < b2; i++) { const blk = raw.slice(at, at + d2); at += d2; dataBlocks.push(blk); ecBlocks.push(ecBytes(Uint8Array.from(blk), ecPer)); }

    const out = [];
    const maxData = Math.max(d1, d2);
    for (let i = 0; i < maxData; i++) for (const blk of dataBlocks) if (i < blk.length) out.push(blk[i]);
    for (let i = 0; i < ecPer; i++) for (const blk of ecBlocks) out.push(blk[i]);

    return { version, data: Uint8Array.from(out) };
  }

  function matrix(text, ecLevel = 'M') {
    const { version, data } = encode(text, ecLevel);
    const { g, size } = build(version, ecLevel, data);

    let best = null;
    for (let mask = 0; mask < 8; mask++) {
      const m = applyMask(g, size, mask);
      writeFormat(m, size, ecLevel, mask);
      const score = penalty(m, size);
      if (!best || score < best.score) best = { score, m };
    }
    return best.m.map(row => Array.from(row));
  }

  function svg(text, opts = {}) {
    const { size = 320, quiet = 4, dark = '#07080b', light = '#ece7dc', ec = 'M' } = opts;
    const m = matrix(text, ec);
    const n = m.length;
    const total = n + quiet * 2;

    let d = '';
    for (let r = 0; r < n; r++) {
      let c = 0;
      while (c < n) {
        if (!m[r][c]) { c++; continue; }
        let run = 1;
        while (c + run < n && m[r][c + run]) run++;
        d += `M${c + quiet} ${r + quiet}h${run}v1h-${run}z`;
        c += run;
      }
    }
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" ` +
      `viewBox="0 0 ${total} ${total}" shape-rendering="crispEdges" role="img" aria-label="Join code">` +
      `<rect width="${total}" height="${total}" fill="${light}"/>` +
      `<path d="${d}" fill="${dark}"/></svg>`;
  }

  return { matrix, svg };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = QR;
if (typeof window !== 'undefined') window.QR = QR;
