# Main Functionalities

## 1. Agent Connection Workflow

- Configure the Agent Card JSON URL.
- Configure an optional OAuth bearer token.
- Connect flow fetches the agent card through the dev proxy (see §6), validates its structure, resolves the runtime service endpoint, and initialises the A2A client.
- Connection state, resolved endpoint, and a runtime status message are shown in the UI.
- A **Reset** command clears all connection state, chat history, tasks, wire logs, and runtime data so you can start fresh.

## 2. Agent Card Exploration

Once connected, the agent card is displayed with three tabs:

- **Summary & Validation tab** — shows `name`, `version`, and `url`; runs a structural validator that reports `error` and `warning` issues for required and recommended fields.
- **Raw JSON tab** — pretty-printed full card payload.
- **Settings Table tab** — flattens all card fields into a section / key / value table for quick inspection (sections: Core, Capabilities, Authentication, Skills).

## 3. Chat Interface

The left column of the Messaging & Operations panel is a chat interface for sending user messages and reading agent responses:

- Type a message and press **Send** (or `Enter`; `Shift+Enter` inserts a newline).
- Toggle **Stream** to choose between `SendStreamingMessage` (SSE) and `SendMessage` (blocking).
- **User bubbles** appear right-aligned immediately on send.
- **Agent bubbles** appear left-aligned. For streaming, a placeholder bubble with a blinking cursor appears at once and its content builds progressively as SSE events arrive. For non-streaming, the bubble appears when the response is complete.
- Agent responses are rendered as rich **GitHub Flavoured Markdown** via `react-markdown` + `remark-gfm`, supporting headings, lists, tables, fenced code blocks with syntax hints, blockquotes, inline code, bold/italic, links, horizontal rules, and emoji.
- Errors are shown inside a red-bordered bubble without losing the conversation history.
- A **Clear** button resets only the chat history without disconnecting.

## 4. Advanced A2A Operations

The right column of the Messaging & Operations panel exposes all A2A v1.0 JSON-RPC methods:

| Method | Type |
|---|---|
| `SendMessage` | Blocking |
| `SendStreamingMessage` | Streaming (SSE) |
| `GetTask` | Blocking |
| `ListTasks` | Blocking |
| `CancelTask` | Blocking |
| `SubscribeToTask` | Streaming (SSE) |
| `CreateTaskPushNotificationConfig` | Blocking |
| `GetTaskPushNotificationConfig` | Blocking |
| `ListTaskPushNotificationConfigs` | Blocking |
| `DeleteTaskPushNotificationConfig` | Blocking |
| `GetExtendedAgentCard` | Blocking |

Parameters are edited as a JSON object. A **Reset Params** button restores the sample payload for the selected method. Raw JSON responses are displayed in the Responses panel.

## 5. Task Monitor

- A table tracks every task seen in any response or stream event.
- Tasks are upserted by ID so partial updates from streaming and polling merge correctly.
- Per-row actions: **Get** (poll current state), **Cancel**, **Subscribe** (open SSE stream).
- **Refresh Task List** triggers a `ListTasks` call.

## 6. CORS Dev Proxy

Browsers enforce CORS on all cross-origin `fetch` calls. During `npm run dev`, the Vite dev server runs a transparent Node.js HTTP proxy at `/__a2a_proxy__/<encoded-url>`. All A2A requests — agent card fetch, JSON-RPC calls, and SSE streams — are automatically routed through it. The proxy:

- Answers CORS preflight `OPTIONS` requests immediately without touching the upstream.
- Forwards all other requests from Node.js (where CORS does not apply) to the real agent endpoint.
- Injects `Access-Control-Allow-Origin: *` and `Access-Control-Expose-Headers: *` into every response.
- Pipes SSE streams byte-for-byte without buffering.

In production builds, `import.meta.env.DEV` resolves to `false` and `resolveViaProxy()` returns the original URL unchanged. The target server must then supply its own CORS headers.

## 7. Wire Inspector

Activated by the magnifier button in the Connection panel. Captures for every call:

- URL (actual target, not proxy path)
- Request headers
- Response headers
- Request body
- Response body (full accumulated text for streams)
- HTTP status code and text

Each entry is shown as a collapsible row. For network-level failures (CORS, DNS, etc.) the entry records status `0 / Network Error` and the browser error message.

## 8. Light / Dark Mode

- Toggle in the header switches between `light` and `dark`.
- Theme is applied via a `data-theme` attribute on `<html>` and resolved through CSS custom properties.
- All panels, bubbles, code blocks, and tables adapt to the active theme.

## 9. Error Handling

- Connection and RPC failures surface in a red alert box below the connection panel.
- JSON parameter syntax errors are caught before any network call.
- Streaming errors produce a red error bubble in the chat without breaking the conversation.
- CORS / network failures include an actionable description explaining the likely cause.
