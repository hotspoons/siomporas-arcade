"""The corridor sound bank, cut from CC0 sources.

    python3 -m venv tools/sounds/.venv && tools/sounds/.venv/bin/pip install soundfile numpy
    tools/sounds/.venv/bin/python -I tools/sounds/build.py            # everything
    tools/sounds/.venv/bin/python -I tools/sounds/build.py gun.fire   # one slot
    tools/sounds/.venv/bin/python -I tools/sounds/build.py --list     # the slots and what feeds them

Sources (tools/sounds/sources.json) are downloaded once into tools/sounds/.cache/ and cut into
apps/corridor/public/sounds/<slot>/<name>.ogg (+ .mp3 for browsers without Vorbis), each mono,
44.1 kHz, trimmed to its onset, peak-normalised to -1 dBFS, with a short fade either end. The
manifest apps/corridor/public/sounds/bank.json lists every slot with its clips (file, duration,
loop, relative gain); the game loads from the manifest, never from file names, and a vehicle or
actor document overrides a slot with its own clips through the same shape. CREDITS.md is written
from sources.json — add a source there, not here.

THE SLOTS are named for what the game wants to say, not for what the file is: `gun.hit` is "a
bullet landed on a car", wherever the recording came from. A slot's clips are variations the
player picks from at random (never the same one twice running); `tire.squeal.loop` is the
exception — ordered light → heavy, crossfaded by slip.

CUTTING. Kenney's one-shots are used as they are. The BigSoundBank shots (0437 Beretta M12, 0438
.357, 0397 Winchester, 0532 shotgun) and Tabasco's range recordings hold several shots per file;
they are split on onsets (energy envelope jumping 8× over the preceding 200 ms, 300 ms apart) and
each shot is cut to 450 ms with an exponential tail so a 10 Hz machine gun does not pile up tails.
The squeal loops are windows of the 30 s BigSoundBank squeal chosen by level (RMS quantile) and
steadiness (lowest envelope variance), closed with a 150 ms equal-power crossfade. The missile
launch is Kenney's thruster cut to 1.2 s under a low-frequency thump — there is no CC0 missile
launch recording worth the name; replace it the day one turns up.
"""
from __future__ import annotations

import io
import json
import sys
import urllib.request
import zipfile
from pathlib import Path

import numpy as np
import soundfile as sf

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent.parent
CACHE = HERE / '.cache'
OUT = ROOT / 'apps' / 'corridor' / 'public' / 'sounds'
SR = 44100
PEAK = 10 ** (-1 / 20)  # -1 dBFS
UA = {'User-Agent': 'Mozilla/5.0 (corridor sound bank build)'}

SOURCES = json.loads((HERE / 'sources.json').read_text())['sources']


# ---------------------------------------------------------------- fetching

def fetch(url: str, dest: Path) -> Path:
    if dest.exists() and dest.stat().st_size > 2000:
        return dest
    dest.parent.mkdir(parents=True, exist_ok=True)
    print(f'  fetch {url}')
    with urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=120) as r:
        data = r.read()
    if len(data) < 2000 or data[:15].lower().startswith(b'<!doctype html'):
        raise SystemExit(f'{url}: got {len(data)} bytes of not-audio; the source moved?')
    dest.write_bytes(data)
    return dest


def source_file(src: str, name: str) -> Path:
    """A file out of a source: a member of its zip, or one of its listed files."""
    s = SOURCES[src]
    d = CACHE / src
    if s['kind'] == 'zip':
        marker = d / '.unpacked'
        if not marker.exists():
            z = fetch(s['download'], CACHE / f'{src}.zip')
            with zipfile.ZipFile(z) as zf:
                zf.extractall(d)
            marker.write_text('')
        hits = list(d.rglob(name))
        if not hits:
            raise SystemExit(f'{src}: no {name!r} in {s["download"]}')
        return hits[0]
    if s['kind'] == 'files':
        if name not in s['files']:
            raise SystemExit(f'{src}: {name} is not in sources.json')
        url = s['download'].format(id=name)
        return fetch(url, d / Path(url).name)
    raise SystemExit(f'{src}: kind {s["kind"]}')


