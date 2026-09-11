// Everything artwork has to fit, for the scripts that prepare it.
//
// These are `ART_FIT` in apps/arcade/src/lobby/Cabinet.ts, which derives them from the machine
// itself. They are copied rather than imported because the scripts here run over images at install
// time, shell out to ImageMagick, and never ship — none of them can import the app's TypeScript.
// apps/arcade/test/cabinet-art.test.ts fails if the two ever drift apart, and that test is the only
// thing standing between a change to the cabinet and templates that quietly stop matching it.
//
// Fractions throughout, with y running down the way an image does.

/**
 * The sign is as tall as its own artwork, so the shape of that artwork is what decides how tall the
 * machine ends up. Asking every marquee for the same shape is what keeps a row of them level.
 */
export const MARQUEE = 1.7777778

/** The control deck, from the lip of the panel back to the foot of the monitor. */
export const DECK = 2.8594139

/** The glass: a 20-inch tube. */
export const SCREEN = 1.3333333

/**
 * The bezel face, and the hole in it the glass fills. A generated bezel is a frame around an opening
 * of the generator's choosing, which is never this one, so it is nine-sliced onto these — see
 * scripts/lib/bezel.mjs.
 */
export const BEZEL = { aspect: 1.4944005, hole: { x0: 0.1987952, y0: 0.1624095, x1: 0.8012048, y1: 0.8375905 } }

/**
 * The outline of a cabinet's side, front of the machine at the left.
 *
 * Traced off a scan of a real upright: base, the swell of the control panel, the deck, the monitor
 * leaning back nineteen degrees, the speaker panel raked over it, the sign, and a top sloping away
 * to the back. The deep notch between the control panel and the sign is the whole shape of the
 * thing, and artwork that ignores it loses whatever it put up there.
 *
 * Front at the left is the *right* flank. The left one is the mirror image: its artwork reads the
 * same way round — both flanks are seen from opposite sides, so both want their text running left to
 * right — which puts the front of the machine, and the notch above it, at the other end.
 */
export const FLANK = {
  aspect: 0.40128809,
  outline: [
    [0.15432099, 1],
    [0.15432099, 0.62348278],
    [0.1037037, 0.60366609],
    [0.03703704, 0.57394105],
    [0, 0.55412435],
    [0.24691358, 0.4956651],
    [0.42592593, 0.28758979],
    [0.11728395, 0.19246966],
    [0.11728395, 0.00743126],
    [0.13209877, 0],
    [0.3382716, 0],
    [1, 0.11196433],
    [1, 1],
  ],
}

/**
 * What every panel is called, what shape it wants, and how much slack there is in that before it
 * starts to show on the machine. `scripts/cabinet-check.mjs` reports against exactly this table, and
 * apps/arcade/ART.md explains what to do about each line of it.
 *
 * `tolerance` is a fraction of the aspect. The flanks are generous because their artwork is fitted
 * to the outline rather than to a rectangle; the marquee is tight because it decides the height of
 * the machine, and three marquees of three shapes is three cabinets of three heights.
 */
export const PANELS = {
  marquee: { aspect: MARQUEE, tolerance: 0.04, minEdge: 900, what: 'the lit sign on top, and the menu item' },
  'side-left': { aspect: FLANK.aspect, tolerance: 0.2, minEdge: 1200, what: 'the left flank' },
  'side-right': { aspect: FLANK.aspect, tolerance: 0.2, minEdge: 1200, what: 'the right flank' },
  // The deck is generous because the geometry fits artwork *inside* its face rather than stretching
  // it: a strip drawn twice too wide becomes a band across a painted deck, which is what a real
  // control panel is. How much of the deck it covers is reported separately.
  panel: { aspect: DECK, tolerance: 1.6, minEdge: 700, what: 'the control deck, seen from above' },
  bezel: { aspect: BEZEL.aspect, tolerance: 0.02, minEdge: 1000, what: 'the surround framing the screen' },
  attract: { aspect: SCREEN, tolerance: 0.1, minEdge: 600, what: 'a still for the screen, where no loop was filmed' },
}
