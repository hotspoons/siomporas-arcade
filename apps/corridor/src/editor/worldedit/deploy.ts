// The Deploy panel: one or more baked worlds → a running copy on Cloudflare.
//
// Rich, 2026-09-30: "think through a form where you select one or more world, it queries
// cloudflare, you give a URL for the worker, then it copies the assets up to R2 and bakes and
// deploys the worker."
//
// In that order, top to bottom:
//   1. the token — from the environment, or typed here and held in the server's memory
//   2. the worlds — every baked one, tick the ones this copy should carry (several = one URL,
//      the viewer's site picker chooses between them)
//   3. Cloudflare, asked — the account, its zones, its buckets, its workers.dev subdomain
//   4. where it goes — the Worker's name and address (workers.dev and/or a hostname in a zone),
//      the bucket (or a new one), the prefix under it, and whether older copies of these worlds
//      are deleted afterwards
//   5. the plan — what would be sent, by group, with every warning — then the deploy itself,
//      which is a run: its log is the progress, and the last line is the URL.

import { api, type DeployCloudflare, type DeployPlan, type DeployRecord, type DeployStatus } from './api'
import { button, el, toast } from '../../ui/shell'
import { bodyOf, empty, group, readout, select, textField, toggle } from '../../ui/controls'
import type { LogView } from './runs'

export interface DeployOpts {
  host: HTMLElement
  logs: LogView
}

const MiB = (n: number) => `${(n / 2 ** 20).toFixed(1)} MiB`

export class DeployPanel {
  private o: DeployOpts
  private status: DeployStatus | null = null
  private cf: DeployCloudflare | null = null
  private plan: DeployPlan | null = null
  private history: DeployRecord[] = []
  private planning = false
  private busy = false
  private form = {
    worlds: new Set<string>(),
    account: '',
    bucket: '',
    newBucket: '',
    prefix: '',
    prefixTouched: false,
    worker: '',
    workerTouched: false,
    workersDev: true,
    zoneId: '',
    host: '',
    prune: false,
  }
  /** set for one start(): delete this prefix, then upload the current bake there */
  private replacePrefix: string | null = null

  constructor(o: DeployOpts) {
    this.o = o
  }

  async load() {
    try {
      this.status = await api.deployStatus()
      this.history = (await api.deployHistory().catch(() => ({ deploys: [] }))).deploys
    } catch (e) {
      this.o.host.replaceChildren(empty(`deploy: ${(e as Error).message}`))
      return
    }
    if (!this.form.worlds.size && this.status.worlds.length === 1) this.form.worlds.add(this.status.worlds[0].slug)
    this.render()
  }

  private get worlds(): string[] {
    return (this.status?.worlds ?? []).map((w) => w.slug).filter((s) => this.form.worlds.has(s))
  }

  /** the prefix and the worker name follow the chosen worlds until somebody edits them */
  private defaults() {
    const w = this.worlds
    if (!this.form.prefixTouched) {
      const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z').replace('T', '-')
      this.form.prefix = w.length ? `corridor/${w.length === 1 ? w[0] : `${w[0]}+${w.length - 1}`}-${stamp}` : ''
    }
    if (!this.form.workerTouched) this.form.worker = w.length ? `corridor-${w.length === 1 ? w[0] : 'worlds'}` : 'corridor'
  }

  private async query() {
    this.busy = true
    this.render()
    try {
      this.cf = await api.deployCloudflare(this.form.account || null)
      this.form.account = this.cf.account ?? ''
      if (!this.form.bucket && this.cf.buckets.length) this.form.bucket = this.cf.buckets[0].name
      toast(`Cloudflare: ${this.cf.zones.length} zone${this.cf.zones.length === 1 ? '' : 's'}, ${this.cf.buckets.length} bucket${this.cf.buckets.length === 1 ? '' : 's'}`, 'ok')
    } catch (e) {
      toast((e as Error).message, 'danger', 8000)
    } finally {
      this.busy = false
      this.render()
    }
  }

  private async makePlan() {
    if (!this.worlds.length) return toast('choose a world first', 'warn')
    this.planning = true
    this.render()
    try {
      this.plan = await api.deployPlan(this.worlds)
    } catch (e) {
      toast((e as Error).message, 'danger', 8000)
    } finally {
      this.planning = false
      this.render()
    }
  }

