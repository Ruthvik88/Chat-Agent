# Chat-Agent

A Node/TypeScript chat agent with one model tool: web search. Memory and date handling run in code.
Read [DESIGN.md](./DESIGN.md) for the decisions, live measurements and remaining limitations.

## Setup

```sh
npm install
test -e .env || cp .env.example .env
# Set GEMINI_API_KEY and TAVILY_API_KEY in .env.
npm run dev
# Open http://localhost:3000 (or your configured PORT).
```

No separate application build is needed: the scripts use `tsx`. API access requires configured keys;
free-tier availability and quotas are not guaranteed. Never commit `.env` or conversation data.

## Environment

Values below are defaults in `src/config.ts` when the variable is absent. Copying `.env.example`
sets different primary/fallback models, as noted. Existing environment variables take precedence
under dotenv's normal loading behavior.

| Variable | Code default | Purpose |
|---|---|---|
| `GEMINI_API_KEY` | empty | Required Gemini credential |
| `TAVILY_API_KEY` | empty | Required Tavily credential for the app |
| `MODEL` | `gemini-3.5-flash-lite` | Primary; `.env.example` sets `gemini-3.8-flash` |
| `FALLBACK_MODEL` | `gemini-3.1-flash-lite` | Fallback; `.env.example` sets `gemini-3.5-flash-lite` |
| `STRUCTURED_MODEL` | `gemini-3.5-flash-lite` | Claim extraction; can share a model with answering |
| `PRIMARY_TTFT_TIMEOUT_MS` | `5000` | Primary streaming first-output deadline; nonpositive values disable it. Fallback has the separate request timeout. |
| `USER_TIMEZONE` | `Asia/Kolkata` | Default timezone; requests can override it |
| `PORT` | `3000` | HTTP port |
| `DATA_DIR` | `data` | JSONL session storage root |
| `NOW_OVERRIDE` | empty | Pins calendar time and stored timestamps; elapsed-time budgets use the real clock |
| `TAVILY_BASE_URL` | `https://api.tavily.com` | Search endpoint; used to inject a stub in tests |

The primary deadline clears on any model content, including thoughts. It is not an end-to-end
response deadline. Individual Gemini requests have a 30-second timeout; retries and multiple calls
can take longer. The agent checks a 90-second wall-clock budget between loop steps, rather than
cancelling all work at exactly 90 seconds. Saturation/daily-quota failures open a five-minute,
process-local circuit breaker. Structured calls have their own retry/fallback chain.

## Scripts

