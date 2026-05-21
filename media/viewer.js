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

  // Browser viewport dimensions (what the CDP frame was rendered at)
  let browserW = 1280;
  let browserH = 800;
  let lastMoveTime = 0;

  // ---- Initialize canvas size ----
  function initCanvas() {
    const w = canvas.clientWidth || 1280;
    const h = canvas.clientHeight || 800;
    canvas.width = w;
    canvas.height = h;
    ctx.fillStyle = '#1e1e1e';
    ctx.fillRect(0, 0, w, h);
  }
  initCanvas();

  // ---- Viewport sync via ResizeObserver ----
  const ro = new ResizeObserver(() => {
    const rect = canvas.getBoundingClientRect();
    const w = Math.floor(rect.width);
    const h = Math.floor(rect.height);
    if (w > 0 && h > 0) {
      canvas.width = w;
      canvas.height = h;
      vscode.postMessage({ type: 'viewport', width: w, height: h });
    }
  });
  ro.observe(canvas);

  // Send initial viewport after layout settles
  setTimeout(() => {
    const rect = canvas.getBoundingClientRect();
    if (rect.width > 0 && rect.height > 0) {
      vscode.postMessage({ type: 'viewport', width: Math.floor(rect.width), height: Math.floor(rect.height) });
    }
  }, 150);

  // ---- Message handler ----
  window.addEventListener('message', (e) => {
    const msg = e.data;
    if (!msg || !msg.type) return;

    if (msg.type === 'frame') {
      const img = new Image();
      img.onload = () => {
        browserW = img.naturalWidth || browserW;
        browserH = img.naturalHeight || browserH;
        const dw = canvas.width;
        const dh = canvas.height;
        ctx.drawImage(img, 0, 0, dw, dh);
      };
      img.src = 'data:image/jpeg;base64,' + msg.data;
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
  });

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
      closeBtn.textContent = '×'; // ×
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

  // ---- Toolbar ----
  urlbar.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    let url = urlbar.value.trim();
    if (!url) return;
    // Auto-prepend https:// if no scheme
    if (!/^[a-zA-Z][a-zA-Z\d+\-.]*:/.test(url)) {
      url = 'https://' + url;
    }
    vscode.postMessage({ type: 'navigate', url });
  });

  btnBack.addEventListener('click', () => vscode.postMessage({ type: 'back' }));
  btnForward.addEventListener('click', () => vscode.postMessage({ type: 'forward' }));
  btnReload.addEventListener('click', () => vscode.postMessage({ type: 'reload' }));
  btnNewTab.addEventListener('click', () => vscode.postMessage({ type: 'new-tab', url: 'about:blank' }));

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

  canvas.addEventListener('contextmenu', (e) => e.preventDefault());

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

    vscode.postMessage({
      type: 'key',
      event: {
        type: 'keyDown',
        key: e.key,
        code: e.code,
        keyCode: kc,
        modifiers,
        autoRepeat: e.repeat,
        text: isPrintable ? e.key : '',
        unmodifiedText: isPrintable ? e.key : '',
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
