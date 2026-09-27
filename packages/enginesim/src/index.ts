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
export type { CatalogEntry } from './catalog'
