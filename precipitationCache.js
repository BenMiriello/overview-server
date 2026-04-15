// Fetches NOAA GFS precipitation data (rate + type) per model cycle (~6h), caches to disk.
// Keeps 72 hours of history for timeline playback.
// Client hits /api/precipitation for latest, /api/precipitation/frames for frame list,
// /api/precipitation/:runId for a specific historical frame.
//
// Requires: eccodes package (provides grib_get_data binary)
//   macOS:  brew install eccodes
//   Docker: apt-get install -y eccodes  (already in Dockerfile)

const fs = require('fs');
const fsp = require('fs').promises;
const path = require('path');
const os = require('os');
const { execFile } = require('child_process');

const CACHE_DIR = path.join(__dirname, 'cache', 'precipitation');
const GFS_DELAY_MS = 3.5 * 60 * 60 * 1000;
const POLL_INTERVAL_MS = 30 * 60 * 1000;
const HISTORY_MS = 72 * 60 * 60 * 1000;

const GRID_W = 1440;
const GRID_H = 721;
const GRID_SIZE = GRID_W * GRID_H;
const LNG_STEP = 0.25;

const GFS_W = 1440;
const GFS_H = 721;

// Precip type enum matching client
const TYPE_NONE = 0;
const TYPE_RAIN = 1;
const TYPE_SNOW = 2;
const TYPE_ICE  = 3;
const TYPE_FRZR = 4;

let latestCache = null;  // { rates, types, fetchedAt, runId }
let fetchInFlight = null;

function formatDate(d) {
  return d.toISOString().slice(0, 10).replace(/-/g, '');
}

function runIdToFilename(runId) {
  return runId.replace('/', '_') + '.json';
}

function filenameToRunId(filename) {
  return filename.replace('.json', '').replace('_', '/');
}

function getLatestAvailableRun() {
  const now = new Date();
  for (const cycleH of [18, 12, 6, 0]) {
    const cycleTime = new Date(now);
    cycleTime.setUTCHours(cycleH, 0, 0, 0);
    if (cycleTime > now) cycleTime.setUTCDate(cycleTime.getUTCDate() - 1);
    if (now - cycleTime >= GFS_DELAY_MS) {
      return { date: formatDate(cycleTime), hour: String(cycleH).padStart(2, '0') };
    }
  }
  const yesterday = new Date(now);
  yesterday.setUTCDate(yesterday.getUTCDate() - 1);
  return { date: formatDate(yesterday), hour: '18' };
}

// Derive a UTC timestamp from a runId like "20260414/18"
function runIdToTimestamp(runId) {
  const [dateStr, hour] = runId.split('/');
  const y = dateStr.slice(0, 4);
  const m = dateStr.slice(4, 6);
  const d = dateStr.slice(6, 8);
  return new Date(`${y}-${m}-${d}T${hour}:00:00Z`).getTime();
}

async function fetchGFS(date, hour) {
  const url = `https://nomads.ncep.noaa.gov/cgi-bin/filter_gfs_0p25.pl` +
    `?file=gfs.t${hour}z.pgrb2.0p25.f000` +
    `&var_PRATE=on&var_CRAIN=on&var_CSNOW=on&var_CICEP=on&var_CFRZR=on` +
    `&lev_surface=on` +
    `&dir=/gfs.${date}/${hour}/atmos`;

  const res = await fetch(url);
  if (!res.ok) throw new Error(`GFS grib-filter HTTP ${res.status} for run ${date}/${hour}`);
  return Buffer.from(await res.arrayBuffer());
}

function parseGribField(stdout) {
  const grid = new Float32Array(GFS_W * GFS_H);
  const buf = Buffer.from(stdout);
  let lineStart = 0;
  let pointIdx = 0;
  let headerSkipped = false;

  for (let i = 0; i <= buf.length; i++) {
    if (i === buf.length || buf[i] === 10) {
      if (i > lineStart) {
        const line = buf.slice(lineStart, i).toString().trim();
        if (!headerSkipped) {
          headerSkipped = true;
        } else if (line && pointIdx < GFS_W * GFS_H) {
          const lastSpace = line.lastIndexOf(' ');
          const val = parseFloat(line.slice(lastSpace + 1));
          grid[pointIdx++] = isFinite(val) ? val : 0;
        }
      }
      lineStart = i + 1;
    }
  }

  if (pointIdx !== GFS_W * GFS_H) {
    throw new Error(`grib_get_data: expected ${GFS_W * GFS_H} points, got ${pointIdx}`);
  }
  return grid;
}

