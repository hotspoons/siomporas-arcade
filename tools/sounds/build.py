"""The corridor sound bank, cut from CC0 sources.

    python3 -m venv tools/sounds/.venv && tools/sounds/.venv/bin/pip install soundfile numpy
    tools/sounds/.venv/bin/python -I tools/sounds/build.py            # everything
    tools/sounds/.venv/bin/python -I tools/sounds/build.py gun.fire   # one slot
    tools/sounds/.venv/bin/python -I tools/sounds/build.py --list     # the slots and what feeds them
    tools/sounds/.venv/bin/python -I tools/sounds/build.py --spectrograms  # a PNG per slot in .cache, to look at the cuts

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
The tyres are Rich's own recordings (tools/sounds/own/README.md), his engines gated out of them
by `isolate_squeal`, cut into three loop levels and six skid passages — the BigSoundBank parking
squeak this started with was "a mouse" (Rich, 2026-10-09). The missile
launch is qubodup's CC0 rocket launch (OpenGameArt) under the SSE library's launching swooshes
(archive.org, CC0), one swoosh per variant, with Kenney's thruster as a sixth voice.
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
from scipy import signal

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent.parent
CACHE = HERE / '.cache'
OUT = ROOT / 'apps' / 'corridor' / 'public' / 'sounds'
SR = 44100
PEAK = 10 ** (-1 / 20)  # -1 dBFS
UA = {'User-Agent': 'Mozilla/5.0 (corridor sound bank build)'}

SOURCES = json.loads((HERE / 'sources.json').read_text())['sources']


# ---------------------------------------------------------------- fetching

def fetch(url: str, dest: Path, mirror: str | None = None) -> Path:
    if dest.exists() and dest.stat().st_size > 2000:
        return dest
    dest.parent.mkdir(parents=True, exist_ok=True)
    data = b''
    for u in [url] + ([mirror] if mirror else []):
        print(f'  fetch {u}')
        try:
            with urllib.request.urlopen(urllib.request.Request(u, headers=UA), timeout=120) as r:
                data = r.read()
        except Exception as e:  # archive.org's canonical /download/ URL 500s now and then; the item's own server answers
            print(f'  {u}: {e}')
            continue
        if len(data) >= 2000 and not data[:15].lower().startswith((b'<!doctype html', b'<html')):
            break
    if len(data) < 2000 or data[:15].lower().startswith((b'<!doctype html', b'<html')):
        raise SystemExit(f'{url}: got {len(data)} bytes of not-audio; the source moved?')
    dest.write_bytes(data)
    return dest


def source_file(src: str, name: str) -> Path:
    """A file out of a source: a member of its zip, or one of its listed files."""
    s = SOURCES[src]
    d = CACHE / src
    if s['kind'] in ('zip', '7z'):
        marker = d / '.unpacked'
        if not marker.exists():
            z = fetch(s['download'], CACHE / f'{src}.{s["kind"]}')
            if s['kind'] == 'zip':
                with zipfile.ZipFile(z) as zf:
                    zf.extractall(d)
            else:
                import py7zr  # pip install py7zr — only the one OpenGameArt launch needs it
                with py7zr.SevenZipFile(z) as zf:
                    zf.extractall(d)
            marker.write_text('')
        hits = list(d.rglob(name))
        if not hits:
            raise SystemExit(f'{src}: no {name!r} in {s["download"]}')
        return hits[0]
    if s['kind'] == 'local':
        f = HERE / s['root'] / name
        if not f.exists():
            raise SystemExit(f'{src}: no {f}')
        return f
    if s['kind'] == 'files':
        if name not in s['files']:
            raise SystemExit(f'{src}: {name} is not in sources.json')
        url = s['files'][name].get('download') or s['download'].format(id=name)
        return fetch(url, d / (name + Path(url.split('?')[0]).suffix), s.get('mirror'))
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


def level(x: np.ndarray, rms_db: float, ceiling: float = PEAK) -> np.ndarray:
    """Set the clip's loudness, not its peak: RMS to `rms_db` dBFS, then the peak held under the
    ceiling. Peak-normalising everything put a glass tinkle and a wreck at the same height
    (Rich, 2026-10-09: "way too loud")."""
    r = float(np.sqrt((x.astype(np.float64) ** 2).mean()))
    if r < 1e-6:
        return x
    y = x * (10 ** (rms_db / 20) / r)
    m = float(np.abs(y).max())
    return (y * (ceiling / m) if m > ceiling else y).astype(np.float32)


def isolate_squeal(x: np.ndarray, noise_s: tuple[float, float] = (0.0, 0.4), hp_hz: float = 650.0, lp_hz: float = 9000.0, keep: float = 2.2) -> np.ndarray:
    """Tyre out of a car recording. The engine, the wind and the road sit under ~600 Hz; the
    squeal is a tone at 1–1.5 kHz with harmonics to 4 kHz. So: a 4th-order high-pass, a low-pass
    over the codec hiss, then a spectral gate whose noise floor is learned from `noise_s` of the
    same clip (the run-in before the tyres let go) — every STFT bin under `keep` × its own floor
    is pulled down, softly, so what is left is what was not there before the squeal."""
    sos = signal.butter(4, [hp_hz, min(lp_hz, SR / 2 - 100)], btype='bandpass', fs=SR, output='sos')
    y = signal.sosfiltfilt(sos, x.astype(np.float64))
    n_fft, hop = 2048, 512
    f, t, Z = signal.stft(y, fs=SR, nperseg=n_fft, noverlap=n_fft - hop, padded=True)
    mag = np.abs(Z)
    a, b = int(noise_s[0] * SR / hop), max(int(noise_s[0] * SR / hop) + 2, int(noise_s[1] * SR / hop))
    floor = np.percentile(mag[:, a:b], 90, axis=1, keepdims=True) + 1e-9
    ratio = mag / (floor * keep)
    mask = np.clip((ratio - 0.5) / 1.0, 0, 1) ** 1.5  # 0 under half the threshold, 1 past 1.5×
    # smooth the mask a little in time and frequency so the gate does not chatter
    mask = signal.convolve2d(mask, np.ones((3, 5)) / 15, mode='same')
    _, out = signal.istft(Z * mask, fs=SR, nperseg=n_fft, noverlap=n_fft - hop)
    out = out[: len(x)]
    if len(out) < len(x):
        out = np.pad(out, (0, len(x) - len(out)))
    return out.astype(np.float32)


def seconds(x: np.ndarray, a: float, b: float) -> np.ndarray:
    return x[int(a * SR):int(b * SR)]


def make_loop(seg: np.ndarray, xfade_s: float = 0.15) -> np.ndarray:
    """Close a segment into a seamless loop: the last `xfade_s` is folded over the first with an
    equal-power crossfade and dropped from the end."""
    X = int(xfade_s * SR)
    n = len(seg) - X
    loop = seg[:n].copy()
    ramp = np.sin(np.linspace(0, np.pi / 2, X)) ** 2
    loop[:X] = seg[:X] * ramp + seg[n:n + X] * (1 - ramp)
    return loop


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


def own(name: str) -> np.ndarray:
    return load(source_file('own', name))


def slot_tire_squeal_loop():
    """Rich's own tyres, isolated from his engines (tools/sounds/own). The BigSoundBank parking
    squeak this started with was, in his words, a mouse. Light is the Subaru scrubbing from
    outside the car, medium its tonal squeal, heavy the Lotus at the top of its pirouette."""
    light = make_loop(seconds(isolate_squeal(own('subaru-outside-a.wav'), (0.0, 0.5)), 1.0, 1.95))
    medium = make_loop(seconds(isolate_squeal(own('subaru-outside-b.wav'), (0.0, 0.5)), 0.95, 2.3))
    heavy = make_loop(seconds(isolate_squeal(own('lotus-pirouette.wav'), (0.0, 0.4)), 2.1, 3.5))
    return [('squeal-light', light), ('squeal-medium', medium), ('squeal-heavy', heavy)], {'loop': True, 'ordered': True}


def slot_tire_skid():
    """Whole passages, for a skid that starts and stops: the Lotus losing it twice, the Subaru
    scrubbing through a corner."""
    lotus = isolate_squeal(own('lotus-pirouette.wav'), (0.0, 0.4))
    sub_b = isolate_squeal(own('subaru-outside-b.wav'), (0.0, 0.5))
    sub_a = isolate_squeal(own('subaru-outside-a.wav'), (0.0, 0.5))
    scrub = isolate_squeal(own('subaru-scrub-c.wav'), (0.0, 0.4), hp_hz=800)
    return [
        ('lotus-pirouette', cut(seconds(lotus, 0.45, 3.7), 3.3, 0.5)),
        ('lotus-oversteer', cut(seconds(lotus, 0.45, 2.0), 1.6, 0.35)),
        ('lotus-correction', cut(seconds(lotus, 2.0, 3.7), 1.7, 0.4)),
        ('subaru-squeal', cut(seconds(sub_b, 0.8, 2.6), 1.8, 0.4)),
        ('subaru-scrub', cut(seconds(sub_a, 0.8, 2.1), 1.3, 0.35)),
        ('subaru-scrub-inside', cut(seconds(scrub, 0.6, 1.6), 1.0, 0.3)),
    ], {}


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
    """qubodup's rocket launch (the ignition and the first second and a half of roar) under the
    launching swooshes from the SSE library split one by one, so each variant has its own
    whoosh over the same motor; a low thump under all of it."""
    lows = [trim_start(load(p)) for _, p in kenney('kenney-scifi', 'lowFrequency_explosion', 2)]
    motor = cut(trim_start(load(source_file('oga-launch', 'launch.wav'))), 1.6, 0.7)
    swooshes = split_shots(load(source_file('ia-sse-swooshes', 'fireworks-launch')), 1.2, 0.4)
    if not swooshes:
        raise SystemExit('missile.launch: no swooshes found in the SSE fireworks file')
    clips = []
    for i, sw in enumerate(swooshes[:5]):
        clips.append((f'launch-{i}', mix((sw, 0.9), (motor, 0.8), (cut(lows[i % 2], 0.5, 0.3), 0.4))))
    # and the thruster version, so the rail has a sci-fi voice to pick too
    thr = cut(trim_start(load(source_file('kenney-scifi', 'thrusterFire_000.ogg'))), 1.2, 0.6)
    clips.append(('launch-thruster', mix((thr, 1.0), (motor, 0.5), (cut(lows[0], 0.5, 0.3), 0.45))))
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


# loudness per slot, RMS dBFS (the peak is held under -1 dBFS whatever this says). A wreck is
# louder than a tap, a gun louder than a hit, the squeal loops quiet because the game opens them
# by level and three play at once.
LEVELS = {
    'tire.squeal.loop': -22, 'tire.skid': -18,
    'crash.light': -20, 'crash.medium': -16, 'crash.heavy': -12, 'crash.glass': -20, 'crash.soft': -20,
    'explosion': -10, 'explosion.far': -18, 'missile.launch': -15,
    'gun.fire': -14, 'gun.fire.shotgun': -12, 'gun.hit': -20, 'gun.hit.glass': -20, 'gun.hit.ground': -22,
}

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
            x = level(fades(x.astype(np.float32)), LEVELS[slot])
            if not np.isfinite(x).all():
                raise SystemExit(f'{slot}/{name}: NaN in the cut')
            rel = f'{folder.name}/{name}.ogg'
            write_clip(OUT / rel, x, mp3)
            entries.append({'file': rel, 's': round(len(x) / SR, 3), 'rms': round(float(np.sqrt((x ** 2).mean())), 4), 'peak': round(float(np.abs(x).max()), 3)})
            print(f'   {rel:48s} {len(x) / SR:5.2f}s')
        manifest['slots'][slot] = {'desc': desc, **opts, 'clips': entries}
    manifest['slots'] = dict(sorted(manifest['slots'].items()))
    manifest['formats'] = ['ogg', 'mp3'] if mp3 else ['ogg']
    manifest_path.write_text(json.dumps(manifest, indent=1) + '\n')
    write_credits()


def write_credits() -> None:
    lines = ['# Sounds', '', 'Every clip under this directory is cut by `tools/sounds/build.py` from either a CC0 '
             '(public domain) recording — those cuts are CC0 too, and attribution is given because it is deserved — '
             'or from a recording Rich Siomporas made and holds the rights to (the tyres: `tire-*`), which ships with '
             'this game and is not free for anything else.', '']
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
    if '--spectrograms' in flags:
        import matplotlib
        matplotlib.use('Agg')
        import matplotlib.pyplot as plt
        for slot in args or list(SLOTS):
            folder = OUT / slot.replace('.', '-')
            files = sorted(folder.glob('*.ogg'))
            if not files:
                continue
            fig, axes = plt.subplots(len(files), 1, figsize=(12, 2.2 * len(files)), squeeze=False)
            for ax, f in zip(axes[:, 0], files):
                x, sr = sf.read(str(f))
                ax.specgram(x, NFFT=1024, Fs=sr, noverlap=768, cmap='magma', vmin=-110, vmax=-20)
                ax.set_ylim(0, 8000)
                ax.set_title(f'{slot} / {f.stem}  {len(x) / sr:.2f}s', fontsize=9)
            plt.tight_layout()
            CACHE.mkdir(exist_ok=True)
            fig.savefig(CACHE / f'spec-{slot}.png', dpi=60)
            plt.close(fig)
            print(f'{CACHE / f"spec-{slot}.png"}')
        sys.exit(0)
    bad = [a for a in args if a not in SLOTS]
    if bad:
        raise SystemExit(f'unknown slot(s) {bad}; --list shows them')
    build(args or list(SLOTS), mp3='--no-mp3' not in flags)
