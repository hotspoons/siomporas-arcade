// Per-frame UI edges (menu navigation, pause, toggles) shared by the menu
// system and every game's InputMap.

export interface UiEdges {
  pause: boolean
  confirm: boolean
  back: boolean
  toggleStyle: boolean
  togglePerf: boolean
  toggleDebug: boolean
  any: boolean
  menuUp: boolean
  menuDown: boolean
  menuLeft: boolean
  menuRight: boolean
}

export function makeUiEdges(): UiEdges {
  return {
    pause: false,
    confirm: false,
    back: false,
    toggleStyle: false,
    togglePerf: false,
    toggleDebug: false,
    any: false,
    menuUp: false,
    menuDown: false,
    menuLeft: false,
    menuRight: false,
  }
}
