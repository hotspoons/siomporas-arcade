// The track vocabulary now lives in `packages/stunt-pieces`, and this is the door to it.
//
// WHY IT MOVED. More than one game wants it: this one lays pieces out on a tile grid, and the
// real-road driving game stands a single loop on an OSM road at an arbitrary position and yaw.
// Sharing it across games is why it is a package rather than a folder in one of them — and moving
// it out stopped it dragging this game's whole car-tuning table along to learn that a cell is 40 m.
//
// The package has NO dependencies at all: not three, not `@apex/engine`, not the DOM. That is what
// lets it be lifted into another repository and depended on over a git URL or a registry.
//
// Nothing else in this game changed: every existing `from './pieces'` still resolves here.
export * from '@apex/stunt-pieces/pieces'
