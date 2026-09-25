import { describe, expect, it } from "vitest";
import { MODELS, isFreeModel, modelIds } from "../src/catalog.js";

describe("catalog", () => {
  it("has 17 models: 12 paid + 5 free", () => {
    expect(MODELS).toHaveLength(17);
    expect(MODELS.filter((m) => m.cost.input === 0)).toHaveLength(5);
    expect(MODELS.filter((m) => m.cost.input > 0)).toHaveLength(12);
  });

  it("uses measured billing prices (not published)", () => {
    const glm = MODELS.find((m) => m.id === "cline-pass/glm-5.3");
    expect(glm?.cost.input).toBe(1.4);
    expect(glm?.cost.output).toBe(4.4);
    expect(glm?.cost.cacheRead).toBe(0.26);

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
    expect(isFreeModel("cline-free/gemini-3.8-flash")).toBe(true);
    expect(isFreeModel("clinepass/cline-free/gemini-3.8-flash")).toBe(true);
    expect(isFreeModel("cline-free/deepseek-v4.1-flash")).toBe(true);
    expect(isFreeModel("clinepass/cline-free/deepseek-v4.1-flash")).toBe(true);
    expect(isFreeModel("stealth/space-bunny-alpha")).toBe(true);
    expect(isFreeModel("clinepass/stealth/space-bunny-alpha")).toBe(true);
    expect(isFreeModel("cline-free/mimo-v2.6-flash")).toBe(true);
    expect(isFreeModel("cline-free/muse-spark-1.3-contributor")).toBe(true);
    expect(isFreeModel("cline-pass/deepseek-v4.1-flash")).toBe(false);
    expect(isFreeModel("clinepass/cline-pass/deepseek-v4.1-flash")).toBe(false);
    expect(isFreeModel("cline-pass/mimo-v2.5")).toBe(false);
    expect(isFreeModel("cline-pass/muse-spark-1.3-contributor")).toBe(false);
  });

  it("has unique model ids", () => {
    const ids = modelIds();
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("glm-5.3-flash and gemini-3.8-flash disable off thinking; others map off → none", () => {
    const flash = MODELS.find((m) => m.id === "cline-pass/glm-5.3-flash");
    expect(flash?.thinkingLevelMap.off).toBeNull();
    const gemini = MODELS.find((m) => m.id === "cline-free/gemini-3.8-flash");
    expect(gemini?.thinkingLevelMap.off).toBeNull();
    expect(gemini?.thinkingLevelMap.minimal).toBeNull();
    expect(gemini?.thinkingLevelMap.low).toBe("low");
    expect(gemini?.thinkingLevelMap.medium).toBe("medium");
    expect(gemini?.thinkingLevelMap.high).toBe("high");
    expect(gemini?.thinkingLevelMap.max).toBeNull();
    const plus = MODELS.find((m) => m.id === "cline-pass/qwen3.7-plus");
    expect(plus?.thinkingLevelMap.off).toBe("none");
    expect(plus?.thinkingLevelMap.max).toBe("max");
  });

  it("space-bunny supports all 7 thinking levels (off allowed)", () => {
    const m = MODELS.find((x) => x.id === "stealth/space-bunny-alpha");
    expect(m?.reasoning).toBe(true);
    for (const level of ["off", "minimal", "low", "medium", "high", "xhigh", "max"]) {
      expect(typeof m?.thinkingLevelMap[level as keyof typeof m.thinkingLevelMap]).toBe("string");
    }
    expect(m?.thinkingLevelMap.off).toBe("none");
  });

  it("sets ClinePass compat on every model", () => {
    for (const m of MODELS) {
      expect(m.compat.supportsDeveloperRole).toBe(false);
      expect(m.compat.cacheControlFormat).toBe("anthropic");
      expect(m.compat.supportsLongCacheRetention).toBe(false);
    }
  });
});
