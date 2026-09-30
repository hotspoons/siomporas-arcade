# @apex/stunt-pieces

The track vocabulary from STUNTIN' — loops, corkscrews, banked sixths, jumps, drawbridges, splits,
joins and tunnels — as **data and arithmetic only**.

## Why it is a package

Two games want it. `apps/stuntin` lays it out on a tile grid; `apps/corridor` stands a single piece
on a real OSM road at an arbitrary position and yaw. Before this package, corridor reached across
into `apps/stuntin/src/sim/` — which works in one repo and stops working the moment the two are
split, and which dragged STUNTIN's entire car-tuning table in to learn that a grid cell is 40 m.

**It has no dependencies at all.** Not three, not the engine, not the DOM. That is deliberate and it
is the property to preserve: it is what lets this folder move to another repository and be depended
on over a git URL, a registry, or a submodule, without anything else moving with it.

```jsonc
// after a split, from whichever repo does not hold it:
"dependencies": { "@apex/stunt-pieces": "github:<owner>/<repo>#v1.0.0" }
```

## What is in it

| file | what |
| --- | --- |
| `src/geometry.ts` | the handful of metres-and-cells constants the pieces are built from |
| `src/scalar.ts` | `smoothstep`, inlined so the package depends on nothing |
| `src/bank.ts` | the banked cross-section: how a surface rolls and where its walls are |
| `src/pieces.ts` | every piece: footprint, ports, and a lane path as a function of t |
| `src/links.ts` | the cubic Hermite that joins two ports, tangent-matched at both ends |

## The frame

A piece's footprint has its **minimum corner at the origin**, `x` runs east, `z` runs north and `y`
is up. One cell is `CELL` metres. A lane is a function of `t ∈ [0, 1]` returning a position, an up
hint (the surface normal before banking), a roll and whether the surface exists there — gaps are how
a jump is described.

A consumer that is not on a grid should read the ports **off the lane** rather than out of the port
table: sample at `t = 0` and `t = 1`. The port table is exact on a grid and needs a pile of rotation
bookkeeping off one, while the lane is the thing the car actually drives.
