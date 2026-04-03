import express from 'express';
import {
  S3Client,
  ListObjectsV2Command,
  GetObjectCommand,
} from '@aws-sdk/client-s3';

// ─── Config ──────────────────────────────────────────────────────────────────
const REGION = process.env.AWS_REGION || 'us-east-1';
const PORT   = process.env.PORT || 3000;

const s3  = new S3Client({ region: REGION });
const app = express();

const IMAGE_EXTS = new Set([
  'jpg','jpeg','png','gif','webp','svg','bmp','tiff','tif','avif','ico'
]);

function isImage(key) {
  const ext = key.split('.').pop()?.toLowerCase();
  return IMAGE_EXTS.has(ext);
}

// ─── S3 Helpers ──────────────────────────────────────────────────────────────

async function listPrefix(bucket, prefix = '') {
  const folders = [], files = [];
  let token;
  do {
    const res = await s3.send(new ListObjectsV2Command({
      Bucket: bucket, Prefix: prefix, Delimiter: '/',
      ContinuationToken: token,
    }));
    for (const cp of res.CommonPrefixes ?? []) folders.push(cp.Prefix);
    for (const obj of res.Contents ?? []) {
      if (obj.Key !== prefix)
        files.push({ key: obj.Key, lastModified: obj.LastModified, size: obj.Size });
    }
    token = res.NextContinuationToken;
  } while (token);
  return { folders, files };
}

async function scanFolder(bucket, prefix) {
  let latest = null, count = 0, token;
  do {
    const res = await s3.send(new ListObjectsV2Command({
      Bucket: bucket, Prefix: prefix, ContinuationToken: token,
    }));
    for (const obj of res.Contents ?? []) {
      count++;
      if (!latest || obj.LastModified > latest) latest = obj.LastModified;
    }
    token = res.NextContinuationToken;
  } while (token);
  return { latest, count };
}

// ─── Routes ──────────────────────────────────────────────────────────────────

app.get('/', (req, res) => res.send(renderLanding()));

app.get('/browse', async (req, res) => {
  const bucket = (req.query.bucket ?? '').trim();
  const prefix = req.query.prefix ?? '';
  if (!bucket) return res.redirect('/');
  try {
    const { folders, files } = await listPrefix(bucket, prefix);
    const folderRows = await Promise.all(
      folders.map(async (f) => {
        const { latest, count } = await scanFolder(bucket, f);
        return { prefix: f, name: f.slice(prefix.length), latestModified: latest, count };
      })
    );
    res.send(renderPage({ prefix, crumbs: buildCrumbs(prefix, bucket), folderRows, files, bucket }));
  } catch (err) {
    res.status(500).send(renderError(err, bucket));
  }
});

// Image proxy — streams the S3 object to the browser
app.get('/image', async (req, res) => {
  const key    = req.query.key;
  const bucket = (req.query.bucket ?? '').trim();
  if (!key || !isImage(key) || !bucket) return res.status(400).send('Bad request');
  try {
    const result = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
    res.setHeader('Content-Type', result.ContentType || 'application/octet-stream');
    if (result.ContentLength) res.setHeader('Content-Length', result.ContentLength);
    result.Body.pipe(res);
  } catch (err) {
    res.status(500).send(err.message);
  }
});

// ─── Helpers ─────────────────────────────────────────────────────────────────

function buildCrumbs(prefix, bucket) {
  const crumbs = [{ label: bucket, prefix: '' }];
  let acc = '';
  for (const part of prefix.split('/').filter(Boolean)) {
    acc += part + '/';
    crumbs.push({ label: part, prefix: acc });
  }
  return crumbs;
}

function fmtDate(d) {
  if (!d) return '<span class="na">—</span>';
  return new Intl.DateTimeFormat('en-US', {
    year: 'numeric', month: 'short', day: '2-digit',
    hour: '2-digit', minute: '2-digit', timeZoneName: 'short',
  }).format(new Date(d));
}

function fmtSize(bytes) {
  if (bytes == null) return '—';
  if (bytes === 0) return '0 B';
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return parseFloat((bytes / Math.pow(1024, i)).toFixed(1)) + '\u00a0' + sizes[i];
}

