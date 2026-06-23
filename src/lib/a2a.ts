export type WireLogEntry = {
  id: string
  timestamp: string
  operation: string
  url: string
  requestHeaders: Record<string, string>
  responseHeaders: Record<string, string>
  requestBody: string
  responseBody: string
  statusCode: number
  statusText: string
}

export type AgentCardValidationIssue = {
  path: string
  severity: 'error' | 'warning'
  message: string
}

export type AgentCardValidationResult = {
  valid: boolean
  issues: AgentCardValidationIssue[]
}

export type AgentSettingRow = {
  section: string
  key: string
  value: string
}

export type ChatMessage = {
  id: string
  role: 'user' | 'agent'
  content: string
  timestamp: string
  isStreaming?: boolean
  isError?: boolean
}

export type StreamContentKind = 'working' | 'answer' | 'other'

export type StreamContentChunk = {
  text: string
  kind: StreamContentKind
  append: boolean
}

export type StreamChatSegment = {
  text: string
  kind: StreamContentKind
  append: boolean
}

// ---------------------------------------------------------------------------
// Chat text extraction helpers
// ---------------------------------------------------------------------------

function extractPartsText(parts: unknown): string {
  if (!Array.isArray(parts)) return ''
  return parts
    .map((p) => toRecord(p))
    .filter((p): p is Record<string, unknown> => p !== null)
    .map((p) => (typeof p.text === 'string' ? p.text : ''))
    .join('')
}

/**
 * Extract displayable text from any A2A non-streaming response payload.
 * Handles: direct Message, Task with status message, Task with artifacts.
 */
export function extractChatText(payload: unknown): string {
  const record = toRecord(payload)
  if (!record) return ''

  // Direct message response: { message: { parts: [...] } }
  if (record.message) {
    const text = extractPartsText(toRecord(record.message)?.parts)
    if (text) return text
  }

  // Unwrap task from { task: {...} } or accept a bare Task object
  const task =
    toRecord(record.task) ??
    (typeof record.id === 'string' && record.status ? record : null)

  if (task) {
    const parts: string[] = []

    // Status message
    const statusMsg = toRecord(toRecord(task.status as unknown)?.message as unknown)
    if (statusMsg) {
      const t = extractPartsText(statusMsg.parts)
      if (t) parts.push(t)
    }

    // Artifacts
    if (Array.isArray(task.artifacts)) {
      for (const artifact of task.artifacts) {
        const t = extractPartsText(toRecord(artifact)?.parts)
        if (t) parts.push(t)
      }
    }

    if (parts.length > 0) return parts.join('\n\n')
  }

  return ''
}

/**
 * Extract a text chunk from a single SSE streaming event.
 * Returns the text and whether it should be appended to the current
 * streaming bubble (true) or treated as a new block (false).
 */
export function extractStreamChunk(event: unknown): { text: string; append: boolean } {
  const record = toRecord(event)
  if (!record) return { text: '', append: false }

  // Artifact update: the main content carrier during streaming
  if (record.artifactUpdate) {
    const update = toRecord(record.artifactUpdate)
    if (update) {
      const artifact = toRecord(update.artifact)
      const text = extractPartsText(artifact?.parts)
      return { text, append: update.append === true }
    }
  }

  // Status update with an agent message (progress / thinking)
  if (record.statusUpdate) {
    const update = toRecord(record.statusUpdate)
    const status = toRecord(update?.status as unknown)
    const msg = toRecord(status?.message as unknown)
    const text = extractPartsText(msg?.parts)
    return { text, append: false }
  }

  // Direct message in stream (message-only stream pattern)
  if (record.message) {
    const msg = toRecord(record.message)
    const text = extractPartsText(msg?.parts)
    return { text, append: false }
  }

  return { text: '', append: false }
}

/**
 * Classify stream payloads so the UI can keep working/progress text before the
 * final answer artifact, even if the transport delivers events out of order.
 */
