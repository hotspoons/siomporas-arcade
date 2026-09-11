#!/usr/bin/env node
// Write out every image-generator prompt, fully expanded, one per generation.
//
//   node scripts/fighter-prompts.mjs                  # writes apps/fighter/PROMPTS.md (all 60)
//   node scripts/fighter-prompts.mjs --only kestrel   # print just one character's five, to stdout
//   node scripts/fighter-prompts.mjs --list           # the running order and nothing else
//
// ART.md explains the pipeline and has the prompts with `[ paste the seed here ]` holes in them,
// which is the right shape for reading and the wrong shape for working. This generates the working
// copy: sixty numbered prompts with the style line, the character description and the special-move
// descriptions already substituted in, so each one is a single copy and paste with nothing to
// assemble. Five per character:
//
//   .1 bible   .2 sheet A   .3 sheet B   .4 turnaround   .5 portrait
//
// The character data lives here rather than in ROSTER.md because this is the file that has to be
// exact — ROSTER.md is prose about the same twelve people and is allowed to read well instead.
//
// Regenerate after any change to a character. Never hand-edit PROMPTS.md.

import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const OUT = path.join(ROOT, 'apps/fighter/PROMPTS.md')

/** In all five prompts, verbatim. The one block that decides whether the roster looks like a roster. */
const STYLE =
  'Painted in the manner of early-1990s arcade character art: a photographed actor in costume, ' +
  'retouched into hard-edged illustration — saturated colour, heavy contrast, one strong key light ' +
  'from the upper front left, deep shadow under the brow and the jaw, visible airbrush modelling on ' +
  'the muscle, and a crisp dark outline holding the whole figure together. Solid and physical, not ' +
  'glossy and not cel-shaded. The costume reads as real cloth and real leather with real wear on it.'

/** The closing prohibitions. The background rule is the one that decides whether the art is usable. */
const CLEAN =
  'The background inside every box stays completely flat, even, unshaded grey — exactly the grey it ' +
  'already is. No floor, no ground shadow, no cast shadow, no backdrop, no scenery, no gradient, no ' +
  'vignette, no glow behind the figure. Do not use grey anywhere in the costume, skin or hair; grey ' +
  'is the background and will be removed. No text, no labels, no captions, no watermark, no logo, ' +
  'no border and no frame.'

const MATCH = (n) =>
  `Attached are two images.\n\n` +
  `IMAGE 1 is the finished reference sheet for a character. Match that character exactly — the same ` +
  `face, build, proportions, costume, colours and gear, in every single box. Study it before you ` +
  `start.\n\n` +
  `IMAGE 2 is a blank layout template: a dark grey field with ${n} lighter grey boxes, each numbered ` +
  `and labelled, each with a faint horizontal floor line near its bottom.`

/**
 * Six rules, numbered, before the pose list rather than after it. Twenty poses is near the limit of
 * what a generator will hold in its head at once, and the failure is always the same: it gets
 * absorbed in the poses and quietly drops the invariants. Short, numbered and first survives best.
 * Rule 2 is the one that matters — a sheet drawn at inconsistent scale is unusable and unfixable.
 */
const RULES = (airborne) => `Six rules. All of them apply to every box, and they matter more than any individual pose:

1. The character FACES RIGHT in every box.
2. The character is EXACTLY THE SAME HEIGHT in every box, measured sole to crown. Never scale the
   character up or down between boxes. These are frames of one animation and any change of size
   shows up in the game as the character growing and shrinking on screen.
3. Feet ON the thin floor line in every box, except ${airborne}, which float clearly above it.
4. The WHOLE body is in every box, head to feet. Nothing crosses into the grey gutters between boxes.
5. The background inside every box stays completely flat, even, unshaded grey — exactly the grey it
   already is. No floor, no shadow, no scenery, no gradient, no glow. Never use grey in the costume,
   skin or hair: grey is the background and gets removed.
6. Fill EVERY box. Never leave one empty, and keep them in their numbered order.`

const CLOSE = `Draw only the body and the costume. No energy, fire, lightning, shockwaves, motion blur, speed lines
or impact effects anywhere — the game draws all of that, and anything painted into the sprite cannot
be removed. No text, labels, captions, watermarks, logos, borders or frames.`

