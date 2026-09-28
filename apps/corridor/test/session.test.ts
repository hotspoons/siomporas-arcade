// Does the session client hold up its end of ACP?
//
// The agent is the other half of this protocol and it asks the CLIENT for things — read this file,
// run this command, may I edit that. Every one of those is a request this page has to answer
// correctly or the agent hangs, and "the agent hangs" is what all of them look like from outside.
//
// So these drive a fake agent: a JSON-RPC peer on the other end of a pair of transports, saying
// what a real one says.
import { describe, expect, it, vi } from 'vitest'
import { JsonRpcPeer, type JsonRpcTransport } from '../src/agent/rpc'
import { Session, type Entry } from '../src/agent/session'

/** Two transports wired to each other, so a real peer can sit on each end. */
function pipe(): [JsonRpcTransport, JsonRpcTransport] {
  const ends: { msg: (p: string) => void; close: (e?: Error) => void }[] = [
    { msg: () => {}, close: () => {} },
    { msg: () => {}, close: () => {} },
  ]
  const make = (me: number): JsonRpcTransport => ({
    send: (p) => queueMicrotask(() => ends[1 - me].msg(p)),
    onMessage: (cb) => { ends[me].msg = cb },
    onClose: (cb) => { ends[me].close = cb },
    close: () => queueMicrotask(() => ends[1 - me].close(new Error('the other end closed'))),
  })
  return [make(0), make(1)]
}

/** A shell that records what it was asked, standing in for the projection. */
function fakeShell() {
  const calls: { method: string; params: unknown }[] = []
  return {
    calls,
    shell: {
      handle: async (method: string, params: Record<string, unknown>) => {
        calls.push({ method, params })
        if (method === 'fs/read_text_file') return { content: '{"slug":"crofton-triangle"}' }
        if (method === 'terminal/create') return { terminalId: 'term-1' }
        return {}
      },
    },
  }
}

/** A session wired straight to a fake agent, with no socket in the way. */
function connected(opts: { ask?: () => Promise<string | null> } = {}) {
  const [a, b] = pipe()
  const entries: Entry[] = []
  const states: string[] = []
  const { shell, calls } = fakeShell()
  const s = new Session({
    shell: shell as never,
    onEntry: (e) => entries.push(e),
    onState: (x, d) => states.push(d ? `${x}:${d}` : x),
    ask: opts.ask ?? (async () => null),
  })
  // reach past `connect`, which owns the WebSocket; what is under test is the protocol
  const wire = (s as unknown as { wire: (p: JsonRpcPeer) => void }).wire.bind(s)
  const peer = new JsonRpcPeer(a)
  wire(peer)
  ;(s as unknown as { peer: JsonRpcPeer; id: string }).peer = peer
  ;(s as unknown as { peer: JsonRpcPeer; id: string }).id = 'sess-1'
  const agent = new JsonRpcPeer(b)
  return { session: s, agent, entries, states, calls }
}

describe('the editor tools', () => {
  it('answers a file read out of the shell', async () => {
    const { agent, calls } = connected()
    const r = await agent.request<{ content: string }>('fs/read_text_file', { path: '/workspace/worlds/crofton-triangle.json' })
    expect(r.content).toContain('crofton-triangle')
    expect(calls[0]).toEqual({ method: 'fs/read_text_file', params: { path: '/workspace/worlds/crofton-triangle.json' } })
  })

  it('answers a write, which is a live edit to a document', async () => {
    const { agent, calls } = connected()
    await agent.request('fs/write_text_file', { path: '/workspace/programs/a.ts', content: 'export default 1' })
    expect(calls[0].method).toBe('fs/write_text_file')
  })

  it('answers the whole terminal set, because an agent uses all of it', async () => {
    const { agent, calls } = connected()
    await agent.request('terminal/create', { command: 'ls', args: ['worlds/'] })
    for (const m of ['terminal/output', 'terminal/wait_for_exit', 'terminal/kill', 'terminal/release']) {
      await agent.request(m, { terminalId: 'term-1' })
    }
    expect(calls.map((c) => c.method)).toEqual([
      'terminal/create', 'terminal/output', 'terminal/wait_for_exit', 'terminal/kill', 'terminal/release',
    ])
  })

  it('reports a method it does not know rather than hanging', async () => {
    const { agent } = connected()
    await expect(agent.request('fs/delete_everything', {})).rejects.toThrow(/method not found/)
  })
})

