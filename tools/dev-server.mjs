#!/usr/bin/env node
/**
 * tools/dev-server.mjs
 *
 * Tiny zero-dependency dev server for ObservabilityPack Studio.
 *
 * Responsibilities:
 *   1. Serve the workspace as static files (so the Studio can fetch
 *      packs/*.json and the html itself over a real http:// origin).
 *   2. Expose POST /api/mcp/refresh which proxies one round of MCP
 *      JSON-RPC calls (initialize + tools/call x N) to the configured
 *      MCP server and returns the freshly-built pack as JSON. This
 *      avoids the browser CORS wall when calling public MCP endpoints
 *      that don't send Access-Control-Allow-Origin headers.
 *
 * Usage:
 *   node tools/dev-server.mjs                 # port 8000, default MCP url
 *   PORT=4173 node tools/dev-server.mjs
 *   MCP_URL=https://your/mcp node tools/dev-server.mjs
 *
 * The browser POSTs { mcpUrl } as JSON to /api/mcp/refresh; the server
 * uses that value (falling back to env MCP_URL) so the URL field in the
 * Studio remains source-of-truth at request time.
 *
 * Requires Node 18+ (global fetch).
 */

import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { join, extname, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT      = resolve(fileURLToPath(import.meta.url), '..', '..');
const PORT      = Number(process.env.PORT || 8000);
const HOST      = process.env.HOST || '127.0.0.1';
const MCP_URL_DEFAULT = process.env.MCP_URL  || 'https://www.krystaline.io/mcp/public';
const MCP_AUTH        = process.env.MCP_AUTH || null;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js':   'text/javascript; charset=utf-8',
  '.mjs':  'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.svg':  'image/svg+xml',
  '.png':  'image/png',
  '.jpg':  'image/jpeg',
  '.ico':  'image/x-icon',
  '.md':   'text/markdown; charset=utf-8',
  '.txt':  'text/plain; charset=utf-8',
};

// ---------- MCP client (same protocol as tools/fetch-live-pack.mjs) ----------

async function mcpRoundTrip(mcpUrl) {
  let sessionId = null;
  let nextId = 1;

  async function rpc(method, params) {
    const headers = {
      'Content-Type': 'application/json',
      'Accept':       'application/json, text/event-stream',
      'MCP-Protocol-Version': '2025-06-18',
    };
    if (MCP_AUTH)  headers['Authorization'] = `Bearer ${MCP_AUTH}`;
    if (sessionId) headers['Mcp-Session-Id'] = sessionId;

    const res = await fetch(mcpUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify({ jsonrpc: '2.0', id: nextId++, method, params: params || {} }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`HTTP ${res.status} on ${method}${body ? ': ' + body.slice(0, 200) : ''}`);
    }
    const sid = res.headers.get('mcp-session-id');
    if (sid) sessionId = sid;

    const ctype = res.headers.get('content-type') || '';
    if (ctype.includes('text/event-stream')) {
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = '';
      while (true) {
        const { done, value } = await reader.read();
        if (value) buf += decoder.decode(value, { stream: true });
        const end = buf.indexOf('\n\n');
        if (end !== -1) {
          const frame = buf.slice(0, end);
          const data = frame.split('\n').filter(l => l.startsWith('data:'))
            .map(l => l.replace(/^data:\s?/, '')).join('\n');
          if (data) {
            const obj = JSON.parse(data);
            if (obj.error) throw new Error(`${method}: ${obj.error.message}`);
            return obj.result;
          }
          buf = buf.slice(end + 2);
        }
        if (done) break;
      }
      throw new Error(`${method}: SSE stream ended with no data frame`);
    }
    const obj = await res.json();
    if (obj.error) throw new Error(`${method}: ${obj.error.message}`);
    return obj.result;
  }

  async function tool(name, args) {
    const result = await rpc('tools/call', { name, arguments: args || {} });
    if (result?.isError) {
      const txt = result?.content?.map(c => c.text).filter(Boolean).join(' ') || 'tool returned isError';
      throw new Error(`${name}: ${txt}`);
    }
    const text = result?.content?.[0]?.text;
    if (typeof text !== 'string') return result;
    try { return JSON.parse(text); } catch { return text; }
  }

  await rpc('initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'observabilitypack-studio-dev-server', version: '0.1.0' },
  }).catch(() => {});

  const errors = {};
  const safe = async (name, fn) => {
    try { return await fn(); }
    catch (e) { errors[name] = e.message; return null; }
  };

  const [health, topology, anomaliesActive, baselines] = await Promise.all([
    safe('system_health',       () => tool('system_health')),
    safe('system_topology',     () => tool('system_topology')),
    safe('anomalies_active',    () => tool('anomalies_active')),
    safe('anomalies_baselines', () => tool('anomalies_baselines')),
  ]);
  await Promise.all([safe('zk_stats', () => tool('zk_stats')), safe('zk_solvency', () => tool('zk_solvency'))]);

  return { health, topology, anomaliesActive, baselines, errors };
}

