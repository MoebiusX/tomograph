// studio/atlases.mjs
//
// Six visual metaphors for the same pair of packs:
//
//   - strata        — geological cross-section (Cuvier/Lyell/USGS strata)
//   - periodic      — Mendeleev's gaps (every artefact a cell; empty
//                     cells are predicted gaps)
//   - constellation — celestial atlas (bright = present, dim = missing,
//                     slider morphs A→B)
//   - skyline       — Tufte slopegraph (one line per layer, steepest = biggest delta)
//   - transit       — subway-style map (layers as lines, artefacts as stations)
//   - arbor         — botanical (trunk → layer branches → artefact leaves)
//
// All six consume the same dataset:
//   { a: layeredPack, b: layeredPack, diff: diffResult }
//
// They emit SVG into a host element via render(host, dataset). Pure ESM.
// Colors come from CSS variables resolved at render time so light/dark
// theme switches Just Work.

const LAYERS = ['L1', 'L2', 'L2X', 'L3', 'L4', 'L5', 'GOV'];

const LAYER_NAMES = {
  L1: 'Contract',
  L2: 'Telemetry',
  L2X: 'Extended',
  L3: 'Insight',
  L4: 'Action',
  L5: 'Validation',
  GOV: 'Governance',
};

export const ATLAS_META = {
  strata:        { title: 'Stratigraphy of the platform',     lede: 'Read the layers like rock. Where the silhouette is jagged, something is missing. The right column is what the platform looks like when every layer is intact.' },
  periodic:      { title: 'A periodic table of observability', lede: 'Every artefact that should exist gets a cell. Dashed cells are gaps — Mendeleev predicted gallium from a hole in his 1869 table; we do the same with missing recording rules and chaos coverage.' },
  constellation: { title: 'The night sky of the platform',    lede: 'A celestial chart. Bright stars are present. Dim stars are missing. Drag the slider to morph A into B — every star reignited is a gap closed.' },
  skyline:       { title: 'The maturity skyline',              lede: 'A slopegraph from A to B, one line per layer. The longest lines are the biggest deltas — your project plan written in geometry.' },
  transit:       { title: 'The platform as a transit network', lede: 'A subway-style map. Layers are lines; artefacts are stations. Closed stations are gaps; interchanges show where one symbol is bound by another.' },
  arbor:         { title: 'A botanical of the platform',       lede: 'A plant rooted in the service. Branches divide upward through the layers; leaves are artefacts. Open buds are gaps; bright leaves are present.' },
};

// ============================================================
// Helpers
// ============================================================

function flatLayer(pack, layerId) {
  const ls = pack?.layers || {};
  if (layerId === 'L4') {
    return [...(ls.L4?.policy || []), ...(ls.L4?.alerting || []), ...(ls.L4?.healing || [])];
  }
  return ls[layerId] || [];
}

function layerCounts(pack) {
  const out = {};
  for (const l of LAYERS) out[l] = flatLayer(pack, l).length;
  return out;
}

function cssVar(name, fallback = '#888') {
  if (typeof window === 'undefined') return fallback;
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return v || fallback;
}

function layerColor(id) { return cssVar(`--${id}`, '#888'); }
function layerBg(id)    { return cssVar(`--${id}-bg`, '#eee'); }
function layerTint(id)  { return cssVar(`--${id}-tint`, '#f4f4f4'); }
function sourceColor(s) {
  if (s === 'Verified') return cssVar('--src-Verified', '#06B6D4');
  if (s === 'Missing')  return cssVar('--src-Missing',  '#DC2626');
  return cssVar('--src-Declared', '#475569');
}

function svg(tag, attrs = {}, children = []) {
  const el = document.createElementNS('http://www.w3.org/2000/svg', tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === null || v === undefined) continue;
    el.setAttribute(k, String(v));
  }
  for (const c of children) {
    if (c === null || c === undefined) continue;
    if (typeof c === 'string') el.appendChild(document.createTextNode(c));
    else el.appendChild(c);
  }
  return el;
}

function clear(host) { while (host.firstChild) host.removeChild(host.firstChild); }

