// Ollama Chat web UI logic
(function () {
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

  const attachBtn = document.getElementById('attachbtn');
  const fileInput = document.getElementById('fileInput');
  const previewBar = document.getElementById('previewbar');
  const micBtn = document.getElementById('micbtn');
  const addBtn = document.getElementById('addbtn');
  const addMenu = document.getElementById('addmenu');
  const capBadges = document.querySelectorAll('.cap-badge');

  const DEFAULT_URL = 'http://localhost:11434';
  const DEFAULT_TEMP = 0.7;

  // Rough cost estimator. Local Ollama is free; these placeholder rates model
  // typical API pricing (USD per 1M tokens). Tune as needed.
  const COST_INPUT_PER_1M = 0.10;
  const COST_OUTPUT_PER_1M = 0.40;

  let messages = [];
  let isStreaming = false;
  let abortController = null;
  let pendingImages = [];
  let pendingAudio = null;
  let modelCaps = { vision: false, tools: false, thinking: false, audio: false };
  let sessionStats = { promptTokens: 0, outputTokens: 0 };
  let mdRendering = false;

  const sessionStatsEl = document.getElementById('session-stats');

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

  let mediaRecorder = null;
  let isRecording = false;
  let recordedChunks = [];

  function ollamaUrl() {
    return ollamaUrlInput.value.trim() || DEFAULT_URL;
  }

  // --- Image helpers ---
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

  // --- Model capabilities ---
  async function loadModelInfo() {
    const model = modelSelect.value;
    if (!model) return;
    try {
      const resp = await fetch('/api/model-info', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ollama_url: ollamaUrl(), model: model })
      });
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

  // --- Audio recording ---
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

  // --- Attachments ---
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
    previewBar.classList.add('open');
  }

  // --- Drag & drop ---
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
    if (e.dataTransfer && e.dataTransfer.files) {
      handleFiles(e.dataTransfer.files);
    }
  });

  // --- Helpers ---
  function setStatus(text, cls) {
    statusEl.textContent = text;
    statusEl.className = cls || '';
  }

  function scrollToBottom() {
    chatEl.scrollTop = chatEl.scrollHeight;
  }

  function addMessage(role, content, images, audioUrl) {
    const div = document.createElement('div');
    div.className = 'msg ' + role;
    const roleLabel = document.createElement('span');
    roleLabel.className = 'role';
    roleLabel.textContent = role === 'user' ? 'user' : role === 'assistant' ? 'assistant' : 'error';
    const contentDiv = document.createElement('div');
    contentDiv.className = 'content';
    if (mdRendering) {
      contentDiv.innerHTML = renderMarkdown(content);
      attachCopyButtons(contentDiv);
    } else {
      contentDiv.textContent = content;
    }
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
    chatEl.appendChild(div);
    scrollToBottom();
    return contentDiv;
  }

  function addStreamingMessage() {
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
    div.appendChild(roleLabel);
    div.appendChild(thinkingDiv);
    div.appendChild(contentDiv);
    div.appendChild(metaDiv);
    chatEl.appendChild(div);
    scrollToBottom();
    return { div, thinkingDiv, thinkContent, contentDiv, cursor, metaDiv };
  }

  // --- Load models ---
  async function loadModels() {
    setStatus('Loading models...', 'busy');
    try {
      const resp = await fetch('/api/models?url=' + encodeURIComponent(ollamaUrl()));
      const data = await resp.json();
      modelSelect.innerHTML = '';
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
        setStatus('No models found', 'err');
      }
    } catch (e) {
      setStatus('Failed to connect to Ollama', 'err');
    }
  }

  // --- Send message ---
  async function sendMessage() {
    const text = inputEl.value.trim();
    if ((!text && pendingImages.length === 0 && !pendingAudio) || isStreaming) return;

    const msg = { role: 'user', content: text };
    const sentImages = [...pendingImages];
    const sentAudio = pendingAudio;
    if (sentImages.length > 0) {
      msg.images = sentImages.map(img => img.b64);
    }
    if (sentAudio) {
      msg.audio = sentAudio.b64;
    }

    addMessage('user', text, sentImages.map(img => img.dataUrl), sentAudio ? sentAudio.dataUrl : null);
    messages.push(msg);
    pendingImages = [];
    pendingAudio = null;
    renderPreview();
    inputEl.value = '';
    inputEl.style.height = 'auto';

    const { thinkingDiv, thinkContent, contentDiv, cursor, metaDiv } = addStreamingMessage();
    isStreaming = true;
    sendBtn.disabled = true;
    stopBtn.style.display = 'inline-block';
    setStatus('Generating...', 'busy');

    abortController = new AbortController();

    try {
      const resp = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ollama_url: ollamaUrl(),
          model: modelSelect.value,
          messages: messages,
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

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        // Process NDJSON lines from server
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
              scrollToBottom();
            } else if (obj.t === 'content') {
              fullText += obj.d;
              cursor.remove();
              if (mdRendering) {
                contentDiv.innerHTML = renderMarkdown(fullText);
                attachCopyButtons(contentDiv);
              } else {
                contentDiv.textContent = fullText;
              }
              scrollToBottom();
            } else if (obj.t === 'progress') {
              if (obj.output_tokens > 0) {
                renderMeta(metaDiv, Object.assign({}, obj, { live: true }));
              }
            } else if (obj.t === 'stats') {
              stats = obj;
              renderMeta(metaDiv, obj);
            }
          } catch (e) {
            // Not JSON - could be error text
            if (line.includes('[ERROR]')) {
              fullText += line;
            }
          }
        }
      }

      thinkingDiv.classList.remove('streaming');
      if (!hasThinking) {
        thinkingDiv.style.display = 'none';
      }

      if (fullText.includes('[ERROR]')) {
        const errMsg = fullText.split('[ERROR]')[1].trim();
        contentDiv.textContent = errMsg;
        contentDiv.parentElement.className = 'msg error';
        setStatus('Error', 'err');
      } else {
        messages.push({ role: 'assistant', content: fullText });
        setStatus('Ready', 'ok');
        if (stats) {
          const outTokens = stats.output_tokens || 0;
          const evalMs = (stats.eval_duration || 0) / 1e6;
          const totalMs = (stats.total_duration || 0) / 1e6;
          const latency = evalMs > 0 ? evalMs / 1000 : totalMs / 1000;
          const tps = latency > 0 ? outTokens / latency : 0;
          const meta = [
            latency.toFixed(1) + 's',
            Math.round(tps) + ' tokens/s',
            fmtNum(outTokens) + ' tokens out',
            fmtNum(stats.prompt_tokens || 0) + ' tokens in',
            'est ' + fmtCost(outTokens, COST_OUTPUT_PER_1M)
          ].join(' · ');
          metaDiv.textContent = meta;
          sessionStats.promptTokens += stats.prompt_tokens || 0;
          sessionStats.outputTokens += outTokens;
          updateSessionStats();
        }
      }
    } catch (e) {
      if (e.name === 'AbortError') {
        contentDiv.textContent = (contentDiv.textContent || '') + '\n\n[Stopped]';
        setStatus('Stopped', 'ok');
      } else {
        contentDiv.textContent = e.message || 'Unknown error';
        contentDiv.parentElement.className = 'msg error';
        setStatus('Error', 'err');
      }
    } finally {
      isStreaming = false;
      sendBtn.disabled = false;
      stopBtn.style.display = 'none';
      abortController = null;
      inputEl.focus();
    }
  }

  // --- Markdown rendering ---
  function renderMarkdown(text) {
    if (typeof marked === 'undefined') return text;
    marked.setOptions({
      highlight: function(code, lang) {
        if (lang && hljs.getLanguage(lang)) {
          try { return hljs.highlight(code, { language: lang }).value; }
          catch (e) {}
        }
        try { return hljs.highlightAuto(code).value; }
        catch (e) {}
        return code;
      },
      breaks: true
    });
    return marked.parse(text);
  }

  function attachCopyButtons(container) {
    const codeBlocks = container.querySelectorAll('pre code');
    codeBlocks.forEach((codeEl) => {
      const pre = codeEl.parentElement;
      if (!pre || pre.className.includes('copy-wrapper')) return;
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
        });
      });
      wrapper.appendChild(btn);
    });
  }

  function refreshMarkdownRendering() {
    document.querySelectorAll('.msg.assistant .content').forEach((contentDiv) => {
      const rawText = contentDiv.textContent;
      contentDiv.innerHTML = renderMarkdown(rawText);
      attachCopyButtons(contentDiv);
    });
    document.querySelectorAll('.msg.user .content').forEach((contentDiv) => {
      const rawText = contentDiv.textContent;
      contentDiv.innerHTML = renderMarkdown(rawText);
      attachCopyButtons(contentDiv);
    });
  }

  // --- Events ---
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

  const mdToggleBtn = document.getElementById('md-toggle');
  if (mdToggleBtn) {
    mdToggleBtn.addEventListener('click', () => {
      mdRendering = !mdRendering;
      mdToggleBtn.classList.toggle('active', mdRendering);
      mdToggleBtn.title = mdRendering ? 'Switch to raw text (Ctrl+M)' : 'Switch to markdown (Ctrl+M)';
      refreshMarkdownRendering();
    });
  }
  document.addEventListener('keydown', (e) => {
    if (e.key === 'm' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      mdToggleBtn && mdToggleBtn.click();
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
    inputEl.style.height = Math.min(inputEl.scrollHeight, 120) + 'px';
  });

  ollamaUrlInput.addEventListener('change', loadModels);

  settingsBtn.addEventListener('click', () => {
    settingsPanel.classList.toggle('open');
    settingsBtn.classList.toggle('active');
  });

  // --- Init ---
  updateCapabilities();
  loadModels();
  inputEl.focus();
})();