const SHEET_A = [
  'IDLE — the fighting stance, weight balanced, guard up, alert.',
  'WALK FORWARD — mid-stride advancing, guard up.',
  'WALK BACK — mid-stride retreating, guard up, still facing right.',
  'CROUCH — down low on the heels, guard up, compact.',
  'BLOCK HIGH — standing, braced, both arms covering head and chest.',
  'BLOCK LOW — crouching, braced, arms covering the body low.',
  'JUMP UP — airborne and rising, knees tucked, straight up.',
  'JUMP FORWARD — airborne at the top of a forward arc, body extended, travelling right.',
  'LIGHT PUNCH — a fast short jab, arm not fully extended, barely committed.',
  'HEAVY PUNCH — a full straight punch, arm locked out, shoulder and hips rotated through it.',
  'LIGHT KICK — a quick snap kick, knee lifted, foot out at shin height.',
  'HEAVY KICK — a full roundhouse, leg swung high and extended, hips open.',
  'CROUCH PUNCH — crouching, a short jab from the low stance.',
  'SWEEP — down on one hand, the other leg swept flat along the floor, fully extended.',
  'AIR PUNCH — airborne, punching down and forward at someone below.',
  'AIR KICK — airborne, one leg extended forward and down at someone below.',
  'THROW — both arms forward at chest height, gripping and hauling an opponent who is NOT drawn. Braced, weight back.',
  'HIT — head snapped back, body recoiling, arms loose, feet still on the floor.',
  'KNOCKED OUT — flat on their back on the ground, limbs slack. The only pose lying down; draw them along the floor line, seen from the side.',
  'VICTORY — standing tall, their own gesture of triumph, in character.',
]

const sheetB = (c) => [
  'IDLE — THE SAME IDLE STANCE AS ON THE FIRST SHEET, at the same size. This box is a size reference, not a new pose. Copy it as closely as you can.',
  `SPECIAL 1 WIND UP — ${c.wind}`,
  `SPECIAL 1 RELEASE — ${c.fire}`,
  'SPECIAL 1 RECOVERY — the same move a moment later: over-extended, off balance, about to recover.',
  `SPECIAL 2 WIND UP — the instant before it: coiled, loaded, committed.`,
  `SPECIAL 2 RELEASE — ${c.second}`,
  'OFF THEIR FEET — launched backward off the ground, body arched, limbs trailing, not in control.',
  'DIZZY — upright but swaying, arms hanging, head lolling, eyes unfocused.',
  'TAUNT — a moment of contempt aimed at the opponent, entirely in character.',
  'INTRO POSE — how they walk on and square up before the bell.',
  `VICTORY 2 — a second, different celebration: ${c.victory}`,
  'IDLE 2 — the second frame of a breathing idle: same stance, weight shifted, guard a little lower.',
  'WALK FORWARD 2 — the opposite stride to a walk forward: the other leg leading.',
  'WALK BACK 2 — the opposite stride to a walk back: the other leg leading.',
  'HEAVY PUNCH WIND UP — the frame before the heavy punch: fist drawn back, shoulder loaded, hips coiled.',
  'HEAVY KICK WIND UP — the frame before the roundhouse: knee up and cocked across the body.',
  'HIT LOW — struck in the legs, doubling forward, knees buckling.',
  'GETTING UP — pushing up off the floor onto one knee, guard not yet back.',
  'AIR NEUTRAL — airborne, falling, arms out, no attack.',
  'GUARD PUSH — both palms shoving forward from a guard, shoulders square, feet planted.',
]

/**
 * The twelve. `seed` is the body and costume; `wind`/`fire`/`second` describe what the body is
 * doing in the two specials, deliberately with no mention of the effect itself.
 */
