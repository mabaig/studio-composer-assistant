/* ═══════════════════════════════════════════════════════════
   Tab management
═══════════════════════════════════════════════════════════ */
function switchTab(name) {
  document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
  document.querySelectorAll('.tab-pane').forEach(p => p.classList.remove('active'));
  document.getElementById(`tab-${name}`)?.classList.add('active');
  document.getElementById(`pane-${name}`)?.classList.add('active');

  // Show camera button only in preview tab
  const dlPrev = document.getElementById('btn-download-preview');
  if (dlPrev) dlPrev.style.display = name === 'preview' ? 'flex' : 'none';

  // Lazy-load SCM tag chips on first open
  if (name === 'scmrest') {
    const chips = document.getElementById('scmrest-tag-chips');
    if (chips && chips.dataset.loaded !== '1') loadScmTags();
    setTimeout(() => document.getElementById('scmrest-q')?.focus(), 50);
  }
  if (name === 'javadoc') {
    setTimeout(() => document.getElementById('javadoc-tab-q')?.focus(), 50);
  }
}

/* ═══════════════════════════════════════════════════════════
   Constants & state
═══════════════════════════════════════════════════════════ */
const SESSION_KEY = 'composer_thread_id';
const AUTH_KEY    = 'composer_auth';
const THEME_KEY   = 'composer_theme';
const CREDS       = { user: 'intellinum.scm', pass: 'Welcome10' };

let attachedFile     = null;   // { name, content }
let lastFlexipage    = null;
let isStreaming      = false;
let turns            = [];     // [{ question, time, result, tokenText }]
let historyOpen      = false;
let currentMode      = 'new';  // 'new' | 'assistant' | 'edit'
let _diffOriginalFp  = null;
let _diffGeneratedFp = null;
let _activeScmTag    = null;

