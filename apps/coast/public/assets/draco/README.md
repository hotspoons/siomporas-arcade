Draco decoder, from `three/examples/jsm/libs/draco`, vendored at the version in package.json.

It lives under `assets/` rather than a `vendor/` of its own for one reason: `scripts/sync-arcade-assets.mjs`
mirrors each game's `public/assets` into the arcade and nothing else, so this is the only path that
resolves both at `localhost:5182` (coast on its own) and at `arcade.siomporas.com/radrun`. Anything
loading a Draco-compressed `.glb` points `DRACOLoader.setDecoderPath` at `/assets/draco/`.

The generated roadside meshes are Draco-compressed because uncompressed they are 83 MB, and a
Cloudflare Worker bundle stops at 64 MiB.