const CAST = [
  {
    id: 'kestrel', name: 'KESTREL', who: 'Wren Adisa',
    seed:
      'A tall, lean Black British woman in her late twenties, shaved head, long limbs, a loose dark ' +
      'teal sleeveless vest and cropped rust-orange trousers, barefoot. Her right forearm is wrapped ' +
      'wrist to elbow in thick rust-orange rope and cloth so it reads as a club, twice the thickness ' +
      'of her bare left arm, which wears brass rings. Confident, relaxed, economical.',
    wind: 'both arms drawn back low to her right hip, the bound forearm cocked behind her, body coiled and turned away, weight loaded on the back foot.',
    fire: 'the bound forearm driven straight forward at full extension from the hip, shoulder and hips rotated completely through it, back heel lifted.',
    second: 'leaping upward, the bound forearm driving up past her own ear in a rising elbow, the opposite knee coming up beneath it, both feet clear of the ground.',
    victory: 'standing straight, the bound forearm raised, turned to look at it, unimpressed.',
  },
  {
    id: 'bollard', name: 'BOLLARD', who: 'Duncan Mear',
    seed:
      'An enormous white Scottish man in his late fifties, bald on top with grey stubble and a broken ' +
      'nose, barrel-chested with short thick legs and a low, planted stance. A filthy high-visibility ' +
      'yellow-green work vest gone grey, a red and black tartan sash across the chest, heavy ' +
      'steel-toecap boots worn through to bare metal. Calm, bored, immovable.',
    wind: 'crouched low with both arms spread wide and open at waist height, palms turned up, about to close on something.',
    fire: 'straightened up with both arms locked round an opponent who is not drawn, lifting — back arched, feet planted wide, face set.',
    second: 'low and running, the leading shoulder dropped and driven forward, both arms trailing behind him, one foot leaving the ground.',
    victory: 'arms folded, feet planted, looking off to one side, entirely unmoved.',
  },
  {
    id: 'sable', name: 'SABLE PRIOR', who: 'Xun Meilin',
    seed:
      'A short, compact Chinese-Canadian woman in her early thirties, black hair cut blunt at the jaw, ' +
      'wiry and coiled. A black quilted short jacket with jade green cuffs and collar, black trousers, ' +
      'flat black canvas shoes. She holds a short rattan stick in each hand at different angles, close ' +
      'to the body. Watchful, still, about to move.',
    wind: 'elbows pinned to her ribs, both sticks drawn back vertical against her forearms, weight forward on the lead foot.',
    fire: 'one stick thrust straight out at full extension along the centre line, the other already drawn back to replace it, body square.',
    second: 'lunging low along the ground, both sticks thrust forward together as a single point, back leg fully extended behind her.',
    victory: 'both sticks spun once and caught, crossed at her chest, expression flat.',
  },
  {
    id: 'kombinat', name: 'KOMBINAT', who: 'Yeva Ostrenko',
    seed:
      'A tall, solidly built Ukrainian woman in her forties, ash-blonde hair scraped back, coal dust ' +
      'worked into the lines of her face and neck. Grey singlet, heavy canvas work trousers. Her left ' +
      'arm below the elbow is a salvaged mining winch: a squared steel housing painted safety red, a ' +
      'drum of steel cable, and a heavy hook where the hand should be, longer and heavier than her ' +
      'right arm. Loose cable trails behind her. Unbothered.',
    wind: 'braced side-on with the winch arm drawn back across her body, slack cable looped in her right hand, feet set.',
    fire: 'the winch arm punched straight out, the hook gone from it and the cable running out taut into the distance, her body pulled forward off her front foot.',
    second: 'turning on the spot with the winch arm held out horizontal and swinging, cable whipping out around her, hair and clothing pulled by the rotation.',
    victory: 'winding the cable back in by hand, not looking up.',
  },
  {
    id: 'fathom', name: 'FATHOM', who: 'Tui Reweti-Kane',
    seed:
      'A heavyset Māori-Samoan man in his mid thirties, long black hair tied high, a full sleeve of ' +
      'traditional tattoo on one arm and shoulder. Bare-chested, deep ocean blue work trousers, a wide ' +
      'braided belt, bare feet. He carries a two-metre hardwood staff weighted with oxidised copper at ' +
      'one end, held diagonally across his body. Grounded, patient, heavy.',
    wind: 'dropped into a deep low stance with the staff drawn back horizontally at ankle height behind him, both hands on the shaft.',
    fire: 'the staff swept flat through a full arc at ankle height in front of him, body rotated completely through the swing, weight down.',
    second: 'standing absolutely upright and still, the staff planted vertically in front of him with both hands on it, chest full, eyes closed.',
    victory: 'the staff spun once overhead and planted, chin lifted.',
  },
  {
    id: 'candela', name: 'CANDELA', who: 'Rosalía Mbeki-Ferrán',
    seed:
      'An athletic Equatoguinean-Spanish woman in her late twenties, dark curls tied back with a ' +
      'yellow cloth, mid-motion and off balance on purpose. A cropped sun-yellow top, loose ' +
      'blood-orange trousers cut off below the knee, bare midriff, hands wrapped, small bells at both ' +
      'ankles. Fluid, grinning, about to invert.',
    wind: 'both hands planted on the floor, hips high, one leg drawn up and cocked overhead.',
    fire: 'inverted on both hands with both legs swung over in a full wheel, one leg fully extended overhead and the other trailing.',
    second: 'upright, back arched, one arm raised overhead in a flamenco line, driving one heel down hard into the floor, the other foot already lifting.',
    victory: 'one arm curled overhead, the other at her waist, heel stamped, head turned away.',
  },
  {
    id: 'meridian', name: 'MERIDIAN', who: 'Dr Anouk Feraud',
    seed:
      'A lean French-Algerian woman in her late thirties, dark hair in a severe short cut, clinical and ' +
      'composed. A fitted white technical top with fine cyan line-work. From hip to ankle both legs are ' +
      'enclosed in an exposed powered brace — visible actuators, carbon struts, cable runs, cyan ' +
      'telemetry seams — clearly mechanism rather than armour. Oxblood leather boots. Balanced on one ' +
      'leg, the other cocked.',
    wind: 'crouched deep on both braced legs, the actuators fully compressed, arms tucked in, looking up.',
    fire: 'launched vertically, one braced leg extended straight overhead in a rising kick, the other tucked, body straight as a line.',
    second: 'standing upright with one hand on the hip brace, head down, the leg actuators extended and venting.',
    victory: 'a single sharp savate salute — one boot brought up and set down, posture perfect.',
  },
  {
    id: 'thresher', name: 'THRESHER', who: 'Gus Vanterpool',
    seed:
      'A big, run-down white American man in his fifties, sunburnt and scarred, thinning hair, a heavy ' +
      'gut over obvious old strength. Bare-chested under an open oil-stained denim vest, faded jeans, ' +
      'work boots. A length of rusted anchor chain is wrapped round his right fist and runs down to his ' +
      'belt, hanging loose. Bad-tempered, unhurried, filthy.',
    wind: 'the chain gathered up in his fist and drawn back over his shoulder, body turned away, weight on the back leg.',
    fire: 'the chain whipped straight out horizontally at full length across the frame, arm extended, body twisted through it.',
    second: 'head lowered and driven forward, both arms flung back behind him, feet leaving the ground, chain swinging loose.',
    victory: 'spitting to one side, wrapping the chain back round his fist.',
  },
  {
    id: 'ossuary', name: 'OSSUARY', who: 'name unknown',
    seed:
      'A powerfully built Mexican luchador in his thirties, classic V-tapered build. A full-head ' +
      'bone-white lucha mask with a raised vertical bone-ridge crest running front to back over the ' +
      'skull, cardinal red eye and mouth trim, gold filigree. Cardinal red trunks with gold detailing, ' +
      'white boots laced to the knee, bone-white wrist wraps. Bare-chested. Theatrical, arms wide.',
    wind: 'crouched low with both hands on the floor and both feet coiled, body angled forward like a sprinter in the blocks.',
    fire: 'fully horizontal in the air, arms swept back along his sides, head leading, body straight, both feet trailing behind him.',
    second: 'airborne and upside down, both legs scissored round an opponent who is not drawn, both hands reaching down.',
    victory: 'arms flung wide, chest out, chin up.',
  },
  {
    id: 'vessel', name: 'VESSEL', who: 'Sunwoo Ha-eun',
    seed:
      'A slight Korean girl of seventeen, wiry and fast, black hair in a high ponytail tied with ' +
      'vermillion cloth. A pale blue sleeveless hanbok-style top over loose white trousers gathered at ' +
      'the ankle, a vermillion sash, white split-toe socks. An hourglass-shaped janggu drum is slung at ' +
      'her left hip on a strap, and she holds a slim bamboo beater in her right hand. Light on her ' +
      'feet, chin up, unimpressed.',
    wind: 'turned side-on with the beater raised high above the drum at her hip, the other hand flat on the drum head.',
    fire: 'the beater brought down hard onto the drum head, her whole body dropped into the strike, knees bent.',
    second: 'one leg extended straight forward at waist height in a flat-footed push, sole leading, arms back for balance.',
    victory: 'a quick flourish of the beater, the drum held out, a slight bow, chin up.',
  },
  {
    id: 'glassjaw', name: 'GLASSJAW BILL', who: 'William Okonkwo-Hart',
    seed:
      'A lean Australian man of sixty-one with dark skin and close-cropped white hair, a scarred face ' +
      'and an immaculate upright stance. Bare-chested under an open brown tweed waistcoat, ' +
      'high-waisted dust-brown trousers with braces hanging loose at the hips, bare feet. Both hands ' +
      'are wrapped in dirty bone-white cloth, marked with blood. Utterly calm, guard low, chin tucked.',
    wind: 'standing very upright, weight back, one wrapped hand turned outward and open at chest height, the other held low.',
    fire: 'one wrapped fist driven out in a short, perfectly straight counterpunch from the chin, almost no body movement, feet barely shifted.',
    second: 'rolling his head and shoulders a few inches to one side, guard still low, eyes forward.',
    victory: 'unwrapping one hand slowly, looking down at it.',
  },
  {
    id: 'arclight', name: 'ARCLIGHT', who: 'Sana Bhattarai',
    seed:
      'A tall, wire-thin Nepali woman in her thirties, weather-beaten, black hair in a practical braid. ' +
      'A dull grey climbing harness over a deep ultraviolet-purple technical jacket with black ' +
      'electrical tape wrapped at the forearms and shins, hazard-orange gloves, heavy boots. Coils of ' +
      'orange cable are slung across her back. She holds a two-metre insulated fibreglass hot stick ' +
      'with a hooked metal fitting at the end. Squinting, braced against wind.',
    wind: 'the hot stick raised high in both hands overhead, body stretched tall, braced.',
    fire: 'the hooked end of the hot stick driven down hard into the floor in front of her, body dropped low over it, both hands on the shaft.',
    second: 'the hot stick held horizontally across her body at arm’s length like a bar, feet planted wide, head turned aside.',
    victory: 'the hot stick spun once and shouldered, adjusting her harness.',
  },
]

