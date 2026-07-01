# luxor · eclipse flight

A single-file WebGL flight simulator: fly the **real Theban west bank of Luxor, Egypt** — the Nile,
the cultivated valley, the Valley of the Kings, and the pyramid-peak of **al-Qurn** — while a total
solar eclipse sweeps the desert to totality. Three.js (r128, via CDN), no build step.

Built in the house style of the Iceland *hellissandur · eclipse flight* sim, retargeted to a desert:
same chase-cam flight + real-DEM terrain + baked satellite imagery + corner minimap, but with a global
elevation source (Luxor is at 25.7°N, far outside ArcticDEM) and a desert-appropriate totality.

## What's real here

The terrain is genuine topography, not procedural noise. Elevation comes from **AWS Terrain Tiles**
(Terrarium encoding, SRTM source ~30 m), baked once into a compact heightmap that drives **both** the
terrain mesh and the flight collision, so they can never disagree:

- the sharp escarpment where the green Nile valley (~41 m) steps up into the desert plateau,
- the dendritic wadis of the Theban hills / Valley of the Kings,
- **al-Qurn** (~420 m, "the Horn") — the natural pyramid you spawn pointed toward.

The **surface** is real too: **Esri World Imagery** is baked into a texture and draped over the terrain,
so you fly over photographic Luxor — the Nile, the green cultivated strip, the desert, the temple sites.
(If that texture ever fails to load, the sim falls back to an elevation colour-ramp, so it always works.)

You spawn over the **Marsam Hotel** (25.7242° N, 32.6065° E) on the west bank, nose pointed at al-Qurn.

The eclipse: no aurora at 25°N — instead the desert's signature **360° "false sunset"** rings the horizon
in copper as the moon's shadow rushes in, stars come out, and the corona blazes. (Luxor sits near the
centreline of the total solar eclipse of **2 August 2027** — one of the longest of the century.)

## Controls

↑ ↓ pitch · ← → bank · W / S throttle · space boost · E hasten eclipse · R reset
(mobile: drag anywhere to steer)

## Run locally

The sim fetches `assets/*` and reads the heightmap pixels back from a canvas, so it **must be served
over HTTP** — opening the file with `file://` fails on fetch/CORS. From this folder:

```
python3 -m http.server 8000
# then open http://localhost:8000/
```

## Repository layout

```
index.html                    the whole sim (HTML + CSS + Three.js)
assets/luxor-height.png        baked elevation, 2048², 16-bit packed into R (high) / G (low)
assets/luxor-height.json       sidecar: bbox, scale, min/max, landmark local coords, attribution
assets/luxor-imagery.jpg       baked Esri satellite imagery (4096²), draped on the terrain
assets/favicon.svg             eclipse mark
tools/bake-dem.mjs             offline DEM baker (AWS Terrain Tiles → heightmap; run once, output committed)
tools/bake-imagery.mjs         offline imagery baker (Esri World Imagery → texture)
tools/package.json             bake-only dev dep (sharp)
```

## Re-baking (optional)

Only needed to change the area, resolution, or data source. The outputs are committed, so the deployed
site never bakes anything.

```
cd tools && npm install
npm run bake       # DEM  -> assets/luxor-height.png + .json
npm run imagery    # Esri -> assets/luxor-imagery.jpg
```

To move the map, edit `CENTER` / `HALF_LNG` / `HALF_LAT` (identical in both bakers) and the `SPAWN` /
`PEAK` landmarks in `bake-dem.mjs`, then re-run both bakes.

## Notes / next steps

- No festival marker yet (deliberately). The minimap shows a neutral peak pin at al-Qurn + your position.
- Re-hosting baked Esri tiles is an Esri-ToS grey area; for a public deploy, consider swapping to free
  EOX Sentinel-2 cloudless imagery.
- Intended to be merged with the Iceland *eclipse-flight* project later as a second location.

## Attribution

Imagery © Esri, Maxar, Earthstar Geographics · Elevation © AWS Terrain Tiles (SRTM / NASA / USGS)
