const fs = require('fs');
const fsp = fs.promises;
const path = require('path');

// Mirrors matteason/live-cloud-maps to local disk so we make one upstream
// request shared across all clients. Source: clouds.matteason.co.uk, CC0,
// modified EUMETSAT data, refreshed every 3 hours upstream.

const UPSTREAM = 'https://clouds.matteason.co.uk/images';
const CACHE_DIR = path.join(__dirname, 'cache');
const POLL_INTERVAL_MS = 30 * 60 * 1000; // 30 min — upstream refreshes every 3 h, this catches it within ~half a cycle.
const ATTRIBUTION = 'Contains modified EUMETSAT data via matteason/live-cloud-maps (CC0)';

const RESOLUTIONS = {
  '1k': '1024x512',
  '2k': '2048x1024',
  '4k': '4096x2048',
  '8k': '8192x4096',
};

const state = {
  // Per-resolution: { etag, lastModified, lastFetchedAt, lastSuccessAt }
  meta: {},
};

function cachePath(res, variant = 'current') {
  const suffix = variant === 'previous' ? '.previous' : '';
  return path.join(CACHE_DIR, `clouds-alpha-${res}${suffix}.png`);
}

async function ensureCacheDir() {
  await fsp.mkdir(CACHE_DIR, { recursive: true });
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

  // Promote current → previous so we always have one good fallback on disk.
  try { await fsp.rename(current, previous); } catch (_) { /* first run */ }
  await fsp.writeFile(tmp, buf);
  await fsp.rename(tmp, current);

  state.meta[resKey] = {
    etag: res.headers.get('etag') || undefined,
    lastModified: res.headers.get('last-modified') || undefined,
    lastFetchedAt: Date.now(),
    lastSuccessAt: Date.now(),
    bytes: buf.length,
  };
  console.log(`[cloudMirror] ${resKey} updated (${buf.length} bytes)`);
  return { ok: true, changed: true };
}

async function pollAll() {
  for (const key of Object.keys(RESOLUTIONS)) {
    await fetchOne(key);
  }
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

module.exports = {
  start,
  stop,
  getCachedFile,
  getMeta,
  ATTRIBUTION,
  RESOLUTIONS,
};
