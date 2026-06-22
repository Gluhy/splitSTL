# STL Cutter

Cut large STL models into printer-bed-sized pieces, right in your browser, and
auto-generate dowel-pin joints to glue them back together.

**100% client-side** — your model never leaves your machine. No upload, no server.

> The UI is in Polish, but you don't need it to use the tool: load a model,
> click **Zaplanuj cięcia** (Plan cuts), then **Tnij i eksportuj** (Cut & export).

## Features

- **Printer presets** — Bambu Lab (A1 / P1 / X1 / H2D), Prusa, Ender 3, Voron, or a custom build volume.
- **Automatic slicing** — splits the model along X/Y/Z so every piece fits the bed (minus margin).
- **Dowel joints** — auto-places **perpendicular** pins on each seam so the parts actually slide together and align. Pin diameter is auto-fitted to wall thickness; seams too thin for a pin fall back to a flat glue joint.
- **Interactive 3D pin editing** — toggle edit mode to add / move / delete pins on the active cut plane.
- **Mesh auto-repair + diagnostics** — welds duplicate vertices, drops degenerate/duplicate triangles, and fills small holes. If a mesh still isn't a valid 2-manifold, it tells you *why* (boundary edges / non-manifold edges / flipped normals) instead of failing with a cryptic error.
- **Piece numbering** (optional) — engraves each piece's grid index (e.g. `0-1-2`) into a cut face, and shows the same label in the 3D view, so you can tell parts apart and reassemble them.
- **Exploded view** + per-piece "fits / too big" check.
- **ZIP export** — one binary STL per piece.

## Tech

- [three.js](https://threejs.org/) — rendering, STL load/export
- [manifold-3d](https://github.com/elalish/manifold) — robust boolean cutting (WASM)
- [three-mesh-bvh](https://github.com/gkjohnson/three-mesh-bvh) — signed-distance sampling for pin fitting
- [fflate](https://github.com/101arrowz/fflate) — ZIP packing
- [Vite](https://vitejs.dev/) — dev server & build

## Run locally

```bash
npm install
npm run dev      # open the printed localhost URL
```

Build a static bundle (deployable to GitHub Pages, Netlify, etc.):

```bash
npm run build
npm run preview
```

## How it works

1. The model is converted to a watertight `manifold-3d` solid (with auto-repair).
2. A signed-distance field (via a BVH) measures wall thickness around the seams.
3. Cut planes are spaced so each resulting cell fits the build volume.
4. Perpendicular dowel pins are placed where a straight pin fully fits the material, kept clear of where perpendicular cuts intersect.
5. Cutting + pin holes/plugs are done with boolean ops; each piece is exported as STL.

## Limitations

- The input must be a **watertight 2-manifold**. Auto-repair handles minor defects (duplicate verts, small holes); heavily broken meshes (self-intersections, many non-manifold edges) need an external pass first — e.g. Blender's **Voxel Remesh**, Meshmixer **Make Solid**, or Netfabb / slicer "repair".
- Boolean ops run on the main thread, so very large meshes (≫1M triangles) will briefly freeze the UI. Decimate first if needed.
- Tongue-and-groove connectors are experimental; dowel pins are the recommended joint.

## License

[MIT](LICENSE)