const numbered = (lines) => lines.map((l, i) => `${i + 1}. ${l}`).join('\n')

/**
 * The arenas. Same method as the cabinet art that worked: templated projections of concept art, one
 * palette and one light per sheet because layers generated separately never agree with each other.
 *
 * 2D first. The 3D note under each is pencilled in, not designed — when the 2.5D camera exists these
 * same descriptions become the brief for a modelled set, and the generated layers become the concept
 * art you model from rather than the thing that ships.
 */
const STAGES = [
  {
    id: 'reservoir', name: 'THE DRAINED RESERVOIR',
    look: 'A vast empty concrete reservoir at dusk. Sloped walls streaked with decades of water stain, a cracked floor, weeds through the joints. Sodium floodlights on scaffold poles. A chain-link fence round the rim with a crowd pressed against it in silhouette.',
    palette: 'Concrete grey and pale green algae, sodium orange light, deep blue-violet dusk sky, one hit of hazard yellow.',
    far: 'the far wall of the reservoir curving away, the fenced rim along the top, a crowd in silhouette against a violet dusk sky, floodlight glare',
    mid: 'the near slope of the reservoir wall, scaffold floodlight towers, a gantry stair, stacked crowd barriers, graffiti',
    floor: 'cracked concrete with old waterline stains and weeds in the joints',
    props: 'floodlight rigs, crowd barriers, oil drums, a burning barrel, coils of cable, hazard signage, a generator, rubble',
  },
  {
    id: 'container', name: 'THE CONTAINER YARD',
    look: 'A shipping container yard at night in sea fog. Containers stacked four high in rust reds and sea greens, a gantry crane overhead, wet asphalt, harbour lights smeared in the haze.',
    palette: 'Rust red, sea green, black, wet asphalt grey, cold sodium and mercury harbour light, fog.',
    far: 'stacked shipping containers four high receding into sea fog, a gantry crane overhead, harbour lights smeared in haze',
    mid: 'a wall of containers close up, doors and locking bars, a stair tower, cargo netting, a lit doorway with figures in it',
    floor: 'wet asphalt with painted yard markings, puddles, rail tracks set into it',
    props: 'lashing bars, a mooring bollard, cargo net rolls, a forklift pallet, floodlight mast, oil drums, crates, a life-ring board',
  },
  {
    id: 'carpark', name: 'THE CAR PARK ROOF',
    look: 'The top deck of a multi-storey car park in heavy rain, at night. A low concrete barrier, painted bays, a city skyline beyond. Headlights of parked cars aimed inward at the fight.',
    palette: 'Wet concrete grey, sodium orange, cold white headlights, black rain, distant window light.',
    far: 'a city skyline at night in rain, tower windows lit in a grid, low cloud catching the city glow',
    mid: 'the low concrete perimeter barrier, a stair core block, parked cars side on with headlights aimed inward, a dripping sign',
    floor: 'wet painted parking bays on concrete, reflections, drainage channels',
    props: 'a parking meter, bollards, a wheel clamp, traffic cones, a fire hose reel, a payment machine, a broken barrier arm, a skip',
  },
  {
    id: 'foundry', name: 'THE FOUNDRY FLOOR',
    look: 'A working iron foundry at night. Molten metal glow from a ladle, sand casting beds, catwalks and chain hoists overhead, heat haze, everything lit orange from below.',
    palette: 'Black and soot, molten orange and white-hot yellow from below, dull steel, brick red.',
    far: 'the far end of the foundry hall, a ladle of molten iron glowing, catwalks and chain hoists, brick arches, heat haze',
    mid: 'sand casting beds, a crucible on a rail, control panels, workers in heat suits watching, hanging chains',
    floor: 'compacted foundry sand and steel plate, scorch marks, spilled slag still glowing',
    props: 'a ladle, ingot moulds, a slag bucket, long-handled tongs, a heat-suit helmet on a hook, chain hoist, tool rack, sand pile',
  },
]