# ---------------------------------------------------------------- signal

def load(path: Path) -> np.ndarray:
    data, sr = sf.read(str(path), dtype='float32', always_2d=True)
    x = data.mean(axis=1)
    if sr != SR:
        n = int(round(len(x) * SR / sr))
        x = np.interp(np.linspace(0, len(x) - 1, n), np.arange(len(x)), x).astype(np.float32)
    return x


def envelope(x: np.ndarray, win_s: float) -> np.ndarray:
    w = max(1, int(win_s * SR))
    p = np.concatenate([[0.0], np.cumsum(x.astype(np.float64) ** 2)])
    idx = np.arange(0, len(x) - w + 1, w)
    return np.sqrt((p[idx + w] - p[idx]) / w)


def trim_start(x: np.ndarray, db: float = -45, pre_s: float = 0.004) -> np.ndarray:
    thr = 10 ** (db / 20) * max(1e-9, float(np.abs(x).max()))
    above = np.nonzero(np.abs(x) > thr)[0]
    if not len(above):
        return x
    return x[max(0, above[0] - int(pre_s * SR)):]


def trim_end(x: np.ndarray, db: float = -60) -> np.ndarray:
    thr = 10 ** (db / 20) * max(1e-9, float(np.abs(x).max()))
    above = np.nonzero(np.abs(x) > thr)[0]
    return x[: above[-1] + int(0.02 * SR)] if len(above) else x


def cut(x: np.ndarray, max_s: float, tail_s: float) -> np.ndarray:
    """At most max_s long; the last tail_s decays exponentially so a hard cut is not a click."""
    n = min(len(x), int(max_s * SR))
    x = x[:n].copy()
    t = min(n, int(tail_s * SR))
    if t > 1:
        x[n - t:] *= np.exp(-6 * np.linspace(0, 1, t)).astype(np.float32)
    return x


