/**
 * Provider-agnostic LLM interface.
 *
 * The agent loop (src/agent.ts) only talks to this interface, so adding another
 * provider (OpenAI, Anthropic, ...) is a single new file in src/llm/ that
 * implements `LlmProvider`.
 */

export interface ToolCall {
  name: string;
  args: Record<string, unknown>;
  /** Provider-side id used to correlate the result with the call. */
  id?: string;
}

export interface ToolResult {
  name: string;
  /** JSON-serialised payload handed back to the model. */
  output: string;
  /** Must match the originating call's id when the provider needs it. */
  id?: string;
}

/**
 * One turn of the conversation.
 *
 * `opaque` is provider-specific state that must be replayed verbatim on the
 * next request (e.g. Gemini thought signatures attached to a function call).
 * The agent loop treats it as an opaque blob and never inspects it.
 */
export interface Turn {
  role: 'user' | 'assistant';
  text?: string;
  toolCalls?: ToolCall[];
  toolResults?: ToolResult[];
  opaque?: unknown;
}

export interface ToolSpec {
  name: string;
  description: string;
  /** JSON Schema (draft-07 style, lowercase types). */
  parameters: Record<string, unknown>;
}

export interface LlmRequest {
  system: string;
  turns: Turn[];
  tools?: ToolSpec[];
  /** When present, the provider must return JSON matching this schema. */
  responseSchema?: Record<string, unknown>;
}

export type LlmEvent =
  | { type: 'text'; text: string }
  | { type: 'tool_calls'; calls: ToolCall[]; opaque?: unknown }
  | { type: 'status'; message: string };

export interface LlmProvider {
  readonly name: string;
  /** The model currently in use. Changes when the provider falls back. */
  readonly model: string;
  /** The model this provider was configured with, before any fallback. */
  readonly primaryModel: string;
  /** Request counters, for reporting. Reset per provider instance. */
  readonly stats: { retries: number; fallbackUsed: boolean };
  stream(req: LlmRequest): AsyncIterable<LlmEvent>;
  structured<T>(req: LlmRequest): Promise<T>;
}