function bible(c) {
  return `Attached is a blank layout template: a dark grey field with eight lighter grey boxes on it, each labelled, and a faint horizontal floor line across the large box on the left.

Fill in every box with finished character art of a single original fighting-game character, described below. Keep each piece of artwork strictly inside its own box, and keep every box exactly where and what size it is. The labels can go.

FULL FIGURE — A POSE: the whole character standing straight on, facing the viewer, arms held a little away from the body, palms forward, legs slightly apart. Feet flat on the floor line, head near the top of the box. Neutral expression, no action, no foreshortening — this is a reference drawing, not a pose.
HEAD — FRONT, HEAD — THREE QUARTER, HEAD — PROFILE: the same head three times, same scale, same lighting, neutral.
HANDS: both hands, front and back, including any wrap, glove or fitting.
FEET: both feet, including footwear, from the side and from the front.
GEAR AND WEAPON: whatever the character carries, drawn on its own, from two angles.
PALETTE: eight to twelve flat rectangular swatches of the exact colours used, in a row — no shading, no labels, no text.

THE CHARACTER: ${c.seed}

${STYLE}

${CLEAN}`
}

const AIRBORNE_A = 'boxes 7, 8, 15 and 16'
const AIRBORNE_B = 'boxes 7 and 19'

function sheet(poses, airborne) {
  return `${MATCH('twenty')}

${RULES(airborne)}

The twenty poses, one per box, in this order:

${numbered(poses)}

${STYLE}

${CLOSE}`
}

