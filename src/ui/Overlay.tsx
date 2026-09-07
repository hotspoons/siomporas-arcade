import { game, newCourse, startRun } from '../game/state'
import { usePhase, useSnapshot } from './useGame'

const CONTROLS: [string, string][] = [
  ['← →  /  A D', 'roll around the conduit'],
  ['↑  /  W', 'thrust'],
  ['↓  /  S', 'brake'],
  ['Shift', 'boost (burns the meter)'],
  ['Space', 'hop off the wall'],
]

export function Overlay() {
  const phase = usePhase()
  const snap = useSnapshot()
  if (phase === 'running') return null

  const finished = phase === 'finished'
  const wrecked = phase === 'wrecked'

  return (
    <div className="overlay">
      <div className="panel">
        {phase === 'title' ? (
          <>
            <h1>
              Apex<span>Conduit</span>
            </h1>
            <p className="tagline">
              Ride the inside of the conduit. Roll past the pylons, graze the pads, make the
              next checkpoint before the clock runs you out.
            </p>
            <dl className="controls">
              {CONTROLS.map(([key, what]) => (
                <div key={key}>
                  <dt>{key}</dt>
                  <dd>{what}</dd>
                </div>
              ))}
            </dl>
          </>
        ) : (
          <>
            <h1 className={wrecked ? 'result result-bad' : 'result'}>
              {finished ? 'Conduit cleared' : game.shield <= 0 ? 'Craft wrecked' : 'Time out'}
            </h1>
            <dl className="stats">
              <div>
                <dt>distance</dt>
                <dd>{Math.round(snap.distance).toLocaleString()} m</dd>
              </div>
              <div>
                <dt>checkpoints</dt>
                <dd>{snap.checkpoints}</dd>
              </div>
              <div>
                <dt>time</dt>
                <dd>{snap.elapsed.toFixed(1)}s</dd>
              </div>
              <div>
                <dt>best on this course</dt>
                <dd>{Math.round(game.best).toLocaleString()} m</dd>
              </div>
            </dl>
          </>
        )}

        <div className="actions">
          <button type="button" className="primary" onClick={startRun}>
            {phase === 'title' ? 'Launch' : 'Run it again'}
          </button>
          <button type="button" onClick={() => newCourse((Math.random() * 0xffffffff) >>> 0)}>
            New course
          </button>
        </div>
        <p className="footnote">
          course #{game.seed.toString(16)} · {Math.round(game.track.length).toLocaleString()} m ·
          press Space or Enter to launch
        </p>
      </div>
    </div>
  )
}
