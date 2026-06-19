import { afterEach, describe, expect, it, vi } from "vitest";
import { testEnvironment } from "./test.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("ironclaw_http testEnvironment", () => {
  it("fails when IRONCLAW_BASE_URL/IRONCLAW_API_KEY are missing", async () => {
    const result = await testEnvironment({
      companyId: "company-1",
      adapterType: "ironclaw_http",
      config: {},
    });

    expect(result.status).toBe("fail");
    expect(result.checks.some((check) => check.code === "ironclaw_url_missing")).toBe(true);
    expect(result.checks.some((check) => check.code === "ironclaw_auth_missing")).toBe(true);
  });

  it("discovers models from OpenAI-compatible /v1/models endpoint", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      object: "list",
      data: [{ id: "qwen3:8b" }, { id: "mistral-nemo:12b" }],
    }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await testEnvironment({
      companyId: "company-1",
      adapterType: "ironclaw_http",
      config: {
        env: {
          IRONCLAW_BASE_URL: "http://10.12.12.102:3000",
          IRONCLAW_API_KEY: "token-123",
        },
      },
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result.status).toBe("pass");
    expect(result.checks.some((check) => check.code === "ironclaw_connected")).toBe(true);
  });
});
