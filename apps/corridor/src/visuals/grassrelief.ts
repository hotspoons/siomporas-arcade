// GROUND-PLANE GRASS UNDERLAYMENT — a camera-oriented bump/"displacement" turf, not cards, not
// geometry, no physical input.
//
// The idea (Rich, 2026-10-03): the ground itself carries a dense, light-reactive, ORIENTATION-AWARE
// grass surface that sits UNDER the real 3D blades and gives the field its mass — the 3D blades
// give the silhouette over the top, the shader fills in the spareness so we never draw hundreds of
// thousands of blades.
//
// ORIENTATION. A blade is a ridge that runs AWAY from the driver, so under the ground plane's
// perspective it projects as a vertical stroke up the screen instead of a line lying flat. The
// pattern frame is the camera's own horizontal frame (right, forward), taken from the view matrix,
// so it turns with the driver — but its ORIGIN stays in the world, so the grass does not ride the
// car. uGRAlign blends from a fixed world axis (0) to the camera axis (1).
//
// LIGHTING. A fragment shader cannot draw above its own pixel, so the blade is given a WORLD-space
// surface normal instead — mostly up, tilted toward the driver — and the strip overrides the
// material normal with it. The scene's own lights (sun, sky, headlights) then shade it as relief.
//
// DEPTH. A 0.2 m blade at 20 m has a ~5 m ground footprint at eye height, so we walk depth toward
// the camera testing the height field (a short parallax walk, 8 steps) — cheap, and it is what
// makes a blade read as standing on the ground rather than painted into it.
import * as THREE from 'three'
import * as T from '../tuning'

/** Read by the strip material while GRASS_GROUND is 1. */
export const grassReliefUniforms = {
  uGROn: { value: 0 },
  /** blades per metre, across the view (the cell rate) */
  uGRScale: { value: 9 },
  /** blade height (m): how far the normal tilts and how far the parallax walks */
  uGRHeight: { value: 0.28 },
  /** blades per cell — real density */
  uGRDensity: { value: 3 },
  /** blade width × */
  uGRThick: { value: 1 },
  uGRWind: { value: 1 },
  uGRTime: { value: 0 },
  /** 0 = blades keep a fixed world axis; 1 = their ridges run away from the driver */
  uGRAlign: { value: 1 },
  /** metres: past this the photo turf takes over and the relief is not evaluated at all */
  uGRFar: { value: 60 },
  /** cos(half-angle) of the forward cone inside which the relief is drawn */
  uGRCone: { value: Math.cos((60 * Math.PI) / 180) },
  /** meters: a full circle of relief this close, so looking down or to the side still has it */
  uGRNear: { value: 14 },
  /** per-cell extra root offset, as a fraction of a cell (0.6 lets roots cross cell borders) */
  uGRJitter: { value: 0.6 },
  /** per-blade lean spread in radians (scaled down for long blades) */
  uGRSpread: { value: 3 },
  /** blade width in metres — world, so GRASS_SHADER_SCALE only changes density */
  uGRWidth: { value: 0.006 },
  /** tip taper 0..1 for mown (short) and rough (long) grass: 0 = cut flat, 1 = needle point */
  uGRTaperShort: { value: 0.25 },
  uGRTaperLong: { value: 0.95 },
  /** dark/light spread of the turf */
  uGRContrast: { value: 1.2 },
  uGRBase: { value: new THREE.Color(0x2f4a1e) },
  uGRTip: { value: new THREE.Color(0x8fae55) },
  uGRDry: { value: 0.3 },
}

/** The season's base/tip/dry, handed in by grass.ts so relief and blades grade alike. */
export function grassReliefLook(base: THREE.Color, tip: THREE.Color, dry: number): void {
  ;(grassReliefUniforms.uGRBase.value as THREE.Color).copy(base)
  ;(grassReliefUniforms.uGRTip.value as THREE.Color).copy(tip)
  grassReliefUniforms.uGRDry.value = dry
}

/**
 * The static half: the clock and the four unified shape controls, plus the type multipliers so
 * bermuda and wheat read differently here too.
 */
