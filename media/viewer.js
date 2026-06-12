(function () {
  // eslint-disable-next-line no-undef
  const vscode = acquireVsCodeApi();

  const canvas = /** @type {HTMLCanvasElement} */ (document.getElementById('screen'));
  const ctx = /** @type {CanvasRenderingContext2D} */ (canvas.getContext('2d'));
  const urlbar = /** @type {HTMLInputElement} */ (document.getElementById('urlbar'));
  const tabsEl = document.getElementById('tabs');
  const btnBack = /** @type {HTMLButtonElement} */ (document.getElementById('btn-back'));
  const btnForward = /** @type {HTMLButtonElement} */ (document.getElementById('btn-forward'));
  const btnReload = /** @type {HTMLButtonElement} */ (document.getElementById('btn-reload'));
  const btnNewTab = document.getElementById('btn-newtab');
  const btnScreenshot = document.getElementById('btn-screenshot');
  const zoomChip = document.getElementById('zoom-chip');
  const mobileIndicator = document.getElementById('mobile-indicator');
  const loadingBar = document.getElementById('loading-bar');
  const overlay = document.getElementById('overlay');
  const overlayMsg = document.getElementById('overlay-msg');
  const overlayBtn = document.getElementById('overlay-btn');
  const findBar = document.getElementById('find-bar');
  const findInput = /** @type {HTMLInputElement} */ (document.getElementById('find-input'));
  const findCount = document.getElementById('find-count');
  const findPrev = document.getElementById('find-prev');
  const findNextBtn = document.getElementById('find-next-btn');
  const findCloseBtn = document.getElementById('find-close');
  const contextMenu = document.getElementById('context-menu');

  const RELOAD_GLYPH = '↻'; // ↻
  const STOP_GLYPH = '✕';   // ✕

  // Page CSS dimensions (the coordinate space CDP input events expect),
  // taken from screencast frame metadata.
  let pageW = 0;
  let pageH = 0;
  // Where the last frame was drawn inside the canvas (device px), for
  // aspect-fit ("contain") rendering + mouse coordinate mapping.
  let dest = null;
  let lastFrameImg = null;
  let lastMoveTime = 0;
  let currentSearchEngine = 'google';
  let isLoading = false;
  let activeTabId = null;
  let overlayKind = 'none';

  // URL history (last 20) for the datalist dropdown
  const urlHistory = [];
  const MAX_HISTORY = 20;

  // Loading bar state
  let loadingTimer = null;
  let loadingProgress = 0;

  function dpr() {
    return Math.max(1, Math.min(3, window.devicePixelRatio || 1));
  }

  function post(msg) {
    vscode.postMessage(msg);
  }

  // ---- Canvas sizing (backing store in device px; CSS controls display size) ----
  function sizeCanvas(cssW, cssH) {
    const r = dpr();
    canvas.width = Math.round(cssW * r);
    canvas.height = Math.round(cssH * r);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    redraw();
  }

  function redraw() {
    ctx.fillStyle = '#1e1e1e';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    if (lastFrameImg) drawFrame(lastFrameImg);
  }

  function drawFrame(img) {
    const fw = img.naturalWidth;
    const fh = img.naturalHeight;
    if (!fw || !fh) return;
    const s = Math.min(canvas.width / fw, canvas.height / fh);
    const dw = Math.max(1, Math.round(fw * s));
    const dh = Math.max(1, Math.round(fh * s));
    const dx = Math.round((canvas.width - dw) / 2);
    const dy = Math.round((canvas.height - dh) / 2);
    dest = { dx, dy, dw, dh };
    ctx.drawImage(img, dx, dy, dw, dh);
  }

  function initCanvas() {
    const w = canvas.clientWidth || 1280;
    const h = canvas.clientHeight || 800;
    sizeCanvas(w, h);
  }
  initCanvas();

  // ---- Viewport sync via ResizeObserver ----
  const ro = new ResizeObserver(() => {
    const rect = canvas.getBoundingClientRect();
    const w = Math.floor(rect.width);
    const h = Math.floor(rect.height);
    if (w > 0 && h > 0) {
      sizeCanvas(w, h);
      post({ type: 'viewport', width: w, height: h, dpr: dpr() });
    }
  });
  ro.observe(canvas);

  setTimeout(() => {
    const rect = canvas.getBoundingClientRect();
    if (rect.width > 0 && rect.height > 0) {
      post({ type: 'viewport', width: Math.floor(rect.width), height: Math.floor(rect.height), dpr: dpr() });
    }
  }, 150);

  // ---- Loading bar + reload/stop button ----
  function setLoading(loading) {
    isLoading = loading;
    btnReload.textContent = loading ? STOP_GLYPH : RELOAD_GLYPH;
    btnReload.title = loading ? 'Stop loading (Esc)' : 'Reload (Cmd/Ctrl+R) — Shift for hard reload';
  }

  function startLoading() {
    setLoading(true);
    if (loadingTimer) clearInterval(loadingTimer);
    loadingProgress = 0;
    loadingBar.style.transition = 'none';
    loadingBar.style.width = '0%';
    loadingBar.style.opacity = '1';
    loadingTimer = setInterval(() => {
      loadingProgress = Math.min(90, loadingProgress + (90 - loadingProgress) * 0.1 + 1);
      loadingBar.style.transition = 'width 0.2s ease';
      loadingBar.style.width = loadingProgress + '%';
      if (loadingProgress >= 90) {
        clearInterval(loadingTimer);
        loadingTimer = null;
      }
    }, 200);
  }

  function stopLoadingBar() {
    setLoading(false);
    if (loadingTimer) { clearInterval(loadingTimer); loadingTimer = null; }
    loadingBar.style.transition = 'width 0.2s ease';
    loadingBar.style.width = '100%';
    setTimeout(() => {
      loadingBar.style.transition = 'opacity 0.3s ease';
      loadingBar.style.opacity = '0';
      setTimeout(() => { loadingBar.style.width = '0%'; }, 350);
    }, 200);
  }

  // ---- Overlay (browser stopped / tab crashed) ----
  function showOverlay(kind, text) {
    overlayKind = kind;
    if (kind === 'none') {
      overlay.style.display = 'none';
      return;
    }
    overlayMsg.textContent = text || (kind === 'crashed' ? 'This tab crashed' : 'Browser stopped');
    overlayBtn.textContent = kind === 'crashed' ? 'Reload Tab' : 'Restart Browser';
    overlay.style.display = 'flex';
  }

  overlayBtn.addEventListener('click', () => {
    if (overlayKind === 'crashed') post({ type: 'reload-crashed' });
    else post({ type: 'restart-session' });
  });

  // ---- Find bar ----
  function showFindBar(active) {
    if (active) {
      findBar.style.display = 'flex';
      findInput.focus();
      findInput.select();
    } else {
      findBar.style.display = 'none';
      findCount.textContent = '';
      post({ type: 'find-close' });
      canvas.focus();
    }
  }

  findInput.addEventListener('input', () => {
    const q = findInput.value;
    if (q) post({ type: 'find', query: q });
  });

  findInput.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Enter') {
      e.preventDefault();
      post({ type: 'find-next', query: findInput.value, backward: e.shiftKey });
    } else if (e.key === 'Escape') {
      e.preventDefault();
      showFindBar(false);
    }
  });

  findPrev.addEventListener('click', () => {
    post({ type: 'find-next', query: findInput.value, backward: true });
  });
  findNextBtn.addEventListener('click', () => {
    post({ type: 'find-next', query: findInput.value, backward: false });
  });
  findCloseBtn.addEventListener('click', () => showFindBar(false));

  // ---- Context menu ----
  function hideContextMenu() {
    contextMenu.style.display = 'none';
    contextMenu.innerHTML = '';
  }

  function showContextMenu(x, y, items) {
    contextMenu.innerHTML = '';
    contextMenu.style.display = 'block';
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    contextMenu.style.left = x + 'px';
    contextMenu.style.top = y + 'px';

    for (const item of items) {
      if (item.separator) {
        const sep = document.createElement('div');
        sep.className = 'ctx-separator';
        contextMenu.appendChild(sep);
        continue;
      }
      const el = document.createElement('div');
      el.className = 'ctx-item';
      el.textContent = item.label;
      if (item.disabled) el.classList.add('ctx-disabled');
      else {
        el.addEventListener('click', () => {
          hideContextMenu();
          if (item.action) item.action();
        });
      }
      contextMenu.appendChild(el);
    }

    requestAnimationFrame(() => {
      const rect = contextMenu.getBoundingClientRect();
      if (rect.right > vw) contextMenu.style.left = Math.max(0, x - rect.width) + 'px';
      if (rect.bottom > vh) contextMenu.style.top = Math.max(0, y - rect.height) + 'px';
    });
  }

  document.addEventListener('click', () => hideContextMenu());
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') hideContextMenu();
  });

  // ---- Smart address bar ----
  const ENGINE_URLS = {
    google: 'https://www.google.com/search?q=',
    duckduckgo: 'https://duckduckgo.com/?q=',
    bing: 'https://www.bing.com/search?q=',
  };
  const ENGINE_NAMES = { google: 'Google', duckduckgo: 'DuckDuckGo', bing: 'Bing' };

  function looksLikeUrl(s) {
    if (/^[a-zA-Z][a-zA-Z\d+\-.]*:/.test(s)) return true; // has scheme
    if (/\s/.test(s)) return false; // has space → query
    if (/^localhost(:\d+)?(\/|$)/i.test(s)) return true;
    if (/^[\d.]+(:\d+)?(\/|$)/.test(s)) return true; // bare IP
    if (/^[^\s]+:\d+(\/|$)/.test(s)) return true; // host:port
    if (/\.[a-z]{2,}(\/|:|$)/i.test(s)) return true; // anything.tld
    return false;
  }

  function navigateToInput(rawValue) {
    let url = rawValue.trim();
    if (!url) return;
    if (looksLikeUrl(url)) {
      if (!/^[a-zA-Z][a-zA-Z\d+\-.]*:/.test(url)) url = 'https://' + url;
    } else {
      const engine = currentSearchEngine || 'google';
      url = (ENGINE_URLS[engine] || ENGINE_URLS.google) + encodeURIComponent(url);
    }
    post({ type: 'navigate', url });
    addToUrlHistory(rawValue.trim());
    canvas.focus();
  }

  function addToUrlHistory(entry) {
    const idx = urlHistory.indexOf(entry);
    if (idx !== -1) urlHistory.splice(idx, 1);
    urlHistory.unshift(entry);
    if (urlHistory.length > MAX_HISTORY) urlHistory.pop();
    updateDatalist();
  }

  function updateDatalist() {
    let dl = document.getElementById('url-history-list');
    if (!dl) {
      dl = document.createElement('datalist');
      dl.id = 'url-history-list';
      document.body.appendChild(dl);
      urlbar.setAttribute('list', 'url-history-list');
    }
    dl.innerHTML = '';
    for (const h of urlHistory) {
      const opt = document.createElement('option');
      opt.value = h;
      dl.appendChild(opt);
    }
  }

  let urlbarCurrent = '';
  function setUrlbar(url) {
    urlbarCurrent = url || '';
    if (document.activeElement !== urlbar) {
      urlbar.value = urlbarCurrent;
    }
  }

  urlbar.addEventListener('focus', () => urlbar.select());
  urlbar.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Enter') {
      e.preventDefault();
      navigateToInput(urlbar.value);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      urlbar.value = urlbarCurrent;
      canvas.focus();
    } else {
      handleGlobalShortcut(e);
    }
  });

  // ---- Toolbar buttons ----
  btnBack.addEventListener('click', () => post({ type: 'back' }));
  btnForward.addEventListener('click', () => post({ type: 'forward' }));
  btnReload.addEventListener('click', (e) => {
    if (isLoading) post({ type: 'stop-loading' });
    else post({ type: 'reload', hard: e.shiftKey });
  });
  btnNewTab.addEventListener('click', () => post({ type: 'new-tab', url: 'about:blank' }));
  btnScreenshot.addEventListener('click', () => {
    post({ type: 'command', command: 'devBrowserPanel.takeScreenshot' });
  });
  zoomChip.addEventListener('click', () => post({ type: 'zoom', direction: 'reset' }));
  setLoading(false);

  // ---- Message handler ----
  window.addEventListener('message', (e) => {
    const msg = e.data;
    if (!msg || !msg.type) return;

    if (msg.type === 'frame') {
      const img = new Image();
      img.onload = () => {
        pageW = msg.pageW || img.naturalWidth;
        pageH = msg.pageH || img.naturalHeight;
        lastFrameImg = img;
        redraw();
        // Frames arriving means the browser is alive again.
        if (overlayKind !== 'none') showOverlay('none');
      };
      const mime = msg.format === 'png' ? 'image/png' : 'image/jpeg';
      img.src = 'data:' + mime + ';base64,' + msg.data;
      return;
    }

    if (msg.type === 'tabs') {
      renderTabs(msg.tabs, msg.activeTargetId);
      return;
    }

    if (msg.type === 'active-target') {
      activeTabId = msg.targetId || null;
      urlbarCurrent = msg.url || '';
      urlbar.value = urlbarCurrent;
      document.title = msg.title ? String(msg.title) + ' — Browser' : 'Browser';
      // Chrome-like: blank tab → cursor in the address bar, ready to type.
      if (!msg.url || msg.url === 'about:blank') {
        urlbar.focus();
        urlbar.select();
      }
      return;
    }

    if (msg.type === 'url-changed') {
      setUrlbar(msg.url || '');
      if (msg.title) document.title = String(msg.title) + ' — Browser';
      return;
    }

    if (msg.type === 'nav-state') {
      btnBack.disabled = !msg.canGoBack;
      btnForward.disabled = !msg.canGoForward;
      return;
    }

    if (msg.type === 'loading-start') { startLoading(); return; }
    if (msg.type === 'loading-stop') { stopLoadingBar(); return; }

    if (msg.type === 'overlay') {
      showOverlay(msg.kind || 'none', msg.text);
      return;
    }

    if (msg.type === 'zoom-level') {
      const z = Math.round((msg.zoom || 1) * 100);
      if (z === 100) {
        zoomChip.style.display = 'none';
      } else {
        zoomChip.style.display = '';
        zoomChip.textContent = z + '%';
      }
      return;
    }

    if (msg.type === 'show-find') { showFindBar(!!msg.active); return; }

    if (msg.type === 'mobile-preset') {
      if (msg.name && msg.name !== 'Desktop') {
        mobileIndicator.textContent = '📱';
        mobileIndicator.title = 'Mobile emulation: ' + msg.name;
        mobileIndicator.style.display = '';
      } else {
        mobileIndicator.style.display = 'none';
      }
      return;
    }

    if (msg.type === 'context-hit-result') {
      buildContextMenu(msg.link, msg.imgSrc, _pendingContextX, _pendingContextY);
      return;
    }

    if (msg.type === 'search-engine') {
      currentSearchEngine = msg.engine || 'google';
      urlbar.placeholder = 'Search ' + (ENGINE_NAMES[currentSearchEngine] || 'Google') + ' or type URL';
      return;
    }
  });

  // ---- Context menu build ----
  let _pendingContextX = 0;
  let _pendingContextY = 0;

  function buildContextMenu(link, imgSrc, pageX, pageY) {
    const items = [];

    items.push({ label: 'Back', disabled: btnBack.disabled, action: () => post({ type: 'back' }) });
    items.push({ label: 'Forward', disabled: btnForward.disabled, action: () => post({ type: 'forward' }) });
    items.push({ label: 'Reload', action: () => post({ type: 'reload' }) });
    items.push({ separator: true });

    if (link) {
      items.push({ label: 'Open Link in New Tab', action: () => post({ type: 'new-tab', url: link }) });
      items.push({ label: 'Open Link Here: ' + link.slice(0, 40), action: () => post({ type: 'navigate', url: link }) });
      items.push({ label: 'Copy Link Address', action: () => post({ type: 'copy-text', text: link }) });
      items.push({ separator: true });
    }

    if (imgSrc) {
      items.push({ label: 'Copy Image URL', action: () => post({ type: 'copy-text', text: imgSrc }) });
      items.push({ separator: true });
    }

    items.push({ label: 'Copy', action: () => post({ type: 'copy-request' }) });
    items.push({ label: 'Cut', action: () => post({ type: 'cut-request' }) });
    items.push({ label: 'Paste', action: () => post({ type: 'paste-request' }) });
    items.push({ label: 'Select All', action: () => post({ type: 'select-all' }) });
    items.push({ separator: true });
    items.push({ label: 'View Source', action: () => post({ type: 'command', command: 'devBrowserPanel.viewSource' }) });
    items.push({ label: 'Inspect Element', action: () => post({ type: 'command', command: 'devBrowserPanel.inspectElement' }) });

    showContextMenu(pageX, pageY, items);
  }

  // ---- Tab strip ----
  function renderTabs(tabList, activeTargetId) {
    activeTabId = activeTargetId || activeTabId;
    tabsEl.innerHTML = '';
    for (const tab of tabList) {
      const el = document.createElement('div');
      el.className = 'tab' + (tab.targetId === activeTargetId ? ' active' : '');
      el.title = tab.url || '';

      const label = document.createElement('span');
      label.className = 'tab-label';
      label.textContent = tab.title || tab.url || 'New Tab';

      const closeBtn = document.createElement('span');
      closeBtn.className = 'close-btn';
      closeBtn.textContent = '\xD7'; // ×
      closeBtn.addEventListener('click', (ev) => {
        ev.stopPropagation();
        post({ type: 'close-tab', targetId: tab.targetId });
      });

      el.appendChild(label);
      el.appendChild(closeBtn);
      el.addEventListener('click', () => {
        post({ type: 'switch-tab', targetId: tab.targetId });
      });
      // Chrome-like: middle-click closes the tab.
      el.addEventListener('auxclick', (ev) => {
        if (ev.button === 1) {
          ev.preventDefault();
          post({ type: 'close-tab', targetId: tab.targetId });
        }
      });
      tabsEl.appendChild(el);
    }
  }

  // ---- Mouse input ----
  function getModifiers(e) {
    return (e.altKey ? 1 : 0) | (e.ctrlKey ? 2 : 0) | (e.metaKey ? 4 : 0) | (e.shiftKey ? 8 : 0);
  }

  function getButton(e) {
    if (e.button === 0) return 'left';
    if (e.button === 1) return 'middle';
    if (e.button === 2) return 'right';
    return 'none';
  }

  // Maps a webview mouse event to page CSS coordinates, accounting for the
  // aspect-fit dest rect and any size difference between canvas and page.
  function toPageCoords(e) {
    const rect = canvas.getBoundingClientRect();
    const cssX = e.clientX - rect.left;
    const cssY = e.clientY - rect.top;
    if (!dest || !pageW || !pageH || rect.width === 0 || rect.height === 0) {
      return { x: cssX, y: cssY };
    }
    const r = canvas.width / rect.width; // device px per CSS px
    const px = ((cssX * r) - dest.dx) / dest.dw * pageW;
    const py = ((cssY * r) - dest.dy) / dest.dh * pageH;
    return {
      x: Math.max(0, Math.min(pageW, px)),
      y: Math.max(0, Math.min(pageH, py)),
    };
  }

  canvas.addEventListener('mousedown', (e) => {
    canvas.focus();
    const { x, y } = toPageCoords(e);
    post({
      type: 'mouse',
      event: {
        type: 'mousePressed', x, y,
        button: getButton(e),
        buttons: e.buttons,
        clickCount: Math.min(3, e.detail || 1),
        modifiers: getModifiers(e),
      },
    });
  });

  canvas.addEventListener('mouseup', (e) => {
    const { x, y } = toPageCoords(e);
    post({
      type: 'mouse',
      event: {
        type: 'mouseReleased', x, y,
        button: getButton(e),
        buttons: e.buttons,
        clickCount: Math.min(3, e.detail || 1),
        modifiers: getModifiers(e),
      },
    });
  });

  canvas.addEventListener('mousemove', (e) => {
    const now = Date.now();
    if (now - lastMoveTime < 16) return; // ~60Hz
    lastMoveTime = now;
    const { x, y } = toPageCoords(e);
    post({
      type: 'mouse',
      event: {
        type: 'mouseMoved', x, y,
        button: 'none',
        buttons: e.buttons, // keep drags/selections alive
        modifiers: getModifiers(e),
      },
    });
  });

  canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    // Cmd/Ctrl+wheel = zoom, like Chrome.
    if (e.metaKey || e.ctrlKey) {
      post({ type: 'zoom', direction: e.deltaY < 0 ? 'in' : 'out' });
      return;
    }
    const { x, y } = toPageCoords(e);
    post({
      type: 'mouse',
      event: { type: 'mouseWheel', x, y, button: 'none', deltaX: e.deltaX, deltaY: e.deltaY, modifiers: getModifiers(e) },
    });
  }, { passive: false });

  canvas.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    hideContextMenu();
    _pendingContextX = e.clientX;
    _pendingContextY = e.clientY;
    const { x, y } = toPageCoords(e);
    post({ type: 'context-hit-test', x, y });
  });

  // ---- Keyboard input ----
  const KEY_CODES = {
    Backspace: 8, Tab: 9, Enter: 13, Escape: 27,
    ' ': 32, PageUp: 33, PageDown: 34, End: 35, Home: 36,
    ArrowLeft: 37, ArrowUp: 38, ArrowRight: 39, ArrowDown: 40,
    Delete: 46,
    F1: 112, F2: 113, F3: 114, F4: 115, F5: 116, F6: 117,
    F7: 118, F8: 119, F9: 120, F10: 121, F11: 122, F12: 123,
  };

  function keyCode(key) {
    if (KEY_CODES[key] !== undefined) return KEY_CODES[key];
    if (key.length === 1) return key.toUpperCase().charCodeAt(0);
    return 0;
  }

  // Browser-level shortcuts that should work from the URL bar too.
  // Returns true when handled.
  function handleGlobalShortcut(e) {
    const mod = e.metaKey || e.ctrlKey;
    const k = e.key.toLowerCase();
    if ((mod && k === 'r') || e.key === 'F5') {
      e.preventDefault();
      post({ type: 'reload', hard: e.shiftKey });
      return true;
    }
    if (mod && k === 't') {
      e.preventDefault();
      post({ type: 'new-tab', url: 'about:blank' });
      return true;
    }
    if (mod && k === 'w') {
      e.preventDefault();
      if (activeTabId) post({ type: 'close-tab', targetId: activeTabId });
      return true;
    }
    if (mod && k === 'l') {
      e.preventDefault();
      urlbar.focus();
      urlbar.select();
      return true;
    }
    return false;
  }

  canvas.addEventListener('keydown', (e) => {
    e.preventDefault();
    if (handleGlobalShortcut(e)) return;

    const mod = e.metaKey || e.ctrlKey;
    const k = e.key.toLowerCase();

    // Clipboard + editing
    if (mod && k === 'c') { post({ type: 'copy-request' }); return; }
    if (mod && k === 'x') { post({ type: 'cut-request' }); return; }
    if (mod && k === 'v') { post({ type: 'paste-request' }); return; }
    if (mod && k === 'a') { post({ type: 'select-all' }); return; }

    // Find in page
    if (mod && k === 'f') { showFindBar(true); return; }

    // History
    if (e.altKey && e.key === 'ArrowLeft') { post({ type: 'back' }); return; }
    if (e.altKey && e.key === 'ArrowRight') { post({ type: 'forward' }); return; }
    if (mod && e.key === '[') { post({ type: 'back' }); return; }
    if (mod && e.key === ']') { post({ type: 'forward' }); return; }

    // Zoom
    if (mod && (e.key === '=' || e.key === '+')) { post({ type: 'zoom', direction: 'in' }); return; }
    if (mod && e.key === '-') { post({ type: 'zoom', direction: 'out' }); return; }
    if (mod && e.key === '0') { post({ type: 'zoom', direction: 'reset' }); return; }

    // Esc: close UI chrome, stop loading, then let the page see it too.
    if (e.key === 'Escape') {
      hideContextMenu();
      if (isLoading) post({ type: 'stop-loading' });
    }

    const modifiers = getModifiers(e);
    const kc = keyCode(e.key);
    const isPrintable = e.key.length === 1 && !e.ctrlKey && !e.metaKey;

    if (isPrintable) {
      // Puppeteer/Playwright pattern: rawKeyDown (no text) + char (inserts the
      // text). keyDown WITH text would synthesize a second insert ("aa").
      post({
        type: 'key',
        event: {
          type: 'rawKeyDown',
          key: e.key,
          code: e.code,
          keyCode: kc,
          windowsVirtualKeyCode: kc,
          modifiers,
          autoRepeat: e.repeat,
        },
      });
      post({
        type: 'key',
        event: {
          type: 'char',
          key: e.key,
          text: e.key,
          unmodifiedText: e.key,
          keyCode: 0,
          modifiers: 0,
          code: e.code,
        },
      });
    } else if (e.key === 'Enter') {
      // Enter must carry text '\r': without it Chromium fires no keypress, so
      // forms don't submit and textareas don't get a newline.
      post({
        type: 'key',
        event: {
          type: 'keyDown',
          key: 'Enter',
          code: e.code || 'Enter',
          keyCode: 13,
          windowsVirtualKeyCode: 13,
          text: '\r',
          unmodifiedText: '\r',
          modifiers,
          autoRepeat: e.repeat,
        },
      });
    } else {
      post({
        type: 'key',
        event: {
          type: 'keyDown',
          key: e.key,
          code: e.code,
          keyCode: kc,
          windowsVirtualKeyCode: kc,
          modifiers,
          autoRepeat: e.repeat,
        },
      });
    }
  });

  canvas.addEventListener('keyup', (e) => {
    const mod = e.metaKey || e.ctrlKey;
    const k = e.key.toLowerCase();
    // Don't echo keyups for combos we intercepted on keydown.
    if (mod && ['c', 'x', 'v', 'a', 'f', 'r', 't', 'w', 'l', '[', ']', '=', '+', '-', '0'].includes(k)) return;
    if (e.key === 'F5') return;
    const modifiers = getModifiers(e);
    const kc = keyCode(e.key);
    post({
      type: 'key',
      event: {
        type: 'keyUp',
        key: e.key,
        code: e.code,
        keyCode: kc,
        windowsVirtualKeyCode: kc,
        modifiers,
      },
    });
  });

  canvas.addEventListener('focus', () => {
    canvas.style.outline = '1px solid var(--vscode-focusBorder)';
  });
  canvas.addEventListener('blur', () => {
    canvas.style.outline = 'none';
  });
}());