def fades(x: np.ndarray, in_s: float = 0.003, out_s: float = 0.02) -> np.ndarray:
    x = x.copy()
    a = min(len(x) // 2, int(in_s * SR))
    b = min(len(x) // 2, int(out_s * SR))
    if a > 1:
        x[:a] *= np.linspace(0, 1, a, dtype=np.float32)
    if b > 1:
        x[-b:] *= np.linspace(1, 0, b, dtype=np.float32)
    return x


def normalise(x: np.ndarray, peak: float = PEAK) -> np.ndarray:
    m = float(np.abs(x).max())
    return x * (peak / m) if m > 1e-6 else x


def mix(*layers: tuple[np.ndarray, float]) -> np.ndarray:
    n = max(len(x) for x, _ in layers)
    out = np.zeros(n, dtype=np.float32)
    for x, g in layers:
        out[: len(x)] += x * g
    return out


def onsets(x: np.ndarray, gap_s: float = 0.3, ratio: float = 8.0, floor: float = 0.15) -> list[int]:
    """Sample indices where a shot starts: the 2 ms envelope jumps `ratio`× over the mean of the
    preceding 200 ms and clears `floor` × the file's loudest frame, at least gap_s apart."""
    win = 0.002
    pad = int(0.25 * SR)  # a shot that starts at sample 0 still needs a quiet run-up to jump over
    env = envelope(np.concatenate([np.zeros(pad, dtype=x.dtype), x]), win)
    w = int(win * SR)
    back = int(0.2 / win)
    peak = env.max()
    out, last = [], -10 ** 9
    for i in range(back, len(env)):
        prev = env[i - back:i].mean() + 1e-6
        if env[i] > floor * peak and env[i] / prev > ratio and (i * w - last) > gap_s * SR:
            out.append(max(0, i * w - pad))
            last = i * w
    return out


def split_shots(x: np.ndarray, shot_s: float, tail_s: float, want: int | None = None) -> list[np.ndarray]:
    shots = [cut(trim_start(x[o:]), shot_s, tail_s) for o in onsets(x)]
    shots = [s for s in shots if len(s) > 0.05 * SR]
    if want is not None:
        shots = sorted(shots, key=lambda s: -float(np.abs(s).max()))[:want]
    return shots


def loop_windows(x: np.ndarray, length_s: float, levels: list[float], xfade_s: float = 0.15) -> list[np.ndarray]:
    """One seamless loop per requested RMS quantile: among windows whose level sits at that
    quantile, the steadiest (lowest envelope variance), never overlapping an earlier pick."""
    frame = 0.05
    env = envelope(x, frame)
    L = int(length_s / frame)
    X = int(xfade_s * SR)
    n = int(length_s * SR)
    cands = []
    for i in range(0, len(env) - L - int(xfade_s / frame) - 1):
        seg = env[i:i + L]
        cands.append((i, float(seg.mean()), float(seg.std() / (seg.mean() + 1e-9))))
    levels_rms = np.quantile([c[1] for c in cands], levels)
    picks, out = [], []
    for target in levels_rms:
        near = sorted(cands, key=lambda c: abs(c[1] - target))[: max(8, len(cands) // 20)]
        near = [c for c in near if all(abs(c[0] - p) >= L for p in picks)] or near
        i = min(near, key=lambda c: c[2])[0]
        picks.append(i)
        s = i * int(frame * SR)
        seg = x[s:s + n + X].astype(np.float32)
        loop = seg[:n].copy()
        ramp = np.sin(np.linspace(0, np.pi / 2, X)) ** 2  # equal power
        loop[:X] = seg[:X] * ramp + seg[n:n + X] * (1 - ramp)
        out.append(loop)
    return out


# ---------------------------------------------------------------- recipes

def kenney(pack: str, stem: str, n: int = 5) -> list[tuple[str, Path]]:
    return [(f'{stem}_{i:03d}', source_file(pack, f'{stem}_{i:03d}.ogg')) for i in range(n)]


def one_shots(files: list[tuple[str, Path]], max_s: float, tail_s: float) -> list[tuple[str, np.ndarray]]:
    return [(name, cut(trim_end(trim_start(load(p))), max_s, tail_s)) for name, p in files]


def slot_tire_squeal_loop():
    x = load(source_file('bsb', '0500'))
    loops = loop_windows(x, 2.5, [0.25, 0.55, 0.92])
    return [(f'squeal-{lvl}', l) for lvl, l in zip(('light', 'medium', 'heavy'), loops)], {'loop': True, 'ordered': True}


def slot_tire_skid():
    files = [(f'skid-{i}', source_file('bsb', i)) for i in ('2368', '2369', '2370')]
    clips = one_shots(files, 2.5, 0.4)
    clips.append(('skid-long', cut(trim_end(trim_start(load(source_file('bsb', '2371')))), 7.0, 1.0)))
    return clips, {}


def slot_crash(level: str):
    stems = {
        'light': [('kenney-impact', 'impactMetal_light'), ('kenney-impact', 'impactPlate_light')],
        'medium': [('kenney-impact', 'impactMetal_medium'), ('kenney-impact', 'impactPlate_medium'), ('kenney-impact', 'impactTin_medium')],
        'heavy': [('kenney-impact', 'impactMetal_heavy'), ('kenney-impact', 'impactPlate_heavy')],
    }[level]
    files = [f for pack, stem in stems for f in kenney(pack, stem)]
    clips = one_shots(files, 1.5, 0.2)
    if level == 'heavy':
        # Eldritch Grim's bass-boosted slams, the eight strongest: the body-on-body part of a wreck
        slams = [(f'slam-{i}', cut(trim_end(trim_start(load(source_file('oga-impacts', f'Impact {i}.wav')))), 1.6, 0.4)) for i in range(1, 16)]
        slams = sorted(slams, key=lambda c: -float(np.sqrt((c[1] ** 2).mean())))[:8]
        clips += slams
    return clips, {}


def slot_crash_glass():
    files = [f for stem in ('impactGlass_light', 'impactGlass_medium', 'impactGlass_heavy') for f in kenney('kenney-impact', stem)]
    return one_shots(files, 1.5, 0.2), {}


def slot_crash_soft():
    files = [f for stem in ('impactSoft_medium', 'impactSoft_heavy', 'impactPunch_medium', 'impactPunch_heavy') for f in kenney('kenney-impact', stem)]
    return one_shots(files, 1.0, 0.15), {}


def slot_explosion():
    crunch = one_shots(kenney('kenney-scifi', 'explosionCrunch'), 1.6, 0.4)
    lows = [trim_start(load(p)) for _, p in kenney('kenney-scifi', 'lowFrequency_explosion', 2)]
    clips = [(f'blast-{i}', mix((c, 1.0), (lows[i % 2], 0.8))) for i, (_, c) in enumerate(crunch)]
    for i in ('1807', '1808', '1806'):
        clips.append((f'bang-{i}', mix((trim_start(load(source_file('bsb', i))), 1.0), (lows[0], 0.5))))
    return clips, {}


def slot_explosion_far():
    clips = [('far-1023', cut(trim_end(trim_start(load(source_file('bsb', '1023')))), 4.0, 1.0))]
    clips += [(name, trim_start(load(p))) for name, p in kenney('kenney-scifi', 'lowFrequency_explosion', 2)]
    return clips, {}


def slot_missile_launch():
    lows = [trim_start(load(p)) for _, p in kenney('kenney-scifi', 'lowFrequency_explosion', 2)]
    clips = []
    for i, (name, p) in enumerate(kenney('kenney-scifi', 'thrusterFire')):
        thr = cut(trim_start(load(p)), 1.2, 0.6)
        clips.append((f'launch-{i}', mix((thr, 1.0), (cut(lows[i % 2], 0.5, 0.3), 0.45))))
    return clips, {}


def slot_gun_fire():
    clips = []
    for i, want in (('0437', 4), ('0438', 3), ('0397', 3)):
        clips += [(f'bsb{i}-{k}', s) for k, s in enumerate(split_shots(load(source_file('bsb', i)), 0.45, 0.15, want))]
    for stem, want in (('cz', 4), ('sks', 4), ('mosin', 3)):
        clips += [(f'{stem}-{k}', s) for k, s in enumerate(split_shots(load(source_file('oga-gunshots', f'{stem}.wav')), 0.45, 0.15, want))]
    return clips, {}


def slot_gun_fire_shotgun():
    clips = [(f'shotgun-{k}', s) for k, s in enumerate(split_shots(load(source_file('bsb', '0532')), 0.8, 0.25, 4))]
    clips.append(('shotty', cut(trim_start(load(source_file('oga-gunshots', 'shotty.wav'))), 0.8, 0.25)))
    return clips, {}


def slot_gun_hit():
    files = kenney('kenney-impact', 'impactMetal_light') + kenney('kenney-impact', 'impactGeneric_light')
    clips = one_shots(files, 0.6, 0.1)
    clips += [(f'impactgun-{i}', cut(trim_end(trim_start(load(source_file('oga-impacts', f'Impact Gun {i}.wav')))), 0.6, 0.15)) for i in range(1, 6)]
    return clips, {}


def slot_gun_hit_glass():
    return one_shots(kenney('kenney-impact', 'impactGlass_light'), 0.6, 0.1), {}


def slot_gun_hit_ground():
    files = kenney('kenney-impact', 'impactMining') + kenney('kenney-impact', 'footstep_concrete')
    return one_shots(files, 0.5, 0.1), {}


SLOTS = {
    'tire.squeal.loop': ('light → heavy squeal loops, crossfaded by slip', slot_tire_squeal_loop),
    'tire.skid': ('a skid that starts and stops: lock-ups, handbrake turns', slot_tire_skid),
    'crash.light': ('a tap: kerbs, bollards, the side of a parked car', lambda: slot_crash('light')),
    'crash.medium': ('a proper hit', lambda: slot_crash('medium')),
    'crash.heavy': ('a wreck: head-on, a roll, a wall at speed', lambda: slot_crash('heavy')),
    'crash.glass': ('glazing going, layered over a crash', slot_crash_glass),
    'crash.soft': ('hitting something that is not metal: a pedestrian, a bush, a bin bag', slot_crash_soft),
    'explosion': ('a missile landing, a car going up', slot_explosion),
    'explosion.far': ('the same, heard from a distance', slot_explosion_far),
    'missile.launch': ('a missile leaving the rail', slot_missile_launch),
    'gun.fire': ('one round from the machine gun', slot_gun_fire),
    'gun.fire.shotgun': ('one shotgun blast', slot_gun_fire_shotgun),
    'gun.hit': ('a round landing on a car', slot_gun_hit),
    'gun.hit.glass': ('a round through a window', slot_gun_hit_glass),
    'gun.hit.ground': ('a round into the road or the verge', slot_gun_hit_ground),
}


# ---------------------------------------------------------------- output

def write_clip(path: Path, x: np.ndarray, mp3: bool) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    try:
        sf.write(str(path), x, SR, format='OGG', subtype='VORBIS', compression_level=0.5)
    except TypeError:  # older soundfile: no compression_level
        sf.write(str(path), x, SR, format='OGG', subtype='VORBIS')
    if mp3:
        sf.write(str(path.with_suffix('.mp3')), x, SR, format='MP3', subtype='MPEG_LAYER_III')


def build(names: list[str], mp3: bool) -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    manifest_path = OUT / 'bank.json'
    manifest = json.loads(manifest_path.read_text()) if manifest_path.exists() else {'version': 1, 'slots': {}}
    for slot in names:
        desc, fn = SLOTS[slot]
        print(f'{slot}: {desc}')
        clips, opts = fn()
        if not clips:
            raise SystemExit(f'{slot}: produced no clips')
        folder = OUT / slot.replace('.', '-')
        if folder.exists():
            for old in folder.iterdir():
                old.unlink()
        entries = []
        for name, x in clips:
            x = normalise(fades(x.astype(np.float32)))
            if not np.isfinite(x).all():
                raise SystemExit(f'{slot}/{name}: NaN in the cut')
            rel = f'{folder.name}/{name}.ogg'
            write_clip(OUT / rel, x, mp3)
            entries.append({'file': rel, 's': round(len(x) / SR, 3), 'rms': round(float(np.sqrt((x ** 2).mean())), 4)})
            print(f'   {rel:48s} {len(x) / SR:5.2f}s')
        manifest['slots'][slot] = {'desc': desc, **opts, 'clips': entries}
    manifest['slots'] = dict(sorted(manifest['slots'].items()))
    manifest['formats'] = ['ogg', 'mp3'] if mp3 else ['ogg']
    manifest_path.write_text(json.dumps(manifest, indent=1) + '\n')
    write_credits()


def write_credits() -> None:
    lines = ['# Sounds', '', 'Every clip under this directory is cut from a CC0 (public domain) recording by '
             '`tools/sounds/build.py`; the cuts are CC0 too. Attribution is not required by any of them and is '
             'given here because it is deserved.', '']
    for key, s in SOURCES.items():
        lines.append(f'- **{s["title"]}** — {s["author"]}, {s["licence"]}. <{s["url"]}>')
        for fid, f in s.get('files', {}).items():
            lines.append(f'  - #{fid} {f["name"]} <{f["url"]}>')
    lines += ['', 'The slot each clip serves is in `bank.json`; a world, vehicle or actor may replace any slot with '
              'its own clips (see docs/corridor/SOUNDS.md).', '']
    (OUT / 'CREDITS.md').write_text('\n'.join(lines))


if __name__ == '__main__':
    args = [a for a in sys.argv[1:] if not a.startswith('--')]
    flags = {a for a in sys.argv[1:] if a.startswith('--')}
    if '--list' in flags:
        for k, (d, _) in SLOTS.items():
            print(f'{k:20s} {d}')
        sys.exit(0)
    bad = [a for a in args if a not in SLOTS]
    if bad:
        raise SystemExit(f'unknown slot(s) {bad}; --list shows them')
    build(args or list(SLOTS), mp3='--no-mp3' not in flags)
