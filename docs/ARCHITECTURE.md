# Architecture Choices

## Overview

The application is a client-side React SPA built with Vite and TypeScript. The architecture is split into three layers:

| Layer | File(s) | Responsibility |
|---|---|---|
| Protocol transport | `src/lib/a2a.ts` | HTTP/SSE fetch, JSON-RPC envelope, wire logging, text extraction |
| State & orchestration | `src/App.tsx` | React state, event handlers, UI composition |
| Dev proxy | `vite.config.ts` | Node.js middleware that forwards requests to bypass browser CORS |

This separation keeps protocol concerns out of rendering code and makes the transport layer independently testable.

## Core Architectural Decisions

### 1. Single-page, state-driven design

All runtime state lives in React state hooks:

- connection and agent card state
- validation state
- chat message history
- task monitor cache
- stream event log
- wire capture log

No router, no external state manager. State resets fully on the Reset command.

### 2. Protocol client abstraction (`A2AClient`)

`A2AClient` centralises all network responsibilities:

- CORS-safe agent card GET (no custom headers)
- JSON-RPC 2.0 POST with `A2A-Version` header
- SSE stream consumption via `ReadableStreamDefaultReader`
- Wire capture logging for every request path

### 3. Dev proxy for CORS bypass

Browsers enforce CORS on all cross-origin `fetch` calls. The `a2aDevProxy` Vite plugin adds a Node.js middleware to the dev server at `/__a2a_proxy__/<encoded-url>`. The client function `resolveViaProxy(url)` rewrites URLs to go through it when `import.meta.env.DEV` is `true`.

This means:
- CORS preflight OPTIONS requests are answered locally without touching the agent.
- The actual HTTP call comes from Node.js, which is not subject to CORS.
- SSE streams are piped byte-for-byte without buffering.
- In production builds the proxy is absent; the original URL is used unchanged.

### 4. Two-step connect flow

1. Fetch agent card from the user-provided URL (CORS-safe headers only: `Accept`, optional `Authorization`).
2. Resolve the runtime service endpoint from the card's `url` or `endpoint` field, then instantiate a separate `A2AClient` for all RPC calls.

This supports agents where the card-hosting URL and the RPC endpoint differ.

### 5. Chat message state model

Chat messages are stored as `ChatMessage[]`:

```ts
type ChatMessage = {
  id: string
  role: 'user' | 'agent'
  content: string        // markdown text
  timestamp: string
  isStreaming?: boolean  // true while SSE is still open
  isError?: boolean
}
```

For streaming, a placeholder agent bubble is inserted immediately with `isStreaming: true`. Each SSE event calls `extractStreamChunk` and patches that single message in the array using the functional `setState` form to avoid stale-closure bugs. When the stream closes, `isStreaming` is set to `false`.

For non-streaming, the agent bubble is appended only after the response resolves.

### 6. Markdown rendering

`react-markdown` with the `remark-gfm` plugin renders all agent messages. It handles: headings, paragraphs, bold/italic, lists, tables, fenced code blocks, blockquotes, inline code, links, horizontal rules, and emoji. Raw HTML in agent content is not evaluated (default `react-markdown` behaviour), preventing XSS.

### 7. Task ingestion

Incoming payloads (from both streaming and blocking calls) are passed through:

- `extractTaskFromPayload` — extracts a single task
- `extractTasksFromListPayload` — extracts an array from `ListTasks`

The task cache is upserted by task ID so partial updates from streaming merge correctly with previously seen data.

### 8. Wire-observability by design

Every request path emits a `WireLogEntry`. For streaming calls the entry is emitted after the stream closes, carrying the full accumulated response body. For network-level failures (CORS, DNS) an entry with `statusCode: 0` is emitted in the catch block.

### 9. Theme architecture

Theme uses CSS custom properties scoped to `data-theme`:

- `:root` — light palette
- `[data-theme='dark']` — dark palette

A `useEffect` writes the attribute to `document.documentElement` when the toggle state changes. No runtime style injection or re-render overhead.

## Security Considerations

- Bearer token is held in React state (memory only), never written to `localStorage` or cookies.
- The dev proxy is only active during `npm run dev`; it is not included in production builds.
- `react-markdown` does not evaluate raw HTML from agent responses, preventing XSS via crafted markdown.
- Agent card and RPC responses are parsed with `JSON.parse`; invalid JSON throws a typed error rather than silently failing.
