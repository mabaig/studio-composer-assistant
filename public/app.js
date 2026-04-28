/* ═══════════════════════════════════════════════════════════
   Tab management
═══════════════════════════════════════════════════════════ */
function switchTab(name) {
  document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
  document.querySelectorAll('.tab-pane').forEach(p => p.classList.remove('active'));
  document.getElementById(`tab-${name}`)?.classList.add('active');
  document.getElementById(`pane-${name}`)?.classList.add('active');
}

/* ═══════════════════════════════════════════════════════════
   Constants & state
═══════════════════════════════════════════════════════════ */
const SESSION_KEY = 'composer_thread_id';
const AUTH_KEY    = 'composer_auth';
const THEME_KEY   = 'composer_theme';
const CREDS       = { user: 'intellinum.scm', pass: 'Welcome10' };

let attachedFile  = null;   // { name, content }
let lastFlexipage = null;
let isStreaming   = false;
let turns         = [];     // [{ question, time, result, tokenText }]
let historyOpen   = false;

/* ═══════════════════════════════════════════════════════════
   Boot
═══════════════════════════════════════════════════════════ */
document.addEventListener('DOMContentLoaded', () => {
  initTheme();
  initLogin();
  initResizer();
  wireUI();
});

/* ═══════════════════════════════════════════════════════════
   Theme
═══════════════════════════════════════════════════════════ */
function initTheme() {
  const saved = localStorage.getItem(THEME_KEY) || 'dark';
  applyTheme(saved);
}

function applyTheme(t) {
  document.documentElement.setAttribute('data-theme', t);
  localStorage.setItem(THEME_KEY, t);
  const hljsTheme = document.getElementById('hljs-theme');
  if (hljsTheme) {
    hljsTheme.href = t === 'dark'
      ? 'https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/styles/atom-one-dark.min.css'
      : 'https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/styles/atom-one-light.min.css';
  }
  const btn = document.getElementById('btn-theme');
  if (!btn) return;
  const isDark = t === 'dark';
  btn.title = isDark ? 'Switch to light mode' : 'Switch to dark mode';
  btn.innerHTML = isDark
    ? `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="5"/><line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/><line x1="1" y1="12" x2="3" y2="12"/><line x1="21" y1="12" x2="23" y2="12"/><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/></svg>`
    : `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>`;
}

/* ═══════════════════════════════════════════════════════════
   Login
═══════════════════════════════════════════════════════════ */
function initLogin() {
  if (sessionStorage.getItem(AUTH_KEY)) {
    showApp();
    return;
  }
  document.getElementById('login-overlay').style.display = 'flex';
  document.getElementById('login-form').addEventListener('submit', handleLogin);
  // Focus username on load
  setTimeout(() => document.getElementById('login-username')?.focus(), 50);
}

function handleLogin(e) {
  e.preventDefault();
  const user = document.getElementById('login-username').value.trim();
  const pass = document.getElementById('login-password').value;
  const err  = document.getElementById('login-error');

  if (user === CREDS.user && pass === CREDS.pass) {
    sessionStorage.setItem(AUTH_KEY, '1');
    document.getElementById('login-overlay').style.display = 'none';
    showApp();
  } else {
    err.textContent = 'Invalid username or password.';
    document.getElementById('login-password').value = '';
    document.getElementById('login-password').focus();
  }
}

function showApp() {
  const app = document.getElementById('app');
  app.classList.add('visible');
  // Init theme icon after DOM is visible
  applyTheme(localStorage.getItem(THEME_KEY) || 'dark');
}

/* ═══════════════════════════════════════════════════════════
   Resizer
═══════════════════════════════════════════════════════════ */
function initResizer() {
  const handle    = document.getElementById('resize-handle');
  const chatPanel = document.getElementById('chat-panel');
  if (!handle || !chatPanel) return;

  let dragging = false;
  let startX, startW;

  handle.addEventListener('mousedown', (e) => {
    dragging = true;
    startX = e.clientX;
    startW = chatPanel.offsetWidth;
    handle.classList.add('dragging');
    document.body.classList.add('resizing');
    e.preventDefault();
  });

  document.addEventListener('mousemove', (e) => {
    if (!dragging) return;
    const newW = Math.max(240, Math.min(startW + (e.clientX - startX), window.innerWidth * 0.65));
    chatPanel.style.width   = newW + 'px';
    chatPanel.style.minWidth = 'unset';
    chatPanel.style.maxWidth = 'unset';
  });

  document.addEventListener('mouseup', () => {
    if (!dragging) return;
    dragging = false;
    handle.classList.remove('dragging');
    document.body.classList.remove('resizing');
  });
}

