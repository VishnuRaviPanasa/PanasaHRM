/**
 * The model adapter. ADR-0020.
 *
 * NO SDK (DEC-134). One endpoint, called three times a turn with a fixed request shape, against
 * a wire format that is stable and small. CLAUDE.md lists adding a dependency without recording
 * why under Forbidden Actions, and this repo already talks to Postgres and MinIO without an SDK
 * ceremony - `browser-verify.mjs` drives a real browser over CDP rather than installing
 * Playwright (DEC-125), which is the same call.
 *
 * WHAT LEAVES THIS PROCESS. The user's question, the tool catalogue (names, descriptions,
 * parameter schemas) and - for the answer call - THE MASKED RESULT ROWS. That last one is
 * DEC-140, which reversed ADR-0020 section 3's "no row of employee data is sent to the model" so
 * that the assistant could state a figure rather than describe a table. The rows are exactly the
 * array the browser is shown in the same turn; `answer.ts` carries the full argument for why
 * that is bounded, and is honest that prompt injection is now contained rather than impossible.
 * `HRM_LLM_ANSWER_FROM_ROWS=false` restores the original posture.
 *
 * WHAT IS NEVER LOGGED. The key, obviously. But also the prompt: it carries the user's question,
 * which `data-inventory.md` classifies PERSONAL, and `security-guidelines.md` bars full request
 * bodies outright. Failures log a shape - status, latency, message count - never content.
 *
 * MUST-KNOW RULE 12. This is a synchronous outbound call from the request path, which ADR-0020
 * permits as a NAMED exception, conditional on the four controls implemented here: a hard
 * timeout below the request budget, at most one retry, a circuit breaker, and containment - a
 * provider outage refuses the assistant and touches nothing else.
 */

import type { OnModuleInit } from '@nestjs/common';

const DEFAULT_BASE_URL = 'https://api.openai.com/v1';
const DEFAULT_MODEL = 'gpt-4o-mini';
const DEFAULT_TIMEOUT_MS = 12_000;

/** Consecutive failures before the breaker opens, and how long it stays open. */
const BREAKER_THRESHOLD = 4;
const BREAKER_COOLDOWN_MS = 60_000;

export class LlmUnavailable extends Error {
  constructor(readonly code: 'disabled' | 'timeout' | 'provider_error', message: string) {
    super(message);
  }
}

export interface ToolSchema {
  readonly name: string;
  readonly description: string;
  /** JSON Schema for the arguments. */
  readonly parameters: Record<string, unknown>;
}

export interface ChatMessage {
  readonly role: 'system' | 'user' | 'assistant';
  readonly content: string;
}

export interface ChatResult {
  readonly content: string | null;
  readonly toolName: string | null;
  readonly toolArgs: Record<string, unknown> | null;
  readonly model: string;
  readonly promptTokens: number;
  readonly completionTokens: number;
}

/**
 * Read one configuration variable, treating BLANK AS UNSET.
 *
 * This is not defensive tidying, it is a correctness requirement. An EMPTY STRING is what an
 * env file with a bare `VAR=` hands over, and what a compose `${VAR:-}` substitution resolves to
 * when nobody set the variable - and `''` is not nullish, so `process.env.X ?? DEFAULT` takes
 * `''` as the answer. An unset `HRM_LLM_MODEL` would become a request for a model named `""`,
 * and an unset `HRM_LLM_TIMEOUT_MS` would become `Number('') === 0`, aborting every call on a
 * zero-millisecond deadline. Both surface as a provider error with nothing pointing at the
 * cause. Trimming also means a stray trailing space - easy to paste into a `$env:` assignment -
 * cannot silently disable the feature switch.
 */
