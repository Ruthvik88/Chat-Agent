# minimi

A chat agent with exactly one tool: web search. Persistent conversation memory with absolute
timestamps, deterministic relative-date resolution, and a "re-verify my old answer" flow.

Design rationale: **[DESIGN.md](./DESIGN.md)**.

## Run it

```bash
npm install
cp .env.example .env     # GEMINI_API_KEY + TAVILY_API_KEY
npm run dev              # http://localhost:3000
```

Free keys:

- `GEMINI_API_KEY` — <https://aistudio.google.com/apikey>
- `TAVILY_API_KEY` — <https://app.tavily.com/home>

Both free tiers are limited (Gemini: ~20 requests/day *per model*; Tavily: 1 000 search credits/month),
so the agent keeps two different Gemini models, switches between them automatically, and skips a
saturated model for five minutes with a circuit breaker. A model that holds the connection open
without answering is caught by a first-token deadline (`PRIMARY_TTFT_TIMEOUT_MS`, default 5 s) and
fails over the same way.

## API

```bash
curl -N -X POST http://localhost:3000/api/chat \
  -H 'content-type: application/json' \
  -d '{"message":"Has Neon changed pricing since Tuesday?","sessionId":"demo","timezone":"Asia/Kolkata"}'
```

`POST /api/chat` accepts an optional `history` array of `{role, content, timestamp}` to seed a prior
conversation; each turn is stored with its original timestamp.

Server-sent events: `delta` (text), `tool` (search performed), `status` (notices: re-verify stages,
model fallback, loaded history), `sources` (cited URLs), `error`, `done`.

The `done` event carries per-request metrics:

```json
{"sessionId":"demo","ttft_ms":2720,"answer_ttft_ms":1270,
 "model_used":"gemini-3.5-flash-lite","primary_model":"gemini-3.8-flash",
 "retries":0,"fallback_used":true,"search_calls":4,"total_ms":3098,
 "extract_ms":1426,"search_ms":8}
```

`ttft_ms` is time to first token; `answer_ttft_ms` is the answering step's own first token;
`search_calls` counts every Tavily call in the turn, from the re-verify flow and the agent loop
together; `extract_ms`/`search_ms` are the re-verify stages. `model_used` is the model
that actually answered and `primary_model` the one configured, so a fallback is never ambiguous. The
server logs the same line to its console.

`GET /api/health` reports which keys are missing. `GET /api/sessions/:id` returns the message turns
of one session, so the page restores a conversation after a refresh.

## The page

One column, one file, no build step and no dependencies. Answers stream in as markdown — headings,
lists, links, code and tables — with the re-verify result rendered as a table of claims, verdicts
and dated evidence. Progress shows as status chips that are replaced by the answer when it starts.
Sources are numbered links with the date each page was published. Light and dark follow
`prefers-color-scheme`, every turn carries the day it was given, and the layout reflows to 320px.

A **Stop** button aborts a turn in flight, and the server ends the agent loop with it rather than
letting it spend the rest of the model's daily quota. **New chat** starts a fresh session;
conversations are restored from the server on refresh.

## Environment

| Variable | Purpose |
| --- | --- |
| `GEMINI_API_KEY` | Gemini API key |
| `TAVILY_API_KEY` | Tavily search key |
| `USER_TIMEZONE` | Default timezone for date resolution (default `Asia/Kolkata`) |
| `PORT` | HTTP port (default `3000`) |
| `MODEL` / `FALLBACK_MODEL` | Primary and secondary model; quotas are counted per model, so they should differ. Defaults: `gemini-3.8-flash` / `gemini-3.5-flash-lite` |
| `STRUCTURED_MODEL` | Model used for structured calls (claim extraction). Default `gemini-3.5-flash-lite` |
| `PRIMARY_TTFT_TIMEOUT_MS` | How long the primary model has to produce its first token before the request fails over and the breaker opens (default `5000`; `0` disables) |
| `NOW_OVERRIDE` | ISO datetime that replaces the clock, for demos and evals |

## Scripts

| Command | What it does |
| --- | --- |
| `npm run dev` | Start the server with reload |
| `npm test` | Date resolver, memory, re-verify, Gemini adapter, model failover, circuit breaker, Tavily schema, agent loop and context injection |
| `npm run eval` | End-to-end scenarios against a live server: the brief examples with seeded history, a date question with no history, chit-chat, and a prompt injection. Prints pass/fail, time to first token, total time and searches per scenario |
| `npm run typecheck` | `tsc --noEmit` |

`npm run eval -- --live` uses the real Gemini API. **Searches are stubbed unless `TAVILY_API_KEY` is
set** — the eval says so in its output, because a stubbed search proves the flow, not the data.
Each scenario runs on its own server and data directory, so one scenario's conversation cannot become
the next scenario's context.

## Layout

```
src/
  server.ts      Express + SSE, serves the UI
  agent.ts       Agent loop (one tool, parallel calls, step and time budgets)
  llm/           LlmProvider interface + Gemini implementation + circuit breaker
  search/        SearchProvider interface + Tavily implementation
  memory/        JSONL store, date resolver, recall, re-verify flow
  public/        Single-page chat UI (index.html) and its markdown renderer (markdown.js)
eval/            Scenario eval: the harness, the checks, and the injectable search stub
```