/* ═══════════════════════════════════════════════════════════
   History
═══════════════════════════════════════════════════════════ */
function toggleHistory() {
  historyOpen = !historyOpen;
  document.getElementById('history-list').style.display   = historyOpen ? 'block' : 'none';
  document.getElementById('history-chevron').classList.toggle('open', historyOpen);
}

function pushTurn(question, result, tokenText) {
  turns.push({ question, time: new Date(), result, tokenText });
  renderHistory();
}

function renderHistory() {
  const section   = document.getElementById('history-section');
  const list      = document.getElementById('history-list');
  const countEl   = document.getElementById('history-count');
  if (!section) return;

  if (turns.length === 0) { section.style.display = 'none'; return; }
  section.style.display = 'block';
  countEl.textContent = turns.length;
  list.style.display  = historyOpen ? 'block' : 'none';

  list.innerHTML = '';
  turns.slice().reverse().forEach((turn, idx) => {
    const isValid = turn.result?.output?.validation?.is_valid;
    const hasFlexipage = !!turn.result?.output?.flexipage;
    const timeStr = turn.time.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

    const item = document.createElement('div');
    item.className = 'history-item';
    item.innerHTML = `
      <button class="history-item-btn" onclick="loadTurn(${turns.length - 1 - idx})">
        <span class="history-item-icon">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            ${hasFlexipage
              ? '<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M9 9h6M9 12h6M9 15h4"/>'
              : '<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>'}
          </svg>
        </span>
        <span class="history-item-content">
          <span class="history-item-q">${escapeHtml(turn.question)}</span>
          <span class="history-item-meta">
            ${isValid === true ? '<span class="history-valid-dot"></span>' : ''}
            ${timeStr}
            ${hasFlexipage ? '· FlexiPage' : ''}
          </span>
        </span>
      </button>`;
    list.appendChild(item);
  });
}

function loadTurn(idx) {
  const turn = turns[idx];
  if (!turn) return;
  clearResponsePanel();
  if (turn.result) {
    renderFinalResult(turn.result);
  } else if (turn.tokenText) {
    renderMarkdown(turn.tokenText);
  }
  setStatus('Loaded from history', false);
}

/* ═══════════════════════════════════════════════════════════
   Wire up UI events
═══════════════════════════════════════════════════════════ */
function wireUI() {
  // Theme toggle
  document.getElementById('btn-theme')?.addEventListener('click', () => {
    const cur = document.documentElement.getAttribute('data-theme');
    applyTheme(cur === 'dark' ? 'light' : 'dark');
  });

  // Example chips
  document.querySelectorAll('.chip').forEach(chip => {
    chip.addEventListener('click', () => {
      document.getElementById('prompt-input').value = chip.dataset.prompt;
      document.getElementById('prompt-input').focus();
      autosize();
    });
  });

  // File attachment
  document.getElementById('file-input').addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (evt) => {
      attachedFile = { name: file.name, content: evt.target.result };
      document.getElementById('attachment-name').textContent = file.name;
      document.getElementById('attachment-row').classList.add('visible');
    };
    reader.onerror = () => setStatus('Failed to read file', false);
    reader.readAsText(file);
    e.target.value = '';
  });

  document.getElementById('btn-remove-file').addEventListener('click', clearAttachment);

  // New chat
  document.getElementById('btn-new-chat').addEventListener('click', () => {
    if (isStreaming) return;
    sessionStorage.removeItem(SESSION_KEY);
    clearAttachment();
    document.getElementById('message-list').innerHTML =
      '<div class="welcome-message"><p>Describe the FlexiPage you want to build. Pick an example below or type your own prompt.</p></div>';
    clearResponsePanel();
    document.getElementById('prompt-input').value = '';
    autosize();
  });

  // Send
  const promptInput = document.getElementById('prompt-input');
  promptInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSend(); }
  });
  promptInput.addEventListener('input', autosize);
  document.getElementById('btn-send').addEventListener('click', handleSend);

  // API search panel
  document.getElementById('btn-api-search')?.addEventListener('click', toggleApiSearch);
  document.getElementById('api-search-close')?.addEventListener('click', () => {
    document.getElementById('api-search-panel').style.display = 'none';
    document.getElementById('btn-api-search')?.classList.remove('active');
  });
  const apiQ = document.getElementById('api-search-q');
  if (apiQ) {
    apiQ.addEventListener('input', () => debounceApiSearch(apiQ.value));
    apiQ.addEventListener('keydown', (e) => { if (e.key === 'Escape') document.getElementById('api-search-panel').style.display = 'none'; });
  }

  // Copy
  document.getElementById('btn-copy')?.addEventListener('click', copyContent);

  // Download
  document.getElementById('btn-download').addEventListener('click', () => {
    if (!lastFlexipage) return;
    const blob = new Blob([JSON.stringify(lastFlexipage, null, 2)], { type: 'application/json' });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href = url; a.download = 'flexipage.json'; a.click();
    URL.revokeObjectURL(url);
  });
}

