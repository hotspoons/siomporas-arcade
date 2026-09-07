import { Game } from './game/Game'
import { Hud } from './ui/Hud'
import { Overlay } from './ui/Overlay'

export default function App() {
  return (
    <div className="app">
      <Game />
      <Hud />
      <Overlay />
      {/* CRT dressing: scanlines and a vignette over everything, pointer
          events off so the canvas still owns every gesture. */}
      <div className="crt" />
    </div>
  )
}