function escapeHtml(s) {
  if (s == null) return '';
  return String(s).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;').replaceAll("'", '&#39;');
}

function makeRoot(width = 1000, height = 600, host) {
  clear(host);
  return svg('svg', { viewBox: `0 0 ${width} ${height}`, width: '100%', height: 'auto', class: 'atlas-svg' });
}

// ============================================================
// 1) Stratigraphy — geological cross-section.
//
// Two stacks of horizontal layer bands, A on the left and B on the right.
// Each layer band's height is proportional to the artefact count in that
// pack. The B silhouette is drawn cleanly; A's bands carry gap notches
// where artefacts are missing relative to B (i.e. counted in
// diff.layers.<L>.onlyInB).
// ============================================================

function renderStrata(host, { a, b, diff }) {
  const W = 1000, H = 580;
  const root = makeRoot(W, H, host);

  const left = { x: 80, w: 380 };
  const right = { x: 540, w: 380 };
  const totalA = LAYERS.reduce((s, l) => s + flatLayer(a, l).length, 0) || 1;
  const totalB = LAYERS.reduce((s, l) => s + flatLayer(b, l).length, 0) || 1;
  const scale = Math.max(totalA, totalB);
  const unit  = (H - 80) / scale;

  // Helper to draw one stack
  const drawStack = (side, pack, missingByLayer = {}, label) => {
    let y = 40;
    const counts = layerCounts(pack);
    for (const lid of LAYERS) {
      const n = counts[lid];
      const missing = missingByLayer[lid] || 0;
      const height = Math.max(8, (n + missing) * unit);
      // background band (potential)
      root.appendChild(svg('rect', {
        x: side.x, y, width: side.w, height,
        fill: layerTint(lid),
        stroke: layerColor(lid), 'stroke-width': 0.5,
      }));
      // filled portion (actual present artefacts)
      const filled = Math.max(0, n * unit);
      root.appendChild(svg('rect', {
        x: side.x, y: y + (height - filled), width: side.w, height: filled,
        fill: layerColor(lid), 'fill-opacity': 0.85,
      }));
      // label
      root.appendChild(svg('text', {
        x: side.x + side.w / 2, y: y + height / 2 + 5,
        'text-anchor': 'middle',
        'font-family': "'IBM Plex Mono', monospace",
        'font-size': 13,
        'font-weight': 600,
        fill: '#fff',
      }, [`${lid} · ${n}${missing ? ` (+${missing} missing)` : ''}`]));
      y += height + 4;
    }
    // Bottom column label
    root.appendChild(svg('text', {
      x: side.x + side.w / 2, y: H - 16,
      'text-anchor': 'middle',
      'font-family': "'Newsreader', serif",
      'font-style': 'italic',
      'font-size': 16,
      fill: cssVar('--ink', '#222'),
    }, [label]));
  };

  // For A, "missing" = things present in B but not in A.
  const missingA = {};
  for (const l of LAYERS) missingA[l] = diff?.layers?.[l]?.onlyInB?.length || 0;
  const missingB = {};
  for (const l of LAYERS) missingB[l] = diff?.layers?.[l]?.onlyInA?.length || 0;

  drawStack(left,  a, missingA, a?.name || 'A');
  drawStack(right, b, missingB, b?.name || 'B');

  host.appendChild(root);
}

// ============================================================
// 2) Periodic Table — Mendeleev's gaps.
//
// Rows = layers, columns = artefact slots. Each artefact gets a cell;
// onlyInB items show up as dashed empty cells on A's side (predicted
// gaps), and vice versa.
// ============================================================