/* ═══════════════════════════════════════════════════════════
   Session
═══════════════════════════════════════════════════════════ */
function getThreadId() {
  let id = sessionStorage.getItem(SESSION_KEY);
  if (!id) { id = crypto.randomUUID(); sessionStorage.setItem(SESSION_KEY, id); }
  return id;
}

/* ═══════════════════════════════════════════════════════════
   Send / Stream
═══════════════════════════════════════════════════════════ */
async function handleSend() {
  const promptInput = document.getElementById('prompt-input');
  const question    = promptInput.value.trim();
  if (!question || isStreaming) return;

  addMessage('user', question);
  promptInput.value = '';
  autosize();

  clearResponsePanel();
  setStatus('Generating…', true);
  document.getElementById('btn-send').disabled = true;
  isStreaming = true;

  const body = {
    input: {
      question,
      code: attachedFile ? attachedFile.content : 'Base',
    },
    config: {
      configurable: { thread_id: getThreadId(), model: 'pro' },
    },
    kwargs: {},
  };

  // Streaming display element
  const pre = document.createElement('pre');
  pre.className = 'stream-raw';
  const responseContent = document.getElementById('response-content');
  responseContent.innerHTML = '';
  responseContent.appendChild(pre);

  let tokenAccum = '';  // visible streaming text (from {"token":"..."} events)
  let lastParsed = null;

  try {
    const res = await fetch('/api/stream', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
      throw new Error(err.error || `HTTP ${res.status}`);
    }

    const reader     = res.body.getReader();
    const decoder    = new TextDecoder();
    let lineBuffer   = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      lineBuffer += decoder.decode(value, { stream: true });
      const lines = lineBuffer.split('\n');
      lineBuffer  = lines.pop() ?? '';

      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const raw = line.slice(6).trim();
        if (!raw || raw === '[DONE]') continue;

        try {
          const parsed = JSON.parse(raw);

          if (parsed.token !== undefined) {
            // ── Token streaming: show only the text value ──
            tokenAccum += parsed.token;
            pre.textContent = tokenAccum;

          } else if (parsed?.output?.flexipage) {
            // ── Final complete result ──
            lastParsed = parsed;

          } else if (parsed?.output) {
            lastParsed = parsed;
          }
          // else: ignore other JSON shapes silently

        } catch {
          // Non-JSON chunk — append as plain text
          tokenAccum += raw;
          pre.textContent = tokenAccum;
        }

        responseContent.scrollTop = responseContent.scrollHeight;
      }
    }

    // Finalize
    if (!lastParsed && tokenAccum) {
      // Try parsing the accumulated token text as the full response
      try { lastParsed = JSON.parse(tokenAccum); } catch { /* keep as text */ }
    }

    const displayQuestion = question;

    if (lastParsed) {
      renderFinalResult(lastParsed);
      const mode = lastParsed.output?.mode;
      const label = lastParsed.output?.flexipage
        ? '✓ FlexiPage generated'
        : mode === 'assistant'
          ? '✓ Answer received'
          : '✓ Response received';
      addMessage('assistant', label);
      pushTurn(displayQuestion, lastParsed, null);
    } else {
      renderMarkdown(tokenAccum || '*(No output)*');
      addMessage('assistant', '✓ Response received');
      pushTurn(displayQuestion, null, tokenAccum);
    }

    setStatus('Done', false);

  } catch (err) {
    setStatus('Error', false);
    responseContent.innerHTML = `<div class="error-msg">Error: ${escapeHtml(err.message)}</div>`;
    addMessage('assistant', `✗ ${err.message}`);
  } finally {
    document.getElementById('btn-send').disabled = false;
    isStreaming = false;
  }
}

