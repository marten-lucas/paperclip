import { afterEach, describe, expect, it, vi } from "vitest";
import { execute } from "./execute.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("ironclaw_http execute", () => {
  it("fails when required config is missing", async () => {
    const result = await execute({
      runId: "run-1",
      agent: {
        id: "agent-1",
        companyId: "company-1",
        name: "Agent",
        adapterType: "ironclaw_http",
        adapterConfig: {},
      },
      runtime: {
        sessionId: null,
        sessionParams: null,
        sessionDisplayId: null,
        taskKey: null,
      },
      config: {},
      context: {},
      onLog: async () => {},
    });

    expect(result.exitCode).toBe(1);
    expect(result.errorCode).toBe("ironclaw_config_missing");
  });

  it("posts to responses endpoint and stores response id", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      id: "resp_123",
      model: "qwen3:8b",
      output: [{ type: "message", content: "hello from ironclaw" }],
      usage: { input_tokens: 10, output_tokens: 20 },
    }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }));

    vi.stubGlobal("fetch", fetchMock);

    const result = await execute({
      runId: "run-2",
      agent: {
        id: "agent-2",
        companyId: "company-1",
        name: "Agent",
        adapterType: "ironclaw_http",
        adapterConfig: {},
      },
      runtime: {
        sessionId: null,
        sessionParams: null,
        sessionDisplayId: null,
        taskKey: null,
      },
      config: {
        url: "http://127.0.0.1:3000",
        authToken: "token-123",
        model: "qwen3:8b",
      },
      context: {
        input: "say hi",
      },
      onLog: async () => {},
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [requestUrl, requestInit] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(requestUrl).toBe("http://127.0.0.1:3000/api/v1/responses");
    expect(requestInit.method).toBe("POST");

    const requestBody = JSON.parse(String(requestInit.body));
    expect(requestBody.model).toBe("qwen3:8b");
    expect(requestBody.input).toBe("say hi");

    expect(result.exitCode).toBe(0);
    expect(result.sessionParams).toEqual({ responseId: "resp_123" });
    expect(result.usage).toEqual({ inputTokens: 10, outputTokens: 20 });
  });
});
