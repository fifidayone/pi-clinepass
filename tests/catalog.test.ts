import { describe, expect, it } from "vitest";
import { MODELS, isFreeModel, modelIds } from "../src/catalog.js";

describe("catalog", () => {
  it("has 16 models: 13 paid + 3 free", () => {
    expect(MODELS).toHaveLength(16);
    expect(MODELS.filter((m) => m.cost.input === 0)).toHaveLength(3);
    expect(MODELS.filter((m) => m.cost.input > 0)).toHaveLength(13);
  });

  it("uses measured billing prices (not published)", () => {
    const kimi = MODELS.find((m) => m.id === "cline-pass/kimi-k2.7-code");
    expect(kimi?.cost.input).toBe(1.58);
    expect(kimi?.cost.output).toBe(6.67);
    expect(kimi?.cost.cacheRead).toBe(0.32);

    const k3 = MODELS.find((m) => m.id === "cline-pass/kimi-k3");
    expect(k3?.cost.input).toBe(6.0);
    expect(k3?.cost.output).toBe(30.0);

    const mimoPro = MODELS.find((m) => m.id === "cline-pass/mimo-v2.5-pro");
    expect(mimoPro?.cost.input).toBe(0.435);
  });

  it("sets cacheWrite to 0 everywhere (not tracked)", () => {
    for (const m of MODELS) {
      expect(m.cost.cacheWrite).toBe(0);
    }
  });

  it("marks free models correctly", () => {
    expect(isFreeModel("z-ai/glm-5.3-flash")).toBe(true);
    expect(isFreeModel("poolside/laguna-s-2.1:free")).toBe(true);
    expect(isFreeModel("deepseek/deepseek-v4-flash")).toBe(true);
    expect(isFreeModel("cline-pass/deepseek-v4-flash")).toBe(false);
  });

  it("has unique model ids", () => {
    const ids = modelIds();
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("glm-5.3-flash disables off thinking; others map off → none", () => {
    const flash = MODELS.find((m) => m.id === "z-ai/glm-5.3-flash");
    expect(flash?.thinkingLevelMap.off).toBeNull();
    const plus = MODELS.find((m) => m.id === "cline-pass/qwen3.7-plus");
    expect(plus?.thinkingLevelMap.off).toBe("none");
    expect(plus?.thinkingLevelMap.max).toBe("max");
  });

  it("sets ClinePass compat on every model", () => {
    for (const m of MODELS) {
      expect(m.compat.supportsDeveloperRole).toBe(false);
      expect(m.compat.cacheControlFormat).toBe("anthropic");
      expect(m.compat.supportsLongCacheRetention).toBe(false);
    }
  });
});