/* ═══════════════════════════════════════════════════════════
   Render
═══════════════════════════════════════════════════════════ */
function renderFinalResult(parsed) {
  const responseContent = document.getElementById('response-content');
  responseContent.innerHTML = '';

  // Always update usage badge regardless of output type
  updateUsageBadge(parsed.metadata?.usage, parsed.output?.mode);

  const fp     = parsed?.output?.flexipage;
  const answer = parsed?.output?.answer;

  if (fp) {
    /* ── FlexiPage JSON output ── */
    lastFlexipage = fp;
    document.getElementById('btn-download').classList.add('visible');

    const v = parsed.output?.validation;
    if (v !== undefined) {
      const badge = document.getElementById('validation-badge');
      badge.textContent = v.is_valid ? '✓ Valid' : '✗ Invalid';
      badge.className   = 'validation-badge ' + (v.is_valid ? 'valid' : 'invalid');
    }

    const wrapper = document.createElement('div');
    wrapper.className = 'json-viewer';
    const pre  = document.createElement('pre');
    const code = document.createElement('code');
    code.className = 'json-code';
    code.innerHTML = syntaxHighlightJSON(fp);
    pre.appendChild(code);
    wrapper.appendChild(pre);
    responseContent.appendChild(wrapper);

    const cb = document.getElementById('btn-copy');
    if (cb) cb.style.display = 'flex';

    runReview(fp);

  } else if (answer) {
    /* ── Assistant markdown answer ── */
    renderMarkdown(answer);

  } else {
    /* ── Fallback: render raw response as JSON ── */
    const wrapper = document.createElement('div');
    wrapper.className = 'json-viewer';
    const pre  = document.createElement('pre');
    const code = document.createElement('code');
    code.className = 'json-code';
    code.innerHTML = syntaxHighlightJSON(parsed);
    pre.appendChild(code);
    wrapper.appendChild(pre);
    responseContent.appendChild(wrapper);
    const cb2 = document.getElementById('btn-copy');
    if (cb2) cb2.style.display = 'flex';
  }
}

function updateUsageBadge(usage, mode) {
  if (!usage) return;
  const totalTokens = (usage.input_tokens || 0) + (usage.output_tokens || 0);
  const cacheRead   = usage.cache_read_tokens     || 0;
  const cacheWrite  = usage.cache_creation_tokens || 0;
  const cost        = usage.cost_usd?.total;
  const model       = usage.model ? ` · ${usage.model}` : '';

  let parts = [`${totalTokens.toLocaleString()} tokens`];
  if (cacheRead)  parts.push(`${(cacheRead / 1000).toFixed(0)}k cached`);
  if (cacheWrite) parts.push(`${(cacheWrite / 1000).toFixed(0)}k written`);
  if (cost)       parts.push(`$${cost.toFixed(4)}`);
  parts.push(model.trim());

  document.getElementById('usage-badge').textContent = parts.filter(Boolean).join(' · ');
}

/* ═══════════════════════════════════════════════════════════
   Review
═══════════════════════════════════════════════════════════ */
async function runReview(flexipage) {
  const reviewContent = document.getElementById('review-content');
  const badge         = document.getElementById('review-badge');

  reviewContent.innerHTML = '<div class="empty-state"><p style="color:var(--cyan)">Running review checks…</p></div>';
  badge.style.display = 'inline-flex';
  badge.textContent   = '…';
  badge.className     = 'review-badge';

  try {
    const res = await fetch('/api/review', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ flexipage }),
    });
    const data = await res.json();
    if (data.error) throw new Error(data.error);
    renderReview(data);
  } catch (err) {
    reviewContent.innerHTML = `<div class="error-msg">Review error: ${escapeHtml(err.message)}</div>`;
    badge.textContent = '!';
  }
}