export function extractStreamContentChunk(event: unknown): StreamContentChunk {
  const record = toRecord(event)
  if (!record) return { text: '', kind: 'other', append: false }

  if (record.statusUpdate) {
    const update = toRecord(record.statusUpdate)
    const status = toRecord(update?.status as unknown)
    const text = extractPartsText(toRecord(status?.message as unknown)?.parts)
    return { text, kind: 'working', append: false }
  }

  if (record.artifactUpdate) {
    const update = toRecord(record.artifactUpdate)
    const artifact = toRecord(update?.artifact as unknown)
    const text = extractPartsText(artifact?.parts)
    const artifactName = typeof artifact?.name === 'string' ? artifact.name : ''
    return {
      text,
      kind: artifactName.toLowerCase() === 'answer' ? 'answer' : 'other',
      append: update?.append === true,
    }
  }

  const fallback = extractStreamChunk(event)
  return { text: fallback.text, kind: 'other', append: fallback.append }
}

export function extractOrderedChatSegments(payload: unknown): StreamChatSegment[] {
  const record = toRecord(payload)
  if (!record) return []

  const segments: StreamChatSegment[] = []

  const addSegment = (text: string, kind: StreamContentKind, append = false) => {
    if (text.trim().length === 0) {
      return
    }
    segments.push({ text, kind, append })
  }

  const task = toRecord(record.task) ?? (typeof record.id === 'string' && record.status ? record : null)
  if (task) {
    const status = toRecord(task.status)
    const statusMessage = extractPartsText(toRecord(status?.message as unknown)?.parts)
    if (statusMessage) {
      addSegment(statusMessage, 'working', false)
    }

    if (Array.isArray(task.artifacts)) {
      for (const artifactEntry of task.artifacts) {
        const artifact = toRecord(artifactEntry)
        const artifactName = typeof artifact?.name === 'string' ? artifact.name : ''
        const artifactText = extractPartsText(artifact?.parts)
        if (artifactText) {
          addSegment(artifactText, artifactName.toLowerCase() === 'answer' ? 'answer' : 'other', false)
        }
      }
    }

    return segments
  }

  if (record.statusUpdate || record.artifactUpdate || record.message) {
    const chunk = extractStreamContentChunk(payload)
    if (chunk.text.trim().length > 0) {
      segments.push(chunk)
    }
  }

  return segments
}

type A2AClientConfig = {
  serviceUrl: string
  bearerToken?: string
  getAccessToken?: () => string | undefined
  onWireLog?: (entry: WireLogEntry) => void
}

type JsonRpcEnvelope = {
  jsonrpc: '2.0'
  id: string | number
  method: string
  params?: Record<string, unknown>
}

function toRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null
  }

  return value as Record<string, unknown>
}

function newId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID()
  }

  return `${Date.now()}-${Math.floor(Math.random() * 10_000)}`
}

function normalizeBaseUrl(url: string): string {
  return url.endsWith('/') ? url.slice(0, -1) : url
}

/**
 * In development the Vite dev server runs a transparent proxy at
 * `/__a2a_proxy__/<encoded-url>`.  Routing outgoing requests through it
 * avoids CORS failures because the browser sees all traffic going to
 * localhost.  In production builds import.meta.env.DEV is false so the
 * original URL is returned unchanged.
 */
function resolveViaProxy(url: string): string {
  if (import.meta.env.DEV) {
    return `/__a2a_proxy__/${encodeURIComponent(url)}`
  }
  return url
}

function mapHeaders(headers: Headers): Record<string, string> {
  const mapped: Record<string, string> = {}
  headers.forEach((value, key) => {
    if (key.toLowerCase() === 'authorization') {
      // Redact the token: keep only the scheme word plus the first 20 chars
      // of the credential to avoid leaking secrets in the wire inspector.
      const spaceIndex = value.indexOf(' ')
      if (spaceIndex !== -1) {
        const scheme = value.slice(0, spaceIndex)
        const credential = value.slice(spaceIndex + 1)
        mapped[key] = `${scheme} ${credential.slice(0, 20)}…`
      } else {
        mapped[key] = `${value.slice(0, 20)}…`
      }
    } else {
      mapped[key] = value
    }
  })
  return mapped
}

