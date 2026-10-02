// The volume as a git repository: what is in it, what has changed, and where it pushes to.
//
// Rich, 2026-09-28: "being able to hook the games code base and assets up to a git lfs repo would
// be a nice touch. We'll need a way to manage git credentials to push to a remote repo."
//
// WHAT THIS SHOWS BEFORE IT DOES ANYTHING. The volume is 64 GB on the machine this was written on
// and 56 of that is re-fetchable cache. So the panel opens with the SCAN — what is actually there,
// by format, and which of it would go through LFS — because "this will push 4.2 GB of .ktx2" is
// something to find out before pressing a button rather than eleven minutes into it.
//
// THE TOKEN IS WRITE-ONLY. It is sent once, stored server-side in a 0600 file the git credential
// helper reads, and never comes back: the panel shows which host it is for and who it is for, and
// has no way to display the secret. A field that can show a token is a field that ends up in a
// screenshot.
import { api } from './api'
import type { GitScan, GitStatus } from './gittypes'
import { bodyOf, empty, group, readout, setFieldError, textField, toggle } from '../../ui/controls'
import { button, confirm, el, toast } from '../../ui/shell'

const size = (n: number) => (n >= 1e9 ? `${(n / 1e9).toFixed(1)} GB` : n >= 1e6 ? `${(n / 1e6).toFixed(1)} MB` : n >= 1e3 ? `${(n / 1e3).toFixed(0)} kB` : `${n} B`)

export interface GitPanelOpts {
  host: HTMLElement
  refresh: () => void
}

export class GitPanel {
  private readonly o: GitPanelOpts
  private status: GitStatus | null = null
  private scan: GitScan | null = null
  private remote = ''
  private bakes = false
  private busy = false

  constructor(o: GitPanelOpts) {
    this.o = o
  }

  async load(): Promise<void> {
    this.status = await api.gitStatus().catch(() => null)
    this.scan = await api.gitScan().catch(() => null)
    this.remote = this.status?.remote ?? this.remote
    this.render()
  }

  private async act(what: string, fn: () => Promise<unknown>): Promise<void> {
    if (this.busy) return
    this.busy = true
    this.render()
    try {
      await fn()
    } catch (e) {
      toast(`${what}: ${(e as Error).message}`, 'danger', 8000)
    } finally {
      this.busy = false
      await this.load()
    }
  }

