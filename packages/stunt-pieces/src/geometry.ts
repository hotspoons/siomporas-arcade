// The metres and cells the pieces are built from.
//
// SEPARATED FROM THE GAME'S TUNING ON PURPOSE. These lived in `apps/stuntin/src/sim/Tuning.ts`
// beside two hundred car knobs — grip, gravity, steering rate, crash speed — and importing them
// from anywhere else dragged the whole table along with the tuning panel that edits it. These
// numbers are not knobs: they are the DIMENSIONS OF THE VOCABULARY, and changing one changes what
// every piece is, so they belong with the pieces.

/** Side of one editor cell, metres. Every piece footprint is whole cells. */
export const CELL = 40
/** Height of one elevation level, metres. Ramps climb exactly one per cell. */
export const LEVEL_H = 8
/** Half the drivable road width. */
export const ROAD_HALF_WIDTH = 5
/** Curb width beyond the road edge (visual + rumble). */
export const CURB_WIDTH = 0.8
/** Radius of vertical loops and corkscrews. */
export const LOOP_RADIUS = 18
/** Corkscrew helix radius, metres. */
export const CORK_RADIUS = 14
/** Round tunnel radius (the road is the floor). */
export const TUBE_RADIUS = 11
/** Metres over which a tunnel's walls rise from curb height at each mouth, and sink again at the exit. */
export const TUBE_RAMP = 18
/** Lateral shift across a loop so the exit clears the entry, metres. */
export const LOOP_SHIFT = CELL