function pushWireLog(
  onWireLog: ((entry: WireLogEntry) => void) | undefined,
  entry: Omit<WireLogEntry, 'id' | 'timestamp'>,
): void {
  if (!onWireLog) {
    return
  }

  onWireLog({
    ...entry,
    id: newId(),
    timestamp: new Date().toISOString(),
  })
}

export class A2AClient {
  private readonly serviceUrl: string
  private readonly bearerToken: string
  private readonly getAccessToken?: () => string | undefined
  private readonly onWireLog?: (entry: WireLogEntry) => void

  constructor(config: A2AClientConfig) {
    this.serviceUrl = normalizeBaseUrl(config.serviceUrl.trim())
    this.bearerToken = config.bearerToken?.trim() ?? ''
    this.getAccessToken = config.getAccessToken
    this.onWireLog = config.onWireLog
  }

  private resolveAccessToken(): string {
    const tokenFromProvider = this.getAccessToken?.()?.trim() ?? ''
    if (tokenFromProvider.length > 0) {
      return tokenFromProvider
    }

    return this.bearerToken
  }

  async fetchAgentCard(cardUrl: string): Promise<unknown> {
    const url = cardUrl.trim()

    // Use only CORS-safe headers for the agent card GET so that the browser
    // does not send a preflight OPTIONS request. The A2A-Version custom header
    // is intentionally omitted here; it is only sent for JSON-RPC calls.
    // Authorization is included only when a token was configured, since some
    // agents protect their extended card behind auth and it is a standard header
    // that CORS-enabled servers generally allow.
    const headers = new Headers()
    headers.set('Accept', 'application/json, application/a2a+json')
    const accessToken = this.resolveAccessToken()
    if (accessToken.length > 0) {
      headers.set('Authorization', `Bearer ${accessToken}`)
    }

    let response: Response
    try {
      response = await fetch(resolveViaProxy(url), { method: 'GET', headers })
    } catch (networkError) {
      // A thrown error here almost always means a CORS block or a network
      // connectivity failure. Neither produces an HTTP status in the browser.
      const detail = networkError instanceof Error ? networkError.message : String(networkError)
      pushWireLog(this.onWireLog, {
        operation: 'GetAgentCardDocument',
        url,
        requestHeaders: mapHeaders(headers),
        responseHeaders: {},
        requestBody: '',
        responseBody: detail,
        statusCode: 0,
        statusText: 'Network Error',
      })
      throw new Error(
        `Unable to reach the agent card URL. This is usually a CORS or network error. ` +
          `Check that the server allows cross-origin requests and that the URL is reachable. ` +
          `Browser detail: ${detail}`,
      )
    }

    const bodyText = await response.text()
    pushWireLog(this.onWireLog, {
      operation: 'GetAgentCardDocument',
      url,
      requestHeaders: mapHeaders(headers),
      responseHeaders: mapHeaders(response.headers),
      requestBody: '',
      responseBody: bodyText,
      statusCode: response.status,
      statusText: response.statusText,
    })

    if (!response.ok) {
      throw new Error(`Failed to fetch agent card: HTTP ${response.status} ${response.statusText}`)
    }

    try {
      return JSON.parse(bodyText)
    } catch {
      throw new Error('Agent card response is not valid JSON.')
    }
  }

  async jsonRpc(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
    const endpoint = this.serviceUrl
    const payload: JsonRpcEnvelope = {
      jsonrpc: '2.0',
      id: newId(),
      method,
      params,
    }

    const requestBody = JSON.stringify(payload)
    const headers = this.makeHeaders({
      accept: 'application/json, application/a2a+json',
      contentType: 'application/json',
    })

    const response = await fetch(resolveViaProxy(endpoint), {
      method: 'POST',
      headers,
      body: requestBody,
    })

    const bodyText = await response.text()
    pushWireLog(this.onWireLog, {
      operation: method,
      url: endpoint,
      requestHeaders: mapHeaders(headers),
      responseHeaders: mapHeaders(response.headers),
      requestBody,
      responseBody: bodyText,
      statusCode: response.status,
      statusText: response.statusText,
    })

    if (!response.ok) {
      throw new Error(`RPC ${method} failed: HTTP ${response.status} ${response.statusText}`)
    }

    const parsed = safeJsonParse(bodyText)
    const envelope = toRecord(parsed)
    if (envelope && envelope.error) {
      const errorRecord = toRecord(envelope.error)
      const message = errorRecord && typeof errorRecord.message === 'string' ? errorRecord.message : 'Unknown JSON-RPC error'
      throw new Error(`RPC ${method} returned error: ${message}`)
    }

    if (envelope && envelope.result !== undefined) {
      return envelope.result
    }

    return parsed
  }

