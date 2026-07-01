// bake-imagery.mjs — Offline satellite-imagery baker for the Luxor eclipse flight sim.
//
// Fetches Esri World Imagery (open, NO API key) for the Luxor bbox, reprojects the
// Web-Mercator tiles onto the SAME lat/lng grid as the heightmap, and writes
//   ../assets/luxor-imagery.jpg
// a photoreal surface texture the runtime drapes over the terrain mesh — so you fly
// over the real Nile, the green cultivated strip, the desert, and the temple sites.
//
// Run once; output is committed.   cd tools && npm install && npm run imagery
//
// Imagery © Esri, Maxar, Earthstar Geographics (attribution required at runtime).

import sharp from 'sharp';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Identical bbox to the heightmap (Marsam Hotel centre, ~27 km square).
const CENTER = { lng: 32.6064777, lat: 25.7242244 };
const HALF_LNG = 0.135, HALF_LAT = 0.122;
const BBOX = {
  w: +(CENTER.lng - HALF_LNG).toFixed(6), s: +(CENTER.lat - HALF_LAT).toFixed(6),
  e: +(CENTER.lng + HALF_LNG).toFixed(6), n: +(CENTER.lat + HALF_LAT).toFixed(6),
};
const Z = 14;            // Esri tile zoom (~8.6 m/px at 25.7°N)
const OUT = 4096;        // output texture size (px/side)
const TILE = 256;
const CONCURRENCY = 24;
const tileUrl = (z, y, x) =>
  `https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/${z}/${y}/${x}`;

// --- Web Mercator global-pixel helpers -----------------------------------
const worldPx = Math.pow(2, Z) * TILE;
const lngToGX = (lng) => (lng + 180) / 360 * worldPx;
const latToGY = (lat) => {
  const s = Math.min(0.9999, Math.max(-0.9999, Math.sin(lat * Math.PI / 180)));
  return (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * worldPx;
};

// Tile range covering the bbox.
const x0 = Math.floor(lngToGX(BBOX.w) / TILE), x1 = Math.floor(lngToGX(BBOX.e) / TILE);
const y0 = Math.floor(latToGY(BBOX.n) / TILE), y1 = Math.floor(latToGY(BBOX.s) / TILE);
const cols = x1 - x0 + 1, rows = y1 - y0 + 1;
console.log(`Imagery z${Z}: tiles x[${x0}..${x1}] y[${y0}..${y1}] = ${cols}×${rows} = ${cols * rows}`);

// --- Fetch + decode every tile to raw RGB --------------------------------
const tiles = new Map(); // "x,y" -> Buffer(TILE*TILE*3)
async function fetchTile(x, y) {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(tileUrl(Z, y, x));
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const rgb = await sharp(Buffer.from(await res.arrayBuffer())).removeAlpha().raw().toBuffer();
      tiles.set(x + ',' + y, rgb);
      return;
    } catch (e) {
      if (attempt === 2) { console.log(`\n  tile ${x},${y} failed (${e.message}) — black`); tiles.set(x + ',' + y, Buffer.alloc(TILE * TILE * 3)); }
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

// Global-pixel RGB lookup, clamped to the fetched range.
function getPx(gx, gy, out) {
  let tx = Math.min(x1, Math.max(x0, Math.floor(gx / TILE)));
  let ty = Math.min(y1, Math.max(y0, Math.floor(gy / TILE)));
  const t = tiles.get(tx + ',' + ty);
  const px = Math.min(TILE - 1, Math.max(0, Math.floor(gx) - tx * TILE));
  const py = Math.min(TILE - 1, Math.max(0, Math.floor(gy) - ty * TILE));
  const o = (py * TILE + px) * 3;
  out[0] = t[o]; out[1] = t[o + 1]; out[2] = t[o + 2];
}

// --- Resample onto the equirectangular bbox grid (aligns with terrain UVs) ---
const outBuf = Buffer.alloc(OUT * OUT * 3);
const rgb = [0, 0, 0];
for (let py = 0; py < OUT; py++) {
  const gy = latToGY(BBOX.n - (BBOX.n - BBOX.s) * (py + 0.5) / OUT);
  for (let px = 0; px < OUT; px++) {
    getPx(lngToGX(BBOX.w + (BBOX.e - BBOX.w) * (px + 0.5) / OUT), gy, rgb);
    const o = (py * OUT + px) * 3;
    outBuf[o] = rgb[0]; outBuf[o + 1] = rgb[1]; outBuf[o + 2] = rgb[2];
  }
}

const here = dirname(fileURLToPath(import.meta.url));
const outPath = resolve(here, '..', 'assets', 'luxor-imagery.jpg');
await sharp(outBuf, { raw: { width: OUT, height: OUT, channels: 3 } }).jpeg({ quality: 84, mozjpeg: true }).toFile(outPath);
console.log(`Wrote assets/luxor-imagery.jpg (${OUT}²)`);
