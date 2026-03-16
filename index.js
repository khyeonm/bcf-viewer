// AutoPipe Plugin: bcf-viewer
// BCF (Binary VCF) viewer — data table with server-side pagination
// Requires bcftools or Docker on the remote server
// Supported extensions: bcf

(function() {
  var PAGE_SIZE = 100;
  var _container = null;
  var _metaCache = {};

  // ── Inject scoped styles ──
  var styleId = '__bcf_viewer_style__';
  if (!document.getElementById(styleId)) {
    var style = document.createElement('style');
    style.id = styleId;
    style.textContent =
      '.bcf-viewer { overflow: auto; }' +
      '.bcf-viewer table { width: 100%; border-collapse: collapse; font-size: 13px; table-layout: auto; }' +
      '.bcf-viewer th { background: #f5f5f5; padding: 8px 12px; text-align: left; font-weight: 600; border-bottom: 2px solid #e5e5e5; position: sticky; top: 0; white-space: nowrap; }' +
      '.bcf-viewer td { padding: 6px 12px; border-bottom: 1px solid #f0f0f0; font-family: "SF Mono","Fira Code","Consolas",monospace; font-size: 12px; white-space: nowrap; }' +
      '.bcf-viewer tr:hover td { background: #f0f7ff; }' +
      '.bcf-viewer .bcf-meta { font-size: 12px; color: #666; margin-bottom: 12px; }' +
      '.bcf-viewer .bcf-seq { font-family: "SF Mono",monospace; font-size: 11px; letter-spacing: 1px; }' +
      '.bcf-viewer .base-A { color: #2ecc71; font-weight: 600; }' +
      '.bcf-viewer .base-T { color: #e74c3c; font-weight: 600; }' +
      '.bcf-viewer .base-C { color: #3498db; font-weight: 600; }' +
      '.bcf-viewer .base-G { color: #f39c12; font-weight: 600; }' +
      '.bcf-viewer .bcf-pagination { display: flex; align-items: center; gap: 8px; padding: 10px 0; justify-content: center; font-size: 13px; color: #666; }' +
      '.bcf-viewer .bcf-pagination button { padding: 4px 12px; border: 1px solid #ddd; border-radius: 4px; background: #f8f8f8; cursor: pointer; font-size: 12px; }' +
      '.bcf-viewer .bcf-pagination button:hover { background: #eee; }' +
      '.bcf-viewer .bcf-pagination button:disabled { color: #ccc; cursor: not-allowed; background: #fafafa; }' +
      '.bcf-viewer .bcf-error { padding: 24px; text-align: center; color: #666; }' +
      '.bcf-viewer .bcf-error h3 { margin: 0 0 8px 0; color: #333; }' +
      '.bcf-viewer .bcf-error p { margin: 0 0 8px 0; font-size: 13px; }' +
      '.bcf-viewer .bcf-error code { background: #f0f0f0; padding: 2px 6px; border-radius: 3px; font-size: 12px; }';
    document.head.appendChild(style);
  }

  function colorBases(seq) {
    return seq.replace(/[ATCGN]/gi, function(b) {
      var u = b.toUpperCase();
      if (u === 'A') return '<span class="base-A">' + b + '</span>';
      if (u === 'T') return '<span class="base-T">' + b + '</span>';
      if (u === 'C') return '<span class="base-C">' + b + '</span>';
      if (u === 'G') return '<span class="base-G">' + b + '</span>';
      return b;
    });
  }

  function escapeHtml(str) {
    return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  async function fetchPage(name, page) {
    var resp = await fetch(
      '/data/' + encodeURIComponent(name) + '?page=' + page + '&page_size=' + PAGE_SIZE
    );
    return await resp.json();
  }

  function renderTable(name, headers, rows, total, page) {
    var totalPages = Math.ceil(total / PAGE_SIZE) || 1;
    var html = '<table><tr>';
    headers.forEach(function(h) {
      html += '<th>' + escapeHtml(h) + '</th>';
    });
    html += '</tr>';
    rows.forEach(function(rec) {
      html += '<tr>';
      rec.forEach(function(val, i) {
        if (headers[i] === 'REF' || headers[i] === 'ALT') {
          html += '<td class="bcf-seq">' + colorBases(escapeHtml(val)) + '</td>';
        } else {
          html += '<td>' + escapeHtml(val) + '</td>';
        }
      });
      html += '</tr>';
    });
    html += '</table>';

    if (totalPages > 1) {
      var safeName = name.replace(/'/g, "\\'");
      html += '<div class="bcf-pagination">';
      html +=
        '<button onclick="window._bcfPluginPaginate(\'' +
        safeName + "'," + (page - 1) + ')"' +
        (page <= 0 ? ' disabled' : '') +
        '>&laquo; Prev</button>';
      html +=
        '<span>Page ' + (page + 1) + ' / ' + totalPages +
        ' (' + total.toLocaleString() + ' rows)</span>';
      html +=
        '<button onclick="window._bcfPluginPaginate(\'' +
        safeName + "'," + (page + 1) + ')"' +
        (page >= totalPages - 1 ? ' disabled' : '') +
        '>Next &raquo;</button>';
      html += '</div>';
    }
    return html;
  }

  function renderError(msg) {
    return '<div class="bcf-viewer"><div class="bcf-error">' +
      '<div style="font-size:48px;margin-bottom:16px">&#9888;</div>' +
      '<h3>Cannot Read BCF File</h3>' +
      '<p>' + escapeHtml(msg) + '</p>' +
      '<p style="color:#888;font-size:12px">BCF is a binary format. To view data, install one of:</p>' +
      '<p><code>bcftools</code> on the remote server, or <code>Docker</code> (auto-pulls bcftools image)</p>' +
      '</div></div>';
  }

  async function renderPage(name, page) {
    if (!_container) return;

    if (page > 0) {
      _container.innerHTML = '<div class="bcf-viewer"><p class="bcf-meta">Loading page...</p></div>';
    }

    var data = await fetchPage(name, page);
    if (data.error) {
      _container.innerHTML = renderError(data.error);
      return;
    }

    // Cache metadata from first page
    if (page === 0 && data.meta) {
      _metaCache[name] = { meta: data.meta, col_headers: data.col_headers || [] };
    }
    var cached = _metaCache[name] || {};
    var hdrs = cached.col_headers || [];

    var html = '<div class="bcf-viewer">';
    html += '<p class="bcf-meta">' + (data.total || 0).toLocaleString() + ' variant(s)</p>';

    // Collapsible metadata
    if (cached.meta) {
      var metaLines = cached.meta.split('\n');
      html +=
        '<details style="margin-bottom:12px">' +
        '<summary style="cursor:pointer;font-size:13px;color:#666">Show metadata (' +
        metaLines.length + ' lines)</summary>' +
        '<pre style="font-size:11px;color:#888;margin-top:4px;max-height:200px;overflow:auto">' +
        escapeHtml(cached.meta) + '</pre></details>';
    }

    html += renderTable(name, hdrs, data.rows || [], data.total || 0, page);
    html += '</div>';
    _container.innerHTML = html;
  }

  // Global pagination handler
  window._bcfPluginPaginate = function(name, page) {
    if (page < 0) return;
    renderPage(name, page);
  };

  window.AutoPipePlugin = {
    render: function(container, fileUrl, filename) {
      _container = container;
      _container.innerHTML = '<div class="bcf-viewer"><p class="bcf-meta">Loading BCF...</p></div>';
      renderPage(filename, 0).catch(function(e) {
        _container.innerHTML = renderError(e.message);
      });
    },
    destroy: function() {
      _container = null;
      _metaCache = {};
      delete window._bcfPluginPaginate;
    }
  };
})();
