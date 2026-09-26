import { redactSecrets } from "@inflynx/config";

/**
 * What went wrong, in terms the agent can *act* on.
 *
 * Before this existed, every provider failure arrived as a plain `Error` with the
 * status buried in a string, so callers made decisions by regex-matching prose
 * (`AgentOrchestrator.isContextOverflowError`) — which is how a recoverable
 * "prompt is too long" and a fatal "invalid API key" ended up in the same bucket
 * and the same `turn.failed`. Each kind below has exactly one right response, and
 * `InflynxProviderError.retryable` plus `userMessage` encode it.
 */
export type ProviderErrorKind =
  | "auth"
  | "rate_limit"
  | "network"
  | "context_overflow"
  | "invalid_request"
  | "content_filter"
  | "server_error"
  | "aborted"
  | "unknown";

export interface ProviderErrorInfo {
  kind: ProviderErrorKind;
  /** Retrying the *same request* can succeed. Not the same as "worth compacting". */
  retryable: boolean;
  /** A sentence fit to show a human, with no credentials and no raw JSON. */
  userMessage: string;
}

/**
 * Overflow wording differs per provider and per gateway (Azure, OpenRouter, a
 * local server). Matched broadly on purpose: treating a non-overflow as an
 * overflow costs one wasted compaction, while missing one kills the session.
 */
const OVERFLOW_PATTERN =
  /context_length_exceeded|prompt is too long|too many tokens|maximum context length|context window|input tokens exceed|exceeds the model'?s (?:context|maximum context|input token)|request too large|token limit exceeded/i;

const CONTENT_FILTER_PATTERN =
  /content[-_ ]?filter|safety|prohibited|flagged|policy violation|responsible[_ ]?pii|blocked by/i;

// Wording matters as much as the status: gateways and Azure-style endpoints say
// "invalid api key" in the body of a 401, a 403, or sometimes no status at all.
const AUTH_PATTERN =
  /invalid[_ ]?api[_ ]?key|api[_ ]?key.{0,24}invalid|invalid.{0,24}api[_ ]?key|authentication|unauthorized|permission denied|quota exceeded|insufficient (?:credits|funds)|no api key/i;

export class InflynxProviderError extends Error {
  readonly kind: ProviderErrorKind;
  readonly retryable: boolean;
  readonly userMessage: string;
  readonly provider: string;
  readonly status?: number;
  readonly providerBody?: string;

  constructor(
    provider: string,
    info: ProviderErrorInfo,
    options: { status?: number; rawBody?: string; cause?: unknown } = {}
  ) {
    // Redacted at construction: the raw body routinely contains echoed request
    // headers, and this error is forwarded to UIs and telemetry.
    const providerBody = options.rawBody ? redactSecrets(options.rawBody).slice(0, 2_000) : undefined;
    // `message` stays the full diagnostic (what a log line and a stack trace show,
    // including the provider's own wording); `userMessage` is the clean sentence a
    // UI can render. Dropping the body from `message` would have thrown away the
    // only detail that makes a provider error debuggable after the fact.
    super(
      `${provider.toUpperCase()} ${info.kind} (${options.status ?? "no status"}): ${info.userMessage}` +
        (providerBody ? `\n${providerBody}` : ""),
      options.cause ? { cause: options.cause } : undefined
    );
    this.name = "InflynxProviderError";
    this.kind = info.kind;
    this.retryable = info.retryable;
    this.userMessage = info.userMessage;
    this.provider = provider;
    this.status = options.status;
    this.providerBody = providerBody;
  }

  /** The provider's own wording, redacted — what to show under a "details" toggle. */
  get detail(): string {
    return this.providerBody || this.message;
  }
}

