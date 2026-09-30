// The track vocabulary now lives in `packages/stunt-pieces`, and this is the door to it.
//
// WHY IT MOVED. Two games want it: this one lays pieces out on a tile grid, and `apps/corridor`
// stands a single loop on a real OSM road at an arbitrary position and yaw. Corridor was reaching
// across into this folder, which works in one repository and stops the moment the two are split —
// and it dragged this game's whole car-tuning table along with it to learn that a cell is 40 m.
//
// The package has NO dependencies at all: not three, not `@apex/engine`, not the DOM. That is what
// lets it be lifted into another repository and depended on over a git URL or a registry.
//
// Nothing else in this game changed: every existing `from './pieces'` still resolves here.
export * from '@apex/stunt-pieces/pieces'
