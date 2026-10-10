// The finish screen: the hero car (or the character) on a turntable, the winnings counted up, and
// the way on — restart, the next stage, or the menu.
//
// Rich, 2026-10-10: *"when the mission is complete we should have a finish screen that defaults to
// showing the hero car or main character depending on game mode, along with a representation of
// winnings (cash for our simple game), and an option to restart or exit to menu."*
//
// THE WORLD IS NOT DRAWN WHILE THIS IS UP. The frame the run ended on is drawn once more, copied
// off the canvas into a small texture in the same task (before the browser presents it, so no
// `preserveDrawingBuffer`), and from then on every frame is two cheap passes on the app's own
// renderer: that copy, blurred and darkened, as the backdrop; and the turntable over it. So the
// screen costs LESS GPU than the game it replaces — the world's thousands of draw calls stop, and
// what is left is a full-screen quad and one car. (Measured numbers: docs/corridor/GAME-MODE.md,
// "Finishing".) The alternative, a CSS blur over the live world, keeps paying for the world every
// frame and blurs the car with it.
//
// THE CAR IS A CLONE OF THE ONE ON SCREEN, so it wears the level's model, the build's paint and
// whatever dents the run gave it — geometry and materials are shared, nothing is uploaded twice,
// and it is let go (never disposed) when the screen closes.
//
// THE KEYS ARE THE MENU'S: arrows / the stick move, Enter / Space / A choose, Start chooses too,
// Escape / Backspace / B is "Exit to menu". `handle(ui)` is fed the same polled edges `MenuStack`
// is, from main.ts's frame.
import * as THREE from 'three'
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js'
import type { UiEdges } from '@apex/engine/input/UiEdges'
import { clockText, countDuration, countUp, formatAmount, lineLabel } from '../game/session/finish'
import type { FinishResult, FinishShow } from '../game/session/program'
import type { UiSound } from './uisound'

export interface FinishButton {
  id: string
  label: string
  hint?: string
  run: () => void
}

export interface FinishShowOpts {
  /** what stands on the turntable, already chosen (`defaultShow` when the program did not say) */
  kind: FinishShow
  /** the thing itself: a clone of the car, a catalog model, or null for the stand-in figure */
  subject: THREE.Object3D | null
  buttons: FinishButton[]
  /** the pad is connected: the footer names its buttons instead of the keys */
  pad?: boolean
}

/** a seconds-long pause before a button can be chosen: the handbrake held at the line is Space */
const ARM_S = 0.8
/** the turntable, radians a second: one turn in about 25 s */
const SPIN = 0.25

export class FinishView {
  readonly root: HTMLElement
  private readonly panel: HTMLElement
  private readonly kicker: HTMLElement
  private readonly title: HTMLElement
  private readonly text: HTMLElement
  private readonly totalBox: HTMLElement
  private readonly totalNum: HTMLElement
  private readonly totalLabel: HTMLElement
  private readonly lines: HTMLElement
  private readonly stats: HTMLElement
  private readonly actions: HTMLElement
  private readonly footer: HTMLElement

  private readonly sounds: UiSound
  private buttons: { def: FinishButton; el: HTMLButtonElement }[] = []
  private focus = 0
  private age = 0
  private result: FinishResult | null = null
  private counted = false
  private lineEls: HTMLElement[] = []

  /* the turntable */
  private readonly scene = new THREE.Scene()
  private readonly camera = new THREE.PerspectiveCamera(26, 1, 0.1, 400)
  private readonly turntable = new THREE.Group()
  private readonly shadow: THREE.Mesh
  private subject: THREE.Object3D | null = null
  private readonly target = new THREE.Vector3()
  /** the subject's bounding radius as it turns, m: what the camera has to fit */
  private radius = 1
  private envReady = false

