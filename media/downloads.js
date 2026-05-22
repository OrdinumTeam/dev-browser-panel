(function () {
  // eslint-disable-next-line no-undef
  const vscode = acquireVsCodeApi();
  const list = document.getElementById('downloads-list');
  const btnClear = document.getElementById('btn-clear');

  const items = new Map();

  function formatBytes(bytes) {
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return Math.round(bytes / 1024) + ' KB';
    return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
  }

  function formatDate(ts) {
    const d = new Date(ts);
    return d.toLocaleTimeString();
  }

  function renderItem(item) {
    let el = document.getElementById('dl-' + item.guid);
    if (!el) {
      el = document.createElement('div');
      el.id = 'dl-' + item.guid;
      el.className = 'dl-item';
      list.insertBefore(el, list.firstChild);
    }

    const progress = item.totalBytes > 0
      ? Math.min(100, Math.round((item.receivedBytes / item.totalBytes) * 100))
      : 0;

    let stateLabel = '';
    let stateClass = '';
    if (item.state === 'downloading') {
      stateLabel = progress + '%';
      stateClass = 'dl-downloading';
    } else if (item.state === 'complete') {
      stateLabel = 'Complete';
      stateClass = 'dl-complete';
    } else {
      stateLabel = 'Failed';
      stateClass = 'dl-failed';
    }

    el.innerHTML = `
      <div class="dl-header">
        <span class="dl-name" title="${escapeHtml(item.url)}">${escapeHtml(item.filename)}</span>
        <span class="dl-state ${stateClass}">${stateLabel}</span>
      </div>
      <div class="dl-meta">
        ${item.totalBytes > 0 ? formatBytes(item.receivedBytes) + ' / ' + formatBytes(item.totalBytes) : formatBytes(item.receivedBytes)}
        &nbsp;&middot;&nbsp; ${formatDate(item.timestamp)}
      </div>
      ${item.state === 'downloading'
        ? `<div class="dl-progress-bar"><div class="dl-progress-fill" style="width:${progress}%"></div></div>`
        : ''}
      <div class="dl-actions">
        ${item.state === 'complete'
          ? `<button class="dl-btn" data-action="open-folder" data-guid="${escapeHtml(item.guid)}">Open Folder</button>`
          : ''}
      </div>
    `;

    el.querySelectorAll('[data-action="open-folder"]').forEach(btn => {
      btn.addEventListener('click', () => {
        vscode.postMessage({ type: 'open-folder', guid: item.guid });
      });
    });
  }

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  if (btnClear) {
    btnClear.addEventListener('click', () => {
      items.clear();
      list.innerHTML = '';
      vscode.postMessage({ type: 'clear' });
    });
  }

  window.addEventListener('message', (e) => {
    const msg = e.data;
    if (!msg || !msg.type) return;
    if (msg.type === 'download-item') {
      items.set(msg.item.guid, msg.item);
      renderItem(msg.item);
    } else if (msg.type === 'download-progress') {
      const item = items.get(msg.guid);
      if (item) {
        item.receivedBytes = msg.receivedBytes ?? item.receivedBytes;
        item.totalBytes = msg.totalBytes ?? item.totalBytes;
        item.state = msg.state ?? item.state;
        renderItem(item);
      }
    }
  });
}());