  render(): void {
    const host = this.o.host
    host.replaceChildren()
    const st = this.status

    if (!st) {
      host.append(empty('The world editor service is not answering.'))
      return
    }

    /* ---- where it is, and where it goes ---- */
    {
      const g = group(st.repo ? 'Repository' : 'Not a repository yet', { collapsed: false })
      const b = bodyOf(g)
      b.append(readout('volume', st.root, true))
      if (st.repo) {
        b.append(readout('branch', st.branch ?? '(no commits yet)'))
        b.append(readout('remote', st.remote ?? 'none'))
        if (st.upstream) b.append(readout('tracking', `${st.upstream}${st.ahead ? ` · ${st.ahead} ahead` : ''}${st.behind ? ` · ${st.behind} behind` : ''}`))
        if (st.lastCommit) b.append(readout('last commit', st.lastCommit))
        b.append(readout('changed', `${st.changed.length} modified, ${st.untracked} new`))
        b.append(readout('through LFS', st.tracked.length ? st.tracked.map((e) => `.${e}`).join(' ') : 'nothing yet'))
      }
      if (!st.lfs) {
        b.append(el('p', 'note warn', 'git-lfs is not installed on the service. Large files would be committed whole, which is how a repository becomes unclonable.'))
      }
      if (st.error) b.append(el('p', 'note warn', st.error))
      host.append(g)
    }

    /* ---- what is on the volume ---- */
    if (this.scan) {
      const s = this.scan
      const g = group(`What would be committed (${s.files} files, ${size(s.bytes)})`, { collapsed: false })
      const b = bodyOf(g)
      b.append(el('p', 'note', 'Worlds, levels, programs, places, assets, and the tuning and presets beside each bake. The download cache and the bake rasters are excluded.'))
      for (const e of s.exts.slice(0, 10)) {
        const row = el('div', 'readout')
        row.append(
          el('span', 'field-label', `.${e.ext}`),
          el('span', 'field-value mono', `${e.files} · ${size(e.bytes)}${e.lfs ? ' · LFS' : ''}`),
        )
        b.append(row)
      }
      if (s.truncated) b.append(el('p', 'note warn', 'the scan stopped at 200 000 files; the numbers above are a floor'))
      host.append(g)
    }

    /* ---- the remote ---- */
    {
      const g = group('Remote', { collapsed: st.repo && !!st.remote })
      const b = bodyOf(g)
      const field = textField({
        label: 'URL',
        value: this.remote,
        placeholder: 'https://github.com/you/your-world.git',
        onChange: (v) => { this.remote = v.trim(); setFieldError(field, null) },
      })
      b.append(field)
      b.append(toggle({
        label: 'include the baked worlds',
        value: this.bakes,
        note: 'gigabytes of raster per world, through LFS. Off by default: a bake is reproducible from its definition.',
        onChange: (v) => { this.bakes = v },
      }))
      b.append(button({
        label: st.repo ? 'Update' : 'Set it up',
        icon: 'check',
        variant: 'primary',
        disabled: this.busy,
        onClick: () => {
          if (!this.remote && !st.repo) return setFieldError(field, 'give it a remote to push to')
          void this.act('set up', () => api.gitInit({ remote: this.remote || undefined, bakes: this.bakes }))
        },
      }))
      host.append(g)
    }

    /* ---- the credential ---- */
    {
      const c = st.credential
      const g = group('Credential', { collapsed: c.set })
      const b = bodyOf(g)
      if (c.set) {
        b.append(readout('stored', c.kind === 'ssh-key' ? 'an SSH private key' : `a token for ${c.host}`))
        if (c.username) b.append(readout('as', c.username))
        b.append(el('p', 'note', 'Replace it by filling the fields below.'))
      } else {
        b.append(el('p', 'note', 'A personal access token with write access to the repository. Stored on the service; nothing here can show it again.'))
      }
      let host_ = c.host ?? ''
      let user = c.username ?? ''
      let secret = ''
      const hostField = textField({ label: 'host', value: host_, placeholder: 'github.com', onChange: (v) => { host_ = v.trim(); setFieldError(hostField, null) } })
      const userField = textField({ label: 'username', value: user, placeholder: 'your-user', onChange: (v) => { user = v.trim(); setFieldError(userField, null) } })
      const secretField = textField({ label: 'token', value: '', placeholder: 'ghp_…', onChange: (v) => { secret = v; setFieldError(secretField, null) } })
      // a token is a password: the browser must not offer to remember it, and it must not be
      // readable over somebody's shoulder
      const input = secretField.querySelector<HTMLInputElement>('input')
      if (input) { input.type = 'password'; input.autocomplete = 'off' }
      b.append(hostField, userField, secretField)
      b.append(button({
        label: 'Store it',
        icon: 'lock-closed',
        variant: 'primary',
        disabled: this.busy,
        onClick: () => {
          if (!host_) return setFieldError(hostField, 'which host is it for')
          if (!user) return setFieldError(userField, 'who is it for')
          if (!secret) return setFieldError(secretField, 'paste the token')
          void this.act('credential', async () => {
            await api.gitCredential({ kind: 'https-token', host: host_, username: user, secret })
            secret = ''
            toast('credential stored on the service', 'ok')
          })
        },
      }))
      if (c.set) {
        b.append(button({
          label: 'Forget it',
          icon: 'trash',
          variant: 'ghost',
          disabled: this.busy,
          onClick: () => void confirm({ title: 'Forget the credential?', message: 'Pushing will stop working until another one is stored.', ok: 'Forget', danger: true })
            .then((ok) => { if (ok) void this.act('credential', () => api.gitClearCredential()) }),
        }))
      }
      host.append(g)
    }

    /* ---- commit and push ---- */
    if (st.repo) {
      const g = group('Commit and push', { collapsed: false })
      const b = bodyOf(g)
      let message = ''
      const msg = textField({ label: 'message', value: '', placeholder: 'crofton: dusk preset and the rooftop program', onChange: (v) => { message = v; setFieldError(msg, null) } })
      b.append(msg)
      const nothing = !st.changed.length && !st.untracked
      b.append(button({
        label: nothing ? 'Nothing to commit' : `Commit ${st.changed.length + st.untracked} file${st.changed.length + st.untracked === 1 ? '' : 's'}`,
        icon: 'document-arrow-down',
        disabled: this.busy || nothing,
        onClick: () => {
          if (!message.trim()) return setFieldError(msg, 'say what changed')
          void this.act('commit', async () => {
            const r = await api.gitCommit(message.trim())
            toast(r.committed ? `committed ${r.files} files` : r.why ?? 'nothing changed', r.committed ? 'ok' : 'info')
          })
        },
      }))
      b.append(button({
        label: st.ahead ? `Push ${st.ahead} commit${st.ahead === 1 ? '' : 's'}` : 'Push',
        icon: 'cloud-arrow-up',
        variant: 'primary',
        disabled: this.busy || !st.remote,
        onClick: () => void this.act('push', async () => {
          toast('pushing — LFS objects go one at a time and a first push of a world takes a while', 'info', 6000)
          await api.gitPush()
          toast('pushed', 'ok')
        }),
      }))
      if (st.behind) {
        b.append(button({
          label: `Pull ${st.behind}`,
          icon: 'arrow-down-tray',
          disabled: this.busy,
          onClick: () => void this.act('pull', () => api.gitPull()),
        }))
      }
      host.append(g)
    }
  }
}
