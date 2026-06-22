# Implementation Details

## Technology Stack

| Package | Version | Purpose |
|---|---|---|
| React | 19 | UI framework |
| TypeScript | 6 | Type safety |
| Vite | 8 | Build tool and dev server |
| react-markdown | latest | GFM markdown rendering in chat bubbles |
| remark-gfm | latest | GitHub Flavoured Markdown plugin for react-markdown |
| Native Fetch API | — | HTTP requests and SSE streaming |
| Node.js `http`/`https` | built-in | Dev proxy request forwarding |

## File Map

| File | Role |
|---|---|
| `src/App.tsx` | UI composition, state management, event handlers |
| `src/lib/a2a.ts` | A2AClient class, validation, text extraction, types |
| `src/App.css` | Component styles, CSS custom properties, chat styles |
| `src/index.css` | Minimal global reset |
| `vite.config.ts` | Vite config + `a2aDevProxy` plugin |

## Dev Proxy (`vite.config.ts`)

`a2aDevProxy` is a Vite plugin that registers a Connect middleware:

- Matches requests at `/__a2a_proxy__/<percent-encoded-url>`.
- Responds to `OPTIONS` preflight immediately with permissive CORS headers (no upstream call).
- For all other methods: strips the proxy prefix, decodes the target URL, and forwards the request via Node.js `http` or `https`, replacing `host` and removing `origin`/`referer` headers to avoid leaking the localhost origin.
- Pipes the upstream response (including headers and body) directly to the browser response, injecting `Access-Control-Allow-Origin: *`.
- Piping preserves chunked encoding, so SSE streams flow through byte-for-byte without buffering.
- Active only during `npm run dev`; excluded from production builds.

## A2A Client (`src/lib/a2a.ts`)

### `resolveViaProxy(url)`

Returns `/__a2a_proxy__/${encodeURIComponent(url)}` when `import.meta.env.DEV` is `true`, otherwise returns the original URL. Called by all three fetch paths.

### `A2AClient.fetchAgentCard`

- Uses only CORS-safe headers (`Accept`, optionally `Authorization`) to avoid triggering a preflight for the initial card GET.
- Wraps the `fetch()` call itself in a try/catch to distinguish network failures (which throw) from HTTP error responses (which return a `Response`).
- On network failure: emits a wire log entry with `statusCode: 0 / Network Error` and re-throws with an actionable message explaining CORS.
- On HTTP error: throws with the status code.
- On invalid JSON: throws with a descriptive parse error.

### `A2AClient.jsonRpc`

- Sends a JSON-RPC 2.0 envelope: `{ jsonrpc: "2.0", id, method, params }`.
- Uses `POST` with `Content-Type: application/json` and `A2A-Version: 1.0`.
- Unwraps `result` from the envelope when present.
- Detects JSON-RPC `error` envelopes and throws with the error `message` field.

### `A2AClient.streamJsonRpc`

- Sends with `Accept: text/event-stream`.
- Reads the response body with `ReadableStreamDefaultReader` + `TextDecoder`.
- Splits on `\n\n` boundaries; extracts `data:` lines from each SSE event.
- Supports JSON-RPC envelope style (`result` field) and direct payload style.
- Accumulates the full response text for wire logging, emitted after the stream closes.

### `makeHeaders`

Builds a `Headers` object with `A2A-Version: 1.0`, `Accept`, optional `Content-Type`, and optional `Authorization: Bearer <token>`. Not used for `fetchAgentCard` (which has its own minimal header set).

## Text Extraction Helpers

### `extractChatText(payload)`

Walks any non-streaming A2A response and returns the concatenated text content:

1. `payload.message.parts[].text` — direct message response
2. `payload.task.status.message.parts[].text` — task status message
3. `payload.task.artifacts[].parts[].text` — task artifacts

Falls back to an empty string if none of the above yield text (the caller then falls back to `JSON.stringify`).

### `extractStreamChunk(event)`

Extracts a `{ text: string, append: boolean }` from a single SSE event:

- `artifactUpdate` — primary content carrier; `append` mirrors `artifactUpdate.append`.
- `statusUpdate` — progress/thinking messages; always `append: false`.
- `message` — direct message stream; always `append: false`.

In `sendChatMessage`, when `append` is `false` and the bubble already has content, a `\n\n` separator is inserted before the new chunk so multiple artifact blocks are visually separated.

## Chat State Model

```ts
type ChatMessage = {
  id: string           // crypto.randomUUID()
  role: 'user' | 'agent'
  content: string      // markdown text, built up during streaming
  timestamp: string    // ISO 8601
  isStreaming?: boolean
  isError?: boolean
}
```

State is a flat array in React. Streaming updates use the functional `setState` form (`prev => prev.map(...)`) keyed by message `id` to avoid stale-closure bugs in the SSE callback.

## Agent Card Handling

### `validateAgentCard`

Checks for required string fields (`name`, `url`, `version`) and recommended fields (`capabilities`, `skills`, `authentication`). Returns a `{ valid, issues[] }` object where each issue has a `severity` of `error` or `warning`.

### `collectSettingsEntries`

Flattens the agent card into `{ section, key, value }` rows for the Settings Table tab. Sections: Core, Capabilities, Authentication, Skills #N.

## Error Handling Patterns

| Scenario | Handling |
|---|---|
| Network / CORS failure on card fetch | Catches thrown error, emits wire log with status 0, re-throws with descriptive message |
| HTTP error on card fetch | Throws with status code |
| JSON-RPC error envelope | Throws with `error.message` |
| HTTP error on RPC call | Throws with status code |
| SSE stream error | Catches in `sendChatMessage`, renders error bubble, sets error state |
| Invalid JSON in params field | Caught before any network call, shown in error box |
| Non-object agent card payload | Detected in connect handler, shown in error box |

## Wire Inspector Data Model

`WireLogEntry` stores:

- operation metadata
- URL
- request/response headers
- request/response body
- HTTP status details

UI renders entries with expandable details for debugging.