function turnaround() {
  return `${MATCH('eight')}

Draw the same character in EXACTLY THE SAME POSE in all eight boxes, seen from eight different camera positions. The pose does not change at all between boxes — only the camera moves around them. Treat it as eight photographs of one statue.

The pose: standing straight, facing forward, arms held a little away from the body, palms down, legs slightly apart — a neutral A-pose.

Top row, camera at the character's chest height, level, orbiting:
1. FRONT — from directly in front.
2. RIGHT SIDE — ninety degrees round, their right side to camera.
3. BACK — directly behind.
4. LEFT SIDE — ninety degrees the other way.

Bottom row, camera raised about thirty degrees and looking down, offset forty-five degrees from the top row:
5. HIGH 45 — above and to the front-right.  6. HIGH 135 — above and to the back-right.
7. HIGH 225 — above and to the back-left.   8. HIGH 315 — above and to the front-left.

Draw the character at EXACTLY the same size in every box, centred, whole body in frame with a small margin. Lighting is fixed to the world and does NOT rotate with the camera, so the same side of the character is lit in all eight. Flat, even, neutral light, soft shadow, no strong highlights. No lens distortion and no perspective foreshortening — as if through a long lens.

${STYLE}

The background in every box stays flat, even, unshaded grey. No floor, no shadow, no scenery. Never use grey in the costume, skin or hair. No text, labels, captions, watermarks, borders or frames.`
}

function portrait(c) {
  return `Attached are two images: a finished character reference sheet whose design, costume, colours and face I want matched exactly, and a blank square template.

Draw a head-and-shoulders portrait of the same character, filling the square, facing slightly toward the viewer's left, lit hard from the upper front left, with a great deal of attitude — this is a fighting-game character-select portrait.${c.who === 'name unknown' ? ' This character is never seen unmasked.' : ''}

${STYLE}

The background stays flat, even, unshaded grey. No text, labels, captions, watermarks, borders or frames.`
}

/**
 * A stage as three parallax bands on one canvas. One canvas because layers generated in separate
 * conversations do not agree about palette, light direction or time of day, and a background whose
 * layers disagree reads as a collage. Same thing that worked on the cabinets: a templated projection
 * of one piece of concept art.
 */
function stage(s) {
  return `Attached is a blank layout template: a dark grey field with three wide lighter grey boxes, stacked, each labelled.

Fill all three boxes with finished background artwork for one arena of a 2D fighting game. Keep each piece strictly inside its own box. The labels can go.

THE ARENA: ${s.name}. ${s.look}

PALETTE: ${s.palette}

All three boxes are the SAME place, at the SAME time of day, under the SAME light, in the SAME palette. They are three depth layers of one picture, not three pictures.

1. FAR LAYER — ${s.far}. This sits furthest away and barely moves as the camera pans. Hazier, lower contrast and cooler than the rest.
2. MID LAYER — ${s.mid}. This is the room itself, at the fighters' own distance. Full contrast, full detail.
3. FLOOR — ${s.floor}. A long shallow strip seen almost edge-on, as a floor is when the camera is at standing height. Perspective lines run gently toward a centre vanishing point. No objects standing on it, no figures, no cast shadows — just the surface.

Every layer is drawn straight on and flat, with no camera tilt and no lens distortion, and fills its box edge to edge with no border, no vignette and no frame. The far and mid layers must read correctly when their left and right edges are placed side by side, because the camera pans across them.

NO FIGHTERS and no main characters anywhere. Crowd figures in the mid and far layers only, small and in silhouette.

Painted in the manner of early-1990s arcade background art: hand-painted, saturated, high contrast, hard-edged, heavy black line work holding the shapes, flat colour laid down the way ink sits on a printed background plate. Atmospheric but graphic. Not photographic and not 3D-rendered.

No text, labels, captions, watermarks, logos, borders or frames.`
}

function props(s) {
  return `Attached is a blank layout template: a dark grey field with twenty lighter grey boxes, each numbered and labelled.

Draw one object per box — scenery objects to scatter through a 2D fighting game arena. Each object is drawn ALONE, complete, centred in its box, with nothing else around it and no ground under it.

THE ARENA these belong to: ${s.name}. ${s.look}

PALETTE: ${s.palette}

Every object is lit the same way, from the upper front left, and shares that palette so they all read as belonging to one place. Draw them straight on from the side, flat, with no camera tilt and no perspective distortion — these get placed into a side-on scene.

The objects this arena wants: ${s.props}. Use the numbered labels on the template as the list, and where a label names something that would not exist in this arena, draw the nearest thing that would.

The background inside every box stays completely flat, even, unshaded grey — exactly the grey it already is. No ground, no shadow, no scenery, no gradient. Never use that grey on the object itself; grey is the background and gets removed. Fill every box.

Painted in the manner of early-1990s arcade background art: hand-painted, saturated, high contrast, hard-edged, heavy black line work, flat colour. Not photographic and not 3D-rendered.

No text, labels, captions, watermarks, logos, borders or frames.`
}