function env(name: string): string | undefined {
  const raw = process.env[name];
  if (raw === undefined) return undefined;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/** A timeout must be a positive finite number; anything else is a misconfiguration, not a value. */
function positiveIntOr(raw: string | undefined, fallback: number): number {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/**
 * Read the key. `HRM_LLM_API_KEY_FILE` is the production path, because
 * `security-guidelines.md` requires file-backed secrets and says in terms: "Never plain
 * environment variables. Never a build arg; they persist in image layers." It takes precedence
 * when both are set, so a deployment that mounts a secret cannot be undercut by a stray
 * variable in the environment.
 *
 * The plain variable is accepted for local development, where the alternative is a developer
 * inventing something worse - and it warns, once, so the shortcut stays visible rather than
 * becoming silently normal (DEC-129).
 *
 * Nothing in this repository wires either one into a production container; that is a deployment
 * decision and the code deliberately accepts both shapes.
 */
let warnedAboutPlainKey = false;
function readApiKey(): string | null {
  const file = env('HRM_LLM_API_KEY_FILE');
  if (file) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const key = require('node:fs').readFileSync(file, 'utf8').trim();
      return key.length > 0 ? key : null;
    } catch {
      // The path is configuration, not a secret, so naming it is safe and saves an outage.
      console.error(`[assistant] HRM_LLM_API_KEY_FILE is set but unreadable: ${file}`);
      return null;
    }
  }
  const plain = env('HRM_LLM_API_KEY');
  if (plain !== undefined) {
    if (!warnedAboutPlainKey) {
      warnedAboutPlainKey = true;
      console.warn(
        '[assistant] using HRM_LLM_API_KEY from the environment. It is readable in ' +
        '`docker inspect` and /proc/<pid>/environ; for any deployment use HRM_LLM_API_KEY_FILE ' +
        'instead - security-guidelines.md requires file-backed secrets (DEC-129).',
      );
    }
    return plain;
  }
  return null;
}

export class Llm implements OnModuleInit {
  private failures = 0;
  private openedAt = 0;

