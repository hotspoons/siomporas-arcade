// Ange Yaghi's engine simulator, running in a Web Audio worklet.
//
// See README.md for what this is and why it is built the way it is. The short version: the game
// calls `drive(rpm, pedal)` every frame and gets a real combustion simulation voicing its car; the
// asset editor gets the same object plus AUDIO_PARAMS to put sliders on.

export { EngineSim, RPM_PER_RAD } from './EngineSim'
export type { EngineProfile, EngineSimOptions, EngineTelemetry } from './EngineSim'
export { AUDIO_PARAMS, AUDIO_PARAM_BY_KEY } from './params'
export type { AudioParamSpec, EnginePreset } from './params'
export { Drivetrain, DEFAULT_DRIVETRAIN } from './Drivetrain'
export type { DrivetrainSpec } from './Drivetrain'
export { ENGINES, enginesByGroup } from './catalog'
export { basis, inverseGain, spatialFor, unit } from './spatial'
export type { Listener, Spatial, SpatialOpts, Vec3 } from './spatial'
export { SampledEngine } from './sampled'
export type { SampledEngineOptions } from './sampled'
export { BAKER_VERSION, bakeRpm, bakeRpmAtMost, bracket, cycleSamples, loopCycles, playbackRate, rpmLadder }
  from './pack'
export type { EnginePack, PackIndex, PackLayer } from './pack'
export { SpatialVoice } from './voice'
export type { Placement, VoiceOptions } from './voice'
export type { CatalogEntry } from './catalog'
