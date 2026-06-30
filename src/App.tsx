import { useEffect, useMemo, useRef, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import './App.css'
import {
  type AgentCardValidationResult,
  A2AClient,
  type ChatMessage,
  type WireLogEntry,
  collectSettingsEntries,
  extractChatText,
  extractOrderedChatSegments,
  extractStreamChunk,
  extractTaskFromPayload,
  extractTasksFromListPayload,
  validateAgentCard,
} from './lib/a2a'

type ThemeMode = 'light' | 'dark'
type AgentTab = 'summary' | 'raw' | 'settings'
type AuthMode = 'anonymous' | 'bearer' | 'oauth'

type RpcOperation = {
  method: string
  label: string
  streaming?: boolean
  sampleParams: Record<string, unknown>
}

type StreamResponseEntry = {
  id: string
  timestamp: string
  source: string
  text: string
  raw: string
}

type OAuthFormState = {
  tenantId: string
  clientId: string
  clientSecret: string
  redirectUri: string
  scopes: string
}

type PersistedConnectionSettings = {
  agentCardUrl: string
  authMode: AuthMode
  bearerToken: string
  oauthForm: OAuthFormState
  oauthAccessToken: string
  oauthTokenExpiresAt: string
}

const CONNECTION_SETTINGS_STORAGE_KEY = 'a2a-consumer.connection-settings.v1'

function createDefaultOAuthForm(): OAuthFormState {
  return {
    tenantId: '',
    clientId: '',
    clientSecret: '',
    redirectUri: `${window.location.origin}${window.location.pathname}`,
    scopes: 'openid profile offline_access',
  }
}

function createDefaultPersistedSettings(): PersistedConnectionSettings {
  return {
    agentCardUrl: '',
    authMode: 'anonymous',
    bearerToken: '',
    oauthForm: createDefaultOAuthForm(),
    oauthAccessToken: '',
    oauthTokenExpiresAt: '',
  }
}

function sanitizePersistedSettings(payload: unknown): PersistedConnectionSettings {
  const defaults = createDefaultPersistedSettings()
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return defaults
  }

  const record = payload as Record<string, unknown>
  const authModeValue = record.authMode
  const authMode: AuthMode =
    authModeValue === 'anonymous' || authModeValue === 'bearer' || authModeValue === 'oauth'
      ? authModeValue
      : defaults.authMode

  const oauthFormValue = record.oauthForm
  const oauthFormRecord =
    oauthFormValue && typeof oauthFormValue === 'object' && !Array.isArray(oauthFormValue)
      ? (oauthFormValue as Record<string, unknown>)
      : {}

  return {
    agentCardUrl: typeof record.agentCardUrl === 'string' ? record.agentCardUrl : defaults.agentCardUrl,
    authMode,
    bearerToken: typeof record.bearerToken === 'string' ? record.bearerToken : defaults.bearerToken,
    oauthForm: {
      tenantId:
        typeof oauthFormRecord.tenantId === 'string' ? oauthFormRecord.tenantId : defaults.oauthForm.tenantId,
      clientId:
        typeof oauthFormRecord.clientId === 'string' ? oauthFormRecord.clientId : defaults.oauthForm.clientId,
      clientSecret:
        typeof oauthFormRecord.clientSecret === 'string'
          ? oauthFormRecord.clientSecret
          : defaults.oauthForm.clientSecret,
      redirectUri:
        typeof oauthFormRecord.redirectUri === 'string'
          ? oauthFormRecord.redirectUri
          : defaults.oauthForm.redirectUri,
      scopes: typeof oauthFormRecord.scopes === 'string' ? oauthFormRecord.scopes : defaults.oauthForm.scopes,
    },
    oauthAccessToken:
      typeof record.oauthAccessToken === 'string' ? record.oauthAccessToken : defaults.oauthAccessToken,
    oauthTokenExpiresAt:
      typeof record.oauthTokenExpiresAt === 'string'
        ? record.oauthTokenExpiresAt
        : defaults.oauthTokenExpiresAt,
  }
}

function loadPersistedSettings(): PersistedConnectionSettings {
  try {
    const raw = window.localStorage.getItem(CONNECTION_SETTINGS_STORAGE_KEY)
    if (!raw) {
      return createDefaultPersistedSettings()
    }

    const parsed = JSON.parse(raw) as unknown
    return sanitizePersistedSettings(parsed)
  } catch {
    return createDefaultPersistedSettings()
  }
}

const OPERATIONS: RpcOperation[] = [
  {
    method: 'SendMessage',
    label: 'Send Message',
    sampleParams: {
      message: {
        role: 'ROLE_USER',
        parts: [{ text: 'Hello from A2A client' }],
        messageId: 'replace-with-message-id',
      },
      configuration: {
        returnImmediately: true,
      },
    },
  },
  {
    method: 'SendStreamingMessage',
    label: 'Send Streaming Message',
    streaming: true,
    sampleParams: {
      message: {
        role: 'ROLE_USER',
        parts: [{ text: 'Generate a long answer and stream progress' }],
        messageId: 'replace-with-message-id',
      },
    },
  },
  {
    method: 'GetTask',
    label: 'Get Task',
    sampleParams: { id: 'replace-with-task-id', historyLength: 20 },
  },
  {
    method: 'ListTasks',
    label: 'List Tasks',
    sampleParams: { pageSize: 20 },
  },
  {
    method: 'CancelTask',
    label: 'Cancel Task',
    sampleParams: { id: 'replace-with-task-id' },
  },
  {
    method: 'SubscribeToTask',
    label: 'Subscribe To Task',
    streaming: true,
    sampleParams: { id: 'replace-with-task-id' },
  },
  {
    method: 'CreateTaskPushNotificationConfig',
    label: 'Create Push Notification Config',
    sampleParams: {
      taskId: 'replace-with-task-id',
      pushNotificationConfig: {
        url: 'https://example.com/webhook',
      },
    },
  },
  {
    method: 'GetTaskPushNotificationConfig',
    label: 'Get Push Notification Config',
    sampleParams: {
      taskId: 'replace-with-task-id',
      pushNotificationConfigId: 'replace-with-config-id',
    },
  },
  {
    method: 'ListTaskPushNotificationConfigs',
    label: 'List Push Notification Configs',
    sampleParams: { taskId: 'replace-with-task-id' },
  },
  {
    method: 'DeleteTaskPushNotificationConfig',
    label: 'Delete Push Notification Config',
    sampleParams: {
      taskId: 'replace-with-task-id',
      pushNotificationConfigId: 'replace-with-config-id',
    },
  },
  {
    method: 'GetExtendedAgentCard',
    label: 'Get Extended Agent Card',
    sampleParams: {},
  },
]

