// bake-dem.mjs — Offline DEM baker for the Luxor eclipse flight sim.
//
// Source: AWS Terrain Tiles ("Terrarium" PNG encoding) — open AWS data, NO API key,
// global coverage (Luxor sits at 25.7°N, far outside ArcticDEM). The underlying data
// around Luxor is SRTM (~30 m); we fetch Web-Mercator z13 tiles (~17 m/px here) and
// resample onto the sim's lat/lng grid, so the DEM and the imagery share one frame.
//
// Terrarium decode:  elevation_m = (R*256 + G + B/256) - 32768
//
// Writes two committed assets the runtime loads:
//   ../assets/luxor-height.png    2048² elevation, packed R=high byte / G=low byte
//   ../assets/luxor-height.json   bbox, scale, min/max, landmark local coords
//
// Run once; outputs are committed; never runs at deploy.   cd tools && npm install && npm run bake
//
// Data: © AWS Terrain Tiles (SRTM/GMTED/…); attribution shown at runtime.

import sharp from 'sharp';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// --- Configuration -------------------------------------------------------
// Centred on the Marsam Hotel, Luxor west bank (25.7242244, 32.6064777) — a ~27 km
// square spanning the Nile, both banks, and the Theban hills (Valley of the Kings + al-Qurn).
const CENTER = { lng: 32.6064777, lat: 25.7242244 };
const HALF_LNG = 0.135, HALF_LAT = 0.122;
const BBOX = {
  w: +(CENTER.lng - HALF_LNG).toFixed(6), s: +(CENTER.lat - HALF_LAT).toFixed(6),
  e: +(CENTER.lng + HALF_LNG).toFixed(6), n: +(CENTER.lat + HALF_LAT).toFixed(6),
};
const Z = 13;            // Terrarium tile zoom (~17 m/px at 25.7°N — oversamples the ~30 m SRTM source)
const OUT = 2048;        // output heightmap size (px/side)
const TILE = 256;
const CONCURRENCY = 16;
const tileUrl = (z, x, y) => `https://s3.amazonaws.com/elevation-tiles-prod/terrarium/${z}/${x}/${y}.png`;

// Landmarks (lng, lat) -> emitted as local metres for the runtime spawn/heading/marker.
const SPAWN = { lng: 32.6064777, lat: 25.7242244 }; // Marsam Hotel (map centre / spawn point)
const PEAK  = { lng: 32.6006,    lat: 25.7328    }; // al-Qurn — the pyramid-peak over the Valley of the Kings

// --- Local-metre frame (matches the sim: +x = east, +z = south, origin = bbox centre) ---
const DEG = Math.PI / 180, M_PER_DEG_LAT = 111320;
const centerLat = (BBOX.s + BBOX.n) / 2, centerLng = (BBOX.w + BBOX.e) / 2;
const mPerDegLng = M_PER_DEG_LAT * Math.cos(centerLat * DEG);
const spanMetersX = (BBOX.e - BBOX.w) * mPerDegLng;
const spanMetersZ = (BBOX.n - BBOX.s) * M_PER_DEG_LAT;
const toLocal = ({ lng, lat }) => ({
  x: Math.round((lng - centerLng) * mPerDegLng),
  z: Math.round((centerLat - lat) * M_PER_DEG_LAT),
});

// --- Web Mercator global-pixel helpers (identical maths to the imagery baker) ---
const worldPx = Math.pow(2, Z) * TILE;
const lngToGX = (lng) => (lng + 180) / 360 * worldPx;
const latToGY = (lat) => {
  const s = Math.min(0.9999, Math.max(-0.9999, Math.sin(lat * Math.PI / 180)));
  return (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * worldPx;
};

// Tile range covering the bbox (+1 tile margin so bilinear reads never fall off the edge).
const x0 = Math.floor(lngToGX(BBOX.w) / TILE) - 1, x1 = Math.floor(lngToGX(BBOX.e) / TILE) + 1;
const y0 = Math.floor(latToGY(BBOX.n) / TILE) - 1, y1 = Math.floor(latToGY(BBOX.s) / TILE) + 1;
const cols = x1 - x0 + 1, rows = y1 - y0 + 1;
console.log(`Baking Terrarium z${Z} for ${JSON.stringify(BBOX)} → ${OUT}²`);
console.log(`  tiles x[${x0}..${x1}] y[${y0}..${y1}] = ${cols}×${rows} = ${cols * rows}`);

// --- Fetch + decode every tile to raw RGB --------------------------------
const tiles = new Map(); // "x,y" -> Buffer(TILE*TILE*3)
async function fetchTile(x, y) {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(tileUrl(Z, x, y));
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const rgb = await sharp(Buffer.from(await res.arrayBuffer())).removeAlpha().raw().toBuffer();
      tiles.set(x + ',' + y, rgb);
      return;
    } catch (e) {
      if (attempt === 2) { console.log(`\n  tile ${x},${y} failed (${e.message}) — flat`); tiles.set(x + ',' + y, null); }
    }
  }
}
const jobs = [];
for (let ty = y0; ty <= y1; ty++) for (let tx = x0; tx <= x1; tx++) jobs.push([tx, ty]);
for (let i = 0; i < jobs.length; i += CONCURRENCY) {
  await Promise.all(jobs.slice(i, i + CONCURRENCY).map(([x, y]) => fetchTile(x, y)));
  process.stdout.write(`\r  fetched ${Math.min(i + CONCURRENCY, jobs.length)}/${jobs.length}`);
}
console.log('\n  all tiles in memory');