function extractGribField(tmpFile, shortName) {
  return new Promise((resolve, reject) => {
    execFile('grib_get_data', ['-w', `shortName=${shortName}`, '-F', '%.4g', tmpFile],
      { maxBuffer: 80 * 1024 * 1024 },
      (err, out, stderr) => {
        if (err) reject(new Error(`grib_get_data (${shortName}) failed: ${err.message}${stderr ? ' | ' + stderr.trim() : ''}`));
        else resolve(parseGribField(out));
      }
    );
  });
}

// Transform GFS grid: flip N→S to S→N, shift longitude so UV=0 → lng=-90°.
// For rates: convert kg/m²/s → mm/h (×3600), round to 0.1.
// For types: derive from categorical flags.
function transformGrids(prateGfs, crainGfs, csnowGfs, cicepGfs, cfrzrGfs) {
  const rates = new Array(GRID_SIZE);
  const types = new Array(GRID_SIZE);

  for (let outRow = 0; outRow < GRID_H; outRow++) {
    const gfsRow = (GRID_H - 1 - outRow);
    for (let outCol = 0; outCol < GRID_W; outCol++) {
      const gfsLng = (((outCol * LNG_STEP - 90) % 360) + 360) % 360;
      const gfsCol = Math.round(gfsLng * 4) % GFS_W;
      const idx = gfsRow * GFS_W + gfsCol;
      const outIdx = outRow * GRID_W + outCol;

      const rateKg = prateGfs[idx];
      const rateMmH = Math.round(rateKg * 3600 * 10) / 10;
      rates[outIdx] = rateMmH;

      // Derive type from categorical flags (priority: snow > ice > freezing rain > rain)
      if (rateMmH < 0.1) {
        types[outIdx] = TYPE_NONE;
      } else if (csnowGfs[idx] > 0.5) {
        types[outIdx] = TYPE_SNOW;
      } else if (cicepGfs[idx] > 0.5) {
        types[outIdx] = TYPE_ICE;
      } else if (cfrzrGfs[idx] > 0.5) {
        types[outIdx] = TYPE_FRZR;
      } else if (crainGfs[idx] > 0.5) {
        types[outIdx] = TYPE_RAIN;
      } else {
        types[outIdx] = TYPE_RAIN; // fallback: if rate > 0.1 but no flag, assume rain
      }
    }
  }

  return { rates, types };
}

async function decodeGrib2(buffer) {
  const tmpFile = path.join(os.tmpdir(), `gfs_precip_${Date.now()}.grib2`);
  await fsp.writeFile(tmpFile, buffer);

  try {
    const [prateGfs, crainGfs, csnowGfs, cicepGfs, cfrzrGfs] = await Promise.all([
      extractGribField(tmpFile, 'prate'),
      extractGribField(tmpFile, 'crain'),
      extractGribField(tmpFile, 'csnow'),
      extractGribField(tmpFile, 'cicep'),
      extractGribField(tmpFile, 'cfrzr'),
    ]);

    return transformGrids(prateGfs, crainGfs, csnowGfs, cicepGfs, cfrzrGfs);
  } finally {
    fsp.unlink(tmpFile).catch(() => {});
  }
}

async function saveFrame(runId, rates, types, fetchedAt) {
  await fsp.mkdir(CACHE_DIR, { recursive: true });
  const filename = runIdToFilename(runId);
  const filepath = path.join(CACHE_DIR, filename);
  const data = { rates, types, fetchedAt, runId };
  await fsp.writeFile(filepath, JSON.stringify(data));
  return data;
}

async function cleanupOldFrames() {
  try {
    const files = await fsp.readdir(CACHE_DIR);
    const cutoff = Date.now() - HISTORY_MS;
    for (const f of files) {
      if (!f.endsWith('.json')) continue;
      const runId = filenameToRunId(f);
      const ts = runIdToTimestamp(runId);
      if (ts < cutoff) {
        await fsp.unlink(path.join(CACHE_DIR, f)).catch(() => {});
        console.log(`[precipitation] cleaned up old frame: ${runId}`);
      }
    }
  } catch {
    // cache dir may not exist yet
  }
}

async function refresh(run) {
  const runId = `${run.date}/${run.hour}`;
  console.log(`[precipitation] fetching GFS run ${runId}...`);
  const buffer = await fetchGFS(run.date, run.hour);
  console.log(`[precipitation] downloaded ${(buffer.length / 1024).toFixed(0)}KB, decoding 5 fields...`);
  const { rates, types } = await decodeGrib2(buffer);
  const fetchedAt = Date.now();
  const frame = await saveFrame(runId, rates, types, fetchedAt);
  console.log(`[precipitation] cached ${rates.length} points (run ${runId})`);
  return frame;
}