function cabinet() {
  return `Attached are two images. The first is finished character artwork whose style, palette and lettering I want you to match exactly. The second is a blank layout template for the decal artwork of an arcade cabinet: five grey slots, each labelled, on a darker grey field.

Fill in every slot with finished artwork in the style of the first image, keeping each piece strictly inside its own slot and keeping the slots exactly where and what size they are. Every slot is filled edge to edge — no holes, no cut-outs, no black shapes. The grey gutters stay flat grey, and the labels can go.

THE GAME: CONCRETE CROWN — an underground bare-knuckle fighting circuit in the places a city forgot it owned. A drained reservoir at dusk, sodium floodlights, chain-link, a crowd in silhouette. Concrete grey and sodium orange with one hit of gold. Logo CONCRETE CROWN in heavy condensed slab letters, scratched gold on black, a small crown set into the C. Tagline TWELVE FIGHTERS - ONE CROWN.

MARQUEE: the illuminated sign, logo huge and centred, tagline beneath it.
SIDE — LEFT and SIDE — RIGHT: the two flanks. Two DIFFERENT scenes in the same world — one a lean woman with one forearm bound in heavy rope squaring up, the other an enormous bald man in a filthy hi-vis vest lifting someone clean off the ground. Each runs the full height of its slot with the logo set into the upper third.
CONTROL PANEL: a wide shallow band, six button positions suggested in the art, instruction text small, logo small at the left end.
BEZEL: artwork with the busiest detail round the edges and the middle kept simple and dark.

All of it is flat printed decal artwork, not a photograph of an arcade machine: completely flat and straight on, no perspective, no cabinet body, no room, no shadows, no glare, no reflections, no bevels.

Authentic early-1990s arcade cabinet screen printing — saturated, high contrast, hard-edged airbrush illustration with heavy black outlines and chrome-and-gradient lettering, flat colour the way ink sits on a printed vinyl decal. No captions or labels beyond the logo and the text asked for.`
}

// --- the running order ------------------------------------------------------------------------

const cut = (cmd) => '`node scripts/fighter-sheet.mjs ' + cmd + '`'
const tpl = (name) => '`art-templates/' + name + '`'

function buildPhases() {
  const bibleNo = {}
  const phases = [
    {
      name: 'Phase 1 — a playable roster',
      note: 'Twenty-four generations and all twelve are in the game. Two prompts per character: the bible, then one sheet of twenty poses which is a complete fighter on its own. Do Kestrel and Bollard first (prompts 1–4) and stop to look — whatever you have to fix in those prompts you would otherwise fix twelve times.',
      items: CAST.flatMap((c) => [
        { who: c.name, label: 'CHARACTER BIBLE', attach: tpl('reference.png') + ' only', cut: cut(`ext/${c.id}-bible.png ${c.id} reference`), text: bible(c), bible: c.id },
        { who: c.name, label: 'SHEET A — twenty poses, a complete fighter', attachBible: c.id, attach: tpl('moves-a.png'), cut: cut(`ext/${c.id}-a.png ${c.id} moves-a --dry-run`), text: sheet(SHEET_A, AIRBORNE_A) },
      ]),
    },
    {
      name: 'Phase 2 — arenas',
      note: 'Two prompts per stage: the three parallax layers on one canvas, then twenty cut-out objects to dress it with. Four arenas is more than enough to ship with.',
      items: STAGES.flatMap((s) => [
        { who: s.name, label: 'STAGE — three parallax layers', attach: tpl('stage.png') + ' only', cut: cut(`ext/${s.id}-stage.png ${s.id} stage`), text: stage(s) },
        { who: s.name, label: 'PROPS — twenty cut-out objects', attach: tpl('props.png') + ', and the finished stage layers as a style reference', cut: cut(`ext/${s.id}-props.png ${s.id} props`), text: props(s) },
      ]),
    },
    {
      name: 'Phase 3 — polish',
      note: 'A second sheet of twenty per character: both specials, the in-between frames that make a walk read as a walk, and the flourishes. Box 1 repeats IDLE on purpose — it is a size reference the cutter uses to reconcile this sheet against the first. Do not skip it and do not redraw it differently.',
      items: CAST.map((c) => ({ who: c.name, label: 'SHEET B — specials, in-betweens, flourishes', attachBible: c.id, attach: tpl('moves-b.png'), cut: cut(`ext/${c.id}-b.png ${c.id} moves-b --dry-run`), text: sheet(sheetB(c), AIRBORNE_B) })),
    },
    {
      name: 'Phase 4 — the cabinet and the select screen',
      note: "The cabinet uses the arcade's existing template and cutter, not the fighter's. The portraits are optional — the bible already has three head studies, and `--only head-three-quarter` cuts one out as a serviceable mug shot for free.",
      items: [
        { who: 'CONCRETE CROWN', label: 'ARCADE CABINET — all five panels', attach: '`../arcade/art-templates/sheet.png`, and any finished character bible as the style reference', cut: '`node scripts/cabinet-sheet.mjs ext/crown-cab.png crown --dry-run`', text: cabinet() },
        ...CAST.map((c) => ({ who: c.name, label: 'PORTRAIT — character select', attachBible: c.id, attach: tpl('portrait.png'), cut: cut(`ext/${c.id}-portrait.png ${c.id} portrait`), text: portrait(c) })),
      ],
    },
    {
      name: 'Phase 5 — the 3D pipeline',
      note: 'Only needed when the 2.5D/3D layer is actually being built. See tools/photogrammetry/README.md — and read the note there about trying the single A-pose from the bible first, because eight nearly-consistent views often reconstruct worse than one clean one.',
      items: CAST.map((c) => ({ who: c.name, label: 'TURNAROUND — eight camera angles', attachBible: c.id, attach: tpl('turnaround.png'), cut: cut(`ext/${c.id}-turn.png ${c.id} turnaround`), text: turnaround() })),
    },
  ]

  let n = 0
  for (const ph of phases) {
    for (const it of ph.items) {
      it.n = ++n
      if (it.bible) bibleNo[it.bible] = it.n
    }
  }
  return { phases, bibleNo, total: n }
}

