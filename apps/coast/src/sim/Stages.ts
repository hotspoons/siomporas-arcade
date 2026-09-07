// The route tree and its themes. Stage A forks into B1/B2, each of which forks
// again into the C stages (B1 → C1|C2, B2 → C2|C3), so a run is three stages
// and there are four distinct routes. Sprite kinds name atlas entries.

import type { StageDesc, Theme } from './Road'

export const THEMES: Record<string, Theme> = {
  coast: {
    id: 'coast',
    palette: 'coast',
    backdrop: 'sea',
    density: 0.3,
    roadside: [
      { kind: 'palm', weight: 5, minOffset: 1.2, maxOffset: 2.1 },
      { kind: 'palmTall', weight: 3, minOffset: 1.25, maxOffset: 2.2 },
      { kind: 'palmBend', weight: 2, minOffset: 1.2, maxOffset: 2.0 },
      { kind: 'bush', weight: 3, minOffset: 1.12, maxOffset: 1.7, scale: 1.3 },
      { kind: 'rock', weight: 1, minOffset: 1.3, maxOffset: 2.2 },
      { kind: 'flower', weight: 2, minOffset: 1.08, maxOffset: 1.5, collide: false, scale: 1.6 },
    ],
    landmarks: ['billboard', 'lightpost', 'billboardLow'],
    landmarkEvery: 70,
  },
  canyon: {
    id: 'canyon',
    palette: 'canyon',
    backdrop: 'mesas',
    density: 0.24,
    roadside: [
      { kind: 'rockTall', weight: 4, minOffset: 1.25, maxOffset: 2.1 },
      { kind: 'rock', weight: 4, minOffset: 1.25, maxOffset: 2.6 },
      { kind: 'cactus', weight: 4, minOffset: 1.2, maxOffset: 2.2 },
      { kind: 'cactusTall', weight: 2, minOffset: 1.3, maxOffset: 2.4 },
    ],
    landmarks: ['billboardLow', 'barrier'],
    landmarkEvery: 90,
  },
  forest: {
    id: 'forest',
    palette: 'forest',
    backdrop: 'hills',
    density: 0.38,
    roadside: [
      { kind: 'pine', weight: 5, minOffset: 1.15, maxOffset: 2.3 },
      { kind: 'pineRound', weight: 3, minOffset: 1.25, maxOffset: 2.6 },
      { kind: 'oak', weight: 3, minOffset: 1.3, maxOffset: 2.8 },
      { kind: 'bushLarge', weight: 2, minOffset: 1.15, maxOffset: 1.9 },
      { kind: 'stump', weight: 1, minOffset: 1.15, maxOffset: 1.8 },
    ],
    landmarks: ['lightpost', 'billboard'],
    landmarkEvery: 110,
  },
  desert: {
    id: 'desert',
    palette: 'desert',
    backdrop: 'dunes',
    density: 0.14,
    roadside: [
      { kind: 'cactus', weight: 4, minOffset: 1.2, maxOffset: 2.6 },
      { kind: 'cactusTall', weight: 3, minOffset: 1.3, maxOffset: 2.6 },
      { kind: 'rock', weight: 2, minOffset: 1.3, maxOffset: 2.8 },
      { kind: 'stoneTall', weight: 1, minOffset: 1.4, maxOffset: 2.8 },
    ],
    landmarks: ['billboardLow'],
    landmarkEvery: 140,
  },
  night: {
    id: 'night',
    palette: 'night',
    backdrop: 'city',
    density: 0.3,
    roadside: [
      { kind: 'lightpostTall', weight: 4, minOffset: 1.15, maxOffset: 1.3 },
      { kind: 'barrier', weight: 3, minOffset: 1.1, maxOffset: 1.25, scale: 1.1 },
      { kind: 'tree', weight: 2, minOffset: 1.5, maxOffset: 2.6 },
      { kind: 'banner', weight: 1, minOffset: 1.4, maxOffset: 2.0 },
    ],
    landmarks: ['grandstand', 'tent', 'pitsOffice'],
    landmarkEvery: 60,
  },
  alpine: {
    id: 'alpine',
    palette: 'alpine',
    backdrop: 'peaks',
    density: 0.34,
    roadside: [
      { kind: 'pineTall', weight: 5, minOffset: 1.15, maxOffset: 2.3 },
      { kind: 'pine', weight: 3, minOffset: 1.2, maxOffset: 2.5 },
      { kind: 'rockTall', weight: 2, minOffset: 1.3, maxOffset: 2.4 },
      { kind: 'barrier', weight: 2, minOffset: 1.08, maxOffset: 1.2 },
    ],
    landmarks: ['billboard', 'lightpost'],
    landmarkEvery: 95,
  },
}