export function grassReliefTick(t: number, typeLook?: { height: number; width: number; density: number }): void {
  const on = T.grassGround() === 1 ? 1 : 0
  grassReliefUniforms.uGROn.value = on
  grassReliefUniforms.uGRScale.value = T.GRASS_SHADER_SCALE
  grassReliefUniforms.uGRHeight.value = 0.28 * T.GRASS_HEIGHT * (typeLook?.height ?? 1)
  // ×3 so the shader field and the relief read the same "blades per cell" as the 3D blades' density
  grassReliefUniforms.uGRDensity.value = T.GRASS_DENSITY * 4 * (typeLook?.density ?? 1)
  grassReliefUniforms.uGRThick.value = T.GRASS_THICK * (typeLook?.width ?? 1)
  grassReliefUniforms.uGRWind.value = T.GRASS_WIND / 0.45
  grassReliefUniforms.uGRAlign.value = T.GRASS_ALIGN
  grassReliefUniforms.uGRFar.value = T.GRASS_SHADER_RADIUS
  grassReliefUniforms.uGRCone.value = Math.cos((T.GRASS_SHADER_CONE * Math.PI) / 180)
  grassReliefUniforms.uGRNear.value = T.GRASS_SHADER_NEAR
  grassReliefUniforms.uGRJitter.value = T.GRASS_SHADER_JITTER
  grassReliefUniforms.uGRSpread.value = T.GRASS_SHADER_SPREAD
  grassReliefUniforms.uGRWidth.value = T.GRASS_RELIEF_WIDTH
  grassReliefUniforms.uGRTaperShort.value = T.GRASS_TAPER_SHORT
  grassReliefUniforms.uGRTaperLong.value = T.GRASS_TAPER_LONG
  grassReliefUniforms.uGRContrast.value = T.GRASS_CONTRAST
  grassReliefUniforms.uGRTime.value = t
}

/**
 * The turf function. Called from the strip's `map_fragment` with the world position and the
 * surface->eye vector. Returns albedo; writes coverage and a WORLD-space normal.
 */