function renderReview(data) {
  const reviewContent = document.getElementById('review-content');
  const badge         = document.getElementById('review-badge');
  const { summary, checks } = data;

  // Update badge
  if (summary.failed === 0) {
    badge.textContent = `${summary.passed}/${summary.total} ✓`;
    badge.className   = 'review-badge ok';
  } else {
    badge.textContent = `${summary.failed} issue${summary.failed > 1 ? 's' : ''}`;
    badge.className   = 'review-badge';
  }
  badge.style.display = 'inline-flex';

  // Build summary bar
  const html = [];
  html.push(`
    <div class="review-summary">
      <div class="review-summary-stat">
        <span class="stat-num stat-passed">${summary.passed}</span>
        <span class="stat-label">Passed</span>
      </div>
      <div class="review-summary-divider"></div>
      <div class="review-summary-stat">
        <span class="stat-num stat-failed">${summary.failed}</span>
        <span class="stat-label">Failed</span>
      </div>
      <div class="review-summary-divider"></div>
      <div class="review-summary-stat">
        <span class="stat-num stat-total">${summary.total}</span>
        <span class="stat-label">Checks</span>
      </div>
    </div>
    <div class="review-checks">`);

  checks.forEach((check, idx) => {
    const itemClass = check.passed ? 'passed' : (check.severity === 'HIGH' ? 'high' : 'failed');
    const icon      = check.passed ? '✅' : (check.severity === 'HIGH' ? '🔴' : check.severity === 'MEDIUM' ? '🟠' : '🔵');
    const sevHtml   = check.severity && !check.passed
      ? `<span class="check-sev sev-${check.severity}">${check.severity}</span>` : '';
    const countHtml = !check.passed
      ? `<span class="check-count">${check.findings.length} finding${check.findings.length !== 1 ? 's' : ''}</span>` : '';

    html.push(`
      <div class="check-item ${itemClass}">
        <button class="check-header" onclick="toggleCheck(${idx})">
          <span class="check-icon">${icon}</span>
          <span class="check-name">${escapeHtml(check.name)}</span>
          ${sevHtml}
          ${countHtml}
          ${!check.passed ? `<svg class="check-chevron" id="chev-${idx}" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="6 9 12 15 18 9"/></svg>` : ''}
        </button>`);

    if (!check.passed) {
      html.push(`<div class="check-findings" id="findings-${idx}">`);
      for (const f of check.findings) {
        html.push(`
          <div class="finding-item">
            <span class="finding-dot dot-${f.severity}"></span>
            <span>${escapeHtml(f.detail)}</span>
          </div>`);
      }
      html.push('</div>');
    }

    html.push('</div>');
  });

  html.push('</div>');
  reviewContent.innerHTML = html.join('');
}

function toggleCheck(idx) {
  const body  = document.getElementById(`findings-${idx}`);
  const chev  = document.getElementById(`chev-${idx}`);
  if (!body) return;
  const open = body.classList.toggle('open');
  chev?.classList.toggle('open', open);
}

function renderMarkdown(text) {
  const responseContent = document.getElementById('response-content');
  responseContent.innerHTML = '';
  const div = document.createElement('div');
  div.className = 'markdown-body';
  div.innerHTML = typeof marked !== 'undefined' ? marked.parse(text) : escapeHtml(text);
  responseContent.appendChild(div);
  if (typeof hljs !== 'undefined') {
    div.querySelectorAll('pre code').forEach(el => hljs.highlightElement(el));
  }
  const cb = document.getElementById('btn-copy');
  if (cb) cb.style.display = 'flex';
}

/* ═══════════════════════════════════════════════════════════
   Helpers
═══════════════════════════════════════════════════════════ */
function clearResponsePanel() {
  const responseContent = document.getElementById('response-content');
  responseContent.innerHTML = `
    <div class="empty-state">
      <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke-width="1.2">
        <rect x="3" y="3" width="18" height="18" rx="2" stroke="var(--navy-border)"/>
        <path d="M9 9h6M9 12h6M9 15h4" stroke="var(--navy-border)"/>
      </svg>
      <p>Your generated FlexiPage will appear here.</p>
    </div>`;
  document.getElementById('btn-download').classList.remove('visible');
  const copyBtn = document.getElementById('btn-copy');
  if (copyBtn) copyBtn.style.display = 'none';
  const ub = document.getElementById('usage-badge');
  if (ub) ub.textContent = '';
  const vb = document.getElementById('validation-badge');
  if (vb) { vb.className = 'validation-badge'; vb.textContent = ''; }
  const rb = document.getElementById('review-badge');
  if (rb) { rb.style.display = 'none'; rb.textContent = ''; }
  const rc = document.getElementById('review-content');
  if (rc) rc.innerHTML = '<div class="empty-state"><svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke-width="1.2"><path d="M9 11l3 3L22 4" stroke="var(--navy-border)"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11" stroke="var(--navy-border)"/></svg><p>Generate a FlexiPage to run the code review.</p></div>';
  lastFlexipage = null;
}

