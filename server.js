import express from 'express';
import { S3Client, ListObjectsV2Command, GetObjectCommand } from '@aws-sdk/client-s3';

// ─── Config ───────────────────────────────────────────────────────────────────
const REGION = process.env.AWS_REGION || 'us-east-1';
const PORT   = process.env.PORT || 3000;

const s3  = new S3Client({ region: REGION });
const app = express();

const IMAGE_EXTS = new Set(['jpg','jpeg','png','gif','webp','svg','bmp','tiff','tif','avif','ico']);
const isImage = key => IMAGE_EXTS.has(key.split('.').pop()?.toLowerCase());

// ─── S3 Helpers ───────────────────────────────────────────────────────────────

async function listPrefix(bucket, prefix = '') {
  const folders = [], files = [];
  let token;
  do {
    const res = await s3.send(new ListObjectsV2Command({
      Bucket: bucket, Prefix: prefix, Delimiter: '/', ContinuationToken: token,
    }));
    for (const cp of res.CommonPrefixes ?? []) folders.push(cp.Prefix);
    for (const obj of res.Contents ?? [])
      if (obj.Key !== prefix)
        files.push({ key: obj.Key, lastModified: obj.LastModified, size: obj.Size });
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

// ─── Routes ───────────────────────────────────────────────────────────────────

app.get('/', (req, res) => res.send(renderLanding()));

// Main browser shell — just serves the HTML, data loaded via /api/list
app.get('/browse', (req, res) => {
  const bucket = (req.query.bucket ?? '').trim();
  if (!bucket) return res.redirect('/');
  res.send(renderApp(bucket));
});

// JSON API — called by the client to populate both panes
app.get('/api/list', async (req, res) => {
  const bucket = (req.query.bucket ?? '').trim();
  const prefix = req.query.prefix ?? '';
  if (!bucket) return res.status(400).json({ error: 'bucket required' });
  try {
    const { folders, files } = await listPrefix(bucket, prefix);
    const folderData = await Promise.all(
      folders.map(async f => {
        const { latest, count } = await scanFolder(bucket, f);
        return { prefix: f, name: f.slice(prefix.length), latestModified: latest?.toISOString() ?? null, count };
      })
    );
    res.json({ folders: folderData, files: files.map(f => ({
      ...f,
      lastModified: f.lastModified?.toISOString() ?? null,
    }))});
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Image preview proxy
app.get('/image', async (req, res) => {
  const { bucket, key } = req.query;
  if (!bucket || !key || !isImage(key)) return res.status(400).send('Bad request');
  try {
    const result = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
    res.setHeader('Content-Type', result.ContentType || 'application/octet-stream');
    if (result.ContentLength) res.setHeader('Content-Length', result.ContentLength);
    result.Body.pipe(res);
  } catch (err) { res.status(500).send(err.message); }
});

// Download — forces browser Save As dialog
app.get('/download', async (req, res) => {
  const { bucket, key } = req.query;
  if (!bucket || !key) return res.status(400).send('Bad request');
  try {
    const result = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
    const filename = key.split('/').pop();
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Content-Type', result.ContentType || 'application/octet-stream');
    if (result.ContentLength) res.setHeader('Content-Length', result.ContentLength);
    result.Body.pipe(res);
  } catch (err) { res.status(500).send(err.message); }
});

// ─── Helpers ──────────────────────────────────────────────────────────────────

const esc = str => String(str ?? '')
  .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');

// ─── Landing page ─────────────────────────────────────────────────────────────

function renderLanding() {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8"/><meta name="viewport" content="width=device-width, initial-scale=1.0"/>
  <title>S3 Browser</title>
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet">
  <style>
    *,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
    :root{--accent:#2563EB;--border:#E2E8F0;--text:#0F172A;--text2:#475569;--muted:#94A3B8;--font:'Inter',system-ui,sans-serif;--mono:'JetBrains Mono',monospace}
    body{font-family:var(--font);background:#F1F5F9;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px}
    .card{background:#fff;border:1px solid var(--border);border-radius:14px;padding:40px 48px;max-width:460px;width:100%;box-shadow:0 4px 24px rgba(15,23,42,.08)}
    .logo{display:flex;align-items:center;gap:10px;margin-bottom:28px}
    .logo-icon{width:36px;height:36px;background:#FF9900;border-radius:9px;display:flex;align-items:center;justify-content:center;flex-shrink:0}
    .logo-text{font-size:18px;font-weight:600;color:var(--text);letter-spacing:-.01em}
    h1{font-size:22px;font-weight:600;color:var(--text);margin-bottom:6px;letter-spacing:-.02em}
    .sub{font-size:14px;color:var(--text2);margin-bottom:28px;line-height:1.6}
    label{display:block;font-size:12px;font-weight:600;color:var(--text2);letter-spacing:.04em;text-transform:uppercase;margin-bottom:6px}
    .row{display:flex}
    input{font-family:var(--mono);font-size:14px;color:var(--text);background:#F8FAFC;border:1px solid var(--border);border-right:none;border-radius:8px 0 0 8px;padding:10px 14px;flex:1;outline:none;transition:border-color .12s,background .12s}
    input:focus{border-color:var(--accent);background:#fff}
    button{font-family:var(--font);font-size:14px;font-weight:500;color:#fff;background:var(--accent);border:1px solid var(--accent);border-radius:0 8px 8px 0;padding:10px 20px;cursor:pointer;transition:background .12s;white-space:nowrap}
    button:hover{background:#1D4ED8}
    .hint{margin-top:14px;font-size:12px;color:var(--muted);line-height:1.6}
    code{font-family:var(--mono);background:#F1F5F9;padding:1px 5px;border-radius:4px;font-size:11px}
  </style>
</head>
<body>
  <div class="card">
    <div class="logo">
      <div class="logo-icon"><svg width="20" height="20" viewBox="0 0 16 16" fill="none"><path d="M8 1L15 4.5V11.5L8 15L1 11.5V4.5L8 1Z" fill="white" fill-opacity=".9"/></svg></div>
      <span class="logo-text">S3 Browser</span>
    </div>
    <h1>Browse a bucket</h1>
    <p class="sub">Enter an S3 bucket name to explore its contents. Credentials are read from your environment.</p>
    <form onsubmit="go(event)">
      <label for="b">Bucket name</label>
      <div class="row">
        <input id="b" type="text" placeholder="my-bucket-name" autocomplete="off" spellcheck="false" autofocus/>
        <button type="submit">Browse →</button>
      </div>
    </form>
    <p class="hint">Region: <code>AWS_REGION</code> env var (default: <code>us-east-1</code>). Needs <code>s3:ListBucket</code> + <code>s3:GetObject</code>.</p>
  </div>
  <script>function go(e){e.preventDefault();const v=document.getElementById('b').value.trim();if(v)location.href='/browse?bucket='+encodeURIComponent(v);}</script>
</body></html>`;
}

// ─── Main app shell ───────────────────────────────────────────────────────────

function renderApp(bucket) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8"/><meta name="viewport" content="width=device-width, initial-scale=1.0"/>
  <title>S3 Browser — ${esc(bucket)}</title>
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet">
  <style>
    *,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
    :root{
      --bg:#F1F5F9;--surface:#fff;--border:#E2E8F0;--border2:#CBD5E1;
      --text:#0F172A;--text2:#475569;--muted:#94A3B8;
      --accent:#2563EB;--accent-bg:#EFF6FF;
      --hover:#F8FBFF;--active:#EFF6FF;
      --shadow-sm:0 1px 2px rgba(15,23,42,.06);
      --shadow-md:0 8px 24px rgba(15,23,42,.10);
      --font:'Inter',system-ui,sans-serif;--mono:'JetBrains Mono',monospace;
    }
    html,body{height:100%;overflow:hidden}
    body{font-family:var(--font);background:var(--bg);color:var(--text);font-size:14px;display:flex;flex-direction:column}

    /* ── Header ── */
    .header{background:var(--surface);border-bottom:1px solid var(--border);height:52px;display:flex;align-items:center;padding:0 20px;gap:14px;box-shadow:var(--shadow-sm);flex-shrink:0;z-index:10}
    .logo{display:flex;align-items:center;gap:8px;font-size:15px;font-weight:600;color:var(--text);text-decoration:none;letter-spacing:-.01em;white-space:nowrap}
    .logo-icon{width:28px;height:28px;background:#FF9900;border-radius:6px;display:flex;align-items:center;justify-content:center;flex-shrink:0}
    .divider{width:1px;height:20px;background:var(--border);flex-shrink:0}
    .bucket-form{display:flex;align-items:center;gap:0}
    .bucket-input{font-family:var(--mono);font-size:12px;color:var(--text);background:var(--bg);border:1px solid var(--border);border-right:none;border-radius:6px 0 0 6px;padding:4px 10px;width:220px;outline:none;transition:border-color .12s}
    .bucket-input:focus{border-color:var(--accent);background:#fff}
    .bucket-btn{font-size:12px;font-weight:500;color:#fff;background:var(--accent);border:1px solid var(--accent);border-radius:0 6px 6px 0;padding:4px 12px;cursor:pointer;transition:background .12s;white-space:nowrap}
    .bucket-btn:hover{background:#1D4ED8}
    .note{margin-left:auto;font-size:11px;color:#92400E;background:#FFFBEB;border:1px solid #FDE68A;border-radius:6px;padding:2px 8px;white-space:nowrap}

    /* ── Two-pane layout ── */
    .panes{display:flex;flex:1;overflow:hidden;min-height:0}

    /* ── Left pane — folder tree ── */
    .left-pane{width:280px;min-width:200px;max-width:400px;background:var(--surface);border-right:1px solid var(--border);display:flex;flex-direction:column;flex-shrink:0;overflow:hidden}
    .resize-handle{width:4px;background:transparent;cursor:col-resize;flex-shrink:0;transition:background .15s;position:relative;z-index:5}
    .resize-handle:hover,.resize-handle.dragging{background:var(--accent)}
    .pane-header{padding:10px 14px;border-bottom:1px solid var(--border);font-size:11px;font-weight:600;color:var(--muted);letter-spacing:.06em;text-transform:uppercase;flex-shrink:0;background:#F8FAFC}
    .tree{overflow-y:auto;flex:1;padding:6px 0}
    .tree-item{display:flex;align-items:center;gap:0;cursor:pointer;user-select:none;padding:0;position:relative}
    .tree-item:hover>.tree-row{background:var(--hover)}
    .tree-item.selected>.tree-row{background:var(--active);color:var(--accent)}
    .tree-row{display:flex;align-items:center;gap:6px;padding:6px 10px;width:100%;border-radius:0;transition:background .1s}
    .tree-toggle{width:16px;height:16px;display:flex;align-items:center;justify-content:center;flex-shrink:0;font-size:9px;color:var(--muted);transition:transform .15s}
    .tree-toggle.open{transform:rotate(90deg)}
    .tree-toggle.leaf{opacity:0;pointer-events:none}
    .tree-name{font-size:13px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;flex:1}
    .tree-children{display:none}
    .tree-children.open{display:block}
    .tree-loader{padding:4px 10px 4px 32px;font-size:11px;color:var(--muted)}

    /* ── Right pane — contents ── */
    .right-pane{flex:1;display:flex;flex-direction:column;overflow:hidden;min-width:0}
    .right-header{padding:10px 20px;border-bottom:1px solid var(--border);display:flex;align-items:center;gap:8px;flex-shrink:0;background:#F8FAFC;min-height:41px}
    .breadcrumb{display:flex;align-items:center;flex-wrap:wrap;font-family:var(--mono);font-size:12px;gap:0;flex:1;min-width:0}
    .crumb{color:var(--muted);cursor:pointer;text-decoration:none;transition:color .12s;white-space:nowrap}
    .crumb:hover{color:var(--accent)}
    .crumb.active{color:var(--text);font-weight:500}
    .sep{color:var(--border2);margin:0 4px}
    .right-count{font-family:var(--mono);font-size:11px;color:var(--muted);white-space:nowrap;flex-shrink:0}

    /* Sort controls bar */
    .sort-bar{padding:0;background:#F8FAFC;border-bottom:1px solid var(--border);flex-shrink:0}
    .sort-bar table{width:100%;border-collapse:collapse}
    .sort-bar th{text-align:left;font-size:11px;font-weight:600;letter-spacing:.05em;text-transform:uppercase;color:var(--muted);padding:8px 12px;cursor:pointer;user-select:none;white-space:nowrap;transition:color .12s,background .12s}
    .sort-bar th:hover{color:var(--text2);background:#F1F5F9}
    .sort-bar th.sort-active{color:var(--accent);background:var(--accent-bg)}
    .sort-icon{margin-left:3px;opacity:.4;font-size:10px}
    th.sort-active .sort-icon{opacity:1}

    /* File list */
    .file-list{overflow-y:auto;flex:1}
    .file-list table{width:100%;border-collapse:collapse}
    .file-row{border-bottom:1px solid var(--border);transition:background .1s}
    .file-row:last-child{border-bottom:none}
    .file-row:hover{background:var(--hover)}
    td{padding:9px 12px;vertical-align:middle}
    .icon-td{width:32px}
    .name-td{min-width:180px}
    .type-td{width:80px}
    .count-td{width:80px;font-family:var(--mono);font-size:12px;color:var(--text2);text-align:right}
    .size-td{width:80px;font-family:var(--mono);font-size:12px;color:var(--muted);text-align:right}
    .date-td{font-family:var(--mono);font-size:12px;color:var(--text2);white-space:nowrap}
    .actions-td{width:110px;text-align:right;white-space:nowrap}
    .pill{font-size:11px;font-weight:500;border-radius:5px;padding:2px 8px;display:inline-block}
    .folder-pill{background:#FFFBEB;color:#B45309;border:1px solid #FDE68A}
    .image-pill{background:#EFF6FF;color:#1D4ED8;border:1px solid #BFDBFE}
    .file-pill{background:#F8FAFC;color:#64748B;border:1px solid #E2E8F0}
    .name-link{font-size:13px;font-weight:500;color:var(--text);text-decoration:none;cursor:pointer;background:none;border:none;padding:0;font-family:var(--font);text-align:left;transition:color .12s}
    .name-link:hover{color:var(--accent)}
    .name-link.is-image{color:var(--accent)}
    .date-note{font-size:10px;color:var(--muted);margin-left:3px}
    .na{color:var(--muted)}

    /* Action buttons */
    .btn{display:inline-flex;align-items:center;gap:4px;font-size:11px;font-weight:500;border-radius:5px;padding:3px 9px;cursor:pointer;text-decoration:none;transition:all .12s;border:1px solid}
    .btn-preview{color:var(--accent);background:var(--accent-bg);border-color:#BFDBFE}
    .btn-preview:hover{background:#DBEAFE}
    .btn-download{color:#16A34A;background:#F0FDF4;border-color:#BBF7D0}
    .btn-download:hover{background:#DCFCE7}
    .btn-enter{color:var(--text2);background:#F8FAFC;border-color:var(--border)}
    .btn-enter:hover{color:var(--accent);border-color:var(--accent);background:var(--accent-bg)}

    /* Empty / loading states */
    .state-box{display:flex;flex-direction:column;align-items:center;justify-content:center;flex:1;gap:10px;color:var(--muted);font-size:13px;padding:48px}
    .spinner{width:24px;height:24px;border:2px solid var(--border);border-top-color:var(--accent);border-radius:50%;animation:spin .7s linear infinite}
    @keyframes spin{to{transform:rotate(360deg)}}

    /* Image modal */
    .modal-overlay{display:none;position:fixed;inset:0;background:rgba(15,23,42,.55);backdrop-filter:blur(4px);z-index:100;align-items:center;justify-content:center;padding:24px}
    .modal-overlay.open{display:flex;animation:fadeIn .15s ease}
    @keyframes fadeIn{from{opacity:0}to{opacity:1}}
    .modal{background:var(--surface);border-radius:12px;box-shadow:var(--shadow-md);max-width:min(920px,95vw);width:100%;max-height:90vh;display:flex;flex-direction:column;overflow:hidden;animation:slideUp .18s ease}
    @keyframes slideUp{from{transform:translateY(10px);opacity:0}to{transform:translateY(0);opacity:1}}
    .modal-header{display:flex;align-items:center;gap:10px;padding:12px 16px;border-bottom:1px solid var(--border);flex-shrink:0}
    .modal-title{font-family:var(--mono);font-size:13px;color:var(--text);font-weight:500;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
    .modal-close{width:26px;height:26px;border-radius:5px;border:1px solid var(--border);background:transparent;cursor:pointer;display:flex;align-items:center;justify-content:center;color:var(--muted);font-size:13px;flex-shrink:0;transition:all .12s}
    .modal-close:hover{background:var(--bg);color:var(--text)}
    .modal-body{overflow:auto;display:flex;align-items:center;justify-content:center;padding:28px;background:#F8FAFC;flex:1;min-height:0}
    .modal-body img{max-width:100%;max-height:60vh;object-fit:contain;border-radius:6px;box-shadow:0 4px 16px rgba(0,0,0,.1);display:block}
    .modal-loader{color:var(--muted);font-size:13px;display:flex;flex-direction:column;align-items:center;gap:12px}
    .modal-error{color:#DC2626;font-size:13px;text-align:center;line-height:1.7}
    .modal-footer{padding:10px 16px;border-top:1px solid var(--border);display:flex;align-items:center;justify-content:space-between;flex-shrink:0;gap:8px}
    .modal-meta{font-family:var(--mono);font-size:11px;color:var(--muted)}
    .modal-actions{display:flex;gap:8px}
  </style>
</head>
<body>

  <!-- Header -->
  <div class="header">
    <a class="logo" href="/">
      <div class="logo-icon"><svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M8 1L15 4.5V11.5L8 15L1 11.5V4.5L8 1Z" fill="white" fill-opacity=".9"/></svg></div>
      S3 Browser
    </a>
    <div class="divider"></div>
    <form class="bucket-form" onsubmit="changeBucket(event)">
      <input class="bucket-input" id="bucket-input" type="text" value="${esc(bucket)}"
        placeholder="bucket name…" autocomplete="off" spellcheck="false"/>
      <button class="bucket-btn" type="submit">Browse →</button>
    </form>
    <span class="note">⚠ Dates = LastModified — S3 has no native last-access tracking</span>
  </div>

  <!-- Two-pane -->
  <div class="panes" id="panes">

    <!-- Left: folder tree -->
    <div class="left-pane" id="left-pane">
      <div class="pane-header">Folders</div>
      <div class="tree" id="tree">
        <div class="state-box"><div class="spinner"></div>Loading…</div>
      </div>
    </div>

    <div class="resize-handle" id="resize-handle"></div>

    <!-- Right: file contents -->
    <div class="right-pane" id="right-pane">
      <div class="right-header">
        <div class="breadcrumb" id="breadcrumb"></div>
        <span class="right-count" id="right-count"></span>
      </div>
      <div class="sort-bar">
        <table><thead><tr>
          <th style="width:32px"></th>
          <th onclick="sortBy('name')">Name <span class="sort-icon" id="si-name">↕</span></th>
          <th onclick="sortBy('type')" style="width:80px">Type <span class="sort-icon" id="si-type">↕</span></th>
          <th onclick="sortBy('count')" style="width:80px;text-align:right">Objects <span class="sort-icon" id="si-count">↕</span></th>
          <th onclick="sortBy('size')" style="width:80px;text-align:right">Size <span class="sort-icon" id="si-size">↕</span></th>
          <th onclick="sortBy('date')">Last Modified <span class="sort-icon" id="si-date">↕</span></th>
          <th style="width:110px;text-align:right">Actions</th>
        </tr></thead></table>
      </div>
      <div class="file-list" id="file-list">
        <div class="state-box">Select a folder on the left to browse its contents.</div>
      </div>
    </div>
  </div>

  <!-- Image modal -->
  <div class="modal-overlay" id="modal" onclick="if(event.target===this)closeModal()">
    <div class="modal">
      <div class="modal-header">
        <span class="modal-title" id="modal-title"></span>
        <button class="modal-close" onclick="closeModal()">✕</button>
      </div>
      <div class="modal-body" id="modal-body"></div>
      <div class="modal-footer">
        <span class="modal-meta" id="modal-meta"></span>
        <div class="modal-actions">
          <a class="btn btn-download" id="modal-download" href="#">↓ Download</a>
          <a class="btn btn-preview" id="modal-open" href="#" target="_blank">↗ Open</a>
        </div>
      </div>
    </div>
  </div>

<script>
// ── State ──────────────────────────────────────────────────────────────────
const BUCKET = ${JSON.stringify(bucket)};
let currentPrefix = '';
let allRows = [];         // raw data for current right pane
let sortCol = 'name', sortAsc = true;

// ── Bucket switch ──────────────────────────────────────────────────────────
function changeBucket(e) {
  e.preventDefault();
  const v = document.getElementById('bucket-input').value.trim();
  if (v) location.href = '/browse?bucket=' + encodeURIComponent(v);
}

// ── API call ───────────────────────────────────────────────────────────────
async function apiList(prefix) {
  const url = '/api/list?bucket=' + encodeURIComponent(BUCKET) + '&prefix=' + encodeURIComponent(prefix);
  const res = await fetch(url);
  if (!res.ok) throw new Error((await res.json()).error || res.statusText);
  return res.json();
}

// ── Left pane: folder tree ─────────────────────────────────────────────────
async function initTree() {
  const tree = document.getElementById('tree');
  tree.innerHTML = '<div class="state-box"><div class="spinner"></div>Loading…</div>';
  try {
    const { folders } = await apiList('');
    if (folders.length === 0) {
      tree.innerHTML = '<div class="state-box">No folders found at root.</div>';
      // Still load root files into right pane
      loadFolder('');
      return;
    }
    tree.innerHTML = '';
    // Root-level "bucket root" entry
    const rootItem = makeTreeItem({ name: '/ (root)', prefix: '', isRoot: true }, 0);
    tree.appendChild(rootItem);
    for (const f of folders) {
      tree.appendChild(makeTreeItem(f, 0));
    }
  } catch (err) {
    tree.innerHTML = '<div class="state-box" style="color:#DC2626">' + esc(err.message) + '</div>';
  }
}

function makeTreeItem(folder, depth) {
  const item = document.createElement('div');
  item.className = 'tree-item';
  item.dataset.prefix = folder.prefix;

  const row = document.createElement('div');
  row.className = 'tree-row';
  row.style.paddingLeft = (10 + depth * 16) + 'px';

  const toggle = document.createElement('span');
  toggle.className = 'tree-toggle';
  toggle.textContent = '▶';

  const folderSvg = '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" style="flex-shrink:0"><path d="M1 3.5A1.5 1.5 0 0 1 2.5 2h3.172a1.5 1.5 0 0 1 1.06.44l.829.828A1.5 1.5 0 0 0 8.62 3.75H13.5A1.5 1.5 0 0 1 15 5.25v7.25A1.5 1.5 0 0 1 13.5 14h-11A1.5 1.5 0 0 1 1 12.5v-9Z" fill="#FEF3C7" stroke="#D97706" stroke-width="1"/></svg>';

  const name = document.createElement('span');
  name.className = 'tree-name';
  name.textContent = folder.name || folder.prefix;

  row.innerHTML = '';
  row.appendChild(toggle);
  row.insertAdjacentHTML('beforeend', folderSvg);
  row.appendChild(name);
  item.appendChild(row);

  const children = document.createElement('div');
  children.className = 'tree-children';
  item.appendChild(children);

  let loaded = false;

  row.addEventListener('click', async () => {
    // Select this item
    document.querySelectorAll('.tree-item.selected').forEach(el => el.classList.remove('selected'));
    item.classList.add('selected');

    // Load right pane
    loadFolder(folder.prefix);
    currentPrefix = folder.prefix;

    // Expand/collapse children
    const isOpen = children.classList.contains('open');
    if (isOpen) {
      children.classList.remove('open');
      toggle.classList.remove('open');
    } else {
      children.classList.add('open');
      toggle.classList.add('open');
      if (!loaded) {
        loaded = true;
        children.innerHTML = '<div class="tree-loader">Loading…</div>';
        try {
          const { folders: sub } = await apiList(folder.prefix);
          children.innerHTML = '';
          if (sub.length === 0) {
            toggle.classList.add('leaf');
          } else {
            for (const sf of sub) {
              children.appendChild(makeTreeItem(sf, depth + 1));
            }
          }
        } catch (err) {
          children.innerHTML = '<div class="tree-loader" style="color:#DC2626">' + esc(err.message) + '</div>';
        }
      }
    }
  });

  return item;
}

// ── Right pane: file list ──────────────────────────────────────────────────
async function loadFolder(prefix) {
  currentPrefix = prefix;
  renderBreadcrumb(prefix);
  const listEl = document.getElementById('file-list');
  listEl.innerHTML = '<div class="state-box"><div class="spinner"></div>Loading…</div>';
  document.getElementById('right-count').textContent = '';
  try {
    const { folders, files } = await apiList(prefix);
    allRows = [
      ...folders.map(f => ({ ...f, _type: 'folder' })),
      ...files.map(f => ({ ...f, _type: isImg(f.key) ? 'image' : 'file' })),
    ];
    renderTable();
  } catch (err) {
    listEl.innerHTML = '<div class="state-box" style="color:#DC2626">' + esc(err.message) + '</div>';
  }
}

function isImg(key) {
  const ext = (key.split('.').pop() || '').toLowerCase();
  return ['jpg','jpeg','png','gif','webp','svg','bmp','tiff','tif','avif','ico'].includes(ext);
}

function renderTable() {
  const sorted = [...allRows].sort((a, b) => {
    let va, vb;
    if (sortCol === 'name')  { va = (a.name || a.key || '').toLowerCase(); vb = (b.name || b.key || '').toLowerCase(); }
    else if (sortCol === 'type')  { va = a._type; vb = b._type; }
    else if (sortCol === 'count') { va = a.count ?? -1; vb = b.count ?? -1; }
    else if (sortCol === 'size')  { va = a.size ?? -1; vb = b.size ?? -1; }
    else if (sortCol === 'date')  {
      va = a.latestModified || a.lastModified ? new Date(a.latestModified || a.lastModified).getTime() : -Infinity;
      vb = b.latestModified || b.lastModified ? new Date(b.latestModified || b.lastModified).getTime() : -Infinity;
    }
    let cmp = typeof va === 'string' ? va.localeCompare(vb, undefined, { numeric: true }) : va - vb;
    return sortAsc ? cmp : -cmp;
  });

  const folders = sorted.filter(r => r._type === 'folder');
  const files   = sorted.filter(r => r._type !== 'folder');

  const listEl = document.getElementById('file-list');
  if (sorted.length === 0) {
    listEl.innerHTML = '<div class="state-box">This folder is empty.</div>';
    document.getElementById('right-count').textContent = '0 items';
    return;
  }

  document.getElementById('right-count').textContent =
    folders.length + ' folder' + (folders.length !== 1 ? 's' : '') +
    ' · ' + files.length + ' object' + (files.length !== 1 ? 's' : '');

  const tbody = document.createElement('tbody');

  for (const f of folders) {
    const tr = document.createElement('tr');
    tr.className = 'file-row';
    tr.innerHTML = \`
      <td class="icon-td"><svg width="14" height="14" viewBox="0 0 16 16" fill="none"><path d="M1 3.5A1.5 1.5 0 0 1 2.5 2h3.172a1.5 1.5 0 0 1 1.06.44l.829.828A1.5 1.5 0 0 0 8.62 3.75H13.5A1.5 1.5 0 0 1 15 5.25v7.25A1.5 1.5 0 0 1 13.5 14h-11A1.5 1.5 0 0 1 1 12.5v-9Z" fill="#FEF3C7" stroke="#D97706" stroke-width="1"/></svg></td>
      <td class="name-td"><button class="name-link" onclick="drillInto(\${esc(JSON.stringify(f.prefix))},\${esc(JSON.stringify(f.name))})">\${esc(f.name)}</button></td>
      <td class="type-td"><span class="pill folder-pill">Folder</span></td>
      <td class="count-td">\${f.count != null ? f.count.toLocaleString() : '—'}</td>
      <td class="size-td">—</td>
      <td class="date-td">\${fmtDate(f.latestModified)}<span class="date-note">latest</span></td>
      <td class="actions-td"><button class="btn btn-enter" onclick="drillInto(\${esc(JSON.stringify(f.prefix))},\${esc(JSON.stringify(f.name))})">Open →</button></td>
    \`;
    tbody.appendChild(tr);
  }

  for (const f of files) {
    const name = f.key.split('/').pop();
    const img  = f._type === 'image';
    const tr = document.createElement('tr');
    tr.className = 'file-row';
    const nameCell = img
      ? \`<button class="name-link is-image" onclick="openPreview(\${esc(JSON.stringify(f.key))},\${esc(JSON.stringify(name))},\${esc(JSON.stringify(fmtSize(f.size)))})">\${esc(name)}</button>\`
      : \`<span class="name-link" style="cursor:default">\${esc(name)}</span>\`;
    const actions = img
      ? \`<a class="btn btn-preview" onclick="openPreview(\${esc(JSON.stringify(f.key))},\${esc(JSON.stringify(name))},\${esc(JSON.stringify(fmtSize(f.size)))});return false" href="#">Preview</a>
         <a class="btn btn-download" href="\${dlUrl(f.key)}">↓</a>\`
      : \`<a class="btn btn-download" href="\${dlUrl(f.key)}">↓ Download</a>\`;
    tr.innerHTML = \`
      <td class="icon-td">\${img
        ? '<svg width="14" height="14" viewBox="0 0 16 16" fill="none"><rect x="1" y="2" width="14" height="12" rx="1.5" fill="#EFF6FF" stroke="#3B82F6" stroke-width="1"/><circle cx="5" cy="6" r="1.5" fill="#93C5FD"/><path d="M1 11l3.5-3.5 2.5 2.5 2-2 5 5" stroke="#3B82F6" stroke-width="1" stroke-linecap="round"/></svg>'
        : '<svg width="14" height="14" viewBox="0 0 16 16" fill="none"><path d="M3 1.5h7l4 4V14a.5.5 0 0 1-.5.5h-10A.5.5 0 0 1 3 14V2a.5.5 0 0 1 0-.5Z" fill="#F8FAFC" stroke="#CBD5E1" stroke-width="1"/><path d="M10 1.5V5.5H14" stroke="#CBD5E1" stroke-width="1"/></svg>'
      }</td>
      <td class="name-td">\${nameCell}</td>
      <td class="type-td"><span class="pill \${img ? 'image-pill' : 'file-pill'}">\${img ? 'Image' : 'Object'}</span></td>
      <td class="count-td na">—</td>
      <td class="size-td">\${fmtSize(f.size)}</td>
      <td class="date-td">\${fmtDate(f.lastModified)}</td>
      <td class="actions-td">\${actions}</td>
    \`;
    tbody.appendChild(tr);
  }

  const table = document.createElement('table');
  table.style.width = '100%';
  table.style.borderCollapse = 'collapse';
  table.appendChild(tbody);
  listEl.innerHTML = '';
  listEl.appendChild(table);
}

// Navigate into a folder from the right pane (also selects it in the tree)
function drillInto(prefix, name) {
  loadFolder(prefix);
  // Try to select the matching tree item
  const items = document.querySelectorAll('.tree-item');
  for (const item of items) {
    if (item.dataset.prefix === prefix) {
      item.classList.add('selected');
      item.scrollIntoView({ block: 'nearest' });
    } else {
      item.classList.remove('selected');
    }
  }
}

// ── Breadcrumb ─────────────────────────────────────────────────────────────
function renderBreadcrumb(prefix) {
  const el = document.getElementById('breadcrumb');
  const parts = prefix.split('/').filter(Boolean);
  let html = \`<span class="crumb\${prefix === '' ? ' active' : ''}" onclick="loadFolder('')">\${esc(BUCKET)}</span>\`;
  let acc = '';
  parts.forEach((p, i) => {
    acc += p + '/';
    const isLast = i === parts.length - 1;
    const cap = acc;
    html += \`<span class="sep">/</span><span class="crumb\${isLast ? ' active' : ''}" onclick="loadFolder(\${esc(JSON.stringify(cap))})">\${esc(p)}</span>\`;
  });
  el.innerHTML = html;
}

// ── Sorting ────────────────────────────────────────────────────────────────
function sortBy(col) {
  if (sortCol === col) sortAsc = !sortAsc; else { sortCol = col; sortAsc = true; }
  document.querySelectorAll('.sort-bar th').forEach(th => th.classList.remove('sort-active'));
  const header = [...document.querySelectorAll('.sort-bar th')].find(th => th.onclick?.toString().includes("'" + col + "'"));
  if (header) header.classList.add('sort-active');
  ['name','type','count','size','date'].forEach(c => {
    const el = document.getElementById('si-' + c);
    if (el) el.textContent = c === sortCol ? (sortAsc ? '↑' : '↓') : '↕';
  });
  renderTable();
}

// ── Formatters ────────────────────────────────────────────────────────────
function fmtDate(d) {
  if (!d) return '<span class="na">—</span>';
  return new Intl.DateTimeFormat('en-US', { year:'numeric', month:'short', day:'2-digit', hour:'2-digit', minute:'2-digit', timeZoneName:'short' }).format(new Date(d));
}
function fmtSize(bytes) {
  if (bytes == null || bytes < 0) return '—';
  if (bytes === 0) return '0 B';
  const s = ['B','KB','MB','GB','TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return parseFloat((bytes / Math.pow(1024, i)).toFixed(1)) + '\\u00a0' + s[i];
}
function esc(str) {
  return String(str ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
function dlUrl(key) {
  return '/download?bucket=' + encodeURIComponent(BUCKET) + '&key=' + encodeURIComponent(key);
}

// ── Image preview modal ────────────────────────────────────────────────────
function openPreview(key, name, size) {
  const body = document.getElementById('modal-body');
  document.getElementById('modal-title').textContent = name;
  document.getElementById('modal-meta').textContent = size ? 'Size: ' + size : '';
  document.getElementById('modal-open').href = '/image?bucket=' + encodeURIComponent(BUCKET) + '&key=' + encodeURIComponent(key);
  document.getElementById('modal-download').href = dlUrl(key);
  body.innerHTML = '<div class="modal-loader"><div class="spinner"></div>Loading…</div>';
  document.getElementById('modal').classList.add('open');
  document.body.style.overflow = 'hidden';
  const img = new Image();
  img.onload = () => {
    body.innerHTML = '';
    body.appendChild(img);
    document.getElementById('modal-meta').textContent = (size ? size + '  ·  ' : '') + img.naturalWidth + ' × ' + img.naturalHeight + ' px';
  };
  img.onerror = () => { body.innerHTML = '<p class="modal-error">Failed to load image.<br>Check s3:GetObject permission.</p>'; };
  img.src = '/image?bucket=' + encodeURIComponent(BUCKET) + '&key=' + encodeURIComponent(key);
}
function closeModal() {
  document.getElementById('modal').classList.remove('open');
  document.body.style.overflow = '';
}
document.addEventListener('keydown', e => { if (e.key === 'Escape') closeModal(); });

// ── Resize handle ──────────────────────────────────────────────────────────
(function() {
  const handle = document.getElementById('resize-handle');
  const leftPane = document.getElementById('left-pane');
  let dragging = false, startX, startW;
  handle.addEventListener('mousedown', e => {
    dragging = true; startX = e.clientX; startW = leftPane.offsetWidth;
    handle.classList.add('dragging');
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
  });
  window.addEventListener('mousemove', e => {
    if (!dragging) return;
    const w = Math.max(160, Math.min(600, startW + e.clientX - startX));
    leftPane.style.width = w + 'px';
  });
  window.addEventListener('mouseup', () => {
    if (!dragging) return;
    dragging = false;
    handle.classList.remove('dragging');
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
  });
})();

// ── Boot ──────────────────────────────────────────────────────────────────
initTree();
renderBreadcrumb('');
</script>
</body>
</html>`;
}

// ─── Start ────────────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log("S3 Browser running on port " + PORT + "  |  Region: " + REGION);
});