/** Pure classifier, exported so it can be unit-tested without any network. */
export function classifyProviderError(provider: string, status: number, rawBody: string): ProviderErrorInfo {
  const body = rawBody || "";

  // A 413 can arrive before any provider-side parsing, with no useful body.
  if (status === 413 || OVERFLOW_PATTERN.test(body)) {
    return {
      kind: "context_overflow",
      // Not "retryable" as-is — the request must shrink first. The orchestrator's
      // compaction pass is what makes the retry worth doing.
      retryable: false,
      userMessage:
        "The conversation outgrew the model's context window. Older tool output will be " +
        "dropped and the step retried; if that is not enough, start a new session or " +
        "choose a model with a larger window.",
    };
  }

  if (status === 401 || status === 403 || AUTH_PATTERN.test(body)) {
    return {
      kind: "auth",
      retryable: false,
      userMessage:
        "The provider rejected the credentials for this model. Check the API key or the " +
        "credential profile selected in /credentials.",
    };
  }

  if (status === 429) {
    return {
      kind: "rate_limit",
      retryable: true,
      userMessage:
        "The provider is rate-limiting this account (it may also mean the free quota is " +
        "used up). Waiting a moment and sending the message again usually works.",
    };
  }

  if (status === 400 || status === 404 || status === 422) {
    return {
      kind: CONTENT_FILTER_PATTERN.test(body) ? "content_filter" : "invalid_request",
      retryable: false,
      userMessage: CONTENT_FILTER_PATTERN.test(body)
        ? "The provider refused this request on content-policy grounds. Rephrase the " +
          "request or choose a different model."
        : `The provider rejected the request as malformed (${provider}). The model, endpoint `
          + "or tool schema may not be supported — check /models for what the provider "
          + "actually offers.",
    };
  }

  if (status === 408 || status === 409 || status === 425 || status >= 500) {
    return {
      kind: "server_error",
      retryable: true,
      userMessage:
        "The provider is erroring on its side. This is usually temporary; the request " +
        "was retried and can safely be sent again.",
    };
  }

  return {
    kind: "unknown",
    retryable: false,
    userMessage: "The provider returned an unexpected error.",
  };
}

export function providerError(provider: string, status: number, rawBody: string): InflynxProviderError {
  return new InflynxProviderError(provider, classifyProviderError(provider, status, rawBody), {
    status,
    rawBody,
  });
}

export function networkError(provider: string, rawMessage: string): InflynxProviderError {
  return new InflynxProviderError(
    provider,
    {
      kind: "network",
      retryable: true,
      userMessage:
        "Could not reach the provider. Check the internet connection, the endpoint " +
        "configuration, and any network proxy, then try again.",
    },
    { rawBody: rawMessage || "fetch failed" }
  );
}

export function abortedError(provider: string): InflynxProviderError {
  return new InflynxProviderError(
    provider,
    {
      kind: "aborted",
      retryable: false,
      userMessage: "The request was cancelled.",
    },
    { status: 499 }
  );
}

/**
 * Wrap anything a provider call threw, so the layer above always gets a typed
 * error. Non-`InflynxProviderError` throws are usually an AbortError or a
 * transport failure, and both need to be recognisable.
 */
export function toProviderError(provider: string, err: unknown): InflynxProviderError {
  if (err instanceof InflynxProviderError) return err;

  const message = err instanceof Error ? err.message : String(err);
  const aborted =
    (err instanceof Error && err.name === "AbortError") || /aborted|abort error/i.test(message);
  if (aborted) return abortedError(provider);

  // Not every overflow arrives as a classified HTTP response: a BYOK gateway can
  // return 200-with-an-error-body, and an SDK may throw a bare Error. Recovering the
  // session is worth more than a tidy taxonomy, so the wording is checked here too.
  if (OVERFLOW_PATTERN.test(message)) {
    return new InflynxProviderError(
      provider,
      classifyProviderError(provider, 0, message),
      { rawBody: message, cause: err }
    );
  }

  return new InflynxProviderError(
    provider,
    {
      kind: "network",
      retryable: true,
      userMessage:
        "Could not reach the provider. Check the internet connection, the endpoint " +
        "configuration, and any network proxy, then try again.",
    },
    { rawBody: message, cause: err }
  );
}

export function isProviderError(err: unknown): err is InflynxProviderError {
  return err instanceof InflynxProviderError;
}
