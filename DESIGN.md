# How I built minimi

I built a Node/TypeScript chat agent with one model tool, `web_search`. Express accepts a message, timezone and optional timestamped history. My context builder combines recent turns with recall across stored sessions. A deterministic date resolver supplies calendar dates and alternatives for ambiguous phrases. I keep memory in code, rather than a recall tool, so context selection happens before the model decides what to do. This also keeps date handling testable without an API call.

For change questions, an optional code pipeline finds an earlier answer, asks Gemini to extract its claims, and searches in parallel. It checks at most six claims and passes overflow names to the answering model for disclosure. I rejected a separate verdict LLM call: the answer step already reads the evidence. Instructions distinguish confirmation from a dated change, but the verdict remains a model judgment.

My agent loop offers only web search. Normal requests get three loop steps, with the last reserved for an answer. Re-verify permits six loop steps. I use a small loop rather than an agent framework because I can inspect its budgets and call sequence directly. SSE carries progress, text, sources, errors and timing metadata. Answers stream immediately. The server sends numbered sources first; the UI links citations and labels entity mismatches or unknown IDs unverified, without a repair call.

I store turns as JSONL with UTC timestamps and timezones. I can inspect the files without database tooling. I would move to SQLite when indexed queries or coordinated writes become necessary. I rejected vector memory for this version because lexical recall and explicit dates are easier for me to inspect; I have not measured semantic recall quality.

I use Tavily publish-date windows to look for announcements since an answer, plus freshness searches for pages edited in place. Neither proves what a page said historically. Vendor-domain searches are added when a domain is inferred. Results below 0.6 relevance are dropped; excerpts are capped at 500 characters. I deduplicate pages and cap the source list at six ranked entries. These controls reduce volume, not the need to check attribution.

My code defaults to Gemini 3.5 Flash-Lite with 3.1 Flash-Lite fallback. The timing experiment instead configured 3.8 Flash, which fell back to 3.5 Flash-Lite. Free-tier failures motivate a five-minute circuit breaker, a five-second primary first-output deadline and fallback. Thinking is explicitly low or minimal, depending on the model. I have not proved which model is best.

Before source IDs, the clean-install live eval passed four of six scenarios. Pricing comparison and injection-topic checks failed because citation repair withheld both answers. Gemini and Tavily were live; the clock was pinned to 12 November 2026. That earlier experiment measured visible first text three times per question:

| Median | Before | After |
|---|---:|---:|
| Node.js version | 17.33s | 11.23s |
| Neon price | 4.92s | 8.24s |

Neon's third baseline made no fresh search. All six timing after-runs searched; model time dominated and unaccounted time was zero. I missed the six-second target. A newer source-ID pair streamed first text at 11.902s/7.352s, with no repair call. Live answers have still misattributed another vendor's price despite valid links. Same-day re-verification is skipped. My eval checks are limited assertions, not proof of factual accuracy or injection resistance.

With another week, I would test one parallel search round followed by synthesis, improve attribution checks, and investigate the proposed Exa `snapshotAsOf` idea. That API and historical coverage are unverified here; none of these changes is implemented.
