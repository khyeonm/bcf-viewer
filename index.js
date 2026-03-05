// AutoPipe Plugin: bcf-viewer
// BCF (Binary VCF) viewer with BGZF decompression

(function() {
  var PAKO_CDN = 'https://cdn.jsdelivr.net/npm/pako@2.1.0/dist/pako.min.js';
  var PAGE_SIZE = 100;
  var MAX_VARIANTS = 2000;
  var MAX_DECOMPRESS = 4 * 1024 * 1024;

  var rootEl = null;
  var headerText = '';
  var contigs = [];
  var allVariants = [];
  var filteredVariants = [];
  var currentPage = 0;
  var filterChrom = '';
  var showHeader = false;

  function loadScript(url, cb) {
    if (window.pako) { cb(); return; }
    var s = document.createElement('script');
    s.src = url;
    s.onload = function() { cb(); };
    s.onerror = function() { cb(new Error('Failed to load pako')); };
    document.head.appendChild(s);
  }

  function decompressBGZF(buf) {
    var data = new Uint8Array(buf);
    var blocks = [];
    var totalSize = 0;
    var pos = 0;
    while (pos < data.length && totalSize < MAX_DECOMPRESS) {
      if (data[pos] !== 31 || data[pos + 1] !== 139) break;
      var xlen = data[pos + 10] | (data[pos + 11] << 8);
      var bsize = -1;
      var extraPos = pos + 12;
      var extraEnd = extraPos + xlen;
      while (extraPos < extraEnd) {
        if (data[extraPos] === 66 && data[extraPos + 1] === 67) {
          bsize = (data[extraPos + 4] | (data[extraPos + 5] << 8)) + 1;
          break;
        }
        var slen = data[extraPos + 2] | (data[extraPos + 3] << 8);
        extraPos += 4 + slen;
      }
      if (bsize < 0) break;
      try {
        var block = pako.inflateRaw(data.subarray(pos + 18, pos + bsize - 8));
        blocks.push(block);
        totalSize += block.length;
      } catch(e) { break; }
      pos += bsize;
    }
    var result = new Uint8Array(totalSize);
    var offset = 0;
    for (var i = 0; i < blocks.length; i++) { result.set(blocks[i], offset); offset += blocks[i].length; }
    return result;
  }

  function readCString(data, pos) {
    var s = '';
    while (pos < data.length && data[pos] !== 0) { s += String.fromCharCode(data[pos]); pos++; }
    return { str: s, end: pos + 1 };
  }

  function parseBCF(decompressed) {
    var view = new DataView(decompressed.buffer, decompressed.byteOffset, decompressed.byteLength);
    var pos = 0;

    // Magic: BCF\2
    var m = String.fromCharCode(decompressed[0], decompressed[1], decompressed[2]);
    if (m !== 'BCF') throw new Error('Not a valid BCF file');
    pos = 5; // BCF + major + minor

    // Header length + header text
    var headerLen = view.getInt32(pos, true); pos += 4;
    var headerBytes = decompressed.subarray(pos, pos + headerLen);
    headerText = '';
    for (var i = 0; i < headerBytes.length; i++) {
      if (headerBytes[i] === 0) break;
      headerText += String.fromCharCode(headerBytes[i]);
    }
    pos += headerLen;

    // Parse contigs from header
    contigs = [];
    var lines = headerText.split('\n');
    for (var li = 0; li < lines.length; li++) {
      var line = lines[li];
      if (line.indexOf('##contig=') === 0) {
        var idMatch = line.match(/ID=([^,>]+)/);
        if (idMatch) contigs.push(idMatch[1]);
      }
    }

    // Parse variant records
    allVariants = [];
    while (pos + 8 < decompressed.length && allVariants.length < MAX_VARIANTS) {
      var lShared = view.getInt32(pos, true); pos += 4;
      var lIndiv = view.getInt32(pos, true); pos += 4;
      if (lShared <= 0 || pos + lShared > decompressed.length) break;

      var recStart = pos;
      var chromIdx = view.getInt32(pos, true); pos += 4;
      var posVal = view.getInt32(pos, true); pos += 4;
      pos += 4; // rlen
      var qual = view.getFloat32(pos, true); pos += 4;
      pos += 4; // n_info + n_allele
      var nSample_nFmt = view.getInt32(pos, true); pos += 4;

      // Read ID
      var idResult = readCString(decompressed, pos);
      pos = recStart + lShared;

      var chrom = chromIdx >= 0 && chromIdx < contigs.length ? contigs[chromIdx] : 'chr' + chromIdx;

      allVariants.push({
        chrom: chrom,
        pos: posVal + 1,
        id: idResult.str || '.',
        qual: isNaN(qual) ? '.' : qual.toFixed(1)
      });

      pos = recStart + lShared + lIndiv;
    }
  }

  function classifyVariant(v) {
    return 'other'; // BCF records need more parsing for ref/alt; show as generic
  }

  function applyFilter() {
    filteredVariants = allVariants.filter(function(v) {
      if (filterChrom && v.chrom !== filterChrom) return false;
      return true;
    });
    currentPage = 0;
  }

  function render() {
    if (!rootEl) return;
    var chroms = [];
    var seen = {};
    for (var i = 0; i < allVariants.length; i++) {
      if (!seen[allVariants[i].chrom]) { seen[allVariants[i].chrom] = true; chroms.push(allVariants[i].chrom); }
    }

    var totalPages = Math.max(1, Math.ceil(filteredVariants.length / PAGE_SIZE));
    if (currentPage >= totalPages) currentPage = totalPages - 1;
    var startIdx = currentPage * PAGE_SIZE;
    var pageVars = filteredVariants.slice(startIdx, startIdx + PAGE_SIZE);

    var html = '<div class="bcf-plugin">';

    // Summary
    html += '<div class="bcf-summary">';
    html += '<span class="stat"><b>' + filteredVariants.length.toLocaleString() + '</b> variants</span>';
    html += '<span class="stat"><b>' + contigs.length + '</b> contigs</span>';
    html += '<span class="stat">BCF format</span>';
    if (allVariants.length >= MAX_VARIANTS) html += '<span class="stat" style="color:#c62828">(first ' + MAX_VARIANTS + ' variants)</span>';
    html += '</div>';

    // Header
    if (headerText) {
      html += '<div class="bcf-header-section">';
      html += '<div class="bcf-header-toggle" id="bcfHeaderToggle">' + (showHeader ? '\u25BC' : '\u25B6') + ' VCF Header</div>';
      if (showHeader) {
        html += '<div class="bcf-header-content">' + headerText.replace(/</g, '&lt;') + '</div>';
      }
      html += '</div>';
    }

    // Controls
    html += '<div class="bcf-controls">';
    html += '<select id="bcfChromFilter"><option value="">All chromosomes</option>';
    for (var ci = 0; ci < chroms.length; ci++) {
      html += '<option value="' + chroms[ci] + '"' + (chroms[ci] === filterChrom ? ' selected' : '') + '>' + chroms[ci] + '</option>';
    }
    html += '</select>';
    html += '</div>';

    // Table
    html += '<div class="bcf-table-wrap" style="max-height:450px;overflow:auto;">';
    html += '<table class="bcf-table"><thead><tr>';
    html += '<th>#</th><th>CHROM</th><th>POS</th><th>ID</th><th>QUAL</th>';
    html += '</tr></thead><tbody>';

    for (var vi = 0; vi < pageVars.length; vi++) {
      var v = pageVars[vi];
      html += '<tr>';
      html += '<td style="color:#aaa">' + (startIdx + vi + 1) + '</td>';
      html += '<td><span class="chr-badge">' + v.chrom + '</span></td>';
      html += '<td>' + v.pos.toLocaleString() + '</td>';
      html += '<td>' + v.id + '</td>';
      html += '<td>' + v.qual + '</td>';
      html += '</tr>';
    }
    html += '</tbody></table></div>';

    // Pagination
    if (totalPages > 1) {
      html += '<div class="bcf-pagination">';
      html += '<button data-page="prev">&laquo; Prev</button>';
      var startP = Math.max(0, currentPage - 3);
      var endP = Math.min(totalPages, startP + 7);
      if (startP > 0) html += '<button data-page="0">1</button><span>...</span>';
      for (var p = startP; p < endP; p++) {
        html += '<button data-page="' + p + '"' + (p === currentPage ? ' class="current"' : '') + '>' + (p + 1) + '</button>';
      }
      if (endP < totalPages) html += '<span>...</span><button data-page="' + (totalPages - 1) + '">' + totalPages + '</button>';
      html += '<button data-page="next">Next &raquo;</button>';
      html += '<span class="page-info">Page ' + (currentPage + 1) + ' of ' + totalPages + '</span>';
      html += '</div>';
    }

    html += '</div>';
    rootEl.innerHTML = html;

    // Events
    var ht = rootEl.querySelector('#bcfHeaderToggle');
    if (ht) ht.addEventListener('click', function() { showHeader = !showHeader; render(); });
    var cs = rootEl.querySelector('#bcfChromFilter');
    if (cs) cs.addEventListener('change', function() { filterChrom = this.value; applyFilter(); render(); });
    var pbs = rootEl.querySelectorAll('.bcf-pagination button');
    for (var bi = 0; bi < pbs.length; bi++) {
      pbs[bi].addEventListener('click', function() {
        var pg = this.getAttribute('data-page');
        if (pg === 'prev') { if (currentPage > 0) currentPage--; }
        else if (pg === 'next') { if (currentPage < totalPages - 1) currentPage++; }
        else { currentPage = parseInt(pg, 10); }
        render();
      });
    }
  }

  window.AutoPipePlugin = {
    render: function(container, fileUrl, filename) {
      rootEl = container;
      rootEl.innerHTML = '<div class="bcf-loading">Loading ' + filename + '...</div>';
      headerText = ''; contigs = []; allVariants = []; filteredVariants = [];
      currentPage = 0; filterChrom = ''; showHeader = false;

      loadScript(PAKO_CDN, function(err) {
        if (err) { rootEl.innerHTML = '<div class="bcf-error">Failed to load pako library.</div>'; return; }
        fetch(fileUrl)
          .then(function(resp) { return resp.arrayBuffer(); })
          .then(function(buf) {
            try {
              var decompressed = decompressBGZF(buf);
              parseBCF(decompressed);
              filteredVariants = allVariants.slice();
              render();
            } catch(e) {
              rootEl.innerHTML = '<div class="bcf-error">Error parsing BCF: ' + e.message + '</div>';
            }
          })
          .catch(function(err) {
            rootEl.innerHTML = '<div class="bcf-error">Error loading file: ' + err.message + '</div>';
          });
      });
    },
    destroy: function() { allVariants = []; filteredVariants = []; rootEl = null; }
  };
})();