  private async start(dryRun: boolean) {
    const f = this.form
    const replacePrefix = this.replacePrefix
    this.replacePrefix = null
    if (!this.worlds.length) return toast('choose a world first', 'warn')
    // THE TOKEN IS IN THE SERVICE'S MEMORY, and the service restarts on every deploy of the editor
    // itself. Ask again before starting, so "no Cloudflare token" arrives as "enter it again"
    // with the field on screen rather than as a bare error after the button (Rich, 2026-09-30).
    try {
      const st = await api.deployStatus()
      if (!st.token.present) {
        this.status = st
        this.render()
        return toast('the service has restarted since the token was entered — enter it again (or set CLOUDFLARE_API_TOKEN in its environment to keep it)', 'warn', 9000)
      }
    } catch { /* the start below reports it */ }
    if (!f.account) return toast('query Cloudflare first', 'warn')
    const bucket = f.newBucket.trim() || f.bucket
    if (!bucket) return toast('choose or name a bucket', 'warn')
    if (!f.workersDev && !(f.host && f.zoneId)) return toast('give the worker an address: workers.dev, or a hostname in a zone', 'warn')
    this.busy = true
    this.render()
    try {
      const zone = this.cf?.zones.find((z) => z.id === f.zoneId)
      const hostname = f.host && zone ? (f.host.endsWith(zone.name) ? f.host : `${f.host}.${zone.name}`) : null
      const { run } = await api.deployStart({
        worlds: this.worlds,
        account: f.account,
        bucket,
        createBucket: true,
        prefix: f.prefix,
        worker: { name: f.worker, workersDev: f.workersDev, hostname, zoneId: hostname ? f.zoneId : null },
        prune: f.prune,
        replacePrefix,
        dryRun,
      })
      toast(`${run.label} started`, 'ok')
      void this.o.logs.open(run.id)
    } catch (e) {
      toast((e as Error).message, 'danger', 8000)
    } finally {
      this.busy = false
      this.render()
    }
  }

  /**
   * Send this deployment again: same worker, same prefix, current bake.
   * The objects under that prefix are deleted first, then the worlds as they are now are uploaded.
   */
  private async redeploy(d: DeployRecord) {
    const named = new Set((this.status?.worlds ?? []).map((w) => w.slug))
    const missing = d.worlds.filter((w) => !named.has(w))
    if (missing.length) return toast(`${missing.join(', ')} is not in this site`, 'warn')
    this.loadRecord(d)
    this.form.prefix = d.prefix
    this.form.prefixTouched = true
    this.replacePrefix = d.prefix
    await this.start(false)
  }

  /** Put a past deploy's choices back in the form: the worlds, the worker, its address, the bucket, pruning. */
  private loadRecord(d: DeployRecord) {
    const f = this.form
    f.worlds = new Set(d.worlds)
    f.account = d.account
    f.bucket = d.bucket
    f.newBucket = ''
    f.worker = d.worker.name
    f.workerTouched = true
    f.workersDev = d.worker.workersDev !== false
    f.zoneId = d.worker.zoneId ?? ''
    f.host = d.worker.hostname ?? ''
    f.prune = d.prune
    f.prefixTouched = false // Load starts a new revision. Redeploy sets the prefix back and replaces it.
    this.plan = null
    this.render()
    toast(`loaded: ${d.worlds.join(', ')} → ${d.worker.name}${d.worker.hostname ? ` at ${d.worker.hostname}` : ''}`, 'ok')
  }

