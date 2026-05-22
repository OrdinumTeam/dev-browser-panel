(function () {
  const content = document.getElementById('content');
  const tabBtns = document.querySelectorAll('.tab-btn');
  let currentTab = 'cookies';
  let storageData = { cookies: [], localStorage: {}, sessionStorage: {} };

  function escapeHtml(s) {
    return String(s === null || s === undefined ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function renderCookies(cookies) {
    if (!cookies || cookies.length === 0) {
      content.innerHTML = '<div class="empty">No cookies</div>';
      return;
    }
    const rows = cookies.map(c => `
      <tr>
        <td title="${escapeHtml(c.name)}">${escapeHtml(c.name)}</td>
        <td title="${escapeHtml(c.value)}" class="val-cell">${escapeHtml(c.value)}</td>
        <td>${escapeHtml(c.domain || '')}</td>
        <td>${escapeHtml(c.path || '')}</td>
        <td>${c.httpOnly ? 'Yes' : 'No'}</td>
        <td>${c.secure ? 'Yes' : 'No'}</td>
      </tr>
    `).join('');
    content.innerHTML = `
      <table>
        <thead><tr>
          <th>Name</th><th>Value</th><th>Domain</th><th>Path</th><th>HttpOnly</th><th>Secure</th>
        </tr></thead>
        <tbody>${rows}</tbody>
      </table>
    `;
  }

  function renderKv(obj, label) {
    const entries = Object.entries(obj || {});
    if (entries.length === 0) {
      content.innerHTML = `<div class="empty">No ${label} entries</div>`;
      return;
    }
    const rows = entries.map(([k, v]) => `
      <tr>
        <td title="${escapeHtml(k)}">${escapeHtml(k)}</td>
        <td title="${escapeHtml(v)}" class="val-cell">${escapeHtml(v)}</td>
      </tr>
    `).join('');
    content.innerHTML = `
      <table>
        <thead><tr><th>Key</th><th>Value</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    `;
  }

  function render() {
    if (currentTab === 'cookies') renderCookies(storageData.cookies);
    else if (currentTab === 'localStorage') renderKv(storageData.localStorage, 'localStorage');
    else renderKv(storageData.sessionStorage, 'sessionStorage');
  }

  tabBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      tabBtns.forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      currentTab = btn.dataset.tab;
      render();
    });
  });

  window.addEventListener('message', (e) => {
    const msg = e.data;
    if (!msg || !msg.type) return;
    if (msg.type === 'storage-data') {
      storageData = msg.data;
      render();
    }
  });

  render();
}());