/* ═══════════════════════════════════════════════════════════
   Boot
═══════════════════════════════════════════════════════════ */
document.addEventListener('DOMContentLoaded', () => {
  initTheme();
  initLogin();
  initResizer();
  wireUI();
  initMic();
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
  // Always attach submit handler so logout → re-login works without a full reload
  const form = document.getElementById('login-form');
  form.removeEventListener('submit', handleLogin);
  form.addEventListener('submit', handleLogin);

  if (sessionStorage.getItem(AUTH_KEY)) {
    document.getElementById('login-overlay').style.display = 'none';
    showApp();
  } else {
    document.getElementById('login-overlay').style.display = 'flex';
    setTimeout(() => document.getElementById('login-username')?.focus(), 50);
  }
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
  document.getElementById('app').classList.add('visible');
  applyTheme(localStorage.getItem(THEME_KEY) || 'dark');
}

function handleLogout() {
  sessionStorage.removeItem(AUTH_KEY);
  document.getElementById('app').classList.remove('visible');
  document.getElementById('login-overlay').style.display = 'flex';
  document.getElementById('login-username').value = '';
  document.getElementById('login-password').value = '';
  document.getElementById('login-error').textContent = '';
  setTimeout(() => document.getElementById('login-username')?.focus(), 50);
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

  // Vertical resize inside chat panel (message list vs input area)
  const vHandle   = document.getElementById('chat-v-resize');
  const msgList   = document.getElementById('message-list');
  if (vHandle && msgList) {
    let vDrag = false, vStartY, vStartH;
    vHandle.addEventListener('mousedown', (e) => {
      vDrag   = true;
      vStartY = e.clientY;
      vStartH = msgList.offsetHeight;
      vHandle.classList.add('dragging');
      document.body.classList.add('resizing');
      e.preventDefault();
    });
    document.addEventListener('mousemove', (e) => {
      if (!vDrag) return;
      const newH = Math.max(60, Math.min(vStartH + (e.clientY - vStartY), window.innerHeight * 0.65));
      msgList.style.height = newH + 'px';
      msgList.style.flex   = 'none';
    });
    document.addEventListener('mouseup', () => {
      if (!vDrag) return;
      vDrag = false;
      vHandle.classList.remove('dragging');
      document.body.classList.remove('resizing');
    });
  }
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

  // Logout
  document.getElementById('btn-logout')?.addEventListener('click', handleLogout);

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
      const row = document.getElementById('attachment-row');
      row.classList.add('visible');
      row.classList.remove('edit-hint');
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
    currentMode      = 'new';
    _diffOriginalFp  = null;
    _diffGeneratedFp = null;
    document.querySelectorAll('.mode-btn').forEach(b => b.classList.toggle('active', b.dataset.mode === 'new'));
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

  // Mode selector
  document.getElementById('mode-group')?.addEventListener('click', (e) => {
    const btn = e.target.closest('.mode-btn');
    if (!btn) return;
    currentMode = btn.dataset.mode;
    document.querySelectorAll('.mode-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    // Edit page mode — nudge user to attach a file
    const attachRow = document.getElementById('attachment-row');
    if (currentMode === 'edit' && !attachedFile) {
      attachRow.classList.add('edit-hint');
    } else {
      attachRow.classList.remove('edit-hint');
    }
  });

  // SCM REST tab search input
  const scmQ = document.getElementById('scmrest-q');
  if (scmQ) {
    scmQ.addEventListener('input', () => debounceApiSearch(scmQ.value));
    scmQ.addEventListener('keydown', (e) => { if (e.key === 'Escape') { scmQ.value = ''; debounceApiSearch(''); } });
  }

  // JavaDoc tab search input
  const jdTabQ = document.getElementById('javadoc-tab-q');
  if (jdTabQ) {
    jdTabQ.addEventListener('input', () => debounceJavadocSearch(jdTabQ.value));
    jdTabQ.addEventListener('keydown', (e) => { if (e.key === 'Escape') { jdTabQ.value = ''; debounceJavadocSearch(''); } });
  }

  // Download preview image
  document.getElementById('btn-download-preview')?.addEventListener('click', downloadPreviewImage);

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
   Voice / Mic
═══════════════════════════════════════════════════════════ */
function initMic() {
  const btn = document.getElementById('btn-mic');
  if (!btn) return;

  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SpeechRecognition) {
    btn.style.display = 'none';
    return;
  }

  const recognition = new SpeechRecognition();
  recognition.continuous  = false;
  recognition.interimResults = true;
  recognition.lang = 'en-US';

  let listening = false;
  let baseText  = '';   // text in textarea before mic started

  recognition.onstart = () => {
    listening = true;
    btn.classList.add('mic-active');
    btn.title = 'Stop recording';
    baseText = document.getElementById('prompt-input').value;
  };

  recognition.onresult = (e) => {
    const transcript = Array.from(e.results).map(r => r[0].transcript).join('');
    const inp = document.getElementById('prompt-input');
    inp.value = (baseText ? baseText + ' ' : '') + transcript;
    autosize();
  };

  recognition.onend = () => {
    listening = false;
    btn.classList.remove('mic-active');
    btn.title = 'Speak your prompt';
    document.getElementById('prompt-input').focus();
  };

  recognition.onerror = () => {
    listening = false;
    btn.classList.remove('mic-active');
    btn.title = 'Speak your prompt';
  };

  btn.addEventListener('click', () => {
    if (listening) {
      recognition.stop();
    } else {
      try { recognition.start(); } catch { /* already started */ }
    }
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
/* Returns true when the prompt is purely a local review/preview request — no generation needed */
function isLocalOnlyIntent(q) {
  const clean  = q.toLowerCase().replace(/[.,!?]/g, '').trim();
  const tokens = clean.split(/\s+/);
  const ok = new Set([
    'review','preview','validate','check','analyze','analyse',
    'show','display','just','only','and','or','the','it','me',
    'code','json','page','file','both','please','can','you',
  ]);
  return tokens.length <= 8 && tokens.every(t => ok.has(t));
}

async function handleLocalIntent(question, fp) {
  clearResponsePanel();
  addMessage('user', question);
  document.getElementById('prompt-input').value = '';
  autosize();
  setStatus('Processing…', true);
  document.getElementById('btn-send').disabled = true;
  isStreaming = true;

  try {
    lastFlexipage = fp;
    document.getElementById('btn-download').classList.add('visible');

    const rc = document.getElementById('response-content');
    rc.innerHTML = '';
    const wrapper = document.createElement('div');
    wrapper.className = 'json-viewer';
    const pre = document.createElement('pre');
    const code = document.createElement('code');
    code.className = 'json-code';
    code.innerHTML = syntaxHighlightJSON(fp);
    pre.appendChild(code);
    wrapper.appendChild(pre);
    rc.appendChild(wrapper);
    const cb = document.getElementById('btn-copy');
    if (cb) cb.style.display = 'flex';

    const q = question.toLowerCase();
    const wantsPreview = q.includes('preview');
    const wantsReview  = q.includes('review') || q.includes('validate') || q.includes('check') || q.includes('analyz');

    renderPreview(fp);
    runReview(fp);

    if (wantsPreview && !wantsReview) switchTab('preview');
    else if (wantsReview && !wantsPreview) switchTab('review');

    addMessage('assistant', '✓ Loaded from file — no API call needed');
    pushTurn(question, { output: { flexipage: fp }, metadata: {} }, null);
    setStatus('Done', false);
  } catch (err) {
    setStatus('Error', false);
    document.getElementById('response-content').innerHTML =
      `<div class="error-msg">Error: ${escapeHtml(err.message)}</div>`;
    addMessage('assistant', `✗ ${err.message}`);
  } finally {
    document.getElementById('btn-send').disabled = false;
    isStreaming = false;
  }
}

async function handleSend() {
  const promptInput = document.getElementById('prompt-input');
  const question    = promptInput.value.trim();
  if (!question || isStreaming) return;

  // Skip API entirely for review/preview-only prompts
  if (isLocalOnlyIntent(question)) {
    let fp = null;
    if (attachedFile) {
      try { fp = JSON.parse(attachedFile.content); } catch { /* fall through */ }
    }
    if (!fp) fp = lastFlexipage;
    if (fp) { await handleLocalIntent(question, fp); return; }
  }

  addMessage('user', question);
  promptInput.value = '';
  autosize();

  clearResponsePanel();
  setStatus('Generating…', true);
  document.getElementById('btn-send').disabled = true;
  isStreaming = true;

  // Derive code value from mode
  let codeValue;
  if (currentMode === 'assistant') {
    codeValue = 'Assistant';
  } else if (currentMode === 'edit') {
    if (!attachedFile) {
      setStatus('Attach a JSON file for Edit page mode', false);
      document.getElementById('btn-send').disabled = false;
      isStreaming = false;
      document.getElementById('attachment-row').classList.add('edit-hint');
      return;
    }
    codeValue = attachedFile.content;
  } else {
    codeValue = 'Base';
  }

  const body = {
    input: {
      question,
      code: codeValue,
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
  const mode   = parsed?.output?.mode;

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

    // ── Edit mode: show diff view instead of plain JSON ──
    if (currentMode === 'edit' && attachedFile) {
      try {
        const origFp = JSON.parse(attachedFile.content);
        renderDiffView(origFp, fp);
        return;
      } catch { /* fall through to normal rendering */ }
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

    renderPreview(fp);
    runReview(fp);

  } else if (mode === 'assistant' || answer !== undefined) {
    /* ── Assistant markdown answer — render ONLY output.answer ── */
    renderMarkdown(typeof answer === 'string' ? answer : '');

  } else {
    /* ── Fallback: render raw response as JSON (non-assistant, no flexipage) ── */
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
  JSON_SCRIPT_STORE.length = 0;
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
  clearPreview();
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
  JSON_SCRIPT_STORE.length = 0;
  const json = JSON.stringify(obj, null, 2);
  const safe = json.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return safe.replace(
    /("(?:[^"\\]|\\.)*"\s*:)|("(?:[^"\\]|\\.)*")|(\b(?:true|false|null)\b)|(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/g,
    (match, key, str, bool, num) => {
      if (key)  return `<span class="json-key">${key}</span>`;
      if (str) {
        const inner = str.slice(1, -1)
          .replace(/\\n/g, '\n').replace(/\\t/g, '\t')
          .replace(/\\"/g, '"').replace(/\\\\/g, '\\');
        if (inner.startsWith('script:') || inner.startsWith('groovy:')) {
          const idx = JSON_SCRIPT_STORE.push(inner) - 1;
          return `<span class="json-string json-script-val" onclick="showJsonScriptDialog(${idx})" title="Click to view formatted code">⚡ ${str}</span>`;
        }
        return `<span class="json-string">${str}</span>`;
      }
      if (bool) return `<span class="json-boolean">${bool}</span>`;
      if (num)  return `<span class="json-number">${num}</span>`;
      return match;
    }
  );
}

/* ═══════════════════════════════════════════════════════════
   API Search (SCM REST tab)
═══════════════════════════════════════════════════════════ */
let _apiSearchTimer = null;

function debounceApiSearch(q) {
  clearTimeout(_apiSearchTimer);
  const resultsEl = document.getElementById('scmrest-results');
  if (!q.trim()) {
    _activeScmTag = null;
    document.querySelectorAll('.tag-chip').forEach(c => c.classList.remove('active'));
    resultsEl.innerHTML = '<p class="api-search-hint">Search by keyword or select a category above</p>';
    return;
  }
  resultsEl.innerHTML = '<p class="api-search-hint">Searching…</p>';
  _apiSearchTimer = setTimeout(() => runApiSearch(q), 300);
}

async function runApiSearch(q) {
  const resultsEl = document.getElementById('scmrest-results');
  try {
    const tagParam = _activeScmTag ? `&tag=${encodeURIComponent(_activeScmTag)}` : '';
    const res  = await fetch(`/api/search-api?q=${encodeURIComponent(q)}${tagParam}`);
    const data = await res.json();
    if (data.error) throw new Error(data.error);
    renderApiSearchResults(data);
  } catch (err) {
    resultsEl.innerHTML = `<p class="api-search-hint" style="color:#ff6b6b">Error: ${escapeHtml(err.message)}</p>`;
  }
}

function renderApiSearchResults(results) {
  const el = document.getElementById('scmrest-results');
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

/* ── SCM tag browser ───────────────────────────────────────── */
async function loadScmTags() {
  const chips = document.getElementById('scmrest-tag-chips');
  if (!chips) return;
  chips.dataset.loaded = '1';
  try {
    const res  = await fetch('/api/scm-tags');
    const tags = await res.json();
    if (tags.error) throw new Error(tags.error);
    chips.innerHTML = tags.map(t =>
      `<button class="tag-chip" onclick="filterByTag('${escapeHtml(t.name).replace(/'/g, "\\'")}')" title="${escapeHtml(t.description || '')}">
        ${escapeHtml(t.name)}<span class="tag-chip-count">${t.count}</span>
      </button>`
    ).join('');
  } catch (err) {
    chips.innerHTML = `<span class="api-search-hint" style="color:#ff6b6b">Failed to load categories: ${escapeHtml(err.message)}</span>`;
  }
}

async function filterByTag(tag) {
  _activeScmTag = tag;
  const resultsEl = document.getElementById('scmrest-results');
  const qInput    = document.getElementById('scmrest-q');
  if (qInput) qInput.value = '';

  document.querySelectorAll('.tag-chip').forEach(c => {
    c.classList.toggle('active', c.textContent.trim().startsWith(tag));
  });

  resultsEl.innerHTML = '<p class="api-search-hint">Loading…</p>';
  try {
    const res  = await fetch(`/api/search-api?tag=${encodeURIComponent(tag)}`);
    const data = await res.json();
    if (data.error) throw new Error(data.error);
    renderApiSearchResults(data);
  } catch (err) {
    resultsEl.innerHTML = `<p class="api-search-hint" style="color:#ff6b6b">Error: ${escapeHtml(err.message)}</p>`;
  }
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
          const firstKey = code[0];
          parts.push(`<div class="api-response-item">
            <span class="api-response-code api-rc-${firstKey}">${code}</span>
            <span class="api-response-desc">${escapeHtml(resp.description || '')}</span>
          </div>`);
          // Render schema inline or with Expand button for $ref
          parts.push(renderSchemaBlock(resp));
        }
        parts.push('</div>');
      }

      parts.push(`<button class="api-use-btn" onclick="injectApiContext(${idx},${rowIdx})">+ Add to prompt</button>`);

      // ── Try It section ──
      const qParams = (Array.isArray(r.parameters) ? r.parameters : []).filter(p => p.in === 'query' && p.name);
      const hasBody = ['POST','PUT','PATCH'].includes(r.method);
      const tryParts = [];
      if (qParams.length) {
        tryParts.push(`<div class="try-it-params"><p class="api-detail-label" style="margin-top:0">Query Parameters</p>`);
        for (const p of qParams) {
          tryParts.push(`<div class="try-it-param-row">
            <span class="try-it-param-name">${escapeHtml(p.name)}</span>
            <input class="try-it-input" data-try-param="${idx}-${rowIdx}" data-param-name="${escapeHtml(p.name)}"
              placeholder="${p.required ? 'required' : 'optional'}" autocomplete="off">
          </div>`);
        }
        tryParts.push(`</div>`);
      }
      if (hasBody) {
        const bodySchema = pickSchema(r.request_body?.content);
        const template = bodySchema?.properties
          ? JSON.stringify(Object.fromEntries(Object.keys(bodySchema.properties).map(k => [k, ''])), null, 2)
          : '{}';
        tryParts.push(`<div class="try-it-body-section">
          <p class="api-detail-label" style="margin-top:0">Request Body</p>
          <textarea id="try-it-body-${idx}-${rowIdx}" class="try-it-body" rows="4" spellcheck="false">${escapeHtml(template)}</textarea>
        </div>`);
      }
      tryParts.push(`<button class="try-it-execute-btn" onclick="executeScmApi(${idx},${rowIdx})">⚡ Execute</button>`);
      tryParts.push(`<div id="try-it-resp-${idx}-${rowIdx}" class="try-it-response" style="display:none"></div>`);

      parts.push(`<div class="try-it-section">
        <button class="try-it-toggle" onclick="toggleTryIt(this)">▶ Try It</button>
        <div class="try-it-content" style="display:none">${tryParts.join('')}</div>
      </div>`);

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
  if (body?.$ref) {
    const name = body.$ref.replace(/.*\//, '');
    return `<div class="api-schema-ref-block">Schema: <code>${escapeHtml(name)}</code><button class="api-expand-ref-btn" onclick="expandSchemaRef(this,'${escapeHtml(name)}')">Expand ▸</button></div>`;
  }
  const schema = pickSchema(body?.content);
  if (!schema) return '<p class="api-param-desc" style="margin:4px 0 8px">No schema defined.</p>';
  if (schema.$ref) {
    const name = schema.$ref.replace(/.*\//, '');
    return `<div class="api-schema-ref-block">Schema: <code>${escapeHtml(name)}</code><button class="api-expand-ref-btn" onclick="expandSchemaRef(this,'${escapeHtml(name)}')">Expand ▸</button></div>`;
  }
  return renderSchemaFields(schema);
}

async function expandSchemaRef(btn, schemaName) {
  btn.disabled = true;
  btn.textContent = '…';
  const container = btn.closest('.api-schema-ref-block');
  try {
    const res  = await fetch(`/api/schema?name=${encodeURIComponent(schemaName)}`);
    const data = await res.json();
    if (!data?.schema_def) { btn.disabled = false; btn.textContent = 'Not found'; return; }
    const schema = typeof data.schema_def === 'object' ? data.schema_def : JSON.parse(data.schema_def);
    if (container) container.outerHTML = renderSchemaFields(schema);
  } catch {
    btn.disabled = false; btn.textContent = 'Error';
  }
}

function renderSchemaFields(schema, depth) {
  depth = depth || 0;

  // Merge allOf sub-schemas
  if (!schema.properties && schema.allOf) {
    const merged = { properties: {}, required: [] };
    for (const sub of schema.allOf) {
      Object.assign(merged.properties, sub.properties || {});
      merged.required.push(...(sub.required || []));
    }
    if (Object.keys(merged.properties).length) return renderSchemaFields(merged, depth);
  }
  if (!schema.properties && (schema.anyOf || schema.oneOf)) {
    const variants = schema.anyOf || schema.oneOf;
    return variants.map(v => renderSchemaFields(v, depth)).join('');
  }

  const props    = schema.properties || {};
  const required = schema.required   || [];
  const entries  = Object.entries(props);
  if (!entries.length) return '<p class="api-param-desc" style="margin:4px 0 8px">No properties defined.</p>';

  const depthStyle = depth > 0
    ? ` style="margin-left:${depth * 10}px; border-left:2px solid var(--navy-border); padding-left:8px;"` : '';

  const rows = entries.map(([name, prop]) => {
    const isReq = required.includes(name);
    let type = 'any';
    if (prop.type) {
      type = prop.type;
      if (prop.type === 'array' && prop.items?.type) type = `array[${prop.items.type}]`;
      if (prop.type === 'array' && prop.items?.$ref)  type = `array[${prop.items.$ref.replace(/.*\//, '')}]`;
    } else if (prop.$ref)  { type = prop.$ref.replace(/.*\//, ''); }
    else if (prop.allOf)   { type = 'object'; }

    const example  = prop.example !== undefined ? String(prop.example) : null;
    const desc     = prop.description ? prop.description.split(/\.\s/)[0] + '.' : '';
    const extras   = [
      prop.maxLength ? `max ${prop.maxLength}` : '',
      prop.minLength ? `min ${prop.minLength}` : '',
      prop.format    ? prop.format              : '',
      prop.enum      ? `[${prop.enum.slice(0,5).join(', ')}${prop.enum.length > 5 ? '…' : ''}]` : '',
    ].filter(Boolean).map(x => `<span class="api-param-type">${escapeHtml(x)}</span>`).join('');

    // Recursive nested rendering
    let nestedHtml = '';
    if (depth < 3) {
      if ((prop.type === 'object' || (!prop.type && prop.properties)) && prop.properties) {
        nestedHtml = `<div class="api-schema-nested">${renderSchemaFields(prop, depth + 1)}</div>`;
      } else if (prop.type === 'array' && prop.items?.properties) {
        nestedHtml = `<div class="api-schema-nested"><div class="api-schema-array-label">items:</div>${renderSchemaFields(prop.items, depth + 1)}</div>`;
      } else if (prop.allOf) {
        const merged2 = { properties: {}, required: [] };
        for (const sub of prop.allOf) { Object.assign(merged2.properties, sub.properties || {}); merged2.required.push(...(sub.required || [])); }
        if (Object.keys(merged2.properties).length) nestedHtml = `<div class="api-schema-nested">${renderSchemaFields(merged2, depth + 1)}</div>`;
      }
    }

    return `<div class="api-schema-field"${depthStyle}>
      <div class="api-param-meta">
        <code class="api-param-name">${escapeHtml(name)}</code>
        <span class="api-param-type">${escapeHtml(type)}</span>
        ${isReq ? '<span class="api-param-required">required</span>' : ''}
        ${extras}
      </div>
      ${desc    ? `<p class="api-param-desc">${escapeHtml(desc)}</p>` : ''}
      ${example ? `<p class="api-param-desc api-param-example">e.g. <code>${escapeHtml(example)}</code></p>` : ''}
      ${nestedHtml}
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
  ta.closest('.input-row')?.classList.add('api-injected');
  setTimeout(() => ta.closest('.input-row')?.classList.remove('api-injected'), 800);
}

function toggleTryIt(btn) {
  const content = btn.nextElementSibling;
  const open    = content.style.display !== 'none';
  content.style.display = open ? 'none' : 'flex';
  btn.textContent        = open ? '▶ Try It' : '▼ Try It';
}

async function executeScmApi(idx, rowIdx) {
  const detailEl = document.getElementById(`api-detail-${idx}`);
  const r        = detailEl?._apiRows?.[rowIdx];
  const respEl   = document.getElementById(`try-it-resp-${idx}-${rowIdx}`);
  if (!r || !respEl) return;

  const queryParams = {};
  document.querySelectorAll(`[data-try-param="${idx}-${rowIdx}"]`).forEach(inp => {
    if (inp.value.trim()) queryParams[inp.dataset.paramName] = inp.value.trim();
  });

  const bodyEl = document.getElementById(`try-it-body-${idx}-${rowIdx}`);
  const body   = bodyEl ? bodyEl.value.trim() || null : null;

  respEl.style.display = 'block';
  respEl.innerHTML     = '<p class="api-search-hint" style="padding:10px">Executing…</p>';

  try {
    const res  = await fetch('/api/scm-execute', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ method: r.method, path: r.path, queryParams, body }),
    });
    const data = await res.json();
    if (data.error) throw new Error(data.error);
    const isOk   = data.status >= 200 && data.status < 300;
    const pretty = typeof data.data === 'object' && data.data !== null
      ? JSON.stringify(data.data, null, 2)
      : String(data.data ?? '(empty)');
    respEl.innerHTML = `
      <div class="try-it-status ${isOk ? 'try-it-ok' : 'try-it-err'}">HTTP ${data.status} ${escapeHtml(data.statusText || '')}</div>
      <pre class="try-it-response-body">${escapeHtml(pretty)}</pre>`;
  } catch (err) {
    respEl.innerHTML = `<p class="api-search-hint" style="color:#ff6b6b;padding:10px">Error: ${escapeHtml(err.message)}</p>`;
  }
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

/* ═══════════════════════════════════════════════════════════
   JSON Diff (Edit mode)
═══════════════════════════════════════════════════════════ */

function computeJsonDiffs(orig, gen, path) {
  if (path === undefined) path = '';
  const diffs = [];
  if (orig === gen) return diffs;

  if (
    typeof orig !== typeof gen ||
    orig === null || gen === null ||
    Array.isArray(orig) !== Array.isArray(gen) ||
    typeof orig !== 'object'
  ) {
    diffs.push({ path, type: 'modified', from: orig, to: gen });
    return diffs;
  }

  if (Array.isArray(orig)) {
    const maxLen = Math.max(orig.length, gen.length);
    for (let i = 0; i < maxLen; i++) {
      const cp = path ? `${path}[${i}]` : `[${i}]`;
      if (i >= orig.length)   diffs.push({ path: cp, type: 'added',   to: gen[i] });
      else if (i >= gen.length) diffs.push({ path: cp, type: 'removed', from: orig[i] });
      else                    diffs.push(...computeJsonDiffs(orig[i], gen[i], cp));
    }
    return diffs;
  }

  for (const key of new Set([...Object.keys(orig), ...Object.keys(gen)])) {
    const cp = path ? `${path}.${key}` : key;
    if (!(key in orig))    diffs.push({ path: cp, type: 'added',   to: gen[key] });
    else if (!(key in gen)) diffs.push({ path: cp, type: 'removed', from: orig[key] });
    else                   diffs.push(...computeJsonDiffs(orig[key], gen[key], cp));
  }
  return diffs;
}

function isScriptValue(v) {
  if (typeof v !== 'string') return false;
  return v.startsWith('script:') || (v.includes('\n') && v.length > 120);
}

function computeLineDiff(oldText, newText) {
  const ol = oldText.replace(/\r\n/g, '\n').split('\n');
  const nl = newText.replace(/\r\n/g, '\n').split('\n');
  const m = ol.length, n = nl.length;

  const dp = Array.from({ length: m + 1 }, () => new Int32Array(n + 1));
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = ol[i - 1] === nl[j - 1]
        ? dp[i - 1][j - 1] + 1
        : Math.max(dp[i - 1][j], dp[i][j - 1]);
    }
  }

  const result = [];
  let i = m, j = n;
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && ol[i - 1] === nl[j - 1]) {
      result.push({ type: 'same',    text: ol[i - 1] }); i--; j--;
    } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
      result.push({ type: 'added',   text: nl[j - 1] }); j--;
    } else {
      result.push({ type: 'removed', text: ol[i - 1] }); i--;
    }
  }
  return result.reverse();
}

function renderScriptDiff(from, to) {
  const lines = computeLineDiff(String(from), String(to));
  const parts = ['<div class="script-diff">'];
  for (const line of lines) {
    const prefix = line.type === 'added' ? '+' : line.type === 'removed' ? '-' : ' ';
    parts.push(`<div class="script-line-${line.type}"><span class="script-line-prefix">${prefix}</span><span>${escapeHtml(line.text)}</span></div>`);
  }
  parts.push('</div>');
  return parts.join('');
}

function truncateDiffVal(val) {
  const s = typeof val === 'object' && val !== null ? JSON.stringify(val, null, 2) : String(val ?? '');
  return s.length > 500 ? s.slice(0, 500) + '\n…(truncated)' : s;
}

function renderDiffItem(diff, idx) {
  const typeLabel = diff.type === 'added' ? 'Added' : diff.type === 'removed' ? 'Removed' : 'Modified';
  let valHtml = '';

  if (diff.type === 'modified' && (isScriptValue(diff.from) || isScriptValue(diff.to))) {
    valHtml = renderScriptDiff(diff.from ?? '', diff.to ?? '');
  } else if (diff.type === 'modified') {
    valHtml = `<div class="diff-values">
      <div class="diff-value diff-old"><span class="diff-val-label">Before</span><pre>${escapeHtml(truncateDiffVal(diff.from))}</pre></div>
      <div class="diff-value diff-new"><span class="diff-val-label">After</span><pre>${escapeHtml(truncateDiffVal(diff.to))}</pre></div>
    </div>`;
  } else if (diff.type === 'added') {
    valHtml = `<div class="diff-values">
      <div class="diff-value diff-new"><span class="diff-val-label">Value</span><pre>${escapeHtml(truncateDiffVal(diff.to))}</pre></div>
    </div>`;
  } else {
    valHtml = `<div class="diff-values">
      <div class="diff-value diff-old"><span class="diff-val-label">Was</span><pre>${escapeHtml(truncateDiffVal(diff.from))}</pre></div>
    </div>`;
  }

  return `<div class="diff-item" id="diff-item-${idx}">
    <div class="diff-item-header">
      <span class="diff-path">${escapeHtml(diff.path)}</span>
      <span class="diff-type-badge diff-type-${diff.type}">${typeLabel}</span>
    </div>
    ${valHtml}
  </div>`;
}

function renderDiffView(originalFp, generatedFp) {
  _diffOriginalFp  = originalFp;
  _diffGeneratedFp = generatedFp;

  const diffs    = computeJsonDiffs(originalFp, generatedFp);
  const added    = diffs.filter(d => d.type === 'added').length;
  const modified = diffs.filter(d => d.type === 'modified').length;
  const removed  = diffs.filter(d => d.type === 'removed').length;

  const MAX = 150;
  const toRender = diffs.slice(0, MAX);
  const overflow = diffs.length > MAX;

  const badgesHtml = [
    added    ? `<span class="diff-summary-badge diff-badge-added">+${added} added</span>`         : '',
    modified ? `<span class="diff-summary-badge diff-badge-modified">~${modified} changed</span>` : '',
    removed  ? `<span class="diff-summary-badge diff-badge-removed">-${removed} removed</span>`   : '',
  ].filter(Boolean).join('') || '<span class="diff-no-changes-label">No changes detected</span>';

  const wrapper = document.createElement('div');
  wrapper.className = 'diff-view';
  wrapper.innerHTML = `
    <div class="diff-toolbar">
      <div class="diff-summary">${badgesHtml}</div>
      <div class="diff-actions">
        <button class="diff-action-btn diff-keep"   onclick="keepOriginal()">Keep Original</button>
        <button class="diff-action-btn diff-accept" onclick="acceptAllChanges()">Accept All Changes</button>
      </div>
    </div>
    <div class="diff-list">
      ${toRender.map((d, i) => renderDiffItem(d, i)).join('')}
      ${overflow  ? `<div class="diff-overflow-notice">+ ${diffs.length - MAX} more changes not shown</div>` : ''}
      ${!diffs.length ? '<div class="diff-no-changes-msg">The generated FlexiPage is identical to the original.</div>' : ''}
    </div>`;

  document.getElementById('response-content').appendChild(wrapper);
  const cb = document.getElementById('btn-copy');
  if (cb) cb.style.display = 'flex';
}

function acceptAllChanges() {
  if (!_diffGeneratedFp) return;
  lastFlexipage    = _diffGeneratedFp;
  _diffOriginalFp  = null;
  _diffGeneratedFp = null;

  const rc = document.getElementById('response-content');
  rc.innerHTML = '';

  const wrapper = document.createElement('div');
  wrapper.className = 'json-viewer';
  const pre  = document.createElement('pre');
  const code = document.createElement('code');
  code.className = 'json-code';
  code.innerHTML = syntaxHighlightJSON(lastFlexipage);
  pre.appendChild(code);
  wrapper.appendChild(pre);
  rc.appendChild(wrapper);

  document.getElementById('btn-download').classList.add('visible');
  renderPreview(lastFlexipage);
  runReview(lastFlexipage);
}

function keepOriginal() {
  _diffOriginalFp  = null;
  _diffGeneratedFp = null;
  clearResponsePanel();
}

/* ═══════════════════════════════════════════════════════════
   Script dialog
═══════════════════════════════════════════════════════════ */
const SCRIPT_STORE      = [];  // preview node scripts
const JSON_SCRIPT_STORE = [];  // JSON output hover scripts

function showScriptDialogByIdx(idx)  { showScriptDialog(SCRIPT_STORE[idx]      || ''); }
function showJsonScriptDialog(idx)   { showScriptDialog(JSON_SCRIPT_STORE[idx] || ''); }

function showScriptDialog(raw) {
  const overlay  = document.getElementById('script-dialog-overlay');
  const code     = document.getElementById('script-dialog-code');
  const title    = document.getElementById('script-dialog-title');
  const isGroovy = raw.startsWith('groovy:');
  const src      = raw.replace(/^(script:|groovy:)\s*/i, '').trim();

  // Reset element so hljs re-highlights (it skips already-highlighted elements)
  code.removeAttribute('data-highlighted');
  code.textContent  = src;
  code.className    = isGroovy ? 'language-groovy' : 'language-java';
  title.textContent = isGroovy ? 'Groovy Script' : 'Java Script';

  if (typeof hljs !== 'undefined') hljs.highlightElement(code);
  overlay.style.display = 'flex';
}

function closeScriptDialog(e) {
  if (e && e.target !== document.getElementById('script-dialog-overlay')) return;
  document.getElementById('script-dialog-overlay').style.display = 'none';
}

/* ═══════════════════════════════════════════════════════════
   Page Preview (mockup renderer)
═══════════════════════════════════════════════════════════ */

function clearPreview() {
  const pc = document.getElementById('preview-content');
  if (!pc) return;
  pc.innerHTML = '<div class="empty-state"><svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke-width="1.2"><rect x="2" y="3" width="20" height="14" rx="2" stroke="var(--navy-border)"/><path d="M8 21h8M12 17v4" stroke="var(--navy-border)"/></svg><p>Generate a FlexiPage to see the page mockup.</p></div>';
  const pb = document.getElementById('preview-badge');
  if (pb) pb.style.display = 'none';
}

// Walk the entire JSON tree and collect every node that has both `type` and `properties`
function collectFlexiNodes(root) {
  const nodes = [];
  function walk(obj) {
    if (!obj || typeof obj !== 'object') return;
    if (Array.isArray(obj)) { obj.forEach(walk); return; }
    if (obj.type && obj.properties && typeof obj.properties === 'object') nodes.push(obj);
    for (const v of Object.values(obj)) { if (v && typeof v === 'object') walk(v); }
  }
  walk(root);
  return nodes;
}

const _INFRA_TYPES = new Set(['page', 'div', 'webservice', 'function', 'variable', 'handler', 'event']);

function nodeKind(typeStr) {
  const t = (typeStr || '').toLowerCase().replace(/[_\s-]/g, '');
  if (/button|btn|submit|action/.test(t))                   return 'button';
  if (/scan|barcode|camera/.test(t))                        return 'scan';
  if (/table|grid|datatable|listview/.test(t))              return 'table';
  if (/textarea|multiline/.test(t))                         return 'textarea';
  if (/^(lov|dropdown|select|combobox|listofvalues)$/.test(t)) return 'lov';
  if (/checkbox|toggle|switch/.test(t))                     return 'checkbox';
  if (/^radio/.test(t))                                     return 'radio';
  if (/label|statictext|heading/.test(t))                   return 'label';
  if (/field|input|text|number|date|time|email|phone|url|lookup|currency/.test(t)) return 'input';
  if (/header|banner|title/.test(t))                        return 'header';
  return 'generic';
}

function hasScriptProp(props) {
  return Object.values(props).some(v =>
    typeof v === 'string' && (v.startsWith('script:') || v.startsWith('groovy:'))
  );
}

function renderPreviewNode(node) {
  const type  = (node.type  || '').toLowerCase();
  const props = node.properties || {};
  const kind  = nodeKind(type);
  const label = props.label || props.text || props.title || props.placeholder || props.id || type;
  const req   = String(props.required || '').toLowerCase() === 'true';

  // Script badge
  const scriptEntries = Object.entries(props).filter(([, v]) =>
    typeof v === 'string' && (v.startsWith('script:') || v.startsWith('groovy:'))
  );
  let scriptBadge = '';
  if (scriptEntries.length) {
    const idx = SCRIPT_STORE.push(scriptEntries[0][1]) - 1;
    scriptBadge = `<button class="mobile-script-badge" onclick="showScriptDialogByIdx(${idx})">⚡ script</button>`;
  }

  const searchSvg = `<svg class="mobile-field-icon" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#009FDE" stroke-width="2"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>`;
  const scanSvg   = `<svg class="mobile-field-icon" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#009FDE" stroke-width="1.8"><rect x="3" y="3" width="5" height="5" rx="1"/><rect x="16" y="3" width="5" height="5" rx="1"/><rect x="3" y="16" width="5" height="5" rx="1"/><path d="M16 16h5v5"/><path d="M9 5.5h6"/><path d="M5.5 9v6"/></svg>`;

  if (kind === 'button') {
    const v = (props.variant || props._class || '').toLowerCase();
    const cls = v.includes('danger') || v.includes('destruct') ? 'mobile-btn-danger'
      : v.includes('secondary') || v.includes('neutral') ? 'mobile-btn-secondary'
      : 'mobile-btn-primary';
    return `<div>${scriptBadge}<button class="mobile-btn ${cls}" disabled>${escapeHtml(label)}</button></div>`;
  }

  if (kind === 'input' || kind === 'lov' || kind === 'textarea') {
    return `<div class="mobile-field-group">
      <div class="mobile-field-card">
        <div class="mobile-field-inner">
          <span class="mobile-field-lbl">${escapeHtml(label)}</span>
          <span class="mobile-field-val">&hairsp;</span>
        </div>${searchSvg}
      </div>
      ${req ? '<span class="mobile-req-text">Required</span>' : ''}
      ${scriptBadge}
    </div>`;
  }

  if (kind === 'scan') {
    return `<div class="mobile-field-group">
      <div class="mobile-field-card">
        <div class="mobile-field-inner">
          <span class="mobile-field-lbl">${escapeHtml(label)}</span>
          <span class="mobile-field-val">&hairsp;</span>
        </div>${scanSvg}
      </div>
      ${req ? '<span class="mobile-req-text">Required</span>' : ''}
      ${scriptBadge}
    </div>`;
  }

  if (kind === 'checkbox' || kind === 'radio') {
    const shape = kind === 'radio'
      ? `<span class="mobile-radio-dot"></span>`
      : `<span class="mobile-checkbox-tick"></span>`;
    return `<div class="mobile-check-row">${shape}<span class="mobile-check-lbl">${escapeHtml(label)}</span>${scriptBadge}</div>`;
  }

  if (kind === 'table') {
    const cols = (props.columns || props.fields || '').split(',').map(c => c.trim()).filter(Boolean).slice(0, 4);
    if (!cols.length) cols.push('Col 1', 'Col 2', 'Col 3');
    return `<div class="mobile-table-card">${scriptBadge}
      <div class="mobile-tbl-head">${cols.map(c => `<span>${escapeHtml(c)}</span>`).join('')}</div>
      <div class="mobile-tbl-row">${cols.map(() => '<span class="mobile-tbl-cell"></span>').join('')}</div>
      <div class="mobile-tbl-row alt">${cols.map(() => '<span class="mobile-tbl-cell"></span>').join('')}</div>
    </div>`;
  }

  if (kind === 'header') {
    return `<div class="mobile-section-hdr">${escapeHtml(label)}${scriptBadge}</div>`;
  }

  if (kind === 'label') {
    return `<div class="mobile-label-text">${escapeHtml(label)}${scriptBadge}</div>`;
  }

  return `<div class="mobile-generic-comp">${escapeHtml(label || type)}${scriptBadge}</div>`;
}

function renderPreview(fp) {
  const pc = document.getElementById('preview-content');
  if (!pc || !fp) return;

  SCRIPT_STORE.length = 0;

  const allNodes  = collectFlexiNodes(fp);
  const pageNode  = allNodes.find(n => (n.type || '').toLowerCase() === 'page');
  const pageProps = pageNode?.properties || {};
  const pageTitle = pageProps.title || pageProps.label || pageProps.id || fp.masterLabel || fp.label || 'FlexiPage';

  const uiNodes = allNodes.filter(n => !_INFRA_TYPES.has((n.type || '').toLowerCase()));
  const wsNodes = allNodes.filter(n => (n.type || '').toLowerCase() === 'webservice');
  const fnNodes = allNodes.filter(n => (n.type || '').toLowerCase() === 'function');

  const fieldsHtml = uiNodes.length
    ? uiNodes.map(renderPreviewNode).join('')
    : '<p class="mobile-empty-msg">No UI components found</p>';

  let metaHtml = '';
  if (wsNodes.length) {
    metaHtml += `<div class="preview-services">
      <div class="preview-services-title">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/></svg>
        Data Services
      </div>
      ${wsNodes.map(ws => {
        const p = ws.properties || {};
        const wid = p.id || '—';
        const url = p._wsurl || '';
        const op  = (p._operationType || 'GET').toUpperCase();
        const shortUrl = url.length > 55 ? url.slice(0, 55) + '…' : url;
        return `<div class="preview-service-row">
          <span class="preview-svc-id">${escapeHtml(wid)}</span>
          ${url ? `<span class="api-method api-method-${op}">${op}</span><span class="preview-svc-url">${escapeHtml(shortUrl)}</span>` : ''}
        </div>`;
      }).join('')}
    </div>`;
  }
  if (fnNodes.length) {
    metaHtml += `<div class="preview-services">
      <div class="preview-services-title">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/></svg>
        Functions
      </div>
      <div class="preview-fn-list">
        ${fnNodes.map(fn => `<span class="preview-fn-chip">${escapeHtml(fn.properties?.id || 'fn')}</span>`).join('')}
      </div>
    </div>`;
  }

  pc.innerHTML = `
    <div class="mobile-preview-wrap">
      <div class="mobile-phone-shell">
        <div class="mobile-statusbar">
          <span class="mobile-time">12:00</span>
          <div class="mobile-status-icons">
            <svg width="14" height="10" viewBox="0 0 24 16" fill="currentColor"><path d="M12 2C7 2 3 4.4 0 8c3 3.6 7 6 12 6s9-2.4 12-6C21 4.4 17 2 12 2zm0 10a4 4 0 1 1 0-8 4 4 0 0 1 0 8zm0-2a2 2 0 1 0 0-4 2 2 0 0 0 0 4z"/></svg>
            <svg width="16" height="10" viewBox="0 0 26 16" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="1" y="2" width="20" height="12" rx="2"/><path d="M23 6v4" stroke-width="3" stroke-linecap="round"/></svg>
          </div>
        </div>
        <div class="mobile-appbar">
          <div class="mobile-back-btn">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="2.5"><polyline points="15 18 9 12 15 6"/></svg>
          </div>
          <span class="mobile-page-title">${escapeHtml(pageTitle)}</span>
          <div class="mobile-app-icon">
            <svg width="22" height="22" viewBox="0 0 32 32">
              <rect width="32" height="32" rx="7" fill="#F47920"/>
              <polygon points="16,4 26,9.5 26,22.5 16,28 6,22.5 6,9.5" fill="rgba(255,255,255,0.15)"/>
              <polygon points="16,9 21,12 21,20 16,23 11,20 11,12" fill="rgba(255,255,255,0.9)"/>
            </svg>
          </div>
        </div>
        <div class="mobile-scroll-content">
          ${fieldsHtml}
        </div>
        <div class="mobile-action-bar">
          <button class="mobile-bar-btn" title="Menu">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="3" y1="6" x2="21" y2="6"/><line x1="3" y1="12" x2="21" y2="12"/><line x1="3" y1="18" x2="21" y2="18"/></svg>
          </button>
          <button class="mobile-bar-btn" title="Barcode">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 9V5a2 2 0 0 1 2-2h4M3 15v4a2 2 0 0 0 2 2h4M21 9V5a2 2 0 0 0-2-2h-4M21 15v4a2 2 0 0 1-2 2h-4"/><line x1="7" y1="8" x2="7" y2="16"/><line x1="10" y1="8" x2="10" y2="16"/><line x1="13" y1="8" x2="13" y2="16"/><line x1="16" y1="8" x2="16" y2="11"/><line x1="16" y1="13" x2="16" y2="16"/></svg>
          </button>
          <button class="mobile-bar-btn" title="QR scan">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="5" height="5" rx="1"/><rect x="16" y="3" width="5" height="5" rx="1"/><rect x="3" y="16" width="5" height="5" rx="1"/><path d="M16 16h5v5"/></svg>
          </button>
          <button class="mobile-bar-btn" title="Clear">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M20 5H9l-7 7 7 7h11a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2z"/><line x1="18" y1="9" x2="12" y2="15"/><line x1="12" y1="9" x2="18" y2="15"/></svg>
          </button>
          <button class="mobile-bar-btn" title="More">
            <svg width="20" height="20" viewBox="0 0 24 24"><circle cx="12" cy="5" r="1.5" fill="currentColor"/><circle cx="12" cy="12" r="1.5" fill="currentColor"/><circle cx="12" cy="19" r="1.5" fill="currentColor"/></svg>
          </button>
        </div>
        <div class="mobile-nav-bar">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="12,4 4,20 20,20"/></svg>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="8"/></svg>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2"/></svg>
        </div>
      </div>
      ${metaHtml ? `<div class="mobile-meta-side">${metaHtml}</div>` : ''}
    </div>`;

  const pb = document.getElementById('preview-badge');
  if (pb) { pb.textContent = uiNodes.length; pb.style.display = uiNodes.length ? 'inline-flex' : 'none'; }
}

/* ═══════════════════════════════════════════════════════════
   JavaDoc Search (JavaDoc tab)
═══════════════════════════════════════════════════════════ */
let _javadocSearchTimer = null;

function debounceJavadocSearch(q) {
  clearTimeout(_javadocSearchTimer);
  const el = document.getElementById('javadoc-tab-results');
  if (!q.trim()) {
    el.innerHTML = '<p class="api-search-hint">Search FlexiPro Java API — classes, methods, fields</p>';
    return;
  }
  el.innerHTML = '<p class="api-search-hint">Searching…</p>';
  _javadocSearchTimer = setTimeout(() => runJavadocSearch(q), 300);
}

async function runJavadocSearch(q) {
  const el = document.getElementById('javadoc-tab-results');
  try {
    const res  = await fetch(`/api/search-javadoc?q=${encodeURIComponent(q)}`);
    const data = await res.json();
    if (data.error) throw new Error(data.error);
    renderJavadocResults(data);
  } catch (err) {
    el.innerHTML = `<p class="api-search-hint" style="color:#ff6b6b">Error: ${escapeHtml(err.message)}</p>`;
  }
}

function renderJavadocResults(results) {
  const el = document.getElementById('javadoc-tab-results');
  if (!results.length) {
    el.innerHTML = '<p class="api-search-hint">No results found</p>';
    return;
  }
  el.innerHTML = results.map((r, i) => {
    const isClass  = r.result_type === 'class';
    const typeBadge = isClass
      ? `<span class="jd-type-badge jd-type-${r.class_type || 'class'}">${r.class_type || 'class'}</span>`
      : `<span class="jd-type-badge jd-type-${r.member_type || 'method'}">${r.member_type || 'method'}</span>`;

    const subtitle = isClass
      ? escapeHtml(r.package_name || r.qualified_name || '')
      : `<span class="jd-member-class">${escapeHtml(r.qualified_class_name || '')}</span>`;

    const summary = r.summary
      ? `<span class="api-result-summary">${escapeHtml(r.summary.slice(0, 80))}${r.summary.length > 80 ? '…' : ''}</span>`
      : '';

    return `<div class="api-result-item">
      <button class="api-result-header" onclick="toggleJavadocDetail(this, ${i}, '${escapeHtml(isClass ? r.name : (r.qualified_class_name || r.name))}', ${isClass})">
        ${typeBadge}
        <span class="api-result-path">${escapeHtml(r.name)}</span>
        ${summary}
        <svg class="api-result-chevron" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="6 9 12 15 18 9"/></svg>
      </button>
      <div class="jd-result-sub">${subtitle}</div>
      <div class="api-result-detail" id="jd-detail-${i}" style="display:none"></div>
    </div>`;
  }).join('');
}

async function toggleJavadocDetail(btn, idx, className, isClass) {
  const detailEl = document.getElementById(`jd-detail-${idx}`);
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
    const res  = await fetch(`/api/javadoc-class?name=${encodeURIComponent(className)}`);
    const data = await res.json();

    if (!data) {
      detailEl.innerHTML = '<p class="api-search-hint">No detail found</p>';
      return;
    }

    const { cls, members } = data;
    detailEl._jdData = data;

    const parts = [];
    if (cls.summary) {
      parts.push(`<p class="api-detail-desc">${escapeHtml(cls.summary.slice(0, 200))}${cls.summary.length > 200 ? '…' : ''}</p>`);
    }

    const byType = { constructor: [], method: [], field: [] };
    for (const m of members) {
      const key = m.member_type in byType ? m.member_type : 'method';
      byType[key].push(m);
    }

    for (const [mtype, list] of Object.entries(byType)) {
      if (!list.length) continue;
      parts.push(`<p class="api-detail-label">${mtype.charAt(0).toUpperCase() + mtype.slice(1)}s <span class="api-detail-count">${list.length}</span></p>`);
      parts.push('<div class="jd-member-list">');
      for (const m of list) {
        const ret = m.return_type ? `<span class="jd-return-type">${escapeHtml(m.return_type)}</span>` : '';
        const sig = m.signature && m.signature !== m.name
          ? `<code class="jd-signature">${escapeHtml(m.signature)}</code>` : '';
        const desc = m.summary ? `<p class="api-param-desc">${escapeHtml(m.summary.slice(0, 120))}${m.summary.length > 120 ? '…' : ''}</p>` : '';
        parts.push(`<div class="jd-member-item">
          <div class="jd-member-meta">
            ${ret}
            <code class="api-param-name">${escapeHtml(m.name)}</code>
            ${sig}
          </div>
          ${desc}
        </div>`);
      }
      parts.push('</div>');
    }

    parts.push(`<button class="api-use-btn" onclick="injectJavadocContext(${idx})">+ Add to prompt</button>`);
    parts.push(`<a href="/flexipro-javadoc/${cls.qualified_name?.replace(/\./g, '/')}.html" target="_blank" class="jd-browse-class-link">View in JavaDoc ↗</a>`);

    detailEl.innerHTML = `<div class="api-detail-block">${parts.join('')}</div>`;
    detailEl.dataset.loaded = '1';
  } catch (err) {
    detailEl.innerHTML = `<p class="api-search-hint" style="color:#ff6b6b">Error: ${escapeHtml(err.message)}</p>`;
  }
}

function injectJavadocContext(idx) {
  const detailEl = document.getElementById(`jd-detail-${idx}`);
  const data     = detailEl?._jdData;
  if (!data) return;

  const { cls, members } = data;
  const lines = [`[JavaDoc: ${cls.qualified_name || cls.class_name}]`];
  lines.push(`${cls.class_type || 'class'} ${cls.class_name} (${cls.package_name || ''})`);
  if (cls.summary) lines.push(cls.summary.slice(0, 150));
  lines.push('');

  const methods = members.filter(m => m.member_type === 'method').slice(0, 8);
  if (methods.length) {
    lines.push('Key methods:');
    for (const m of methods) {
      lines.push(`  ${m.return_type ? m.return_type + ' ' : ''}${m.signature || m.name}${m.summary ? ' — ' + m.summary.slice(0, 60) : ''}`);
    }
    lines.push('');
  }

  const block = lines.join('\n').trim() + '\n\n';
  const ta    = document.getElementById('prompt-input');
  ta.value    = block + ta.value;
  ta.focus();
  ta.setSelectionRange(block.length, block.length);
  autosize();
}

/* ═══════════════════════════════════════════════════════════
   Download preview as image
═══════════════════════════════════════════════════════════ */
async function downloadPreviewImage() {
  const shell = document.querySelector('.mobile-phone-shell');
  if (!shell) return;
  const btn = document.getElementById('btn-download-preview');
  if (btn) btn.disabled = true;
  try {
    if (typeof html2canvas === 'undefined') {
      alert('html2canvas library not loaded — cannot capture preview.');
      return;
    }
    const canvas = await html2canvas(shell, {
      backgroundColor: '#1a1a1a',
      scale: 2,
      logging: false,
      useCORS: true,
    });
    const url = canvas.toDataURL('image/png');
    const a   = document.createElement('a');
    a.href = url;
    a.download = 'flexipage-preview.png';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  } catch (err) {
    console.error('Preview download failed:', err);
  } finally {
    if (btn) btn.disabled = false;
  }
}