  /* the backdrop: the last frame of the world, small, blurred and darkened in one pass */
  private readonly backScene = new THREE.Scene()
  private readonly backCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1)
  private readonly backCanvas = document.createElement('canvas')
  private readonly backTex: THREE.CanvasTexture
  private readonly backMat: THREE.ShaderMaterial

  /** true from `show` until the next frame has been drawn and copied: main.ts draws the world once more for it */
  capturePending = false
  open = false
  /** the draws of the last frame this drew, for the performance numbers */
  lastCalls = 0
  lastTriangles = 0

  constructor(o: { sounds: UiSound }) {
    this.sounds = o.sounds
    const div = (cls: string, parent?: HTMLElement): HTMLElement => {
      const d = document.createElement('div')
      d.className = cls
      parent?.append(d)
      return d
    }
    this.root = div('finish')
    this.root.hidden = true
    this.panel = div('fin-panel', this.root)
    this.kicker = div('fin-kicker', this.panel)
    this.title = document.createElement('h1')
    this.title.className = 'fin-title'
    this.panel.append(this.title)
    this.text = div('fin-text', this.panel)
    this.totalBox = div('fin-total', this.panel)
    this.totalNum = div('fin-total-num', this.totalBox)
    this.totalLabel = div('fin-total-label', this.totalBox)
    this.lines = div('fin-lines', this.panel)
    this.stats = div('fin-stats', this.panel)
    this.actions = div('fin-actions', this.panel)
    this.footer = div('fin-footer', this.panel)

    // a soft contact shadow under whatever is on the turntable: a radial gradient, no shadow map
    const sc = document.createElement('canvas')
    sc.width = sc.height = 128
    const g = sc.getContext('2d')
    if (g) {
      const grad = g.createRadialGradient(64, 64, 4, 64, 64, 64)
      grad.addColorStop(0, 'rgba(0,0,0,0.75)')
      grad.addColorStop(0.55, 'rgba(0,0,0,0.35)')
      grad.addColorStop(1, 'rgba(0,0,0,0)')
      g.fillStyle = grad
      g.fillRect(0, 0, 128, 128)
    }
    const shadowTex = new THREE.CanvasTexture(sc)
    this.shadow = new THREE.Mesh(
      new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2),
      new THREE.MeshBasicMaterial({ map: shadowTex, transparent: true, depthWrite: false, toneMapped: false }),
    )
    this.shadow.renderOrder = -1
    this.scene.add(this.turntable, this.shadow)

    // lit the way the library's mesh viewer is (editor/library/meshview.ts), plus a rim from behind
    // so a dark car has an edge against a dark backdrop
    this.scene.add(new THREE.HemisphereLight(0xffffff, 0x30343c, 0.7))
    const key = new THREE.DirectionalLight(0xffffff, 1.6)
    key.position.set(3, 5, 4)
    const rim = new THREE.DirectionalLight(0xbfd8ff, 1.1)
    rim.position.set(-4, 3, -5)
    this.scene.add(key, rim)

    this.backCanvas.width = this.backCanvas.height = 1
    this.backTex = new THREE.CanvasTexture(this.backCanvas)
    this.backTex.minFilter = THREE.LinearFilter
    this.backTex.magFilter = THREE.LinearFilter
    this.backTex.generateMipmaps = false
    /*
     * RAW BYTES IN, RAW BYTES OUT. The copy is the canvas's own sRGB pixels; sampled as plain RGBA
     * and written without three's colour-space chunk it lands on screen exactly as it was, then
     * blurred and darkened. Treating it as sRGB would convert it twice.
     */
    this.backMat = new THREE.ShaderMaterial({
      uniforms: { map: { value: this.backTex }, texel: { value: new THREE.Vector2(1, 1) } },
      vertexShader: 'varying vec2 vUv; void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }',
      fragmentShader: `
        uniform sampler2D map; uniform vec2 texel; varying vec2 vUv;
        void main() {
          vec3 c = vec3(0.0);
          float w = 0.0;
          for (int i = -2; i <= 2; i++) for (int j = -2; j <= 2; j++) {
            float k = exp(-float(i * i + j * j) / 4.5);
            c += texture2D(map, vUv + vec2(float(i), float(j)) * texel * 1.5).rgb * k;
            w += k;
          }
          c /= w;
          float l = dot(c, vec3(0.299, 0.587, 0.114));
          c = mix(vec3(l), c, 0.55) * 0.42;
          vec2 d = vUv - vec2(0.42, 0.5);
          c *= 1.0 - 0.75 * smoothstep(0.25, 0.95, length(d * vec2(1.0, 0.8)));
          gl_FragColor = vec4(c, 1.0);
        }`,
      depthTest: false,
      depthWrite: false,
      toneMapped: false,
    })
    const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.backMat)
    quad.frustumCulled = false
    this.backScene.add(quad)
    this.drawBackdropFallback()

    // the mouse: hovering a button moves the focus to it, a click chooses it
    this.actions.addEventListener('pointermove', (e) => {
      const i = this.buttons.findIndex((b) => b.el === (e.target as HTMLElement).closest('button'))
      if (i >= 0 && i !== this.focus) this.setFocus(i, false)
    })
    addEventListener('resize', () => { if (this.open) this.frame() })
  }

  /**
   * Put the screen up. The DOM is filled now; the turntable is drawn from the next frame, after
   * main.ts has drawn the world one last time and called `capture`.
   */
  show(r: FinishResult, o: FinishShowOpts): void {
    this.result = r
    this.age = 0
    this.counted = false
    this.root.dataset.outcome = r.outcome
    this.root.dataset.show = o.kind

    const headline = { win: 'Mission complete', lose: 'Mission failed', abandoned: 'Mission abandoned' }[r.outcome]
    this.kicker.textContent = r.title === headline ? '' : headline
    this.kicker.hidden = !this.kicker.textContent
    this.title.textContent = r.title
    this.text.textContent = r.text
    this.text.hidden = !r.text

    const w = r.winnings
    this.totalBox.hidden = !w
    this.totalNum.textContent = w ? formatAmount(0, w.currency) : ''
    this.totalLabel.textContent = w ? (w.currency ? 'winnings' : 'score') : ''
    this.lines.replaceChildren()
    this.lineEls = []
    for (const l of w?.lines ?? []) {
      const row = document.createElement('div')
      row.className = 'fin-line'
      const a = document.createElement('span')
      a.className = 'fin-line-label'
      a.textContent = lineLabel(l)
      const b = document.createElement('span')
      b.className = 'fin-line-amount'
      b.textContent = formatAmount(l.amount, w!.currency)
      row.append(a, b)
      this.lines.append(row)
      this.lineEls.push(row)
    }
    this.lines.hidden = !this.lineEls.length

    this.stats.replaceChildren()
    const statRows: { label: string; value: string }[] = [{ label: 'Time', value: clockText(r.time) }]
    for (const s of r.stats) statRows.push({ label: s.label, value: typeof s.value === 'number' ? s.value.toLocaleString('en-US') : s.value })
    for (const s of statRows) {
      const row = document.createElement('div')
      row.className = 'fin-stat'
      const a = document.createElement('span')
      a.className = 'fin-stat-label'
      a.textContent = s.label
      const b = document.createElement('span')
      b.className = 'fin-stat-value'
      b.textContent = s.value
      row.append(a, b)
      this.stats.append(row)
    }

    this.actions.replaceChildren()
    this.buttons = o.buttons.map((def, i) => {
      const el = document.createElement('button')
      el.type = 'button'
      el.className = 'fin-btn'
      el.dataset.id = def.id
      el.textContent = def.label
      if (def.hint) el.title = def.hint
      el.addEventListener('click', () => { if (this.armed) { this.setFocus(i, false); this.choose() } })
      this.actions.append(el)
      return { def, el }
    })
    this.setFocus(0, false)
    this.footer.textContent = o.pad ? 'A choose · B menu' : 'Enter chooses · Esc menu'

    this.setSubject(o.subject, o.kind)
    this.root.hidden = false
    this.root.classList.remove('counted')
    this.open = true
    this.capturePending = true
    this.sounds.sting(r.outcome === 'win')
  }

  close(): void {
    this.open = false
    this.capturePending = false
    this.root.hidden = true
    this.setSubject(null, 'none')
    this.result = null
  }

  /** the turntable's own scene, for a compile ahead of the first frame */
  get compileTarget(): { scene: THREE.Scene; camera: THREE.Camera } {
    return { scene: this.scene, camera: this.camera }
  }

  /**
   * Copy the frame that has just been drawn — call it in the same task as the render, before the
   * browser presents the canvas and clears its buffer. Small on purpose: a sixth of the size is
   * already most of a blur, and the shader does the rest.
   */
  capture(src: HTMLCanvasElement): void {
    this.capturePending = false
    const w = Math.max(32, Math.round(src.width / 6))
    const h = Math.max(32, Math.round(src.height / 6))
    this.backCanvas.width = w
    this.backCanvas.height = h
    const g = this.backCanvas.getContext('2d')
    if (!g) return
    g.imageSmoothingEnabled = true
    g.imageSmoothingQuality = 'high'
    try {
      g.drawImage(src, 0, 0, w, h)
    } catch {
      this.drawBackdropFallback()
      return
    }
    this.backMat.uniforms.texel.value.set(1 / w, 1 / h)
    this.backTex.dispose() // the size changed: a new texture on the GPU, not a sub-image into the old
    this.backTex.needsUpdate = true
  }

  /** Per frame, from main.ts, in place of the world's render. */
  render(renderer: THREE.WebGLRenderer, dt: number): void {
    if (!this.open) return
    this.age += dt
    this.turntable.rotation.y += SPIN * dt
    this.tickCount()
    this.ensureEnv(renderer)
    this.frame(renderer)
    const autoClear = renderer.autoClear
    const tone = renderer.toneMapping
    renderer.setRenderTarget(null)
    renderer.autoClear = true
    renderer.render(this.backScene, this.backCam)
    const calls = renderer.info.render.calls
    const tris = renderer.info.render.triangles
    renderer.autoClear = false
    renderer.clearDepth()
    // a product shot's tone curve, as the library viewer has: the world's own is linear
    renderer.toneMapping = THREE.ACESFilmicToneMapping
    renderer.render(this.scene, this.camera)
    renderer.toneMapping = tone
    renderer.autoClear = autoClear
    this.lastCalls = calls + renderer.info.render.calls
    this.lastTriangles = tris + renderer.info.render.triangles
  }

  /**
   * Compile what the turntable draws before its first frame, in the background where the driver
   * has KHR_parallel_shader_compile. The car's materials were compiled for the world's lights;
   * under these lights, this environment and this tone curve they are new programs, and compiled
   * on the frame they are first drawn they are a hitch on the one screen that should be smooth.
   */
  async prepare(renderer: THREE.WebGLRenderer): Promise<void> {
    this.ensureEnv(renderer)
    this.frame(renderer)
    const tone = renderer.toneMapping
    renderer.toneMapping = THREE.ACESFilmicToneMapping
    let done: Promise<unknown> = Promise.resolve()
    try {
      done = renderer.compileAsync(this.scene, this.camera)
    } catch {
      /* compiled on first draw instead */
    }
    renderer.toneMapping = tone
    await Promise.race([done.catch(() => {}), new Promise((r) => setTimeout(r, 1500))])
  }

  /** the room environment the library's viewer lights its models with, made once, on first use */
  private ensureEnv(renderer: THREE.WebGLRenderer): void {
    if (this.envReady) return
    const pmrem = new THREE.PMREMGenerator(renderer)
    this.scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture
    pmrem.dispose()
    this.envReady = true
  }

  /** the polled menu edges, once a frame */
  handle(ui: UiEdges): void {
    if (!this.open) return
    if (ui.menuLeft || ui.menuUp) this.setFocus((this.focus - 1 + this.buttons.length) % this.buttons.length, true)
    else if (ui.menuRight || ui.menuDown) this.setFocus((this.focus + 1) % this.buttons.length, true)
    // the first press while the total is still counting finishes the count instead of choosing
    if ((ui.confirm || ui.pause) && !this.counted && this.age > 0.3) { this.age = 1e3; this.tickCount(); return }
    if (ui.confirm || ui.pause) this.choose()
    else if (ui.back) this.back()
  }

  /** Escape, Backspace, B: the button that leaves, if there is one */
  back(): void {
    if (!this.open || !this.armed) return
    const i = this.buttons.findIndex((b) => b.def.id === 'exit')
    if (i < 0) return
    this.setFocus(i, false)
    this.choose()
  }

  get armed(): boolean {
    return this.age >= ARM_S
  }

  /** the count-up and the breakdown appearing under it */
  private tickCount(): void {
    const w = this.result?.winnings
    if (!w || this.counted) return
    const t = this.age - 0.35
    const dur = countDuration(w.total)
    this.totalNum.textContent = formatAmount(countUp(t, w.total, dur), w.currency)
    const step = dur / Math.max(1, this.lineEls.length)
    this.lineEls.forEach((el, i) => el.classList.toggle('in', t >= i * step * 0.8))
    if (t >= dur) {
      this.counted = true
      this.root.classList.add('counted')
      this.sounds.select()
    }
  }

  private choose(): void {
    if (!this.armed) return
    const b = this.buttons[this.focus]
    if (!b) return
    this.sounds.select()
    b.def.run()
  }

  private setFocus(i: number, sound: boolean): void {
    if (!this.buttons.length) return
    this.focus = Math.max(0, Math.min(this.buttons.length - 1, i))
    this.buttons.forEach((b, k) => b.el.classList.toggle('selected', k === this.focus))
    if (sound) this.sounds.move()
  }

  /** a dark, slightly blue field for when there is no frame to copy */
  private drawBackdropFallback(): void {
    this.backCanvas.width = this.backCanvas.height = 2
    const g = this.backCanvas.getContext('2d')
    if (g) { g.fillStyle = '#2a3440'; g.fillRect(0, 0, 2, 2) }
    this.backMat.uniforms.texel.value.set(0.5, 0.5)
    this.backTex.needsUpdate = true
  }

  /**
   * Stand the subject on the turntable: centred, its lowest point on the floor, the camera far
   * enough back to see all of it with room to turn. The original stays where it is — this is
   * whatever main.ts handed over (a clone), or the stand-in figure.
   */
  private setSubject(obj: THREE.Object3D | null, kind: FinishShow): void {
    if (this.subject) this.turntable.remove(this.subject)
    this.subject = null
    this.turntable.rotation.y = -0.6
    if (kind === 'none') { this.shadow.visible = false; return }
    const s = obj ?? (kind === 'character' ? standInFigure() : null)
    if (!s) { this.shadow.visible = false; return }
    s.position.set(0, 0, 0)
    s.rotation.set(0, 0, 0)
    s.updateMatrixWorld(true)
    const box = new THREE.Box3().setFromObject(s)
    if (box.isEmpty()) { this.shadow.visible = false; return }
    const c = box.getCenter(new THREE.Vector3())
    s.position.set(-c.x, -box.min.y, -c.z)
    this.turntable.add(s)
    this.subject = s
    const size = box.getSize(new THREE.Vector3())
    this.shadow.visible = true
    this.shadow.scale.set(size.x * 1.35 + 0.3, 1, size.z * 1.35 + 0.3)
    this.shadow.position.set(0, 0.01, 0)
    // turning, the footprint's diagonal is what has to fit
    this.radius = Math.max(Math.hypot(size.x, size.z) / 2, size.y / 2, 0.4)
    this.target.set(0, size.y * (kind === 'character' ? 0.52 : 0.42), 0)
  }

  /**
   * Frame the camera: the subject in the middle of what the panel leaves free — to the panel's
   * left on a wide screen, above it on a tall one — by shifting the projection, not the camera, so
   * the perspective is the same as if the panel were not there.
   */
  private frame(renderer?: THREE.WebGLRenderer): void {
    const cw = renderer?.domElement.clientWidth || innerWidth
    const ch = renderer?.domElement.clientHeight || innerHeight
    const p = this.panel.getBoundingClientRect()
    const tall = ch > cw * 1.05
    this.camera.aspect = cw / Math.max(1, ch)
    // shifting the window right moves the subject left, and down moves it up
    const dx = tall ? 0 : Math.min(cw * 0.35, p.width / 2)
    const dy = tall ? Math.min(ch * 0.3, p.height / 2) : 0
    this.camera.setViewOffset(cw, ch, dx, dy, cw, ch)
    // FIT THE PART OF THE SCREEN THE PANEL LEAVES, both ways: on a phone the figure has the top
    // half, and fitted to the whole height it stood behind the panel from the waist down
    const freeW = Math.max(1, tall ? cw : cw - 2 * dx)
    const freeH = Math.max(1, tall ? ch - 2 * dy : ch)
    const halfV = Math.atan(Math.tan(THREE.MathUtils.degToRad(this.camera.fov / 2)) * (freeH / ch))
    const halfH = Math.atan(Math.tan(THREE.MathUtils.degToRad(this.camera.fov / 2)) * (freeW / ch))
    const distance = (this.radius / Math.sin(Math.min(halfV, halfH))) * 1.25
    const elev = THREE.MathUtils.degToRad(14)
    this.camera.position.set(0, this.target.y + Math.sin(elev) * distance, Math.cos(elev) * distance)
    this.camera.lookAt(this.target)
    this.camera.updateProjectionMatrix()
  }
}