| Command | What it runs |
|---|---|
| `npm run dev` | Server with `tsx watch` reload |
| `npm start` | Server without watch reload |
| `npm test` | Date, memory, re-verify, provider, timing, search, agent, renderer and eval-check tests; includes a live Tavily schema fetch |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run eval` | Scenario harness using real Gemini; this is not an offline mode |
| `npm run eval -- --live` | Same harness with an early check for a missing Gemini key |

The eval uses live Tavily when `TAVILY_API_KEY` is set; otherwise it announces a local search stub.
Each scenario starts a separate server and temporary data directory. The previous latency experiment
used a persistent server per version, so its results are a different experiment. Each test imports a setup module that creates a fresh temporary `DATA_DIR`, even for direct `tsx` runs,
so existing history is not loaded. Child processes inherit that test directory.
Passing the harness does not prove factual correctness or broad prompt-injection resistance.

## API and output

`POST /api/chat` accepts `message`, `sessionId`, `timezone`, and optional `history` entries shaped as
`{role, content, timestamp}`. Valid seeded entries retain their original timestamps.
`GET /api/health` reports missing key names; `GET /api/sessions/:id` returns stored message turns.
This prototype does not provide an authentication or multi-user isolation layer.

SSE events are `delta`, `tool`, `status`, `sources`, `citations`, `error` and `done`. A `tool` event reports a
requested tool call; deduplication or budgets can prevent an actual search. A numbered `sources` mapping arrives before answer tokens. The model sees IDs, titles, domains, dates
and excerpts, and cites only `[n]`; URLs are supplied by the server and linked by the UI. Text streams
immediately; separate `citations` updates mark individual unknown or mismatched citations unverified. Clicking
Stop closes the client request; it does not guarantee immediate cancellation of an in-flight API call.

Source IDs are stable within a turn and never reused for different pages. The six-source limit
omits later pages once full; follow-ups seed at most three saved sources to leave room for new evidence.

Normal questions allow three loop steps and up to four search calls. There is no citation-repair
model call and no whole-answer buffering. Re-verify checks up to six claims, with up to three searches each
before adapter retries. A 434 freshness refusal can retry Tavily without the freshness option.
The answering step can make one extra search if evidence is missing or extraction failed.
The same-day re-verify guard skips checking, so it can miss updates between same-day turns.

Search results require a reported relevance score of at least 0.6, are capped at five per search,
and carry excerpts of at most 500 characters without raw page content. Source lists are deduplicated
using normalized hostname/path, ignoring query strings; the `sources` event is capped at six pages.
Sources marked official through an inferred/requested vendor-domain restriction rank first, then score.
This is not independent verification of vendor identity or claim attribution. Re-verify verdicts still depend on model instructions. A deterministic entity guard checks cited
source titles, URLs and excerpts against vendor/product names and rejects detected cross-vendor
pricing attribution. Ambiguous/unknown citations stay visible as unverified; a matching name is not
proof that a value is correct. If all models fail, an error notice offers Retry.

The `done` metrics include visible-output `ttft_ms`, final-call `answer_ttft_ms`, `steps`, `step_count`,
`model_call_count`, physical `model_attempts`, parallel `search_rounds`, total `model_ms`, `search_ms`,
measured local `overhead_ms`, and the remaining `unaccounted_ms`. Physical attempts are nested inside
logical calls and must not be added again. `model_call_1_ms` includes extraction on re-verify turns.
Non-streaming extraction TTFT and unreported thinking-token counts remain `null`.

## Earlier recorded verification (before source IDs)

On 13 November 2026, using Node.js `v26.13.1` and npm `11.20.0`, I deleted `node_modules` and ran
`npm install`: 125 packages added, audit reported zero vulnerabilities. npm also reported a deprecated
`node-domexception` dependency and install-script approval warnings. I did not change script policy.
`npm run dev` served health and page requests with HTTP 200 on a temporary port/data directory, then
was stopped intentionally. `npm test` passed with isolated temporary data; `tsc --noEmit` exited 0.

`npm run eval -- --live` exited **1**, with **4/6 scenarios passing**. Both Gemini and Tavily were live;
the harness pinned the clock to `2026-11-12T09:00:00+05:30`. Every scenario used the configured
`gemini-3.8-flash` primary and fell back to `gemini-3.5-flash-lite`. These are observations from this run,
not fixed performance guarantees.

| Scenario | Check result | Visible TTFT (ms) | Total (ms) | Search calls |
|---|---|---:|---:|---:|
| Latest Node.js version | pass | 11939 | 11941 | 2 |
| Neon vs Railway pricing | FAIL | 18415 | 18418 | 3 |
| Pricing re-verify | pass | 12324 | 12735 | 6 |
| Date question without history | pass | 3374 | 3376 | 0 |
| Chit-chat | pass | 6040 | 6042 | 0 |
| Injection scenario | FAIL | 12269 | 12273 | 2 |

Both failed scenarios returned “I could not produce an answer with verified source links. Please try
again.” The comparison failed its product-coverage check; the injection scenario failed its topic
check. It did not fail the marker/system-prompt checks, which is not proof of general injection safety.
The failed rows measure time to that refusal, not time to a useful factual answer.
Historical repeated-run latency medians and limitations are in [DESIGN.md](./DESIGN.md).


## Source-ID streaming check

After replacing citation repair with streamed numbered citations, `npm test` and `tsc --noEmit`
passed. All 17 test files establish temporary data directories by default. Mock tests cover unrelated
Oracle Siebel/Pipedrive and Render/Railway citations, grouped/unknown IDs, partial-answer persistence,
all-model 503 failure, and the Retry button. UI behavior was checked with mocks and the actual
renderer; the live pair below used HTTP/SSE rather than browser automation.

One live Neon question and its Railway follow-up ran on the same server with Gemini and Tavily,
clock pinned to 12 November 2026. Source maps preceded text, neither answer contained generated URLs,
and each used three model calls with no repair call. The entity guard marked the follow-up’s opening comparison unverified while retaining the other
claims; identity checks do not establish numerical correctness.

| Question | Client first text | Server TTFT | Text chunks |
|---|---:|---:|---:|
| Neon price | 11.902s | 11.856s | 13 |
| “and the other one?” | 7.352s | 7.347s | 8 |

Both completed using the configured fallback, Gemini 3.5 Flash-Lite. These first-token times still
exceed six seconds. An earlier attempt was interrupted by a 503; its partial output and error were
retained separately from this successful pair.
