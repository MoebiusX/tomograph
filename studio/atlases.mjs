// studio/atlases.mjs
//
// Atlas renderers — visual metaphors for the same pair of packs:
//
//   - strata   — geological cross-section (Cuvier 1812 / Lyell 1830 / USGS)
//   - periodic — Mendeleev's table (every artefact a cell; dashed = gap)
//
// Constellation, Skyline, Transit, and Arbor are reserved for follow-up
// PRs. They were retired in Phase 3a and are being restored two at a
// time; only strata and periodic are wired in this iteration so the
// variant selector doesn't surface placeholder/half-baked versions.
//
// Each renderer takes (host, dataset, opts) where dataset is
//   { a: layeredPack, b: layeredPack, diff: diffResult }.
// opts.onArtefactClick(artefact, layerId) opens the drawer in app.mjs.

const LAYERS = ['L1', 'L2', 'L3', 'L4', 'L5', 'GOV'];

const LAYER_NAMES = {
  L1: 'Contract',
  L2: 'Telemetry',
  L3: 'Insight',
  L4: 'Action',
  L5: 'Validation',
  GOV: 'Governance',
};

// Layer hex palette mirroring the CSS variables — SVG attributes need
// explicit colors at definition time so we can build patterns/gradients
// against them. Kept in sync with :root in app.css.
const C = {
  L1:  '#C97700', L2:  '#2E75B6', L3:  '#006B6B',
  L4:  '#A22323', L5:  '#5B2C82', GOV: '#4A4A4A',
};
const CBG = {
  L1:  '#FFF4E0', L2:  '#E5ECF5', L3:  '#DBEEEE',
  L4:  '#F8DCDC', L5:  '#ECE0F4', GOV: '#E8E8E8',
};
const SRC_MISSING = '#DC2626';
const SRC_ADDED   = '#16A34A';