function createMessageId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID()
  }

  return `${Date.now()}-${Math.floor(Math.random() * 10_000)}`
}

function toPrettyJson(value: unknown): string {
  return JSON.stringify(value, null, 2)
}

function createOAuthStateValue(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
}

function splitScopes(scopesInput: string): string[] {
  return scopesInput
    .split(/[\s,]+/)
    .map((scope) => scope.trim())
    .filter((scope) => scope.length > 0)
}

function base64UrlEncode(input: Uint8Array): string {
  const binary = Array.from(input)
    .map((byte) => String.fromCharCode(byte))
    .join('')

  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '')
}

function createPkceVerifier(): string {
  const bytes = new Uint8Array(32)
  crypto.getRandomValues(bytes)
  return base64UrlEncode(bytes)
}

async function createPkceChallenge(verifier: string): Promise<string> {
  const encoded = new TextEncoder().encode(verifier)
  const digest = await crypto.subtle.digest('SHA-256', encoded)
  return base64UrlEncode(new Uint8Array(digest))
}

function formatAuthModeLabel(mode: AuthMode): string {
  if (mode === 'anonymous') {
    return 'Anonymous'
  }
  if (mode === 'bearer') {
    return 'Bearer Token'
  }
  return 'OAuth Flow'
}

function isLikelyValidUrl(value: string): boolean {
  try {
    const parsed = new URL(value)
    return parsed.protocol === 'http:' || parsed.protocol === 'https:'
  } catch {
    return false
  }
}

function resolveAgentEndpoint(agentCard: Record<string, unknown>, cardUrl: string): string {
  const directUrl = agentCard.url
  if (typeof directUrl === 'string' && directUrl.trim().length > 0) {
    return directUrl
  }

  const endpoint = agentCard.endpoint
  if (typeof endpoint === 'string' && endpoint.trim().length > 0) {
    return endpoint
  }

  try {
    return new URL(cardUrl).origin
  } catch {
    return cardUrl
  }
}

function upsertTask(
  current: Record<string, Record<string, unknown>>,
  incomingTask: Record<string, unknown>,
): Record<string, Record<string, unknown>> {
  const idValue = incomingTask.id
  if (typeof idValue !== 'string' || idValue.length === 0) {
    return current
  }

  return {
    ...current,
    [idValue]: {
      ...(current[idValue] ?? {}),
      ...incomingTask,
    },
  }
}

function toRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null
  }

  return value as Record<string, unknown>
}

function extractTaskIdFromStreamEvent(payload: unknown): string | undefined {
  const task = extractTaskFromPayload(payload)
  if (task && typeof task.id === 'string' && task.id.length > 0) {
    return task.id
  }

  const record = toRecord(payload)
  if (!record) {
    return undefined
  }

  const statusUpdate = toRecord(record.statusUpdate)
  if (statusUpdate && typeof statusUpdate.taskId === 'string' && statusUpdate.taskId.length > 0) {
    return statusUpdate.taskId
  }

  const artifactUpdate = toRecord(record.artifactUpdate)
  if (artifactUpdate && typeof artifactUpdate.taskId === 'string' && artifactUpdate.taskId.length > 0) {
    return artifactUpdate.taskId
  }

  return undefined
}

function formatStreamResponseText(payload: unknown): string {
  const chunk = extractStreamChunk(payload)
  if (chunk.text.trim().length > 0) {
    return chunk.text
  }

  const record = toRecord(payload)
  if (!record) {
    return toPrettyJson(payload)
  }

  const statusUpdate = toRecord(record.statusUpdate)
  if (statusUpdate) {
    const status = toRecord(statusUpdate.status)
    const statusState = typeof status?.state === 'string' ? status.state : ''
    const statusMessage = extractChatText(status?.message)

    if (statusState === 'TASK_STATE_WORKING' && statusMessage.trim().length === 0) {
      return ''
    }

    if (statusState.length > 0) {
      return `Status update: ${statusState}`
    }
    return 'Status update received.'
  }

  const artifactUpdate = toRecord(record.artifactUpdate)
  if (artifactUpdate) {
    return 'Artifact update received.'
  }

  return toPrettyJson(payload)
}

