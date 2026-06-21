import { afterEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execute } from "./execute.js";

function seededPreviousResponseId(agentId: string, issueId?: string): string {
  const scopeKey = issueId
    ? `paperclip-task-thread:${agentId}:${issueId}`
    : `paperclip-agent-thread:${agentId}`;
  const threadHex = createHash("sha256")
    .update(scopeKey)
    .digest("hex")
    .slice(0, 32);
  const responseScopeKey = issueId
    ? `paperclip-task-seed-response:${agentId}:${issueId}`
    : `paperclip-agent-seed-response:${agentId}`;
  const responseHex = createHash("sha256")
    .update(responseScopeKey)
    .digest("hex")
    .slice(0, 32);
  return `resp_${responseHex}${threadHex}`;
}

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

  it("treats timeoutSec=0 as no timeout", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.signal?.aborted) {
        throw new DOMException("Aborted", "AbortError");
      }
      return new Response(JSON.stringify({
        id: "resp_timeout_0",
        model: "default",
        output: [{ type: "message", content: "ok" }],
      }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await execute({
      runId: "run-timeout-0",
      agent: {
        id: "agent-timeout-0",
        companyId: "company-1",
        name: "CEO",
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
        env: {
          IRONCLAW_BASE_URL: "http://127.0.0.1:3000",
          IRONCLAW_API_KEY: "token-123",
        },
        timeoutSec: 0,
      },
      context: {
        input: "hello",
      },
      onLog: async () => {},
    });

    const calls = fetchMock.mock.calls as unknown as Array<[string, RequestInit?]>;
    const requestBody = JSON.parse(String(calls[0]?.[1]?.body ?? "{}"));
    expect(requestBody.timeout_sec).toBe(0);

    expect(result.timedOut).toBe(false);
    expect(result.exitCode).toBe(0);
  });

  it("times out when timeoutSec is positive", async () => {
    const realSetTimeout = globalThis.setTimeout;
    vi.stubGlobal("setTimeout", ((handler: (...args: any[]) => void) => {
      handler();
      return realSetTimeout(() => {}, 0);
    }) as unknown as typeof setTimeout);

    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.signal?.aborted) {
        throw new DOMException("Aborted", "AbortError");
      }
      return new Response(JSON.stringify({
        id: "resp_should_not_happen",
        model: "default",
        output: [{ type: "message", content: "ok" }],
      }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await execute({
      runId: "run-timeout-1",
      agent: {
        id: "agent-timeout-1",
        companyId: "company-1",
        name: "CEO",
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
        env: {
          IRONCLAW_BASE_URL: "http://127.0.0.1:3000",
          IRONCLAW_API_KEY: "token-123",
        },
        timeoutSec: 1,
      },
      context: {
        input: "hello",
      },
      onLog: async () => {},
    });

    const calls = fetchMock.mock.calls as unknown as Array<[string, RequestInit?]>;
    const requestBody = JSON.parse(String(calls[0]?.[1]?.body ?? "{}"));
    expect(requestBody.timeout_sec).toBe(1);

    expect(result.timedOut).toBe(true);
    expect(result.errorCode).toBe("timeout");
    expect(result.errorMessage).toContain("1s");
  });

  it("reads URL/token from env bindings, forwards configured model, and stores response id", async () => {
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
        env: {
          IRONCLAW_BASE_URL: "http://127.0.0.1:3000",
          IRONCLAW_API_KEY: "token-123",
        },
        model: "qwen3:8b",
      },
      context: {
        input: "say hi",
      },
      onLog: async () => {},
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const calls = fetchMock.mock.calls as unknown as Array<[string, RequestInit?]>;
    const requestUrl = String(calls[0]?.[0]);
    const requestInit = (calls[0]?.[1] ?? {}) as RequestInit;
    expect(requestUrl).toBe("http://127.0.0.1:3000/api/v1/responses");
    expect(requestInit.method).toBe("POST");

    const requestBody = JSON.parse(String(requestInit.body));
    expect(requestBody.model).toBe("qwen3:8b");
    expect(requestBody.input).toBe("say hi");
    expect(requestBody.stream).toBe(false);
    expect(requestBody.previous_response_id).toBe(seededPreviousResponseId("agent-2"));
    expect(requestBody.x_context).toMatchObject({
      paperclip: {
        source: "paperclip_heartbeat",
        runId: "run-2",
        agentId: "agent-2",
        agentName: "Agent",
      },
      conversation: {
        label: "Agent heartbeat",
        title: "Agent",
        kind: "paperclip_heartbeat",
      },
    });

    expect(result.exitCode).toBe(0);
    expect(result.sessionParams).toEqual({ responseId: "resp_123" });
    expect(result.usage).toEqual({ inputTokens: 10, outputTokens: 20 });
  });

  it("recovers when IRONCLAW_BASE_URL and IRONCLAW_API_KEY are accidentally swapped", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      id: "resp_swap_1",
      model: "default",
      output: [{ type: "message", content: "swap ok" }],
    }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }));

    vi.stubGlobal("fetch", fetchMock);

    const result = await execute({
      runId: "run-swap-1",
      agent: {
        id: "agent-swap-1",
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
        env: {
          IRONCLAW_BASE_URL: "token-123",
          IRONCLAW_API_KEY: "http://127.0.0.1:3000",
        },
      },
      context: {
        input: "say hi",
      },
      onLog: async () => {},
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const calls = fetchMock.mock.calls as unknown as Array<[string, RequestInit?]>;
    const requestUrl = String(calls[0]?.[0]);
    const requestInit = (calls[0]?.[1] ?? {}) as RequestInit;
    expect(requestUrl).toBe("http://127.0.0.1:3000/api/v1/responses");
    expect(requestInit.headers).toMatchObject({
      authorization: "Bearer token-123",
    });
    expect(result.exitCode).toBe(0);
  });

  it("passes model when explicitly configured as default", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      id: "resp_124",
      model: "default",
      output: [{ type: "message", content: "default ok" }],
    }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }));

    vi.stubGlobal("fetch", fetchMock);

    const result = await execute({
      runId: "run-3",
      agent: {
        id: "agent-3",
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
        env: {
          IRONCLAW_BASE_URL: "http://127.0.0.1:3000",
          IRONCLAW_API_KEY: "token-123",
        },
        model: "default",
      },
      context: {
        input: "say hi",
      },
      onLog: async () => {},
    });

    const calls = fetchMock.mock.calls as unknown as Array<[string, RequestInit?]>;
    const requestInit = (calls[0]?.[1] ?? {}) as RequestInit;
    const requestBody = JSON.parse(String(requestInit.body));
    expect(requestBody.model).toBe("default");
    expect(requestBody.previous_response_id).toBe(seededPreviousResponseId("agent-3"));
    expect(result.exitCode).toBe(0);
    expect(result.sessionParams).toEqual({ responseId: "resp_124" });
  });

  it("uses runtime session responseId over deterministic seed when present", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      id: "resp_200",
      model: "default",
      output: [{ type: "message", content: "ok" }],
    }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }));

    vi.stubGlobal("fetch", fetchMock);

    const result = await execute({
      runId: "run-4",
      agent: {
        id: "agent-4",
        companyId: "company-1",
        name: "Agent",
        adapterType: "ironclaw_http",
        adapterConfig: {},
      },
      runtime: {
        sessionId: null,
        sessionParams: { responseId: "resp_existing" },
        sessionDisplayId: null,
        taskKey: null,
      },
      config: {
        env: {
          IRONCLAW_BASE_URL: "http://127.0.0.1:3000",
          IRONCLAW_API_KEY: "token-123",
        },
      },
      context: {
        input: "continue",
      },
      onLog: async () => {},
    });

    const calls = fetchMock.mock.calls as unknown as Array<[string, RequestInit?]>;
    const requestInit = (calls[0]?.[1] ?? {}) as RequestInit;
    const requestBody = JSON.parse(String(requestInit.body));
    expect(requestBody.stream).toBe(false);
    expect(requestBody.previous_response_id).toBe("resp_existing");
    expect(result.exitCode).toBe(0);
  });

  it("fails when Ironclaw returns response status=failed", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      id: "resp_failed_1",
      model: "qwen3:8b",
      status: "failed",
      error: { message: "backend stream failed" },
      output: [],
    }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }));

    vi.stubGlobal("fetch", fetchMock);

    const result = await execute({
      runId: "run-failed-status-1",
      agent: {
        id: "agent-failed-status-1",
        companyId: "company-1",
        name: "CEO",
        adapterType: "ironclaw_http",
        adapterConfig: {},
      },
      runtime: {
        sessionId: null,
        sessionParams: { responseId: "resp_existing" },
        sessionDisplayId: null,
        taskKey: null,
      },
      config: {
        env: {
          IRONCLAW_BASE_URL: "http://127.0.0.1:3000",
          IRONCLAW_API_KEY: "token-123",
        },
      },
      context: {
        input: "continue",
      },
      onLog: async () => {},
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result.exitCode).toBe(1);
    expect(result.errorCode).toBe("ironclaw_response_failed");
    expect(result.errorMessage).toContain("backend stream failed");
    expect(result.resultJson).toMatchObject({
      id: "resp_failed_1",
      status: "failed",
    });
  });

  it("warns when Ironclaw returns a suspiciously short non-stream response", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      id: "resp_short_warn_1",
      model: "qwen3:8b",
      status: "completed",
      output: [{ type: "message", content: "Based" }],
    }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }));

    vi.stubGlobal("fetch", fetchMock);
    const onLog = vi.fn(async () => {});

    const result = await execute({
      runId: "run-short-warn-1",
      agent: {
        id: "agent-short-warn-1",
        companyId: "company-1",
        name: "CEO",
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
        env: {
          IRONCLAW_BASE_URL: "http://127.0.0.1:3000",
          IRONCLAW_API_KEY: "token-123",
        },
      },
      context: {
        input: "continue",
      },
      onLog,
    });

    expect(result.exitCode).toBe(0);
    expect(onLog).toHaveBeenCalledWith("stdout", "Based\n");
    expect(onLog).toHaveBeenCalledWith(
      "stderr",
      expect.stringContaining("Warning: low_signal_short_text response from Ironclaw"),
    );
    expect(result.resultJson).toMatchObject({
      paperclip_response_quality: {
        classification: "low_signal_short_text",
        low_signal_detected: true,
        retry_recommendation: "fresh_session",
      },
    });
  });

  it("does not warn for a normal-length response", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      id: "resp_no_warn_1",
      model: "qwen3:8b",
      status: "completed",
      output: [{ type: "message", content: "This is a normal complete answer from Ironclaw." }],
    }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }));

    vi.stubGlobal("fetch", fetchMock);
    const onLog = vi.fn(async () => {});

    const result = await execute({
      runId: "run-no-warn-1",
      agent: {
        id: "agent-no-warn-1",
        companyId: "company-1",
        name: "CEO",
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
        env: {
          IRONCLAW_BASE_URL: "http://127.0.0.1:3000",
          IRONCLAW_API_KEY: "token-123",
        },
      },
      context: {
        input: "continue",
      },
      onLog,
    });

    expect(result.exitCode).toBe(0);
    expect(onLog).toHaveBeenCalledWith("stdout", "This is a normal complete answer from Ironclaw.\n");
    expect(result.resultJson).toMatchObject({
      paperclip_response_quality: {
        classification: "normal_text",
        low_signal_detected: false,
        retry_recommendation: "none",
      },
    });
    expect(onLog).not.toHaveBeenCalledWith(
      "stderr",
      expect.stringContaining("Warning: low_signal_short_text response from Ironclaw"),
    );
  });

  it("prefers paperclipTaskMarkdown over fallback input and prefixes agent label", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      id: "resp_300",
      model: "default",
      output: [{ type: "message", content: "ok" }],
    }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }));

    vi.stubGlobal("fetch", fetchMock);

    const result = await execute({
      runId: "run-5",
      agent: {
        id: "f9dcf478-88ac-496e-96df-79a3c4927057",
        companyId: "company-1",
        name: "CEO",
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
        env: {
          IRONCLAW_BASE_URL: "http://127.0.0.1:3000",
          IRONCLAW_API_KEY: "token-123",
        },
      },
      context: {
        input: "",
        paperclipTaskMarkdown: "Paperclip task context:\n- Issue: \"AHOA-1\"\n- Title: \"Do work\"",
      },
      onLog: async () => {},
    });

    const calls = fetchMock.mock.calls as unknown as Array<[string, RequestInit?]>;
    const requestBody = JSON.parse(String(calls[0]?.[1]?.body ?? "{}"));
    expect(requestBody.input).toContain("CEO heartbeat task:");
    expect(requestBody.input).toContain("Paperclip task context:");
    expect(result.exitCode).toBe(0);
  });

  it("uses agent-specific fallback when no contextual input is available", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      id: "resp_301",
      model: "default",
      output: [{ type: "message", content: "ok" }],
    }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }));

    vi.stubGlobal("fetch", fetchMock);

    const result = await execute({
      runId: "run-6",
      agent: {
        id: "f9dcf478-88ac-496e-96df-79a3c4927057",
        companyId: "company-1",
        name: "CEO",
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
        env: {
          IRONCLAW_BASE_URL: "http://127.0.0.1:3000",
          IRONCLAW_API_KEY: "token-123",
        },
      },
      context: {},
      onLog: async () => {},
    });

    const calls = fetchMock.mock.calls as unknown as Array<[string, RequestInit?]>;
    const requestBody = JSON.parse(String(calls[0]?.[1]?.body ?? "{}"));
    expect(requestBody.input).toBe("CEO heartbeat task:\n\nExecute the assigned task.");
    expect(requestBody.x_context?.conversation?.label).toBe("CEO heartbeat");
    expect(requestBody.x_context?.conversation?.title).toBe("CEO");
    expect(requestBody.x_context?.paperclip?.wakeSource).toBeNull();
    expect(result.exitCode).toBe(0);
  });

  it("uses manualTaskMarkdown when paperclipTaskMarkdown is unavailable", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      id: "resp_302",
      model: "default",
      output: [{ type: "message", content: "ok" }],
    }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }));

    vi.stubGlobal("fetch", fetchMock);

    const result = await execute({
      runId: "run-7",
      agent: {
        id: "agent-7",
        companyId: "company-1",
        name: "CEO",
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
        env: {
          IRONCLAW_BASE_URL: "http://127.0.0.1:3000",
          IRONCLAW_API_KEY: "token-123",
        },
      },
      context: {
        manualTaskMarkdown: "Manual wake task context:\n- Reason: \"manual\"",
      },
      onLog: async () => {},
    });

    const calls = fetchMock.mock.calls as unknown as Array<[string, RequestInit?]>;
    const requestBody = JSON.parse(String(calls[0]?.[1]?.body ?? "{}"));
    expect(requestBody.input).toContain("CEO heartbeat task:\n\nManual wake task context:");
    expect(result.exitCode).toBe(0);
  });

  it("omits previous_response_id when forceFreshSession is requested", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      id: "resp_400",
      model: "default",
      output: [{ type: "message", content: "ok" }],
    }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }));

    vi.stubGlobal("fetch", fetchMock);

    const result = await execute({
      runId: "run-8",
      agent: {
        id: "agent-8",
        companyId: "company-1",
        name: "CEO",
        adapterType: "ironclaw_http",
        adapterConfig: {},
      },
      runtime: {
        sessionId: null,
        sessionParams: { responseId: "resp_existing" },
        sessionDisplayId: null,
        taskKey: "adhoc-task",
      },
      config: {
        env: {
          IRONCLAW_BASE_URL: "http://127.0.0.1:3000",
          IRONCLAW_API_KEY: "token-123",
        },
      },
      context: {
        forceFreshSession: true,
        manualTaskMarkdown: "Manual wake task context:\n- Task key: \"adhoc-task\"",
      },
      onLog: async () => {},
    });

    const calls = fetchMock.mock.calls as unknown as Array<[string, RequestInit?]>;
    const requestBody = JSON.parse(String(calls[0]?.[1]?.body ?? "{}"));
    expect(requestBody.previous_response_id).toBeUndefined();
    expect(requestBody.x_context?.conversation?.label).toBe("CEO heartbeat");
    expect(requestBody.x_context?.conversation?.title).toBe("CEO");
    expect(result.exitCode).toBe(0);
  });

  it("injects managed instructions separately and selected runtime skills into the outbound prompt", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "ironclaw-execute-test-"));
    const instructionsPath = path.join(tempDir, "AGENTS.md");
    const skillDir = path.join(tempDir, "paperclip-converting-plans-to-tasks");
    const skillPath = path.join(skillDir, "SKILL.md");
    await fs.mkdir(skillDir, { recursive: true });
    await fs.writeFile(instructionsPath, "# Agent instructions\nAlways decompose approved plans.", "utf8");
    await fs.writeFile(skillPath, "# Plan to tasks\nUse blockedByIssueIds for real blockers.", "utf8");

    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      id: "resp_500",
      model: "default",
      output: [{ type: "message", content: "ok" }],
    }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }));
    vi.stubGlobal("fetch", fetchMock);

    try {
      const result = await execute({
        runId: "run-9",
        agent: {
          id: "agent-9",
          companyId: "company-1",
          name: "CEO",
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
          env: {
            IRONCLAW_BASE_URL: "http://127.0.0.1:3000",
            IRONCLAW_API_KEY: "token-123",
          },
          instructionsFilePath: instructionsPath,
          metadata: {
            source: "nextcloud-talk",
            channel: "operations",
          },
          temperature: 0.25,
          numCtx: 8192,
          thinkingMode: "on",
          paperclipRuntimeSkills: [
            {
              key: "paperclip-converting-plans-to-tasks",
              runtimeName: "paperclip-converting-plans-to-tasks",
              source: skillDir,
              sourceStatus: "available",
              required: false,
            },
          ],
          paperclipSkillSync: {
            desiredSkills: ["paperclip-converting-plans-to-tasks"],
          },
        },
        context: {
          paperclipTaskMarkdown: "Paperclip task context:\n- Issue: \"AHOA-1\"",
          paperclipStrategicContext: {
            company: { id: "company-1", name: "AHOA" },
          },
        },
        onLog: async () => {},
      });

      const calls = fetchMock.mock.calls as unknown as Array<[string, RequestInit?]>;
      const requestBody = JSON.parse(String(calls[0]?.[1]?.body ?? "{}"));
      expect(requestBody.input).not.toContain("Managed agent instructions");
      expect(requestBody.input).not.toContain("Always decompose approved plans.");
      expect(requestBody.input).not.toContain("Paperclip runtime skills");
      expect(requestBody.input).not.toContain("Skill: paperclip-converting-plans-to-tasks");
      expect(requestBody.input).not.toContain("Use blockedByIssueIds for real blockers.");
      expect(requestBody.instructions).toContain("Always decompose approved plans.");
      expect(requestBody.instructions).toContain("Execution contract:");
      expect(requestBody.metadata).toMatchObject({
        source: "nextcloud-talk",
        channel: "operations",
      });
      expect(requestBody.temperature).toBe(0.25);
      expect(requestBody.num_ctx).toBe(8192);
      expect(requestBody.thinking_mode).toBe("on");
      expect(requestBody.x_context.paperclip.runtimeSkills).toEqual(["paperclip-converting-plans-to-tasks"]);
      expect(requestBody.x_context.paperclip.runtimeSkillSummaries).toEqual([
        {
          key: "paperclip-converting-plans-to-tasks",
          summary: "Use blockedByIssueIds for real blockers.",
        },
      ]);
      expect(requestBody.x_context.paperclip.runtimeSkillSelection).toMatchObject({
        selectedCount: 1,
        summaryCount: 1,
        rationale: "selected_from_paperclip_runtime_skills",
      });
      expect(requestBody.x_context.paperclip.continuationPolicy).toMatchObject({
        continuationMode: "chained",
        lowSignalDetected: false,
        retryRecommendation: "none",
      });
      expect(requestBody.x_context.paperclip.managedInstructionsAttached).toBe(true);
      expect(requestBody.x_context.paperclip.requestControls).toMatchObject({
        temperature: 0.25,
        numCtx: 8192,
        thinkingMode: "on",
        metadataAttached: true,
      });
      expect(requestBody.x_context.paperclip.strategicContext).toMatchObject({
        company: { id: "company-1", name: "AHOA" },
      });
      expect(result.exitCode).toBe(0);
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("uses task-scoped seed for previous_response_id when issueId is present", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      id: "resp_601",
      model: "default",
      output: [{ type: "message", content: "ok" }],
    }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }));
    vi.stubGlobal("fetch", fetchMock);

    const agentId = "agent-task-seed";
    const issueId = "issue-abc-123";

    await execute({
      runId: "run-task-seed",
      agent: {
        id: agentId,
        companyId: "company-1",
        name: "CEO",
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
        env: {
          IRONCLAW_BASE_URL: "http://127.0.0.1:3000",
          IRONCLAW_API_KEY: "token-123",
        },
      },
      context: {
        issueId,
        input: "do the task",
      },
      onLog: async () => {},
    });

    const calls = fetchMock.mock.calls as unknown as Array<[string, RequestInit?]>;
    const requestBody = JSON.parse(String(calls[0]?.[1]?.body ?? "{}"));
    // Must use task-scoped seed, not agent-level seed
    expect(requestBody.previous_response_id).toBe(seededPreviousResponseId(agentId, issueId));
    expect(requestBody.previous_response_id).not.toBe(seededPreviousResponseId(agentId));
    // Strategy label reflects task-scoped seed
    expect(requestBody.x_context.paperclip.continuationPolicy.conversationStrategy).toBe("task_scoped_seed");
  });

  it("forces fresh session when retryReason is set and no prior session exists", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      id: "resp_602",
      model: "default",
      output: [{ type: "message", content: "ok" }],
    }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }));
    vi.stubGlobal("fetch", fetchMock);

    await execute({
      runId: "run-retry-fresh",
      agent: {
        id: "agent-retry",
        companyId: "company-1",
        name: "CEO",
        adapterType: "ironclaw_http",
        adapterConfig: {},
      },
      runtime: {
        sessionId: null,
        sessionParams: null, // no prior session
        sessionDisplayId: null,
        taskKey: null,
      },
      config: {
        env: {
          IRONCLAW_BASE_URL: "http://127.0.0.1:3000",
          IRONCLAW_API_KEY: "token-123",
        },
      },
      context: {
        issueId: "issue-retry",
        retryReason: "issue_continuation_needed",
        retryOfRunId: "a38ec39c-54c9-4bd3-811d-2de9834d1bd1",
        input: "retry the task",
      },
      onLog: async () => {},
    });

    const calls = fetchMock.mock.calls as unknown as Array<[string, RequestInit?]>;
    const requestBody = JSON.parse(String(calls[0]?.[1]?.body ?? "{}"));
    // Must not send previous_response_id — fresh thread
    expect(requestBody.previous_response_id).toBeUndefined();
    expect(requestBody.x_context.paperclip.continuationPolicy.conversationStrategy).toBe("retry_fresh_session");
    expect(requestBody.x_context.paperclip.continuationPolicy.freshSessionReason).toBe(
      "retry_of_failed_run_no_prior_session",
    );
    expect(requestBody.x_context.paperclip.continuationPolicy.continuationMode).toBe("fresh");
  });

  it("does not send thinking_mode when thinkingMode is auto", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      id: "resp_501",
      model: "default",
      output: [{ type: "message", content: "ok" }],
    }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await execute({
      runId: "run-10",
      agent: {
        id: "agent-10",
        companyId: "company-1",
        name: "CEO",
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
        env: {
          IRONCLAW_BASE_URL: "http://127.0.0.1:3000",
          IRONCLAW_API_KEY: "token-123",
        },
        thinkingMode: "auto",
      },
      context: {
        input: "hello",
      },
      onLog: async () => {},
    });

    const calls = fetchMock.mock.calls as unknown as Array<[string, RequestInit?]>;
    const requestBody = JSON.parse(String(calls[0]?.[1]?.body ?? "{}"));
    expect(requestBody.thinking_mode).toBeUndefined();
    expect(requestBody.x_context.paperclip.requestControls.thinkingMode).toBe("auto");
    expect(result.exitCode).toBe(0);
  });
});
