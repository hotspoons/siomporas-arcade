// The Agent Client Protocol, as this page needs it.
//
// LIFTED from patapsco-remote (src/core/acp/protocol.ts): the message shapes, the version
// negotiation and the one helper that reads a capability. It is all types and two functions, which
// is why it ports without argument — and why lifting it rather than writing it again matters: the
// protocol is somebody else's and a hand-made copy of it drifts silently, one field at a time,
// until a session update stops rendering and nothing says which field.
//
// Only the semicolons changed, for this repo's lint.
export const PROTOCOL_VERSION = 1
export const MAX_PROTOCOL_VERSION = 2
export type AcpVersion = 1 | 2
export function agentMethods(version: AcpVersion): { authenticate: string; reattach: string } {
  return version >= 2
    ? { authenticate: 'auth/login', reattach: 'session/resume' }
    : { authenticate: 'authenticate', reattach: 'session/load' }
}

export type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; mimeType: string; data: string; uri?: string }
  | { type: 'audio'; mimeType: string; data: string }
  | { type: 'resource_link'; uri: string; name?: string; mimeType?: string; title?: string }
  | { type: 'resource'; resource: { uri: string; mimeType?: string; text?: string; blob?: string } }
export interface ClientCapabilities {
  fs?: { readTextFile?: boolean; writeTextFile?: boolean }
  terminal?: boolean
}

export interface PromptCapabilities {
  image?: boolean
  audio?: boolean
  embeddedContext?: boolean
}

/** Spec: omitted or `null` means unsupported, `{}` means supported. Never a boolean. */
export type SessionCapability = Record<string, unknown> | boolean | null
export interface SessionCapabilities {
  list?: SessionCapability
  resume?: SessionCapability
  fork?: SessionCapability
}

export function offered(capability: unknown): boolean {
  return capability === true || (typeof capability === 'object' && capability !== null)
}

export interface AgentCapabilities {
  loadSession?: boolean
  sessionCapabilities?: SessionCapabilities
  promptCapabilities?: PromptCapabilities
  mcpCapabilities?: Record<string, unknown>
}

export interface AuthMethod {
  id: string
  name: string
  description?: string | null
}

export interface InitializeRequest {
  protocolVersion: number
  clientCapabilities?: ClientCapabilities
}

export interface InitializeResponse {
  protocolVersion: number
  agentCapabilities?: AgentCapabilities
  authMethods?: AuthMethod[]
  agentInfo?: { name?: string; version?: string }
  capabilities?: AgentCapabilities
  info?: { name?: string; version?: string }
}

export interface McpServerConfig {
  name: string
  command: string
  args?: string[]
  env?: Array<{ name: string; value: string }>
}

export interface NewSessionRequest {
  cwd: string
  mcpServers?: McpServerConfig[]
}

export interface NewSessionResponse {
  sessionId: string
  modes?: unknown
}

export interface LoadSessionRequest {
  sessionId: string
  cwd: string
  mcpServers?: McpServerConfig[]
}

export interface PromptRequest {
  sessionId: string
  prompt: ContentBlock[]
}

export type StopReason =
  | 'end_turn'
  | 'max_tokens'
  | 'max_turn_requests'
  | 'refusal'
  | 'cancelled'
export interface PromptResponse {
  stopReason: StopReason
}

export type ToolCallStatus = 'pending' | 'in_progress' | 'completed' | 'failed' | 'cancelled' | 'other'
export type ToolKind =
  | 'read' | 'edit' | 'delete' | 'move' | 'search'
  | 'execute' | 'think' | 'fetch' | 'other'
export type ToolCallContent =
  | { type: 'content'; content: ContentBlock }
  | { type: 'diff'; path: string; oldText?: string | null; newText: string }
  | { type: 'terminal'; terminalId: string }
export interface ToolCallLocation {
  path: string
  line?: number | null
}

export interface ToolCall {
  toolCallId: string
  title?: string
  kind?: ToolKind
  status?: ToolCallStatus
  content?: ToolCallContent[]
  locations?: ToolCallLocation[]
  rawInput?: unknown
  rawOutput?: unknown
}

export interface PlanEntry {
  content: string
  priority?: 'high' | 'medium' | 'low'
  status?: 'pending' | 'in_progress' | 'completed' | 'cancelled' | 'other'
}