/**
 * THE STAND-IN, for "character" when the game has no character model — and it has none yet: the
 * library's actors are unrigged (docs/corridor: rigging), and on foot is a camera. A plain
 * mannequin in the interface's slate, the right height (1.8 m), standing at ease. A level with a
 * model it would rather show passes `finish({ model: '<catalog id>' })`.
 */
export function standInFigure(): THREE.Object3D {
  const g = new THREE.Group()
  g.name = 'stand-in figure'
  const skin = new THREE.MeshStandardMaterial({ color: 0xc9d2dc, roughness: 0.55, metalness: 0.05 })
  const suit = new THREE.MeshStandardMaterial({ color: 0x2f5f8a, roughness: 0.6, metalness: 0.1 })
  const dark = new THREE.MeshStandardMaterial({ color: 0x1d242c, roughness: 0.7 })
  const part = (geo: THREE.BufferGeometry, mat: THREE.Material, x: number, y: number, z = 0, rz = 0): void => {
    const m = new THREE.Mesh(geo, mat)
    m.position.set(x, y, z)
    m.rotation.z = rz
    g.add(m)
  }
  part(new THREE.SphereGeometry(0.115, 24, 16), skin, 0, 1.66)
  part(new THREE.CylinderGeometry(0.05, 0.055, 0.08, 12), skin, 0, 1.53)
  part(new THREE.CapsuleGeometry(0.15, 0.4, 6, 16), suit, 0, 1.2)
  part(new THREE.CapsuleGeometry(0.05, 0.5, 4, 10), suit, -0.2, 1.17, 0, 0.1)
  part(new THREE.CapsuleGeometry(0.05, 0.5, 4, 10), suit, 0.2, 1.17, 0, -0.1)
  part(new THREE.SphereGeometry(0.05, 12, 8), skin, -0.23, 0.88)
  part(new THREE.SphereGeometry(0.05, 12, 8), skin, 0.23, 0.88)
  part(new THREE.CapsuleGeometry(0.075, 0.68, 4, 12), dark, -0.095, 0.48)
  part(new THREE.CapsuleGeometry(0.075, 0.68, 4, 12), dark, 0.095, 0.48)
  part(new THREE.BoxGeometry(0.11, 0.06, 0.24), dark, -0.095, 0.03, 0.04)
  part(new THREE.BoxGeometry(0.11, 0.06, 0.24), dark, 0.095, 0.03, 0.04)
  return g
}