// Decoded elevation at an integer global pixel (clamped to the fetched tile range).
function elevAt(gx, gy) {
  let tx = Math.min(x1, Math.max(x0, Math.floor(gx / TILE)));
  let ty = Math.min(y1, Math.max(y0, Math.floor(gy / TILE)));
  const t = tiles.get(tx + ',' + ty);
  if (!t) return 0;
  const px = Math.min(TILE - 1, Math.max(0, Math.floor(gx) - tx * TILE));
  const py = Math.min(TILE - 1, Math.max(0, Math.floor(gy) - ty * TILE));
  const o = (py * TILE + px) * 3;
  return (t[o] * 256 + t[o + 1] + t[o + 2] / 256) - 32768; // terrarium decode
}
// Bilinear elevation at a fractional global pixel — smooths the 30 m source.
function elevBilinear(gx, gy) {
  const x0f = Math.floor(gx), y0f = Math.floor(gy), fx = gx - x0f, fy = gy - y0f;
  const a = elevAt(x0f, y0f), b = elevAt(x0f + 1, y0f), c = elevAt(x0f, y0f + 1), d = elevAt(x0f + 1, y0f + 1);
  return (a * (1 - fx) + b * fx) * (1 - fy) + (c * (1 - fx) + d * fx) * fy;
}

// --- Build the height grid (row 0 = north, col 0 = west) -----------------
const heights = new Float32Array(OUT * OUT);
let minE = Infinity, maxE = -Infinity;
for (let py = 0; py < OUT; py++) {
  const gy = latToGY(BBOX.n - (BBOX.n - BBOX.s) * (py + 0.5) / OUT);
  for (let px = 0; px < OUT; px++) {
    const gx = lngToGX(BBOX.w + (BBOX.e - BBOX.w) * (px + 0.5) / OUT);
    let h = elevBilinear(gx, gy);
    if (!isFinite(h)) h = 0;
    heights[py * OUT + px] = h;
    if (h < minE) minE = h;
    if (h > maxE) maxE = h;
  }
}
console.log(`Elevation range: ${minE.toFixed(1)}..${maxE.toFixed(1)} m`);

// Encode: normalise [minE, maxE] to 16 bits, packed R=high / G=low (canvas read-back safe).
const floor = Math.floor(minE), range = (maxE - floor) || 1;
const rgba = Buffer.alloc(OUT * OUT * 4);
for (let i = 0; i < OUT * OUT; i++) {
  const g16 = Math.max(0, Math.min(65535, Math.round(((heights[i] - floor) / range) * 65535)));
  const o = i * 4;
  rgba[o] = (g16 >> 8) & 255; rgba[o + 1] = g16 & 255; rgba[o + 2] = 0; rgba[o + 3] = 255;
}

// --- Write outputs -------------------------------------------------------
const here = dirname(fileURLToPath(import.meta.url));
const assets = resolve(here, '..', 'assets');
mkdirSync(assets, { recursive: true });
await sharp(rgba, { raw: { width: OUT, height: OUT, channels: 4 } }).png().toFile(resolve(assets, 'luxor-height.png'));

const sidecar = {
  // decode: elev = minElevation + ((R<<8 | G) / 65535) * (maxElevation - minElevation)
  encoding: 'rg16-normalized',
  source: 'AWS Terrain Tiles (Terrarium / SRTM), Web-Mercator z' + Z,
  bbox: BBOX,
  size: OUT,
  minElevation: floor,
  maxElevation: Math.round(maxE),
  spanMetersX: Math.round(spanMetersX),
  spanMetersZ: Math.round(spanMetersZ),
  metersPerPixelX: +(spanMetersX / OUT).toFixed(2),
  metersPerPixelY: +(spanMetersZ / OUT).toFixed(2),
  center: { lng: centerLng, lat: centerLat },
  spawn: { ...SPAWN, ...toLocal(SPAWN) },
  peak:  { ...PEAK,  ...toLocal(PEAK)  },
  attribution: 'Elevation © AWS Terrain Tiles · SRTM / NASA / USGS',
};
writeFileSync(resolve(assets, 'luxor-height.json'), JSON.stringify(sidecar, null, 2));

console.log('Wrote assets/luxor-height.png + .json');
console.log(`  Spawn (Marsam) local: ${JSON.stringify(toLocal(SPAWN))}`);
console.log(`  Peak (al-Qurn) local: ${JSON.stringify(toLocal(PEAK))}`);
console.log(`  spanX=${Math.round(spanMetersX)} m  spanZ=${Math.round(spanMetersZ)} m  (${(spanMetersX / OUT).toFixed(1)} m/px)`);