describe('permission', () => {
  it('asks before letting the agent change something', async () => {
    const ask = vi.fn(async () => 'allow-once')
    const { agent } = connected({ ask })
    const r = await agent.request<{ outcome: { outcome: string; optionId?: string } }>('session/request_permission', {
      toolCall: { title: 'Write worlds/crofton-triangle.json', kind: 'edit', rawInput: { path: 'worlds/x.json' } },
      options: [{ optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' }, { optionId: 'reject', name: 'No', kind: 'reject_once' }],
    })
    expect(ask).toHaveBeenCalledOnce()
    expect(r.outcome).toEqual({ outcome: 'selected', optionId: 'allow-once' })
  })

  it('does NOT ask about a read', async () => {
    // a dialog per file trains a person to press the first button, which is how the one that
    // mattered gets allowed too
    const ask = vi.fn(async () => null)
    const { agent } = connected({ ask })
    const r = await agent.request<{ outcome: { outcome: string; optionId?: string } }>('session/request_permission', {
      toolCall: { title: 'Read worlds/x.json', kind: 'read' },
      options: [{ optionId: 'ok', name: 'Allow', kind: 'allow_once' }],
    })
    expect(ask).not.toHaveBeenCalled()
    expect(r.outcome).toEqual({ outcome: 'selected', optionId: 'ok' })
  })

  it('still asks about a read with no allow option, rather than inventing one', async () => {
    const ask = vi.fn(async () => 'x')
    const { agent } = connected({ ask })
    await agent.request('session/request_permission', {
      toolCall: { title: 'Read', kind: 'read' },
      options: [{ optionId: 'x', name: 'Only this', kind: 'reject_once' }],
    })
    expect(ask).toHaveBeenCalledOnce()
  })

  it('reports a dismissed dialog as cancelled, not as a refusal', async () => {
    // they are different to an agent: refused means "do something else", cancelled means "stop"
    const { agent } = connected({ ask: async () => null })
    const r = await agent.request<{ outcome: { outcome: string } }>('session/request_permission', {
      toolCall: { title: 'Delete the world', kind: 'delete' },
      options: [{ optionId: 'yes', name: 'Yes', kind: 'allow_once' }],
    })
    expect(r.outcome).toEqual({ outcome: 'cancelled' })
  })
})

describe('the transcript', () => {
  const notify = (agent: JsonRpcPeer, update: unknown) => agent.send('session/update', { sessionId: 'sess-1', update })
  const settle = () => new Promise((r) => setTimeout(r, 0))

  it('shows what the agent said, and its thinking as its own kind', async () => {
    const { agent, entries } = connected()
    notify(agent, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'looking at the worlds' } })
    notify(agent, { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'hmm' } })
    await settle()
    expect(entries).toEqual([
      { kind: 'agent', text: 'looking at the worlds' },
      { kind: 'thought', text: 'hmm' },
    ])
  })

  it('carries a tool call id, so an update is an update rather than another line', async () => {
    const { agent, entries } = connected()
    notify(agent, { sessionUpdate: 'tool_call', toolCallId: 't1', title: 'Read worlds/x.json', status: 'pending' })
    notify(agent, { sessionUpdate: 'tool_call_update', toolCallId: 't1', status: 'completed' })
    await settle()
    expect(entries.map((e) => [e.id, e.status])).toEqual([['t1', 'pending'], ['t1', 'completed']])
  })

  it('renders a plan as its entries, with what is done marked', async () => {
    const { agent, entries } = connected()
    notify(agent, { sessionUpdate: 'plan', entries: [
      { content: 'read the world', status: 'completed' },
      { content: 'write the level', status: 'pending' },
    ] })
    await settle()
    expect(entries[0].kind).toBe('plan')
    expect(entries[0].text).toBe('✓ read the world\n· write the level')
  })

  it('ignores an update kind it has never heard of, rather than throwing in a notification', async () => {
    // a notification handler that throws takes nothing with it, but it also says nothing; the
    // protocol gains update kinds and an older client must simply not show them
    const { agent, entries } = connected()
    notify(agent, { sessionUpdate: 'some_future_thing', whatever: 1 })
    notify(agent, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'still here' } })
    await settle()
    expect(entries).toEqual([{ kind: 'agent', text: 'still here' }])
  })
})

describe('prompting', () => {
  it('shows what was typed, waits for the turn, and says when it is thinking', async () => {
    const { session, agent, entries, states } = connected()
    agent.handle('session/prompt', async () => ({ stopReason: 'end_turn' }))
    await session.prompt('what worlds are there?')
    expect(entries[0]).toEqual({ kind: 'you', text: 'what worlds are there?' })
    expect(states).toEqual(['thinking', 'ready'])
  })

  it('refuses a second prompt while the first is running', async () => {
    // two interleaved streams into one transcript, with no way to tell which answered what
    const { session, agent } = connected()
    let release: () => void = () => {}
    agent.handle('session/prompt', () => new Promise((r) => { release = () => r({ stopReason: 'end_turn' }) }))
    const first = session.prompt('one')
    await new Promise((r) => setTimeout(r, 0))
    await expect(session.prompt('two')).rejects.toThrow(/still working/)
    release()
    await first
    // and it takes one afterwards
    agent.handle('session/prompt', async () => ({ stopReason: 'end_turn' }))
    await expect(session.prompt('three')).resolves.toBeUndefined()
  })

  it('says so when the turn stopped for a reason other than finishing', async () => {
    const { session, agent, entries } = connected()
    agent.handle('session/prompt', async () => ({ stopReason: 'max_tokens' }))
    await session.prompt('go')
    expect(entries.some((e) => e.kind === 'note' && e.text.includes('max_tokens'))).toBe(true)
  })

  it('frees itself when a turn fails, rather than staying busy for ever', async () => {
    const { session, agent } = connected()
    agent.handle('session/prompt', async () => { throw new Error('the model is down') })
    await expect(session.prompt('go')).rejects.toThrow(/the model is down/)
    expect(session.running).toBe(false)
  })
})
