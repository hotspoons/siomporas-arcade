import { SHIELD_MAX } from '../game/constants'
import { useSnapshot } from './useGame'

/** Speed is displayed in fictional MPH — a readout, not a unit conversion. */
const MPH_PER_UNIT = 1.2

export function Hud() {
  const s = useSnapshot()
  const progress = Math.min(1, s.distance / Math.max(1, s.length))
  const low = s.timeLeft < 8

  return (
    <div className="hud">
      <div className="hud-row hud-top">
        <div className="readout">
          <span className="label">time</span>
          <span className={low ? 'value value-alarm' : 'value'}>{s.timeLeft.toFixed(1)}</span>
        </div>
        <div className="progress">
          <div className="progress-track">
            <div className="progress-fill" style={{ width: `${progress * 100}%` }} />
          </div>
          <span className="label">
            checkpoint {s.checkpoints} · {Math.round(s.distance).toLocaleString()} m
          </span>
        </div>
        <div className="readout readout-right">
          <span className="label">velocity</span>
          <span className="value">
            {Math.round(s.speed * MPH_PER_UNIT)}
            <em>mph</em>
          </span>
        </div>
      </div>

      <div className="hud-row hud-bottom">
        <div className="readout">
          <span className="label">shield</span>
          <span className="pips">
            {Array.from({ length: SHIELD_MAX }, (_, i) => (
              <i key={i} className={i < s.shield ? 'pip pip-on' : 'pip'} />
            ))}
          </span>
        </div>
        <div className="readout readout-right">
          <span className="label">boost</span>
          <span className="meter">
            <span
              className={s.boosting ? 'meter-fill meter-fill-hot' : 'meter-fill'}
              style={{ width: `${s.boost}%` }}
            />
          </span>
        </div>
      </div>

      {/* Full-screen tints for the three things worth reacting to. */}
      <div className="flash flash-hit" style={{ opacity: s.hitFlash * 0.55 }} />
      <div className="flash flash-pickup" style={{ opacity: s.pickupFlash * 0.18 }} />
      <div className="flash flash-checkpoint" style={{ opacity: s.checkpointFlash * 0.2 }} />
    </div>
  )
}