export const GRASS_RELIEF_PARS = /* glsl */ `
uniform float uGROn;
uniform float uGRScale;
uniform float uGRHeight;
uniform float uGRDensity;
uniform float uGRThick;
uniform float uGRWind;
uniform float uGRTime;
uniform float uGRAlign;
uniform float uGRFar;
uniform float uGRCone;
uniform float uGRNear;
uniform float uGRJitter;
uniform float uGRSpread;
uniform float uGRWidth;
uniform float uGRTaperShort;
uniform float uGRTaperLong;
uniform float uGRContrast;
uniform vec3 uGRBase;
uniform vec3 uGRTip;
uniform float uGRDry;

float grh(vec2 p) {
  // Hoskins hash: the previous one used rational multipliers (123.34 = 6167/50, 345.45 = 6909/20),
  // so it repeated EXACTLY every 50 cells in x and 20 in y — a visible tiling that no jitter could
  // hide. 0.1031/0.1030 have no such short period.
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

// One hash, two independent values. Replaces pairs of grh() calls, which were the single biggest
// per-fragment cost (six hashes per blade, five blades, nine cells).
vec2 grh2(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * vec3(0.1031, 0.1030, 0.0973));
  p3 += dot(p3, p3.yzx + 33.33);
  return fract(vec2((p3.x + p3.y) * p3.z, (p3.y + p3.z) * p3.x));
}

// Smooth value noise, for the CLUMP field below. grh is white noise (neighbouring cells are
// uncorrelated), which is exactly wrong for clumps: interpolating four corners gives a field that
// varies over a few cells.
float grv(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  float a = grh(i), b = grh(i + vec2(1.0, 0.0)), c = grh(i + vec2(0.0, 1.0)), d = grh(i + vec2(1.0, 1.0));
  return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}

// A world-stable tuft field. Every grid cell holds one (or a few) blades ROOTED at a fixed world
// spot; only a blade's LEAN turns with the driver — its ridge runs radially from the camera to that
// blade's own root — so under the ground's perspective it stands up as a stroke. Because the root
// never moves, the grass does not slide under the car; turning only pivots each blade about its
// root. lenC is the blade's ground footprint in cells and is handed in by the caller: it grows
// with the view angle (short from above, long at grazing), which is the height cue, times the
// length control. fragRad is the fragment's own away-from-driver direction, so every blade near it
// leans about the same way. Returns coverage; writes the tip fraction and a seed.
float grH(vec2 p, float s, float lenC, float taper, vec2 fragRad, float clump, float bCap, out float tip, out float seed) {
  vec2 ip = floor(p), fp = fract(p);
  float best = 0.0;
  tip = 0.0;
  seed = 0.0;
  // Base lean once per fragment, not per blade. The per-blade variation is a small rotation, done
  // with a polynomial instead of atan()+cos()+sin() — those transcendentals, five per blade over
  // nine cells, were a large slice of the fragment time.
  vec2 lean0 = normalize(mix(vec2(0.0, 1.0), fragRad, uGRAlign) + vec2(1e-4, 0.0));
  float spread = uGRSpread / (1.0 + lenC * 0.6);
  float swayT = uGRTime * 0.2069; // ~ same rate as the old sin(uGRTime * 1.3)
  for (int y = -1; y <= 1; y++) {
    for (int x = -1; x <= 1; x++) {
      vec2 o = vec2(float(x), float(y));
      vec2 cc = ip + o;
      // clumpy density: each cell holds a different number of blades, so the field is not an even
      // grid — some cells are bare, some are thick. cellFill is white noise, which only makes the
      // field speckled; clump is a low-frequency field (from grRelief) that groups the cells into
      // tufts with thinner ground between, which is what stops a dense field reading as noise.
      float cellFill = (0.45 + 1.1 * grh(cc + vec2(127.3, 71.9))) * clump;
      for (int i = 0; i < 5; i++) {
        float fi = float(i);
        // SUB-PIXEL LOD: once a blade is under a pixel its albedo is pulled toward the mean further
        // down anyway, so evaluating 5 of them per cell is wasted work. Cap the count by the blade's
        // on-screen size — full near, a few at half a pixel, one when it is a sliver. The rest of the
        // field (root scatter, lean, clump) is unchanged, so this costs nothing visually.
        if (fi < min(uGRDensity * cellFill, bCap)) {
          // TWO packed hashes per blade, not six: r1 = root x,y; r2 = length, lean angle. Width and
          // seed are cheap decorrelated folds of those, which the eye cannot tell from fresh noise.
          vec2 r1 = grh2(cc + vec2(fi * 17.3, fi * 23.1));
          vec2 r2 = grh2(cc + vec2(fi * 31.7, fi * 11.9) + 5.0);
          float h5 = fract(r2.x * 7.31 + 0.37);
          float h6 = fract(r2.y * 3.17 + 0.61);
          // ORIGINS RANDOM IN X AND Y. One root per cell is still a lattice; scatter each root over
          // a cell-and-a-half and let roots cross borders (the 3×3 search still finds them), so the
          // point set has no characteristic spacing. uGRJitter 0 = inside the cell, 1 = ±1.5 cells.
          vec2 root = o + vec2(0.5) + (r1 - 0.5) * (1.0 + 1.5 * uGRJitter);
          // lean away from the driver — mostly radial, with a length-scaled spread: short blades may
          // point anywhere, long blades stay near the ray. Small-angle polynomial rotation.
          float th = (r2.y - 0.5) * spread;
          float ct = 1.0 - 0.5 * th * th;
          float st = th * (1.0 - 0.1666667 * th * th);
          vec2 lean = vec2(lean0.x * ct - lean0.y * st, lean0.x * st + lean0.y * ct);
          vec2 side = vec2(lean.y, -lean.x);
          // a little sway, per blade; triangle wave, no sin()
          float tri = abs(fract(swayT + r1.x) * 2.0 - 1.0) * 2.0 - 1.0;
          root += side * (tri * 0.06 * uGRWind);
          vec2 d = fp - root;
          float along = dot(d, lean);
          float across = dot(d, side);
          // LENGTH: a broad mix of stubble and tall blades, the tall ones with brighter tips
          float len = lenC * mix(0.15, 2.2, r2.x * r2.x);
          // WIDTH IN METRES, not cells. In cells a bigger GRASS_SHADER_SCALE shrank the blade in the
          // world until it aliased to noise, and a smaller one widened it until blades merged into
          // flat patches. World width makes the scale mean only "blades per metre".
          float w = uGRWidth * uGRThick * (0.6 + 0.8 * h5) * s;
          float t = clamp(along / max(len, 1e-3), 0.0, 1.0);
          // TAPER: narrow the blade toward its tip. taper 0 = parallel sides (freshly cut), 1 = a
          // needle point. Short (mown) and long (rough) grass pass different values.
          float tw = max(w * mix(1.0, max(0.0, 1.0 - t), taper), w * 0.08);
          float prof = (1.0 - smoothstep(tw, tw + w * 1.3, abs(across)))
                     * smoothstep(-0.03, 0.08, along)
                     * (1.0 - smoothstep(mix(0.85, 0.45, taper), 1.0, t));
          if (prof > best) { best = prof; tip = t; seed = fract(r1.x + h6 * 0.37); }
        }
      }
    }
  }
  return best;
}

vec3 grRelief(vec3 world, vec3 V, float rough, out float cov, out vec3 nrm) {
  float s = uGRScale * (0.85 + 0.4 * rough);
  // CLUMP. A low-frequency density field at roughly 1.5 m, in WORLD space so it does not move with
  // GRASS_SHADER_SCALE. Blades gather into tufts and thinner ground shows between, which is what
  // keeps a dense field from reading as uniform speckle.
  float clump = 0.3 + 1.5 * grv(world.xz * 0.7 + 11.3);
  float clumpN = clamp((clump - 0.3) / 1.5, 0.0, 1.0);

  // the fragment's own radial from the driver: the walk to find a covering blade goes toward them
  vec2 rel = world.xz - cameraPosition.xz;
  float D = length(rel);
  vec2 rad = D > 1e-3 ? rel / D : vec2(0.0, 1.0);
  float camH = max(0.4, cameraPosition.y - world.y);
  float bladeH = max(0.04, uGRHeight);
  // HEIGHT CUE. A vertical blade of height h at horizontal distance D and camera height camH has a
  // ground footprint L = D*h/(camH-h): nothing straight down, long at grazing. That is the whole
  // length control — GRASS_HEIGHT drives it and there is no separate multiplier to fight. The clamp
  // only bounds the parallax walk.
  float Lworld = D * bladeH / max(0.15, camH - bladeH);
  float lenC = clamp(Lworld * s, 0.6, 12.0);
  // short (mown) grass is cut flat; long (rough) grass tapers to a point — independently
  float taper = mix(uGRTaperShort, uGRTaperLong, rough);

  // SUB-PIXEL LOD, computed once and reused by the anti-stipple below. bladePx is the blade's
  // on-screen width in pixels; when it is a fraction of a pixel the field is being averaged anyway.
  float worldPx = max(length(fwidth(world.xz)), 1e-5);
  float bladePx = (uGRWidth * uGRThick) / worldPx;
  float bCap = bladePx > 0.8 ? 5.0 : (bladePx > 0.35 ? 3.0 : 1.0);

  // 2-D RANDOM ROOTS. One full-jitter root per cell, with an extra per-cell offset (uGRJitter) that
  // lets roots cross cell borders, so the field is not a lattice. The offset is per owning cell, so
  // there is no seam — unlike warping the lookup coordinate.
  vec2 p0 = world.xz * s;

  // NO PARALLAX MARCH. The old loop started layer at 0 and broke on h >= layer, which is always
  // true, so it evaluated grH exactly once every time — the walk never walked. The height cue comes
  // from lenC (the blade's ground footprint), which already stretches with the view angle, so we
  // sample the field once and skip the dead loop and its per-step cost. hit now distinguishes a
  // real blade from bare turf, which the old always-zero hit never did.
  float tip = 0.0, seed = 0.0;
  float h = grH(p0, s, lenC, taper, rad, clump, bCap, tip, seed);
  float hit = h > 0.0 ? 1.0 : -1.0;

  // BLADE NORMAL: mostly up so the sun and sky catch it, leaning toward the driver enough that the
  // light reads it as relief rather than as flat ground. World space; the strip converts it.
  nrm = normalize(vec3(-rad.x * 0.45, 1.0, -rad.y * 0.45));

  // keep the whole blade on the season palette's bright half: a relief field whose roots are dark
  // reads as a shadowed carpet, and a grazing angle shows mostly the base of the blade
  vec3 c = mix(uGRBase, uGRTip, 0.3 + 0.7 * tip);
  c = mix(c, c * vec3(1.15, 1.05, 0.65), uGRDry * (0.3 + 0.7 * seed));
  c *= mix(1.0, 1.2, tip) * (0.95 + 0.15 * seed);
  // where the walk missed there is still turf — flat, unstreaked grass — so the field is a full
  // green carpet with the blades standing out of it, never bare ground showing through
  if (hit < 0.0) c = mix(uGRBase, uGRTip, 0.6);
  // clump tint: tufts are a touch darker and denser than the ground between them
  c *= mix(0.84, 1.12, clumpN);
  // GRASS_CONTRAST: push the dark roots and bright tips apart (or flatten them) around a mid luma
  c = clamp((c - 0.42) * uGRContrast + 0.42, 0.0, 1.5);
  // ANTI-STIPPLE, FAR ONLY. When a blade is genuinely under a pixel the random per-blade albedo
  // shimmers, so pull it toward the mean. Close blades (a couple of pixels or more) are untouched —
  // an earlier version faded everything and washed the field out to flat green underfoot.
  c = mix(c, mix(uGRBase, uGRTip, 0.55), (1.0 - smoothstep(0.4, 1.2, bladePx)) * 0.5);
  cov = 1.0;
  return c;
}
`