  readonly model = env('HRM_LLM_MODEL') ?? DEFAULT_MODEL;
  private readonly baseUrl = (env('HRM_LLM_BASE_URL') ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
  private readonly timeoutMs = positiveIntOr(env('HRM_LLM_TIMEOUT_MS'), DEFAULT_TIMEOUT_MS);

  /**
   * Say at boot whether the assistant is on, and if not, exactly why.
   *
   * Worth the four lines. The feature is off by default and takes two variables to switch on, so
   * "it is not working" has a boring cause almost every time - a variable that never reached the
   * process. Without this the only symptom is a polite refusal in the chat panel, which looks
   * identical whether the operator forgot the flag, mistyped it, or used shell syntax their shell
   * ignores (`VAR=x node ...` sets nothing in PowerShell and reports no error).
   *
   * NEVER prints the key, or its length, or a prefix of it. Only which variable supplied it.
   */
  onModuleInit(): void {
    if (this.enabled) {
      const via = env('HRM_LLM_API_KEY_FILE') ? 'HRM_LLM_API_KEY_FILE' : 'HRM_LLM_API_KEY';
      console.log(
        `[assistant] ENABLED - model=${this.model} base=${this.baseUrl} ` +
        `timeout=${this.timeoutMs}ms key from ${via}`,
      );
      // Said at boot, every boot. Whether row values leave the country is not something an
      // operator should have to read the source to establish (DEC-140).
      console.log(
        this.answerFromRows
          ? '[assistant] answers are written FROM ROW VALUES - masked result rows are sent to ' +
            'the provider (ADR-0020 s3 as amended, DEC-140). Set HRM_LLM_ANSWER_FROM_ROWS=false ' +
            'to send only column names and a row count.'
          : '[assistant] HRM_LLM_ANSWER_FROM_ROWS=false - no row value is sent to the provider; ' +
            'the sentence above each table is deterministic.',
      );
    } else {
      console.log(`[assistant] disabled - ${this.disabledReason}`);
    }
  }

  /**
   * Off unless an operator turns it on AND a key is present. ADR-0020: "a deployment that has
   * not chosen this has not taken the dependency."
   */
  get enabled(): boolean {
    return env('HRM_ASSISTANT_ENABLED') === 'true' && readApiKey() !== null;
  }

  /**
   * Whether the ANSWER is written from the row values, or only from the shape of the result.
   *
   * DEC-140 turned this on and it defaults on, because an assistant that cannot state a figure
   * was not what was asked for. It stays a switch rather than becoming implicit for one reason:
   * it is the only control that decides whether personal data crosses the border, and OR-03 still
   * has no named legal owner. Setting `HRM_LLM_ANSWER_FROM_ROWS=false` restores exactly the
   * posture ADR-0020 shipped with - the model sees column names and a row count, the deterministic
   * sentence introduces the table - without a code change or a redeploy of anything else.
   */
  get answerFromRows(): boolean {
    return env('HRM_LLM_ANSWER_FROM_ROWS') !== 'false';
  }

  /** Why it is off, for an operator reading a health response. Never includes the key. */
  get disabledReason(): string | null {
    if (env('HRM_ASSISTANT_ENABLED') !== 'true') return 'HRM_ASSISTANT_ENABLED is not true';
    if (readApiKey() === null) {
      return 'no API key: set HRM_LLM_API_KEY_FILE (preferred) or HRM_LLM_API_KEY';
    }
    return null;
  }

  private breakerOpen(): boolean {
    if (this.failures < BREAKER_THRESHOLD) return false;
    if (Date.now() - this.openedAt > BREAKER_COOLDOWN_MS) {
      // Half-open: let one through and see.
      this.failures = BREAKER_THRESHOLD - 1;
      return false;
    }
    return true;
  }

  async chat(opts: {
    messages: readonly ChatMessage[];
    tools?: readonly ToolSchema[];
    /** Force a tool call rather than prose. Used by the selection step. */
    requireTool?: boolean;
    maxTokens?: number;
    /**
     * Called with each fragment of prose as it arrives, for the answer call.
     *
     * IGNORED WHEN TOOLS ARE ATTACHED. Streaming a tool call means reassembling
     * `tool_calls[].function.arguments` across chunks, and the route and select steps gain
     * nothing from it: their output is a word or a function name that the user never sees mid
     * flight. So the streaming reader below handles prose only, and this is silently a no-op for
     * the two calls that select rather than write.
     */
    onDelta?: (text: string) => void;
  }): Promise<ChatResult> {
    const key = readApiKey();
    if (env('HRM_ASSISTANT_ENABLED') !== 'true' || key === null) {
      throw new LlmUnavailable('disabled', this.disabledReason ?? 'assistant is disabled');
    }
    if (this.breakerOpen()) {
      throw new LlmUnavailable(
        'provider_error',
        'The assistant is unavailable after repeated failures. Try again shortly.',
      );
    }

    const body: Record<string, unknown> = {
      model: this.model,
      messages: opts.messages,
      temperature: 0,
      max_tokens: opts.maxTokens ?? 400,
    };
    if (opts.tools?.length) {
      body.tools = opts.tools.map((t) => ({
        type: 'function',
        function: { name: t.name, description: t.description, parameters: t.parameters },
      }));
      body.tool_choice = opts.requireTool ? 'required' : 'auto';
    }

    const streaming = typeof opts.onDelta === 'function'
      && !opts.tools?.length
      && env('HRM_LLM_STREAM') !== 'false';
    if (streaming) {
      body.stream = true;
      // Without this a streamed completion reports NO usage at all, and the transcript's token
      // counters - the only cost telemetry this feature has - would silently become zero.
      body.stream_options = { include_usage: true };
    }

    // One retry, and only for a transport failure or a 5xx. A 4xx is our bug and retrying it
    // just doubles the latency of a request that will fail anyway.
    let emitted = false;
    const onDelta = streaming
      ? (text: string) => { emitted = true; opts.onDelta!(text); }
      : undefined;

    let lastErr: LlmUnavailable | null = null;
    let streamingNow = streaming;

    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const res = await this.post(key, body, streamingNow ? onDelta : undefined);
        this.failures = 0;
        return res;
      } catch (e) {
        lastErr = e instanceof LlmUnavailable
          ? e
          : new LlmUnavailable('provider_error', 'The assistant could not reach the model. Try again in a moment.');
        if (lastErr.code === 'timeout') break;      // a retry would blow the request budget
        // A retry after a break mid-stream would replay text the user has ALREADY READ, so the
        // answer would appear to stutter and repeat itself. Once a word is on screen there is no
        // second attempt - the caller degrades instead.
        if (emitted) break;

        /*
         * THE RETRY DROPS STREAMING, and this is the one case where retrying a 4xx is right.
         *
         * A 4xx is normally our bug and worth no second attempt. But `stream_options` is a
         * CAPABILITY, not an argument we chose: an Azure deployment, a gateway, or an older
         * model can reject it while accepting the identical non-streamed request. The symptom is
         * pointed - route and select succeed because they do not stream, and only the ANSWER
         * fails, so the user gets a tool run, a row count, and "the answer could not be written".
         * Falling back converts that into a working answer that simply arrives all at once.
         */
        if (attempt === 0 && streamingNow) {
          console.warn(
            '[assistant] the streamed answer call failed; retrying WITHOUT streaming. If this ' +
            'recurs, the provider does not support stream_options and the retry is doing the ' +
            'work every turn - set HRM_LLM_STREAM=false to skip it.',
          );
          streamingNow = false;
          delete body.stream;
          delete body.stream_options;
        }
        if (attempt === 0) continue;
      }
    }

