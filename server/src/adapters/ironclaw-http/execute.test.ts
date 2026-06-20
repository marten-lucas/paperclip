import { afterEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execute } from "./execute.js";

function seededPreviousResponseId(agentId: string): string {
  const threadHex = createHash("sha256")
    .update(`paperclip-agent-thread:${agentId}`)
    .digest("hex")
    .slice(0, 32);
  const responseHex = createHash("sha256")
    .update(`paperclip-agent-seed-response:${agentId}`)
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

  it("reads URL/token from env bindings, omits non-default model, and stores response id", async () => {
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
    expect(requestBody.model).toBeUndefined();
    expect(requestBody.input).toBe("say hi");
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
    expect(requestBody.previous_response_id).toBe("resp_existing");
    expect(result.exitCode).toBe(0);
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
          maxOutputTokens: 1234,
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
      expect(requestBody.instructions).toContain("Always decompose approved plans.");
      expect(requestBody.input).toContain("Paperclip runtime skills");
      expect(requestBody.input).toContain("Skill: paperclip-converting-plans-to-tasks");
      expect(requestBody.input).toContain("Use blockedByIssueIds for real blockers.");
      expect(requestBody.metadata).toMatchObject({
        source: "nextcloud-talk",
        channel: "operations",
      });
      expect(requestBody.temperature).toBe(0.25);
      expect(requestBody.max_output_tokens).toBe(1234);
      expect(requestBody.num_ctx).toBe(8192);
      expect(requestBody.thinking_mode).toBe("on");
      expect(requestBody.x_context.paperclip.runtimeSkills).toEqual(["paperclip-converting-plans-to-tasks"]);
      expect(requestBody.x_context.paperclip.managedInstructionsAttached).toBe(true);
      expect(requestBody.x_context.paperclip.requestControls).toMatchObject({
        temperature: 0.25,
        maxOutputTokens: 1234,
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
