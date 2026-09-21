// Where does a manifest `s` actually land, and would rescaling it help?
//
//   SLUGS=bowie-racetrack-rd,chesterfield-rd,bonnie-branch-rd node probes/corridor-sdrift.mjs
//
// `corridor.verify` warns on 8 of 20 sites that "the published centreline is -N m against the line
// every `s` is measured on: features near the far end are displaced by up to N m", and the
// suggested fix was one line in `spineAt` — `s × curveLen / length_m`. THAT FIX IS WRONG, and this
// probe is why it did not get applied.
//
// The self-inconsistency is real: export.py publishes `length_m` as the RAW spine's length while
// `coords` are sampled from the SMOOTHED line, which is 0.2–1.8 % shorter. But the viewer already
// does the right thing with it. `spineAt` resolves `u = s / curveLen` against the curve through the
// published coords, which maps a feature at 50 % of the raw line to 50 % of the drawn one — the
// correct proportional mapping. Measured displacement against where the published polyline puts
// the same station:
//
//                        as it is        with the proposed rescale
//     bowie      98 %      2.8 m                  12.4 m
//     chesterfield 98 %    4.4 m                  17.5 m
//     bonnie-branch 98 %  36.3 m                  64.7 m
//
// So the rescale makes every station on every site worse, by three to nine times, and verify's
// "displaced by up to N m" overstates the real error by about 4×.
//
// What IS left is the far-end growth (bonnie-branch, 36 m at 98 %): smoothing does not shorten a
// line uniformly, it shortens it where the road bends, so a proportional mapping accumulates error
// where the curvature is unevenly distributed. That is the smoothing clamp, not a rescale — fix
// the shortening, not the arithmetic on top of it.
import { chromium } from 'playwright'
const b=await chromium.launch({args:['--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader','--ignore-gpu-blocklist']})
for (const slug of (process.env.SLUGS??'bowie-racetrack-rd,chesterfield-rd,bonnie-branch-rd').split(',')) {
  const p=await b.newPage({viewport:{width:900,height:600}})
  await p.route('**/@vite/client',r=>r.abort())
  await p.goto(`http://127.0.0.1:5185/#${slug}`,{waitUntil:'domcontentloaded',timeout:120000})
  try{ await p.waitForFunction((s)=>window.corridor?.site?.manifest?.slug===s,slug,{timeout:240000}) }catch{ console.log(slug,'LOAD FAIL'); await p.close(); continue }
  console.log(await p.evaluate(()=>{
    const s=window.corridor.site, m=s.manifest
    const published=m.spine.length_m
    // the drawn curve's own length: walk spineAt in curve space
    let L=0, prev=null
    for(let t=0;t<=published*1.2;t+=2){ const q=s.spineAt(t); if(prev) L+=Math.hypot(q.pos.x-prev.x,q.pos.z-prev.z); prev={x:q.pos.x,z:q.pos.z}
      // spineAt clamps at u=1, so once it stops moving we are at the end
      if(t>4 && prev && L>0 && Math.hypot(q.pos.x-prev.x,q.pos.z-prev.z)===0 && t>published) break }
    // where does the LAST structure land vs where the raw polyline says it should?
    const coords=m.spine.coords
    let raw=0; const cum=[0]
    for(let i=1;i<coords.length;i++){ raw+=Math.hypot(coords[i][0]-coords[i-1][0],coords[i][1]-coords[i-1][1]); cum.push(raw) }
    const atRaw=(sv)=>{ let i=1; while(i<cum.length && cum[i]<sv) i++; if(i>=cum.length) i=cum.length-1
      const t=(sv-cum[i-1])/Math.max(1e-6,cum[i]-cum[i-1])
      return {x:coords[i-1][0]+(coords[i][0]-coords[i-1][0])*t, y:coords[i-1][1]+(coords[i][1]-coords[i-1][1])*t} }
    const probes=[0.25,0.5,0.75,0.98].map(f=>{
      const sv=published*f
      const drawn=s.spineAt(sv)            // current behaviour
      const scaled=s.spineAt(sv*raw/published) // if s were rescaled by raw/published
      const want=atRaw(sv)                  // where the raw polyline puts it
      const d=(q)=>Math.hypot(q.pos.x-want.x, (-q.pos.z)-want.y)
      return {f, now:+d(drawn).toFixed(2), rescaled:+d(scaled).toFixed(2)}
    })
    return JSON.stringify({site:m.slug, published_length_m:published, raw_polyline_m:+raw.toFixed(1), diff_m:+(raw-published).toFixed(1), probes})
  }))
  await p.close()
}
await b.close()
