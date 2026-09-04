import express from 'express';
import { S3Client, ListObjectsV2Command, GetObjectCommand } from '@aws-sdk/client-s3';
import { CloudWatchLogsClient, FilterLogEventsCommand } from '@aws-sdk/client-cloudwatch-logs';

const REGION = process.env.AWS_REGION || 'us-east-1';
const PORT   = process.env.PORT || 3000;

const s3     = new S3Client({ region: REGION });
const cwLogs = new CloudWatchLogsClient({ region: REGION });
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
  let latest = null, earliest = null, count = 0, token;
  do {
    const res = await s3.send(new ListObjectsV2Command({
      Bucket: bucket, Prefix: prefix, ContinuationToken: token,
    }));
    for (const obj of res.Contents ?? []) {
      count++;
      if (!latest   || obj.LastModified > latest)   latest   = obj.LastModified;
      if (!earliest || obj.LastModified < earliest)  earliest = obj.LastModified;
    }
    token = res.NextContinuationToken;
  } while (token);
  return { latest, earliest, count };
}

// ─── Routes ───────────────────────────────────────────────────────────────────

app.get('/', (req, res) => res.send(renderLanding()));

app.get('/browse', (req, res) => {
  const bucket = (req.query.bucket ?? '').trim();
  if (!bucket) return res.redirect('/');
  res.send(renderApp(bucket));
});

app.get('/report', (req, res) => {
  const bucket = (req.query.bucket ?? '').trim();
  res.send(renderReport(bucket));
});