// Enumerate all GFS cycles that should exist within the history window.
// Returns oldest-first: [{ date, hour, runId }, ...]
function getExpectedCycles() {
  const now = Date.now();
  const cutoff = now - HISTORY_MS;
  const cycles = [];
  // Walk backwards from the latest available run in 6-hour steps
  const latest = getLatestAvailableRun();
  const latestTs = runIdToTimestamp(`${latest.date}/${latest.hour}`);
  for (let ts = latestTs; ts >= cutoff; ts -= 6 * 60 * 60 * 1000) {
    // Only include cycles old enough to be available on NOMADS
    if (now - ts < GFS_DELAY_MS) continue;
    const d = new Date(ts);
    cycles.push({
      date: formatDate(d),
      hour: String(d.getUTCHours()).padStart(2, '0'),
      runId: `${formatDate(d)}/${String(d.getUTCHours()).padStart(2, '0')}`,
    });
  }
  return cycles.reverse();
}

async function fetchIfMissing(cycle) {
  const filepath = path.join(CACHE_DIR, runIdToFilename(cycle.runId));
  try {
    await fsp.access(filepath);
    return false; // already on disk
  } catch {
    // missing — fetch it
  }
  const frame = await refresh(cycle);
  // Don't overwrite latestCache if this is a historical backfill
  const latest = getLatestAvailableRun();
  const latestRunId = `${latest.date}/${latest.hour}`;
  if (cycle.runId === latestRunId) {
    latestCache = frame;
  }
  return true;
}

async function backfillMissing() {
  const cycles = getExpectedCycles();
  let filled = 0;
  for (const cycle of cycles) {
    try {
      if (await fetchIfMissing(cycle)) filled++;
    } catch (err) {
      console.error(`[precipitation] backfill ${cycle.runId} failed:`, err.message);
    }
  }
  if (filled > 0) {
    console.log(`[precipitation] backfilled ${filled} missing frame(s)`);
  }
}

async function poll() {
  if (fetchInFlight) return;

  fetchInFlight = (async () => {
    // 1. Ensure latest frame is current
    const run = getLatestAvailableRun();
    const runId = `${run.date}/${run.hour}`;

    if (!latestCache || latestCache.runId !== runId) {
      const filepath = path.join(CACHE_DIR, runIdToFilename(runId));
      try {
        await fsp.access(filepath);
        const raw = await fsp.readFile(filepath, 'utf8');
        const parsed = JSON.parse(raw);
        if (parsed.rates?.length === GRID_SIZE) {
          latestCache = parsed;
          console.log(`[precipitation] loaded from disk cache (run ${runId})`);
        }
      } catch {
        try {
          latestCache = await refresh(run);
        } catch (err) {
          console.error(`[precipitation] fetch failed (${runId}):`, err.message);
        }
      }
    }

    // 2. Backfill any missing historical frames
    await backfillMissing();

    // 3. Clean up frames older than the history window
    await cleanupOldFrames();
  })().finally(() => { fetchInFlight = null; });

  await fetchInFlight;
}

function loadLatestDiskCache() {
  try {
    const files = fs.readdirSync(CACHE_DIR).filter(f => f.endsWith('.json')).sort();
    if (files.length === 0) return;
    const latest = files[files.length - 1];
    const raw = fs.readFileSync(path.join(CACHE_DIR, latest), 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed.rates?.length === GRID_SIZE) {
      latestCache = parsed;
      console.log(`[precipitation] loaded disk cache (run ${parsed.runId}, ${parsed.rates.length} points)`);
    }
  } catch {
    // No cache yet
  }
}

loadLatestDiskCache();
poll();
const _pollTimer = setInterval(poll, POLL_INTERVAL_MS);

async function getLatestFrame() {
  if (latestCache) return latestCache;
  if (fetchInFlight) return fetchInFlight;
  fetchInFlight = poll().then(() => {
    if (!latestCache) throw new Error('Precipitation data not yet available — GFS fetch in progress');
    return latestCache;
  }).finally(() => { fetchInFlight = null; });
  return fetchInFlight;
}

async function getFrameList() {
  try {
    const files = (await fsp.readdir(CACHE_DIR)).filter(f => f.endsWith('.json')).sort();
    return files.map(f => {
      const runId = filenameToRunId(f);
      return {
        runId,
        timestamp: runIdToTimestamp(runId),
      };
    });
  } catch {
    return [];
  }
}

async function getFrame(runId) {
  const filepath = path.join(CACHE_DIR, runIdToFilename(runId));
  const raw = await fsp.readFile(filepath, 'utf8');
  const parsed = JSON.parse(raw);
  if (parsed.rates?.length !== GRID_SIZE) {
    throw new Error(`Frame ${runId} has wrong grid size: ${parsed.rates?.length}`);
  }
  return parsed;
}

module.exports = { getLatestFrame, getFrameList, getFrame, GRID_W, GRID_H };
