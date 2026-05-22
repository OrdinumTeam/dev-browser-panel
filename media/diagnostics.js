(function () {
  // eslint-disable-next-line no-undef
  const vscode = acquireVsCodeApi();
  const btnCopy = document.getElementById('btn-copy');
  let currentData = null;

  if (btnCopy) {
    btnCopy.addEventListener('click', () => {
      vscode.postMessage({ type: 'copy' });
    });
  }

  function updateTable(data) {
    const tbody = document.getElementById('diag-body');
    if (!tbody) return;
    tbody.innerHTML = '';
    for (const [k, v] of Object.entries(data)) {
      const tr = document.createElement('tr');
      tr.innerHTML = `<td>${escapeHtml(k)}</td><td>${escapeHtml(String(v))}</td>`;
      tbody.appendChild(tr);
    }
  }

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }

  window.addEventListener('message', (e) => {
    const msg = e.data;
    if (!msg || !msg.type) return;
    if (msg.type === 'update') {
      currentData = msg.data;
      updateTable(currentData);
    }
  });
}());