export const STAGES: StageDesc[] = [
  {
    id: 'A',
    name: 'Coastal Highway',
    theme: 'coast',
    sections: [
      { kind: 'straight', n: 120 },
      { kind: 'curve', n: 140, curve: 2.2 },
      { kind: 'straight', n: 60 },
      { kind: 'hills', n: 160, height: 22, count: 2 },
      { kind: 'curve', n: 160, curve: -3.0 },
      { kind: 's', n: 200, curve: 2.6 },
      { kind: 'straight', n: 80, hill: 14 },
      { kind: 'curve', n: 120, curve: 3.4, hill: -14 },
      { kind: 'straight', n: 140 },
    ],
    next: ['B1', 'B2'],
  },
  {
    id: 'B1',
    name: 'Red Canyon',
    theme: 'canyon',
    sections: [
      { kind: 'straight', n: 80 },
      { kind: 'curve', n: 150, curve: -3.6 },
      { kind: 'hills', n: 180, height: 30, count: 3 },
      { kind: 'curve', n: 140, curve: 3.6 },
      { kind: 's', n: 240, curve: 3.2 },
      { kind: 'straight', n: 60 },
      { kind: 'curve', n: 160, curve: -4.2, hill: 20 },
      { kind: 'straight', n: 130, hill: -20 },
    ],
    next: ['C1', 'C2'],
  },
  {
    id: 'B2',
    name: 'Pine Ridge',
    theme: 'forest',
    sections: [
      { kind: 'straight', n: 60 },
      { kind: 's', n: 220, curve: 2.4 },
      { kind: 'hills', n: 200, height: 26, count: 4 },
      { kind: 'curve', n: 180, curve: 4.0 },
      { kind: 'straight', n: 100 },
      { kind: 'curve', n: 160, curve: -3.0, hill: 24 },
      { kind: 'straight', n: 140, hill: -24 },
    ],
    next: ['C2', 'C3'],
  },
  {
    id: 'C1',
    name: 'Salt Flats',
    theme: 'desert',
    sections: [
      { kind: 'straight', n: 260 },
      { kind: 'curve', n: 120, curve: 1.8 },
      { kind: 'straight', n: 200 },
      { kind: 's', n: 260, curve: 4.4 },
      { kind: 'straight', n: 220 },
    ],
    next: [],
  },
  {
    id: 'C2',
    name: 'Neon Bay',
    theme: 'night',
    sections: [
      { kind: 'straight', n: 90 },
      { kind: 's', n: 260, curve: 3.6 },
      { kind: 'curve', n: 160, curve: -4.6 },
      { kind: 'hills', n: 140, height: 12, count: 3 },
      { kind: 'curve', n: 200, curve: 4.6 },
      { kind: 'straight', n: 180 },
    ],
    next: [],
  },
  {
    id: 'C3',
    name: 'High Pass',
    theme: 'alpine',
    sections: [
      { kind: 'straight', n: 60, hill: 30 },
      { kind: 'curve', n: 160, curve: -3.8, hill: 30 },
      { kind: 's', n: 220, curve: 4.8 },
      { kind: 'hills', n: 200, height: 34, count: 2 },
      { kind: 'curve', n: 180, curve: 4.4, hill: -40 },
      { kind: 'straight', n: 160, hill: -20 },
    ],
    next: [],
  },
]

export const STAGE_BY_ID: Record<string, StageDesc> = Object.fromEntries(STAGES.map((s) => [s.id, s]))
