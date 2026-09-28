#!/usr/bin/env node
// A thin client for the zip-ties agent harness on :8400, so work can be handed to a local model
// instead of to Claude.
//
//   node tools/assetlib/zt.mjs agents
//   node tools/assetlib/zt.mjs new --name Rigger
//   node tools/assetlib/zt.mjs ask --dep dep_xxx --text "..."       # send and wait for the reply
//   node tools/assetlib/zt.mjs ask --dep dep_xxx --file brief.md
//   node tools/assetlib/zt.mjs say --dep dep_xxx --text "..."       # fire and forget
//   node tools/assetlib/zt.mjs read --dep dep_xxx                   # last reply
//
// WHY THIS EXISTS. Rich: "I want it either scriptable, or more realistically done with a reasonably
// sized model that can run on a high end consumer GPU... doesn't depend on a $200/mo Anthropic
// subscription for updates." So the asset pipeline's judgement steps need to run on the local
// qwen3.8-27b deployment, and that needs to be a command, not a conversation.
//
// THINGS THAT COST TIME TO FIND OUT, recorded so the next person does not repeat them:
//
// - Auth is loopback: from this box you are `user:local-admin` with every action. No token needed.
// - There is NO `POST /api/v1/sessions` (405). Creating a DEPLOYMENT auto-creates its session;
//   find it by matching `target.deployment_id` in `GET /api/v1/sessions`.
// - The message body is `{"text": "..."}` and nothing else. `content`, `message` and `parts` all
//   return 400 `text required`.
// - `PATCH /api/v1/deployments/:id` and `.../config` both return 200 and silently DO NOT apply a
//   policy change. The model pin has to be set in the CREATE body or it stays `allowed_models:["*"]`
//   with a null default — which quietly routes to Anthropic, defeating the whole point.
// - The transcript is ACP JSON-RPC at `GET /api/v1/sessions/:id/snapshot`. The agent's actual words
//   are `session/update` rows whose `update.content.type === 'text'`; the turn is over when a
//   `result` row carries a `stopReason`. Thought rows look identical but carry `sessionUpdate:
//   'agent_thought_chunk'` — skip those or you read its reasoning as its answer.
// - The agent declares `promptCapabilities.image = true`, so a VLM step is available on this model.

const BASE = process.env.ZT_BASE || 'http://127.0.0.1:8400'
const MODEL = process.env.ZT_MODEL || 'qwen3.8-27b'

const api = async (method, path, body) => {
  const r = await fetch(`${BASE}/api/v1${path}`, {
    method,
    headers: { accept: 'application/json', ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  })
  const text = await r.text()
  let json = null
  try { json = text ? JSON.parse(text) : null } catch { json = { raw: text } }
  if (!r.ok) throw new Error(`${method} ${path} -> ${r.status} ${JSON.stringify(json).slice(0, 200)}`)
  return json
}

export const listDeployments = () => api('GET', '/deployments')
export const listSessions = () => api('GET', '/sessions')

/** The session that was created with a deployment. There is no way to make another one. */
export async function sessionFor(depId) {
  const s = (await listSessions()).find((x) => x.target?.deployment_id === depId)
  if (!s) throw new Error(`no session for ${depId}`)
  return s.id
}

/**
 * Create a deployment with the model pinned. The pin MUST go in this call — see the header.
 */
export async function createAgent(name, { entry = 'hermes', model = MODEL } = {}) {
  const dep = await api('POST', '/deployments', {
    entry, name,
    policy: { llm: { allowed_models: [model], default_model: model, default_provider: 'default', routes: {}, pin: null, budget: null } },
  })
  for (let i = 0; i < 60; i++) {
    const d = await api('GET', `/deployments/${dep.id}`)
    if (d.status === 'ready') return d
    if (d.status === 'failed') throw new Error(`deployment failed: ${d.status_detail}`)
    await new Promise((r) => setTimeout(r, 4000))
  }
  throw new Error('deployment never became ready')
}

/** Everything the agent has SAID (not thought), oldest first, with the turn's stop reason. */
export async function transcript(sessionId) {
  const snap = await api('GET', `/sessions/${sessionId}/snapshot`)
  const said = []
  let stop = null
  for (const row of snap.rows ?? []) {
    const p = row.payload ?? {}
    const u = p.params?.update
    // agent_message_chunk carries speech; agent_thought_chunk carries reasoning. Both have
    // update.content.text, which is exactly how you accidentally read the thinking as the answer.
    if (u?.content?.type === 'text' && u.sessionUpdate !== 'agent_thought_chunk') said.push(u.content.text)
    if (p.result?.stopReason) stop = p.result.stopReason
  }
  return { text: said.join(''), stop, seq: snap.seq }
}

export async function say(sessionId, text) {
  return api('POST', `/sessions/${sessionId}/messages`, { text })
}

/** Send, then wait for the turn to end. Returns what the agent said during THIS turn. */
export async function ask(sessionId, text, { timeoutMs = 900000, pollMs = 4000 } = {}) {
  const before = await transcript(sessionId)
  await say(sessionId, text)
  const deadline = Date.now() + timeoutMs
  let last = before.text
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, pollMs))
    const t = await transcript(sessionId)
    if (t.seq > before.seq && t.stop && t.text.length >= last.length && t.text !== before.text) {
      // The turn has produced a stopReason and the text has grown: this turn is done.
      return { text: t.text.slice(before.text.length), stop: t.stop }
    }
    last = t.text
  }
  throw new Error('timed out waiting for the agent to finish its turn')
}

// --- CLI -----------------------------------------------------------------------------------------

if (import.meta.url === `file://${process.argv[1]}`) {
  const argv = process.argv.slice(2)
  const cmd = argv[0]
  const flag = (k, d) => { const i = argv.indexOf(`--${k}`); return i === -1 ? d : argv[i + 1] }
  const { readFileSync } = await import('node:fs')
  const textOf = () => (flag('file') ? readFileSync(flag('file'), 'utf8') : flag('text'))

  if (cmd === 'agents') {
    for (const d of await listDeployments()) {
      const m = d.policy?.llm?.default_model ?? '(unpinned — routes to the default provider)'
      console.log(`${d.id}  ${String(d.name).padEnd(16)} ${String(d.status).padEnd(9)} ${m}`)
    }
  } else if (cmd === 'new') {
    const d = await createAgent(flag('name', 'Agent'))
    console.log(`${d.id}  ${d.name}  ${d.policy.llm.default_model}`)
  } else if (cmd === 'ask' || cmd === 'say') {
    const dep = flag('dep')
    const ses = flag('session') ?? (dep ? await sessionFor(dep) : null)
    if (!ses) { console.error('pass --dep or --session'); process.exit(1) }
    const text = textOf()
    if (!text) { console.error('pass --text or --file'); process.exit(1) }
    if (cmd === 'say') { await say(ses, text); console.log('sent') }
    else { const r = await ask(ses, text); console.log(r.text.trim()); console.error(`[${r.stop}]`) }
  } else if (cmd === 'read') {
    const ses = flag('session') ?? await sessionFor(flag('dep'))
    const t = await transcript(ses)
    console.log(t.text.trim())
  } else {
    console.log('usage: zt.mjs agents | new --name N | ask --dep D --text T | say ... | read --dep D')
  }
}