  render() {
    const host = this.o.host
    host.replaceChildren()
    const st = this.status
    if (!st) return
    this.defaults()
    const f = this.form

    /* 0 · what was deployed before, when its worlds are still in this site */
    const named = new Set((st.worlds ?? []).map((w) => w.slug))
    const usable = this.history.filter((d) => d.worlds.length > 0 && d.worlds.every((w) => named.has(w)))
    if (usable.length) {
      const past = group(`Past deployments (${usable.length})`, { collapsed: false, note: 'these contain worlds in this site. Redeploy deletes that copy in R2 and uploads the current bake in its place' })
      const pb = bodyOf(past)
      for (const d of usable.slice(0, 20)) {
        const row = el('div', 'deploy-row')
        const when = d.at.slice(0, 16).replace('T', ' ')
        row.append(el('div', 'deploy-row-main', `${d.worlds.join(', ')} → ${d.worker.name}${d.worker.hostname ? ` · ${d.worker.hostname}` : ''}`))
        row.append(el('div', 'deploy-row-note', `${when} · ${d.state}${d.bytes ? ` · ${MiB(d.bytes)}` : ''}${d.urls?.length ? ` · ${d.urls[0]}` : ''}`))
        const acts = el('div', 'row')
        acts.append(
          button({ label: 'Load', icon: 'arrow-uturn-left', variant: 'ghost', onClick: () => this.loadRecord(d) }),
          button({ label: 'Redeploy', icon: 'cloud-arrow-up', variant: 'ghost', disabled: this.busy || !st.token.present, onClick: () => void this.redeploy(d) }),
        )
        if (d.urls?.[0]) acts.append(button({ label: 'Open', icon: 'arrow-top-right-on-square', variant: 'ghost', onClick: () => window.open(d.urls![0], '_blank', 'noopener') }))
        row.append(acts)
        pb.append(row)
      }
      host.append(past)
    }

    /* 1 · the token */
    const tok = group('1 · Cloudflare token', { note: st.token.present ? (st.token.source === 'env' ? 'from the environment' : 'entered here, held in memory') : 'none yet' })
    const tb = bodyOf(tok)
    if (st.token.present) {
      tb.append(readout('token', st.token.source === 'env' ? 'CLOUDFLARE_API_TOKEN' : 'in memory — not written anywhere, never shown', false))
      if (st.token.source === 'entered') tb.append(button({ label: 'Forget it', icon: 'trash', variant: 'ghost', onClick: async () => { await api.deployForgetToken(); this.cf = null; await this.load() } }))
    } else {
      let typed = ''
      const field = textField({ label: 'API token', value: '', placeholder: 'a user token, or an account-owned token', note: 'Workers Scripts, R2 Storage and Account Settings read; kept in the server’s memory only — set CLOUDFLARE_API_TOKEN in the environment to skip this', onChange: (v) => (typed = v), onInput: (v) => (typed = v) })
      const input = field.querySelector('input')
      if (input) input.type = 'password'
      tb.append(
        field,
        button({
          label: 'Use this token',
          icon: 'lock-closed',
          variant: 'primary',
          onClick: async () => {
            try {
              const r = await api.deployToken(typed)
              toast(`token accepted (${r.kind === 'account' ? 'account-owned' : 'user'} token)`, 'ok')
              await this.load()
            } catch (e) {
              toast((e as Error).message, 'danger', 8000)
            }
          },
        }),
      )
    }
    host.append(tok)

    /* 2 · the worlds */
    const ws = group('2 · Worlds', { note: 'several worlds share one address; the viewer’s site picker chooses' })
    const wb = bodyOf(ws)
    if (!st.worlds.length) wb.append(empty('no baked worlds — bake one first'))
    for (const w of st.worlds) {
      wb.append(toggle({ label: w.name === w.slug ? w.slug : `${w.name} (${w.slug})`, value: f.worlds.has(w.slug), onChange: (on) => { if (on) f.worlds.add(w.slug); else f.worlds.delete(w.slug); this.plan = null; this.render() } }))
    }
    host.append(ws)

    /* 3 · Cloudflare, asked */
    const q = group('3 · Cloudflare', { note: this.cf ? `account ${this.cf.accounts.find((a) => a.id === this.cf!.account)?.name ?? this.cf.account}` : 'not asked yet' })
    const qb = bodyOf(q)
    qb.append(button({ label: this.cf ? 'Ask again' : 'Query Cloudflare', icon: 'cloud', variant: this.cf ? 'ghost' : 'primary', disabled: !st.token.present || this.busy, onClick: () => void this.query() }))
    if (this.cf) {
      if (this.cf.accounts.length > 1) {
        qb.append(select({ label: 'Account', value: f.account, options: this.cf.accounts.map((a) => ({ value: a.id, label: a.name })), onChange: (v) => { f.account = v; void this.query() } }))
      }
      qb.append(readout('zones', this.cf.zones.length ? this.cf.zones.map((z) => z.name).join(', ') : 'none — a Worker can still live on workers.dev', false))
      qb.append(readout('workers.dev', this.cf.subdomain ? `*.${this.cf.subdomain}.workers.dev` : 'no subdomain set on the account yet', false))
    }
    host.append(q)

    /* 4 · where it goes */
    const where = group('4 · Where it goes')
    const xb = bodyOf(where)
    xb.append(textField({ label: 'Worker name', value: f.worker, note: 'lower-case, digits and dashes', onChange: (v) => { f.worker = v; f.workerTouched = true } }))
    xb.append(toggle({ label: `serve at ${f.worker || 'name'}.${this.cf?.subdomain ?? '<account>'}.workers.dev`, value: f.workersDev, onChange: (v) => { f.workersDev = v; this.render() } }))
    if (this.cf?.zones.length) {
      xb.append(select({ label: 'Zone', value: f.zoneId, options: [{ value: '', label: '(no custom hostname)' }, ...this.cf.zones.map((z) => ({ value: z.id, label: z.name }))], onChange: (v) => { f.zoneId = v; this.render() } }))
      if (f.zoneId) {
        const zone = this.cf.zones.find((z) => z.id === f.zoneId)!
        xb.append(textField({ label: 'Hostname', value: f.host, placeholder: `play  →  play.${zone.name}`, note: 'a subdomain of the zone; Cloudflare writes the DNS record', onChange: (v) => (f.host = v.trim()) }))
      }
    }
    const buckets = this.cf?.buckets ?? []
    xb.append(select({ label: 'Bucket', value: f.newBucket ? '' : f.bucket, options: [...buckets.map((b) => ({ value: b.name, label: b.name })), { value: '', label: 'a new one…' }], note: buckets.length ? undefined : 'query Cloudflare to list buckets, or name a new one', onChange: (v) => { f.bucket = v; if (v) f.newBucket = ''; this.render() } }))
    if (!f.bucket || f.newBucket) xb.append(textField({ label: 'New bucket', value: f.newBucket, placeholder: 'corridor-games', note: 'made on the first deploy if it does not exist', onChange: (v) => (f.newBucket = v.trim()) }))
    xb.append(textField({ label: 'Prefix', value: f.prefix, note: 'every object of this deploy lives under it, so an old copy can be deleted whole', onChange: (v) => { f.prefix = v.trim(); f.prefixTouched = true } }))
    xb.append(toggle({ label: 'delete older copies of these worlds from the bucket afterwards', value: f.prune, onChange: (v) => (f.prune = v) }))
    if (this.cf && f.account && f.bucket && !f.newBucket) {
      xb.append(button({ label: 'What is in the bucket already', icon: 'queue-list', variant: 'ghost', onClick: async () => {
        try {
          const { deployments } = await api.deployRevisions(f.account, f.bucket)
          toast(deployments.length ? deployments.map((d) => `${d.prefix} — ${d.worlds.join(', ')} · ${d.at.slice(0, 16)} · ${MiB(d.bytes)}`).join('\n') : 'no deploys recorded in that bucket', 'info', 12000)
        } catch (e) {
          toast((e as Error).message, 'danger', 8000)
        }
      } }))
    }
    host.append(where)

    /* 5 · the plan, then the deploy */
    const go = group('5 · Deploy', { note: st.app ? `app: ${st.app} · setup: docs/corridor/CLOUDFLARE.md` : 'setup: docs/corridor/CLOUDFLARE.md' })
    const gb = bodyOf(go)
    gb.append(button({ label: this.planning ? 'Planning…' : 'Plan (dry run)', icon: 'beaker', variant: 'ghost', disabled: this.planning || !this.worlds.length, onClick: () => void this.makePlan() }))
    const p = this.plan
    if (p) {
      const groups = Object.entries(p.byGroup).map(([g, v]) => `${g} ${v.objects} (${MiB(v.bytes)})`).join(' · ')
      gb.append(readout('objects', `${p.count} · ${MiB(p.bytes)}`, false))
      gb.append(readout('by group', groups, false))
      gb.append(readout('levels', p.levels.length ? p.levels.join(', ') : 'none', false))
      gb.append(readout('models used', `${p.assets.items.length}${p.assets.items.length ? `: ${p.assets.items.join(', ')}` : ''}`, false))
      const builds = Object.entries(p.assets.builds).filter(([, v]) => v.length).map(([k, v]) => `${k} ${v.length}`).join(' · ')
      if (builds) gb.append(readout('builds', builds, false))
      if (p.app) gb.append(readout('app', `${p.app.files} files · ${MiB(p.app.bytes)}`, false))
      for (const w of p.warnings) gb.append(el('div', 'panel-hint warn', `⚠ ${w}`))
      for (const x of p.problems) gb.append(el('div', 'panel-hint warn', `✕ ${x}`))
    }
    const ready = !!(st.token.present && this.cf && this.worlds.length && (f.bucket || f.newBucket) && (!p || !p.problems.length))
    gb.append(button({ label: this.busy ? 'Working…' : 'Deploy', icon: 'cloud-arrow-up', variant: 'primary', disabled: !ready || this.busy, onClick: () => void this.start(false) }))
    if (!st.token.present) gb.append(el('div', 'panel-hint', 'a token first'))
    else if (!this.cf) gb.append(el('div', 'panel-hint', 'query Cloudflare first'))
    host.append(go)
  }
}
