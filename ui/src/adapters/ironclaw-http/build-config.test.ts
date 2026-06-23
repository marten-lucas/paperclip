import { describe, expect, it } from "vitest";
import { buildIronclawHttpConfig } from "./build-config";

describe("buildIronclawHttpConfig", () => {
  it("maps numCtx and thinkingMode from adapter schema values", () => {
    const config = buildIronclawHttpConfig({
      model: "qwen3:8b",
      adapterSchemaValues: {
        numCtx: 8192,
        thinkingMode: "on",
      },
    } as any);

    expect(config).toMatchObject({
      model: "qwen3:8b",
      timeoutSec: 120,
      numCtx: 8192,
      thinkingMode: "on",
    });
  });

  it("omits invalid values and preserves valid defaults", () => {
    const config = buildIronclawHttpConfig({
      adapterSchemaValues: {
        numCtx: 0,
        thinkingMode: "invalid",
      },
    } as any);

    expect(config.timeoutSec).toBe(120);
    expect(config.numCtx).toBeUndefined();
    expect(config.thinkingMode).toBeUndefined();
  });

  it("preserves env bindings for create payloads", () => {
    const config = buildIronclawHttpConfig({
      envBindings: {
        IRONCLAW_BASE_URL: { type: "plain", value: "https://gateway.example/api/v1/responses" },
        IRONCLAW_API_KEY: { type: "plain", value: "plain-token" },
      },
      adapterSchemaValues: {
        url: "http://10.12.12.102:3000/",
      },
    } as any);

    expect(config.env).toMatchObject({
      IRONCLAW_BASE_URL: { type: "plain", value: "https://gateway.example/api/v1/responses" },
      IRONCLAW_API_KEY: { type: "plain", value: "plain-token" },
    });
    expect(config.url).toBe("http://10.12.12.102:3000/");
  });
});