  async streamJsonRpc(
    method: string,
    params: Record<string, unknown>,
    onEvent: (eventPayload: unknown) => void,
    options?: { signal?: AbortSignal },
  ): Promise<void> {
    const endpoint = this.serviceUrl
    const payload: JsonRpcEnvelope = {
      jsonrpc: '2.0',
      id: newId(),
      method,
      params,
    }

    const requestBody = JSON.stringify(payload)
    const headers = this.makeHeaders({
      accept: 'text/event-stream',
      contentType: 'application/json',
    })

    const response = await fetch(resolveViaProxy(endpoint), {
      method: 'POST',
      headers,
      body: requestBody,
      signal: options?.signal,
    })

    if (!response.ok) {
      const errorBody = await response.text()
      pushWireLog(this.onWireLog, {
        operation: `${method} (stream)`,
        url: endpoint,
        requestHeaders: mapHeaders(headers),
        responseHeaders: mapHeaders(response.headers),
        requestBody,
        responseBody: errorBody,
        statusCode: response.status,
        statusText: response.statusText,
      })
      throw new Error(`Streaming RPC ${method} failed: HTTP ${response.status} ${response.statusText}`)
    }

    if (!response.body) {
      throw new Error('Streaming response body is empty.')
    }

    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    let fullResponseBody = ''

    while (true) {
      const chunk = await reader.read()
      if (chunk.done) {
        break
      }

      const decoded = decoder.decode(chunk.value, { stream: true })
      fullResponseBody += decoded
      buffer += decoded

      const events = buffer.split('\n\n')
      buffer = events.pop() ?? ''

      for (const rawEvent of events) {
        const payloadText = extractSseData(rawEvent)
        if (!payloadText) {
          continue
        }

        const parsed = safeJsonParse(payloadText)
        const envelope = toRecord(parsed)

        if (envelope && envelope.result !== undefined) {
          onEvent(envelope.result)
        } else {
          onEvent(parsed)
        }
      }
    }

    if (buffer.trim().length > 0) {
      const lastPayload = extractSseData(buffer)
      if (lastPayload) {
        const parsed = safeJsonParse(lastPayload)
        const envelope = toRecord(parsed)
        if (envelope && envelope.result !== undefined) {
          onEvent(envelope.result)
        } else {
          onEvent(parsed)
        }
      }
    }

    pushWireLog(this.onWireLog, {
      operation: `${method} (stream)`,
      url: endpoint,
      requestHeaders: mapHeaders(headers),
      responseHeaders: mapHeaders(response.headers),
      requestBody,
      responseBody: fullResponseBody,
      statusCode: response.status,
      statusText: response.statusText,
    })
  }

  private makeHeaders(options: {
    accept?: string
    contentType?: string
  }): Headers {
    const headers = new Headers()
    headers.set('A2A-Version', '1.0')
    headers.set('Accept', options.accept ?? 'application/json')

    if (options.contentType) {
      headers.set('Content-Type', options.contentType)
    }

    const accessToken = this.resolveAccessToken()
    if (accessToken.length > 0) {
      headers.set('Authorization', `Bearer ${accessToken}`)
    }

    return headers
  }
}

function extractSseData(rawEvent: string): string {
  const lines = rawEvent.split('\n')
  const dataLines: string[] = []

  for (const line of lines) {
    const trimmed = line.trimEnd()
    if (trimmed.startsWith('data:')) {
      dataLines.push(trimmed.slice(5).trimStart())
    }
  }

  return dataLines.join('\n').trim()
}