function setStatus(text, active) {
  const el = document.getElementById('status-indicator');
  if (!el) return;
  el.textContent = text;
  el.className   = 'status-indicator' + (active ? ' streaming' : '');
}

function addMessage(role, text) {
  const list    = document.getElementById('message-list');
  const welcome = list.querySelector('.welcome-message');
  if (welcome && role === 'user') welcome.remove();

  const div = document.createElement('div');
  div.className   = `message message-${role}`;
  div.textContent = text;
  list.appendChild(div);
  list.scrollTop  = list.scrollHeight;
}

function autosize() {
  const ta = document.getElementById('prompt-input');
  if (!ta) return;
  ta.style.height = 'auto';
  ta.style.height = Math.min(ta.scrollHeight, window.innerHeight * 0.55) + 'px';
}

function clearAttachment() {
  attachedFile = null;
  document.getElementById('attachment-row').classList.remove('visible');
  document.getElementById('attachment-name').textContent = '';
}

function syntaxHighlightJSON(obj) {
  const json = JSON.stringify(obj, null, 2);
  const safe = json.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return safe.replace(
    /("(?:[^"\\]|\\.)*"\s*:)|("(?:[^"\\]|\\.)*")|(\b(?:true|false|null)\b)|(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/g,
    (match, key, str, bool, num) => {
      if (key)  return `<span class="json-key">${key}</span>`;
      if (str)  return `<span class="json-string">${str}</span>`;
      if (bool) return `<span class="json-boolean">${bool}</span>`;
      if (num)  return `<span class="json-number">${num}</span>`;
      return match;
    }
  );
}

/* ═══════════════════════════════════════════════════════════
   API Search
═══════════════════════════════════════════════════════════ */
let _apiSearchTimer = null;

function toggleApiSearch() {
  const panel  = document.getElementById('api-search-panel');
  const btn    = document.getElementById('btn-api-search');
  const visible = panel.style.display !== 'none';
  panel.style.display = visible ? 'none' : 'block';
  btn?.classList.toggle('active', !visible);
  if (!visible) document.getElementById('api-search-q').focus();
}

function debounceApiSearch(q) {
  clearTimeout(_apiSearchTimer);
  const resultsEl = document.getElementById('api-search-results');
  if (!q.trim()) {
    resultsEl.innerHTML = '<p class="api-search-hint">Search across 3,613 Oracle SCM endpoints</p>';
    return;
  }
  resultsEl.innerHTML = '<p class="api-search-hint">Searching…</p>';
  _apiSearchTimer = setTimeout(() => runApiSearch(q), 300);
}

async function runApiSearch(q) {
  const resultsEl = document.getElementById('api-search-results');
  try {
    const res  = await fetch(`/api/search-api?q=${encodeURIComponent(q)}`);
    const data = await res.json();
    if (data.error) throw new Error(data.error);
    renderApiSearchResults(data);
  } catch (err) {
    resultsEl.innerHTML = `<p class="api-search-hint" style="color:#ff6b6b">Error: ${escapeHtml(err.message)}</p>`;
  }
}

function renderApiSearchResults(results) {
  const el = document.getElementById('api-search-results');
  if (!results.length) {
    el.innerHTML = '<p class="api-search-hint">No results found</p>';
    return;
  }
  el.innerHTML = results.map((r, i) => `
    <div class="api-result-item">
      <button class="api-result-header" onclick="toggleApiResultDetail(this, ${i}, '${escapeHtml(r.path)}')">
        <span class="api-method api-method-${r.method}">${r.method}</span>
        <span class="api-result-path">${escapeHtml(r.path)}</span>
        <span class="api-result-summary">${escapeHtml(r.summary || '')}</span>
        <svg class="api-result-chevron" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="6 9 12 15 18 9"/></svg>
      </button>
      <div class="api-result-detail" id="api-detail-${i}" style="display:none"></div>
    </div>
  `).join('');
}

async function toggleApiResultDetail(btn, idx, path) {
  const detailEl = document.getElementById(`api-detail-${idx}`);
  const chevron  = btn.querySelector('.api-result-chevron');
  const open     = detailEl.style.display !== 'none';

  if (open) {
    detailEl.style.display = 'none';
    chevron?.classList.remove('open');
    return;
  }

  detailEl.style.display = 'block';
  chevron?.classList.add('open');

  if (detailEl.dataset.loaded) return;
  detailEl.innerHTML = '<p class="api-search-hint">Loading…</p>';

  try {
    const res  = await fetch(`/api/endpoint-detail?path=${encodeURIComponent(path)}`);
    const rows = await res.json();
    if (rows.error) throw new Error(rows.error);
    if (!rows.length) { detailEl.innerHTML = '<p class="api-search-hint">No detail found</p>'; return; }

    detailEl._apiRows = rows;

    detailEl.innerHTML = rows.map((r, rowIdx) => {
      const parts = [];

      if (rows.length > 1) {
        parts.push(`<div class="api-detail-method-header">
          <span class="api-method api-method-${r.method}">${r.method}</span>
          <code class="api-detail-path">${escapeHtml(r.path)}</code>
        </div>`);
      }

      if (r.description) {
        parts.push(`<p class="api-detail-desc">${escapeHtml(r.description.split('\n')[0])}</p>`);
      }

      // ── Parameters ──
      const params = (Array.isArray(r.parameters) ? r.parameters : []).filter(p => p.name);
      if (params.length) {
        parts.push(`<p class="api-detail-label">Parameters <span class="api-detail-count">${params.length}</span></p>`);
        parts.push('<div class="api-param-list">');
        for (const p of params) {
          const type = p.schema?.type || (p.schema?.$ref ? p.schema.$ref.replace(/.*\//, '') : '');
          const firstSentence = p.description ? p.description.split(/\.\s/)[0] + '.' : '';
          parts.push(`<div class="api-param-item">
            <div class="api-param-meta">
              <code class="api-param-name">${escapeHtml(p.name)}</code>
              <span class="api-param-in api-param-in-${p.in}">${p.in}</span>
              ${type  ? `<span class="api-param-type">${escapeHtml(type)}</span>` : ''}
              ${p.required ? '<span class="api-param-required">required</span>' : ''}
            </div>
            ${firstSentence ? `<p class="api-param-desc">${escapeHtml(firstSentence)}</p>` : ''}
          </div>`);
        }
        parts.push('</div>');
      }

      // ── Request Body ──
      if (r.request_body) {
        parts.push(`<p class="api-detail-label">Request Body</p>`);
        parts.push(renderSchemaBlock(r.request_body));
      }

      // ── Responses ──
      const respEntries = r.responses ? Object.entries(r.responses) : [];
      if (respEntries.length) {
        parts.push(`<p class="api-detail-label">Responses</p>`);
        parts.push('<div class="api-responses">');
        for (const [code, resp] of respEntries) {
          const schema   = pickSchema(resp?.content);
          const ref      = schema?.$ref?.replace(/.*\//, '');
          const firstKey = code[0]; // '2', '4', '5'
          parts.push(`<div class="api-response-item">
            <span class="api-response-code api-rc-${firstKey}">${code}</span>
            <span class="api-response-desc">${escapeHtml(resp.description || '')}</span>
            ${ref ? `<code class="api-schema-ref-inline">→ ${escapeHtml(ref)}</code>` : ''}
          </div>`);
          if (schema?.properties) {
            parts.push(renderSchemaFields(schema));
          }
        }
        parts.push('</div>');
      }

      parts.push(`<button class="api-use-btn" onclick="injectApiContext(${idx},${rowIdx})">+ Add to prompt</button>`);

      return `<div class="api-detail-block">${parts.join('')}</div>`;
    }).join('<div class="api-detail-sep"></div>');

    detailEl.dataset.loaded = '1';
  } catch (err) {
    detailEl.innerHTML = `<p class="api-search-hint" style="color:#ff6b6b">Error: ${escapeHtml(err.message)}</p>`;
  }
}

function pickSchema(content) {
  if (!content) return null;
  return content['application/json']?.schema
    || content['application/vnd.oracle.adf.resourceitem+json']?.schema
    || content['application/vnd.oracle.adf.resourcecollection+json']?.schema
    || Object.values(content)[0]?.schema
    || null;
}

function renderSchemaBlock(body) {
  // Top-level $ref on the body object itself (e.g. Oracle's requestBodies components)
  if (body?.$ref) {
    const name = body.$ref.replace(/.*\//, '');
    return `<div class="api-schema-ref-block">Schema: <code>${escapeHtml(name)}</code></div>`;
  }
  const schema = pickSchema(body?.content);
  if (!schema) return '<p class="api-param-desc" style="margin:4px 0 8px">No schema defined.</p>';
  if (schema.$ref) {
    const name = schema.$ref.replace(/.*\//, '');
    return `<div class="api-schema-ref-block">Schema: <code>${escapeHtml(name)}</code></div>`;
  }
  return renderSchemaFields(schema);
}

function renderSchemaFields(schema) {
  const props    = schema.properties || {};
  const required = schema.required   || [];
  const entries  = Object.entries(props);
  if (!entries.length) return '<p class="api-param-desc" style="margin:4px 0 8px">No properties.</p>';

  const rows = entries.map(([name, prop]) => {
    const isReq = required.includes(name);
    const type  = prop.type
      || (prop.$ref     ? prop.$ref.replace(/.*\//, '')    : '')
      || (prop.allOf    ? 'object'                         : '')
      || (prop.items    ? `array[${prop.items?.type || ''}]` : '')
      || 'any';
    const example = prop.example !== undefined ? String(prop.example) : null;
    const desc    = prop.description ? prop.description.split(/\.\s/)[0] + '.' : '';
    return `<div class="api-schema-field">
      <div class="api-param-meta">
        <code class="api-param-name">${escapeHtml(name)}</code>
        <span class="api-param-type">${escapeHtml(type)}</span>
        ${isReq ? '<span class="api-param-required">required</span>' : ''}
      </div>
      ${desc    ? `<p class="api-param-desc">${escapeHtml(desc)}</p>` : ''}
      ${example ? `<p class="api-param-desc api-param-example">e.g. <code>${escapeHtml(example)}</code></p>` : ''}
    </div>`;
  });
  return `<div class="api-schema-fields">${rows.join('')}</div>`;
}

function injectApiContext(idx, rowIdx) {
  const detailEl = document.getElementById(`api-detail-${idx}`);
  const r        = detailEl?._apiRows?.[rowIdx];
  if (!r) return;

  const lines = [`${r.method} ${r.path}`];
  if (r.summary) lines.push(r.summary);
  lines.push('');

  const params = (Array.isArray(r.parameters) ? r.parameters : []).filter(p => p.name);
  if (params.length) {
    lines.push('Parameters:');
    for (const p of params) {
      const type = p.schema?.type || '';
      lines.push(`  ${p.name} (${p.in}${p.required ? ', required' : ''}${type ? ', ' + type : ''})`);
    }
    lines.push('');
  }

  if (r.request_body) {
    const schema = pickSchema(r.request_body?.content);
    if (schema?.properties) {
      const req = schema.required || [];
      lines.push('Request Body:');
      for (const [name, prop] of Object.entries(schema.properties)) {
        const type = prop.type || (prop.$ref ? prop.$ref.replace(/.*\//, '') : 'object');
        lines.push(`  ${name}${req.includes(name) ? ' *' : ''}: ${type}`);
      }
      lines.push('');
    } else if (schema?.$ref) {
      lines.push(`Request Body: ${schema.$ref.replace(/.*\//, '')}`);
      lines.push('');
    }
  }

  const block = `[API: ${r.method} ${r.path}]\n${lines.join('\n').trim()}\n\n`;
  const ta    = document.getElementById('prompt-input');
  ta.value    = block + ta.value;
  ta.focus();
  ta.setSelectionRange(block.length, block.length);
  autosize();
  document.getElementById('api-search-panel').style.display = 'none';
  ta.closest('.input-row')?.classList.add('api-injected');
  setTimeout(() => ta.closest('.input-row')?.classList.remove('api-injected'), 800);
}

async function copyContent() {
  let text = '';
  if (lastFlexipage) {
    text = JSON.stringify(lastFlexipage, null, 2);
  } else {
    const markdownBody = document.querySelector('.markdown-body');
    const streamRaw    = document.querySelector('.stream-raw');
    const jsonCode     = document.querySelector('.json-code');
    if (markdownBody) text = markdownBody.innerText;
    else if (jsonCode) text = jsonCode.textContent;
    else if (streamRaw) text = streamRaw.textContent;
  }
  if (!text) return;
  try {
    await navigator.clipboard.writeText(text);
    const btn = document.getElementById('btn-copy');
    if (!btn) return;
    const prev = btn.innerHTML;
    btn.innerHTML = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="20 6 9 17 4 12"/></svg>`;
    btn.style.color = '#34c759';
    btn.title = 'Copied!';
    setTimeout(() => { btn.innerHTML = prev; btn.style.color = ''; btn.title = 'Copy to clipboard'; }, 1600);
  } catch {
    /* clipboard blocked */
  }
}

function escapeHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
