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
  const clientRef = useRef<A2AClient | null>(null)
  const subscriptionsRef = useRef<Record<string, AbortController>>({})
  const mutedResponseTaskIdsRef = useRef<Set<string>>(new Set())
  const [theme, setTheme] = useState<ThemeMode>('light')
  const [agentCardUrl, setAgentCardUrl] = useState('')
  const [bearerToken, setBearerToken] = useState('')
  const [serviceUrl, setServiceUrl] = useState('')
  const [isConnecting, setIsConnecting] = useState(false)
  const [isConnected, setIsConnected] = useState(false)
  const [connectionError, setConnectionError] = useState('')

  const [agentCard, setAgentCard] = useState<Record<string, unknown> | null>(null)
  const [validation, setValidation] = useState<AgentCardValidationResult | null>(null)
  const [agentTab, setAgentTab] = useState<AgentTab>('summary')

  const [quickMessage, setQuickMessage] = useState('Hello from A2A SPA')
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
  const chatScrollAnchor = useRef<HTMLDivElement>(null)

  useEffect(() => {
    chatScrollAnchor.current?.scrollIntoView({ behavior: 'smooth' })
  }, [chatMessages])

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme)
  }, [theme])

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
      const client = new A2AClient({
        serviceUrl: trimmedCardUrl,
        bearerToken: bearerToken.trim(),
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
        bearerToken: bearerToken.trim(),
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
          <button type="button" className="small-btn danger" onClick={clearRuntime}>
            Reset
          </button>
        </div>
      </header>

      <section className="panel connection-panel">
        <h2>Connection</h2>
        <div className="form-grid">
          <label>
            Agent Card JSON URL
            <input
              type="url"
              placeholder="https://agent.example.com/.well-known/agent-card.json"
              value={agentCardUrl}
              onChange={(event) => setAgentCardUrl(event.target.value)}
            />
          </label>
          <label>
            OAuth Bearer Token (optional)
            <input
              type="password"
              placeholder="eyJ..."
              value={bearerToken}
              onChange={(event) => setBearerToken(event.target.value)}
            />
          </label>
        </div>

        <div className="row-actions">
          <button type="button" onClick={handleConnect} disabled={isConnecting || busy}>
            {isConnecting ? 'Connecting...' : 'Connect'}
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

            <div className="chat-messages">
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
              <div ref={chatScrollAnchor} />
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
