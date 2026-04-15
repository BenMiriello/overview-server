const fs = require('fs');
const fsp = fs.promises;
const path = require('path');

// Mirrors matteason/live-cloud-maps to local disk so we make one upstream
// request shared across all clients. Source: clouds.matteason.co.uk, CC0,
// modified EUMETSAT data, refreshed every 3 hours upstream.

const UPSTREAM = 'https://clouds.matteason.co.uk/images';
const CACHE_DIR = path.join(__dirname, 'cache');
const HISTORY_DIR = path.join(CACHE_DIR, 'clouds-history');
const HISTORY_RES = '4k';
const HISTORY_MS = 72 * 60 * 60 * 1000;
const POLL_INTERVAL_MS = 30 * 60 * 1000;
const ATTRIBUTION = 'Contains modified EUMETSAT data via matteason/live-cloud-maps (CC0)';

const RESOLUTIONS = {
  '1k': '1024x512',
  '2k': '2048x1024',
  '4k': '4096x2048',
  '8k': '8192x4096',
};

const state = {
  meta: {},
};

function cachePath(res, variant = 'current') {
  const suffix = variant === 'previous' ? '.previous' : '';
  return path.join(CACHE_DIR, `clouds-alpha-${res}${suffix}.png`);
}

async function ensureCacheDir() {
  await fsp.mkdir(CACHE_DIR, { recursive: true });
  await fsp.mkdir(HISTORY_DIR, { recursive: true });
}

async function fetchOne(resKey) {
  const dim = RESOLUTIONS[resKey];
  const url = `${UPSTREAM}/${dim}/clouds-alpha.png`;
  const meta = state.meta[resKey] || {};

  const headers = {};
  if (meta.etag) headers['If-None-Match'] = meta.etag;
  if (meta.lastModified) headers['If-Modified-Since'] = meta.lastModified;

  let res;
  try {
    res = await fetch(url, { headers });
  } catch (err) {
    console.error(`[cloudMirror] ${resKey} fetch error:`, err.message);
    return { ok: false };
  }

  if (res.status === 304) {
    state.meta[resKey] = { ...meta, lastFetchedAt: Date.now() };
    return { ok: true, changed: false };
  }
  if (!res.ok) {
    console.error(`[cloudMirror] ${resKey} HTTP ${res.status}`);
    return { ok: false };
  }

  const buf = Buffer.from(await res.arrayBuffer());
  const current = cachePath(resKey, 'current');
  const previous = cachePath(resKey, 'previous');
  const tmp = `${current}.tmp`;

  try { await fsp.rename(current, previous); } catch (_) { /* first run */ }
  await fsp.writeFile(tmp, buf);
  await fsp.rename(tmp, current);

  const lastModified = res.headers.get('last-modified') || undefined;

  state.meta[resKey] = {
    etag: res.headers.get('etag') || undefined,
    lastModified,
    lastFetchedAt: Date.now(),
    lastSuccessAt: Date.now(),
    bytes: buf.length,
  };
  console.log(`[cloudMirror] ${resKey} updated (${buf.length} bytes)`);

  // Save history snapshot for the history resolution
  if (resKey === HISTORY_RES) {
    const ts = lastModified ? new Date(lastModified).getTime() : Date.now();
    // Round to nearest 3 hours to avoid duplicates from polling
    const rounded = Math.round(ts / (3 * 60 * 60 * 1000)) * (3 * 60 * 60 * 1000);
    const histFile = path.join(HISTORY_DIR, `${rounded}.png`);
    try {
      await fsp.access(histFile);
      // Already have this snapshot
    } catch {
      await fsp.writeFile(histFile, buf);
      console.log(`[cloudMirror] history snapshot saved: ${rounded}`);
    }
  }

  return { ok: true, changed: true };
}

async function cleanupHistory() {
  try {
    const files = await fsp.readdir(HISTORY_DIR);
    const cutoff = Date.now() - HISTORY_MS;
    for (const f of files) {
      if (!f.endsWith('.png')) continue;
      const ts = parseInt(f.replace('.png', ''), 10);
      if (!isFinite(ts) || ts < cutoff) {
        await fsp.unlink(path.join(HISTORY_DIR, f)).catch(() => {});
        console.log(`[cloudMirror] cleaned up old history: ${f}`);
      }
    }
  } catch { /* dir may not exist */ }
}

async function pollAll() {
  for (const key of Object.keys(RESOLUTIONS)) {
    await fetchOne(key);
  }
  await cleanupHistory();
}

let pollTimer = null;

async function start() {
  await ensureCacheDir();
  await pollAll();
  pollTimer = setInterval(() => { pollAll().catch(err => console.error('[cloudMirror] poll error:', err)); }, POLL_INTERVAL_MS);
}

function stop() {
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
}

function getCachedFile(resKey, variant = 'current') {
  if (!RESOLUTIONS[resKey]) return null;
  const p = cachePath(resKey, variant);
  if (!fs.existsSync(p)) return null;
  return p;
}

function getMeta(resKey) {
  return state.meta[resKey] || null;
}

async function getCloudFrameList() {
  try {
    const files = (await fsp.readdir(HISTORY_DIR))
      .filter(f => f.endsWith('.png'))
      .sort();
    return files.map(f => ({
      timestamp: parseInt(f.replace('.png', ''), 10),
    }));
  } catch {
    return [];
  }
}

function getCloudFrame(timestamp) {
  const file = path.join(HISTORY_DIR, `${timestamp}.png`);
  if (!fs.existsSync(file)) return null;
  return file;
}

module.exports = {
  start,
  stop,
  getCachedFile,
  getMeta,
  getCloudFrameList,
  getCloudFrame,
  ATTRIBUTION,
  RESOLUTIONS,
};