function esc(str) {
  return String(str ?? '')
    .replace(/&/g,'&amp;').replace(/</g,'&lt;')
    .replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// ─── HTML renderer ───────────────────────────────────────────────────────────

function renderPage({ prefix, crumbs, folderRows, files, bucket }) {
  const parentPrefix = crumbs.length > 1 ? crumbs[crumbs.length - 2].prefix : null;
  const isRoot = prefix === '';

  const crumbHtml = crumbs.map((c, i) => {
    const isLast = i === crumbs.length - 1;
    return isLast
      ? `<span class="crumb active">${esc(c.label)}</span>`
      : `<a class="crumb" href="/browse?bucket=${encodeURIComponent(bucket)}&prefix=${encodeURIComponent(c.prefix)}">${esc(c.label)}</a><span class="sep">/</span>`;
  }).join('');

  const folderHtml = folderRows.map(f => `
    <tr class="row"
      data-name="${esc(f.name.toLowerCase())}"
      data-type="folder"
      data-size="-1"
      data-count="${f.count}"
      data-date="${f.latestModified ? new Date(f.latestModified).toISOString() : ''}">
      <td class="icon-cell">
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
          <path d="M1 3.5A1.5 1.5 0 0 1 2.5 2h3.172a1.5 1.5 0 0 1 1.06.44l.829.828A1.5 1.5 0 0 0 8.62 3.75H13.5A1.5 1.5 0 0 1 15 5.25v7.25A1.5 1.5 0 0 1 13.5 14h-11A1.5 1.5 0 0 1 1 12.5v-9Z" fill="#FEF3C7" stroke="#D97706" stroke-width="1"/>
        </svg>
      </td>
      <td class="name-cell">
        <a class="entry-link folder-link" href="/browse?bucket=${encodeURIComponent(bucket)}&prefix=${encodeURIComponent(f.prefix)}">${esc(f.name)}</a>
      </td>
      <td class="type-cell"><span class="pill folder-pill">Folder</span></td>
      <td class="count-cell">${f.count.toLocaleString()}</td>
      <td class="size-cell">—</td>
      <td class="date-cell">${fmtDate(f.latestModified)}<span class="date-note"> latest inside</span></td>
    </tr>`).join('');

  const fileHtml = files.map(f => {
    const name = f.key.slice(prefix.length);
    const img  = isImage(f.key);
    const nameHtml = img
      ? `<a class="entry-link image-link" href="#" onclick="openImage(${esc(JSON.stringify(f.key))},${esc(JSON.stringify(name))},'${esc(fmtSize(f.size))}'); return false;">${esc(name)}</a>`
      : `<span class="entry-name">${esc(name)}</span>`;
    return `
    <tr class="row"
      data-name="${esc(name.toLowerCase())}"
      data-type="${img ? 'image' : 'object'}"
      data-size="${f.size ?? -1}"
      data-count="-1"
      data-date="${f.lastModified ? new Date(f.lastModified).toISOString() : ''}">
      <td class="icon-cell">
        ${img
          ? `<svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg"><rect x="1" y="2" width="14" height="12" rx="1.5" fill="#EFF6FF" stroke="#3B82F6" stroke-width="1"/><circle cx="5" cy="6" r="1.5" fill="#93C5FD"/><path d="M1 11l3.5-3.5 2.5 2.5 2-2 5 5" stroke="#3B82F6" stroke-width="1" stroke-linecap="round" stroke-linejoin="round"/></svg>`
          : `<svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M3 1.5h7l4 4V14a.5.5 0 0 1-.5.5h-10A.5.5 0 0 1 3 14V2a.5.5 0 0 1 0-.5Z" fill="#F8FAFC" stroke="#CBD5E1" stroke-width="1"/><path d="M10 1.5V5.5H14" stroke="#CBD5E1" stroke-width="1"/></svg>`
        }
      </td>
      <td class="name-cell">${nameHtml}</td>
      <td class="type-cell"><span class="pill ${img ? 'image-pill' : 'file-pill'}">${img ? 'Image' : 'Object'}</span></td>
      <td class="count-cell na">—</td>
      <td class="size-cell">${fmtSize(f.size)}</td>
      <td class="date-cell">${fmtDate(f.lastModified)}</td>
    </tr>`;
  }).join('');

  const emptyHtml = (folderRows.length + files.length === 0)
    ? `<tr><td colspan="6" class="empty">This folder is empty.</td></tr>` : '';

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1.0"/>
  <title>S3 Browser — ${esc(bucket)}</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet">
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    :root {
      --bg:        #F1F5F9;
      --surface:   #FFFFFF;
      --border:    #E2E8F0;
      --border2:   #CBD5E1;
      --text:      #0F172A;
      --text2:     #475569;
      --muted:     #94A3B8;
      --accent:    #2563EB;
      --accent-bg: #EFF6FF;
      --shadow-sm: 0 1px 2px rgba(15,23,42,0.06);
      --shadow-md: 0 8px 24px rgba(15,23,42,0.10);
      --font:      'Inter', system-ui, sans-serif;
      --mono:      'JetBrains Mono', monospace;
    }
    body { background: var(--bg); color: var(--text); font-family: var(--font); font-size: 14px; line-height: 1.6; min-height: 100vh; }

    /* Header */
    .header { background: var(--surface); border-bottom: 1px solid var(--border); padding: 0 32px; height: 56px; display: flex; align-items: center; gap: 14px; box-shadow: var(--shadow-sm); position: sticky; top: 0; z-index: 10; }
    .logo { display: flex; align-items: center; gap: 9px; font-size: 15px; font-weight: 600; color: var(--text); letter-spacing: -0.01em; }
    .logo-icon { width: 30px; height: 30px; background: #FF9900; border-radius: 7px; display: flex; align-items: center; justify-content: center; }
    .divider { width: 1px; height: 20px; background: var(--border); }
    .bucket-chip { font-family: var(--mono); font-size: 12px; color: var(--text2); background: var(--bg); border: 1px solid var(--border); border-radius: 6px; padding: 3px 10px; }
    .note { margin-left: auto; font-size: 12px; color: #92400E; background: #FFFBEB; border: 1px solid #FDE68A; border-radius: 6px; padding: 3px 10px; }

    /* Breadcrumbs */
    .breadcrumb-bar { background: var(--surface); border-bottom: 1px solid var(--border); padding: 10px 32px; font-family: var(--mono); font-size: 12px; display: flex; align-items: center; flex-wrap: wrap; }
    .crumb { color: var(--muted); text-decoration: none; transition: color 0.12s; }
    .crumb:hover { color: var(--accent); }
    .crumb.active { color: var(--text); font-weight: 500; }
    .sep { color: var(--border2); margin: 0 5px; }

    /* Toolbar */
    .toolbar { padding: 16px 32px; display: flex; align-items: center; gap: 10px; }
    .up-link { display: inline-flex; align-items: center; gap: 6px; font-size: 13px; font-weight: 500; color: var(--text2); text-decoration: none; background: var(--surface); border: 1px solid var(--border); border-radius: 7px; padding: 5px 12px; transition: all 0.12s; box-shadow: var(--shadow-sm); }
    .up-link:hover { border-color: var(--accent); color: var(--accent); background: var(--accent-bg); }
    .count { margin-left: auto; font-size: 12px; color: var(--muted); font-family: var(--mono); }

    /* Table */
    .table-wrap { padding: 0 32px 48px; overflow-x: auto; }
    .table-card { background: var(--surface); border: 1px solid var(--border); border-radius: 10px; overflow: hidden; box-shadow: var(--shadow-sm); }
    table { width: 100%; border-collapse: collapse; font-size: 13px; }
    thead th { text-align: left; font-size: 11px; font-weight: 600; letter-spacing: 0.05em; text-transform: uppercase; color: var(--muted); padding: 10px 14px; background: #F8FAFC; border-bottom: 1px solid var(--border); }
    .row { border-bottom: 1px solid var(--border); transition: background 0.1s; }
    .row:last-child { border-bottom: none; }
    .row:hover { background: #F8FBFF; }
    td { padding: 11px 14px; vertical-align: middle; }

    .icon-cell { width: 36px; }
    .name-cell { min-width: 240px; }
    .entry-link { text-decoration: none; font-weight: 500; transition: color 0.12s; font-size: 13px; }
    .folder-link { color: var(--text); }
    .folder-link:hover { color: var(--accent); }
    .image-link { color: var(--accent); display: inline-flex; align-items: center; gap: 5px; }
    .image-link:hover { color: #1D4ED8; text-decoration: underline; }
    .img-hint { font-size: 10px; color: var(--muted); font-weight: 400; margin-left: 2px; }
    .entry-name { color: var(--text2); font-size: 13px; }

    .type-cell { width: 80px; }
    .pill { font-size: 11px; font-weight: 500; border-radius: 5px; padding: 2px 8px; display: inline-block; }
    .folder-pill { background: #FFFBEB; color: #B45309; border: 1px solid #FDE68A; }
    .image-pill  { background: #EFF6FF; color: #1D4ED8; border: 1px solid #BFDBFE; }
    .file-pill   { background: #F8FAFC; color: #64748B; border: 1px solid #E2E8F0; }

    .count-cell { width: 80px; font-family: var(--mono); font-size: 12px; color: var(--text2); text-align: right; }
    .size-cell { width: 90px; font-family: var(--mono); font-size: 12px; color: var(--muted); text-align: right; }
    .date-cell { font-family: var(--mono); font-size: 12px; color: var(--text2); white-space: nowrap; }
    .date-note { font-size: 11px; color: var(--muted); margin-left: 4px; }
    .na { color: var(--muted); }
    .empty { text-align: center; padding: 56px 0; color: var(--muted); font-size: 13px; }


    /* Bucket input */
    .bucket-form { display: flex; align-items: center; gap: 0; }
    .bucket-input { font-family: var(--mono); font-size: 13px; color: var(--text); background: var(--bg); border: 1px solid var(--border); border-right: none; border-radius: 7px 0 0 7px; padding: 5px 12px; width: 260px; outline: none; transition: border-color 0.12s; }
    .bucket-input:focus { border-color: var(--accent); background: #fff; }
    .bucket-btn { font-size: 13px; font-weight: 500; color: #fff; background: var(--accent); border: 1px solid var(--accent); border-radius: 0 7px 7px 0; padding: 5px 14px; cursor: pointer; transition: background 0.12s; white-space: nowrap; }
    .bucket-btn:hover { background: #1D4ED8; border-color: #1D4ED8; }
    /* Sortable headers */
    thead th.sortable { cursor: pointer; user-select: none; white-space: nowrap; }
    thead th.sortable:hover { color: var(--text2); background: #F1F5F9; }
    thead th.sortable.sort-active { color: var(--accent); background: #EFF6FF; }
    .sort-icon { display: inline-block; width: 14px; margin-left: 3px; opacity: 0.4; font-style: normal; font-size: 10px; vertical-align: middle; }
    thead th.sort-active .sort-icon { opacity: 1; color: var(--accent); }

    /* Image Modal */
    .modal-overlay { display: none; position: fixed; inset: 0; background: rgba(15,23,42,0.55); backdrop-filter: blur(4px); z-index: 100; align-items: center; justify-content: center; padding: 24px; }
    .modal-overlay.open { display: flex; animation: fadeIn 0.15s ease; }
    @keyframes fadeIn { from { opacity: 0; } to { opacity: 1; } }
    .modal { background: var(--surface); border-radius: 12px; box-shadow: var(--shadow-md); max-width: min(920px, 95vw); width: 100%; max-height: 90vh; display: flex; flex-direction: column; overflow: hidden; animation: slideUp 0.18s ease; }
    @keyframes slideUp { from { transform: translateY(10px); opacity: 0; } to { transform: translateY(0); opacity: 1; } }
    .modal-header { display: flex; align-items: center; gap: 10px; padding: 14px 18px; border-bottom: 1px solid var(--border); flex-shrink: 0; }
    .modal-title { font-family: var(--mono); font-size: 13px; color: var(--text); font-weight: 500; flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .modal-close { width: 28px; height: 28px; border-radius: 6px; border: 1px solid var(--border); background: transparent; cursor: pointer; display: flex; align-items: center; justify-content: center; color: var(--muted); font-size: 14px; transition: all 0.12s; flex-shrink: 0; }
    .modal-close:hover { background: var(--bg); color: var(--text); border-color: var(--border2); }
    .modal-body { overflow: auto; display: flex; align-items: center; justify-content: center; padding: 28px; background: #F8FAFC; flex: 1; min-height: 0; }
    .modal-body img { max-width: 100%; max-height: 60vh; object-fit: contain; border-radius: 6px; box-shadow: 0 4px 16px rgba(0,0,0,0.1); display: block; }
    .modal-loader { color: var(--muted); font-size: 13px; display: flex; flex-direction: column; align-items: center; gap: 12px; }
    .spinner { width: 28px; height: 28px; border: 2.5px solid var(--border); border-top-color: var(--accent); border-radius: 50%; animation: spin 0.7s linear infinite; }
    @keyframes spin { to { transform: rotate(360deg); } }
    .modal-error { color: #DC2626; font-size: 13px; text-align: center; line-height: 1.7; }
    .modal-footer { padding: 10px 18px; border-top: 1px solid var(--border); display: flex; align-items: center; justify-content: space-between; flex-shrink: 0; }
    .modal-meta { font-family: var(--mono); font-size: 11px; color: var(--muted); }
    .open-btn { font-size: 12px; font-weight: 500; color: var(--accent); text-decoration: none; background: var(--accent-bg); border: 1px solid #BFDBFE; border-radius: 6px; padding: 4px 12px; transition: background 0.12s; }
    .open-btn:hover { background: #DBEAFE; }
  </style>
</head>
<body>

  <div class="header">
    <div class="logo">
      <div class="logo-icon">
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
          <path d="M8 1L15 4.5V11.5L8 15L1 11.5V4.5L8 1Z" fill="white" fill-opacity="0.9"/>
        </svg>
      </div>
      S3 Browser
    </div>
    <div class="divider"></div>
    <form class="bucket-form" onsubmit="changeBucket(event)">
      <input class="bucket-input" id="bucket-input" type="text" value="${esc(bucket)}"
        placeholder="Enter bucket name…" autocomplete="off" spellcheck="false"/>
      <button class="bucket-btn" type="submit">Browse →</button>
    </form>
    <span class="note">⚠ Dates reflect LastModified — S3 has no native last-access tracking</span>
  </div>

  <div class="breadcrumb-bar">${crumbHtml}</div>

  <div class="toolbar">
    ${!isRoot ? `<a class="up-link" href="/browse?bucket=${encodeURIComponent(bucket)}&prefix=${encodeURIComponent(parentPrefix)}">↑ Up a level</a>` : ''}
    <span class="count">${folderRows.length} folder${folderRows.length !== 1 ? 's' : ''} &nbsp;·&nbsp; ${files.length} object${files.length !== 1 ? 's' : ''}</span>
  </div>

  <div class="table-wrap">
    <div class="table-card">
      <table>
        <thead>
          <tr>
            <th></th>
            <th class="sortable" data-col="name" onclick="sortBy('name')">
              Name <span class="sort-icon" id="icon-name"></span>
            </th>
            <th class="sortable" data-col="type" onclick="sortBy('type')">
              Type <span class="sort-icon" id="icon-type"></span>
            </th>
            <th class="sortable" data-col="count" onclick="sortBy('count')" style="text-align:right">
              Objects <span class="sort-icon" id="icon-count"></span>
            </th>
            <th class="sortable" data-col="size" onclick="sortBy('size')" style="text-align:right">
              Size <span class="sort-icon" id="icon-size"></span>
            </th>
            <th class="sortable" data-col="date" onclick="sortBy('date')">
              Last Modified <span class="sort-icon" id="icon-date"></span>
            </th>
          </tr>
        </thead>
        <tbody>
          ${folderHtml}
          ${fileHtml}
          ${emptyHtml}
        </tbody>
      </table>
    </div>
  </div>

  <!-- Image Modal -->
  <div class="modal-overlay" id="modal" onclick="handleOverlayClick(event)">
    <div class="modal">
      <div class="modal-header">
        <span class="modal-title" id="modal-title"></span>
        <button class="modal-close" onclick="closeModal()">✕</button>
      </div>
      <div class="modal-body" id="modal-body">
        <div class="modal-loader"><div class="spinner"></div>Loading…</div>
      </div>
      <div class="modal-footer">
        <span class="modal-meta" id="modal-meta"></span>
        <a class="open-btn" id="modal-open" href="#" target="_blank">↗ Open original</a>
      </div>
    </div>
  </div>

  <script>
    const currentBucket = ${JSON.stringify(bucket)};

    function changeBucket(e) {
      e.preventDefault();
      const name = document.getElementById('bucket-input').value.trim();
      if (name) window.location.href = '/browse?bucket=' + encodeURIComponent(name);
    }

    // ── Sorting ──────────────────────────────────────────────────────────────
    let sortCol = 'name', sortAsc = true;

    function sortBy(col) {
      if (sortCol === col) { sortAsc = !sortAsc; }
      else { sortCol = col; sortAsc = true; }
      applySort();
      updateSortUI();
    }

    function applySort() {
      const tbody = document.querySelector('tbody');
      const rows  = Array.from(tbody.querySelectorAll('tr.row'));
      rows.sort((a, b) => {
        let va = a.dataset[sortCol] ?? '';
        let vb = b.dataset[sortCol] ?? '';
        let cmp = 0;
        if (sortCol === 'size' || sortCol === 'count' || sortCol === 'date') {
          const na = sortCol === 'date' ? (va ? new Date(va).getTime() : -Infinity) : parseFloat(va);
          const nb = sortCol === 'date' ? (vb ? new Date(vb).getTime() : -Infinity) : parseFloat(vb);
          cmp = na - nb;
        } else {
          cmp = va.localeCompare(vb, undefined, { sensitivity: 'base', numeric: true });
        }
        return sortAsc ? cmp : -cmp;
      });
      rows.forEach(r => tbody.appendChild(r));
    }

    function updateSortUI() {
      document.querySelectorAll('thead th.sortable').forEach(th => {
        const col  = th.dataset.col;
        const icon = document.getElementById('icon-' + col);
        th.classList.toggle('sort-active', col === sortCol);
        icon.textContent = col === sortCol ? (sortAsc ? '↑' : '↓') : '↕';
        icon.style.opacity = col === sortCol ? '1' : '0.3';
      });
    }

    // Init default sort indicators on load
    updateSortUI();

    // ── Image modal ──────────────────────────────────────────────────────────
    function openImage(key, name, size) {
      const modal = document.getElementById('modal');
      const body  = document.getElementById('modal-body');
      document.getElementById('modal-title').textContent = name;
      document.getElementById('modal-meta').textContent  = size ? 'Size: ' + size : '';
      document.getElementById('modal-open').href = '/image?bucket=' + encodeURIComponent(currentBucket) + '&key=' + encodeURIComponent(key);
      body.innerHTML = '<div class="modal-loader"><div class="spinner"></div>Loading image\u2026</div>';
      modal.classList.add('open');
      document.body.style.overflow = 'hidden';

      const img = new Image();
      img.onload = () => {
        body.innerHTML = '';
        body.appendChild(img);
        document.getElementById('modal-meta').textContent =
          (size ? size + '  \u00b7  ' : '') + img.naturalWidth + ' \u00d7 ' + img.naturalHeight + ' px';
      };
      img.onerror = () => {
        body.innerHTML = '<p class="modal-error">Could not load image.<br>Verify your IAM role has <code>s3:GetObject</code> on this key.</p>';
      };
      img.src = '/image?bucket=' + encodeURIComponent(currentBucket) + '&key=' + encodeURIComponent(key);
    }

    function closeModal() {
      document.getElementById('modal').classList.remove('open');
      document.body.style.overflow = '';
    }

    function handleOverlayClick(e) {
      if (e.target === document.getElementById('modal')) closeModal();
    }

    document.addEventListener('keydown', e => { if (e.key === 'Escape') closeModal(); });
  </script>
</body>
</html>`;
}

function renderLanding() {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1.0"/>
  <title>S3 Browser</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet">
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    :root { --accent: #2563EB; --border: #E2E8F0; --text: #0F172A; --text2: #475569; --muted: #94A3B8; --font: 'Inter', system-ui, sans-serif; --mono: 'JetBrains Mono', monospace; }
    body { font-family: var(--font); background: #F1F5F9; min-height: 100vh; display: flex; align-items: center; justify-content: center; padding: 24px; }
    .card { background: #fff; border: 1px solid var(--border); border-radius: 14px; padding: 40px 48px; max-width: 460px; width: 100%; box-shadow: 0 4px 24px rgba(15,23,42,0.08); }
    .logo { display: flex; align-items: center; gap: 10px; margin-bottom: 28px; }
    .logo-icon { width: 36px; height: 36px; background: #FF9900; border-radius: 9px; display: flex; align-items: center; justify-content: center; flex-shrink: 0; }
    .logo-text { font-size: 18px; font-weight: 600; color: var(--text); letter-spacing: -0.01em; }
    h1 { font-size: 22px; font-weight: 600; color: var(--text); margin-bottom: 6px; letter-spacing: -0.02em; }
    .sub { font-size: 14px; color: var(--text2); margin-bottom: 28px; line-height: 1.5; }
    label { display: block; font-size: 12px; font-weight: 600; color: var(--text2); letter-spacing: 0.04em; text-transform: uppercase; margin-bottom: 6px; }
    .input-row { display: flex; gap: 0; }
    input { font-family: var(--mono); font-size: 14px; color: var(--text); background: #F8FAFC; border: 1px solid var(--border); border-right: none; border-radius: 8px 0 0 8px; padding: 10px 14px; flex: 1; outline: none; transition: border-color 0.12s, background 0.12s; }
    input:focus { border-color: var(--accent); background: #fff; }
    button { font-family: var(--font); font-size: 14px; font-weight: 500; color: #fff; background: var(--accent); border: 1px solid var(--accent); border-radius: 0 8px 8px 0; padding: 10px 20px; cursor: pointer; transition: background 0.12s; white-space: nowrap; }
    button:hover { background: #1D4ED8; }
    .hint { margin-top: 14px; font-size: 12px; color: var(--muted); line-height: 1.6; }
    .hint code { font-family: var(--mono); background: #F1F5F9; padding: 1px 5px; border-radius: 4px; font-size: 11px; }
  </style>
</head>
<body>
  <div class="card">
    <div class="logo">
      <div class="logo-icon">
        <svg width="20" height="20" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
          <path d="M8 1L15 4.5V11.5L8 15L1 11.5V4.5L8 1Z" fill="white" fill-opacity="0.9"/>
        </svg>
      </div>
      <span class="logo-text">S3 Browser</span>
    </div>
    <h1>Browse a bucket</h1>
    <p class="sub">Enter an S3 bucket name to explore its contents. Make sure your AWS credentials have <code style="font-family:monospace;font-size:12px;background:#F1F5F9;padding:1px 4px;border-radius:3px">s3:ListBucket</code> access.</p>
    <form onsubmit="go(event)">
      <label for="bucket">Bucket name</label>
      <div class="input-row">
        <input id="bucket" type="text" placeholder="my-bucket-name" autocomplete="off" spellcheck="false" autofocus/>
        <button type="submit">Browse →</button>
      </div>
    </form>
    <p class="hint">AWS region is read from the <code>AWS_REGION</code> environment variable (default: <code>us-east-1</code>).</p>
  </div>
  <script>
    function go(e) {
      e.preventDefault();
      const name = document.getElementById('bucket').value.trim();
      if (name) window.location.href = '/browse?bucket=' + encodeURIComponent(name);
    }
  </script>
</body>
</html>`;
}

function renderError(err, bucket='') {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8"/>
  <title>Error — S3 Browser</title>
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500&display=swap" rel="stylesheet">
  <style>
    body { font-family: 'Inter', sans-serif; background: #F1F5F9; display: flex; align-items: center; justify-content: center; min-height: 100vh; margin: 0; }
    .card { background: #fff; border: 1px solid #E2E8F0; border-radius: 12px; padding: 32px 40px; max-width: 520px; box-shadow: 0 4px 12px rgba(0,0,0,0.06); }
    h2 { color: #DC2626; font-size: 18px; margin-bottom: 12px; }
    pre { background: #FEF2F2; border: 1px solid #FECACA; border-radius: 8px; padding: 14px; font-size: 13px; color: #991B1B; white-space: pre-wrap; word-break: break-all; margin-bottom: 0; }
    p { margin-top: 16px; font-size: 13px; color: #64748B; }
    code { background: #F1F5F9; padding: 1px 5px; border-radius: 4px; font-size: 12px; }
  </style>
</head>
<body>
  <div class="card">
    <h2>S3 Error</h2>
    <pre>${esc(err.message)}</pre>
    <p>Check your <code>AWS_REGION</code> env var and confirm the bucket exists and your credentials have <code>s3:ListBucket</code>.</p>
    ${bucket ? `<p style='margin-top:10px'><a href='/browse?bucket=\${encodeURIComponent(bucket)}' style='color:#2563EB;font-size:13px'>← Try again</a> &nbsp;·&nbsp; <a href='/' style='color:#2563EB;font-size:13px'>Change bucket</a></p>` : `<p style='margin-top:10px'><a href='/' style='color:#2563EB;font-size:13px'>← Back</a></p>`}
  </div>
</body>
</html>`;
}

// ─── Start ───────────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`S3 Browser running → http://localhost:${PORT}`);
  console.log(`Region: ${REGION} | Bucket supplied per request`);
});
