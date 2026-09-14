# Ryu: Champion Edition against Super Turbo

Both measured by `tools/sf2-probe` with the same plan — `sf2ceea` and `ssf2tad` — so the
numbers are comparable frame for frame. Rows where nothing changed are left out.

## The character itself

| | Champion Edition | Super Turbo |
|---|---|---|
| walk forward / back, px per frame | 3 / 2 | 3 / 2 |
| jump: launch speed / gravity | 6.813 / 0.312 | 6.813 / 0.313 |
| jump: airborne frames / apex | — / 77 | — / 77 |
| forward jump distance, px | 131 | 131 |
| landing recovery | 1 | 5 |
| round timer, frames per tick | 40 | — |
| throw damage | 32 | — |

## Normals

start/active/recovery, then damage, then how many frames the victim is stuck.

| move | Champion Edition | Super Turbo | dmg Champion Edition | dmg Super Turbo | stuck Champion Edition | stuck Super Turbo |
|---|---|---|---|---|---|---|
| air-hk | 5/7/17 | undefined/undefined/undefined | 18–20 | 0–144 | 28 | — |
| air-hp | 4/8/17 | undefined/undefined/undefined | 18–19 | 0–28 | 28 | 29 |
| air-lk | 5/24/0 | undefined/undefined/undefined | 6 | 0–14 | 28 | 3 |
| air-lp | 2/27/0 | undefined/undefined/undefined | 7 | 0 | 28 | — |
| air-mk | 5/13/11 | undefined/undefined/undefined | 12–14 | 0–43 | 28 | — |
| air-mp | 4/20/5 | 0/1/0 | 12–14 | 0 | 28 | 48 |
| crouch-hk | 4/6/25 | null/0/null | 18 | 0 | 98 | 28 |
| crouch-hp | 4/11/23 | undefined/undefined/undefined | 18 | 4 | 37 | 28 |
| crouch-lk | 3/4/5 | undefined/undefined/undefined | 4–5 | 0 | 28 | 3 |
| crouch-lp | 3/4/5 | undefined/undefined/undefined | 4–5 | 0 | 28 | 3 |
| crouch-mk | 4/6/9 | 3/5/53 | 12–13 | 18 | 33 | — |
| crouch-mp | 4/4/7 | undefined/undefined/undefined | 12–14 | 13 | 33 | 80 |
| stand-hk | 3/12/17 | 2/10/13 | 23–24 | 0 | 58 | 3 |
| stand-hp | 6/6/23 | 4/5/17 | 19 | 23 | 37 | 27 |
| stand-lk | 7/8/5 | 3/6/4 | 7 | 10–13 | 28 | 20 |
| stand-lp | 3/4/5 | 2/3/4 | 4–5 | 4–6 | 28 | 22 |
| stand-mk | 12/12/7 | 6/6/57 | 14–15 | 0 | 33 | 3 |
| stand-mp | 4/4/7 | 3/3/5 | 14–15 | 19 | 33 | 25 |

## Specials

start/active/recovery, then damage, then how many frames the victim is stuck.

| move | Champion Edition | Super Turbo | dmg Champion Edition | dmg Super Turbo | stuck Champion Edition | stuck Super Turbo |
|---|---|---|---|---|---|---|
| hadouken-hp | 9/1/39 | undefined/undefined/undefined | 12 | — | — | — |
| hadouken-lp | 9/1/39 | undefined/undefined/undefined | 9–10 | — | 58 | — |
| hadouken-mp | 9/1/39 | undefined/undefined/undefined | 11–12 | — | 58 | — |
| shoryuken-hp | 4/30/33 | undefined/undefined/undefined | 27–28 | — | 37 | — |
| shoryuken-lp | 4/18/23 | 0/1/0 | 26–28 | — | 136 | — |
| shoryuken-mp | 4/26/26 | undefined/undefined/undefined | 26–27 | — | 136 | — |
| tatsumaki-hk | 11/43/21 | undefined/undefined/undefined | 20 | — | 136 | — |
| tatsumaki-lk | 11/31/21 | undefined/undefined/undefined | 18–20 | — | 136 | — |
| tatsumaki-mk | 11/23/21 | null/0/null | 19–22 | — | 135 | — |