function renderPeriodic(host, { a, b, diff }) {
  const cell = 60;
  const gap  = 6;
  const padX = 100;
  const padY = 60;

  // Figure out the column count: union of layer-cells (max per layer).
  const maxCols = Math.max(...LAYERS.map(l =>
    (flatLayer(a, l).length + (diff?.layers?.[l]?.onlyInB?.length || 0))
  ), 1);

  const W = padX + maxCols * (cell + gap) + 80;
  const H = padY + LAYERS.length * (cell + gap) + 60;
  const root = makeRoot(W, H, host);

  // Title strip
  root.appendChild(svg('text', {
    x: W / 2, y: 30,
    'text-anchor': 'middle',
    'font-family': "'IBM Plex Mono', monospace",
    'font-size': 11,
    'letter-spacing': '0.12em',
    fill: cssVar('--ink-4', '#888'),
  }, [`${a?.name || 'A'}: present + dashed for items in ${b?.name || 'B'} only`]));

  LAYERS.forEach((lid, rowIdx) => {
    const y = padY + rowIdx * (cell + gap);
    // Row label
    root.appendChild(svg('text', {
      x: padX - 12, y: y + cell / 2 + 4,
      'text-anchor': 'end',
      'font-family': "'IBM Plex Mono', monospace",
      'font-weight': 700,
      'font-size': 13,
      fill: layerColor(lid),
    }, [lid]));

    const present = flatLayer(a, lid);
    const missing = diff?.layers?.[lid]?.onlyInB || [];

    present.forEach((art, i) => {
      const x = padX + i * (cell + gap);
      const cellRoot = svg('g', {});
      cellRoot.appendChild(svg('rect', {
        x, y, width: cell, height: cell, rx: 4,
        fill: layerBg(lid),
        stroke: layerColor(lid),
        'stroke-width': 1.5,
      }));
      cellRoot.appendChild(svg('text', {
        x: x + 6, y: y + 16,
        'font-family': "'IBM Plex Mono', monospace",
        'font-weight': 700,
        'font-size': 11,
        fill: layerColor(lid),
      }, [art.id]));
      cellRoot.appendChild(svg('text', {
        x: x + cell / 2, y: y + cell - 8,
        'text-anchor': 'middle',
        'font-family': "'IBM Plex Sans', sans-serif",
        'font-size': 10,
        fill: cssVar('--ink', '#222'),
      }, [shorten(art.title || art.id, 8)]));
      // source dot
      cellRoot.appendChild(svg('circle', {
        cx: x + cell - 8, cy: y + 8, r: 3,
        fill: sourceColor(art.source),
      }));
      // title for hover
      cellRoot.appendChild(svg('title', {}, [`${art.id} · ${art.title || ''}\n${art.source || ''}`]));
      root.appendChild(cellRoot);
    });

    missing.forEach((entry, i) => {
      const x = padX + (present.length + i) * (cell + gap);
      const art = entry.artefact;
      const g = svg('g', { 'class': 'periodic-gap' });
      g.appendChild(svg('rect', {
        x, y, width: cell, height: cell, rx: 4,
        fill: 'transparent',
        stroke: cssVar('--src-Missing', '#DC2626'),
        'stroke-width': 1.5,
        'stroke-dasharray': '5 4',
      }));
      g.appendChild(svg('text', {
        x: x + cell / 2, y: y + cell / 2 + 5,
        'text-anchor': 'middle',
        'font-family': "'IBM Plex Mono', monospace",
        'font-size': 14,
        'font-weight': 600,
        fill: cssVar('--src-Missing', '#DC2626'),
      }, ['—']));
      g.appendChild(svg('title', {}, [`${art?.id || entry.key} · gap (only in ${b?.name || 'B'})`]));
      root.appendChild(g);
    });
  });

  host.appendChild(root);
}