export const ATLAS_META = {
  strata: {
    title: 'Stratigraphy of the platform',
    lede: 'Read the layers like rock. Where the silhouette is jagged, something is missing. The right column shows the layer-stack the architecture is meant to be — clean parallelograms floating on dashed datum, after Cuvier and Lyell.',
  },
  periodic: {
    title: 'A periodic table of observability',
    lede: 'Every artefact gets a cell. Dashed cells are gaps — Mendeleev predicted gallium from a hole in his 1869 table; we do the same with missing recording rules and chaos coverage. Stripes encode the source.',
  },
  // The four below are intentionally not exported via VARIANTS yet —
  // they'll come back as their faithful ports land.
  constellation: { title: 'The night sky of the platform',  lede: 'Coming in the next restoration PR.' },
  skyline:       { title: 'The maturity skyline',           lede: 'Coming in the next restoration PR.' },
  transit:       { title: 'The platform as a transit network', lede: 'Coming in a later restoration PR.' },
  arbor:         { title: 'A botanical of the platform',     lede: 'Coming in a later restoration PR.' },
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

function allArtefacts(pack) {
  const out = [];
  for (const l of LAYERS) for (const a of flatLayer(pack, l)) out.push(a);
  return out;
}

// Canonical key — matches by `defines` when possible so the same SLI in
// two different packs is recognised as the same artefact even though its
// positional ID (SLI-NN) differs.
function keyOf(art) {
  if (!art) return null;
  return art.defines || art.id;
}

function escapeHtml(s) {
  if (s == null) return '';
  return String(s).replaceAll('&', '&amp;').replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;');
}

// ============================================================
// 1) STRATIGRAPHY — geological cross-section.
//
// Two stacks of layer bands, current on the left and target on the right.
// Left bands have hatching fills + jagged top edges (slight waviness) +
// notches carved upward for each "missing" artefact (items B has and A
// doesn't, per the diff). Right bands are clean parallelograms with a
// subtle isometric skew, filled with a per-layer linear gradient and
// drop-shadowed via an SVG filter. A central bridge calls out the
// migration math: how many artefacts to add, how many gaps to close.
//
// Inspired by Cuvier 1812, Lyell 1830, USGS strata columns.
// ============================================================

function renderStrata(host, { a, b, diff }, opts = {}) {
  if (!a || !b) {
    host.innerHTML = '<div class="placeholder">Pick a Pack B to render the strata.</div>';
    return;
  }
  const A = a, B = b;
  const onClick = opts.onArtefactClick;

  // Per-layer "list" for A's silhouette: present items + injected gap
  // markers (one per onlyInB diff entry) so notches carve into the band.
  function aSilhouetteList(L) {
    const present = flatLayer(A, L);
    const gaps = (diff?.layers?.[L]?.onlyInB || []).map(e => ({
      ...e.artefact,
      _isGap: true,
    }));
    return [...present, ...gaps];
  }

  function layerStats(pack, L) {
    const list = flatLayer(pack, L);
    return { list, count: list.length };
  }

  const VB_W = 1100, VB_H = 600;
  const PAD_L = 30, PAD_R = 30, PAD_T = 30;
  const COL_W = (VB_W - PAD_L - PAD_R - 200) / 2;
  const LEFT_X = PAD_L;
  const RIGHT_X = PAD_L + COL_W + 200;
  const STACK_TOP = PAD_T + 40;
  const STACK_H = VB_H - STACK_TOP - 80;
  const BAND_H = STACK_H / LAYERS.length - 6;

  // ---- jagged silhouette path (current/left) ----
  function jaggedPath(x, y, w, h, list) {
    if (!list.length) return `M ${x} ${y} L ${x+w} ${y} L ${x+w} ${y+h} L ${x} ${y+h} Z`;
    const n = list.length;
    const cw = w / n;
    let d = `M ${x} ${y}`;
    const segs = 6;
    for (let s = 1; s <= segs; s++) {
      const tx = x + (w * s / segs);
      const wave = Math.sin(s * 1.7 + x * 0.003) * 1.2;
      d += ` L ${tx} ${y + wave}`;
    }
    d += ` L ${x+w} ${y+h}`;
    for (let i = n - 1; i >= 0; i--) {
      const segX0 = x + i * cw;
      const segX1 = x + (i + 1) * cw;
      const item = list[i];
      if (item._isGap) {
        const mid = (segX0 + segX1) / 2;
        const depth = h * (0.55 + (i % 3) * 0.08);
        const lipL = segX1 - cw * 0.10;
        const lipR = segX0 + cw * 0.10;
        const peakY = y + h - depth;
        d += ` L ${lipL} ${y + h}`;
        d += ` L ${mid + cw*0.10} ${peakY + h*0.18}`;
        d += ` L ${mid - cw*0.04} ${peakY}`;
        d += ` L ${mid - cw*0.14} ${peakY + h*0.10}`;
        d += ` L ${lipR} ${y + h}`;
      }
      d += ` L ${segX0} ${y + h}`;
    }
    d += ` Z`;
    return d;
  }

  function targetPath(x, y, w, h, skew) {
    return `M ${x + skew} ${y} L ${x + w} ${y} L ${x + w - skew} ${y + h} L ${x} ${y + h} Z`;
  }

  // ---- defs: hatching + gradient + shadow + bedrock ----
  const defs = `
    <defs>
      ${LAYERS.map(L => `
        <pattern id="hatch-${L}" patternUnits="userSpaceOnUse" width="6" height="6" patternTransform="rotate(45)">
          <rect width="6" height="6" fill="${CBG[L]}" />
          <line x1="0" y1="0" x2="0" y2="6" stroke="${C[L]}" stroke-width="0.6" opacity="0.30"/>
        </pattern>
        <linearGradient id="tg-${L}" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%"   stop-color="${C[L]}" stop-opacity="0.95"/>
          <stop offset="100%" stop-color="${C[L]}" stop-opacity="0.75"/>
        </linearGradient>
      `).join('')}
      <filter id="softShadow" x="-20%" y="-20%" width="140%" height="140%">
        <feGaussianBlur in="SourceAlpha" stdDeviation="3"/>
        <feOffset dx="0" dy="4" result="off"/>
        <feComponentTransfer><feFuncA type="linear" slope="0.18"/></feComponentTransfer>
        <feMerge><feMergeNode/><feMergeNode in="SourceGraphic"/></feMerge>
      </filter>
      <pattern id="bedrock" patternUnits="userSpaceOnUse" width="8" height="8">
        <rect width="8" height="8" fill="#F1ECE0"/>
        <path d="M 0 8 L 8 0" stroke="#C8C0AC" stroke-width="0.6"/>
      </pattern>
    </defs>`;

  let svg = `<svg viewBox="0 0 ${VB_W} ${VB_H}" class="strata-svg atlas-svg" xmlns="http://www.w3.org/2000/svg" font-family="IBM Plex Sans, system-ui">${defs}`;

  // ---- column headers ----
  svg += `
    <text x="${LEFT_X + COL_W/2}" y="${PAD_T - 2}" text-anchor="middle"
      style="font-family:'IBM Plex Mono', monospace; font-size:11px; letter-spacing:0.18em; text-transform:uppercase; fill:#6B6B6B;">Present State</text>
    <text x="${LEFT_X + COL_W/2}" y="${PAD_T + 22}" text-anchor="middle"
      style="font-family:'Newsreader', serif; font-style:italic; font-size:18px; fill:#1F3A5F;">${escapeHtml(A.name)}</text>
    <text x="${RIGHT_X + COL_W/2}" y="${PAD_T - 2}" text-anchor="middle"
      style="font-family:'IBM Plex Mono', monospace; font-size:11px; letter-spacing:0.18em; text-transform:uppercase; fill:#6B6B6B;">Target State</text>
    <text x="${RIGHT_X + COL_W/2}" y="${PAD_T + 22}" text-anchor="middle"
      style="font-family:'Newsreader', serif; font-style:italic; font-size:18px; fill:#1F3A5F;">${escapeHtml(B.name)}</text>
  `;

  // ---- bedrock + sky datum lines ----
  const bedY = STACK_TOP + STACK_H + 6;
  svg += `
    <rect x="${LEFT_X}" y="${bedY}" width="${COL_W}" height="20" fill="url(#bedrock)" opacity="0.6"/>
    <line x1="${LEFT_X}" y1="${bedY}" x2="${LEFT_X + COL_W}" y2="${bedY}" stroke="#8B8472" stroke-width="0.6"/>
    <line x1="${RIGHT_X}" y1="${PAD_T + 40}" x2="${RIGHT_X + COL_W}" y2="${PAD_T + 40}" stroke="#D4D9DF" stroke-width="0.6" stroke-dasharray="2 4"/>
    <text x="${RIGHT_X}" y="${PAD_T + 36}" style="font-family:'Newsreader', serif; font-style:italic; font-size:10px; fill:#9BA3AD;">— ideal datum —</text>
  `;

  // ---- bands ----
  let totalAddedAll = 0, totalGapsAll = 0;

  LAYERS.forEach((L, idx) => {
    const sa = layerStats(A, L);
    const sb = layerStats(B, L);
    const aList = aSilhouetteList(L);
    const gapsHere = aList.filter(x => x._isGap).length;
    const addedHere = Math.max(0, sb.count - sa.count);
    totalAddedAll += addedHere;
    totalGapsAll += gapsHere;

    const yTop = STACK_TOP + idx * (BAND_H + 6);

    // CURRENT — jagged, hatched
    const dPath = jaggedPath(LEFT_X, yTop, COL_W, BAND_H, aList);
    svg += `
      <g class="strata-band current" data-layer="${L}" data-side="current">
        <path d="${dPath}" fill="url(#hatch-${L})" stroke="${C[L]}" stroke-width="1.3" stroke-linejoin="round"/>
        <text x="${LEFT_X + 8}" y="${yTop + 14}" style="fill:${C[L]}; font-weight:700; font-family:'IBM Plex Mono', monospace; font-size:11px; letter-spacing:0.04em;">${L} · ${LAYER_NAMES[L].toUpperCase()}</text>
        <text x="${LEFT_X + COL_W - 8}" y="${yTop + 14}" text-anchor="end"
          style="font-family:'IBM Plex Mono', monospace; font-size:10px; fill:#4A4A4A;">${sa.count} present · ${gapsHere ? gapsHere + ' missing' : 'no gaps'}</text>
      </g>
    `;

    // Gap tag pins under the current band
    if (gapsHere > 0) {
      const gaps = aList.filter(x => x._isGap).slice(0, 3);
      gaps.forEach((g, gi) => {
        const gx = LEFT_X + 16 + gi * (COL_W / Math.min(gapsHere + 1, 4));
        const gy = yTop + BAND_H - 4;
        svg += `
          <g>
            <circle cx="${gx}" cy="${gy + 12}" r="2.2" fill="${SRC_MISSING}"/>
            <line x1="${gx}" y1="${gy}" x2="${gx}" y2="${gy + 10}" stroke="${SRC_MISSING}" stroke-width="0.8" stroke-dasharray="1.5 1.5"/>
          </g>`;
      });
    }

    // TARGET — clean isometric ribbon
    const skew = 12;
    const tPath = targetPath(RIGHT_X, yTop, COL_W, BAND_H, skew);
    svg += `
      <g class="strata-band target" data-layer="${L}" data-side="target" filter="url(#softShadow)">
        <path d="${tPath}" fill="url(#tg-${L})" stroke="${C[L]}" stroke-width="1.2" stroke-linejoin="miter"/>
        <text x="${RIGHT_X + 18}" y="${yTop + 16}" style="font-family:'Newsreader', serif; font-style:italic; font-size:13px; fill:#fff; font-weight:500;">${L} · ${LAYER_NAMES[L]}</text>
        <text x="${RIGHT_X + COL_W - 8}" y="${yTop + 16}" text-anchor="end"
          style="font-family:'IBM Plex Mono', monospace; font-size:10px; fill:#fff; opacity:0.92;">${sb.count} artefacts</text>
        ${addedHere > 0 ? `
          <text x="${RIGHT_X + COL_W - 8}" y="${yTop + BAND_H - 8}" text-anchor="end"
            style="font-family:'IBM Plex Mono', monospace; font-size:10px; fill:#ECFCEF; font-weight:600;">+${addedHere} new</text>` : ''}
      </g>
    `;
  });

  // ---- central bridge ----
  const bridgeX = LEFT_X + COL_W + 30;
  const bridgeY = STACK_TOP + STACK_H / 2;
  svg += `
    <g>
      <text x="${bridgeX + 70}" y="${STACK_TOP + 12}" text-anchor="middle"
        style="font-family:'IBM Plex Mono', monospace; font-size:9.5px; letter-spacing:0.10em; fill:#6B6B6B; text-transform:uppercase;">Migration</text>
      <line x1="${bridgeX}" y1="${STACK_TOP + 40}" x2="${bridgeX + 140}" y2="${STACK_TOP + 40}" stroke="#1F3A5F" stroke-width="0.8"/>
      <path d="M ${bridgeX + 130} ${STACK_TOP + 36} L ${bridgeX + 140} ${STACK_TOP + 40} L ${bridgeX + 130} ${STACK_TOP + 44}" fill="none" stroke="#1F3A5F" stroke-width="0.8"/>
      <text x="${bridgeX + 70}" y="${bridgeY - 30}" text-anchor="middle"
        style="font-family:'Newsreader', serif; font-style:italic; font-size:13px; fill:#1F3A5F;">close the gap</text>
      <text x="${bridgeX + 70}" y="${bridgeY}" text-anchor="middle"
        style="font-family:'Newsreader', serif; font-size:34px; font-weight:500; fill:${SRC_ADDED}; font-variant-numeric:tabular-nums;">+${totalAddedAll}</text>
      <text x="${bridgeX + 70}" y="${bridgeY + 18}" text-anchor="middle"
        style="font-family:'IBM Plex Mono', monospace; font-size:10px; letter-spacing:0.08em; fill:#6B6B6B;">artefacts to add</text>
      <text x="${bridgeX + 70}" y="${bridgeY + 60}" text-anchor="middle"
        style="font-family:'Newsreader', serif; font-size:26px; font-weight:500; fill:${SRC_MISSING}; font-variant-numeric:tabular-nums;">${totalGapsAll}</text>
      <text x="${bridgeX + 70}" y="${bridgeY + 78}" text-anchor="middle"
        style="font-family:'IBM Plex Mono', monospace; font-size:10px; letter-spacing:0.08em; fill:#6B6B6B;">gaps to close</text>
    </g>
  `;

  // ---- caption ----
  svg += `
    <text x="${VB_W/2}" y="${VB_H - 30}" text-anchor="middle"
      style="font-family:'Newsreader', serif; font-style:italic; font-size:13px; fill:#6B6B6B;">
      Each notch in the left-hand strata is an artefact missing from ${escapeHtml(A.name)}.
      The right column shows the layer-stack ${escapeHtml(B.name)} is meant to be.
    </text>
    <text x="${VB_W/2}" y="${VB_H - 12}" text-anchor="middle"
      style="font-family:'IBM Plex Mono', monospace; font-size:9.5px; letter-spacing:0.12em; fill:#9BA3AD; text-transform:uppercase;">
      after Cuvier · Lyell · USGS
    </text>
  `;

  svg += `</svg>`;

  host.innerHTML = `
    <div class="strata-wrap">${svg}</div>
    <div class="strata-legend">
      Click any layer band to open the drawer for its first artefact.
      Notches on the left represent items present in <code>${escapeHtml(B.name)}</code> but absent from <code>${escapeHtml(A.name)}</code>.
      Ribbons on the right are scaled to <code>${escapeHtml(B.id)}</code>.
    </div>
  `;

  // Wire clicks
  host.querySelectorAll('.strata-band').forEach(el => {
    el.addEventListener('click', () => {
      const L = el.dataset.layer;
      const side = el.dataset.side;
      const pack = side === 'current' ? A : B;
      const list = flatLayer(pack, L);
      const target = list[0];
      if (target && onClick) onClick(target, L);
    });
  });
}

// ============================================================
// 2) PERIODIC — Mendeleev's table of observability elements.
//
// HTML/CSS-based grid. Two sides (current + target). Each row is a layer
// (L1..GOV). Each cell is an artefact, with:
//   - a coloured source stripe down the left edge
//   - an "atomic number" (stable counter per artefact ID across both packs)
//   - a 1-2 letter "element symbol" derived from the title
//   - the truncated title beneath
// Dashed cells (`.empty`) are gaps — items the other pack has and this one
// doesn't. Cells marked `.added` show up only on the target side and are
// flagged with a ★ in the corner. Clicking any cell opens the drawer.
// ============================================================

function renderPeriodic(host, { a, b }, opts = {}) {
  if (!a || !b) {
    host.innerHTML = '<div class="placeholder">Pick a Pack B to render the periodic table.</div>';
    return;
  }
  const A = a, B = b;
  const onClick = opts.onArtefactClick;

  function symbolFor(title) {
    if (!title) return '··';
    const cleaned = String(title).replace(/[—–·:].*/, '').trim();
    const words = cleaned.split(/\s+/).filter(w => w.length > 1 &&
      !/^(the|of|and|a|an|to|for|in|on|at|by)$/i.test(w));
    if (words.length >= 2) return (words[0][0] + words[1][0]).toUpperCase();
    if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
    return cleaned.slice(0, 2).toUpperCase();
  }

  // Stable atomic numbers across both sides — assign in the order we see
  // each canonical key for the first time.
  const numberMap = new Map();
  let counter = 1;
  function num(key) {
    if (!numberMap.has(key)) numberMap.set(key, counter++);
    return numberMap.get(key);
  }

  // Pre-seed counter from A so its numbering reads first.
  for (const L of LAYERS) for (const it of flatLayer(A, L)) num(keyOf(it));
  for (const L of LAYERS) for (const it of flatLayer(B, L)) num(keyOf(it));

  // For each side, build a per-layer list that includes:
  //   - real items in this pack (filled cells)
  //   - "gap" items the OTHER pack has and this one doesn't (dashed cells)
  function rowsFor(pack, otherPack, side) {
    const otherKeys = new Set(allArtefacts(otherPack).map(keyOf));
    return LAYERS.map(L => {
      const here = flatLayer(pack, L);
      const otherHere = flatLayer(otherPack, L);
      const hereKeys = new Set(here.map(keyOf));
      const missingHere = otherHere.filter(o => !hereKeys.has(keyOf(o)))
        .map(o => ({ ...o, _isGap: true }));
      const list = [...here, ...missingHere];
      const present = here.length;
      const tot = list.length;
      const pct = tot ? Math.round(100 * present / tot) : 0;

      const cells = list.map(item => {
        const isGap = !!item._isGap;
        const isAdded = side === 'target' && !otherKeys.has(keyOf(item)) && !isGap;
        const classes = ['pcell', `row-${L}`, `src-${(item.source || 'Declared')}`];
        if (isGap)   classes.push('empty');
        if (isAdded) classes.push('added');
        return `
          <button type="button" class="${classes.join(' ')}"
                  data-key="${escapeHtml(keyOf(item))}" data-layer="${L}"
                  data-side="${side}" title="${escapeHtml(item.title || item.id)}">
            <span class="pstripe" style="background:${isGap ? SRC_MISSING : C[L]}"></span>
            <span class="pnum">${num(keyOf(item))}</span>
            <span class="psym">${escapeHtml(symbolFor(item.title || item.id))}</span>
            <span class="pname">${escapeHtml(shorten(item.title || item.id, 22))}</span>
            ${isAdded ? '<span class="pstar" aria-hidden="true">★</span>' : ''}
          </button>`;
      }).join('');

      return `
        <div class="periodic-row" data-layer="${L}">
          <div class="periodic-row-label" style="color:${C[L]}">${L}<span class="pct">${pct}%</span></div>
          <div class="periodic-cells">${cells}</div>
        </div>
      `;
    }).join('');
  }

  function renderSide(pack, otherPack, side) {
    const all = allArtefacts(pack).length;
    const otherKeys = new Set(allArtefacts(otherPack).map(keyOf));
    const matched = allArtefacts(pack).filter(it => otherKeys.has(keyOf(it))).length;
    const pct = all ? Math.round(100 * matched / all) : 0;
    return `
      <div class="periodic-side" data-side="${side}">
        <div class="periodic-head">
          <div class="label">${side === 'current' ? 'Present State' : 'Target State'}</div>
          <div class="name">${escapeHtml(pack.name)}</div>
          <div class="coverage"><strong>${matched}</strong>/${all} · ${pct}% in common</div>
        </div>
        <div class="periodic-rows">${rowsFor(pack, otherPack, side)}</div>
      </div>
    `;
  }

  host.innerHTML = `
    <div class="periodic-wrap">
      ${renderSide(A, B, 'current')}
      ${renderSide(B, A, 'target')}
      <div class="periodic-foot">
        Dashed cells are <strong>gaps</strong> — the periodic equivalent of the holes Mendeleev left for undiscovered elements.
        Cells marked with ★ are <strong>added</strong> in the target side. The colour stripe is the layer.
      </div>
    </div>
  `;

  // Wire clicks
  host.querySelectorAll('.pcell').forEach(el => {
    el.addEventListener('click', () => {
      const key = el.dataset.key;
      const layer = el.dataset.layer;
      const side = el.dataset.side;
      const pack = side === 'current' ? A : B;
      // Match by canonical key first; if not present (gap), open the
      // other pack's version since that's where the artefact lives.
      const here = flatLayer(pack, layer).find(it => keyOf(it) === key);
      if (here) return onClick && onClick(here, layer);
      const other = flatLayer(side === 'current' ? B : A, layer).find(it => keyOf(it) === key);
      if (other) return onClick && onClick(other, layer);
    });
  });
}

function shorten(s, n) {
  if (!s) return '';
  s = String(s);
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

// ============================================================
// Public dispatcher
// ============================================================

const RENDERERS = {
  strata:   renderStrata,
  periodic: renderPeriodic,
};

export function render(variant, host, dataset, opts = {}) {
  const fn = RENDERERS[variant];
  if (!fn) {
    host.innerHTML = `<div class="placeholder">${escapeHtml(variant)} — coming in a follow-up restoration PR.</div>`;
    return;
  }
  try {
    fn(host, dataset, opts);
  } catch (e) {
    host.innerHTML = `<div class="error">Atlas render failed: ${escapeHtml(e.message)}</div>`;
    console.error('[atlas]', e);
  }
}

// Only export the variants we actually ship. constellation/skyline/transit/
// arbor return to VARIANTS as their faithful ports land.
export const VARIANTS = Object.keys(RENDERERS);
