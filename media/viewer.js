(function () {
  // eslint-disable-next-line no-undef
  const vscode = acquireVsCodeApi();

  const canvas = /** @type {HTMLCanvasElement} */ (document.getElementById('screen'));
  const ctx = /** @type {CanvasRenderingContext2D} */ (canvas.getContext('2d'));
  const urlbar = /** @type {HTMLInputElement} */ (document.getElementById('urlbar'));
  const tabsEl = document.getElementById('tabs');
  const btnBack = document.getElementById('btn-back');
  const btnForward = document.getElementById('btn-forward');
  const btnReload = document.getElementById('btn-reload');
  const btnNewTab = document.getElementById('btn-newtab');
  const btnScreenshot = document.getElementById('btn-screenshot');
  const mobileIndicator = document.getElementById('mobile-indicator');
  const loadingBar = document.getElementById('loading-bar');
  const findBar = document.getElementById('find-bar');
  const findInput = /** @type {HTMLInputElement} */ (document.getElementById('find-input'));
  const findCount = document.getElementById('find-count');
  const findPrev = document.getElementById('find-prev');
  const findNextBtn = document.getElementById('find-next-btn');
  const findCloseBtn = document.getElementById('find-close');
  const contextMenu = document.getElementById('context-menu');

  // Browser viewport dimensions (what the CDP frame was rendered at)
  let browserW = 1280;
  let browserH = 800;
  let lastMoveTime = 0;
  let currentSearchEngine = 'google';

  // Feature 13d — frame mismatch detection
  const _mismatchSeen = new Set();

  // URL history (last 20)
  const urlHistory = [];
  const MAX_HISTORY = 20;

  // Loading bar state
  let loadingTimer = null;
  let loadingProgress = 0;

  function dpr() {
    return Math.max(1, Math.min(3, window.devicePixelRatio || 1));
  }

  // ---- Initialize canvas size (DPR-aware for crisp rendering on Retina) ----
  // IMPORTANT: do NOT set canvas.style.width/height inline. The CSS
  // (width: 100%; height: 100% on #screen, flex: 1 on #viewport) is the
  // single source of truth for DISPLAY size. We only set canvas.width/height
  // (the backing-store size, in device pixels) for crisp 1:1 rendering with
  // the screencast frames. Inline style would override the CSS and create
  // a "frozen" smaller canvas when the panel is resized.
  function sizeCanvas(cssW, cssH) {
    const r = dpr();
    canvas.width = Math.round(cssW * r);
    canvas.height = Math.round(cssH * r);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.fillStyle = '#1e1e1e';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
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
      vscode.postMessage({ type: 'viewport', width: w, height: h, dpr: dpr() });
    }
  });
  ro.observe(canvas);

  // Send initial viewport after layout settles
  setTimeout(() => {
    const rect = canvas.getBoundingClientRect();
    if (rect.width > 0 && rect.height > 0) {
      vscode.postMessage({
        type: 'viewport',
        width: Math.floor(rect.width),
        height: Math.floor(rect.height),
        dpr: dpr(),
      });
    }
  }, 150);

  // ---- Loading bar ----
  function startLoading() {
    if (loadingTimer) clearInterval(loadingTimer);
    loadingProgress = 0;
    loadingBar.style.transition = 'none';
    loadingBar.style.width = '0%';
    loadingBar.style.opacity = '1';
    // Animate 0 → 90% gradually
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

  function stopLoading() {
    if (loadingTimer) { clearInterval(loadingTimer); loadingTimer = null; }
    loadingBar.style.transition = 'width 0.2s ease';
    loadingBar.style.width = '100%';
    setTimeout(() => {
      loadingBar.style.transition = 'opacity 0.3s ease';
      loadingBar.style.opacity = '0';
      setTimeout(() => { loadingBar.style.width = '0%'; }, 350);
    }, 200);
  }

  // ---- Find bar ----
  function showFindBar(active) {
    if (active) {
      findBar.style.display = 'flex';
      findInput.focus();
      findInput.select();
    } else {
      findBar.style.display = 'none';
      findCount.textContent = '';
      vscode.postMessage({ type: 'find-close' });
      canvas.focus();
    }
  }

  if (findInput) {
    findInput.addEventListener('input', () => {
      const q = findInput.value;
      if (q) {
        vscode.postMessage({ type: 'find', query: q });
      }
    });

    findInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        vscode.postMessage({ type: 'find-next', query: findInput.value, backward: e.shiftKey });
      } else if (e.key === 'Escape') {
        e.preventDefault();
        showFindBar(false);
      }
    });
  }

  if (findPrev) {
    findPrev.addEventListener('click', () => {
      vscode.postMessage({ type: 'find-next', query: findInput.value, backward: true });
    });
  }

  if (findNextBtn) {
    findNextBtn.addEventListener('click', () => {
      vscode.postMessage({ type: 'find-next', query: findInput.value, backward: false });
    });
  }

  if (findCloseBtn) {
    findCloseBtn.addEventListener('click', () => showFindBar(false));
  }

  // ---- Context menu ----
  function hideContextMenu() {
    if (contextMenu) {
      contextMenu.style.display = 'none';
      contextMenu.innerHTML = '';
    }
  }

  function showContextMenu(x, y, items) {
    if (!contextMenu) return;
    contextMenu.innerHTML = '';
    contextMenu.style.display = 'block';
    // Position near click, but keep inside viewport
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    let left = x;
    let top = y;
    contextMenu.style.left = left + 'px';
    contextMenu.style.top = top + 'px';

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

    // Adjust position if overflows
    requestAnimationFrame(() => {
      const rect = contextMenu.getBoundingClientRect();
      if (rect.right > vw) {
        left = Math.max(0, x - rect.width);
        contextMenu.style.left = left + 'px';
      }
      if (rect.bottom > vh) {
        top = Math.max(0, y - rect.height);
        contextMenu.style.top = top + 'px';
      }
    });
  }

  document.addEventListener('click', () => hideContextMenu());
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') hideContextMenu(); });

  // ---- Smart address bar ----
  const ENGINE_URLS = {
    google: 'https://www.google.com/search?q=',
    duckduckgo: 'https://duckduckgo.com/?q=',
    bing: 'https://www.bing.com/search?q=',
  };

  function looksLikeUrl(s) {
    if (/^[a-zA-Z][a-zA-Z\d+\-.]*:/.test(s)) return true; // has scheme
    if (/\s/.test(s)) return false; // has space → query
    if (/\.(com|io|net|org|dev|edu|gov|co|app|ai|xyz|me|info)(\/|$)/i.test(s)) return true;
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
    vscode.postMessage({ type: 'navigate', url });
    addToUrlHistory(rawValue.trim());
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

  urlbar.placeholder = 'Search or type URL';

  urlbar.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    navigateToInput(urlbar.value);
  });

  btnBack.addEventListener('click', () => vscode.postMessage({ type: 'back' }));
  btnForward.addEventListener('click', () => vscode.postMessage({ type: 'forward' }));
  btnReload.addEventListener('click', () => vscode.postMessage({ type: 'reload' }));
  btnNewTab.addEventListener('click', () => vscode.postMessage({ type: 'new-tab', url: 'about:blank' }));

  if (btnScreenshot) {
    btnScreenshot.addEventListener('click', () => {
      vscode.postMessage({ type: 'command', command: 'devBrowserPanel.takeScreenshot' });
    });
  }

  // ---- Message handler ----
  window.addEventListener('message', (e) => {
    const msg = e.data;
    if (!msg || !msg.type) return;

    if (msg.type === 'frame') {
      const img = new Image();
      img.onload = () => {
        browserW = img.naturalWidth || browserW;
        browserH = img.naturalHeight || browserH;
        // Feature 13d — frame mismatch detection
        if (img.naturalWidth !== canvas.width || img.naturalHeight !== canvas.height) {
          const key = `${img.naturalWidth}x${img.naturalHeight}_${canvas.width}x${canvas.height}`;
          if (!_mismatchSeen.has(key)) {
            _mismatchSeen.add(key);
            console.warn(`[dev-browser-panel] frame ${img.naturalWidth}x${img.naturalHeight} ≠ canvas ${canvas.width}x${canvas.height} — degraded quality`);
          }
        }
        // canvas.width/height are already in device pixels (DPR-aware),
        // and the frame is rendered at the same device pixels by Chromium
        // (we set deviceScaleFactor = dpr on viewport message). So this
        // draw is effectively 1:1 — no upscale, crisp text.
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
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
      urlbar.value = msg.url || '';
      document.title = msg.title ? String(msg.title) + ' — Browser' : 'Browser';
      return;
    }

    if (msg.type === 'loading-start') {
      startLoading();
      return;
    }

    if (msg.type === 'loading-stop') {
      stopLoading();
      return;
    }

    if (msg.type === 'show-find') {
      showFindBar(!!msg.active);
      return;
    }

    if (msg.type === 'mobile-preset') {
      if (mobileIndicator) {
        if (msg.name && msg.name !== 'Desktop') {
          mobileIndicator.textContent = '📱';
          mobileIndicator.title = 'Mobile emulation: ' + msg.name;
          mobileIndicator.style.display = '';
        } else {
          mobileIndicator.style.display = 'none';
        }
      }
      return;
    }

    if (msg.type === 'context-hit-result') {
      const rect = canvas.getBoundingClientRect();
      // We stored the hit test position in a closure below
      buildContextMenu(msg.link, msg.imgSrc, _pendingContextX, _pendingContextY);
      return;
    }

    if (msg.type === 'search-engine') {
      currentSearchEngine = msg.engine || 'google';
      return;
    }
  });

  // Pending context menu position (set on right-click, used when hit-test result arrives)
  let _pendingContextX = 0;
  let _pendingContextY = 0;

  function buildContextMenu(link, imgSrc, pageX, pageY) {
    const items = [];

    items.push({ label: 'Back', action: () => vscode.postMessage({ type: 'back' }) });
    items.push({ label: 'Forward', action: () => vscode.postMessage({ type: 'forward' }) });
    items.push({ label: 'Reload', action: () => vscode.postMessage({ type: 'reload' }) });
    items.push({ separator: true });

    if (link) {
      items.push({ label: 'Open Link: ' + link.slice(0, 40), action: () => vscode.postMessage({ type: 'navigate', url: link }) });
      items.push({ label: 'Copy Link', action: () => navigator.clipboard.writeText(link).catch(() => undefined) });
    }

    if (imgSrc) {
      items.push({ label: 'Copy Image URL', action: () => navigator.clipboard.writeText(imgSrc).catch(() => undefined) });
    }

    items.push({ separator: true });
    items.push({ label: 'Copy', action: () => vscode.postMessage({ type: 'copy-request' }) });
    items.push({ label: 'Paste', action: () => vscode.postMessage({ type: 'paste-request' }) });
    items.push({ separator: true });
    items.push({ label: 'View Source', action: () => vscode.postMessage({ type: 'command', command: 'devBrowserPanel.viewSource' }) });
    items.push({ label: 'Inspect Element', action: () => vscode.postMessage({ type: 'command', command: 'devBrowserPanel.inspectElement' }) });

    showContextMenu(pageX, pageY, items);
  }

  // ---- Tab strip ----
  function renderTabs(tabList, activeTargetId) {
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
        vscode.postMessage({ type: 'close-tab', targetId: tab.targetId });
      });

      el.appendChild(label);
      el.appendChild(closeBtn);
      el.addEventListener('click', () => {
        vscode.postMessage({ type: 'switch-tab', targetId: tab.targetId });
      });
      tabsEl.appendChild(el);
    }
  }

  // ---- Mouse input helpers ----
  function getModifiers(e) {
    return (e.altKey ? 1 : 0) | (e.ctrlKey ? 2 : 0) | (e.metaKey ? 4 : 0) | (e.shiftKey ? 8 : 0);
  }

  function getButton(e) {
    if (e.button === 0) return 'left';
    if (e.button === 1) return 'middle';
    if (e.button === 2) return 'right';
    return 'none';
  }

  function toCanvasCoords(e) {
    const rect = canvas.getBoundingClientRect();
    const cx = e.clientX - rect.left;
    const cy = e.clientY - rect.top;
    // Map CSS display pixels → browser viewport pixels
    return {
      x: browserW > 0 ? cx * browserW / rect.width : cx,
      y: browserH > 0 ? cy * browserH / rect.height : cy,
    };
  }

  // ---- Mouse events ----
  canvas.addEventListener('mousedown', (e) => {
    canvas.focus();
    const { x, y } = toCanvasCoords(e);
    vscode.postMessage({
      type: 'mouse',
      event: { type: 'mousePressed', x, y, button: getButton(e), clickCount: 1, modifiers: getModifiers(e) },
    });
  });

  canvas.addEventListener('mouseup', (e) => {
    const { x, y } = toCanvasCoords(e);
    vscode.postMessage({
      type: 'mouse',
      event: { type: 'mouseReleased', x, y, button: getButton(e), clickCount: 1, modifiers: getModifiers(e) },
    });
  });

  canvas.addEventListener('mousemove', (e) => {
    const now = Date.now();
    if (now - lastMoveTime < 16) return; // ~60Hz
    lastMoveTime = now;
    const { x, y } = toCanvasCoords(e);
    vscode.postMessage({
      type: 'mouse',
      event: { type: 'mouseMoved', x, y, button: 'none', modifiers: getModifiers(e) },
    });
  });

  canvas.addEventListener('dblclick', (e) => {
    const { x, y } = toCanvasCoords(e);
    vscode.postMessage({
      type: 'mouse',
      event: { type: 'mousePressed', x, y, button: getButton(e), clickCount: 2, modifiers: getModifiers(e) },
    });
  });

  canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    const { x, y } = toCanvasCoords(e);
    vscode.postMessage({
      type: 'mouse',
      event: { type: 'mouseWheel', x, y, button: 'none', deltaX: e.deltaX, deltaY: e.deltaY, modifiers: getModifiers(e) },
    });
  }, { passive: false });

  canvas.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    hideContextMenu();
    const rect = canvas.getBoundingClientRect();
    _pendingContextX = e.clientX - rect.left + rect.left;
    _pendingContextY = e.clientY - rect.top + rect.top;
    const { x, y } = toCanvasCoords(e);
    // Store absolute page coordinates for the menu
    _pendingContextX = e.clientX;
    _pendingContextY = e.clientY;
    vscode.postMessage({ type: 'context-hit-test', x, y });
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

  canvas.addEventListener('keydown', (e) => {
    e.preventDefault();
    const modifiers = getModifiers(e);
    const kc = keyCode(e.key);
    const isPrintable = e.key.length === 1 && !e.ctrlKey && !e.metaKey;

    // Feature 12 — Copy/paste interception
    if ((e.metaKey || e.ctrlKey) && e.key === 'c') {
      vscode.postMessage({ type: 'copy-request' });
      return;
    }
    if ((e.metaKey || e.ctrlKey) && e.key === 'v') {
      vscode.postMessage({ type: 'paste-request' });
      return;
    }

    // Feature 1 — Find in page (Cmd+F / Ctrl+F)
    if ((e.metaKey || e.ctrlKey) && e.key === 'f') {
      showFindBar(true);
      return;
    }

    // Puppeteer/Playwright pattern:
    //   - printable: rawKeyDown (no text) + char (inserts the text)
    //   - non-printable (Enter, Tab, arrows, etc): just keyDown
    // Sending keyDown WITH text AND a char event causes Chromium to insert
    // the character twice ("aa" instead of "a"), since keyDown with non-empty
    // text already synthesizes a char event internally.
    vscode.postMessage({
      type: 'key',
      event: {
        type: isPrintable ? 'rawKeyDown' : 'keyDown',
        key: e.key,
        code: e.code,
        keyCode: kc,
        modifiers,
        autoRepeat: e.repeat,
      },
    });

    if (isPrintable) {
      vscode.postMessage({
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
    }
  });

  canvas.addEventListener('keyup', (e) => {
    const modifiers = getModifiers(e);
    const kc = keyCode(e.key);
    vscode.postMessage({
      type: 'key',
      event: {
        type: 'keyUp',
        key: e.key,
        code: e.code,
        keyCode: kc,
        modifiers,
        text: '',
        unmodifiedText: '',
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
