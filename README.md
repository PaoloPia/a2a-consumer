# A2A Consumer SPA

A React single-page application for interacting with any A2A v1.0 compatible agent directly from the browser.

## Features

- Configure agent card JSON URL and optional OAuth bearer token.
- Connect to the agent: fetches and validates the agent card automatically.
- Inspect the agent card with three tabs:
  - **Summary & Validation** — key fields plus structural issue report.
  - **Raw JSON** — formatted full payload.
  - **Settings Table** — flattened key/value view of all card sections.
- **Chat interface** for `SendMessage` / `SendStreamingMessage`:
  - User and agent bubbles with timestamps.
  - Agent responses rendered as rich Markdown (GFM): headings, lists, tables, code blocks, blockquotes, inline code, links, bold/italic, and emojis.
  - Streaming messages build progressively with a blinking cursor; `Enter` sends, `Shift+Enter` inserts a newline.
- **Advanced operation runner** for all A2A v1.0 JSON-RPC methods:
  - `SendMessage`, `SendStreamingMessage`
  - `GetTask`, `ListTasks`, `CancelTask`, `SubscribeToTask`
  - `CreateTaskPushNotificationConfig`, `GetTaskPushNotificationConfig`, `ListTaskPushNotificationConfigs`, `DeleteTaskPushNotificationConfig`
  - `GetExtendedAgentCard`
- **Task monitor** table — lists tracked tasks with Get, Cancel, and Subscribe actions per row.
- **Wire inspector** (magnifier button) — expands to show URL, request headers, response headers, request body, and response body for every A2A call including streams.
- **Reset** command — clears connection, chat history, tasks, wire logs, and all runtime state.
- Light and dark mode toggle.
- Responsive layout (desktop and mobile).

## CORS and the dev proxy

Browsers block cross-origin requests to most A2A agent endpoints. During development the Vite dev server runs a transparent HTTP proxy at `/__a2a_proxy__/<encoded-url>`. All outgoing A2A requests are automatically routed through it so no CORS headers are needed on the agent side.

In a **production build** the proxy is not present. The target A2A server must expose the appropriate `Access-Control-Allow-*` headers, or the SPA must be served from the same origin as the agent.

## Run

```bash
npm install
npm run dev      # development server with built-in CORS proxy
```

Build for production:

```bash
npm run build
npm run preview  # preview the production build locally
```

## Documentation

- [`docs/FUNCTIONALITIES.md`](docs/FUNCTIONALITIES.md)
- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md)
- [`docs/IMPLEMENTATION_DETAILS.md`](docs/IMPLEMENTATION_DETAILS.md)
