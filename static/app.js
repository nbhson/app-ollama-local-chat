// Ollama Chat web UI logic — round 2
// Features: conversation history (localStorage), system-prompt presets,
// export (MD/JSON), light/dark theme, regenerate, sanitized markdown.
(function () {
  'use strict';

  const chatEl = document.getElementById('chat');
  const inputEl = document.getElementById('input');
  const sendBtn = document.getElementById('sendbtn');
  const stopBtn = document.getElementById('stopbtn');
  const modelSelect = document.getElementById('modelSelect');
  const ollamaUrlInput = document.getElementById('ollamaUrl');
  const tempInput = document.getElementById('temperature');
  const statusEl = document.getElementById('status');
  const settingsBtn = document.getElementById('settingsbtn');
  const settingsPanel = document.getElementById('settings');
  const systemPromptEl = document.getElementById('systemPrompt');
  const presetSelect = document.getElementById('presetSelect');
  const themeToggle = document.getElementById('themeToggle');
  const mdToggleBtn = document.getElementById('md-toggle');
  const sessionStatsEl = document.getElementById('session-stats');
  const capBadges = document.querySelectorAll('.cap-badge');

  const sidebar = document.getElementById('sidebar');
  const sidebarToggle = document.getElementById('sidebarToggle');
  const sidebarClose = document.getElementById('sidebarClose');
  const backdrop = document.getElementById('backdrop');
  const newChatBtn = document.getElementById('newChatBtn');
  const conversationList = document.getElementById('conversationList');
  const exportSelect = document.getElementById('exportSelect');

  const attachBtn = document.getElementById('attachbtn');
  const fileInput = document.getElementById('fileInput');
  const previewBar = document.getElementById('previewbar');
  const micBtn = document.getElementById('micbtn');
  const addBtn = document.getElementById('addbtn');
  const addMenu = document.getElementById('addmenu');

  const DEFAULT_URL = 'http://localhost:11434';
  const DEFAULT_TEMP = 0.7;
  const LS = {
    conversations: 'oc:conversations',
    currentId: 'oc:currentId',
    theme: 'oc:theme',
    md: 'oc:mdRendering',
    settings: 'oc:settings'
  };

  // Rough cost estimator. Local Ollama is free; these placeholder rates model
  // typical API pricing (USD per 1M tokens). Tune as needed.
  const COST_INPUT_PER_1M = 0.10;
  const COST_OUTPUT_PER_1M = 0.40;

  const PRESETS = [
    { name: 'General', prompt: 'You are a helpful assistant.' },
    { name: 'Code assistant', prompt: 'You are an expert software engineer. Give precise, correct answers with short code examples when useful.' },
    { name: 'Translator', prompt: 'You are a translator. Detect the language of the user text and translate faithfully. Reply with the translation only.' },
    { name: 'Concise', prompt: 'Answer as briefly and directly as possible. No filler, no preamble.' },
    { name: 'Custom', prompt: null }
  ];

  let messages = [];            // messages of the CURRENT conversation
  let conversations = [];       // [{id, title, messages, createdAt, updatedAt}]
  let currentConvId = null;
  let isStreaming = false;
  let abortController = null;
  let pendingImages = [];
  let pendingAudio = null;
  let modelCaps = { vision: false, tools: false, thinking: false, audio: false };
  let mdRendering = false;

  function uid() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  }

  // ── Formatting helpers ─────────────────────────────────────────────────
  function fmtNum(n) {
    if (n >= 1e9) return (n / 1e9).toFixed(2) + 'B';
    if (n >= 1e6) return (n / 1e6).toFixed(2) + 'M';
    if (n >= 1e3) return (n / 1e3).toFixed(1) + 'k';
    return String(Math.round(n));
  }

  function fmtCost(tokens, ratePer1M) {
    return '$' + ((tokens / 1e6) * ratePer1M).toFixed(4);
  }

  function updateSessionStats() {
    const total = sessionStats.promptTokens + sessionStats.outputTokens;
    const cost = fmtCost(sessionStats.promptTokens, COST_INPUT_PER_1M) +
                 ' + ' + fmtCost(sessionStats.outputTokens, COST_OUTPUT_PER_1M);
    sessionStatsEl.textContent =
      'session: ' + fmtNum(total) + ' tokens (' +
      fmtNum(sessionStats.promptTokens) + ' in / ' +
      fmtNum(sessionStats.outputTokens) + ' out) · est ' + cost;
  }

  // Single source of truth for the per-response meta line (F5).
  function renderMeta(metaDiv, data) {
    const outTokens = data.output_tokens || 0;
    const evalMs = (data.eval_duration || 0) / 1e6;
    const totalMs = (data.total_duration || 0) / 1e6;
    const latency = evalMs > 0 ? evalMs / 1000 : totalMs / 1000;
    const tps = latency > 0 ? outTokens / latency : 0;
    const parts = [
      latency.toFixed(1) + 's',
      Math.round(tps) + ' tokens/s',
      fmtNum(outTokens) + ' tokens out',
      fmtNum(data.prompt_tokens || 0) + ' tokens in',
      'est ' + fmtCost(outTokens, COST_OUTPUT_PER_1M)
    ];
    if (data.live) parts.push('…');
    metaDiv.textContent = parts.join(' · ');
  }
  // ── Persistence ────────────────────────────────────────────────────────
  function loadState() {
    try { conversations = JSON.parse(localStorage.getItem(LS.conversations) || '[]'); }
    catch (e) { conversations = []; }
    if (!Array.isArray(conversations)) conversations = [];
    currentConvId = localStorage.getItem(LS.currentId) || null;
    mdRendering = localStorage.getItem(LS.md) === '1';
  }

  function persistConversations(stripAttachments) {
    try {
      localStorage.setItem(LS.conversations, JSON.stringify(conversations));
    } catch (e) {
      // Quota: base64 images blow the 5MB limit fast. Retry without
      // attachments; if still failing, drop oldest conversations.
      if (stripAttachments) {
        conversations.forEach(c => {
          c.messages.forEach(m => { delete m.images; delete m.audio; });
        });
        try { localStorage.setItem(LS.conversations, JSON.stringify(conversations)); return; } catch (e2) {}
      }
      while (conversations.length > 1) {
        conversations.shift();
        try {
          localStorage.setItem(LS.conversations, JSON.stringify(conversations));
          return;
        } catch (e2) { /* keep dropping */ }
      }
    }
  }

  function currentConv() {
    return conversations.find(c => c.id === currentConvId) || null;
  }

  function saveCurrentConversation() {
    if (!currentConvId) return;
    const conv = conversations.find(c => c.id === currentConvId);
    if (!conv) return;
    conv.messages = messages;
    conv.updatedAt = Date.now();
    persistConversations(true);
  }

  // ── Conversations sidebar ──────────────────────────────────────────────
  function renderConversationList() {
    conversationList.innerHTML = '';
    const sorted = [...conversations].sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
    if (sorted.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'conversation-empty';
      empty.textContent = 'No conversations yet';
      conversationList.appendChild(empty);
      return;
    }
    sorted.forEach(conv => {
      const item = document.createElement('div');
      item.className = 'conversation-item' + (conv.id === currentConvId ? ' active' : '');
      const title = document.createElement('span');
      title.className = 'conv-title';
      title.textContent = conv.title || 'Untitled';
      title.title = conv.title || '';
      const actions = document.createElement('span');
      actions.className = 'conv-actions';
      const renameBtn = document.createElement('button');
      renameBtn.textContent = '✎';
      renameBtn.title = 'Rename';
      renameBtn.addEventListener('click', (e) => { e.stopPropagation(); renameConversation(conv.id); });
      const delBtn = document.createElement('button');
      delBtn.className = 'del';
      delBtn.textContent = '🗑';
      delBtn.title = 'Delete conversation';
      delBtn.addEventListener('click', (e) => { e.stopPropagation(); deleteConversation(conv.id); });
      actions.appendChild(renameBtn);
      actions.appendChild(delBtn);
      item.appendChild(title);
      item.appendChild(actions);
      item.addEventListener('click', () => switchConversation(conv.id));
      conversationList.appendChild(item);
    });
  }

  function newConversation() {
    const conv = {
      id: uid(),
      title: 'New chat',
      messages: [],
      createdAt: Date.now(),
      updatedAt: Date.now()
    };
    conversations.push(conv);
    currentConvId = conv.id;
    messages = [];
    persistConversations(false);
    localStorage.setItem(LS.currentId, currentConvId);
    renderConversationList();
    renderConversation();
    setStatus('Ready', 'ok');
    inputEl.focus();
  }

  function switchConversation(id) {
    if (isStreaming) {
      abortController && abortController.abort();
    }
    const conv = conversations.find(c => c.id === id);
    if (!conv) return;
    currentConvId = id;
    messages = conv.messages || [];
    localStorage.setItem(LS.currentId, id);
    renderConversationList();
    renderConversation();
  }

  function deleteConversation(id) {
    const idx = conversations.findIndex(c => c.id === id);
    if (idx < 0) return;
    if (!confirm('Delete this conversation?')) return;
    conversations.splice(idx, 1);
    if (currentConvId === id) {
      currentConvId = null;
      messages = [];
      localStorage.removeItem(LS.currentId);
      chatEl.innerHTML = '';
      if (conversations.length > 0) {
        switchConversation(conversations[conversations.length - 1].id);
      }
    }
    persistConversations(false);
    renderConversationList();
  }

  function renameConversation(id) {
    const conv = conversations.find(c => c.id === id);
    if (!conv) return;
    const name = prompt('Rename conversation:', conv.title || '');
    if (name === null) return;
    conv.title = name.trim() || conv.title;
    conv.updatedAt = Date.now();
    persistConversations(false);
    renderConversationList();
  }

  function autoTitle(conv) {
    const firstUser = conv.messages.find(m => m.role === 'user');
    if (firstUser && conv.messages[0] && conv.messages[0].role === 'user') {
      const t = conv.messages[0].content.trim().replace(/\s+/g, ' ');
      if (t) conv.title = t.length > 42 ? t.slice(0, 42) + '…' : t;
    }
  }
  // ── Markdown rendering ─────────────────────────────────────────────────
  function renderMarkdown(text) {
    if (typeof marked === 'undefined') return text;
    let html = marked.parse(text, { breaks: true, gfm: true });
    // Model output is untrusted — sanitize before it ever enters the DOM (F1).
    if (typeof DOMPurify !== 'undefined') {
      html = DOMPurify.sanitize(html, { USE_PROFILES: { html: true } });
    }
    return html;
  }

  // highlight.js v5+ dropped the `highlight` option — highlight AFTER parse (F2).
  function postProcessContent(container) {
    container.querySelectorAll('pre code').forEach(codeEl => {
      if (codeEl.dataset.highlighted) return;
      if (typeof hljs !== 'undefined') {
        try { hljs.highlightElement(codeEl); } catch (e) { /* non-fatal */ }
        codeEl.dataset.highlighted = '1';
      }
    });
    attachCopyButtons(container);
  }

  function attachCopyButtons(container) {
    container.querySelectorAll('pre code').forEach(codeEl => {
      const pre = codeEl.parentElement;
      if (!pre || pre.parentElement.classList.contains('copy-wrapper')) return;
      const wrapper = document.createElement('div');
      wrapper.className = 'copy-wrapper';
      pre.parentNode.insertBefore(wrapper, pre);
      wrapper.appendChild(pre);
      const btn = document.createElement('button');
      btn.className = 'copy-btn';
      btn.title = 'Copy code';
      btn.textContent = 'Copy';
      btn.addEventListener('click', () => {
        navigator.clipboard.writeText(codeEl.textContent).then(() => {
          btn.textContent = 'Copied!';
          setTimeout(() => { btn.textContent = 'Copy'; }, 1500);
        }).catch(() => {
          btn.textContent = 'Failed';
          setTimeout(() => { btn.textContent = 'Copy'; }, 1500);
        });
      });
      wrapper.appendChild(btn);
    });
  }

  function fillContent(contentDiv, rawText, role) {
    // Raw text lives in data-raw — toggling Md re-renders from the source
    // text, not from already-rendered HTML (F3).
    contentDiv.dataset.raw = rawText;
    if (mdRendering) {
      contentDiv.innerHTML = renderMarkdown(rawText);
      postProcessContent(contentDiv);
    } else {
      contentDiv.textContent = rawText;
    }
  }

  // ── Scroll: only follow the stream when the user is near the bottom (F4).
  function isNearBottom() {
    return chatEl.scrollHeight - chatEl.scrollTop - chatEl.clientHeight < 80;
  }

  function scrollToBottom(force) {
    if (force || isNearBottom()) chatEl.scrollTop = chatEl.scrollHeight;
  }

  // ── Message rendering ──────────────────────────────────────────────────
  function addMessage(role, content, images, audioUrl, skipScroll) {
    const div = document.createElement('div');
    div.className = 'msg ' + role;
    const roleLabel = document.createElement('span');
    roleLabel.className = 'role';
    roleLabel.textContent = role === 'user' ? 'user' : role === 'assistant' ? 'assistant' : 'error';
    const contentDiv = document.createElement('div');
    contentDiv.className = 'content';
    fillContent(contentDiv, content, role);
    if (audioUrl) {
      const audioChip = document.createElement('span');
      audioChip.className = 'audio-chip';
      audioChip.textContent = '🎤 audio';
      contentDiv.appendChild(audioChip);
    }
    div.appendChild(roleLabel);
    div.appendChild(contentDiv);
    if (images && images.length > 0) {
      const imgWrap = document.createElement('div');
      imgWrap.className = 'images';
      images.forEach(dUrl => {
        const im = document.createElement('img');
        im.src = dUrl;
        imgWrap.appendChild(im);
      });
      div.appendChild(imgWrap);
    }
    if (role === 'assistant') {
      const actions = document.createElement('div');
      actions.className = 'msg-actions';
      div.appendChild(actions);
    }
    chatEl.appendChild(div);
    if (!skipScroll) scrollToBottom(true);
    return contentDiv;
  }

  // Rebuild the chat area from the current conversation's messages.
  function renderConversation() {
    chatEl.innerHTML = '';
    messages.forEach(m => {
      addMessage(m.role, m.content, (m.images || []).map(img => img.dataUrl),
        m.audio ? m.audio : null, true);
    });
    updateLastAssistantActions();
    chatEl.scrollTop = chatEl.scrollHeight;
  }

  function updateLastAssistantActions() {
    // Regenerate button only under the LAST assistant message.
    chatEl.querySelectorAll('.msg-actions').forEach(a => { a.innerHTML = ''; });
    const conv = currentConv();
    if (!conv || conv.messages.length === 0) return;
    if (conv.messages[conv.messages.length - 1].role !== 'assistant') return;
    const msgs = chatEl.querySelectorAll('.msg.assistant');
    const last = msgs.length ? msgs[msgs.length - 1] : null;
    if (!last) return;
    const btn = document.createElement('button');
    btn.textContent = '↻ Regenerate';
    btn.title = 'Regenerate this response';
    btn.addEventListener('click', regenerate);
    last.querySelector('.msg-actions').appendChild(btn);
  }

  // ── Theme ──────────────────────────────────────────────────────────────
  function applyTheme(theme) {
    document.documentElement.setAttribute('data-theme', theme);
    themeToggle.textContent = theme === 'light' ? '🌙' : '☀️';
    themeToggle.title = theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme';
    // Vendored highlight.js themes: exactly one stylesheet active at a time
    // so code blocks follow the light/dark toggle.
    const hljsDark = document.getElementById('hljsDark');
    const hljsLight = document.getElementById('hljsLight');
    if (hljsDark && hljsLight) {
      hljsDark.disabled = theme === 'light';
      hljsLight.disabled = theme !== 'light';
    }
    localStorage.setItem(LS.theme, theme);
  }

  function toggleTheme() {
    const cur = document.documentElement.getAttribute('data-theme') || 'dark';
    applyTheme(cur === 'dark' ? 'light' : 'dark');
  }
  // ── Model loading ──────────────────────────────────────────────────────
  function ollamaUrl() {
    return ollamaUrlInput.value.trim() || DEFAULT_URL;
  }

  async function loadModelInfo() {
    const model = modelSelect.value;
    if (!model) return;
    try {
      const resp = await fetch('/api/model-info', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ollama_url: ollamaUrl(), model: model })
      });
      if (!resp.ok) return; // keep previous state
      const data = await resp.json();
      modelCaps = data.supports || modelCaps;
      updateCapabilities();
    } catch (e) {
      // keep previous state
    }
  }

  function updateCapabilities() {
    capBadges.forEach(badge => {
      const cap = badge.dataset.cap;
      badge.classList.toggle('on', !!modelCaps[cap]);
      badge.classList.toggle('off', !modelCaps[cap]);
    });
    attachBtn.disabled = !modelCaps.vision;
    micBtn.disabled = !modelCaps.audio;
  }

  async function loadModels() {
    setStatus('Loading models...', 'busy');
    try {
      const urlParam = ollamaUrl();
      const resp = await fetch('/api/models' + (urlParam ? '?url=' + encodeURIComponent(urlParam) : ''));
      const data = await resp.json();
      modelSelect.innerHTML = '';
      if (data.error) {
        // Server meng distinguish "no models" vs "cannot connect" (S2).
        const opt = document.createElement('option');
        opt.textContent = '— no models —';
        opt.disabled = true;
        opt.selected = true;
        modelSelect.appendChild(opt);
        setStatus('Ollama unreachable: ' + data.error, 'err');
        return;
      }
      if (data.models && data.models.length > 0) {
        data.models.forEach(m => {
          const opt = document.createElement('option');
          opt.value = m;
          opt.textContent = m;
          modelSelect.appendChild(opt);
        });
        if (data.default && data.models.includes(data.default)) {
          modelSelect.value = data.default;
        }
        setStatus('Ready', 'ok');
        loadModelInfo();
      } else {
        const opt = document.createElement('option');
        opt.textContent = '— no models —';
        opt.disabled = true;
        opt.selected = true;
        modelSelect.appendChild(opt);
        setStatus('Ollama reachable but no models installed — run `ollama pull <model>`', 'err');
      }
    } catch (e) {
      setStatus('Failed to reach local server', 'err');
    }
  }

  // ── Presets ────────────────────────────────────────────────────────────
  function renderPresets() {
    presetSelect.innerHTML = '';
    PRESETS.forEach((p, i) => {
      const opt = document.createElement('option');
      opt.value = String(i);
      opt.textContent = p.name;
      presetSelect.appendChild(opt);
    });
  }

  function applyPreset(name) {
    const p = PRESETS.find(x => x.name === name);
    if (!p) return;
    if (p.prompt !== null) systemPromptEl.value = p.prompt;
    saveSettings();
  }

  function saveSettings() {
    try {
      localStorage.setItem(LS.settings, JSON.stringify({
        url: ollamaUrlInput.value,
        temp: tempInput.value,
        systemPrompt: systemPromptEl.value,
        preset: presetSelect.value
      }));
    } catch (e) { /* storage unavailable — non-fatal */ }
  }

  function restoreSettings() {
    let s = null;
    try { s = JSON.parse(localStorage.getItem(LS.settings) || 'null'); } catch (e) {}
    if (s) {
      if (s.url) ollamaUrlInput.value = s.url;
      if (s.systemPrompt !== undefined && s.systemPrompt !== null) systemPromptEl.value = s.systemPrompt;
      if (s.temp !== undefined && s.temp !== '') tempInput.value = s.temp;
      // Sync preset dropdown with stored prompt; fall back to Custom.
      const match = PRESETS.find(p => p.prompt !== null && p.prompt === systemPromptEl.value);
      presetSelect.value = match ? match.name : 'Custom';
      if (typeof s.preset === 'string' && PRESETS.some(p => p.name === s.preset) && !match) {
        presetSelect.value = s.preset;
      }
    }
  }
  // ── Streaming send / regenerate ────────────────────────────────────────
  function setStreamingUI(on) {
    isStreaming = on;
    sendBtn.disabled = on;
    stopBtn.style.display = on ? 'inline-block' : 'none';
  }

  function makeStreamingDom() {
    const div = document.createElement('div');
    div.className = 'msg assistant';
    const roleLabel = document.createElement('span');
    roleLabel.className = 'role';
    roleLabel.textContent = 'assistant';
    const thinkingDiv = document.createElement('div');
    thinkingDiv.className = 'thinking open';
    const toggle = document.createElement('span');
    toggle.className = 'thinking-toggle';
    toggle.textContent = '− thinking';
    toggle.title = 'Show/hide thinking';
    toggle.addEventListener('click', () => {
      const open = thinkingDiv.classList.toggle('open');
      toggle.textContent = open ? '− thinking' : '+ thinking';
    });
    const contentWrap = document.createElement('div');
    contentWrap.className = 'think-content-wrap';
    const thinkContent = document.createElement('div');
    thinkContent.className = 'think-content';
    contentWrap.appendChild(thinkContent);
    thinkingDiv.appendChild(toggle);
    thinkingDiv.appendChild(contentWrap);
    const contentDiv = document.createElement('div');
    contentDiv.className = 'content';
    const cursor = document.createElement('span');
    cursor.className = 'cursor';
    contentDiv.appendChild(cursor);
    const metaDiv = document.createElement('div');
    metaDiv.className = 'meta';
    const actions = document.createElement('div');
    actions.className = 'msg-actions';
    div.appendChild(roleLabel);
    div.appendChild(thinkingDiv);
    div.appendChild(contentDiv);
    div.appendChild(metaDiv);
    div.appendChild(actions);
    chatEl.appendChild(div);
    scrollToBottom(true);
    return { div, thinkingDiv, thinkContent, contentDiv, cursor, metaDiv };
  }

  async function runCompletion() {
    // Capture the history array at start: if the user switches conversations
    // mid-stream, the reply must land in the conversation it belongs to,
    // never in the one that happens to be active when the stream ends.
    const hist = messages;
    const { div, thinkingDiv, thinkContent, contentDiv, cursor, metaDiv } = makeStreamingDom();
    setStreamingUI(true);
    setStatus('Generating...', 'busy');
    abortController = new AbortController();
    let hadError = false;

    try {
      const resp = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ollama_url: ollamaUrl(),
          model: modelSelect.value,
          // Stored messages keep images as {dataUrl} for display/persistence;
          // Ollama expects raw base64 — derive it from the dataUrl.
          messages: hist.map(m => {
            if (m.images && m.images.length && typeof m.images[0] === 'object') {
              return Object.assign({}, m, {
                images: m.images.map(i => stripBase64Prefix(i.dataUrl))
              });
            }
            return m;
          }),
          temperature: parseFloat(tempInput.value) || DEFAULT_TEMP,
          system_prompt: systemPromptEl.value.trim()
        }),
        signal: abortController.signal
      });

      if (!resp.ok) {
        const err = await resp.json().catch(() => ({}));
        throw new Error(err.error || 'HTTP ' + resp.status);
      }

      const reader = resp.body.getReader();
      const decoder = new TextDecoder();
      let fullText = '';
      let fullThinking = '';
      let buffer = '';
      let hasThinking = false;
      let stats = null;
      let serverError = null;

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let lines = buffer.split('\n');
        buffer = lines.pop(); // keep incomplete line in buffer
        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const obj = JSON.parse(line);
            if (obj.t === 'think') {
              hasThinking = true;
              fullThinking += obj.d;
              thinkingDiv.style.display = 'block';
              thinkingDiv.classList.add('streaming');
              thinkContent.textContent = fullThinking;
              scrollToBottom(false);
            } else if (obj.t === 'content') {
              fullText += obj.d;
              cursor.remove();
              contentDiv.dataset.raw = fullText;
              if (mdRendering) {
                contentDiv.innerHTML = renderMarkdown(fullText);
                postProcessContent(contentDiv);
              } else {
                contentDiv.textContent = fullText;
              }
              scrollToBottom(false);
            } else if (obj.t === 'error') {
              // Server gửi lỗi dạng frame có cấu trúc {"t":"error","d":"..."}
              // — client parse được, không đoán bằng substring.
              serverError = obj.d || 'Unknown server error';
            } else if (obj.t === 'progress') {
              if (obj.output_tokens > 0) {
                renderMeta(metaDiv, Object.assign({}, obj, { live: true }));
              }
            } else if (obj.t === 'stats') {
              stats = obj;
              renderMeta(metaDiv, obj);
            }
          } catch (e) {
            // Dòng không phải JSON — bỏ qua im lặng.
          }
        }
      }

      thinkingDiv.classList.remove('streaming');
      if (!hasThinking) thinkingDiv.style.display = 'none';

      if (serverError) {
        hadError = true;
        contentDiv.textContent = serverError;
        div.className = 'msg error';
        setStatus('Error', 'err');
      } else if (fullText || fullThinking) {
        contentDiv.dataset.raw = fullText;
        hist.push({ role: 'assistant', content: fullText });
        setStatus('Ready', 'ok');
        if (stats) {
          renderMeta(metaDiv, stats);
          sessionStats.promptTokens += stats.prompt_tokens || 0;
          sessionStats.outputTokens += stats.output_tokens || 0;
          updateSessionStats();
        }
      } else {
        hadError = true;
        contentDiv.textContent = '(empty response from model)';
        setStatus('Ready', 'ok');
      }
    } catch (e) {
      if (e.name === 'AbortError') {
        // Keep whatever partial text arrived; append as the assistant turn.
        const partial = (contentDiv.dataset.raw || '').trim();
        if (partial) {
          hist.push({ role: 'assistant', content: partial + '\n\n_[Stopped]_' });
          contentDiv.textContent = partial + '\n\n[Stopped]';
        } else {
          contentDiv.textContent = '[Stopped]';
        }
        setStatus('Stopped', 'ok');
      } else {
        hadError = true;
        contentDiv.textContent = e.message || 'Unknown error';
        div.className = 'msg error';
        setStatus('Error', 'err');
      }
    } finally {
      setStreamingUI(false);
      abortController = null;
      scrollToBottom(false);
      // Save the conversation that owns `hist` (may differ from the active
      // one if the user switched mid-stream).
      const conv = conversations.find(c => c.messages === hist);
      if (conv) {
        conv.updatedAt = Date.now();
        autoTitle(conv);
      }
      persistConversations(true);
      renderConversationList();
      updateLastAssistantActions();
      inputEl.focus();
    }
    return !hadError;
  }

  async function sendMessage() {
    const text = inputEl.value.trim();
    if ((!text && pendingImages.length === 0 && !pendingAudio) || isStreaming) return;
    if (!modelSelect.value || modelSelect.options[0].disabled) {
      setStatus('Select a model first', 'err');
      return;
    }

    const msg = { role: 'user', content: text };
    const sentImages = [...pendingImages];
    const sentAudio = pendingAudio;
    if (sentImages.length > 0) msg.images = sentImages.map(img => img.b64);
    if (sentAudio) msg.audio = sentAudio.b64;

    // Ensure a conversation exists for this turn.
    if (!currentConvId) newConversation();
    const conv = currentConv();
    // Keep dataUrl for display + persistence; b64 payload goes to the server.
    const displayImages = sentImages.map(img => ({ dataUrl: img.dataUrl }));

    addMessage('user', text, displayImages.map(i => i.dataUrl), sentAudio ? sentAudio.dataUrl : null);
    conv.messages.push(Object.assign({}, msg, displayImages.length ? { images: displayImages } : {}));
    messages = conv.messages;
    pendingImages = [];
    pendingAudio = null;
    renderPreview();
    autoTitle(conv);
    renderConversationList();
    inputEl.value = '';
    inputEl.style.height = 'auto';
    saveCurrentConversation();

    await runCompletion();
  }

  async function regenerate() {
    if (isStreaming) return;
    // Drop the last assistant reply and stream a fresh one for the same history.
    const last = messages[messages.length - 1];
    if (!last || last.role !== 'assistant') return;
    messages.pop();
    const lastMsgDiv = chatEl.querySelectorAll('.msg.assistant');
    if (lastMsgDiv.length) lastMsgDiv[lastMsgDiv.length - 1].remove();
    saveCurrentConversation();
    await runCompletion();
  }
  // ── Export ─────────────────────────────────────────────────────────────
  function download(filename, text, mime) {
    const blob = new Blob([text], { type: mime });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => {
      URL.revokeObjectURL(url);
      a.remove();
    }, 0);
  }

  function slugify(s) {
    return (s || 'chat').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'chat';
  }

  function exportConversation(fmt) {
    const conv = currentConv();
    if (!conv || conv.messages.length === 0) {
      setStatus('Nothing to export', 'err');
      return;
    }
    let content, mime;
    if (fmt === 'json') {
      content = JSON.stringify({
        title: conv.title,
        exportedAt: new Date().toISOString(),
        model: modelSelect.value || null,
        messages: messages
      }, null, 2);
      mime = 'application/json';
    } else {
      const lines = ['# ' + (conv.title || 'Chat'), ''];
      messages.forEach(m => {
        lines.push('**' + m.role + ':**', '', m.content, '');
      });
      content = lines.join('\n');
      mime = 'text/markdown';
    }
    const stamp = new Date().toISOString().slice(0, 10);
    const name = slugify(conv.title) + '-' + stamp + (fmt === 'json' ? '.json' : '.md');
    download(name, content, mime);
    exportSelect.value = '';
    setStatus('Exported ' + name, 'ok');
  }

  // ── Attachments ────────────────────────────────────────────────────────
  function fileToDataUrl(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = reject;
      reader.readAsDataURL(file);
    });
  }

  function stripBase64Prefix(dataUrl) {
    const idx = dataUrl.indexOf(',');
    return idx >= 0 ? dataUrl.slice(idx + 1) : dataUrl;
  }

  // ── Audio recording ────────────────────────────────────────────────────
  let mediaRecorder = null;
  let isRecording = false;
  let recordedChunks = [];

  async function handleAudioBlob(blob) {
    const dataUrl = await fileToDataUrl(blob);
    const ext = blob.type.includes('mp4') ? 'm4a' : 'webm';
    pendingAudio = { name: 'audio.' + ext, dataUrl: dataUrl, b64: stripBase64Prefix(dataUrl) };
    renderPreview();
  }

  async function toggleRecording() {
    if (isRecording) {
      mediaRecorder && mediaRecorder.stop();
      return;
    }
    if (!navigator.mediaDevices || !window.MediaRecorder) {
      setStatus('Voice recording not supported', 'err');
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      recordedChunks = [];
      mediaRecorder = new MediaRecorder(stream);
      mediaRecorder.ondataavailable = e => {
        if (e.data.size > 0) recordedChunks.push(e.data);
      };
      mediaRecorder.onstop = async () => {
        stream.getTracks().forEach(t => t.stop());
        const blob = new Blob(recordedChunks, { type: mediaRecorder.mimeType || 'audio/webm' });
        if (blob.size > 0) await handleAudioBlob(blob);
        isRecording = false;
        micBtn.classList.remove('recording');
        micBtn.textContent = '🎤';
        micBtn.title = 'Record voice';
      };
      mediaRecorder.start();
      isRecording = true;
      micBtn.classList.add('recording');
      micBtn.textContent = '⏹';
      micBtn.title = 'Stop recording';
    } catch (e) {
      setStatus('Cannot access microphone', 'err');
    }
  }
  // ── Image attachments + drag & drop ────────────────────────────────────
  async function handleFiles(files) {
    const arr = Array.from(files || []).filter(f => f.type.startsWith('image/'));
    if (arr.length === 0) return;
    for (const file of arr) {
      try {
        const dataUrl = await fileToDataUrl(file);
        pendingImages.push({ name: file.name, dataUrl: dataUrl, b64: stripBase64Prefix(dataUrl) });
      } catch (err) {
        console.error('File error', err);
      }
    }
    renderPreview();
  }

  function renderPreview() {
    previewBar.innerHTML = '';
    if (pendingImages.length === 0 && !pendingAudio) {
      previewBar.classList.remove('open');
      return;
    }
    pendingImages.forEach((img, i) => {
      const item = document.createElement('div');
      item.className = 'preview-item';
      const thumb = document.createElement('img');
      thumb.src = img.dataUrl;
      const rm = document.createElement('button');
      rm.className = 'remove';
      rm.textContent = 'x';
      rm.title = 'Remove image';
      rm.addEventListener('click', () => {
        pendingImages.splice(i, 1);
        renderPreview();
      });
      item.appendChild(thumb);
      item.appendChild(rm);
      previewBar.appendChild(item);
    });
    if (pendingAudio) {
      const item = document.createElement('div');
      item.className = 'preview-item';
      const chip = document.createElement('span');
      chip.className = 'audio-chip';
      chip.textContent = '🎤 ' + pendingAudio.name;
      const rm = document.createElement('button');
      rm.className = 'remove';
      rm.textContent = 'x';
      rm.title = 'Remove audio';
      rm.addEventListener('click', () => {
        pendingAudio = null;
        renderPreview();
      });
      item.appendChild(chip);
      item.appendChild(rm);
      previewBar.appendChild(item);
    }
    const hint = document.createElement('span');
    hint.className = 'attach-hint';
    hint.textContent = '📎 ' + pendingImages.length + ' image(s)' + (pendingAudio ? ' + audio' : '');
    previewBar.appendChild(hint);
    previewBar.classList.add('open');
  }

  function setStatus(text, cls) {
    statusEl.textContent = text;
    statusEl.className = cls || '';
  }

  ['dragenter', 'dragover'].forEach(evt => {
    document.addEventListener(evt, (e) => {
      e.preventDefault();
      document.body.classList.add('dragover');
    });
  });
  ['dragleave', 'drop'].forEach(evt => {
    document.addEventListener(evt, (e) => {
      e.preventDefault();
      document.body.classList.remove('dragover');
    });
  });
  document.addEventListener('drop', (e) => {
    if (e.dataTransfer && e.dataTransfer.files) handleFiles(e.dataTransfer.files);
  });

  // ── Sidebar open/close (overlay on mobile) ─────────────────────────────
  function setSidebar(open) {
    sidebar.classList.toggle('hidden', !open);
    backdrop.classList.toggle('open', open && window.innerWidth <= 768);
  }

  sidebarToggle.addEventListener('click', () => setSidebar(sidebar.classList.contains('hidden')));
  sidebarClose.addEventListener('click', () => setSidebar(false));
  backdrop.addEventListener('click', () => setSidebar(false));
  window.addEventListener('resize', () => {
    if (window.innerWidth > 768) backdrop.classList.remove('open');
  });

  // ── Events ─────────────────────────────────────────────────────────────
  newChatBtn.addEventListener('click', newConversation);
  exportSelect.addEventListener('change', () => {
    if (exportSelect.value) exportConversation(exportSelect.value);
  });

  attachBtn.addEventListener('click', () => {
    fileInput.click();
    addMenu.classList.remove('open');
    addBtn.classList.remove('active');
  });
  micBtn.addEventListener('click', toggleRecording);
  addBtn.addEventListener('click', () => {
    addMenu.classList.toggle('open');
    addBtn.classList.toggle('active');
  });

  modelSelect.addEventListener('change', loadModelInfo);
  presetSelect.addEventListener('change', () => applyPreset(presetSelect.value));
  themeToggle.addEventListener('click', toggleTheme);

  mdToggleBtn.addEventListener('click', () => {
    mdRendering = !mdRendering;
    mdToggleBtn.classList.toggle('active', mdRendering);
    mdToggleBtn.title = mdRendering ? 'Switch to raw text (Ctrl+M)' : 'Switch to markdown (Ctrl+M)';
    localStorage.setItem(LS.md, mdRendering ? '1' : '0');
    // Re-render from data-raw source text (never from rendered HTML).
    document.querySelectorAll('.msg .content').forEach(contentDiv => {
      fillContent(contentDiv, contentDiv.dataset.raw || '', '');
    });
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'm' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      mdToggleBtn.click();
    }
  });

  fileInput.addEventListener('change', () => {
    handleFiles(fileInput.files);
    fileInput.value = '';
  });

  sendBtn.addEventListener('click', sendMessage);
  stopBtn.addEventListener('click', () => {
    if (abortController) abortController.abort();
  });

  inputEl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  });

  inputEl.addEventListener('input', () => {
    inputEl.style.height = 'auto';
    inputEl.style.height = Math.min(inputEl.scrollHeight, 160) + 'px';
  });

  ollamaUrlInput.addEventListener('change', () => { saveSettings(); loadModels(); });
  tempInput.addEventListener('change', saveSettings);
  systemPromptEl.addEventListener('change', saveSettings);

  settingsBtn.addEventListener('click', () => {
    settingsPanel.classList.toggle('open');
    settingsBtn.classList.toggle('active');
  });

  // ── Init ───────────────────────────────────────────────────────────────
  applyTheme(localStorage.getItem(LS.theme) || 'dark');
  mdRendering = localStorage.getItem(LS.md) === '1';
  mdToggleBtn.classList.toggle('active', mdRendering);
  renderPresets();
  loadState();
  restoreSettings();
  if (conversations.length === 0) {
    newConversation();
  } else {
    if (!currentConvId || !conversations.some(c => c.id === currentConvId)) {
      currentConvId = conversations[conversations.length - 1].id;
    }
    messages = currentConv().messages || [];
    renderConversationList();
    renderConversation();
  }
  updateCapabilities();
  loadModels();
  setSidebar(window.innerWidth > 768);
  inputEl.focus();
})();






