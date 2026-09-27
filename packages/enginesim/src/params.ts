// The tuning knobs, as data.
//
// These are the Synthesizer::AudioParameters fields, which is what the desktop application binds to
// Z/X/C/V/B and a scroll wheel. The editor renders this table into sliders and the game leaves it
// alone apart from volume, so there is one description of each knob rather than one in the UI and
// another in whatever writes a preset.
//
// `id` is the switch index in native/apex_enginesim.cpp. If you add one, add it in both places and
// bump PARAM_COUNT in src/processor.js.

export interface AudioParamSpec {
  id: number
  key: string
  label: string
  min: number
  max: number
  /** Sliders on a decade-spanning range are useless linearly; these get a log taper. */
  log?: boolean
  unit?: string
  hint: string
}

export const AUDIO_PARAMS: readonly AudioParamSpec[] = [
  {
    id: 0,
    key: 'volume',
    label: 'Volume',
    min: 0,
    max: 1,
    hint: 'Output gain, applied after the leveler. The leveler normalises towards its target, so '
      + 'this is the only knob that reliably makes the engine quieter.',
  },
  {
    id: 1,
    key: 'convolution',
    label: 'Convolution',
    min: 0,
    max: 1,
    hint: 'Dry/wet against the exhaust impulse response. At 0 the filter is skipped entirely, '
      + 'which is the cheapest the engine can run and sounds like it.',
  },
  {
    id: 2,
    key: 'highFrequencyGain',
    label: 'High frequency gain',
    min: 0,
    max: 0.5,
    hint: 'Mixes in the derivative of the exhaust signal. Small values add the edge and rasp; past '
      + 'about 0.1 it turns into hiss.',
  },
  {
    id: 3,
    key: 'highFrequencyNoise',
    label: 'High frequency noise',
    min: 0,
    max: 2,
    hint: 'Jitter on the input samples. Roughens the firing pulses — the difference between a '
      + 'synthetic buzz and something mechanical.',
  },
  {
    id: 4,
    key: 'highFrequencyNoiseCutoff',
    label: 'HF noise cutoff',
    min: 100,
    max: 20000,
    log: true,
    unit: 'Hz',
    hint: 'Where the jitter stops. Lower values move the roughness down into the body of the note.',
  },
  {
    id: 5,
    key: 'lowFrequencyNoise',
    label: 'Low frequency noise',
    min: 0,
    max: 2,
    hint: 'Air noise multiplied into the signal. This is intake and turbulence rather than combustion.',
  },
  {
    id: 6,
    key: 'lowFrequencyNoiseCutoff',
    label: 'LF noise cutoff',
    min: 20,
    max: 8000,
    log: true,
    unit: 'Hz',
    hint: 'Low-pass on the air noise.',
  },
  {
    id: 7,
    key: 'levelerTarget',
    label: 'Leveler target',
    min: 1000,
    max: 32767,
    log: true,
    hint: 'The amplitude the automatic gain aims for, in 16-bit counts. 30000 is nearly full scale, '
      + 'which is why a stock engine arrives loud.',
  },
  {
    id: 8,
    key: 'levelerMaxGain',
    label: 'Leveler max gain',
    min: 0.01,
    max: 8,
    log: true,
    hint: 'Ceiling on the automatic gain. Lower it to stop a quiet idle being pumped up to match a '
      + 'wide-open throttle.',
  },
  {
    id: 9,
    key: 'levelerMinGain',
    label: 'Leveler min gain',
    min: 0.000001,
    max: 1,
    log: true,
    hint: 'Floor on the automatic gain.',
  },
]

export const AUDIO_PARAM_BY_KEY: ReadonlyMap<string, AudioParamSpec> =
  new Map(AUDIO_PARAMS.map((spec) => [spec.key, spec]))

/** A saved voicing: what the editor produces and the game loads alongside an engine script. */
export interface EnginePreset {
  /** Script path inside the embedded asset tree, e.g. `engines/atg-video-2/07_gm_ls.mr`. */
  engine: string
  /** Sparse: only the knobs moved away from what the script itself asked for. */
  params?: Partial<Record<string, number>>
  simFrequency?: number
  irLimit?: number
}
