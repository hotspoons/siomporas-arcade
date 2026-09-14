# Ryu across the three arcade editions

Measured with the same plan on `sf2` (World Warrior, WW), `sf2ceea` (Champion Edition, CE) and `sf2hfu` (Hyper Fighting, HF). HF runs its game logic faster than the display (turbo), so its frame counts are display frames and read about 0.7× CE.

| | WW | CE | HF |
|---|---|---|---|
| walk fwd/back px/f | 3 / 2 | 3 / 2 | 3 / 2 |
| jump vy0 / gravity / fwd vx | 6.844 / 0.282 / 3.48 | 6.813 / 0.312 / 3.48 | 6.5 / 0.313 / 3.48 |
| timer frames per tick | 30 | 40 | 35 |
| throw damage | 38 | 32 | 32 |
| dizzy: pokes 22/25/27/28/29 + jab → dizzy? | 22:nYn 25:YnY 27:YYY 28:YYY 29:YYY | 22:nnn 25:Ynn 27:YYn 28:YYY 29:YYY | 22:nnn 25:nnn 27:YYY 28:YYY 29:YYY |

## Normals: startup/active/recovery (total) · damage · frames the victim is stuck

| move | WW | CE | HF |
|---|---|---|---|
| stand-lp | 3/4/5 (12) · 14-14 · 28 | 3/4/5 (12) · 4-5 · 28 | 2/3/4 (9) · 4-5 · 20 |
| stand-mp | 4/4/7 (15) · 22-22 · 33 | 4/4/7 (15) · 14-15 · 33 | 3/3/5 (11) · 14-14 · 23 |
| stand-hp | 6/6/23 (35) · 28-29 · 37 | 6/6/23 (35) · 19-19 · 37 | 4/4/16 (24) · 19-20 · 26 |
| stand-lk | 7/8/5 (20) · 14-14 · 28 | 7/8/5 (20) · 7-7 · 28 | 5/6/3 (14) · 7-7 · 20 |
| stand-mk | 12/12/7 (31) · 22-23 · 33 | 12/12/7 (31) · 14-15 · 33 | 8/9/5 (22) · 14-14 · 24 |
| stand-hk | 3/12/17 (32) · 34-35 · 58 | 3/12/17 (32) · 23-24 · 58 | 2/9/12 (23) · 25-26 · 42 |
| crouch-lp | 3/4/5 (12) · 12-12 · 28 | 3/4/5 (12) · 4-5 · 28 | 2/3/3 (8) · 4-5 · 20 |
| crouch-mp | 4/4/7 (15) · 20-21 · 33 | 4/4/7 (15) · 12-14 · 33 | 3/2/5 (10) · 12-13 · 25 |
| crouch-hp | 4/11/23 (38) · 27-27 · 37 | 4/11/23 (38) · 18-18 · 37 | 2/9/16 (27) · 18-18 · 27 |
| crouch-lk | 3/4/5 (12) · 12-12 · 28 | 3/4/5 (12) · 4-5 · 28 | 2/3/3 (8) · 4-5 · 20 |
| crouch-mk | 4/6/9 (19) · 20-21 · 33 | 4/6/9 (19) · 12-13 · 33 | 3/4/6 (13) · 12-13 · 24 |
| crouch-hk | 4/6/25 (35) · 27-27 · 98 | 4/6/25 (35) · 18-18 · 98 | 3/4/18 (25) · 18-18 · 69 |
| air-lp | 2/32/0 (34) · - · - | 2/27/0 (29) · 7-7 · 28 | 2/13/0 (15) · 4-5 · 20 |
| air-mp | 4/8/22 (34) · - · - | 4/20/5 (29) · 12-14 · 28 | 3/13/0 (16) · - · - |
| air-hp | 4/8/22 (34) · - · - | 4/8/17 (29) · 18-19 · 28 | 2/6/7 (15) · - · - |
| air-lk | 5/29/0 (34) · 12-12 · 28 | 5/24/0 (29) · 6-6 · 28 | 4/11/0 (15) · 6-6 · 20 |
| air-mk | 5/13/16 (34) · 20-20 · 28 | 5/13/11 (29) · 12-14 · 28 | 4/9/3 (16) · 12-12 · 21 |
| air-hk | 5/7/22 (34) · 27-27 · 28 | 5/7/17 (29) · 18-20 · 28 | 3/5/7 (15) · 18-20 · 20 |

## Specials

| move | WW | CE | HF |
|---|---|---|---|
| hadouken-lp | 13/1/39 (53) · 21-22 · fireball 3 px/f | 9/1/39 (49) · 9-10 · fireball 3 px/f | 8/1/27 (36) · 9-10 · fireball 4.5 px/f |
| hadouken-mp | 13/1/39 (53) · 20-20 · fireball 4 px/f | 9/1/39 (49) · 11-12 · fireball 4 px/f | 7/1/28 (36) · 12-15 · fireball 5.5 px/f |
| hadouken-hp | 13/1/39 (53) · 19-19 · fireball 5 px/f | 9/1/39 (49) · 12-12 · fireball 5 px/f | 7/1/27 (35) · 12-12 · fireball 6.88 px/f |
| shoryuken-lp | 4/18/23 (45) · 38-38 | 4/18/23 (45) · 26-28 · KD | 3/13/16 (32) · 26-26 · KD |
| shoryuken-mp | 4/26/26 (56) · 39-39 | 4/26/26 (56) · 26-27 · KD | 2/19/18 (39) · 27-28 · KD |
| shoryuken-hp | 4/30/33 (67) · 36-36 | 4/30/33 (67) · 27-28 | 3/21/24 (48) · 26-28 |
| tatsumaki-lk | 11/17/21 (64) · 44-47 | 11/31/21 (78) · 18-20 · KD | 8/12/15 (46) · 19-20 · KD |
| tatsumaki-mk | 11/23/21 (76) · 46-47 | 11/23/21 (76) · 19-22 · KD | 8/16/15 (55) · 19-20 · KD |
| tatsumaki-hk | 11/57/21 (116) · 50-64 | 11/43/21 (102) · 20-20 · KD | 8/31/15 (74) · 20-20 · KD |

## What changed

* WW damage is much higher across the board (jab 14 vs 4–5, fierce 28–29 vs 19, shoryuken 38 vs 26–29, hadouken 19–22 vs 9–12, throw 38 vs 32); CE halved most of it. HF keeps CE damage.
* WW's round timer ticks every 30 frames (99 counts ≈ 50 s), CE's every 40 (≈ 66 s).
* WW's dizzy threshold is lower and looser (pokes of 22–25 already dizzy about half the time); CE and HF dizzy exactly when the meter would pass 30.
* The hitboxes and the startup/active/recovery of Ryu's normals are identical between WW and CE; HF's are the same animations played at turbo speed.
* Hadouken: CE fireballs travel 3/4/5 px per frame for LP/MP/HP, HF 4.5/5.5/6.9 (turbo); WW's startup is 13 frames vs CE's 9.
* The hurricane kick knocks down in CE and HF; the WW one hit the dummy repeatedly without knocking down (44–64 damage over the spin).
