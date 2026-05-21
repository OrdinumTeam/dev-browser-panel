(function () {
  // eslint-disable-next-line no-undef
  const vscode = typeof acquireVsCodeApi === 'function' ? acquireVsCodeApi() : null;
  const logsList = document.getElementById('logs-list');
  const btnClear = document.getElementById('btn-clear');
  const filterInput = document.getElementById('filter');
  const btnPause = document.getElementById('btn-pause');
  const btnCopyHar = document.getElementById('btn-copy-har');
  const tabButtons = document.querySelectorAll('#tabs .tab');

  const MAX_ENTRIES = 5000;
  const MAX_TOTAL_BODY_BYTES = 30 * 1024 * 1024;
  let paused = false;
  let filterText = '';
  let activeTab = 'all';
  const allEntries = [];
  let totalBodyBytes = 0;

  function bodyByteLength(entry) {
    return entry.responseBody ? entry.responseBody.length : 0;
  }

  function enforceBodyBudget() {
    if (totalBodyBytes <= MAX_TOTAL_BODY_BYTES) return;
    for (const e of allEntries) {
      if (totalBodyBytes <= MAX_TOTAL_BODY_BYTES) break;
      if (e.kind === 'network' && e.responseBody) {
        totalBodyBytes -= e.responseBody.length;
        e.responseBody = undefined;
        e.bodyEvicted = true;
      }
    }
  }

  function padZ(n, len) {
    return String(n).padStart(len, '0');
  }

  function formatTs(ms) {
    const d = new Date(ms);
    return padZ(d.getHours(), 2) + ':' + padZ(d.getMinutes(), 2) + ':' +
           padZ(d.getSeconds(), 2) + '.' + padZ(d.getMilliseconds(), 3);
  }

  function formatSize(bytes) {
    if (bytes == null) return '';
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
    return (bytes / (1024 * 1024)).toFixed(2) + ' MB';
  }

  function formatDuration(ms) {
    if (ms == null) return '';
    if (ms < 1000) return Math.round(ms) + ' ms';
    return (ms / 1000).toFixed(2) + ' s';
  }

  function shortUrl(url) {
    if (!url) return '';
    try {
      const u = new URL(url);
      const path = u.pathname + u.search;
      return u.host + (path === '/' ? '' : path);
    } catch (e) {
      return url;
    }
  }

  function buildConsoleEntryEl(entry) {
    const div = document.createElement('div');
    div.className = 'log-entry log-console log-' + entry.level;

    const ts = document.createElement('span');
    ts.className = 'log-ts';
    ts.textContent = formatTs(entry.timestamp);

    const lvl = document.createElement('span');
    lvl.className = 'log-level';
    lvl.textContent = '[' + entry.level.toUpperCase() + ']';

    const text = document.createElement('span');
    text.className = 'log-text';
    text.textContent = entry.text || '';

    div.appendChild(ts);
    div.appendChild(lvl);
    div.appendChild(text);

    if (entry.url) {
      const src = document.createElement('span');
      src.className = 'log-src';
      src.title = entry.url + (entry.lineNumber != null ? ':' + entry.lineNumber : '');
      src.textContent = ' — ' + entry.url + (entry.lineNumber != null ? ':' + entry.lineNumber : '');
      div.appendChild(src);
    }

    return div;
  }

  function buildNetworkEntryEl(entry) {
    const div = document.createElement('div');
    div.className = 'log-entry log-network net-' + entry.level;
    if (entry.failed) div.classList.add('net-failed');

    const ts = document.createElement('span');
    ts.className = 'log-ts';
    ts.textContent = formatTs(entry.timestamp);

    const method = document.createElement('span');
    method.className = 'net-method net-method-' + (entry.method || 'GET').toLowerCase();
    method.textContent = entry.method || 'GET';

    const status = document.createElement('span');
    status.className = 'net-status';
    if (entry.failed) {
      status.textContent = 'ERR';
      status.title = entry.errorText || 'failed';
    } else if (entry.status != null) {
      status.textContent = String(entry.status);
      if (entry.statusText) status.title = entry.status + ' ' + entry.statusText;
    } else {
      status.textContent = '—';
    }

    const url = document.createElement('span');
    url.className = 'net-url';
    url.title = entry.url || '';
    url.textContent = shortUrl(entry.url);

    const type = document.createElement('span');
    type.className = 'net-type';
    type.textContent = entry.resourceType || (entry.mimeType ? entry.mimeType.split('/').pop() : '');

    const size = document.createElement('span');
    size.className = 'net-size';
    size.textContent = formatSize(entry.size);

    const time = document.createElement('span');
    time.className = 'net-time';
    time.textContent = formatDuration(entry.durationMs);

    div.appendChild(ts);
    div.appendChild(method);
    div.appendChild(status);
    div.appendChild(url);
    div.appendChild(type);
    div.appendChild(size);
    div.appendChild(time);

    return div;
  }

  function buildEntryEl(entry) {
    if (entry.kind === 'network') return buildNetworkEntryEl(entry);
    return buildConsoleEntryEl(entry);
  }

  function entrySearchText(entry) {
    if (entry.kind === 'network') {
      return ((entry.method || '') + ' ' + (entry.url || '') + ' ' + (entry.status || '') + ' ' +
              (entry.resourceType || '') + ' ' + (entry.mimeType || '') + ' ' +
              (entry.errorText || '')).toLowerCase();
    }
    return ((entry.text || '') + ' ' + (entry.url || '')).toLowerCase();
  }

  function matchesTab(entry) {
    if (activeTab === 'all') return true;
    if (activeTab === 'console') return entry.kind !== 'network';
    if (activeTab === 'network') return entry.kind === 'network';
    return true;
  }

  function matchesFilter(entry) {
    if (!matchesTab(entry)) return false;
    if (!filterText) return true;
    return entrySearchText(entry).includes(filterText);
  }

  function appendLog(entry) {
    allEntries.push(entry);
    totalBodyBytes += bodyByteLength(entry);
    if (allEntries.length > MAX_ENTRIES) {
      const dropped = allEntries.shift();
      if (dropped) totalBodyBytes -= bodyByteLength(dropped);
      if (logsList.firstChild) logsList.removeChild(logsList.firstChild);
    }
    enforceBodyBudget();
    if (matchesFilter(entry)) {
      logsList.appendChild(buildEntryEl(entry));
      if (!paused) {
        logsList.scrollTop = logsList.scrollHeight;
      }
    }
  }

  function rebuildList() {
    logsList.innerHTML = '';
    const frag = document.createDocumentFragment();
    for (const entry of allEntries) {
      if (matchesFilter(entry)) frag.appendChild(buildEntryEl(entry));
    }
    logsList.appendChild(frag);
    if (!paused) logsList.scrollTop = logsList.scrollHeight;
  }

  btnClear.addEventListener('click', () => {
    allEntries.length = 0;
    totalBodyBytes = 0;
    logsList.innerHTML = '';
  });

  filterInput.addEventListener('input', () => {
    filterText = filterInput.value.trim().toLowerCase();
    rebuildList();
  });

  btnPause.addEventListener('click', () => {
    paused = !paused;
    btnPause.textContent = paused ? 'Resume' : 'Pause';
    if (!paused) logsList.scrollTop = logsList.scrollHeight;
  });

  function headersToHar(headers) {
    if (!headers) return [];
    return Object.entries(headers).map(([name, value]) => ({ name, value: String(value) }));
  }

  function queryStringToHar(url) {
    try {
      const u = new URL(url);
      const out = [];
      u.searchParams.forEach((v, k) => out.push({ name: k, value: v }));
      return out;
    } catch (e) {
      return [];
    }
  }

  function lookupHeader(headers, name) {
    if (!headers) return undefined;
    const lc = name.toLowerCase();
    for (const k of Object.keys(headers)) {
      if (k.toLowerCase() === lc) return headers[k];
    }
    return undefined;
  }

  function entryToHar(e) {
    const reqContentType = lookupHeader(e.requestHeaders, 'content-type');
    const postData = e.requestPostData
      ? { mimeType: reqContentType || 'application/octet-stream', text: e.requestPostData }
      : undefined;
    const httpVersion = e.httpVersion || 'HTTP/1.1';
    const content = {
      size: e.size || 0,
      mimeType: e.mimeType || '',
    };
    if (e.responseBody != null) {
      content.text = e.responseBody;
      if (e.responseBodyBase64) content.encoding = 'base64';
      if (e.responseBodyTruncated) {
        content.comment = 'truncated to first ' + e.responseBody.length +
                          ' bytes of ' + e.responseBodyTruncated + ' original';
      }
    } else if (e.bodyEvicted) {
      content.comment = 'body evicted by webview budget (30MB total); headers preserved';
    }
    const timings = {
      send: e.timing && e.timing.send != null ? e.timing.send : 0,
      wait: e.timing && e.timing.wait != null ? e.timing.wait : (e.durationMs || 0),
      receive: e.timing && e.timing.receive != null ? e.timing.receive : 0,
    };
    if (e.timing) {
      if (e.timing.dns != null) timings.dns = e.timing.dns;
      if (e.timing.connect != null) timings.connect = e.timing.connect;
      if (e.timing.ssl != null) timings.ssl = e.timing.ssl;
    }
    return {
      startedDateTime: new Date(e.timestamp).toISOString(),
      time: e.durationMs || 0,
      request: {
        method: e.method,
        url: e.url,
        httpVersion,
        cookies: [],
        headers: headersToHar(e.requestHeaders),
        queryString: queryStringToHar(e.url),
        headersSize: -1,
        bodySize: postData ? postData.text.length : -1,
        ...(postData ? { postData } : {}),
      },
      response: {
        status: e.status || 0,
        statusText: e.statusText || (e.failed ? e.errorText || 'Failed' : ''),
        httpVersion,
        cookies: [],
        headers: headersToHar(e.responseHeaders),
        content,
        redirectURL: '',
        headersSize: -1,
        bodySize: e.size || 0,
      },
      cache: {},
      timings,
      serverIPAddress: e.serverIPAddress || undefined,
      _resourceType: e.resourceType,
      _failed: e.failed || undefined,
      _errorText: e.errorText || undefined,
    };
  }

  function buildHAR() {
    const networkEntries = allEntries.filter((e) => e.kind === 'network');
    return {
      json: JSON.stringify(
        {
          log: {
            version: '1.2',
            creator: { name: 'dev-browser-panel', version: '0.1.0' },
            entries: networkEntries.map(entryToHar),
          },
        },
        null,
        2,
      ),
      count: networkEntries.length,
    };
  }

  if (btnCopyHar) {
    btnCopyHar.addEventListener('click', () => {
      const { json, count } = buildHAR();
      if (count === 0) {
        btnCopyHar.textContent = 'No network';
        setTimeout(() => (btnCopyHar.textContent = 'Copy HAR'), 1200);
        return;
      }
      if (vscode) {
        vscode.postMessage({ type: 'copy-har', har: json, count });
      } else if (navigator.clipboard && navigator.clipboard.writeText) {
        void navigator.clipboard.writeText(json);
      }
      const prev = btnCopyHar.textContent;
      btnCopyHar.textContent = 'Copied ' + count;
      setTimeout(() => (btnCopyHar.textContent = prev), 1200);
    });
  }

  tabButtons.forEach((btn) => {
    btn.addEventListener('click', () => {
      activeTab = btn.dataset.tab || 'all';
      tabButtons.forEach((b) => b.classList.toggle('tab-active', b === btn));
      rebuildList();
    });
  });

  window.addEventListener('message', (e) => {
    const msg = e.data;
    if (msg && msg.type === 'log') appendLog(msg.entry);
  });
}());