    this.failures++;
    if (this.failures === BREAKER_THRESHOLD) this.openedAt = Date.now();
    throw lastErr ?? new LlmUnavailable('provider_error', 'The assistant could not reach the model. Try again in a moment.');
  }

  private async post(
    key: string,
    body: Record<string, unknown>,
    onDelta?: (text: string) => void,
  ): Promise<ChatResult> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    const started = Date.now();

    try {
      const res = await fetch(`${this.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      if (!res.ok) {
        // The SHAPE, never the body: a provider error can echo the request, and the request
        // carries the user's question.
        console.error(`[assistant] model call failed: HTTP ${res.status} after ${Date.now() - started}ms`);
        throw new LlmUnavailable('provider_error', 'The assistant could not reach the model. Try again in a moment.');
      }

      if (onDelta) return await this.readStream(res, onDelta);

      const json: any = await res.json();
      const choice = json?.choices?.[0]?.message ?? {};
      const call = choice.tool_calls?.[0];

      let toolArgs: Record<string, unknown> | null = null;
      if (call?.function?.arguments) {
        try {
          const parsed = JSON.parse(call.function.arguments);
          toolArgs = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
        } catch {
          // A model that emits invalid JSON has produced no arguments, not arbitrary ones.
          toolArgs = {};
        }
      }

      return {
        content: typeof choice.content === 'string' ? choice.content : null,
        toolName: call?.function?.name ?? null,
        toolArgs,
        model: typeof json?.model === 'string' ? json.model : this.model,
        promptTokens: Number(json?.usage?.prompt_tokens ?? 0),
        completionTokens: Number(json?.usage?.completion_tokens ?? 0),
      };
    } catch (e: any) {
      if (e instanceof LlmUnavailable) throw e;
      if (e?.name === 'AbortError') {
        console.error(`[assistant] model call timed out after ${this.timeoutMs}ms`);
        throw new LlmUnavailable('timeout', 'The assistant took too long to answer. Try again.');
      }
      console.error(`[assistant] model call errored after ${Date.now() - started}ms: ${e?.name ?? 'unknown'}`);
      throw new LlmUnavailable('provider_error', 'The assistant could not reach the model. Try again in a moment.');
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Read an OpenAI-style streamed completion, forwarding each fragment as it arrives.
   *
   * WHY BY HAND. The same reasoning as DEC-134, which kept the `openai` package out for the
   * non-streaming call: this is one well-specified wire format - `data: {json}` lines, a
   * `[DONE]` sentinel - and the SSE parser it needs is the same twenty lines `api.ts` already
   * has on the browser side for our own event stream.
   *
   * THE ABORT TIMER STILL COVERS THE WHOLE READ. `this.timeoutMs` is a budget for the entire
   * call, not for the first byte, so a provider that opens a stream and then stalls is still cut
   * off rather than holding the request open. A stalled stream that has already emitted text
   * surfaces as a truncated answer, which the caller marks.
   *
   * A CHUNK CAN SPLIT ANYWHERE, including mid-UTF-8 and mid-line, so the carry-over buffer and
   * `stream: true` on the decoder are both load-bearing rather than defensive.
   */
  private async readStream(res: Response, onDelta: (text: string) => void): Promise<ChatResult> {
    if (!res.body) {
      throw new LlmUnavailable('provider_error', 'The assistant could not reach the model. Try again in a moment.');
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let content = '';
    let model = this.model;
    let promptTokens = 0;
    let completionTokens = 0;

    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let nl: number;
      while ((nl = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (!line.startsWith('data:')) continue;          // comments and blank separators

        const payload = line.slice(5).trim();
        if (payload === '[DONE]') continue;

        let chunk: any;
        try { chunk = JSON.parse(payload); } catch { continue; }   // never a fatal parse

        if (typeof chunk?.model === 'string') model = chunk.model;
        if (chunk?.usage) {
          promptTokens = Number(chunk.usage.prompt_tokens ?? promptTokens);
          completionTokens = Number(chunk.usage.completion_tokens ?? completionTokens);
        }

        const delta = chunk?.choices?.[0]?.delta?.content;
        if (typeof delta === 'string' && delta.length > 0) {
          content += delta;
          onDelta(delta);
        }
      }
    }

    return {
      content: content.length > 0 ? content : null,
      toolName: null,
      toolArgs: null,
      model,
      promptTokens,
      completionTokens,
    };
  }

}