export interface PlanUpdateContent {
  type?: string
  planId?: string
  entries?: PlanEntry[]
}

export interface AvailableCommand {
  name: string
  description?: string
  input?: { hint?: string } | null
}

export type SessionUpdate =
  | { sessionUpdate: 'user_message_chunk'; content: ContentBlock }
  | { sessionUpdate: 'agent_message_chunk'; content: ContentBlock }
  | { sessionUpdate: 'agent_thought_chunk'; content: ContentBlock }
  | ({ sessionUpdate: 'tool_call' } & ToolCall)
  | ({ sessionUpdate: 'tool_call_update' } & ToolCall)
  | { sessionUpdate: 'plan'; entries: PlanEntry[] }
  | { sessionUpdate: 'plan_update'; plan?: PlanUpdateContent }
  | { sessionUpdate: 'tool_call_content_chunk'; toolCallId: string; content: ToolCallContent }
  | { sessionUpdate: 'agent_message'; content?: ContentBlock }
  | { sessionUpdate: 'agent_thought'; content?: ContentBlock }
  | { sessionUpdate: 'available_commands_update'; availableCommands: AvailableCommand[] }
  | { sessionUpdate: string; [k: string]: unknown }
export interface SessionNotification {
  sessionId: string
  update: SessionUpdate
}

export interface PermissionOption {
  optionId: string
  name: string
  kind: 'allow_once' | 'allow_always' | 'reject_once' | 'reject_always' | string
}

export interface RequestPermissionRequest {
  sessionId: string
  toolCall: ToolCall
  options: PermissionOption[]
}

export type RequestPermissionOutcome =
  | { outcome: 'selected'; optionId: string }
  | { outcome: 'cancelled' }
export interface RequestPermissionResponse {
  outcome: RequestPermissionOutcome
}

export interface ReadTextFileRequest {
  sessionId: string
  path: string
  line?: number | null
  limit?: number | null
}

export interface WriteTextFileRequest {
  sessionId: string
  path: string
  content: string
}

export interface CreateTerminalRequest {
  sessionId: string
  command: string
  args?: string[]
  cwd?: string
  env?: Array<{ name: string; value: string }>
  outputByteLimit?: number | null
}

export interface RemoteSessionInfo {
  sessionId: string
  cwd?: string
  title?: string
  updatedAt?: string
}

export interface ListSessionsRequest {
  cwd?: string
  cursor?: string
}

export interface ListSessionsResponse {
  sessions?: RemoteSessionInfo[]
  nextCursor?: string | null
}

export const M = {
  initialize: 'initialize',
  newSession: 'session/new',
  listSessions: 'session/list',
  prompt: 'session/prompt',
  cancel: 'session/cancel',
  update: 'session/update',
  requestPermission: 'session/request_permission',
  readTextFile: 'fs/read_text_file',
  writeTextFile: 'fs/write_text_file',
  terminalCreate: 'terminal/create',
  terminalOutput: 'terminal/output',
  terminalWaitForExit: 'terminal/wait_for_exit',
  terminalKill: 'terminal/kill',
  terminalRelease: 'terminal/release',
} as const
export function blockText(block: ContentBlock | undefined): string {
  if (!block) return ''
  switch (block.type) {
    case 'text': return block.text || ''
    case 'resource_link': return block.title || block.name || block.uri || ''
    case 'resource': return block.resource?.text || block.resource?.uri || ''
    default: return ''
  }
}

/**
 * When a turn is already running, hermes acknowledges the next prompt with an
 * ordinary assistant message and `end_turn`, having run no model. There is no
 * structured signal, so matching the two known forms is all there is; a reworded
 * upstream renders as it does today rather than breaking anything.
 */
const BUSY_ACKS = [
  /^Redirected the active turn with your correction\.$/,
  /^Queued for the next turn\.(\s*\(\d+\s+queued\))?$/,
]
export function isAbandonedTurnEcho(content: string, stopReason: string): boolean {
  if (stopReason !== 'end_turn') return false
  const said = content.replace(/<think>[\s\S]*?<\/think>/g, '').trim()
  return BUSY_ACKS.some((re) => re.test(said))
}