function shorten(s, n) {
  if (!s) return '';
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

// ============================================================
// 3) Constellation — celestial atlas.
//
// Layers are horizontal "altitude bands" of the night sky. Each artefact
// is a star. A's stars are at full brightness; missing stars are dim.
// The slider morphs A toward B: missing stars reignite, extras fade.
// ============================================================

function renderConstellation(host, { a, b, diff }, opts = {}) {
  const W = 1000, H = 560;
  const root = makeRoot(W, H, host);

  // Night sky background
  root.appendChild(svg('rect', { x: 0, y: 0, width: W, height: H, fill: '#0B1530' }));
  // Subtle gradient bands per layer
  LAYERS.forEach((lid, i) => {
    const top = 30 + i * ((H - 60) / LAYERS.length);
    const bot = 30 + (i + 1) * ((H - 60) / LAYERS.length);
    const bandColor = layerColor(lid);
    root.appendChild(svg('rect', {
      x: 0, y: top, width: W, height: bot - top,
      fill: bandColor, 'fill-opacity': 0.04,
    }));
    root.appendChild(svg('text', {
      x: 16, y: top + 18,
      'font-family': "'IBM Plex Mono', monospace",
      'font-size': 11,
      'letter-spacing': '0.12em',
      fill: bandColor,
    }, [`${lid} · ${LAYER_NAMES[lid]}`]));
  });

  // Pseudo-random reproducible star positions per (layer, index)
  const rand = (seed) => {
    let s = seed | 0;
    s ^= s << 13; s ^= s >>> 17; s ^= s << 5;
    return ((s >>> 0) / 0xffffffff);
  };
  const t = typeof opts.morph === 'number' ? Math.max(0, Math.min(1, opts.morph)) : 0;

  LAYERS.forEach((lid, layerIdx) => {
    const present = flatLayer(a, lid);
    const incoming = diff?.layers?.[lid]?.onlyInB || [];
    const outgoing = diff?.layers?.[lid]?.onlyInA || [];
    const top = 36 + layerIdx * ((H - 60) / LAYERS.length);
    const bot = 30 + (layerIdx + 1) * ((H - 60) / LAYERS.length) - 6;

    // Present (stays bright unless it's onlyInA, then fades as t→1)
    present.forEach((art, i) => {
      const outIdx = outgoing.findIndex(o => o.artefact?.id === art.id);
      const x = 100 + rand(layerIdx * 1000 + i * 31) * (W - 200);
      const y = top + rand(layerIdx * 991 + i * 17) * (bot - top);
      const baseR = 2 + rand(i * 7) * 2.5;
      const opacity = outIdx === -1 ? 0.95 : 0.95 * (1 - t);
      const r = baseR * (outIdx === -1 ? 1 : 1 - t * 0.6);
      drawStar(root, x, y, r, '#fff', opacity);
      // tooltip
      const g = svg('g', {});
      g.appendChild(svg('title', {}, [`${art.id} · ${art.title || ''}`]));
      g.appendChild(svg('circle', { cx: x, cy: y, r: r + 6, fill: 'transparent' }));
      root.appendChild(g);
    });

    // Incoming (onlyInB) — dim → bright as t goes 0→1
    incoming.forEach((entry, i) => {
      const x = 100 + rand(layerIdx * 9001 + i * 41) * (W - 200);
      const y = top + rand(layerIdx * 877 + i * 53) * (bot - top);
      const opacity = 0.18 + t * 0.77;
      const r = (1.6 + rand(i * 13) * 2) * (0.5 + t * 0.5);
      drawStar(root, x, y, r, t > 0.5 ? '#fff' : '#7C9AC4', opacity);
      const g = svg('g', {});
      g.appendChild(svg('title', {}, [`${entry.artefact?.id || entry.key} · gap (incoming)`]));
      g.appendChild(svg('circle', { cx: x, cy: y, r: r + 6, fill: 'transparent' }));
      root.appendChild(g);
    });
  });

  host.appendChild(root);
}

function drawStar(root, cx, cy, r, fill = '#fff', opacity = 1) {
  // Bright core + soft halo
  root.appendChild(svg('circle', { cx, cy, r: r * 2.4, fill, 'fill-opacity': opacity * 0.18 }));
  root.appendChild(svg('circle', { cx, cy, r, fill, 'fill-opacity': opacity }));
}

// ============================================================
// 4) Skyline — Tufte slopegraph.
//
// Two columns (A and B); one line per layer connecting the two counts.
// Steepest line = biggest delta in that layer.
// ============================================================

function renderSkyline(host, { a, b }) {
  const W = 1000, H = 540;
  const root = makeRoot(W, H, host);

  const counts = LAYERS.map(l => ({
    layer: l,
    a: flatLayer(a, l).length,
    b: flatLayer(b, l).length,
  }));
  const max = Math.max(1, ...counts.map(c => Math.max(c.a, c.b)));

  const xA = 220, xB = 780;
  const yTop = 60, yBot = H - 60;
  const yOf = (n) => yBot - (n / max) * (yBot - yTop);

  // Column axes
  root.appendChild(svg('line', { x1: xA, y1: yTop, x2: xA, y2: yBot, stroke: cssVar('--line', '#ccc'), 'stroke-width': 1 }));
  root.appendChild(svg('line', { x1: xB, y1: yTop, x2: xB, y2: yBot, stroke: cssVar('--line', '#ccc'), 'stroke-width': 1 }));

  // Headers
  root.appendChild(svg('text', { x: xA, y: yTop - 22, 'text-anchor': 'middle', 'font-family': "'Newsreader', serif", 'font-style': 'italic', 'font-size': 16, fill: cssVar('--ink', '#222') }, [a?.name || 'A']));
  root.appendChild(svg('text', { x: xB, y: yTop - 22, 'text-anchor': 'middle', 'font-family': "'Newsreader', serif", 'font-style': 'italic', 'font-size': 16, fill: cssVar('--ink', '#222') }, [b?.name || 'B']));

  // Per-layer lines
  counts.forEach(c => {
    const yA = yOf(c.a);
    const yB = yOf(c.b);
    const color = layerColor(c.layer);

    // line
    root.appendChild(svg('line', {
      x1: xA, y1: yA, x2: xB, y2: yB,
      stroke: color, 'stroke-width': 2.5, 'stroke-linecap': 'round',
    }));
    // endpoints
    root.appendChild(svg('circle', { cx: xA, cy: yA, r: 5, fill: color }));
    root.appendChild(svg('circle', { cx: xB, cy: yB, r: 5, fill: color }));

    // labels
    root.appendChild(svg('text', {
      x: xA - 14, y: yA + 4,
      'text-anchor': 'end',
      'font-family': "'IBM Plex Mono', monospace",
      'font-size': 12,
      'font-weight': 700,
      fill: color,
    }, [`${c.layer} ${c.a}`]));
    root.appendChild(svg('text', {
      x: xB + 14, y: yB + 4,
      'font-family': "'IBM Plex Mono', monospace",
      'font-size': 12,
      'font-weight': 700,
      fill: color,
    }, [`${c.b} ${c.layer}`]));

    // delta annotation in the middle for biggest slopes
    const mid = (xA + xB) / 2;
    const delta = c.b - c.a;
    if (Math.abs(delta) >= 3) {
      const myMid = (yA + yB) / 2 - 6;
      root.appendChild(svg('text', {
        x: mid, y: myMid,
        'text-anchor': 'middle',
        'font-family': "'IBM Plex Mono', monospace",
        'font-size': 10,
        'letter-spacing': '0.06em',
        fill: cssVar('--ink-4', '#888'),
      }, [`Δ ${delta > 0 ? '+' : ''}${delta}`]));
    }
  });

  host.appendChild(root);
}

// ============================================================
// 5) Transit — subway-style map.
//
// Each layer is a coloured vertical "line"; each artefact is a station
// on that line. Refs draw interchange chords (e.g. SLO → SLI). Gaps
// (onlyInB items) are drawn as hollow stations.
// ============================================================

function renderTransit(host, { a, diff }) {
  const W = 1100, H = 620;
  const root = makeRoot(W, H, host);

  const colsX = {};
  LAYERS.forEach((l, i) => { colsX[l] = 100 + i * ((W - 200) / (LAYERS.length - 1)); });

  // Layer line + label
  LAYERS.forEach(lid => {
    const x = colsX[lid];
    root.appendChild(svg('line', {
      x1: x, y1: 60, x2: x, y2: H - 60,
      stroke: layerColor(lid), 'stroke-width': 6, 'stroke-linecap': 'round',
    }));
    root.appendChild(svg('text', {
      x, y: 40,
      'text-anchor': 'middle',
      'font-family': "'IBM Plex Mono', monospace",
      'font-weight': 700,
      'font-size': 12,
      'letter-spacing': '0.08em',
      fill: layerColor(lid),
    }, [lid]));
  });

  // Position artefacts as stations on each line
  const stations = {};  // symbol -> {x, y, layer}
  LAYERS.forEach(lid => {
    const present = flatLayer(a, lid);
    const missing = (diff?.layers?.[lid]?.onlyInB || []).map(e => ({ ...e.artefact, _missing: true }));
    const all = [...present, ...missing];
    const yStep = (H - 140) / Math.max(1, all.length - 1);
    all.forEach((art, i) => {
      const x = colsX[lid];
      const y = 80 + (all.length === 1 ? (H - 160) / 2 : i * yStep);
      stations[art.defines || art.id] = { x, y, layer: lid };

      const isGap = !!art._missing;
      // Station marker
      const r = 7;
      const fill = isGap ? cssVar('--paper', '#fafaf7') : '#fff';
      root.appendChild(svg('circle', { cx: x, cy: y, r, fill, stroke: layerColor(lid), 'stroke-width': isGap ? 2 : 3 }));
      if (isGap) {
        // Cross out
        root.appendChild(svg('line', { x1: x - 4, y1: y - 4, x2: x + 4, y2: y + 4, stroke: cssVar('--src-Missing', '#DC2626'), 'stroke-width': 1.5 }));
        root.appendChild(svg('line', { x1: x - 4, y1: y + 4, x2: x + 4, y2: y - 4, stroke: cssVar('--src-Missing', '#DC2626'), 'stroke-width': 1.5 }));
      }

      // Station label
      const labelX = LAYERS.indexOf(lid) >= LAYERS.length / 2 ? x + 14 : x - 14;
      const anchor = LAYERS.indexOf(lid) >= LAYERS.length / 2 ? 'start' : 'end';
      root.appendChild(svg('text', {
        x: labelX, y: y + 4,
        'text-anchor': anchor,
        'font-family': "'IBM Plex Mono', monospace",
        'font-size': 10,
        fill: cssVar('--ink', '#222'),
        'fill-opacity': isGap ? 0.55 : 1,
      }, [shorten(art.title || art.id, 18)]));

      // tooltip
      const tip = svg('title', {}, [`${art.id || ''} · ${art.title || ''}${isGap ? ' · gap' : ''}`]);
      root.appendChild(tip);
    });
  });

  // Interchange chords for `refs`
  flatAll(a).forEach(art => {
    const src = stations[art.defines || art.id];
    if (!src) return;
    (art.refs || []).forEach(ref => {
      const dst = stations[ref];
      if (!dst) return;
      const mx = (src.x + dst.x) / 2;
      root.appendChild(svg('path', {
        d: `M ${src.x} ${src.y} Q ${mx} ${(src.y + dst.y) / 2 - 30} ${dst.x} ${dst.y}`,
        fill: 'none',
        stroke: cssVar('--ink-4', '#888'),
        'stroke-width': 0.6,
        'stroke-opacity': 0.4,
      }));
    });
  });

  host.appendChild(root);
}

function flatAll(pack) {
  const out = [];
  for (const l of LAYERS) for (const a of flatLayer(pack, l)) out.push(a);
  return out;
}

// ============================================================
// 6) Arbor — botanical of the platform.
//
// Trunk (service) branches upward into the six layers; each artefact is
// a leaf. Verified leaves glow. Gaps render as open buds.
// ============================================================

function renderArbor(host, { a, b, diff }) {
  const W = 1000, H = 600;
  const root = makeRoot(W, H, host);

  const trunkX = W / 2, baseY = H - 30, topY = 60;

  // Trunk
  root.appendChild(svg('path', {
    d: `M ${trunkX} ${baseY} L ${trunkX} ${topY + 80}`,
    stroke: cssVar('--GOV', '#4A4A4A'),
    'stroke-width': 10, 'stroke-linecap': 'round',
  }));

  // Service label at root
  root.appendChild(svg('text', {
    x: trunkX, y: baseY + 4,
    'text-anchor': 'middle',
    'font-family': "'Newsreader', serif",
    'font-style': 'italic',
    'font-size': 18,
    fill: cssVar('--ink', '#222'),
  }, [a?.name || 'service']));

  // Branches per layer, alternating left/right
  LAYERS.forEach((lid, idx) => {
    const present = flatLayer(a, lid);
    const incoming = diff?.layers?.[lid]?.onlyInB || [];

    const branchY = topY + 80 + idx * 70;
    const dir = idx % 2 === 0 ? -1 : 1;
    const branchEnd = trunkX + dir * (W / 2 - 90);

    // Branch
    root.appendChild(svg('path', {
      d: `M ${trunkX} ${branchY} Q ${trunkX + dir * 80} ${branchY - 25} ${branchEnd} ${branchY - 40}`,
      stroke: layerColor(lid),
      'stroke-width': 4, 'stroke-linecap': 'round',
      fill: 'none',
    }));
    root.appendChild(svg('text', {
      x: trunkX + dir * 60, y: branchY - 32,
      'text-anchor': dir < 0 ? 'end' : 'start',
      'font-family': "'IBM Plex Mono', monospace",
      'font-weight': 700,
      'font-size': 11,
      'letter-spacing': '0.08em',
      fill: layerColor(lid),
    }, [lid]));

    // Leaves (present)
    const total = present.length + incoming.length;
    const spread = Math.min(360, 24 * Math.max(total, 4));
    const leafStart = branchEnd - dir * spread;
    const leafStep = total > 1 ? (dir * spread) / (total - 1) : 0;

    present.forEach((art, i) => {
      const lx = leafStart + i * leafStep;
      const ly = branchY - 40 - (i % 2 === 0 ? 14 : 4);
      const fill = art.source === 'Verified' ? cssVar('--src-Verified', '#06B6D4') : layerColor(lid);
      // Leaf as ellipse
      root.appendChild(svg('ellipse', {
        cx: lx, cy: ly, rx: 9, ry: 5,
        transform: `rotate(${dir < 0 ? -20 : 20} ${lx} ${ly})`,
        fill, 'fill-opacity': art.source === 'Verified' ? 1 : 0.75,
        stroke: cssVar('--ink', '#222'), 'stroke-width': 0.4,
      }));
      // tooltip
      const tip = svg('title', {}, [`${art.id} · ${art.title || ''}\n${art.source || ''}`]);
      root.appendChild(tip);
    });

    incoming.forEach((entry, i) => {
      const lx = leafStart + (present.length + i) * leafStep;
      const ly = branchY - 40 - 6;
      // Unfurled bud — small open V
      root.appendChild(svg('path', {
        d: `M ${lx - 6} ${ly + 4} L ${lx} ${ly - 6} L ${lx + 6} ${ly + 4}`,
        stroke: cssVar('--src-Missing', '#DC2626'),
        'stroke-width': 1.5,
        fill: 'none',
        'stroke-linecap': 'round', 'stroke-linejoin': 'round',
      }));
      const tip = svg('title', {}, [`${entry.artefact?.id || entry.key} · gap (bud)`]);
      root.appendChild(tip);
    });
  });

  // Footer
  root.appendChild(svg('text', {
    x: 16, y: H - 12,
    'font-family': "'IBM Plex Mono', monospace",
    'font-size': 10,
    fill: cssVar('--ink-4', '#888'),
  }, [`Buds (red Vs) are artefacts present in ${b?.name || 'B'} but absent here.`]));

  host.appendChild(root);
}

// ============================================================
// Public dispatcher
// ============================================================

const RENDERERS = {
  strata:        renderStrata,
  periodic:      renderPeriodic,
  constellation: renderConstellation,
  skyline:       renderSkyline,
  transit:       renderTransit,
  arbor:         renderArbor,
};

export function render(variant, host, dataset, opts = {}) {
  const fn = RENDERERS[variant];
  if (!fn) {
    host.innerHTML = `<div class="placeholder">unknown atlas variant: ${escapeHtml(variant)}</div>`;
    return;
  }
  try {
    fn(host, dataset, opts);
  } catch (e) {
    host.innerHTML = `<div class="error">Atlas render failed: ${escapeHtml(e.message)}</div>`;
  }
}

export const VARIANTS = Object.keys(RENDERERS);
