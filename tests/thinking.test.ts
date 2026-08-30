import { describe, expect, it } from "vitest";
import { normalizeThinking, normalizeThinkingText } from "../src/thinking.js";

describe("normalizeThinkingText", () => {
  it("collapses token-joined newline runs mid-text", () => {
    expect(normalizeThinkingText("Good\n\n\n —\n\n\n I\n\n\n confirmed")).toBe(
      "Good\n\n —\n\n I\n\n confirmed",
    );
  });

  it("collapses runs longer than 3 (tokens with embedded newlines)", () => {
    expect(normalizeThinkingText("The\n\n\n\n next\n\n\n\n\n token")).toBe(
      "The\n\n next\n\n token",
    );
  });

  it("leaves normal paragraph breaks untouched", () => {
    const text = "First paragraph.\n\nSecond paragraph.\n\nEnd";
    expect(normalizeThinkingText(text)).toBe(text);
  });

  it("preserves the model's natural trailing paragraph terminator", () => {
    // GLM ends some thinking blocks with ".\n\n\n" — corruption joins are
    // always mid-text, never at the very end.
    expect(normalizeThinkingText("done thinking.\n\n\n")).toBe("done thinking.\n\n\n");
  });

  it("is idempotent", () => {
    const once = normalizeThinkingText("Good\n\n\n —\n\n\n fine");
    expect(normalizeThinkingText(once)).toBe(once);
  });
});

describe("normalizeThinking", () => {
  const thinkingBlock = (thinking: string): Record<string, unknown> => ({
    type: "thinking",
    thinking,
    thinkingSignature: "reasoning_content",
  });
  const textBlock = (text: string): Record<string, unknown> => ({ type: "text", text });
  const assistantMsg = (content: unknown, provider = "clinepass") => ({
    role: "assistant",
    content,
    provider,
    model: "cline-pass/kimi-k3",
    usage: { input: 1, output: 1 },
  });
  const event = (message: unknown) => ({ message });
  const ctx = { model: { provider: "clinepass" } };

  it("returns undefined for clean messages (no clone, no result)", () => {
    const message = assistantMsg([thinkingBlock("clean\n\nthinking")]);
    const ev = event(message);
    expect(normalizeThinking(ev, ctx)).toBeUndefined();
    // event object untouched
    expect(ev.message).toBe(message);
  });

  it("repairs corrupted thinking and preserves everything else", () => {
    const untouched = textBlock("answer");
    const message = assistantMsg([thinkingBlock("Good\n\n\n —\n\n\n fine"), untouched]);
    const result = normalizeThinking(event(message), ctx);
    expect(result).toBeDefined();
    const repaired = result!.message as typeof message;
    expect(repaired.role).toBe("assistant");
    expect(repaired.provider).toBe("clinepass");
    expect(repaired.model).toBe("cline-pass/kimi-k3");
    expect(repaired.usage).toEqual({ input: 1, output: 1 });
    expect((repaired.content as unknown[])[0]).toEqual({
      type: "thinking",
      thinking: "Good\n\n —\n\n fine",
      thinkingSignature: "reasoning_content",
    });
    expect((repaired.content as unknown[])[1]).toBe(untouched);
    // original message NOT mutated
    expect(((message.content as unknown[])[0] as { thinking: string }).thinking).toContain("\n\n\n");
    expect((message.content as unknown[])[1]).toBe(untouched);
  });

  it("keeps natural trailing terminators while repairing the rest", () => {
    const message = assistantMsg([thinkingBlock("Part one.\n\n\nPart\n\n\n two.\n\n\n")]);
    const result = normalizeThinking(event(message), ctx);
    expect(result!.message).toEqual(
      expect.objectContaining({
        content: [
          expect.objectContaining({ thinking: "Part one.\n\nPart\n\n two.\n\n\n" }),
        ],
      }),
    );
  });

  it("gates on provider (clinepass aliases only)", () => {
    const ev = event(assistantMsg([thinkingBlock("Good\n\n\n —\n\n\n fine")], "anthropic"));
    expect(normalizeThinking(ev, ctx)).toBeUndefined();
  });

  it("falls back to ctx.model.provider when the message carries none", () => {
    const message = {
      role: "assistant",
      content: [thinkingBlock("Good\n\n\n —\n\n\n fine")],
    };
    expect(normalizeThinking(event(message), ctx)).toBeDefined();
    expect(normalizeThinking(event(message), {})).toBeUndefined();
  });

  it("ignores non-assistant roles and malformed shapes without throwing", () => {
    expect(
      normalizeThinking(event({ role: "user", content: [thinkingBlock("Good\n\n\n bad")] }), ctx),
    ).toBeUndefined();
    expect(normalizeThinking(event({ role: "assistant" }), ctx)).toBeUndefined();
    expect(normalizeThinking(event(null), ctx)).toBeUndefined();
    expect(normalizeThinking(event("nope"), ctx)).toBeUndefined();
    expect(normalizeThinking(event(undefined), ctx)).toBeUndefined();
    expect(normalizeThinking(event(assistantMsg("not-an-array")), ctx)).toBeUndefined();
    expect(normalizeThinking(event(assistantMsg([null, 42, "str"])), ctx)).toBeUndefined();
  });

  it("ignores thinking blocks whose thinking field is not a string", () => {
    const message = assistantMsg([
      { type: "thinking", thinking: 42, thinkingSignature: "reasoning_content" },
      { type: "thinking" }, // missing field
      { type: "thinking", thinking: null },
    ]);
    expect(normalizeThinking(event(message), ctx)).toBeUndefined();
  });
});