// ---------- pack builder (mirrors tools/fetch-live-pack.mjs surface) ----------

function buildPack({ health, topology, anomaliesActive, baselines, errors, mcpUrl }) {
  const REFRESH_AT = new Date().toISOString();
  const live = (id, title, desc, tool, tags, source, evidence) => ({
    id, source: 'LIVE', title, desc, tool, tags,
    mcp: { verified: true, source, refreshedAt: REFRESH_AT, evidence },
  });
  const gap = (id, title, desc, tags, source, evidence) => ({
    id, source: 'GAP', title, desc, tool: '—', tags,
    mcp: { verified: false, source, refreshedAt: REFRESH_AT, evidence },
  });

  const services = health?.services || [];
  const serviceNames = services.map(s => s.name);
  const baselineCount = baselines?.baselines?.length || 0;
  const baselineNormal = (baselines?.baselines || []).filter(b => b.statusIndicator?.status === 'normal').length;
  const jaegerEdge = (topology?.dependencies || []).find(d => (d.child || '').includes('jaeger'));

  const perService = services.map((s, i) => live(
    `COL-X${i + 1}`,
    `Service: ${s.name}`,
    `Live: ${s.status}, P50 ~${Math.round(s.avgDuration || 0)}ms, ${s.spanCount || 0} spans, ${s.activeAnomalies || 0} anomalies.`,
    'OTel + Prometheus',
    ['service', 'discovered', ...((s.spanCount || 0) < 5 ? ['sparse-traces'] : [])],
    'system_health', s,
  ));

  return {
    id: 'mcp-live-' + REFRESH_AT,
    name: 'MCP Live — ' + REFRESH_AT.replace('T', ' ').slice(0, 19) + ' UTC',
    badge: 'LIVE',
    description: `Generated by dev-server from ${mcpUrl}. ${serviceNames.length} services, ${baselineCount} baselines.`,
    liveness: {
      refreshedAt: REFRESH_AT,
      mcpUrl,
      toolsCalled: ['system_health','system_topology','anomalies_active','anomalies_baselines'].filter(n => !errors[n]),
      toolsFailed: errors,
      servicesDiscovered: serviceNames,
      baselinesComputed: baselineCount,
      activeAnomalies: anomaliesActive?.traceAnomalies?.active?.length || 0,
      embedded: false,
    },
    layers: {
      L1: [],
      L2: [
        live('COL-02', 'OTel Collector pipeline',
          'OTLP receive · batch · export to Jaeger + Prometheus.',
          'OTel Collector', ['otel', 'pipeline'], 'system_health',
          { services: services.length, healthyServices: services.filter(s => s.status === 'healthy').length }),
        live('COL-03', 'Jaeger trace agent',
          `system_topology shows ${jaegerEdge?.callCount || 0} spans into jaeger from ${jaegerEdge?.parent || 'unknown'}.`,
          'Jaeger', ['traces'], 'system_topology',
          { jaegerInboundCalls: jaegerEdge?.callCount || 0, sourceService: jaegerEdge?.parent || null }),
        live('COL-05', 'Health-check probes',
          `system_health responds; ${services.length} services reporting.`,
          'kube-state-metrics', ['health'], 'system_health',
          { services: serviceNames }),
        ...perService,
      ],
      L3: [
        live('TOPO-X1', 'Live dependency map',
          `system_topology returned ${(topology?.dependencies || []).length} edges.`,
          'system_topology', ['topology', 'discovered'], 'system_topology',
          { edges: (topology?.dependencies || []).length, detail: topology?.dependencies || [] }),
      ],
      L4: {
        policy: [],
        alerting: anomaliesActive ? [
          live('ALR-07', 'Anomaly detector (trace)',
            `anomalies_active: ${anomaliesActive?.traceAnomalies?.active?.length || 0} active anomalies.`,
            'otel-mcp anomalies', ['alert', 'anomaly'], 'anomalies_active',
            {
              traceAnomaliesActive: anomaliesActive?.traceAnomalies?.active?.length || 0,
              traceAnomaliesRecent: anomaliesActive?.traceAnomalies?.recentCount || 0,
              amountDetectorEnabled: !!anomaliesActive?.amountAnomalies?.enabled,
            }),
        ] : [],
        healing: [],
      },
      L5: baselines ? [
        live('VAL-01', 'Anomaly baselines (live)',
          `anomalies_baselines: ${baselineCount} baselines computed, ${baselineNormal} status=normal.`,
          'otel-mcp-server', ['anomaly', 'verified'], 'anomalies_baselines',
          { totalBaselines: baselineCount, normalStatus: baselineNormal }),
      ] : [],
      GOV: [
        live('GOV-01', 'MCP-driven reports',
          'MCP tools reachable; studio is itself a consumer.',
          'otel-mcp-server', ['report', 'meta'], 'mcp.reachable',
          {
            toolsReachable: ['system_health','system_topology','anomalies_active','anomalies_baselines'].filter(n => !errors[n]),
            toolsFailed: Object.keys(errors),
          }),
        ...(errors['zk_stats'] || errors['zk_solvency'] ? [
          gap('GOV-02', 'ZK proof verification logs',
            'zk_stats / zk_solvency unavailable on the public MCP surface.',
            ['compliance', 'crypto', 'endpoint-missing'], 'zk_stats',
            { errors: { zk_stats: errors['zk_stats'], zk_solvency: errors['zk_solvency'] } }),
        ] : []),
      ],
    },
  };
}