function App() {
  const initialSettings = useMemo(() => loadPersistedSettings(), [])
  const clientRef = useRef<A2AClient | null>(null)
  const subscriptionsRef = useRef<Record<string, AbortController>>({})
  const mutedResponseTaskIdsRef = useRef<Set<string>>(new Set())
  const activeAccessTokenRef = useRef('')
  const [theme, setTheme] = useState<ThemeMode>('light')
  const [agentCardUrl, setAgentCardUrl] = useState(initialSettings.agentCardUrl)
  const [authMode, setAuthMode] = useState<AuthMode>(initialSettings.authMode)
  const [bearerToken, setBearerToken] = useState(initialSettings.bearerToken)
  const [oauthForm, setOauthForm] = useState<OAuthFormState>(initialSettings.oauthForm)
  const [oauthAccessToken, setOauthAccessToken] = useState(initialSettings.oauthAccessToken)
  const [oauthTokenExpiresAt, setOauthTokenExpiresAt] = useState(initialSettings.oauthTokenExpiresAt)
  const [showOauthAccessToken, setShowOauthAccessToken] = useState(false)
  const [isAuthorizing, setIsAuthorizing] = useState(false)
  const [serviceUrl, setServiceUrl] = useState('')
  const [isConnecting, setIsConnecting] = useState(false)
  const [isConnected, setIsConnected] = useState(false)
  const [connectionError, setConnectionError] = useState('')

  const [agentCard, setAgentCard] = useState<Record<string, unknown> | null>(null)
  const [validation, setValidation] = useState<AgentCardValidationResult | null>(null)
  const [agentTab, setAgentTab] = useState<AgentTab>('summary')

  const [quickMessage, setQuickMessage] = useState('')
  const [quickStreaming, setQuickStreaming] = useState(true)
  const [selectedMethod, setSelectedMethod] = useState(OPERATIONS[0].method)
  const [operationParamsText, setOperationParamsText] = useState(
    toPrettyJson(OPERATIONS[0].sampleParams),
  )
  const [lastResponse, setLastResponse] = useState('')
  const [statusMessage, setStatusMessage] = useState('Ready')
  const [busy, setBusy] = useState(false)

  const [tasks, setTasks] = useState<Record<string, Record<string, unknown>>>({})
  const [streamResponseEntries, setStreamResponseEntries] = useState<StreamResponseEntry[]>([])
  const [wireLogs, setWireLogs] = useState<WireLogEntry[]>([])
  const [showWireInspector, setShowWireInspector] = useState(false)
  const [subscribedTaskIds, setSubscribedTaskIds] = useState<string[]>([])
  const [mutedResponseTaskIds, setMutedResponseTaskIds] = useState<string[]>([])
  const [showResponsesPanel, setShowResponsesPanel] = useState(false)
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([])
  const chatMessagesContainerRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const container = chatMessagesContainerRef.current
    if (!container) {
      return
    }

    // Keep autoscroll scoped to the chat panel to avoid page-level jumps.
    container.scrollTo({ top: container.scrollHeight, behavior: 'smooth' })
  }, [chatMessages])

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme)
  }, [theme])

  const activeAccessToken = useMemo(() => {
    if (authMode === 'anonymous') {
      return ''
    }

    if (authMode === 'bearer') {
      return bearerToken.trim()
    }

    return oauthAccessToken.trim()
  }, [authMode, bearerToken, oauthAccessToken])

  const oauthValidationErrors = useMemo(() => {
    const errors: string[] = []
    if (oauthForm.tenantId.trim().length === 0) {
      errors.push('Tenant Id is required.')
    }
    if (oauthForm.clientId.trim().length === 0) {
      errors.push('Client Id is required.')
    }
    if (oauthForm.redirectUri.trim().length === 0) {
      errors.push('Redirect URI is required.')
    } else if (!isLikelyValidUrl(oauthForm.redirectUri.trim())) {
      errors.push('Redirect URI must be a valid http/https URL.')
    }
    if (splitScopes(oauthForm.scopes).length === 0) {
      errors.push('At least one scope is required.')
    }
    return errors
  }, [oauthForm])

  const canAuthorizeOAuth = oauthValidationErrors.length === 0

  useEffect(() => {
    activeAccessTokenRef.current = activeAccessToken
  }, [activeAccessToken])

  useEffect(() => {
    const payload: PersistedConnectionSettings = {
      agentCardUrl,
      authMode,
      bearerToken,
      oauthForm,
      oauthAccessToken,
      oauthTokenExpiresAt,
    }

    window.localStorage.setItem(CONNECTION_SETTINGS_STORAGE_KEY, JSON.stringify(payload))
  }, [agentCardUrl, authMode, bearerToken, oauthForm, oauthAccessToken, oauthTokenExpiresAt])

  const selectedOperation = useMemo(
    () => OPERATIONS.find((op) => op.method === selectedMethod) ?? OPERATIONS[0],
    [selectedMethod],
  )

  const taskList = useMemo(() => Object.values(tasks), [tasks])
  const settingRows = useMemo(() => (agentCard ? collectSettingsEntries(agentCard) : []), [agentCard])

  const handleWireLog = (entry: WireLogEntry) => {
    setWireLogs((current) => [entry, ...current].slice(0, 60))
  }

  const updateAgentStreamingMessage = (
    messageId: string,
    content: string,
    options: { replace?: boolean; append?: boolean } = {},
  ) => {
    const { replace = false, append = false } = options

    setChatMessages((current) => {
      const next = [...current]
      const existingIndex = next.findIndex((message) => message.id === messageId)

      if (existingIndex === -1) {
        next.push({
          id: messageId,
          role: 'agent',
          content,
          timestamp: new Date().toISOString(),
          isStreaming: true,
        })
        return next
      }

      const existing = next[existingIndex]
      next[existingIndex] = {
        ...existing,
        content: replace ? content : append ? `${existing.content}${content}` : content,
      }
      return next
    })
  }

  const ingestPayload = (payload: unknown) => {
    const directTask = extractTaskFromPayload(payload)
    if (directTask) {
      setTasks((current) => upsertTask(current, directTask))
    }

    const listTasks = extractTasksFromListPayload(payload)
    if (listTasks.length > 0) {
      setTasks((current) => {
        let next = current
        for (const listedTask of listTasks) {
          next = upsertTask(next, listedTask)
        }
        return next
      })
    }
  }

  const addStreamResponseEntry = (payload: unknown, source: string) => {
    const now = new Date().toISOString()
    const text = formatStreamResponseText(payload)
    if (text.trim().length === 0) {
      return
    }
    const raw = toPrettyJson(payload)
    const nextEntry: StreamResponseEntry = {
      id: createMessageId(),
      timestamp: now,
      source,
      text,
      raw,
    }

    // Keep stream events in chronological order so setup/progress messages are
    // shown before final responses.
    setStreamResponseEntries((current) => [...current, nextEntry].slice(-120))
  }

  const stopTaskSubscription = (taskId: string) => {
    if (!subscribedTaskIds.includes(taskId)) {
      return
    }

    mutedResponseTaskIdsRef.current.add(taskId)
    setMutedResponseTaskIds((current) => (current.includes(taskId) ? current : [...current, taskId]))
    setStatusMessage(`Unsubscribed from realtime Responses events for task ${taskId}. Chat updates remain enabled.`)
  }

  const startTaskSubscription = async (taskId: string) => {
    if (!clientRef.current) {
      return
    }
    if (subscriptionsRef.current[taskId]) {
      return
    }

    const controller = new AbortController()
    subscriptionsRef.current[taskId] = controller
    setSubscribedTaskIds((current) => (current.includes(taskId) ? current : [...current, taskId]))

    try {
      await clientRef.current.streamJsonRpc(
        'SubscribeToTask',
        { id: taskId },
        (event) => {
          ingestPayload(event)
          if (!mutedResponseTaskIdsRef.current.has(taskId)) {
            addStreamResponseEntry(event, `SubscribeToTask(${taskId})`)
          }
        },
        { signal: controller.signal },
      )
    } catch (error) {
      if (!(error instanceof DOMException && error.name === 'AbortError')) {
        const message = error instanceof Error ? error.message : 'Subscription stream failed.'
        setConnectionError(message)
        addStreamResponseEntry({ message: `Subscription error: ${message}` }, `SubscribeToTask(${taskId})`)
      }
    } finally {
      if (subscriptionsRef.current[taskId] === controller) {
        delete subscriptionsRef.current[taskId]
        setSubscribedTaskIds((current) => current.filter((id) => id !== taskId))
      }
    }
  }

  const clearRuntime = () => {
    Object.values(subscriptionsRef.current).forEach((controller) => controller.abort())
    subscriptionsRef.current = {}
    mutedResponseTaskIdsRef.current.clear()
    clientRef.current = null
    setIsConnected(false)
    setServiceUrl('')
    setConnectionError('')
    setAgentCard(null)
    setValidation(null)
    setTasks({})
    setStreamResponseEntries([])
    setWireLogs([])
    setSubscribedTaskIds([])
    setMutedResponseTaskIds([])
    setShowResponsesPanel(false)
    setLastResponse('')
    setChatMessages([])
    setStatusMessage('Connection reset. Configure agent card URL and connect again.')
  }

  const handleDisconnect = () => {
    clearRuntime()
    setStatusMessage('Disconnected. Connection settings were kept.')
  }

  const handleFactoryReset = () => {
    clearRuntime()
    const defaults = createDefaultPersistedSettings()
    setAgentCardUrl(defaults.agentCardUrl)
    setAuthMode(defaults.authMode)
    setBearerToken(defaults.bearerToken)
    setOauthForm(defaults.oauthForm)
    setOauthAccessToken(defaults.oauthAccessToken)
    setOauthTokenExpiresAt(defaults.oauthTokenExpiresAt)
    activeAccessTokenRef.current = ''
    window.localStorage.removeItem(CONNECTION_SETTINGS_STORAGE_KEY)
    setStatusMessage('Factory reset complete. All saved settings were removed.')
  }

  const waitForOAuthCode = (popup: Window, redirectUri: string, expectedState: string): Promise<string> => {
    return new Promise((resolve, reject) => {
      let resolved = false
      const expectedRedirect = new URL(redirectUri)
      let intervalId: number | undefined

      const finish = (callback: () => void) => {
        if (resolved) {
          return
        }
        resolved = true
        if (intervalId !== undefined) {
          window.clearInterval(intervalId)
        }
        try {
          popup.close()
        } catch {
          // Ignore popup close errors.
        }
        callback()
      }

      intervalId = window.setInterval(() => {
        if (popup.closed) {
          finish(() => reject(new Error('OAuth popup was closed before authorization completed.')))
          return
        }

        try {
          const currentUrl = new URL(popup.location.href)
          if (
            currentUrl.origin !== expectedRedirect.origin ||
            currentUrl.pathname !== expectedRedirect.pathname
          ) {
            return
          }

          const params = new URLSearchParams(currentUrl.search)
          const returnedState = params.get('state')
          if (returnedState !== expectedState) {
            finish(() => reject(new Error('OAuth state mismatch detected.')))
            return
          }

          const authError = params.get('error')
          if (authError) {
            const description = params.get('error_description') || authError
            finish(() => reject(new Error(`OAuth authorize error: ${description}`)))
            return
          }

          const code = params.get('code')
          if (!code) {
            finish(() => reject(new Error('OAuth authorization code was not returned.')))
            return
          }

          finish(() => resolve(code))
        } catch {
          // Ignore cross-origin access until the popup returns to redirect URI.
        }
      }, 350)
    })
  }

  const exchangeCodeForToken = async (
    authorizationCode: string,
    scopeText: string,
    codeVerifier: string,
  ): Promise<string> => {
    const tenantId = oauthForm.tenantId.trim()
    const clientId = oauthForm.clientId.trim()
    const redirectUri = oauthForm.redirectUri.trim()
    const tokenEndpoint = `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`

    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: clientId,
      redirect_uri: redirectUri,
      scope: scopeText,
      code: authorizationCode,
      code_verifier: codeVerifier,
    })

    const response = await fetch(tokenEndpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: body.toString(),
    })

    const payload = (await response.json()) as Record<string, unknown>
    if (!response.ok) {
      const message =
        (typeof payload.error_description === 'string' && payload.error_description) ||
        (typeof payload.error === 'string' && payload.error) ||
        `HTTP ${response.status}`
      throw new Error(`OAuth token request failed: ${message}`)
    }

    const accessToken = payload.access_token
    if (typeof accessToken !== 'string' || accessToken.trim().length === 0) {
      throw new Error('OAuth token response did not include an access_token.')
    }

    const expiresIn = payload.expires_in
    if (typeof expiresIn === 'number' && Number.isFinite(expiresIn)) {
      setOauthTokenExpiresAt(new Date(Date.now() + expiresIn * 1000).toISOString())
    } else {
      setOauthTokenExpiresAt('')
    }

    return accessToken
  }

  const requestOAuthAccessToken = async (): Promise<string> => {
    const tenantId = oauthForm.tenantId.trim()
    const clientId = oauthForm.clientId.trim()
    const redirectUri = oauthForm.redirectUri.trim()
    const scopes = splitScopes(oauthForm.scopes)

    if (!tenantId || !clientId || !redirectUri) {
      throw new Error('OAuth flow requires Tenant Id, Client Id, and Redirect URI.')
    }
    if (scopes.length === 0) {
      throw new Error('OAuth flow requires at least one scope.')
    }

    const redirectUrl = new URL(redirectUri)
    if (redirectUrl.origin !== window.location.origin) {
      throw new Error(
        'Redirect URI must use the current app origin so the browser can capture the authorization code.',
      )
    }

    const authorizeEndpoint = `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/authorize`
    const scopeText = scopes.join(' ')
    const state = createOAuthStateValue()
    const codeVerifier = createPkceVerifier()
    const codeChallenge = await createPkceChallenge(codeVerifier)
    const authorizeUrl = new URL(authorizeEndpoint)
    authorizeUrl.searchParams.set('client_id', clientId)
    authorizeUrl.searchParams.set('response_type', 'code')
    authorizeUrl.searchParams.set('redirect_uri', redirectUri)
    authorizeUrl.searchParams.set('response_mode', 'query')
    authorizeUrl.searchParams.set('scope', scopeText)
    authorizeUrl.searchParams.set('state', state)
    authorizeUrl.searchParams.set('code_challenge', codeChallenge)
    authorizeUrl.searchParams.set('code_challenge_method', 'S256')

    const popup = window.open(authorizeUrl.toString(), 'a2a-oauth-authorize', 'popup,width=540,height=720')
    if (!popup) {
      throw new Error('Unable to open OAuth popup. Allow popups and try again.')
    }

    const authorizationCode = await waitForOAuthCode(popup, redirectUri, state)
    const accessToken = await exchangeCodeForToken(authorizationCode, scopeText, codeVerifier)
    setOauthAccessToken(accessToken)
    return accessToken
  }

  const handleAuthorizeOAuth = async () => {
    setConnectionError('')
    setIsAuthorizing(true)
    setStatusMessage('Starting OAuth authorization flow...')

    try {
      const accessToken = await requestOAuthAccessToken()
      activeAccessTokenRef.current = accessToken
      setStatusMessage('OAuth access token acquired.')
    } catch (error) {
      const message = error instanceof Error ? error.message : 'OAuth authorization failed.'
      setConnectionError(message)
      setStatusMessage('OAuth authorization failed.')
    } finally {
      setIsAuthorizing(false)
    }
  }

  const handleCopyOauthAccessToken = async () => {
    if (!oauthAccessToken) {
      return
    }

    try {
      await navigator.clipboard.writeText(oauthAccessToken)
      setStatusMessage('OAuth access token copied to clipboard.')
    } catch {
      setConnectionError('Unable to copy token automatically. Select and copy it manually.')
    }
  }

  const handleConnect = async () => {
    setConnectionError('')
    setStatusMessage('Connecting to agent...')

    const trimmedCardUrl = agentCardUrl.trim()
    if (trimmedCardUrl.length === 0) {
      setConnectionError('Agent card JSON URL is required.')
      return
    }

    setIsConnecting(true)

    try {
      let accessToken = ''
      if (authMode === 'bearer') {
        accessToken = bearerToken.trim()
        if (accessToken.length === 0) {
          throw new Error('Bearer token mode requires a token value.')
        }
      }

      if (authMode === 'oauth') {
        accessToken = oauthAccessToken.trim()
        if (accessToken.length === 0) {
          setStatusMessage('Running OAuth flow before connecting...')
          accessToken = await requestOAuthAccessToken()
        }
      }

      activeAccessTokenRef.current = accessToken

      const client = new A2AClient({
        serviceUrl: trimmedCardUrl,
        getAccessToken: () => activeAccessTokenRef.current,
        onWireLog: handleWireLog,
      })

      const cardPayload = await client.fetchAgentCard(trimmedCardUrl)
      if (!cardPayload || typeof cardPayload !== 'object' || Array.isArray(cardPayload)) {
        throw new Error('Agent card response is not a JSON object.')
      }

      const cardObject = cardPayload as Record<string, unknown>
      const resolvedEndpoint = resolveAgentEndpoint(cardObject, trimmedCardUrl)
      const runtimeClient = new A2AClient({
        serviceUrl: resolvedEndpoint,
        getAccessToken: () => activeAccessTokenRef.current,
        onWireLog: handleWireLog,
      })

      const validationResult = validateAgentCard(cardObject)

      clientRef.current = runtimeClient
      setAgentCard(cardObject)
      setValidation(validationResult)
      setServiceUrl(resolvedEndpoint)
      setIsConnected(true)
      setStatusMessage('Connected successfully.')
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error while connecting.'
      setConnectionError(message)
      setStatusMessage('Connection failed.')
      setIsConnected(false)
    } finally {
      setIsConnecting(false)
    }
  }

  const handleMethodChanged = (methodName: string) => {
    setSelectedMethod(methodName)
    const operation = OPERATIONS.find((item) => item.method === methodName)
    if (operation) {
      setOperationParamsText(toPrettyJson(operation.sampleParams))
    }
  }

  const runRpc = async (method: string, params: Record<string, unknown>, streaming = false) => {
    if (!clientRef.current) {
      setConnectionError('Not connected. Connect to an A2A server first.')
      return
    }

    setBusy(true)
    setConnectionError('')
    setStatusMessage(`Running ${method}...`)

    try {
      if (streaming) {
        await clientRef.current.streamJsonRpc(method, params, (streamPayload) => {
          ingestPayload(streamPayload)
          addStreamResponseEntry(streamPayload, method)
        })
        setLastResponse(`Streaming call for ${method} completed.`)
      } else {
        const resultPayload = await clientRef.current.jsonRpc(method, params)
        setLastResponse(toPrettyJson(resultPayload))
        ingestPayload(resultPayload)
        if (method === 'GetExtendedAgentCard') {
          if (resultPayload && typeof resultPayload === 'object' && !Array.isArray(resultPayload)) {
            const extendedCard = resultPayload as Record<string, unknown>
            setAgentCard(extendedCard)
            setValidation(validateAgentCard(extendedCard))
          } else {
            setConnectionError('GetExtendedAgentCard returned a non-object payload.')
          }
        }
      }

      setStatusMessage(`${method} completed.`)
    } catch (error) {
      const message = error instanceof Error ? error.message : `Unknown error in ${method}.`
      setConnectionError(message)
      setStatusMessage(`${method} failed.`)
    } finally {
      setBusy(false)
    }
  }

  const sendChatMessage = async () => {
    const text = quickMessage.trim()
    if (text.length === 0) {
      setConnectionError('Enter a message before sending.')
      return
    }
    if (!clientRef.current) {
      setConnectionError('Not connected. Connect to an A2A server first.')
      return
    }

    // Append user bubble immediately
    setChatMessages((prev) => [
      ...prev,
      { id: createMessageId(), role: 'user', content: text, timestamp: new Date().toISOString() },
    ])
    setQuickMessage('')
    setBusy(true)
    setConnectionError('')

    const rpcParams = {
      message: {
        role: 'ROLE_USER',
        parts: [{ text }],
        messageId: createMessageId(),
      },
      configuration: { returnImmediately: !quickStreaming },
    }

    if (quickStreaming) {
      const agentMsgId = createMessageId()
      const workingMsgId = createMessageId()
      const answerMsgId = createMessageId()
      let latestTaskId: string | undefined
      // Placeholder streaming bubble
      setChatMessages((prev) => [
        ...prev,
        { id: agentMsgId, role: 'agent', content: '', timestamp: new Date().toISOString(), isStreaming: true },
      ])

      try {
        await clientRef.current.streamJsonRpc('SendStreamingMessage', rpcParams, (event) => {
          ingestPayload(event)
          addStreamResponseEntry(event, 'SendStreamingMessage')

          const eventTaskId = extractTaskIdFromStreamEvent(event)
          if (eventTaskId) {
            latestTaskId = eventTaskId
          }

          const segments = extractOrderedChatSegments(event)
          if (segments.length === 0) {
            return
          }

          for (const segment of segments) {
            if (segment.kind === 'working') {
              updateAgentStreamingMessage(workingMsgId, segment.text, { replace: true })
              continue
            }

            if (segment.kind === 'answer') {
              updateAgentStreamingMessage(answerMsgId, segment.text, { append: segment.append })
              continue
            }

            updateAgentStreamingMessage(agentMsgId, segment.text, { append: segment.append })
          }
        })

        // When streaming is enabled, automatically subscribe for additional
        // task updates if the stream exposed a task identifier.
        if (latestTaskId) {
          void startTaskSubscription(latestTaskId)
        }
      } catch (err) {
        const errText = err instanceof Error ? err.message : 'Streaming error.'
        setChatMessages((prev) =>
          prev.map((msg) =>
            msg.id === agentMsgId
              ? { ...msg, content: msg.content || `**Error:** ${errText}`, isError: true }
              : msg,
          ),
        )
        setConnectionError(errText)
      } finally {
        setChatMessages((prev) =>
          prev.map((msg) =>
            msg.id === agentMsgId || msg.id === workingMsgId || msg.id === answerMsgId
              ? { ...msg, isStreaming: false }
              : msg,
          ),
        )
        setBusy(false)
      }
    } else {
      try {
        const result = await clientRef.current.jsonRpc('SendMessage', rpcParams)
        ingestPayload(result)
        const responseText = extractChatText(result)
        setChatMessages((prev) => [
          ...prev,
          {
            id: createMessageId(),
            role: 'agent',
            content: responseText || toPrettyJson(result),
            timestamp: new Date().toISOString(),
          },
        ])
      } catch (err) {
        const errText = err instanceof Error ? err.message : 'Error sending message.'
        setChatMessages((prev) => [
          ...prev,
          {
            id: createMessageId(),
            role: 'agent',
            content: `**Error:** ${errText}`,
            timestamp: new Date().toISOString(),
            isError: true,
          },
        ])
        setConnectionError(errText)
      } finally {
        setBusy(false)
      }
    }
  }

  const handleOperationExecute = async () => {
    let parsedParams: Record<string, unknown>
    try {
      const parsed = JSON.parse(operationParamsText)
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        parsedParams = parsed as Record<string, unknown>
      } else {
        throw new Error('Operation parameters must be a JSON object.')
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Invalid JSON parameters.'
      setConnectionError(message)
      return
    }

    await runRpc(selectedOperation.method, parsedParams, selectedOperation.streaming === true)
  }

  const handleRefreshTasks = async () => {
    await runRpc('ListTasks', { pageSize: 50 })
  }

  const handleTaskAction = async (method: 'GetTask' | 'CancelTask', taskId: string) => {
    await runRpc(method, { id: taskId }, false)
  }

  useEffect(() => {
    return () => {
      Object.values(subscriptionsRef.current).forEach((controller) => controller.abort())
      subscriptionsRef.current = {}
    }
  }, [])

  return (
    <div className="app-shell">
      <header className="app-header">
        <div>
          <h1>A2A Consumer</h1>
          <p className="subtitle">Connect to any A2A v1.0 agent and test protocol operations.</p>
        </div>
        <div className="header-actions">
          <button
            type="button"
            className="small-btn"
            onClick={() => setTheme((current) => (current === 'dark' ? 'light' : 'dark'))}
          >
            Theme: {theme}
          </button>
          <button type="button" className="small-btn danger" onClick={handleFactoryReset}>
            Reset
          </button>
        </div>
      </header>

      <section className="panel connection-panel">
        <h2>Connection</h2>
        <div className="connection-grid">
          <label>
            Agent Card JSON URL
            <input
              type="url"
              placeholder="https://agent.example.com/.well-known/agent-card.json"
              value={agentCardUrl}
              onChange={(event) => setAgentCardUrl(event.target.value)}
            />
          </label>

          <div className="auth-panel" role="group" aria-label="Authentication configuration">
            <p className="auth-panel-title">Authentication</p>
            <div className="auth-mode-row" role="radiogroup" aria-label="Authentication options">
              <label className="auth-mode-option">
                <input
                  type="radio"
                  name="auth-mode"
                  checked={authMode === 'anonymous'}
                  onChange={() => setAuthMode('anonymous')}
                />
                Anonymous
              </label>
              <label className="auth-mode-option">
                <input
                  type="radio"
                  name="auth-mode"
                  checked={authMode === 'bearer'}
                  onChange={() => setAuthMode('bearer')}
                />
                Bearer Token
              </label>
              <label className="auth-mode-option">
                <input
                  type="radio"
                  name="auth-mode"
                  checked={authMode === 'oauth'}
                  onChange={() => setAuthMode('oauth')}
                />
                OAuth Flow
              </label>
            </div>

            {authMode === 'bearer' && (
              <label>
                Bearer token value
                <input
                  type="password"
                  placeholder="eyJ..."
                  value={bearerToken}
                  onChange={(event) => setBearerToken(event.target.value)}
                />
              </label>
            )}

            {authMode === 'oauth' && (
              <div className="oauth-grid">
                <label>
                  <span className="field-label-text">
                    Tenant Id <span className="required-mark" aria-hidden="true">*</span>
                  </span>
                  <input
                    type="text"
                    placeholder="contoso.onmicrosoft.com or tenant GUID"
                    value={oauthForm.tenantId}
                    required
                    aria-required="true"
                    onChange={(event) =>
                      setOauthForm((current) => ({ ...current, tenantId: event.target.value }))
                    }
                  />
                </label>
                <label>
                  <span className="field-label-text">
                    Client Id <span className="required-mark" aria-hidden="true">*</span>
                  </span>
                  <input
                    type="text"
                    placeholder="Application (client) ID"
                    value={oauthForm.clientId}
                    required
                    aria-required="true"
                    onChange={(event) =>
                      setOauthForm((current) => ({ ...current, clientId: event.target.value }))
                    }
                  />
                </label>
                <label>
                  Client Secret
                  <input
                    type="password"
                    placeholder="Optional for browser PKCE flow"
                    value={oauthForm.clientSecret}
                    onChange={(event) =>
                      setOauthForm((current) => ({ ...current, clientSecret: event.target.value }))
                    }
                  />
                </label>
                <label>
                  <span className="field-label-text">
                    Redirect URI <span className="required-mark" aria-hidden="true">*</span>
                  </span>
                  <input
                    type="url"
                    placeholder="Must match current app origin"
                    value={oauthForm.redirectUri}
                    required
                    aria-required="true"
                    onChange={(event) =>
                      setOauthForm((current) => ({ ...current, redirectUri: event.target.value }))
                    }
                  />
                </label>
                <label className="oauth-scopes-field">
                  <span className="field-label-text">
                    Scopes <span className="required-mark" aria-hidden="true">*</span>
                  </span>
                  <textarea
                    rows={2}
                    placeholder="openid profile offline_access api://your-app/.default"
                    value={oauthForm.scopes}
                    required
                    aria-required="true"
                    onChange={(event) =>
                      setOauthForm((current) => ({ ...current, scopes: event.target.value }))
                    }
                  />
                </label>

                {oauthValidationErrors.length > 0 && (
                  <div className="oauth-validation" role="alert">
                    {oauthValidationErrors.map((error) => (
                      <p key={error}>{error}</p>
                    ))}
                  </div>
                )}

                <div className="row-actions oauth-actions">
                  <button
                    type="button"
                    className="small-btn"
                    onClick={handleAuthorizeOAuth}
                    disabled={isConnecting || busy || isAuthorizing || !canAuthorizeOAuth}
                  >
                    {isAuthorizing ? 'Authorizing...' : 'Authorize & Get Token'}
                  </button>
                  <p className="oauth-token-hint">
                    {oauthAccessToken
                      ? `Token acquired${oauthTokenExpiresAt ? ` (expires ${new Date(oauthTokenExpiresAt).toLocaleString()})` : ''}`
                      : 'No OAuth token acquired yet.'}
                  </p>
                </div>

                {oauthAccessToken && (
                  <div className="oauth-token-viewer">
                    <div className="oauth-token-viewer-header">
                      <button
                        type="button"
                        className="small-btn"
                        onClick={() => setShowOauthAccessToken((current) => !current)}
                      >
                        {showOauthAccessToken ? 'Hide Access Token' : 'Show Access Token'}
                      </button>
                      {showOauthAccessToken && (
                        <button
                          type="button"
                          className="small-btn"
                          onClick={handleCopyOauthAccessToken}
                        >
                          Copy Token
                        </button>
                      )}
                    </div>

                    {showOauthAccessToken && (
                      <textarea
                        className="oauth-token-textarea"
                        rows={4}
                        readOnly
                        value={oauthAccessToken}
                        onFocus={(event) => event.currentTarget.select()}
                        aria-label="Retrieved OAuth access token"
                      />
                    )}
                  </div>
                )}
              </div>
            )}
          </div>
        </div>

        <div className="row-actions">
          <button type="button" onClick={handleConnect} disabled={isConnecting || busy || isAuthorizing}>
            {isConnecting ? 'Connecting...' : 'Connect'}
          </button>
          <button
            type="button"
            className="small-btn"
            onClick={handleDisconnect}
            disabled={isConnecting || busy || isAuthorizing || !isConnected}
          >
            Disconnect
          </button>
        </div>

        <div className="status-grid">
          <p>
            <strong>Status:</strong> {isConnected ? 'Connected' : 'Disconnected'}
          </p>
          <p>
            <strong>Agent Endpoint:</strong> {serviceUrl || '-'}
          </p>
          <p>
            <strong>Runtime:</strong> {statusMessage}
          </p>
          <p>
            <strong>Auth Mode:</strong> {formatAuthModeLabel(authMode)}
          </p>
        </div>

        {connectionError && (
          <div className="error-box" role="alert">
            {connectionError}
          </div>
        )}
      </section>

      {agentCard && (
        <section className="panel">
          <h2>Agent Card</h2>
          <div className="tab-row" role="tablist" aria-label="Agent card tabs">
            <button
              type="button"
              className={agentTab === 'summary' ? 'tab active' : 'tab'}
              onClick={() => setAgentTab('summary')}
            >
              Summary & Validation
            </button>
            <button
              type="button"
              className={agentTab === 'raw' ? 'tab active' : 'tab'}
              onClick={() => setAgentTab('raw')}
            >
              Raw JSON
            </button>
            <button
              type="button"
              className={agentTab === 'settings' ? 'tab active' : 'tab'}
              onClick={() => setAgentTab('settings')}
            >
              Settings Table
            </button>
          </div>

          {agentTab === 'summary' && (
            <div className="tab-panel">
              <p>
                <strong>Name:</strong> {String(agentCard.name ?? '-')}
              </p>
              <p>
                <strong>Version:</strong> {String(agentCard.version ?? '-')}
              </p>
              <p>
                <strong>URL:</strong> {String(agentCard.url ?? (serviceUrl || '-'))}
              </p>

              <h3>Validation</h3>
              {validation && validation.issues.length === 0 && (
                <p className="ok-text">No structural issues detected for required core fields.</p>
              )}
              {validation && validation.issues.length > 0 && (
                <ul className="validation-list">
                  {validation.issues.map((issue, index) => (
                    <li key={`${issue.path}-${index}`} className={issue.severity === 'error' ? 'issue-error' : 'issue-warn'}>
                      <strong>{issue.severity.toUpperCase()}</strong> - {issue.path}: {issue.message}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}

          {agentTab === 'raw' && (
            <div className="tab-panel">
              <pre>{toPrettyJson(agentCard)}</pre>
            </div>
          )}

          {agentTab === 'settings' && (
            <div className="tab-panel">
              <table>
                <thead>
                  <tr>
                    <th>Section</th>
                    <th>Key</th>
                    <th>Value</th>
                  </tr>
                </thead>
                <tbody>
                  {settingRows.map((row, index) => (
                    <tr key={`${row.section}-${row.key}-${index}`}>
                      <td>{row.section}</td>
                      <td>{row.key}</td>
                      <td>{row.value}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      )}

      <section className="panel">
        <h2>A2A Messaging & Operations</h2>
        <div className="columns">
          <div className="column chat-column">
            <div className="chat-header">
              <h3>Chat</h3>
              <button
                type="button"
                className="small-btn"
                onClick={() => setChatMessages([])}
              >
                Clear
              </button>
            </div>

            <div className="chat-messages" ref={chatMessagesContainerRef}>
              {chatMessages.length === 0 && (
                <p className="chat-empty">Send a message to start the conversation.</p>
              )}
              {chatMessages.map((msg) => (
                <div
                  key={msg.id}
                  className={`chat-msg chat-msg-${msg.role}${
                    msg.isError ? ' chat-msg-error' : ''
                  }`}
                >
                  <div className="chat-bubble">
                    {msg.role === 'agent' ? (
                      <ReactMarkdown remarkPlugins={[remarkGfm]}>
                        {msg.content || (msg.isStreaming ? '\u00a0' : '')}
                      </ReactMarkdown>
                    ) : (
                      <p>{msg.content}</p>
                    )}
                    {msg.isStreaming && <span className="chat-cursor" aria-hidden="true" />}
                  </div>
                  <time className="chat-ts">
                    {new Date(msg.timestamp).toLocaleTimeString()}
                  </time>
                </div>
              ))}
            </div>

            <div className="chat-input-row">
              <textarea
                className="chat-input"
                rows={2}
                placeholder="Type a message… (Enter to send, Shift+Enter for newline)"
                value={quickMessage}
                onChange={(event) => setQuickMessage(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' && !event.shiftKey) {
                    event.preventDefault()
                    void sendChatMessage()
                  }
                }}
              />
              <div className="chat-input-footer">
                <label className="checkline">
                  <input
                    type="checkbox"
                    checked={quickStreaming}
                    onChange={(event) => setQuickStreaming(event.target.checked)}
                  />
                  Stream
                </label>
                <button
                  type="button"
                  className="chat-send-btn"
                  onClick={() => void sendChatMessage()}
                  disabled={!isConnected || busy}
                >
                  Send
                </button>
              </div>
            </div>
          </div>

          <div className="column">
            <h3>Advanced Operation</h3>
            <label>
              Method
              <select
                value={selectedMethod}
                onChange={(event) => handleMethodChanged(event.target.value)}
              >
                {OPERATIONS.map((op) => (
                  <option key={op.method} value={op.method}>
                    {op.label}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Params (JSON object)
              <textarea
                rows={9}
                value={operationParamsText}
                onChange={(event) => setOperationParamsText(event.target.value)}
              />
            </label>
            <div className="row-actions">
              <button type="button" onClick={handleOperationExecute} disabled={!isConnected || busy}>
                Execute
              </button>
              <button
                type="button"
                className="small-btn"
                onClick={() => setOperationParamsText(toPrettyJson(selectedOperation.sampleParams))}
              >
                Reset Params
              </button>
            </div>
          </div>
        </div>
      </section>

      <section className="panel">
        <div className="row-actions spread">
          <h2>Task Monitor</h2>
          <button type="button" onClick={handleRefreshTasks} disabled={!isConnected || busy}>
            Refresh Task List
          </button>
        </div>
        <table>
          <thead>
            <tr>
              <th>Task ID</th>
              <th>Context</th>
              <th>State</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {taskList.length === 0 && (
              <tr>
                <td colSpan={4}>No tasks tracked yet.</td>
              </tr>
            )}
            {taskList.map((task) => {
              const taskId = typeof task.id === 'string' ? task.id : 'unknown'
              const statusRecord = task.status as Record<string, unknown> | undefined
              const state = typeof statusRecord?.state === 'string' ? statusRecord.state : '-'
              const isSubscribed = subscribedTaskIds.includes(taskId)

              return (
                <tr key={taskId}>
                  <td>{taskId}</td>
                  <td>{typeof task.contextId === 'string' ? task.contextId : '-'}</td>
                  <td>
                    <div className="task-state-with-badge">
                      <span>{state}</span>
                      {isSubscribed && <span className="task-sub-badge">Subscribed</span>}
                    </div>
                  </td>
                  <td>
                    <div className="mini-actions">
                      <button type="button" onClick={() => handleTaskAction('GetTask', taskId)}>
                        Get
                      </button>
                      <button type="button" onClick={() => handleTaskAction('CancelTask', taskId)}>
                        Cancel
                      </button>
                      <button
                        type="button"
                        onClick={() => stopTaskSubscription(taskId)}
                        disabled={!isSubscribed || mutedResponseTaskIds.includes(taskId)}
                      >
                        Unsubscribe
                      </button>
                    </div>
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </section>

      <section className={`panel responses-panel ${showResponsesPanel ? 'expanded' : 'collapsed'}`}>
        <div className="row-actions spread responses-header">
          <h2>Responses</h2>
          <button
            type="button"
            className="small-btn"
            onClick={() => setShowResponsesPanel((current) => !current)}
          >
            {showResponsesPanel ? 'Hide Responses' : 'Show Responses'}
          </button>
        </div>

        {showResponsesPanel ? (
          <div className="columns">
            <div className="column">
              <h3>Last RPC Response</h3>
              <pre>{lastResponse || 'No response yet.'}</pre>
            </div>
            <div className="column">
              <h3>Streaming Events</h3>
              {streamResponseEntries.length === 0 ? (
                <pre>No stream events yet.</pre>
              ) : (
                <div className="stream-response-list">
                  {streamResponseEntries.map((entry) => (
                    <div key={entry.id} className="stream-response-item">
                      <div className="stream-response-meta">
                        <span>{new Date(entry.timestamp).toLocaleTimeString()}</span>
                        <span>{entry.source}</span>
                      </div>
                      <pre>{entry.text}</pre>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        ) : (
          <p className="responses-collapsed-hint">
            Responses panel is reduced. Open it to inspect raw RPC and streaming event details.
          </p>
        )}
      </section>

      <section className={`panel wire-toggle-panel wire-panel ${showWireInspector ? 'expanded' : 'collapsed'}`}>
        <div className="row-actions spread responses-header">
          <h2>On-Wire Communication</h2>
          <button
            type="button"
            className="small-btn"
            onClick={() => setShowWireInspector((current) => !current)}
          >
            {showWireInspector ? 'Hide Wire Inspector' : 'Show Wire Inspector'}
          </button>
        </div>

        {showWireInspector ? (
          <div className="wire-panel-content">
            {wireLogs.length === 0 && <p>No requests captured yet.</p>}
            {wireLogs.map((entry) => (
              <details key={entry.id}>
                <summary>
                  <span>{entry.timestamp}</span>
                  <span>{entry.operation}</span>
                  <span>{entry.url}</span>
                  <span>{entry.statusText}</span>
                </summary>
                <div className="wire-grid">
                  <div>
                    <h3>Request Headers</h3>
                    <pre>{toPrettyJson(entry.requestHeaders)}</pre>
                  </div>
                  <div>
                    <h3>Response Headers</h3>
                    <pre>{toPrettyJson(entry.responseHeaders)}</pre>
                  </div>
                  <div>
                    <h3>Request Body</h3>
                    <pre>{entry.requestBody || '-'}</pre>
                  </div>
                  <div>
                    <h3>Response Body</h3>
                    <pre>{entry.responseBody || '-'}</pre>
                  </div>
                </div>
              </details>
            ))}
          </div>
        ) : (
          <p className="responses-collapsed-hint">
            On-Wire Communication is reduced. Open it to inspect request and response details.
          </p>
        )}
      </section>
    </div>
  )
}

export default App
