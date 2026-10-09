# Rich's own recordings

Cut from Rich Siomporas's videos (he holds all rights; used here with his permission, 2026-10-09),
mono 48 kHz, each with half a second of run-in. The engine is isolated out of them by
`build.py` (`isolate_squeal`): a high-pass above the boxer's fundamentals, a spectral gate learned
from the clip's own run-in, and a tilt to put the squeal where the game wants it.

| file | video | where | what |
| --- | --- | --- | --- |
| lotus-pirouette.wav | youtu.be/qUrz6KlLzkc | 3.5 s + 5.5 s | the Lotus into a corner too hot at an autocross: oversteer, correction, oversteer again, then a mild understeer. GoPro. The squeal sits at 1.0–1.5 kHz with harmonics to 3 kHz |
| subaru-scrub-a/b/c.wav | youtu.be/FPBxUg5L_Us | 30.5 + 3, 33.5 + 2, 48.5 + 2 | speed scrub from inside the Subaru; the boxer dominates below 600 Hz |
| subaru-outside-a.wav | youtu.be/ho54XuvwFJU | 19.5 + 3 | from outside, mid-turn, little engine |
| subaru-outside-b.wav | youtu.be/j3Q6PL_HB3o | 19.5 + 4 | the same, a tonal squeal near 1.2 kHz and 4 kHz from 0.9 to 2.3 s |

Re-cut with yt-dlp + ffmpeg (both in the tool venv: `pip install yt-dlp imageio-ffmpeg`):
`yt-dlp -f bestaudio -o <id>.%(ext)s <url>` then `ffmpeg -ss <start> -t <len> -i <file> -ac 1 -ar 48000 -c:a pcm_s16le <name>.wav`.
