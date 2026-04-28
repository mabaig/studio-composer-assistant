/**
 * reviewer.js — FlexiPage code reviewer (ported from flexipro-code-reviewer.py)
 * Runs structural, reference, script, credential, API, and guard checks on a
 * single flexipage JSON object. Returns structured pass/fail findings.
 */

'use strict';

// ─── Regex constants ─────────────────────────────────────────────
const SCRIPT_MARKERS       = ['script:', 'groovy:'];
const GLOSSARY_IGNORE      = new Set(['webservice', 'div', 'page']);
const SEVERITY_RANK        = { LOW: 1, MEDIUM: 2, HIGH: 3 };
const ORACLE_URL_RX        = /oraclecloudapps\.com|oraclecloud\.com|fusion\.oracle\.com|fscmRestApi/i;
const FIELDS_RX            = /\bfields=/i;
const ONLY_DATA_RX         = /\bonlyData\s*=\s*true/i;
const LIMIT_RX             = /\blimit\s*=/i;
const PLACEHOLDER_ONLY_RX  = /^\s*\$\{[^}]+\}\s*$/;
const BASIC_TOKEN_RX       = /\bBasic\s+[A-Za-z0-9+/=]{12,}\b/i;
const BEARER_TOKEN_RX      = /\bBearer\s+[A-Za-z0-9._\-]{20,}\b/i;
const EMPTY_CATCH_RX       = /catch\s*\([^)]*\)\s*\{([^{}]*(?:\{[^{}]*\}[^{}]*)*)\}/gi;
const COMMIT_RX_LIST       = [/\bsetAutoCommit\s*\(\s*false\s*\)/i, /\bcommit\s*\(\s*\)/i];
const CALL_WS_RX           = /\b([A-Za-z_][A-Za-z0-9_]*)\s*\.\s*callWebService\s*\(/g;
const GET_RAW_RX           = /\b([A-Za-z_][A-Za-z0-9_]*)\s*\.\s*getRawResponse\s*\(/g;
const GET_CODE_RX          = /\b([A-Za-z_][A-Za-z0-9_]*)\s*\.\s*getResponseCode\s*\(/;
const ARRAY_IDX0_RX        = /getJSONArray\s*\(\s*['"]([^'"]+)['"]\s*\)\s*\.get\w*\s*\(\s*0\b/gi;
const PUT_OBJECT_RX        = /\b(?:flexi\.)?put(?:Session)?Object\s*\(\s*['"]([A-Z0-9_]+)['"]/g;
const PLACEHOLDER_RX       = /\$\{([^}]+)\}/g;
const RUNTIME_PREFIXES     = ['ORACLE_','CURRENT_','ACCESS_','SCM_','SESSION_','USER_','AUTH_','BEARER_','REST_'];
const RUNTIME_EXACT        = new Set(['CURRENT_TIMESTAMP','INPUT']);
const LOV_HINT_RX          = /\bLike\b|\bLIKE\b|%/;

// ─── Tree traversal ───────────────────────────────────────────────
function* iterNodes(node, pageId = '', pageTitle = '') {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    for (const child of node) yield* iterNodes(child, pageId, pageTitle);
    return;
  }
  const typeLow = String(node.type || '').trim().toLowerCase();
  const props   = (node.properties && typeof node.properties === 'object') ? node.properties : {};
  let pid = pageId, ptitle = pageTitle;
  if (typeLow === 'page') {
    pid    = String(props.id    || pageId);
    ptitle = String(props.title || pageTitle);
  }
  yield { node, typeLow, props, pageId: pid, pageTitle: ptitle };
  for (const val of Object.values(node)) {
    if (val && typeof val === 'object') yield* iterNodes(val, pid, ptitle);
  }
}

function collectArtifacts(root) {
  const uiNodes = [], wsNodes = [], scriptNodes = [], idNodes = [];
  const pageNodes = [], wsRefs = [], functionNodes = [];

  for (const ctx of iterNodes(root)) {
    const { typeLow, props, pageId, pageTitle } = ctx;
    if (typeLow === 'page') pageNodes.push({ pageId, pageTitle });

    const nodeId = String(props.id || '').trim();
    const label  = String(props.label || props.text || props.title || props.placeholder || '').trim();

    if (nodeId) idNodes.push({ pageId, pageTitle, nodeId, typeLow, label });
    if (typeLow === 'function' && nodeId) functionNodes.push({ pageId, functionId: nodeId });

    if (typeLow === 'webservice') {
      wsNodes.push({
        pageId, pageTitle, serviceId: nodeId,
        wsurl:         String(props._wsurl         || ''),
        wstype:        String(props._wstype         || ''),
        operationType: String(props._operationType  || ''),
        request:       String(props._request        || ''),
        userWS:        String(props._userWS         || ''),
        passWS:        String(props._passWS         || ''),
      });
    }

    if (!GLOSSARY_IGNORE.has(typeLow) && nodeId)
      uiNodes.push({ pageId, pageTitle, id: nodeId, typeLow, label });

    const wsRef = String(props._webService || '').trim();
    if (wsRef) wsRefs.push({ pageId, pageTitle, nodeId, typeLow, refServiceId: wsRef });

    for (const [propName, propVal] of Object.entries(props)) {
      if (typeof propVal === 'string' && looksLikeScript(propVal))
        scriptNodes.push({ pageId, pageTitle, nodeId, typeLow, propName, scriptText: propVal });
    }
  }
  return { uiNodes, wsNodes, scriptNodes, idNodes, pageNodes, wsRefs, functionNodes };
}

function looksLikeScript(text) {
  const low = text.toLowerCase();
  return SCRIPT_MARKERS.some(m => low.includes(m));
}
function isDynamic(val) { return PLACEHOLDER_ONLY_RX.test(val) || val.startsWith('${'); }
function isRuntime(name) {
  return RUNTIME_EXACT.has(name) || RUNTIME_PREFIXES.some(p => name.startsWith(p));
}
function isOracleFusionRest(url) { return ORACLE_URL_RX.test(url || ''); }
function isGetOp(op) { const u = (op || '').trim().toUpperCase(); return !u || u === 'GET'; }

function stripComments(text) {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
}

function highestSev(findings) {
  return findings.reduce((best, f) => {
    return (SEVERITY_RANK[f.severity] || 0) > (SEVERITY_RANK[best] || 0) ? f.severity : best;
  }, null);
}

function makeCheck(name, category, findings) {
  return { name, category, passed: findings.length === 0, severity: highestSev(findings), findings };
}

// ─── Check 1: Structure ───────────────────────────────────────────
function checkStructure({ idNodes, pageNodes }) {
  const findings = [];

  // Duplicate IDs
  const seen = new Map();
  for (const n of idNodes) {
    if (!seen.has(n.nodeId)) seen.set(n.nodeId, 0);
    seen.set(n.nodeId, seen.get(n.nodeId) + 1);
  }
  for (const [id, count] of seen) {
    if (count > 1)
      findings.push({ severity: 'HIGH', detail: `Duplicate component ID "${id}" appears ${count} times.` });
  }

  if (pageNodes.length === 0)
    findings.push({ severity: 'HIGH', detail: 'No top-level Page node found in the FlexiPage JSON.' });

  for (const pn of pageNodes) {
    if (!pn.pageId)    findings.push({ severity: 'MEDIUM', detail: 'Page node is missing an id property.' });
    if (!pn.pageTitle) findings.push({ severity: 'MEDIUM', detail: 'Page node is missing a title property.' });
  }

  return makeCheck('Structure', 'Structure', findings);
}

// ─── Check 2: References ──────────────────────────────────────────
function checkReferences({ wsNodes, wsRefs, functionNodes, scriptNodes }) {
  const findings  = [];
  const wsIds     = new Set(wsNodes.map(w => w.serviceId).filter(Boolean));
  const fnIds     = new Set(functionNodes.map(f => f.functionId).filter(Boolean));

  for (const ref of wsRefs) {
    if (!wsIds.has(ref.refServiceId))
      findings.push({ severity: 'HIGH',
        detail: `"${ref.nodeId}" references WebService "${ref.refServiceId}" which does not exist.` });
  }

  const refByProp    = new Set(wsRefs.map(r => r.refServiceId));
  const calledInScr  = new Set();
  for (const s of scriptNodes) {
    let m; const rx = new RegExp(CALL_WS_RX.source, 'g');
    while ((m = rx.exec(s.scriptText)) !== null) calledInScr.add(m[1]);
  }
  for (const ws of wsNodes) {
    if (ws.serviceId && !refByProp.has(ws.serviceId) && !calledInScr.has(ws.serviceId))
      findings.push({ severity: 'LOW',
        detail: `WebService "${ws.serviceId}" is defined but never referenced or called in scripts.` });
  }

  if (fnIds.size > 0) {
    const calledFns = new Set();
    const fnPattern = new RegExp(`\\b(${[...fnIds].map(f => f.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})\\b`, 'g');
    for (const s of scriptNodes) {
      let m;
      while ((m = fnPattern.exec(s.scriptText)) !== null) calledFns.add(m[1]);
    }
    for (const fn of functionNodes) {
      if (!calledFns.has(fn.functionId))
        findings.push({ severity: 'LOW',
          detail: `Function "${fn.functionId}" is defined but never called from any script.` });
    }
  }

  return makeCheck('References', 'Reference', findings);
}

// ─── Check 3: Scripts ─────────────────────────────────────────────
function checkScripts({ scriptNodes }) {
  const findings  = [];
  const LONG_LINE = 50;
  const seenBodies = new Map();

  for (const s of scriptNodes) {
    const clean    = stripComments(s.scriptText);
    const lines    = s.scriptText.split('\n').length;
    const loc      = `${s.nodeId}.${s.propName}`;

    if (lines > LONG_LINE)
      findings.push({ severity: 'LOW',
        detail: `${loc} has ${lines} lines — consider extracting to a Function node.` });

    // Empty catch blocks
    const rx = new RegExp(EMPTY_CATCH_RX.source, 'gi');
    let m;
    while ((m = rx.exec(clean)) !== null) {
      if (m[1].trim() === '')
        findings.push({ severity: 'HIGH', detail: `${loc} has an empty catch block (silently swallows exceptions).` });
    }

    // Duplicate handler logic (first 200 chars of normalised body)
    const norm = clean.replace(/\s+/g, ' ').trim().slice(0, 200);
    if (norm.length > 30) {
      if (seenBodies.has(norm))
        findings.push({ severity: 'MEDIUM',
          detail: `${loc} has near-identical logic to ${seenBodies.get(norm)} — consider a shared Function node.` });
      else seenBodies.set(norm, loc);
    }
  }
  return makeCheck('Scripts', 'Script', findings);
}

// ─── Check 4: Credentials ────────────────────────────────────────
function checkCredentials({ wsNodes, scriptNodes }) {
  const findings = [];

  for (const ws of wsNodes) {
    if (ws.userWS && !isDynamic(ws.userWS))
      findings.push({ severity: 'HIGH',
        detail: `${ws.serviceId}._userWS contains a hardcoded username — use \${PLACEHOLDER} instead.` });
    if (ws.passWS && !isDynamic(ws.passWS))
      findings.push({ severity: 'HIGH',
        detail: `${ws.serviceId}._passWS contains a hardcoded password — use \${PLACEHOLDER} instead.` });
  }

  for (const s of scriptNodes) {
    const loc = `${s.nodeId}.${s.propName}`;
    if (BASIC_TOKEN_RX.test(s.scriptText))
      findings.push({ severity: 'HIGH', detail: `${loc} contains a hardcoded Basic auth token in script.` });
    if (BEARER_TOKEN_RX.test(s.scriptText))
      findings.push({ severity: 'HIGH', detail: `${loc} contains a hardcoded Bearer token in script.` });
  }

  return makeCheck('Credentials', 'Credential', findings);
}

// ─── Check 5: Response Guards ────────────────────────────────────
function checkResponseGuards({ scriptNodes, wsNodes }) {
  const findings = [];
  const wsIds    = new Set(wsNodes.map(w => w.serviceId).filter(Boolean));

  for (const s of scriptNodes) {
    const text = s.scriptText;
    const loc  = `${s.nodeId}.${s.propName}`;

    let m;
    const rawRx = new RegExp(GET_RAW_RX.source, 'g');
    while ((m = rawRx.exec(text)) !== null) {
      const svc = m[1];
      if (!wsIds.has(svc)) continue;
      const guardRx = new RegExp(`\\b${svc.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\.\\s*getResponseCode\\s*\\(`);
      if (!guardRx.test(text))
        findings.push({ severity: 'MEDIUM',
          detail: `${loc} reads getRawResponse() from "${svc}" without first checking getResponseCode().` });
    }

    const arrRx = new RegExp(ARRAY_IDX0_RX.source, 'gi');
    while ((m = arrRx.exec(text)) !== null)
      findings.push({ severity: 'HIGH',
        detail: `${loc} accesses JSONArray["${m[1]}"].get(0) without a length guard (IndexOutOfBoundsException risk).` });
  }

  return makeCheck('Response Guards', 'ResponseGuard', findings);
}

// ─── Check 6: API Quality (Oracle Fusion REST) ────────────────────
function checkApiQuality({ wsNodes, wsRefs }) {
  const findings = [];

  // Build referenced-by-node-type map
  const refTypes = {};
  for (const ref of wsRefs) {
    if (!refTypes[ref.refServiceId]) refTypes[ref.refServiceId] = new Set();
    refTypes[ref.refServiceId].add(ref.typeLow);
  }

  for (const ws of wsNodes) {
    if (!isOracleFusionRest(ws.wsurl)) continue;
    if ((ws.wstype || '').trim().toUpperCase() && (ws.wstype || '').trim().toUpperCase() !== 'REST') continue;
    if (!isGetOp(ws.operationType)) continue;

    const combined = ws.wsurl + ' ' + ws.request;

    if (!FIELDS_RX.test(combined))
      findings.push({ severity: 'HIGH',
        detail: `${ws.serviceId}: Oracle Fusion GET call missing fields= projection (returns full object, wasting bandwidth).` });

    if (!ONLY_DATA_RX.test(combined))
      findings.push({ severity: 'MEDIUM',
        detail: `${ws.serviceId}: Missing onlyData=true (response includes unnecessary metadata wrapper).` });

    // LOV-style services should have a limit
    const types = refTypes[ws.serviceId] || new Set();
    const isLov = types.has('lov') || LOV_HINT_RX.test(ws.request);
    if (isLov && !LIMIT_RX.test(combined))
      findings.push({ severity: 'MEDIUM',
        detail: `${ws.serviceId}: LOV/search service has no limit= parameter (unbounded results risk).` });
  }

  return makeCheck('API Quality (Fusion)', 'APIQuality', findings);
}

// ─── Check 7: Redundant APIs ──────────────────────────────────────
function checkRedundantApis({ wsNodes }) {
  const findings = [];
  const groups   = {};

  for (const ws of wsNodes) {
    const url = ws.wsurl.replace(/\?.*$/, '').replace(/\/+$/, '').toLowerCase();
    if (!url) continue;
    if (!groups[url]) groups[url] = [];
    groups[url].push(ws.serviceId);
  }

  for (const [endpoint, ids] of Object.entries(groups)) {
    if (ids.length > 1)
      findings.push({ severity: 'LOW',
        detail: `Same endpoint "${endpoint}" is used by ${ids.length} WebService nodes: ${ids.join(', ')} — consider consolidating.` });
  }

  return makeCheck('Redundant APIs', 'RedundantAPI', findings);
}

// ─── Check 8: Commit Patterns ────────────────────────────────────
function checkCommitPatterns({ scriptNodes }) {
  const findings = [];
  for (const s of scriptNodes) {
    for (const rx of COMMIT_RX_LIST) {
      const hit = s.scriptText.match(rx);
      if (hit)
        findings.push({ severity: 'HIGH',
          detail: `${s.nodeId}.${s.propName} contains "${hit[0]}" — direct DB commits in FlexiPage scripts are dangerous.` });
    }
  }
  return makeCheck('Commit Patterns', 'Commit', findings);
}

// ─── Check 9: Placeholder Dependencies ───────────────────────────
function checkPlaceholders({ scriptNodes, wsNodes }) {
  const findings    = [];
  const definedKeys = new Set();

  for (const s of scriptNodes) {
    let m; const rx = new RegExp(PUT_OBJECT_RX.source, 'g');
    while ((m = rx.exec(s.scriptText)) !== null) definedKeys.add(m[1]);
  }

  for (const ws of wsNodes) {
    const combined = ws.wsurl + ' ' + ws.request;
    let m; const rx = new RegExp(PLACEHOLDER_RX.source, 'g');
    while ((m = rx.exec(combined)) !== null) {
      const name = m[1].toUpperCase();
      if (!definedKeys.has(name) && !isRuntime(name))
        findings.push({ severity: 'MEDIUM',
          detail: `${ws.serviceId} uses \${${m[1]}} which may not be set before this service runs.` });
    }
  }

  return makeCheck('Placeholder Dependencies', 'Placeholder', findings);
}

// ─── Public API ───────────────────────────────────────────────────
function reviewFlexipage(input) {
  let root = input;
  if (typeof input === 'string') {
    try { root = JSON.parse(input); } catch { return { error: 'Invalid JSON input' }; }
  }

  const artifacts = collectArtifacts(root);

  const checks = [
    checkStructure(artifacts),
    checkReferences(artifacts),
    checkScripts(artifacts),
    checkCredentials(artifacts),
    checkResponseGuards(artifacts),
    checkApiQuality(artifacts),
    checkRedundantApis(artifacts),
    checkCommitPatterns(artifacts),
    checkPlaceholders(artifacts),
  ];

  const passed  = checks.filter(c => c.passed).length;
  const failed  = checks.filter(c => !c.passed).length;
  const highCount = checks.filter(c => c.severity === 'HIGH').length;

  return { summary: { total: checks.length, passed, failed, highCount }, checks };
}

module.exports = { reviewFlexipage };