const { phases, bibleNo, total } = buildPhases()

function renderPhases(list) {
  const out = []
  for (const ph of list) {
    out.push(`\n---\n\n# ${ph.name}\n`)
    out.push(`${ph.note}\n`)
    for (const it of ph.items) {
      out.push(`## ${it.n}. ${it.who} — ${it.label}\n`)
      const attach = it.attachBible
        ? `the finished bible from prompt ${bibleNo[it.attachBible]} **first**, then ${it.attach}`
        : it.attach
      out.push(`**Attach:** ${attach}\n`)
      out.push(`**Cut with:** ${it.cut}\n`)
      out.push('```text')
      out.push(it.text)
      out.push('```\n')
    }
  }
  return out.join('\n')
}

const argv = process.argv.slice(2)
const only = argv.includes('--only') ? argv[argv.indexOf('--only') + 1] : null

if (argv.includes('--list')) {
  for (const ph of phases) {
    console.log(`\n${ph.name}`)
    for (const it of ph.items) console.log(`  ${String(it.n).padStart(2)}.  ${it.who.padEnd(22)} ${it.label}`)
  }
  process.exit(0)
}

if (only) {
  const picked = phases
    .map((ph) => ({ ...ph, items: ph.items.filter((it) => it.who.toLowerCase().includes(only.toLowerCase())) }))
    .filter((ph) => ph.items.length)
  if (!picked.length) {
    console.error(`fighter-prompts: nothing matches ${only}`)
    process.exit(1)
  }
  process.stdout.write(renderPhases(picked))
  process.exit(0)
}

const header = `# Every prompt, in order

Generated by \`scripts/fighter-prompts.mjs\` — **do not hand-edit**; change the script and run it again.

${total} prompts, each one a single copy and paste with nothing left to assemble. [ART.md](ART.md)
explains why they are shaped the way they are; this file is for working through. The roster is in
[ROSTER.md](ROSTER.md).

## Before you start

\`\`\`bash
node scripts/fighter-template.mjs     # blank templates land in ext/
\`\`\`

The templates are **2390 x 1792** — exactly what the generator returns, and exactly 4:3 — so nothing
is resampled going in or cropped coming out. Any other 4:3 output still works; the cutter says so.

## The order that matters

| Phase | Prompts | Numbers |
|---|---|---|
${phases.map((ph) => `| ${ph.name.replace(/^Phase \d+ — /, '')} | ${ph.items.length} | ${ph.items[0].n}–${ph.items[ph.items.length - 1].n} |`).join('\n')}

**You do not need all ${total}.** Phase 1 alone — twenty-four generations — puts all twelve
characters in the playable game. Everything after it is width, not depth.

## Three things that will bite you

1. **Check the palette strip on every bible before going on.** If there is a mid-grey swatch in it,
   say *"replace the grey swatch — the costume cannot contain grey"* and generate again. Grey is the
   key colour; a grey costume gets holes cut in it twenty poses later.
2. **Scale is the one error you cannot fix by eye.** Rule 2 in every sheet prompt exists for it.
   *Across* sheets it is handled for you — sheet B repeats IDLE as a size reference and the cutter
   rescales the whole sheet to match — but *within* a sheet, poses drawn at different sizes mean the
   sheet has to be redone.
3. **Never name a real game, studio or character**, in these prompts or in follow-ups. They name the
   era and the printing technique instead. See the note at the top of ROSTER.md.

Three or four bad boxes out of twenty is normal, and is what \`--only\` is for: regenerate the whole
sheet, then cut just the boxes that came back better.
`

mkdirSync(path.dirname(OUT), { recursive: true })
writeFileSync(OUT, `${header}${renderPhases(phases)}`)
console.log(`${path.relative(ROOT, OUT)}  ${total} prompts across ${phases.length} phases`)
console.log(`  one character or stage:  node scripts/fighter-prompts.mjs --only kestrel`)
console.log(`  just the running order:  node scripts/fighter-prompts.mjs --list`)