// JSON API — browse
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
      ...f, lastModified: f.lastModified?.toISOString() ?? null,
    }))});
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// JSON API — fetch source URL from CloudWatch Logs for a given S3 object timestamp
app.get('/api/chrome-url', async (req, res) => {
  const ts = req.query.ts;
  if (!ts) return res.status(400).json({ error: 'ts required' });
  const t = new Date(ts).getTime();
  if (isNaN(t)) return res.status(400).json({ error: 'invalid ts' });
  try {
    const result = await cwLogs.send(new FilterLogEventsCommand({
      logGroupName: '/aws/lambda/chrome-api-gateway',
      startTime: t - 3 * 60 * 1000,
      endTime:   t + 30 * 1000,
      filterPattern: '"QRContent:"',
    }));
    const events = result.events || [];
    const qrRe = /QRContent:\s*(\S+)/;
    const matches = [];
    for (const ev of events) {
      const m = ev.message.match(qrRe);
      if (m) matches.push({ url: m[1].replace(/[.,;]+$/, ''), ts: ev.timestamp || 0 });
    }
    // Pick the log event whose timestamp is closest to the S3 object creation time
    matches.sort((a, b) => Math.abs(a.ts - t) - Math.abs(b.ts - t));
    const urls = matches.map(m => m.url);
    res.json({ url: urls[0] ?? null, urls });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// JSON API — summary report
// start/end: ISO datetime string (e.g. 2025-08-01T00:00:00Z or 2025-08-01)
// granularity: 'hour' | 'day' | 'auto' (default: auto — hour if ≤72h, day otherwise)
app.get('/api/summary', async (req, res) => {
  const bucket      = (req.query.bucket ?? '').trim();
  const startRaw    = req.query.start ?? '';
  const endRaw      = req.query.end   ?? '';
  const granParam   = req.query.granularity ?? 'auto';
  if (!bucket) return res.status(400).json({ error: 'bucket required' });
  if (!startRaw || !endRaw) return res.status(400).json({ error: 'start and end required' });

  // Parse — if date-only, treat as UTC day boundaries
  const startMs = new Date(/T/.test(startRaw) ? startRaw : startRaw + 'T00:00:00Z').getTime();
  const endMs   = new Date(/T/.test(endRaw)   ? endRaw   : endRaw   + 'T23:59:59.999Z').getTime();
  const spanMs  = endMs - startMs;

  // Auto granularity: hour if ≤ 72 h, day otherwise
  const useHour = granParam === 'hour' || (granParam === 'auto' && spanMs <= 72 * 3600000);
  const granularity = useHour ? 'hour' : 'day';

  try {
    const { folders } = await listPrefix(bucket, '');

    // Scan every root folder — get earliest + latest + count
    const folderStats = await Promise.all(
      folders.map(async f => {
        const { earliest, latest, count } = await scanFolder(bucket, f);
        return {
          prefix:   f,
          name:     f.replace(/\/$/, ''),
          earliest: earliest?.toISOString() ?? null,
          latest:   latest?.toISOString()   ?? null,
          count,
        };
      })
    );

    // Filter to folders whose earliest date falls in range
    const inRange = folderStats.filter(f => {
      if (!f.earliest) return false;
      const t = new Date(f.earliest).getTime();
      return t >= startMs && t <= endMs;
    });

    // Group into buckets
    function periodKey(isoStr) {
      const d = new Date(isoStr);
      const y = d.getUTCFullYear();
      const mo = String(d.getUTCMonth() + 1).padStart(2, '0');
      const dy = String(d.getUTCDate()).padStart(2, '0');
      if (useHour) {
        const hr = String(d.getUTCHours()).padStart(2, '0');
        return `${y}-${mo}-${dy}T${hr}:00`;
      }
      return `${y}-${mo}-${dy}`;
    }

    const byPeriod = {};
    for (const f of inRange) {
      const key = periodKey(f.earliest);
      if (!byPeriod[key]) byPeriod[key] = { period: key, count: 0, folders: [] };
      byPeriod[key].count++;
      byPeriod[key].folders.push(f);
    }

    // Fill every slot in the range (zero-count slots included)
    const periods = [];
    const step = useHour ? 3600000 : 86400000;
    const cur = new Date(useHour
      ? new Date(startMs).setUTCMinutes(0, 0, 0)
      : new Date(startRaw.slice(0, 10) + 'T00:00:00Z').getTime()
    );
    const last = new Date(endMs);

    while (cur <= last) {
      const key = periodKey(cur.toISOString());
      periods.push(byPeriod[key] ?? { period: key, count: 0, folders: [] });
      cur.setTime(cur.getTime() + step);
    }

    res.json({
      periods,
      granularity,
      totalFolders: folders.length,
      totalInRange: inRange.length,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Image proxy
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

// Download
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

// ─── HTML helpers ─────────────────────────────────────────────────────────────

const esc = str => String(str ?? '')
  .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');

const SHARED_FONTS = `<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet">`;

const SHARED_VARS = `
  *,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
  :root{
    --accent:#2563EB;--accent-bg:#EFF6FF;
    --border:#E2E8F0;--border2:#CBD5E1;
    --text:#0F172A;--text2:#475569;--muted:#94A3B8;
    --bg:#F1F5F9;--surface:#fff;
    --shadow-sm:0 1px 2px rgba(15,23,42,.06);
    --shadow-md:0 8px 24px rgba(15,23,42,.10);
    --font:'Inter',system-ui,sans-serif;
    --mono:'JetBrains Mono',monospace;
  }
  body{font-family:var(--font);background:var(--bg);color:var(--text);font-size:14px}
`;

// ─── Landing page ─────────────────────────────────────────────────────────────

function renderLanding() {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/>
  <title>S3 Browser</title>
  ${SHARED_FONTS}
  <style>
    ${SHARED_VARS}
    body{min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px}
    .card{background:#fff;border:1px solid var(--border);border-radius:14px;padding:40px 48px;max-width:480px;width:100%;box-shadow:var(--shadow-md)}
    .logo{display:flex;align-items:center;gap:10px;margin-bottom:28px}
    .logo-icon{width:36px;height:36px;background:#FF9900;border-radius:9px;display:flex;align-items:center;justify-content:center}
    .logo-text{font-size:18px;font-weight:600;letter-spacing:-.01em}
    h1{font-size:22px;font-weight:600;margin-bottom:6px;letter-spacing:-.02em}
    .sub{font-size:14px;color:var(--text2);margin-bottom:28px;line-height:1.6}
    label{display:block;font-size:12px;font-weight:600;color:var(--text2);letter-spacing:.04em;text-transform:uppercase;margin-bottom:6px}
    .row{display:flex}
    input{font-family:var(--mono);font-size:14px;background:#F8FAFC;border:1px solid var(--border);border-right:none;border-radius:8px 0 0 8px;padding:10px 14px;flex:1;outline:none;transition:border-color .12s}
    input:focus{border-color:var(--accent);background:#fff}
    .btn-browse{font-size:14px;font-weight:500;color:#fff;background:var(--accent);border:1px solid var(--accent);border-radius:0;padding:10px 20px;cursor:pointer;transition:background .12s}
    .btn-browse:hover{background:#1D4ED8}
    .btn-report{font-size:14px;font-weight:500;color:var(--accent);background:#fff;border:1px solid var(--accent);border-left:none;border-radius:0 8px 8px 0;padding:10px 16px;cursor:pointer;transition:all .12s}
    .btn-report:hover{background:var(--accent-bg)}
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
    <p class="sub">Enter an S3 bucket name to explore its contents or generate a summary report.</p>
    <form onsubmit="go(event)">
      <label for="b">Bucket name</label>
      <div class="row">
        <input id="b" type="text" placeholder="my-bucket-name" autocomplete="off" spellcheck="false" autofocus/>
        <button class="btn-browse" type="submit">Browse →</button>
        <button class="btn-report" type="button" onclick="goReport()">📊 Report</button>
      </div>
    </form>
    <p class="hint">Region: <code>AWS_REGION</code> env var (default: <code>us-east-1</code>). Needs <code>s3:ListBucket</code> + <code>s3:GetObject</code>.</p>
  </div>
  <script>
    function go(e){e.preventDefault();const v=document.getElementById('b').value.trim();if(v)location.href='/browse?bucket='+encodeURIComponent(v);}
    function goReport(){const v=document.getElementById('b').value.trim();location.href='/report'+(v?'?bucket='+encodeURIComponent(v):'');}
  </script>
</body></html>`;
}

// ─── Summary report page ──────────────────────────────────────────────────────

function renderReport(bucket) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/>
  <title>S3 Report${bucket ? ' — ' + esc(bucket) : ''}</title>
  ${SHARED_FONTS}
  <style>
    ${SHARED_VARS}
    body{min-height:100vh;display:flex;flex-direction:column;overflow:hidden}

    /* ── Header ── */
    .header{background:var(--surface);border-bottom:1px solid var(--border);height:52px;display:flex;align-items:center;padding:0 20px;gap:14px;box-shadow:var(--shadow-sm);flex-shrink:0}
    .logo{display:flex;align-items:center;gap:8px;font-size:15px;font-weight:600;color:var(--text);text-decoration:none;letter-spacing:-.01em}
    .logo-icon{width:28px;height:28px;background:#FF9900;border-radius:6px;display:flex;align-items:center;justify-content:center}
    .divider{width:1px;height:20px;background:var(--border)}
    .page-title{font-size:14px;font-weight:600;color:var(--text2)}
    .header-right{margin-left:auto;display:flex;align-items:center;gap:8px}
    .hdr-btn{font-size:12px;font-weight:500;color:var(--text2);background:transparent;border:1px solid var(--border);border-radius:5px;padding:3px 10px;cursor:pointer;text-decoration:none;transition:all .12s}
    .hdr-btn:hover{color:var(--accent);border-color:var(--accent);background:var(--accent-bg)}

    /* ── Controls ── */
    .controls{background:var(--surface);border-bottom:1px solid var(--border);padding:12px 24px;display:flex;align-items:flex-end;gap:12px;flex-wrap:wrap;flex-shrink:0}
    .ctrl-group{display:flex;flex-direction:column;gap:4px}
    .ctrl-label{font-size:11px;font-weight:600;color:var(--text2);letter-spacing:.04em;text-transform:uppercase}
    .ctrl-input{font-family:var(--mono);font-size:13px;background:#F8FAFC;border:1px solid var(--border);border-radius:6px;padding:5px 9px;outline:none;transition:border-color .12s;color:var(--text)}
    .ctrl-input:focus{border-color:var(--accent);background:#fff}
    .bucket-input{width:210px}
    .dt-input{width:176px}
    .btn-run{font-size:13px;font-weight:500;color:#fff;background:var(--accent);border:none;border-radius:6px;padding:6px 18px;cursor:pointer;transition:background .12s;align-self:flex-end}
    .btn-run:hover{background:#1D4ED8}
    .btn-run:disabled{opacity:.5;cursor:not-allowed}

    /* ── Shortcuts ── */
    .shortcuts{display:flex;align-items:center;gap:6px;align-self:flex-end;flex-wrap:wrap}
    .shortcut-btn{font-size:11px;font-weight:500;color:var(--text2);background:#F8FAFC;border:1px solid var(--border);border-radius:5px;padding:4px 9px;cursor:pointer;transition:all .12s;white-space:nowrap}
    .shortcut-btn:hover{color:var(--accent);border-color:var(--accent);background:var(--accent-bg)}
    .shortcut-btn.active{color:var(--accent);border-color:var(--accent);background:var(--accent-bg);font-weight:600}

    /* ── Main scroll area ── */
    .main{flex:1;overflow-y:auto;padding:20px 24px;display:flex;flex-direction:column;gap:18px;min-height:0}

    /* ── Stat cards ── */
    .stats-row{display:flex;gap:14px;flex-wrap:wrap}
    .stat-card{background:var(--surface);border:1px solid var(--border);border-radius:10px;padding:14px 18px;min-width:140px;flex:1}
    .stat-label{font-size:11px;font-weight:600;color:var(--muted);letter-spacing:.05em;text-transform:uppercase;margin-bottom:5px}
    .stat-value{font-size:26px;font-weight:600;color:var(--text);letter-spacing:-.02em;font-family:var(--mono);line-height:1}
    .stat-sub{font-size:11px;color:var(--muted);margin-top:4px;line-height:1.4}

    /* ── Chart cards ── */
    .charts-row{display:flex;gap:16px;flex-wrap:wrap}
    .chart-card{background:var(--surface);border:1px solid var(--border);border-radius:10px;padding:18px 20px;flex:1;min-width:300px}
    .chart-title{font-size:12px;font-weight:600;color:var(--text2);text-transform:uppercase;letter-spacing:.04em;margin-bottom:14px;display:flex;align-items:center;gap:8px}
    .chart-subtitle{font-weight:400;color:var(--muted)}
    .chart-wrap{overflow-x:auto}

    /* ── Tooltip ── */
    .tooltip{position:fixed;background:var(--text);color:#fff;font-family:var(--mono);font-size:11px;padding:6px 10px;border-radius:6px;pointer-events:none;white-space:pre;z-index:200;display:none;line-height:1.6}

    /* ── Drill panel ── */
    .drill-panel{background:var(--surface);border-top:2px solid var(--accent);display:none;flex-direction:column;position:fixed;bottom:0;left:0;right:0;height:clamp(260px,33vh,400px);overflow:hidden;z-index:10;box-shadow:0 -4px 16px rgba(0,0,0,.10)}
    .drill-panel.open{display:flex}
    .drill-resize{height:20px;cursor:row-resize;background:#F1F5F9;flex-shrink:0;position:relative;border-top:1px solid var(--border);display:flex;align-items:center;justify-content:center;touch-action:none;user-select:none}
    .drill-resize::after{content:'';width:48px;height:4px;border-radius:2px;background:#CBD5E1}
    .drill-resize:hover{background:#E2E8F0}
    .drill-resize:hover::after{background:#94A3B8}
    .drill-hdr{display:flex;align-items:center;gap:10px;padding:10px 18px;border-bottom:1px solid var(--border);flex-shrink:0;background:#F8FAFC}
    .drill-period{font-family:var(--mono);font-size:13px;font-weight:600;color:var(--text)}
    .drill-count{font-size:12px;color:var(--muted);margin-left:4px}
    .drill-close{margin-left:auto;width:26px;height:26px;border:1px solid var(--border);border-radius:5px;background:transparent;cursor:pointer;display:flex;align-items:center;justify-content:center;color:var(--muted);font-size:13px;transition:all .12s}
    .drill-close:hover{background:var(--bg);color:var(--text)}
    .drill-body{display:flex;flex:1;min-height:0;overflow:hidden}

    /* Left: folder list */
    .drill-left{width:280px;min-width:200px;border-right:1px solid var(--border);display:flex;flex-direction:column;overflow:hidden;flex-shrink:0;max-height:100%;align-self:stretch}
    .drill-left-hdr{padding:8px 12px;border-bottom:1px solid var(--border);font-size:11px;font-weight:600;color:var(--muted);text-transform:uppercase;letter-spacing:.05em;background:#F8FAFC;flex-shrink:0}
    .drill-folders{overflow-y:scroll;flex:1;min-height:0;height:0;scrollbar-gutter:stable}
    .drill-folders::-webkit-scrollbar{width:10px}
    .drill-folders::-webkit-scrollbar-track{background:#E2E8F0}
    .drill-folders::-webkit-scrollbar-thumb{background:#94A3B8;border-radius:5px;border:2px solid #E2E8F0}
    .drill-folders::-webkit-scrollbar-thumb:hover{background:#64748B}
    .drill-folder-item{display:flex;align-items:center;gap:8px;padding:8px 12px;cursor:pointer;border-bottom:1px solid var(--border);transition:background .1s;user-select:none}
    .drill-folder-item:last-child{border-bottom:none}
    .drill-folder-item:hover{background:var(--hover)}
    .drill-folder-item.selected{background:var(--active)}
    .drill-folder-name{font-size:12px;font-family:var(--mono);font-weight:500;color:var(--text);flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
    .drill-folder-item.selected .drill-folder-name{color:var(--accent)}
    .drill-folder-meta{font-size:10px;color:var(--muted);font-family:var(--mono);white-space:nowrap}

    /* Right: file browser — drill-right is the scroll container */
    .drill-right{flex:1;min-width:0;min-height:0;max-height:100%;overflow-y:scroll;scrollbar-gutter:stable;align-self:stretch}
    .drill-right::-webkit-scrollbar{width:10px}
    .drill-right::-webkit-scrollbar-track{background:#E2E8F0}
    .drill-right::-webkit-scrollbar-thumb{background:#94A3B8;border-radius:5px;border:2px solid #E2E8F0}
    .drill-right::-webkit-scrollbar-thumb:hover{background:#64748B}
    .drill-browser-hdr{padding:8px 14px;border-bottom:1px solid var(--border);display:flex;align-items:center;gap:8px;background:#F8FAFC;min-height:37px;position:sticky;top:0;z-index:3}
    .drill-breadcrumb{font-family:var(--mono);font-size:11px;display:flex;align-items:center;flex-wrap:wrap;flex:1;gap:0}
    .d-crumb{color:var(--muted);cursor:pointer;transition:color .12s;white-space:nowrap}
    .d-crumb:hover{color:var(--accent)}
    .d-crumb.active{color:var(--text);font-weight:600}
    .d-sep{color:var(--border2);margin:0 3px}
    .drill-file-count{font-size:10px;color:var(--muted);font-family:var(--mono);white-space:nowrap;flex-shrink:0}

    /* Drill file table */
    .drill-file-list{}
    .drill-table{width:100%;border-collapse:collapse;table-layout:fixed;font-size:12px}
    .drill-table colgroup col:nth-child(1){width:32px}
    .drill-table colgroup col:nth-child(3){width:70px}
    .drill-table colgroup col:nth-child(4){width:70px}
    .drill-table colgroup col:nth-child(5){width:70px}
    .drill-table colgroup col:nth-child(6){width:150px}
    .drill-table colgroup col:nth-child(7){width:90px}
    .drill-table thead th{position:sticky;top:37px;z-index:2;text-align:left;font-size:10px;font-weight:600;letter-spacing:.05em;text-transform:uppercase;color:var(--muted);padding:6px 10px;background:#F8FAFC;border-bottom:1px solid var(--border);white-space:nowrap}
    .drill-table thead th.tr{text-align:right}
    .drill-table tbody td{padding:7px 10px;border-bottom:1px solid var(--border);vertical-align:middle}
    .drill-table tbody tr:last-child td{border-bottom:none}
    .drill-table tbody tr:hover{background:var(--hover)}
    .d-name-btn{font-size:12px;font-weight:500;color:var(--text);background:none;border:none;padding:0;cursor:pointer;font-family:var(--font);text-align:left;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;display:block;max-width:100%;transition:color .12s}
    .d-name-btn:hover{color:var(--accent)}
    .d-pill{font-size:10px;font-weight:500;border-radius:4px;padding:1px 6px;display:inline-block}
    .d-folder-pill{background:#FFFBEB;color:#B45309;border:1px solid #FDE68A}
    .d-file-pill{background:#F8FAFC;color:#64748B;border:1px solid #E2E8F0}
    .d-img-pill{background:#EFF6FF;color:#1D4ED8;border:1px solid #BFDBFE}
    .d-mono{font-family:var(--mono);font-size:11px;color:var(--text2)}
    .d-muted{color:var(--muted)}
    .d-tr{text-align:right}
    .d-btn{display:inline-flex;align-items:center;gap:3px;font-size:10px;font-weight:500;border-radius:4px;padding:2px 7px;cursor:pointer;text-decoration:none;transition:all .12s;border:1px solid;white-space:nowrap}
    .d-btn-enter{color:var(--text2);background:#F8FAFC;border-color:var(--border)}
    .d-btn-enter:hover{color:var(--accent);border-color:var(--accent);background:var(--accent-bg)}
    .d-btn-dl{color:#16A34A;background:#F0FDF4;border-color:#BBF7D0}
    .d-btn-dl:hover{background:#DCFCE7}
    .d-btn-prev{color:var(--accent);background:var(--accent-bg);border-color:#BFDBFE}
    .d-btn-prev:hover{background:#DBEAFE}

    /* States */
    .state-box{display:flex;flex-direction:column;align-items:center;justify-content:center;min-height:160px;gap:10px;color:var(--muted);font-size:13px;background:var(--surface);border:1px solid var(--border);border-radius:10px}
    .spinner{width:22px;height:22px;border:2px solid var(--border);border-top-color:var(--accent);border-radius:50%;animation:spin .7s linear infinite}
    @keyframes spin{to{transform:rotate(360deg)}}
    .inline-spin{width:14px;height:14px;border:2px solid var(--border);border-top-color:var(--accent);border-radius:50%;animation:spin .7s linear infinite;display:inline-block;vertical-align:middle}
    .error-box{color:#DC2626;background:#FEF2F2;border:1px solid #FECACA;border-radius:10px;padding:16px 20px;font-size:13px}

    /* Image modal (reused in drill) */
    .modal-overlay{display:none;position:fixed;inset:0;background:rgba(15,23,42,.55);backdrop-filter:blur(4px);z-index:300;align-items:center;justify-content:center;padding:24px}
    .modal-overlay.open{display:flex;animation:fadeIn .15s ease}
    @keyframes fadeIn{from{opacity:0}to{opacity:1}}
    .modal{background:var(--surface);border-radius:12px;box-shadow:var(--shadow-md);max-width:min(920px,95vw);width:100%;max-height:90vh;display:flex;flex-direction:column;overflow:hidden}
    .modal-header{display:flex;align-items:center;gap:10px;padding:12px 16px;border-bottom:1px solid var(--border);flex-shrink:0}
    .modal-title{font-family:var(--mono);font-size:13px;color:var(--text);font-weight:500;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
    .modal-close{width:26px;height:26px;border-radius:5px;border:1px solid var(--border);background:transparent;cursor:pointer;display:flex;align-items:center;justify-content:center;color:var(--muted);font-size:13px;transition:all .12s}
    .modal-close:hover{background:var(--bg);color:var(--text)}
    .modal-body{overflow:auto;display:flex;align-items:center;justify-content:center;padding:28px;background:#F8FAFC;flex:1}
    .modal-body img{max-width:100%;max-height:60vh;object-fit:contain;border-radius:6px;box-shadow:0 4px 16px rgba(0,0,0,.1)}
    .modal-footer{padding:10px 16px;border-top:1px solid var(--border);display:flex;align-items:center;justify-content:space-between;flex-shrink:0;gap:8px}
    .modal-meta{font-family:var(--mono);font-size:11px;color:var(--muted)}
    .modal-actions{display:flex;gap:8px}
    .m-btn{display:inline-flex;align-items:center;gap:4px;font-size:12px;font-weight:500;border-radius:5px;padding:4px 10px;cursor:pointer;text-decoration:none;transition:all .12s;border:1px solid}
    .m-btn-dl{color:#16A34A;background:#F0FDF4;border-color:#BBF7D0}
    .m-btn-dl:hover{background:#DCFCE7}
    .m-btn-prev{color:var(--accent);background:var(--accent-bg);border-color:#BFDBFE}
    .m-btn-prev:hover{background:#DBEAFE}
    .modal-loader{color:var(--muted);font-size:13px;display:flex;flex-direction:column;align-items:center;gap:12px}
  </style>
</head>
<body>

<div class="header">
  <a class="logo" href="/">
    <div class="logo-icon"><svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M8 1L15 4.5V11.5L8 15L1 11.5V4.5L8 1Z" fill="white" fill-opacity=".9"/></svg></div>
    S3 Browser
  </a>
  <div class="divider"></div>
  <span class="page-title">Summary Report</span>
  <div class="header-right">
    ${bucket ? `<a class="hdr-btn" href="/browse?bucket=${esc(encodeURIComponent(bucket))}">← Browse</a>` : ''}
    <a class="hdr-btn" href="/">Home</a>
  </div>
</div>

<div class="controls">
  <div class="ctrl-group">
    <span class="ctrl-label">Bucket</span>
    <input class="ctrl-input bucket-input" id="bucket-input" type="text" value="${esc(bucket)}" placeholder="my-bucket-name" spellcheck="false"/>
  </div>
  <div class="ctrl-group">
    <span class="ctrl-label">From</span>
    <input class="ctrl-input dt-input" id="start-dt" type="datetime-local"/>
  </div>
  <div class="ctrl-group">
    <span class="ctrl-label">To</span>
    <input class="ctrl-input dt-input" id="end-dt" type="datetime-local"/>
  </div>
  <div class="shortcuts" id="shortcuts">
    <button class="shortcut-btn" onclick="applyShortcut(24,   'h', this)">24h</button>
    <button class="shortcut-btn" onclick="applyShortcut(48,   'h', this)">48h</button>
    <button class="shortcut-btn" onclick="applyShortcut(72,   'h', this)">72h</button>
    <button class="shortcut-btn" onclick="applyShortcut(7,    'd', this)">7d</button>
    <button class="shortcut-btn" onclick="applyShortcut(30,   'd', this)">30d</button>
    <button class="shortcut-btn" onclick="applyShortcut(90,   'd', this)">90d</button>
  </div>
  <button class="btn-run" id="run-btn" onclick="runReport()">Generate Report</button>
</div>

<!-- split: charts + drill in same column, main scrolls above drill -->
<div id="drill-wrapper" style="display:flex;flex-direction:column;flex:1;overflow-y:auto;min-height:0">
  <div class="main" id="main">
    <div class="state-box">Choose a bucket and time range, then click Generate Report.<br>Use the quick shortcuts to jump to the last 24 h, 48 h, or 72 h.</div>
  </div>

  <!-- Drill-down panel — slides up from bottom -->
  <div class="drill-panel" id="drill-panel">
    <div class="drill-resize" id="drill-resize"></div>
    <div class="drill-hdr">
      <span class="drill-period" id="drill-period-label"></span>
      <span class="drill-count" id="drill-count-label"></span>
      <div style="margin-left:auto;display:flex;gap:6px;align-items:center">
        <button class="drill-close" title="Expand panel" onclick="(function(){var p=document.getElementById('drill-panel');p.style.height=(Math.min((p.offsetHeight||320)+120,window.innerHeight-100))+'px';syncDrillHeights();})()">↑</button>
        <button class="drill-close" title="Shrink panel" onclick="(function(){var p=document.getElementById('drill-panel');p.style.height=(Math.max((p.offsetHeight||320)-120,160))+'px';syncDrillHeights();})()">↓</button>
        <button class="drill-close" onclick="closeDrill()">✕</button>
      </div>
    </div>
    <div class="drill-body">
      <div class="drill-left">
        <div class="drill-left-hdr" style="display:flex;align-items:center;justify-content:space-between">
          <span>Objects added this period</span>
          <div style="display:flex;gap:3px">
            <button class="d-btn" title="Scroll up" onclick="document.getElementById('drill-folders').scrollTop-=120" style="font-size:10px;padding:1px 5px">▲</button>
            <button class="d-btn" title="Scroll down" onclick="document.getElementById('drill-folders').scrollTop+=120" style="font-size:10px;padding:1px 5px">▼</button>
          </div>
        </div>
        <div class="drill-folders" id="drill-folders"></div>
      </div>
      <div class="drill-right">
        <div class="drill-browser-hdr">
          <div class="drill-breadcrumb" id="drill-bc"></div>
          <span class="drill-file-count" id="drill-fc"></span>
          <div style="display:flex;gap:4px;margin-left:8px;flex-shrink:0">
            <button class="d-btn" title="Scroll up" onclick="document.querySelector('.drill-right').scrollTop-=200" style="font-size:11px;padding:2px 6px">▲</button>
            <button class="d-btn" title="Scroll down" onclick="document.querySelector('.drill-right').scrollTop+=200" style="font-size:11px;padding:2px 6px">▼</button>
          </div>
        </div>
        <div class="drill-file-list" id="drill-file-list">
          <table class="drill-table" id="drill-table">
            <colgroup><col><col><col><col><col><col><col></colgroup>
            <thead><tr>
              <th></th>
              <th>Name</th>
              <th>Type</th>
              <th class="tr">Objects</th>
              <th class="tr">Size</th>
              <th>Last Modified</th>
              <th class="tr">Actions</th>
            </tr></thead>
          </table>
          <div id="drill-state" style="display:flex;align-items:center;justify-content:center;padding:32px;color:var(--muted);font-size:12px">
            Select an object on the left to browse.
          </div>
        </div>
      </div>
    </div>
  </div>
</div>

<!-- Image modal -->
<div class="modal-overlay" id="img-modal" onclick="if(event.target===this)closeImgModal()">
  <div class="modal">
    <div class="modal-header">
      <span class="modal-title" id="img-modal-title"></span>
      <button class="modal-close" onclick="closeImgModal()">✕</button>
    </div>
    <div class="modal-body" id="img-modal-body"></div>
    <div class="modal-footer">
      <span class="modal-meta" id="img-modal-meta"></span>
      <div id="img-modal-url-row" style="display:none;width:100%;margin-top:8px;padding:6px 10px;background:#F1F5F9;border-radius:6px;font-size:11px;font-family:var(--mono);display:flex;align-items:center;gap:8px;overflow:hidden">
        <span style="color:var(--muted);flex-shrink:0">Source URL:</span>
        <a id="img-modal-url" href="#" target="_blank" style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--accent)"></a>
        <button onclick="navigator.clipboard.writeText(document.getElementById('img-modal-url').href)" style="flex-shrink:0;font-size:10px;padding:2px 6px;border:1px solid var(--border);border-radius:4px;background:white;cursor:pointer;color:var(--muted)">Copy</button>
      </div>
      <div class="modal-actions">
        <a class="m-btn m-btn-dl"   id="img-modal-dl"   href="#">↓ Download</a>
        <a class="m-btn m-btn-prev" id="img-modal-open" href="#" target="_blank">↗ Open</a>
      </div>
    </div>
  </div>
</div>

<div class="tooltip" id="tt"></div>

<script>
// ── Globals ──────────────────────────────────────────────────────────────────
const INIT_BUCKET = ${JSON.stringify(bucket)};
let reportData   = null;
let drillBucket  = '';
let drillFolders = [];        // folders for the drilled period
let drillPrefix  = '';        // currently browsing in the right pane
let drillApiCache = {};

// ── Init defaults ─────────────────────────────────────────────────────────
(function() {
  const now = new Date();
  document.getElementById('end-dt').value   = toLocalDT(now);
  document.getElementById('start-dt').value = toLocalDT(new Date(now - 30 * 86400000));
  if (INIT_BUCKET) runReport();
})();

// ── Shortcuts ─────────────────────────────────────────────────────────────
function applyShortcut(n, unit, btn) {
  const now = new Date();
  const ms  = unit === 'h' ? n * 3600000 : n * 86400000;
  document.getElementById('end-dt').value   = toLocalDT(now);
  document.getElementById('start-dt').value = toLocalDT(new Date(now - ms));
  document.querySelectorAll('.shortcut-btn').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  runReport();
}

function toLocalDT(d) {
  const p = n => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + p(d.getMonth()+1) + '-' + p(d.getDate())
       + 'T' + p(d.getHours()) + ':' + p(d.getMinutes());
}

// ── Report fetch + render ─────────────────────────────────────────────────
async function runReport() {
  const bucket = document.getElementById('bucket-input').value.trim();
  const startV = document.getElementById('start-dt').value;  // local datetime
  const endV   = document.getElementById('end-dt').value;
  const btn    = document.getElementById('run-btn');
  const main   = document.getElementById('main');

  if (!bucket) { alert('Enter a bucket name.'); return; }
  if (!startV || !endV) { alert('Select a date/time range.'); return; }

  // Convert local datetime-local values to UTC ISO strings
  const startISO = new Date(startV).toISOString();
  const endISO   = new Date(endV).toISOString();
  if (startISO >= endISO) { alert('Start must be before end.'); return; }

  drillBucket = bucket;
  drillApiCache = {};
  closeDrill();

  btn.disabled = true; btn.textContent = 'Loading…';
  main.innerHTML = '<div class="state-box"><div class="spinner"></div>Scanning bucket…</div>';

  try {
    const url = '/api/summary?bucket=' + encodeURIComponent(bucket)
              + '&start=' + encodeURIComponent(startISO)
              + '&end='   + encodeURIComponent(endISO);
    const res = await fetch(url);
    if (!res.ok) { const e = await res.json(); throw new Error(e.error || res.statusText); }
    reportData = await res.json();
    renderAll(reportData, bucket, startISO, endISO);
  } catch (err) {
    main.innerHTML = '<div class="error-box">Error: ' + escH(err.message) + '</div>';
  } finally {
    btn.disabled = false; btn.textContent = 'Generate Report';
  }
}

function renderAll(data, bucket, startISO, endISO) {
  const { periods, granularity, totalFolders, totalInRange } = data;
  const maxCount   = Math.max(...periods.map(p => p.count), 1);
  const activePds  = periods.filter(p => p.count > 0).length;
  const peak       = periods.reduce((a, b) => b.count > a.count ? b : a, { count: 0, period: '' });
  const avgPerDay  = periods.length > 0 ? (totalInRange / periods.length).toFixed(1) : '0';

  const main = document.getElementById('main');
  main.innerHTML = \`
    <div class="stats-row">
      <div class="stat-card">
        <div class="stat-label">Added in Range</div>
        <div class="stat-value">\${fmt(totalInRange)}</div>
        <div class="stat-sub">of \${fmt(totalFolders)} total in bucket</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">Active Periods</div>
        <div class="stat-value">\${fmt(activePds)}</div>
        <div class="stat-sub">of \${fmt(periods.length)} \${granularity === 'hour' ? 'hours' : 'days'} had activity</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">Avg / \${granularity === 'hour' ? 'Hour' : 'Day'}</div>
        <div class="stat-value">\${avgPerDay}</div>
        <div class="stat-sub">objects added per period</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">Peak Period</div>
        <div class="stat-value">\${peak.count > 0 ? fmt(peak.count) : '—'}</div>
        <div class="stat-sub">\${peak.count > 0 ? fmtPeriod(peak.period, granularity) : 'No activity'}</div>
      </div>
    </div>
    <div class="charts-row">
      <div class="chart-card" style="min-width:400px">
        <div class="chart-title">
          Objects Added per \${granularity === 'hour' ? 'Hour' : 'Day'}
          <span class="chart-subtitle">— click a bar to drill down</span>
        </div>
        <div class="chart-wrap" id="bar-wrap"></div>
      </div>
      <div class="chart-card" style="min-width:300px;max-width:380px">
        <div class="chart-title">Cumulative Growth</div>
        <div class="chart-wrap" id="line-wrap"></div>
      </div>
    </div>
  \`;

  drawBarChart(periods, granularity, maxCount);
  drawLineChart(periods, granularity);
}

// ── Bar chart ─────────────────────────────────────────────────────────────
function drawBarChart(periods, granularity, maxCount) {
  const wrap  = document.getElementById('bar-wrap');
  const n     = periods.length;
  const BAR   = Math.max(8, Math.min(36, Math.floor(640 / Math.max(n, 1)) - 2));
  const GAP   = Math.max(2, Math.round(BAR * 0.18));
  const H     = 180, PL = 44, PR = 12, PT = 12, PB = 52;
  const W     = Math.max(PL + n * (BAR + GAP) - GAP + PR, 400);
  const svgH  = PT + H + PB;

  // Y gridlines
  const TICKS = 4;
  let gridLines = '', yLabels = '';
  for (let i = 0; i <= TICKS; i++) {
    const val = Math.round(maxCount * i / TICKS);
    const y   = PT + H - (H * i / TICKS);
    gridLines += \`<line x1="\${PL}" y1="\${y}" x2="\${W-PR}" y2="\${y}" stroke="#E2E8F0" stroke-width="1"/>\`;
    yLabels   += \`<text x="\${PL-5}" y="\${y+4}" text-anchor="end" font-size="9" fill="#94A3B8">\${val}</text>\`;
  }

  // X labels: show every Nth to avoid crowding
  const every = n > 120 ? Math.ceil(n/30) : n > 60 ? Math.ceil(n/15) : n > 30 ? 2 : 1;
  let bars = '', xLabels = '';

  periods.forEach((p, i) => {
    const x    = PL + i * (BAR + GAP);
    const barH = p.count > 0 ? Math.max(2, Math.round((p.count / maxCount) * H)) : 0;
    const y    = PT + H - barH;
    const fill = p.count > 0 ? '#2563EB' : '#E2E8F0';
    // Invisible wider hit area for small bars — use data attrs to avoid quote-in-attribute issues
    bars += \`<rect x="\${x}" y="\${PT}" width="\${BAR}" height="\${H}" fill="transparent"
      style="cursor:\${p.count>0?'pointer':'default'}"
      data-idx="\${i}" data-cnt="\${p.count}" data-lbl="\${escAttr(fmtPeriod(p.period,granularity))}"/>\`;
    bars += \`<rect class="bar" x="\${x}" y="\${y}" width="\${BAR}" height="\${barH}" fill="\${fill}" rx="2"
      style="pointer-events:none;transition:opacity .1s"\${p.count > 0 ? ' data-clickable="1"' : ''}
      id="bar-\${i}"/>\`;

    if (i % every === 0) {
      const label = shortPeriodLabel(p.period, granularity);
      const lx = x + BAR / 2;
      const ly = PT + H + 14;
      xLabels += \`<text x="\${lx}" y="\${ly}" text-anchor="middle" font-size="9" fill="#94A3B8" transform="rotate(-40 \${lx} \${ly})">\${label}</text>\`;
    }
  });

  wrap.innerHTML = \`<svg width="\${W}" height="\${svgH}" xmlns="http://www.w3.org/2000/svg">
    <style>.bar[data-clickable]:hover{opacity:.75}</style>
    \${gridLines}\${yLabels}\${bars}\${xLabels}
    <line x1="\${PL}" y1="\${PT}" x2="\${PL}" y2="\${PT+H}" stroke="#CBD5E1" stroke-width="1"/>
    <line x1="\${PL}" y1="\${PT+H}" x2="\${W-PR}" y2="\${PT+H}" stroke="#CBD5E1" stroke-width="1"/>
  </svg>\`;
  wrap.querySelectorAll('rect[data-idx]').forEach(el => {
    el.addEventListener('mouseenter', e => showTT(e, el.dataset.lbl, +el.dataset.cnt));
    el.addEventListener('mouseleave', hideTT);
    if (+el.dataset.cnt > 0) el.addEventListener('click', () => openDrill(+el.dataset.idx));
  });
}

// ── Line chart (cumulative) ───────────────────────────────────────────────
function drawLineChart(periods, granularity) {
  const wrap = document.getElementById('line-wrap');
  const n    = periods.length;
  if (n === 0) { wrap.innerHTML = ''; return; }

  const cumulative = [];
  let running = 0;
  for (const p of periods) { running += p.count; cumulative.push(running); }
  const maxVal = running || 1;

  const W = 300, H = 180, PL = 44, PR = 12, PT = 12, PB = 52;
  const svgH = PT + H + PB;
  const xStep = (W - PL - PR) / Math.max(n - 1, 1);

  // Y gridlines + labels
  const TICKS = 4;
  let gridLines = '', yLabels = '';
  for (let i = 0; i <= TICKS; i++) {
    const val = Math.round(maxVal * i / TICKS);
    const y   = PT + H - (H * i / TICKS);
    gridLines += \`<line x1="\${PL}" y1="\${y}" x2="\${W-PR}" y2="\${y}" stroke="#E2E8F0" stroke-width="1"/>\`;
    yLabels   += \`<text x="\${PL-5}" y="\${y+4}" text-anchor="end" font-size="9" fill="#94A3B8">\${val}</text>\`;
  }

  // Build polyline points + area fill
  const pts = cumulative.map((v, i) => {
    const x = PL + i * xStep;
    const y = PT + H - (H * v / maxVal);
    return [x, y];
  });
  const pointsStr = pts.map(([x, y]) => x.toFixed(1) + ',' + y.toFixed(1)).join(' ');
  const areaPath  = 'M ' + pts[0][0].toFixed(1) + ',' + (PT+H)
                  + ' L ' + pts.map(([x, y]) => x.toFixed(1)+','+y.toFixed(1)).join(' L ')
                  + ' L ' + pts[pts.length-1][0].toFixed(1) + ',' + (PT+H) + ' Z';

  // X labels
  const every = n > 30 ? Math.ceil(n/10) : n > 15 ? 2 : 1;
  let xLabels = '', dots = '', hitRects = '';
  pts.forEach(([x, y], i) => {
    const p = periods[i];
    dots += \`<circle cx="\${x.toFixed(1)}" cy="\${y.toFixed(1)}" r="3" fill="#2563EB" style="pointer-events:none"/>\`;
    hitRects += \`<rect x="\${(x - xStep/2).toFixed(1)}" y="\${PT}" width="\${xStep.toFixed(1)}" height="\${H}" fill="transparent"
      data-idx="\${i}" data-cum="\${cumulative[i]}" data-lbl="\${escAttr(fmtPeriod(p.period,granularity))}"/>\`;
    if (i % every === 0) {
      const label = shortPeriodLabel(p.period, granularity);
      const ly = PT + H + 14;
      xLabels += \`<text x="\${x.toFixed(1)}" y="\${ly}" text-anchor="middle" font-size="9" fill="#94A3B8" transform="rotate(-40 \${x.toFixed(1)} \${ly})">\${label}</text>\`;
    }
  });

  wrap.innerHTML = \`<svg width="\${W}" height="\${svgH}" xmlns="http://www.w3.org/2000/svg">
    \${gridLines}\${yLabels}
    <defs><linearGradient id="lg" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#2563EB" stop-opacity=".18"/>
      <stop offset="100%" stop-color="#2563EB" stop-opacity="0"/>
    </linearGradient></defs>
    <path d="\${areaPath}" fill="url(#lg)"/>
    <polyline points="\${pointsStr}" fill="none" stroke="#2563EB" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>
    \${dots}\${hitRects}\${xLabels}
    <line x1="\${PL}" y1="\${PT}" x2="\${PL}" y2="\${PT+H}" stroke="#CBD5E1" stroke-width="1"/>
    <line x1="\${PL}" y1="\${PT+H}" x2="\${W-PR}" y2="\${PT+H}" stroke="#CBD5E1" stroke-width="1"/>
  </svg>\`;
  wrap.querySelectorAll('rect[data-idx]').forEach(el => {
    el.addEventListener('mouseenter', e => showTT(e, el.dataset.lbl, +el.dataset.cum, true));
    el.addEventListener('mouseleave', hideTT);
  });
}

// We need cumulative accessible from inline SVG handlers — attach to wrap
function showTT(e, label, value, isCumulative) {
  const tt = document.getElementById('tt');
  tt.textContent = label + (isCumulative ? '\\nTotal so far: ' + fmt(value) : '\\n' + fmt(value) + ' object' + (value !== 1 ? 's' : '') + ' added');
  tt.style.display = 'block';
  moveTT(e);
}
function moveTT(e) {
  const tt = document.getElementById('tt');
  tt.style.left = (e.clientX + 14) + 'px';
  tt.style.top  = (e.clientY - 44) + 'px';
}
function hideTT() { document.getElementById('tt').style.display = 'none'; }
document.addEventListener('mousemove', e => { if (document.getElementById('tt').style.display !== 'none') moveTT(e); });

// Drill panel resize handle — document-capture to bypass stacking/clip issues
(function(){
  var handle = document.getElementById('drill-resize');
  var panel  = document.getElementById('drill-panel');
  var startY, startH, active = false;

  // Capture phase on document fires before anything else in the tree
  document.addEventListener('mousedown', function(e) {
    var r = handle.getBoundingClientRect();
    var TOL = 30;
    if (e.clientX < r.left - TOL || e.clientX > r.right + TOL || e.clientY < r.top - TOL || e.clientY > r.bottom + TOL) return;
    e.preventDefault();
    active = true;
    startY = e.clientY;
    startH = panel.offsetHeight;
    document.body.style.userSelect = 'none';
    document.body.style.cursor = 'ns-resize';
    console.log('RESIZE START y=' + e.clientY + ' panelH=' + startH);
  }, true); // capture = true

  document.addEventListener('mousemove', function(e) {
    if (!active) return;
    var newH = Math.max(160, Math.min(window.innerHeight - 120, startH + startY - e.clientY));
    panel.style.height = newH + 'px';
    syncDrillHeights();
  });

  document.addEventListener('mouseup', function() {
    if (!active) return;
    active = false;
    document.body.style.userSelect = '';
    document.body.style.cursor = '';
  });

  window.addEventListener('blur', function() { active = false; });
})();

// Route wheel events to the correct scroll pane
document.getElementById('drill-panel').addEventListener('wheel', e => {
  if (e.target.closest('.drill-left')) {
    const df = document.querySelector('.drill-folders');
    if (!df) return;
    e.preventDefault();
    df.scrollTop += e.deltaY;
    return;
  }
  const dr = document.querySelector('.drill-right');
  if (!dr) return;
  e.preventDefault();
  dr.scrollTop += e.deltaY;
}, { passive: false });

// Drill-down event delegation — avoids quote-in-attribute issues
document.addEventListener('click', e => {
  const nav = e.target.closest('[data-drill-nav]');
  if (nav) { loadDrillFolder(nav.dataset.prefix, nav.dataset.root); return; }
  const img = e.target.closest('[data-drill-img]');
  if (img) { e.preventDefault(); openImgModal(img.dataset.key, img.dataset.name, img.dataset.sz, img.dataset.ts); }
});

// ── Drill-down ────────────────────────────────────────────────────────────
function syncDrillHeights() {
  var panel   = document.getElementById('drill-panel');
  var body    = document.querySelector('.drill-body');
  var lhdr    = document.querySelector('.drill-left-hdr');
  var folders = document.getElementById('drill-folders');
  var right   = document.querySelector('.drill-right');
  if (!body || !folders || !right) return;
  var bh = body.offsetHeight;
  if (bh === 0) { requestAnimationFrame(syncDrillHeights); return; }
  var fh = bh - (lhdr ? lhdr.offsetHeight : 0);
  if (fh > 0) folders.style.height = fh + 'px';
  right.style.height = bh + 'px';
  // Keep wrapper padding so fixed panel doesn't overlay content
  var wrapper = document.getElementById('drill-wrapper');
  if (wrapper && panel) wrapper.style.paddingBottom = panel.offsetHeight + 'px';
}

function openDrill(periodIdx) {
  if (!reportData) return;
  const p = reportData.periods[periodIdx];
  if (!p || p.count === 0) return;

  drillFolders = p.folders;
  drillPrefix  = '';

  document.getElementById('drill-period-label').textContent = fmtPeriod(p.period, reportData.granularity);
  document.getElementById('drill-count-label').textContent  = '(' + fmt(p.count) + ' object' + (p.count !== 1 ? 's' : '') + ')';
  document.getElementById('drill-panel').classList.add('open');
  requestAnimationFrame(syncDrillHeights);

  // Render folder list
  renderDrillFolders(p.folders);

  // Clear browser pane
  clearDrillBrowser('Select an object on the left to browse its contents.');

  // Auto-select first folder
  if (p.folders.length > 0) selectDrillFolder(p.folders[0], 0);
}

function closeDrill() {
  document.getElementById('drill-panel').classList.remove('open');
  var wrapper = document.querySelector('.drill-wrapper');
  if (wrapper) wrapper.style.paddingBottom = '';
  drillFolders = []; drillPrefix = '';
}

function renderDrillFolders(folders) {
  const el = document.getElementById('drill-folders');
  if (folders.length === 0) { el.innerHTML = '<div style="padding:12px;font-size:12px;color:var(--muted)">No objects.</div>'; return; }
  el.innerHTML = folders.map((f, i) => \`
    <div class="drill-folder-item" id="dfi-\${i}" onclick="selectDrillFolder(drillFolders[\${i}],\${i})">
      <svg width="12" height="12" viewBox="0 0 16 16" fill="none" style="flex-shrink:0"><path d="M1 3.5A1.5 1.5 0 0 1 2.5 2h3.172a1.5 1.5 0 0 1 1.06.44l.829.828A1.5 1.5 0 0 0 8.62 3.75H13.5A1.5 1.5 0 0 1 15 5.25v7.25A1.5 1.5 0 0 1 13.5 14h-11A1.5 1.5 0 0 1 1 12.5v-9Z" fill="#FEF3C7" stroke="#D97706" stroke-width="1"/></svg>
      <span class="drill-folder-name">\${escH(f.name)}</span>
      <span class="drill-folder-meta">\${f.count != null ? fmt(f.count) : ''}</span>
    </div>
  \`).join('');
}

function selectDrillFolder(folder, idx) {
  document.querySelectorAll('.drill-folder-item').forEach((el, i) => el.classList.toggle('selected', i === idx));
  loadDrillFolder(folder.prefix, folder.prefix);
}

// ── Drill browser pane ────────────────────────────────────────────────────
async function loadDrillFolder(prefix, rootPrefix) {
  drillPrefix = prefix;
  renderDrillBreadcrumb(prefix, rootPrefix || prefix);
  document.getElementById('drill-fc').textContent = '';
  setDrillState('<div class="inline-spin"></div> Loading…');
  try {
    const data = await drillApiList(drillBucket, prefix);
    renderDrillTable(data, prefix, rootPrefix || prefix);
  } catch (err) {
    setDrillState('<span style="color:#DC2626">' + escH(err.message) + '</span>');
  }
}

async function drillApiList(bucket, prefix) {
  const key = bucket + '|' + prefix;
  if (drillApiCache[key]) return drillApiCache[key];
  const url = '/api/list?bucket=' + encodeURIComponent(bucket) + '&prefix=' + encodeURIComponent(prefix);
  const res = await fetch(url);
  if (!res.ok) throw new Error((await res.json()).error || res.statusText);
  const data = await res.json();
  drillApiCache[key] = data;
  return data;
}

function renderDrillTable({ folders, files }, prefix, rootPrefix) {
  const rows = [
    ...folders.map(f => ({ ...f, _t: 'folder' })),
    ...files.map(f => ({ ...f, _t: isImg(f.key) ? 'image' : 'file' })),
  ];

  if (rows.length === 0) {
    setDrillState('This folder is empty.');
    document.getElementById('drill-fc').textContent = '0 items';
    return;
  }

  document.getElementById('drill-fc').textContent =
    folders.length + ' object' + (folders.length !== 1 ? 's' : '') +
    ' · ' + files.length + ' file' + (files.length !== 1 ? 's' : '');

  const tbody = document.createElement('tbody');

  for (const f of folders) {
    const tr = document.createElement('tr');
    tr.innerHTML = \`
      <td><svg width="12" height="12" viewBox="0 0 16 16" fill="none"><path d="M1 3.5A1.5 1.5 0 0 1 2.5 2h3.172a1.5 1.5 0 0 1 1.06.44l.829.828A1.5 1.5 0 0 0 8.62 3.75H13.5A1.5 1.5 0 0 1 15 5.25v7.25A1.5 1.5 0 0 1 13.5 14h-11A1.5 1.5 0 0 1 1 12.5v-9Z" fill="#FEF3C7" stroke="#D97706" stroke-width="1"/></svg></td>
      <td><button class="d-name-btn" data-drill-nav="1" data-prefix="\${escAttr(f.prefix)}" data-root="\${escAttr(rootPrefix)}">\${escH(f.name)}</button></td>
      <td><span class="d-pill d-folder-pill">Folder</span></td>
      <td class="d-mono d-tr">\${f.count != null ? fmt(f.count) : '<span class="d-muted">—</span>'}</td>
      <td class="d-mono d-tr d-muted">—</td>
      <td class="d-mono">\${dFmtDate(f.latestModified)}</td>
      <td class="d-tr"><button class="d-btn d-btn-enter" data-drill-nav="1" data-prefix="\${escAttr(f.prefix)}" data-root="\${escAttr(rootPrefix)}">Open →</button></td>
    \`;
    tbody.appendChild(tr);
  }

  for (const f of files) {
    const name = f.key.split('/').pop();
    const img  = isImg(f.key);
    const tr   = document.createElement('tr');
    const dlUrl = '/download?bucket=' + encodeURIComponent(drillBucket) + '&key=' + encodeURIComponent(f.key);
    const actionsHtml = img
      ? \`<a class="d-btn d-btn-prev" href="#" data-drill-img="1" data-key="\${escAttr(f.key)}" data-name="\${escAttr(name)}" data-sz="\${escAttr(fmtSize(f.size))}" data-ts="\${escAttr(f.lastModified||'')}">Preview</a>
         <a class="d-btn d-btn-dl" href="\${dlUrl}">↓</a>\`
      : \`<a class="d-btn d-btn-prev" href="\${dlUrl}" target="_blank">Preview</a>
         <a class="d-btn d-btn-dl" href="\${dlUrl}">↓</a>\`;
    tr.innerHTML = \`
      <td><svg width="12" height="12" viewBox="0 0 16 16" fill="none">\${img
        ? '<rect x="1" y="2" width="14" height="12" rx="1.5" fill="#EFF6FF" stroke="#3B82F6" stroke-width="1"/><circle cx="5" cy="6" r="1.5" fill="#93C5FD"/><path d="M1 11l3.5-3.5 2.5 2.5 2-2 5 5" stroke="#3B82F6" stroke-width="1" stroke-linecap="round"/>'
        : '<path d="M3 1.5h7l4 4V14a.5.5 0 0 1-.5.5h-10A.5.5 0 0 1 3 14V2a.5.5 0 0 1 0-.5Z" fill="#F8FAFC" stroke="#CBD5E1" stroke-width="1"/><path d="M10 1.5V5.5H14" stroke="#CBD5E1" stroke-width="1"/>'
      }</svg></td>
      <td><span class="d-name-btn" style="cursor:default">\${escH(name)}</span></td>
      <td><span class="d-pill \${img ? 'd-img-pill' : 'd-file-pill'}">\${img ? 'Image' : 'Object'}</span></td>
      <td class="d-muted d-tr">—</td>
      <td class="d-mono d-tr">\${fmtSize(f.size)}</td>
      <td class="d-mono">\${dFmtDate(f.lastModified)}</td>
      <td class="d-tr">\${actionsHtml}</td>
    \`;
    tbody.appendChild(tr);
  }

  clearDrillBrowser();
  const table = document.getElementById('drill-table');
  const old = table.querySelector('tbody');
  if (old) table.removeChild(old);
  table.appendChild(tbody);
  syncDrillHeights();
}

function renderDrillBreadcrumb(prefix, rootPrefix) {
  const el = document.getElementById('drill-bc');
  // Show bucket > root folder > subfolders
  const rootName = rootPrefix.split('/').filter(Boolean)[0] || rootPrefix.replace(/\\/$/, '');
  const parts = prefix.slice(rootPrefix.length).split('/').filter(Boolean);

  let html = \`<span class="d-crumb" data-drill-nav="1" data-prefix="\${escAttr(rootPrefix)}" data-root="\${escAttr(rootPrefix)}">\${escH(rootName)}</span>\`;
  let acc = rootPrefix;
  for (let i = 0; i < parts.length; i++) {
    acc += parts[i] + '/';
    const isLast = i === parts.length - 1;
    const cap = acc;
    html += \`<span class="d-sep">/</span><span class="d-crumb\${isLast ? ' active' : ''}" data-drill-nav="1" data-prefix="\${escAttr(cap)}" data-root="\${escAttr(rootPrefix)}">\${escH(parts[i])}</span>\`;
  }
  el.innerHTML = html;
}

function setDrillState(html) {
  const table = document.getElementById('drill-table');
  const old = table.querySelector('tbody');
  if (old) table.removeChild(old);
  document.getElementById('drill-state').innerHTML = html;
  document.getElementById('drill-state').style.display = 'flex';
}

function clearDrillBrowser(msg) {
  document.getElementById('drill-state').style.display = msg ? 'flex' : 'none';
  if (msg) document.getElementById('drill-state').textContent = msg;
  const table = document.getElementById('drill-table');
  const old = table.querySelector('tbody');
  if (old) table.removeChild(old);
}

// ── Image modal ───────────────────────────────────────────────────────────
function openImgModal(key, name, size, ts) {
  const body = document.getElementById('img-modal-body');
  document.getElementById('img-modal-title').textContent = name;
  document.getElementById('img-modal-meta').textContent  = size ? 'Size: ' + size : '';
  const imgUrl = '/image?bucket=' + encodeURIComponent(drillBucket) + '&key=' + encodeURIComponent(key);
  const dlUrl  = '/download?bucket=' + encodeURIComponent(drillBucket) + '&key=' + encodeURIComponent(key);
  document.getElementById('img-modal-open').href = imgUrl;
  document.getElementById('img-modal-dl').href   = dlUrl;

  // Reset URL row
  const urlRow = document.getElementById('img-modal-url-row');
  const urlEl  = document.getElementById('img-modal-url');
  urlRow.style.display = 'none';
  urlEl.textContent = '';
  urlEl.href = '#';

  body.innerHTML = '<div class="modal-loader"><div class="spinner"></div>Loading…</div>';
  document.getElementById('img-modal').classList.add('open');

  const img = new Image();
  img.onload = () => {
    body.innerHTML = ''; body.appendChild(img);
    document.getElementById('img-modal-meta').textContent = (size ? size + '  ·  ' : '') + img.naturalWidth + ' × ' + img.naturalHeight + ' px';
  };
  img.onerror = () => { body.innerHTML = '<p style="color:#DC2626;text-align:center">Failed to load image.</p>'; };
  img.src = imgUrl;
  img.style.cssText = 'max-width:100%;max-height:60vh;object-fit:contain;border-radius:6px;box-shadow:0 4px 16px rgba(0,0,0,.1)';

  // Fetch source URL from CloudWatch Logs
  if (ts) {
    fetch('/api/chrome-url?ts=' + encodeURIComponent(ts))
      .then(r => r.json())
      .then(d => {
        if (d.url) {
          urlEl.textContent = d.url;
          urlEl.href = d.url;
          urlRow.style.display = 'flex';
        }
      })
      .catch(() => {});
  }
}
function closeImgModal() {
  document.getElementById('img-modal').classList.remove('open');
}
document.addEventListener('keydown', e => { if (e.key === 'Escape') closeImgModal(); });

// ── Formatters ────────────────────────────────────────────────────────────
function fmtPeriod(period, granularity) {
  if (!period) return '';
  if (granularity === 'hour') {
    // period is YYYY-MM-DDTHH:00
    const d = new Date(period + ':00Z');
    return d.toLocaleString('en-US', { month:'short', day:'numeric', hour:'2-digit', minute:'2-digit', hour12:false });
  }
  const d = new Date(period + 'T00:00:00Z');
  return d.toLocaleDateString('en-US', { weekday:'short', month:'short', day:'numeric', year:'numeric' });
}

function shortPeriodLabel(period, granularity) {
  if (granularity === 'hour') {
    // period is "YYYY-MM-DDTHH:00" — extract day and hour directly by position
    return parseInt(period.slice(8, 10)) + '/' + period.slice(11, 13) + 'h';
  }
  const [, m, d] = period.split('-');
  return parseInt(m) + '/' + parseInt(d);
}

function dFmtDate(d) {
  if (!d) return '<span class="d-muted">—</span>';
  return new Intl.DateTimeFormat('en-US', { month:'short', day:'2-digit', hour:'2-digit', minute:'2-digit', timeZoneName:'short' }).format(new Date(d));
}

function fmtSize(bytes) {
  if (bytes == null || bytes < 0) return '—';
  if (bytes === 0) return '0 B';
  const s = ['B','KB','MB','GB','TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return parseFloat((bytes / Math.pow(1024, i)).toFixed(1)) + '\\u00a0' + s[i];
}

function fmt(n) { return Number(n).toLocaleString(); }

function isImg(key) {
  const ext = (key.split('.').pop() || '').toLowerCase();
  return ['jpg','jpeg','png','gif','webp','svg','bmp','tiff','tif','avif','ico'].includes(ext);
}

function escH(s) {
  return String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
function escAttr(s) {
  return String(s ?? '').replace(/&/g,'&amp;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}

// Double-quoted JSON string safe for inline onclick
function dq(s) { return JSON.stringify(String(s ?? '')); }
</script>
</body></html>`;
}

// ─── Browser app ──────────────────────────────────────────────────────────────

const COLGROUP = [40, null, 90, 90, 90, 170, 120]
  .map(w => `<col${w ? ` style="width:${w}px"` : ''}>`)
  .join('');

function renderApp(bucket) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/>
  <title>S3 Browser — ${esc(bucket)}</title>
  ${SHARED_FONTS}
  <style>
    ${SHARED_VARS}
    html,body{height:100%;overflow:hidden}
    body{display:flex;flex-direction:column}

    .header{background:var(--surface);border-bottom:1px solid var(--border);height:52px;display:flex;align-items:center;padding:0 20px;gap:14px;box-shadow:var(--shadow-sm);flex-shrink:0;z-index:10}
    .logo{display:flex;align-items:center;gap:8px;font-size:15px;font-weight:600;color:var(--text);text-decoration:none;letter-spacing:-.01em;white-space:nowrap}
    .logo-icon{width:28px;height:28px;background:#FF9900;border-radius:6px;display:flex;align-items:center;justify-content:center;flex-shrink:0}
    .divider{width:1px;height:20px;background:var(--border);flex-shrink:0}
    .bucket-form{display:flex;align-items:center}
    .bucket-input{font-family:var(--mono);font-size:12px;color:var(--text);background:var(--bg);border:1px solid var(--border);border-right:none;border-radius:6px 0 0 6px;padding:4px 10px;width:220px;outline:none;transition:border-color .12s}
    .bucket-input:focus{border-color:var(--accent);background:#fff}
    .bucket-btn{font-size:12px;font-weight:500;color:#fff;background:var(--accent);border:1px solid var(--accent);border-radius:0 6px 6px 0;padding:4px 12px;cursor:pointer;transition:background .12s;white-space:nowrap}
    .bucket-btn:hover{background:#1D4ED8}
    .header-right{margin-left:auto;display:flex;align-items:center;gap:8px}
    .report-btn{font-size:12px;font-weight:500;color:var(--text2);background:transparent;border:1px solid var(--border);border-radius:5px;padding:3px 10px;cursor:pointer;text-decoration:none;transition:all .12s;white-space:nowrap}
    .report-btn:hover{color:var(--accent);border-color:var(--accent);background:var(--accent-bg)}
    .note{font-size:11px;color:#92400E;background:#FFFBEB;border:1px solid #FDE68A;border-radius:6px;padding:2px 8px;white-space:nowrap}

    .panes{display:flex;flex:1;overflow:hidden;min-height:0}
    .left-pane{width:280px;min-width:200px;max-width:400px;background:var(--surface);border-right:1px solid var(--border);display:flex;flex-direction:column;flex-shrink:0;overflow:hidden}
    .resize-handle{width:4px;background:transparent;cursor:col-resize;flex-shrink:0;transition:background .15s;position:relative;z-index:5}
    .resize-handle:hover,.resize-handle.dragging{background:var(--accent)}
    .pane-header{padding:10px 14px;border-bottom:1px solid var(--border);font-size:11px;font-weight:600;color:var(--muted);letter-spacing:.06em;text-transform:uppercase;flex-shrink:0;background:#F8FAFC}
    .tree{overflow-y:auto;flex:1;padding:6px 0}
    .tree-item{display:flex;align-items:center;gap:0;cursor:pointer;user-select:none;padding:0;position:relative;flex-direction:column}
    .tree-item:hover>.tree-row{background:var(--hover)}
    .tree-item.selected>.tree-row{background:var(--active);color:var(--accent)}
    .tree-row{display:flex;align-items:center;gap:6px;padding:6px 10px;width:100%;transition:background .1s}
    .tree-toggle{width:16px;height:16px;display:flex;align-items:center;justify-content:center;flex-shrink:0;font-size:9px;color:var(--muted);transition:transform .15s}
    .tree-toggle.open{transform:rotate(90deg)}
    .tree-toggle.leaf{opacity:0;pointer-events:none}
    .tree-name{font-size:13px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;flex:1}
    .tree-children{display:none;width:100%}
    .tree-children.open{display:block}
    .tree-loader{padding:4px 10px 4px 32px;font-size:11px;color:var(--muted)}

    .right-pane{flex:1;display:flex;flex-direction:column;overflow:hidden;min-width:0}
    .right-header{padding:10px 20px;border-bottom:1px solid var(--border);display:flex;align-items:center;gap:8px;flex-shrink:0;background:#F8FAFC;min-height:41px}
    .refresh-btn{font-size:12px;font-weight:500;color:var(--accent);background:transparent;border:1px solid var(--accent);border-radius:5px;padding:3px 10px;cursor:pointer;transition:all .12s;display:inline-flex;align-items:center;gap:4px}
    .refresh-btn:hover{background:var(--accent-bg)}
    .refresh-icon{display:inline-block;transition:transform .3s}
    .refresh-btn:hover .refresh-icon{transform:rotate(180deg)}
    .breadcrumb{display:flex;align-items:center;flex-wrap:wrap;font-family:var(--mono);font-size:12px;gap:0;flex:1;min-width:0}
    .crumb{color:var(--muted);cursor:pointer;text-decoration:none;transition:color .12s;white-space:nowrap}
    .crumb:hover{color:var(--accent)}
    .crumb.active{color:var(--text);font-weight:500}
    .sep{color:var(--border2);margin:0 4px}
    .right-count{font-family:var(--mono);font-size:11px;color:var(--muted);white-space:nowrap;flex-shrink:0}

    .file-list{overflow-y:auto;flex:1}
    .content-table{width:100%;border-collapse:collapse;table-layout:fixed}
    .content-table thead th{position:sticky;top:0;z-index:2;text-align:left;font-size:11px;font-weight:600;letter-spacing:.05em;text-transform:uppercase;color:var(--muted);padding:8px 12px;background:#F8FAFC;border-bottom:1px solid var(--border);cursor:pointer;user-select:none;white-space:nowrap;transition:color .12s,background .12s}
    .content-table thead th:hover{color:var(--text2);background:#F1F5F9}
    .content-table thead th.sort-active{color:var(--accent);background:var(--accent-bg)}
    .content-table thead th.no-sort{cursor:default}
    .content-table thead th.no-sort:hover{color:var(--muted);background:#F8FAFC}
    .sort-icon{margin-left:3px;opacity:.4;font-size:10px}
    th.sort-active .sort-icon{opacity:1}

    .file-row{border-bottom:1px solid var(--border);transition:background .1s}
    .file-row:last-child{border-bottom:none}
    .file-row:hover{background:var(--hover)}
    td{padding:9px 12px;vertical-align:middle}
    .pill{font-size:11px;font-weight:500;border-radius:5px;padding:2px 8px;display:inline-block}
    .folder-pill{background:#FFFBEB;color:#B45309;border:1px solid #FDE68A}
    .image-pill{background:#EFF6FF;color:#1D4ED8;border:1px solid #BFDBFE}
    .file-pill{background:#F8FAFC;color:#64748B;border:1px solid #E2E8F0}
    .name-link{font-size:13px;font-weight:500;color:var(--text);text-decoration:none;cursor:pointer;background:none;border:none;padding:0;font-family:var(--font);text-align:left;transition:color .12s;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;display:block;max-width:100%}
    .name-link:hover{color:var(--accent)}
    .name-link.is-image{color:var(--accent)}
    .mono-sm{font-family:var(--mono);font-size:12px;color:var(--text2)}
    .na{color:var(--muted)}
    .date-note{font-size:10px;color:var(--muted);margin-left:3px}
    .tr{text-align:right}

    .btn{display:inline-flex;align-items:center;gap:4px;font-size:11px;font-weight:500;border-radius:5px;padding:3px 9px;cursor:pointer;text-decoration:none;transition:all .12s;border:1px solid}
    .btn-preview{color:var(--accent);background:var(--accent-bg);border-color:#BFDBFE}
    .btn-preview:hover{background:#DBEAFE}
    .btn-download{color:#16A34A;background:#F0FDF4;border-color:#BBF7D0}
    .btn-download:hover{background:#DCFCE7}
    .btn-enter{color:var(--text2);background:#F8FAFC;border-color:var(--border)}
    .btn-enter:hover{color:var(--accent);border-color:var(--accent);background:var(--accent-bg)}

    .state-box{display:flex;flex-direction:column;align-items:center;justify-content:center;flex:1;gap:10px;color:var(--muted);font-size:13px;padding:48px}
    .spinner{width:24px;height:24px;border:2px solid var(--border);border-top-color:var(--accent);border-radius:50%;animation:spin .7s linear infinite}
    @keyframes spin{to{transform:rotate(360deg)}}

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
  <div class="header-right">
    <a class="report-btn" href="/report?bucket=${esc(encodeURIComponent(bucket))}">📊 Report</a>
    <span class="note">⚠ Dates = LastModified</span>
  </div>
</div>

<div class="panes" id="panes">
  <div class="left-pane" id="left-pane">
    <div class="pane-header">Folders <span id="folder-count"></span></div>
    <div class="tree" id="tree">
      <div class="state-box"><div class="spinner"></div>Loading…</div>
    </div>
  </div>
  <div class="resize-handle" id="resize-handle"></div>
  <div class="right-pane" id="right-pane">
    <div class="right-header">
      <div class="breadcrumb" id="breadcrumb"></div>
      <button class="refresh-btn" onclick="refreshCurrent()"><span class="refresh-icon">⟳</span> Refresh</button>
      <span class="right-count" id="right-count"></span>
    </div>
    <div class="file-list" id="file-list">
      <table class="content-table" id="content-table">
        <colgroup>${COLGROUP}</colgroup>
        <thead id="sort-thead"><tr>
          <th class="no-sort"></th>
          <th onclick="sortBy('name')">Name <span class="sort-icon" id="si-name">↕</span></th>
          <th onclick="sortBy('type')">Type <span class="sort-icon" id="si-type">↕</span></th>
          <th onclick="sortBy('count')" style="text-align:right">Objects <span class="sort-icon" id="si-count">↕</span></th>
          <th onclick="sortBy('size')"  style="text-align:right">Size <span class="sort-icon" id="si-size">↕</span></th>
          <th onclick="sortBy('date')">Last Modified <span class="sort-icon" id="si-date">↕</span></th>
          <th class="no-sort" style="text-align:right">Actions</th>
        </tr></thead>
      </table>
      <div id="list-state" class="state-box">Select a folder on the left to browse its contents.</div>
    </div>
  </div>
</div>

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
        <a class="btn btn-preview"  id="modal-open"     href="#" target="_blank">↗ Open</a>
      </div>
    </div>
  </div>
</div>

<script>
const BUCKET = ${JSON.stringify(bucket)};
let currentPrefix = '';
let allRows = [];
let sortCol = 'name', sortAsc = true;
let prefixCache = {};

function changeBucket(e) {
  e.preventDefault();
  const v = document.getElementById('bucket-input').value.trim();
  if (v) location.href = '/browse?bucket=' + encodeURIComponent(v);
}

async function apiList(prefix, opts) {
  if (!opts?.bypassCache && prefixCache[prefix]) return prefixCache[prefix];
  const url = '/api/list?bucket=' + encodeURIComponent(BUCKET) + '&prefix=' + encodeURIComponent(prefix);
  const res = await fetch(url);
  if (!res.ok) throw new Error((await res.json()).error || res.statusText);
  const data = await res.json();
  prefixCache[prefix] = data;
  return data;
}

const UUID4_RE = /^[a-z0-9]{4}-[a-z0-9]{4}-[a-z0-9]{4}-[a-z0-9]{4}$/;
async function initTree() {
  const tree = document.getElementById('tree');
  tree.innerHTML = '<div class="state-box"><div class="spinner"></div>Loading…</div>';
  try {
    const { folders } = await apiList('');
    const countEl = document.getElementById('folder-count');
    const valid = folders.filter(f => { const n = f.prefix.split('/').filter(Boolean).pop(); return n && UUID4_RE.test(n); });
    if (countEl) countEl.textContent = valid.length ? '(' + valid.length + ')' : '';
    tree.innerHTML = '';
    tree.appendChild(makeTreeItem({ name:'/ (root)', prefix:'', isRoot:true }, 0));
    for (const f of folders) tree.appendChild(makeTreeItem(f, 0));
    if (folders.length === 0) loadFolder('');
  } catch (err) {
    tree.innerHTML = '<div class="state-box" style="color:#DC2626">' + esc(err.message) + '</div>';
  }
}

function makeTreeItem(folder, depth) {
  const item = document.createElement('div');
  item.className = 'tree-item'; item.dataset.prefix = folder.prefix;
  const row = document.createElement('div');
  row.className = 'tree-row'; row.style.paddingLeft = (10 + depth * 16) + 'px';
  const toggle = document.createElement('span'); toggle.className = 'tree-toggle'; toggle.textContent = '▶';
  const name = document.createElement('span'); name.className = 'tree-name'; name.textContent = folder.name || folder.prefix;
  row.appendChild(toggle);
  row.insertAdjacentHTML('beforeend', '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" style="flex-shrink:0"><path d="M1 3.5A1.5 1.5 0 0 1 2.5 2h3.172a1.5 1.5 0 0 1 1.06.44l.829.828A1.5 1.5 0 0 0 8.62 3.75H13.5A1.5 1.5 0 0 1 15 5.25v7.25A1.5 1.5 0 0 1 13.5 14h-11A1.5 1.5 0 0 1 1 12.5v-9Z" fill="#FEF3C7" stroke="#D97706" stroke-width="1"/></svg>');
  row.appendChild(name); item.appendChild(row);
  const children = document.createElement('div'); children.className = 'tree-children'; item.appendChild(children);
  let loaded = false;
  row.addEventListener('click', async () => {
    document.querySelectorAll('.tree-item.selected').forEach(el => el.classList.remove('selected'));
    item.classList.add('selected');
    loadFolder(folder.prefix); currentPrefix = folder.prefix;
    const isOpen = children.classList.contains('open');
    if (isOpen) { children.classList.remove('open'); toggle.classList.remove('open'); }
    else {
      children.classList.add('open'); toggle.classList.add('open');
      if (!loaded) {
        loaded = true; children.innerHTML = '<div class="tree-loader">Loading…</div>';
        try {
          const { folders: sub } = await apiList(folder.prefix);
          children.innerHTML = '';
          if (sub.length === 0) toggle.classList.add('leaf');
          else for (const sf of sub) children.appendChild(makeTreeItem(sf, depth + 1));
        } catch (err) { children.innerHTML = '<div class="tree-loader" style="color:#DC2626">' + esc(err.message) + '</div>'; }
      }
    }
  });
  return item;
}

async function loadFolder(prefix, bypassCache) {
  currentPrefix = prefix; renderBreadcrumb(prefix);
  showListState('<div class="spinner"></div>Loading…');
  document.getElementById('right-count').textContent = '';
  try {
    const { folders, files } = await apiList(prefix, { bypassCache });
    allRows = [
      ...folders.map(f => ({ ...f, _type:'folder' })),
      ...files.map(f => ({ ...f, _type: isImg(f.key) ? 'image' : 'file' })),
    ];
    renderTable();
  } catch (err) { showListState('<span style="color:#DC2626">' + esc(err.message) + '</span>'); }
}

function showListState(html) {
  const table = document.getElementById('content-table');
  const old = table.querySelector('tbody'); if (old) table.removeChild(old);
  document.getElementById('list-state').style.display = '';
  document.getElementById('list-state').innerHTML = html;
}

function isImg(key) {
  return ['jpg','jpeg','png','gif','webp','svg','bmp','tiff','tif','avif','ico'].includes((key.split('.').pop()||'').toLowerCase());
}

function renderTable() {
  const sorted = [...allRows].sort((a, b) => {
    let va, vb;
    if      (sortCol==='name')  { va=(a.name||a.key||'').toLowerCase(); vb=(b.name||b.key||'').toLowerCase(); }
    else if (sortCol==='type')  { va=a._type; vb=b._type; }
    else if (sortCol==='count') { va=a.count??-1; vb=b.count??-1; }
    else if (sortCol==='size')  { va=a.size??-1;  vb=b.size??-1; }
    else if (sortCol==='date')  {
      va=a.latestModified||a.lastModified?new Date(a.latestModified||a.lastModified).getTime():-Infinity;
      vb=b.latestModified||b.lastModified?new Date(b.latestModified||b.lastModified).getTime():-Infinity;
    }
    const cmp = typeof va==='string' ? va.localeCompare(vb,undefined,{numeric:true}) : va-vb;
    return sortAsc ? cmp : -cmp;
  });
  const folders = sorted.filter(r => r._type==='folder');
  const files   = sorted.filter(r => r._type!=='folder');
  if (sorted.length === 0) { showListState('This folder is empty.'); document.getElementById('right-count').textContent='0 items'; return; }
  document.getElementById('list-state').style.display = 'none';
  document.getElementById('right-count').textContent = folders.length + ' folder' + (folders.length!==1?'s':'') + ' · ' + files.length + ' object' + (files.length!==1?'s':'');
  const tbody = document.createElement('tbody');
  for (const f of folders) {
    const tr = document.createElement('tr'); tr.className = 'file-row';
    tr.innerHTML = \`
      <td><svg width="14" height="14" viewBox="0 0 16 16" fill="none"><path d="M1 3.5A1.5 1.5 0 0 1 2.5 2h3.172a1.5 1.5 0 0 1 1.06.44l.829.828A1.5 1.5 0 0 0 8.62 3.75H13.5A1.5 1.5 0 0 1 15 5.25v7.25A1.5 1.5 0 0 1 13.5 14h-11A1.5 1.5 0 0 1 1 12.5v-9Z" fill="#FEF3C7" stroke="#D97706" stroke-width="1"/></svg></td>
      <td><button class="name-link" onclick="drillInto(\${esc(JSON.stringify(f.prefix))})">\${esc(f.name)}</button></td>
      <td><span class="pill folder-pill">Folder</span></td>
      <td class="mono-sm tr">\${f.count!=null?f.count.toLocaleString():'<span class="na">—</span>'}</td>
      <td class="na tr">—</td>
      <td class="mono-sm">\${fmtDate(f.latestModified)}<span class="date-note">latest</span></td>
      <td style="text-align:right;white-space:nowrap"><button class="btn btn-enter" onclick="drillInto(\${esc(JSON.stringify(f.prefix))})">Open →</button></td>
    \`;
    tbody.appendChild(tr);
  }
  for (const f of files) {
    const name = f.key.split('/').pop(); const img = f._type==='image';
    const tr = document.createElement('tr'); tr.className = 'file-row';
    const dlUrl = '/download?bucket='+encodeURIComponent(BUCKET)+'&key='+encodeURIComponent(f.key);
    const nameCell = img ? \`<button class="name-link is-image" onclick="openPreview(\${esc(JSON.stringify(f.key))},\${esc(JSON.stringify(name))},\${esc(JSON.stringify(fmtSize(f.size)))})">\${esc(name)}</button>\`
                        : \`<span class="name-link" style="cursor:default">\${esc(name)}</span>\`;
    const actions = img ? \`<a class="btn btn-preview" onclick="openPreview(\${esc(JSON.stringify(f.key))},\${esc(JSON.stringify(name))},\${esc(JSON.stringify(fmtSize(f.size)))});return false" href="#">Preview</a><a class="btn btn-download" href="\${dlUrl}">↓</a>\`
                        : \`<a class="btn btn-download" href="\${dlUrl}">↓ Download</a>\`;
    tr.innerHTML = \`
      <td>\${img?'<svg width="14" height="14" viewBox="0 0 16 16" fill="none"><rect x="1" y="2" width="14" height="12" rx="1.5" fill="#EFF6FF" stroke="#3B82F6" stroke-width="1"/><circle cx="5" cy="6" r="1.5" fill="#93C5FD"/><path d="M1 11l3.5-3.5 2.5 2.5 2-2 5 5" stroke="#3B82F6" stroke-width="1" stroke-linecap="round"/></svg>':'<svg width="14" height="14" viewBox="0 0 16 16" fill="none"><path d="M3 1.5h7l4 4V14a.5.5 0 0 1-.5.5h-10A.5.5 0 0 1 3 14V2a.5.5 0 0 1 0-.5Z" fill="#F8FAFC" stroke="#CBD5E1" stroke-width="1"/><path d="M10 1.5V5.5H14" stroke="#CBD5E1" stroke-width="1"/></svg>'}</td>
      <td>\${nameCell}</td>
      <td><span class="pill \${img?'image-pill':'file-pill'}">\${img?'Image':'Object'}</span></td>
      <td class="na tr">—</td>
      <td class="mono-sm tr">\${fmtSize(f.size)}</td>
      <td class="mono-sm">\${fmtDate(f.lastModified)}</td>
      <td style="text-align:right;white-space:nowrap">\${actions}</td>
    \`;
    tbody.appendChild(tr);
  }
  const table = document.getElementById('content-table');
  const old = table.querySelector('tbody'); if (old) table.removeChild(old);
  table.appendChild(tbody);
}

function drillInto(prefix) {
  loadFolder(prefix);
  document.querySelectorAll('.tree-item').forEach(item => {
    item.classList.toggle('selected', item.dataset.prefix===prefix);
    if (item.dataset.prefix===prefix) item.scrollIntoView({block:'nearest'});
  });
}
function refreshCurrent() { loadFolder(currentPrefix, true); }
function renderBreadcrumb(prefix) {
  const el = document.getElementById('breadcrumb');
  const parts = prefix.split('/').filter(Boolean);
  let html = \`<span class="crumb\${prefix===''?' active':''}" onclick="loadFolder('')">\${esc(BUCKET)}</span>\`;
  let acc = '';
  parts.forEach((p, i) => {
    acc += p + '/'; const isLast = i===parts.length-1; const cap = acc;
    html += \`<span class="sep">/</span><span class="crumb\${isLast?' active':''}" onclick="loadFolder(\${esc(JSON.stringify(cap))})">\${esc(p)}</span>\`;
  });
  el.innerHTML = html;
}
function sortBy(col) {
  if (sortCol===col) sortAsc=!sortAsc; else { sortCol=col; sortAsc=true; }
  document.querySelectorAll('#sort-thead th').forEach(th => th.classList.remove('sort-active'));
  const colMap = {name:1,type:2,count:3,size:4,date:5};
  if (colMap[col]!==undefined) document.querySelectorAll('#sort-thead th')[colMap[col]]?.classList.add('sort-active');
  ['name','type','count','size','date'].forEach(c => { const el=document.getElementById('si-'+c); if(el) el.textContent=c===sortCol?(sortAsc?'↑':'↓'):'↕'; });
  renderTable();
}
function fmtDate(d) {
  if (!d) return '<span class="na">—</span>';
  return new Intl.DateTimeFormat('en-US',{year:'numeric',month:'short',day:'2-digit',hour:'2-digit',minute:'2-digit',timeZoneName:'short'}).format(new Date(d));
}
function fmtSize(bytes) {
  if (bytes==null||bytes<0) return '—'; if (bytes===0) return '0 B';
  const s=['B','KB','MB','GB','TB']; const i=Math.floor(Math.log(bytes)/Math.log(1024));
  return parseFloat((bytes/Math.pow(1024,i)).toFixed(1))+'\\u00a0'+s[i];
}
function esc(str) { return String(str??'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }

function openPreview(key, name, size) {
  const body = document.getElementById('modal-body');
  document.getElementById('modal-title').textContent = name;
  document.getElementById('modal-meta').textContent = size ? 'Size: ' + size : '';
  document.getElementById('modal-open').href = '/image?bucket='+encodeURIComponent(BUCKET)+'&key='+encodeURIComponent(key);
  document.getElementById('modal-download').href = '/download?bucket='+encodeURIComponent(BUCKET)+'&key='+encodeURIComponent(key);
  body.innerHTML = '<div class="modal-loader"><div class="spinner"></div>Loading…</div>';
  document.getElementById('modal').classList.add('open');
  document.body.style.overflow = 'hidden';
  const img = new Image();
  img.onload = () => { body.innerHTML=''; body.appendChild(img); document.getElementById('modal-meta').textContent=(size?size+'  ·  ':'')+img.naturalWidth+' × '+img.naturalHeight+' px'; };
  img.onerror = () => { body.innerHTML='<p class="modal-error">Failed to load image.<br>Check s3:GetObject permission.</p>'; };
  img.src = '/image?bucket='+encodeURIComponent(BUCKET)+'&key='+encodeURIComponent(key);
  img.style.cssText = 'max-width:100%;max-height:60vh;object-fit:contain;border-radius:6px;box-shadow:0 4px 16px rgba(0,0,0,.1);display:block';
}
function closeModal() { document.getElementById('modal').classList.remove('open'); document.body.style.overflow=''; }
document.addEventListener('keydown', e => { if (e.key==='Escape') closeModal(); });

(function() {
  const handle = document.getElementById('resize-handle');
  const leftPane = document.getElementById('left-pane');
  let dragging = false, startX, startW;
  handle.addEventListener('mousedown', e => { dragging=true; startX=e.clientX; startW=leftPane.offsetWidth; handle.classList.add('dragging'); document.body.style.cursor='col-resize'; document.body.style.userSelect='none'; });
  window.addEventListener('mousemove', e => { if (!dragging) return; leftPane.style.width=Math.max(160,Math.min(600,startW+e.clientX-startX))+'px'; });
  window.addEventListener('mouseup', () => { if (!dragging) return; dragging=false; handle.classList.remove('dragging'); document.body.style.cursor=''; document.body.style.userSelect=''; });
})();

initTree(); renderBreadcrumb('');
</script>
</body></html>`;
}

// ─── Start ────────────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`S3 Browser  http://localhost:${PORT}  |  region: ${REGION}`);
});