function safeJsonParse(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}

export function validateAgentCard(agentCard: Record<string, unknown>): AgentCardValidationResult {
  const issues: AgentCardValidationIssue[] = []

  const requiredStrings = [
    { key: 'name', label: 'name' },
    { key: 'url', label: 'url' },
    { key: 'version', label: 'version' },
  ]

  for (const field of requiredStrings) {
    const value = agentCard[field.key]
    if (typeof value !== 'string' || value.trim().length === 0) {
      issues.push({
        path: field.label,
        severity: 'error',
        message: 'Required string field is missing or empty.',
      })
    }
  }

  const capabilities = toRecord(agentCard.capabilities)
  if (!capabilities) {
    issues.push({
      path: 'capabilities',
      severity: 'warning',
      message: 'Capabilities object is missing; some client features may not be discoverable.',
    })
  }

  const skills = agentCard.skills
  if (!Array.isArray(skills)) {
    issues.push({
      path: 'skills',
      severity: 'warning',
      message: 'Skills array is missing.',
    })
  }

  const auth = toRecord(agentCard.authentication ?? agentCard.auth)
  if (!auth) {
    issues.push({
      path: 'authentication',
      severity: 'warning',
      message: 'Authentication metadata is missing; token requirements may be unknown.',
    })
  }

  return {
    valid: issues.every((issue) => issue.severity !== 'error'),
    issues,
  }
}

export function collectSettingsEntries(agentCard: Record<string, unknown>): AgentSettingRow[] {
  const rows: AgentSettingRow[] = []

  const addRow = (section: string, key: string, value: unknown) => {
    if (value === undefined) {
      return
    }

    rows.push({
      section,
      key,
      value: stringifyCompact(value),
    })
  }

  for (const [key, value] of Object.entries(agentCard)) {
    if (key === 'capabilities' || key === 'authentication' || key === 'security' || key === 'skills') {
      continue
    }

    addRow('Core', key, value)
  }

  const capabilities = toRecord(agentCard.capabilities)
  if (capabilities) {
    for (const [key, value] of Object.entries(capabilities)) {
      addRow('Capabilities', key, value)
    }
  }

  const authentication = toRecord(agentCard.authentication ?? agentCard.auth)
  if (authentication) {
    for (const [key, value] of Object.entries(authentication)) {
      addRow('Authentication', key, value)
    }
  }

  if (Array.isArray(agentCard.skills)) {
    agentCard.skills.forEach((skill, index) => {
      const skillRecord = toRecord(skill)
      if (!skillRecord) {
        addRow('Skills', `skills[${index}]`, skill)
        return
      }

      for (const [key, value] of Object.entries(skillRecord)) {
        addRow(`Skills #${index + 1}`, key, value)
      }
    })
  }

  return rows
}

function stringifyCompact(value: unknown): string {
  if (typeof value === 'string') {
    return value
  }

  if (typeof value === 'number' || typeof value === 'boolean' || value === null) {
    return String(value)
  }

  if (Array.isArray(value)) {
    return value.length === 0 ? '[]' : JSON.stringify(value)
  }

  if (typeof value === 'object') {
    return JSON.stringify(value)
  }

  return '-'
}

export function extractTaskFromPayload(payload: unknown): Record<string, unknown> | null {
  const payloadRecord = toRecord(payload)
  if (!payloadRecord) {
    return null
  }

  const task = toRecord(payloadRecord.task)
  if (task) {
    return task
  }

  if (typeof payloadRecord.id === 'string' && payloadRecord.status) {
    return payloadRecord
  }

  return null
}

export function extractTasksFromListPayload(payload: unknown): Record<string, unknown>[] {
  const payloadRecord = toRecord(payload)
  if (!payloadRecord) {
    return []
  }

  const tasks = payloadRecord.tasks
  if (!Array.isArray(tasks)) {
    return []
  }

  return tasks
    .map((item) => toRecord(item))
    .filter((item): item is Record<string, unknown> => item !== null)
}
