// studio/artifact-model.mjs
//
// Shared client-side artifact helpers used by Diagnose, Remediate, and the
// deploy modal. Keep identity and row expansion in one place so the counts the
// user sees in the plan match the rows they are asked to deploy.

function nonEmptyString(value) {
  const s = typeof value === 'string' ? value.trim() : '';
  return s || null;
}

export function prettyDiffKey(key) {
  const raw = String(key || '');
  const short = raw.includes(':') ? raw.slice(raw.indexOf(':') + 1) : raw;
  if (/^\{.*\}$/.test(short)) {
    try {
      const parsed = JSON.parse(short);
      if (parsed.id) return String(parsed.id);
      if (parsed.record) return String(parsed.record);
      if (parsed.slo) return `burn-rate alert: ${parsed.slo}`;
      if (parsed.severity) return `${String(parsed.severity).toUpperCase()} route`;
      if (parsed.signal && parsed.target) return `${parsed.signal}: ${parsed.target}`;
      if (parsed.name) return String(parsed.name);
    } catch (_) {}
  }
  return short || raw;
}

export function artefactLabel(art, fallback = '-') {
  const title = nonEmptyString(art?.title);
  if (title) return title;
  const defines = nonEmptyString(art?.defines);
  if (defines) return defines.split('.').pop() || defines;
  const id = nonEmptyString(art?.id);
  if (id) return id;
  return fallback;
}

export function diffEntryLabel(entry) {
  const art = entry?.artefact || entry?.a || entry?.b;
  return artefactLabel(art, prettyDiffKey(entry?.key));
}

// Is this layered artefact part of the deployable Grafana surface, and if so
// what identity does the deploy manifest key it by? Mirrors
// tools/lib/compile.mjs::compileCatalog and catalogToDeployManifest below.
export function deploySurfaceForArtefact(art) {
  const id = String(art?.id || '').toUpperCase();
  const defines = String(art?.defines || '');

  if (/^SLO-/.test(id) || defines.startsWith('slos.')) {
    const identity = artefactLabel(art, defines.replace(/^slos\./, '') || null);
    return {
      deployable: !!identity,
      kind: 'rules',
      identity,
      deployRows: 2,
      deployLabel: '2 rule artefacts',
    };
  }

  if (/^QRY-/.test(id)) {
    const identity = artefactLabel(art, null);
    return {
      deployable: !!identity,
      kind: 'rules',
      identity,
      deployRows: 1,
      deployLabel: 'recording rule',
    };
  }

  if (/^DASH-/.test(id) || defines.startsWith('dashboards.')) {
    const identity = defines.replace(/^dashboards\./, '') || artefactLabel(art, null);
    return {
      deployable: !!identity,
      kind: 'dashboard',
      identity,
      deployRows: 1,
      deployLabel: 'dashboard',
    };
  }

  return { deployable: false, kind: null, identity: null, deployRows: 0, deployLabel: null };
}

export function deploySelectionFromEntries(entries, deselected = new Set()) {
  const identities = new Set();
  let rows = 0;
  for (const e of entries || []) {
    if (!e?.deployable || !e.identity || deselected.has(e.identity) || identities.has(e.identity)) continue;
    identities.add(e.identity);
    rows += e.deployRows || 1;
  }
  return { identities, rows };
}

// Map a compile catalog (groups -> items) to a flat manifest with per-row
// deploy semantics. Rules' per-SLO items expand into separate recording and
// alerting rows so the type filter and Remediate counts remain honest.
export function catalogToDeployManifest(catalog) {
  const out = [];
  for (const g of (catalog?.groups || [])) {
    const deployable = g.flavors?.some(f => f.deployable);
    if (g.id === 'rules') {
      for (const it of (g.items || [])) {
        if (it.kind === 'rules-slo') {
          out.push({
            key: `rules:recording:slo:${it.sloId}`,
            type: 'recording',
            name: `${it.label} (recording rules)`,
            id: it.sloId,
            group: 'rules',
            flavor: 'prometheus',
            artifact: `slo:${it.sloId}`,
            scope: 'recording',
            deployable,
            source: 'Repo',
          });
          out.push({
            key: `rules:alert:slo:${it.sloId}`,
            type: 'alert',
            name: `${it.label} (burn-rate alerts)`,
            id: it.sloId,
            group: 'rules',
            flavor: 'prometheus',
            artifact: `slo:${it.sloId}`,
            scope: 'alerting',
            deployable,
            source: 'Repo',
          });
        } else if (it.kind === 'rules-declared') {
          out.push({
            key: `rules:recording:declared:${it.ruleIndex}`,
            type: 'recording',
            name: it.label,
            id: it.ruleName || it.id,
            group: 'rules',
            flavor: 'prometheus',
            artifact: `declared:${it.ruleIndex}`,
            scope: 'recording',
            deployable,
            source: 'Repo',
          });
        }
      }
    } else if (g.id === 'dashboards') {
      for (const it of (g.items || [])) {
        if (it.kind !== 'dashboard') continue;
        out.push({
          key: `dashboards:${it.dashboardId}`,
          type: 'dashboard',
          name: it.label,
          id: it.dashboardId,
          subtitle: it.subtitle,
          group: 'dashboards',
          flavor: 'grafana',
          dashboardId: it.dashboardId,
          deployable,
          source: 'Repo',
        });
      }
    }
  }
  return out;
}
