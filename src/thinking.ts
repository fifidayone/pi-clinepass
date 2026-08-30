/**
 * Repairs gateway-side reasoning-stream corruption before the assistant
 * message is persisted.
 *
 * Observed failure mode (api.cline.bot, intermittent): reasoning deltas
 * arrive token-by-token and are assembled with a literal join separator,
 * so the final thinking text reads "word\n\n\nword\n\n\nword" (original
 * tokenizer tokens preserved, separated by three newlines). The garbled
 * text is cosmetic at display time but expensive afterwards: pi replays
 * prior assistant thinking back into the request context on every
 * subsequent turn, so the inflated newlines are re-billed as input
 * tokens for the rest of the session.
 *
 * Repair strategy: collapse runs of 3+ newlines to a standard paragraph
 * break (\n\n) — but only mid-text. GLM's tokenizer legitimately ends
 * thinking blocks with a trailing ".\n\n\n" paragraph terminator (observed
 * on ~2% of clean blocks, always at the very end of the text), and since
 * the corruption join never sits at the end (it is always between two
 * tokens), a trailing run is the model's own output and must be left
 * alone. Mid-text runs are always corruption.
 *
 * Text blocks (user-visible answers) are never touched. The transform is
 * deterministic and idempotent, so replayed context stays stable across
 * requests (prompt-cache friendly) and re-running on already-repaired
 * text is a no-op.
 *
 * Runs synchronously on pi's message_end critical path: the fast path
 * (clean text) is a string search per thinking block, nothing is cloned
 * unless a repair actually happened, and the function never throws.
 */

export interface ThinkingRepairContext {
  /** Fallback provider when the message carries none (pi's current model). */
  model?: { provider?: string } | undefined;
}

/**
 * Collapse token-joined newline runs (3+ newlines) back to a standard
 * paragraph break. A run at the very end of the text is left intact: the
 * corruption join is always mid-text (between two tokens), while a
 * trailing run is the model's own paragraph terminator.
 */
export function normalizeThinkingText(text: string): string {
  return text.replace(/\n{3,}(?=[^\n])/g, "\n\n");
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const CLINEPASS_PROVIDERS = new Set(["clinepass", "cline-pass"]);

/**
 * Repair a message_end event's assistant thinking and return the
 * replacement message, or undefined when nothing needs changing.
 *
 * Generic over the event so the repair is transparent at the wiring site:
 * the returned message keeps the exact type pi handed us. TMessage is
 * deliberately NOT a standalone type parameter — it would have no inference
 * source in the arguments, fall back to `unknown`, and fail the handler's
 * MessageEndEventResult assignability. Inferring the whole event and
 * indexing into it keeps the return type concrete.
 */
export function normalizeThinking<
  TEvent extends { message?: unknown },
>(event: TEvent, ctx: ThinkingRepairContext = {}): { message?: TEvent["message"] } | undefined {
  try {
    const msg = event.message;
    if (!isRecord(msg) || msg.role !== "assistant") return undefined;

    const provider =
      typeof msg.provider === "string" ? msg.provider : ctx.model?.provider;
    // Guard (instead of a bare .has) also narrows away the undefined that
    // ctx.model?.provider can produce, and rejects empty strings.
    if (!provider || !CLINEPASS_PROVIDERS.has(provider)) return undefined;

    const content = msg.content;
    if (!Array.isArray(content)) return undefined;

    let changed = false;
    let repaired: unknown[] = content; // lazy copy: zero allocation on the clean path
    for (let i = 0; i < content.length; i++) {
      const block = content[i];
      if (!isRecord(block) || block.type !== "thinking") continue;
      // Explicit `unknown` binding (not a generic-indexed alias) so the
      // typeof guard below narrows reliably under strict mode.
      const raw: unknown = block.thinking;
      if (typeof raw !== "string" || !raw.includes("\n\n\n")) continue;
      if (!changed) {
        repaired = content.slice();
        changed = true;
      }
      // Block spread preserves every other field (e.g. thinkingSignature).
      repaired[i] = { ...block, thinking: normalizeThinkingText(raw) };
    }
    if (!changed) return undefined;

    // Shallow copy with only `content` replaced; the cast is sound because
    // every other field is preserved untouched from the original message.
    return { message: { ...msg, content: repaired } as TEvent["message"] };
  } catch {
    // Repair is best-effort: never fail pi's message_end critical path over it.
    return undefined;
  }
}
