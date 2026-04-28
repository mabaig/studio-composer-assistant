# Studio Composer Assistant — Developer Guide

## Purpose

Chat interface that generates Salesforce FlexiPage JSON from natural language prompts via the Intellinum Composer Skills streaming API. Users type a prompt (or pick an example), optionally attach a JSON file as code context, and see the streaming response rendered on the right. A built-in code reviewer runs automatically and shows a pass/fail checklist.

---

## Stack

- **Backend**: Node.js ≥18 · Express · native `fetch` (streaming proxy)
- **Frontend**: Vanilla JS · `marked.js` (CDN) for markdown · no build step
- **API**: `https://copilot-chat.intellinum.com/composer_skills/stream`
- **Brand**: `#F47920` orange · `#222E5F` navy · `#009FDE` cyan
- **Theme**: Dark (VS Code style — `#0d0d0d` bg) + Light toggle; persisted in `localStorage`

---

## Project Structure

```
studio-composer-assistant/
├── server.js        # Express server — streaming proxy + /api/review endpoint
├── reviewer.js      # FlexiPage code reviewer (9 checks, ported from Python)
└── public/
    ├── index.html   # Login overlay + 42/58 split layout (chat | response viewer)
    ├── styles.css   # Dark/light CSS custom-property theme system
    ├── app.js       # Streaming client, JSON/markdown renderer, review UI
    └── favicon.svg  # Orange hexagon logo
```

---

## Composer API

**Endpoint**: `POST https://copilot-chat.intellinum.com/composer_skills/stream`

**Request body**:
```json
{
  "input": {
    "messages": [{ "role": "user", "content": "<user prompt>" }],
    "thread_id": "<session UUID>",
    "model": "pro",
    "code": "<attached JSON content, or \"Base\" if no file>"
  }
}
```

| Field | Rule |
|-------|------|
| `input.messages` | Array with single user message |
| `input.code` | Content of attached JSON file; defaults to `"Base"` when no file |
| `input.thread_id` | UUID generated once per page load — never changes mid-session |
| `input.model` | Always `"pro"` |

**Response shape** (accumulated from stream):
```json
{
  "output": {
    "flexipage": { ... },
    "validation": { "is_valid": true, "errors": [] },
    "mode": "create"
  },
  "metadata": {
    "thread_id": "...",
    "usage": { "input_tokens": 0, "output_tokens": 0, "cost_usd": { "total": 0 } }
  }
}
```

---

## Streaming Mechanics

**Backend** (`POST /api/stream`):
- Forwards body to Composer API with `Authorization: Bearer <token>` header
- Pipes raw SSE bytes back to browser via `Readable.fromWeb(upstream.body).pipe(res)`

**Frontend** (line-by-line SSE parsing):
- `{"token":"..."}` events → accumulate `.token` value, show in `<pre>` with auto-scroll
- `{"output":{...}}` event → final result; render JSON viewer + auto-run reviewer
- Fallback: if stream ends with no `output` event → render accumulated text as markdown

**Token extraction** (key pattern in `app.js`):
```javascript
if (parsed.token !== undefined) { tokenAccum += parsed.token; pre.textContent = tokenAccum; }
```

---

## UI Layout

```
┌────────────────────────────────────────────────────────┐
│  Header  [Studio Composer]                  [New Chat] │
├────────────────┬───────────────────────────────────────┤
│  Chat  (30%)   │  Response  (70%)                      │
│                │  ┌──────────────────────────────────┐ │
│  Message       │  │ Formatted JSON or Markdown        │ │
│  history       │  │ (live streaming, auto-scroll)     │ │
│                │  └──────────────────────────────────┘ │
│  Examples:     │  [↓ Download flexipage.json]          │
│  [chip][chip]  │                                       │
│  [chip]        │                                       │
│                │                                       │
│  [📎][input  ] │                                       │
│       [Send]   │                                       │
└────────────────┴───────────────────────────────────────┘
```

---

## Example Prompts

Shown as clickable chips in the chat panel — clicking fills the input:

- `"Create a receiving page with org and quantity fields and a Submit button"`
- `"Add a barcode scan field to an existing inventory page"`
- `"Build a cycle count page with location and item fields"`

---

## Response Rendering

| State | Behaviour |
|-------|-----------|
| Streaming | Raw text in `<pre>`, auto-scroll to bottom |
| Stream end — JSON | `JSON.stringify(output.flexipage, null, 2)` in syntax-highlighted `<pre><code>` |
| Stream end — markdown | Render buffer with `marked.parse()` |
| `output.flexipage` present | Show **↓ Download flexipage.json** button |

Download saves `output.flexipage` as `flexipage.json` via a temporary `<a>` with `Blob` URL.

---

## File Attachment

- `<input type="file" accept=".json">` icon button in the chat input row
- File read with `FileReader.readAsText()`, stored in memory as a string
- Content sent as `input.code` on submit
- Attached filename shown as a removable chip above the text input
- Cleared on **New Chat**; defaults `input.code` to `"Base"` when no file

---

## Session Management

- **Thread ID**: `crypto.randomUUID()` on page load, stored in `sessionStorage`
- **New Chat** button: clears message history, generates a new thread ID, removes attached file, clears the response panel

---

## Environment Variables

```bash
COMPOSER_API_URL=https://copilot-chat.intellinum.com/composer_skills/stream
COMPOSER_API_TOKEN=          # Bearer token for the Composer API
PORT=3000
```

Copy `.env.example` → `.env` and fill in values.

---

## Local Setup

```bash
npm install
npm run dev   # → http://localhost:3000
```

---

## Constraints

- Never call the composer API directly from the browser — always proxy through the backend
- Thread ID must be stable for the full session — do NOT regenerate per message
- `input.code` must always be present in the request body (use `"Base"` as default)
- No authentication or API key required for the composer API (public endpoint)
- Keep frontend simple vanilla JS — no frameworks, no build step
- Do NOT add a chatbot fallback or intent detection layer — this is a pass-through UI