// ---------- HTTP server ----------

async function serveStatic(req, res) {
  let urlPath = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  if (urlPath === '/') urlPath = '/index.html';
  // Prevent directory traversal outside ROOT
  const safe = normalize(urlPath).replace(/^([\\/])+/, '');
  const filePath = join(ROOT, safe);
  if (!filePath.startsWith(ROOT)) {
    res.writeHead(403); res.end('forbidden'); return;
  }
  try {
    const s = await stat(filePath);
    if (s.isDirectory()) {
      res.writeHead(403); res.end('directory listing disabled'); return;
    }
    const buf = await readFile(filePath);
    const mime = MIME[extname(filePath).toLowerCase()] || 'application/octet-stream';
    res.writeHead(200, {
      'Content-Type': mime,
      'Cache-Control': 'no-store',
    });
    res.end(buf);
  } catch (e) {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('not found: ' + urlPath);
  }
}

async function handleMcpRefresh(req, res) {
  let body = '';
  for await (const chunk of req) body += chunk;
  let parsed = {};
  try { parsed = body ? JSON.parse(body) : {}; } catch {}
  const mcpUrl = (parsed && typeof parsed.mcpUrl === 'string' && parsed.mcpUrl.trim()) || MCP_URL_DEFAULT;

  const t0 = Date.now();
  try {
    process.stderr.write(`[dev-server] /api/mcp/refresh → ${mcpUrl}\n`);
    const fetched = await mcpRoundTrip(mcpUrl);
    const pack = buildPack({ ...fetched, mcpUrl });
    process.stderr.write(
      `[dev-server]   ok in ${Date.now() - t0}ms · services=${pack.liveness.servicesDiscovered.length}` +
      ` baselines=${pack.liveness.baselinesComputed}` +
      ` failed=${Object.keys(pack.liveness.toolsFailed).join(',') || 'none'}\n`
    );
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(pack));
  } catch (e) {
    process.stderr.write(`[dev-server]   error: ${e.message}\n`);
    res.writeHead(502, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ error: e.message, mcpUrl }));
  }
}

const server = createServer(async (req, res) => {
  // Permit any origin (dev only) — useful if studio is loaded from another port.
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  const url = new URL(req.url, 'http://x');
  if (req.method === 'POST' && url.pathname === '/api/mcp/refresh') {
    return handleMcpRefresh(req, res);
  }
  if (req.method === 'GET' && url.pathname === '/api/mcp/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, mcpUrl: MCP_URL_DEFAULT }));
    return;
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405); res.end('method not allowed'); return;
  }
  return serveStatic(req, res);
});

server.listen(PORT, HOST, () => {
  process.stderr.write(
    `[dev-server] listening on http://${HOST}:${PORT}\n` +
    `[dev-server]   studio: http://${HOST}:${PORT}/studio/observabilitypack-studio.html\n` +
    `[dev-server]   mcp proxy: POST http://${HOST}:${PORT}/api/mcp/refresh   default → ${MCP_URL_DEFAULT}\n`
  );
});
