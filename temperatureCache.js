// Fetches NOAA GFS 2m temperature once per model cycle (~6h), caches to disk.
// Client hits /api/temperature for a single ~350KB JSON response.
// No API key, no rate limits — GFS is public infrastructure.
//
// Requires: eccodes package (provides grib_get_data binary)
//   macOS:  brew install eccodes
//   Docker: apt-get install -y eccodes  (already in Dockerfile)

const fs = require('fs');
const fsp = require('fs').promises;
const path = require('path');
const os = require('os');
const { execFile } = require('child_process');

const CACHE_FILE = path.join(__dirname, 'cache', 'temperature.json');
const GFS_DELAY_MS = 3.5 * 60 * 60 * 1000;  // ~3.5h after run start before available on NOAA servers
const POLL_INTERVAL_MS = 30 * 60 * 1000;      // check for new run every 30min

// Output grid: 0.25° resolution, matches GFS source — no downsample.
// Column ordering: UV=0 on a Three.js SphereGeometry corresponds to lng=-90° (not -180°),
// because three-globe applies rotation.y=-π/2 to tile meshes but standalone spheres don't.
// Starting the texture at lng=-90° (outCol=0) aligns it with the tile-based globe.
const GRID_W = 1440;  // 0.25° resolution
const GRID_H = 721;   // -90° to +90°, 0.25° steps
const LNG_STEP = 0.25; // degrees per output column

// GFS source grid at 0.25° — same dimensions as output
const GFS_W = 1440;  // 0° to 359.75° longitude
const GFS_H = 721;   // 90°N to 90°S latitude

let cache = null;      // { temps: number[], fetchedAt: number, runId: string }
let fetchInFlight = null;

function formatDate(d) {
  return d.toISOString().slice(0, 10).replace(/-/g, '');
}

// Find the most recent GFS run that should be available on NOAA servers.
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

async function fetchGFS(date, hour) {
  // grib-filter returns only the requested variable — no byte-range math, ~500KB response.
  const url = `https://nomads.ncep.noaa.gov/cgi-bin/filter_gfs_0p25.pl` +
    `?file=gfs.t${hour}z.pgrb2.0p25.f000` +
    `&var_TMP=on&lev_2_m_above_ground=on` +
    `&dir=/gfs.${date}/${hour}/atmos`;

  const res = await fetch(url);
  if (!res.ok) throw new Error(`GFS grib-filter HTTP ${res.status} for run ${date}/${hour}`);
  return Buffer.from(await res.arrayBuffer());
}

// Parse grib_get_data text output into a 1440×721 Float32Array (GFS grid order: N→S, 0°→359.75°)
function parseGribGetDataOutput(stdout) {
  const grid = new Float32Array(GFS_W * GFS_H);
  const buf = Buffer.from(stdout);
  let lineStart = 0;
  let pointIdx = 0;
  let headerSkipped = false;

  for (let i = 0; i <= buf.length; i++) {
    if (i === buf.length || buf[i] === 10 /* \n */) {
      if (i > lineStart) {
        const line = buf.slice(lineStart, i).toString().trim();
        if (!headerSkipped) {
          headerSkipped = true;  // skip "Latitude Longitude Value" header
        } else if (line && pointIdx < GFS_W * GFS_H) {
          const lastSpace = line.lastIndexOf(' ');
          const val = parseFloat(line.slice(lastSpace + 1));
          grid[pointIdx++] = isFinite(val) ? val : 273.15;
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

async function decodeGrib2(buffer) {
  const tmpFile = path.join(os.tmpdir(), `gfs_${Date.now()}.grib2`);
  await fsp.writeFile(tmpFile, buffer);

  try {
    const stdout = await new Promise((resolve, reject) => {
      execFile('grib_get_data', ['-F', '%.4g', tmpFile],
        { maxBuffer: 80 * 1024 * 1024 },  // 80MB — 1M lines × ~50 bytes each
        (err, out, stderr) => {
          if (err) reject(new Error(`grib_get_data failed: ${err.message}${stderr ? ' | ' + stderr.trim() : ''}`));
          else resolve(out);
        }
      );
    });

    const gfsGrid = parseGribGetDataOutput(stdout);

    // 1:1 copy from GFS grid — flip N→S to S→N, shift longitude so UV=0 → lng=-90°.
    const out = new Array(GRID_W * GRID_H);
    for (let outRow = 0; outRow < GRID_H; outRow++) {
      const gfsRow = (GRID_H - 1 - outRow);  // flip south-to-north
      for (let outCol = 0; outCol < GRID_W; outCol++) {
        const gfsLng = (((outCol * LNG_STEP - 90) % 360) + 360) % 360;
        const gfsCol = Math.round(gfsLng * 4) % GFS_W;
        const kelvin = gfsGrid[gfsRow * GFS_W + gfsCol];
        out[outRow * GRID_W + outCol] = Math.round((kelvin - 273.15) * 10) / 10;
      }
    }
    return out;
  } finally {
    fsp.unlink(tmpFile).catch(() => {});
  }
}

async function refresh(run) {
  console.log(`[temperature] fetching GFS run ${run.date}/${run.hour}Z...`);
  const buffer = await fetchGFS(run.date, run.hour);
  console.log(`[temperature] downloaded ${(buffer.length / 1024).toFixed(0)}KB, decoding with grib_get_data...`);
  const temps = await decodeGrib2(buffer);
  const runId = `${run.date}/${run.hour}`;
  const fetchedAt = Date.now();
  cache = { temps, fetchedAt, runId };
  await fsp.mkdir(path.dirname(CACHE_FILE), { recursive: true });
  await fsp.writeFile(CACHE_FILE, JSON.stringify({ temps, fetchedAt, runId }));
  console.log(`[temperature] cached ${temps.length} points (run ${runId})`);
  return cache;
}

async function poll() {
  const run = getLatestAvailableRun();
  const runId = `${run.date}/${run.hour}`;
  if (cache && cache.runId === runId) return;
  if (fetchInFlight) return;
  fetchInFlight = refresh(run)
    .catch(err => console.error(`[temperature] fetch failed (${runId}):`, err.message))
    .finally(() => { fetchInFlight = null; });
  await fetchInFlight;
}

function loadDiskCache() {
  try {
    const raw = fs.readFileSync(CACHE_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    const expectedSize = GRID_W * GRID_H;
    if (parsed.temps?.length !== expectedSize) {
      console.log(`[temperature] disk cache grid size mismatch (${parsed.temps?.length} vs ${expectedSize}) — discarding`);
      return;
    }
    cache = parsed;
    console.log(`[temperature] loaded disk cache (run ${cache.runId}, ${cache.temps.length} points)`);
  } catch {
    // No cache yet — first run
  }
}

loadDiskCache();
poll();
const _pollTimer = setInterval(poll, POLL_INTERVAL_MS);

async function getTemperatureGrid() {
  if (cache) return cache;
  if (fetchInFlight) return fetchInFlight;
  fetchInFlight = poll().then(() => {
    if (!cache) throw new Error('Temperature data not yet available — GFS fetch in progress');
    return cache;
  }).finally(() => { fetchInFlight = null; });
  return fetchInFlight;
}

module.exports = { getTemperatureGrid, GRID_W, GRID_H };
