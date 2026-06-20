import type { AdapterExecutionContext, AdapterExecutionResult } from "../types.js";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { resolvePaperclipDesiredSkillNames } from "@paperclipai/adapter-utils/server-utils";
import { asNumber, asString, parseObject } from "../utils.js";
const MAX_INSTRUCTIONS_CHARS = 12_000;
const MAX_SKILLS_IN_PROMPT = 6;
const MAX_SKILL_CHARS = 4_000;

type IronclawUsage = {
  input_tokens?: number;
  output_tokens?: number;
  inputTokens?: number;
  outputTokens?: number;
};

type RuntimeSkillEntry = {
  key: string;
  runtimeName: string;
  source: string;
  sourceStatus: "available" | "missing";
  required: boolean;
};

function isHttpUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

function resolveBaseUrl(rawUrl: string): string {
  const trimmed = rawUrl.trim();
  if (!trimmed) return "";
  const normalized = trimmed.endsWith("/api/v1/responses")
    ? trimmed
    : `${trimmed.replace(/\/$/, "")}/api/v1/responses`;
  return isHttpUrl(normalized) ? normalized : "";
}

function toUuidHex(value: string): string {
  const trimmed = value.trim();
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(trimmed)) {
    return trimmed.replace(/-/g, "").toLowerCase();
  }

  return createHash("sha256").update(trimmed).digest("hex").slice(0, 32);
}

function buildSeededPreviousResponseId(agentId: string): string {
  const threadHex = toUuidHex(`paperclip-agent-thread:${agentId}`);
  const responseHex = createHash("sha256")
    .update(`paperclip-agent-seed-response:${agentId}`)
    .digest("hex")
    .slice(0, 32);
  return `resp_${responseHex}${threadHex}`;
}

function buildConversationLabel(agentLabel: string): string {
  if (/\bceo\b/i.test(agentLabel)) return "CEO heartbeat";
  return `${agentLabel} heartbeat`;
}

function truncateChars(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  return `${value.slice(0, maxChars)}\n\n...[truncated by Paperclip]`;
}

function parseRuntimeSkillEntries(config: Record<string, unknown>): RuntimeSkillEntry[] {
  const raw = Array.isArray(config.paperclipRuntimeSkills) ? config.paperclipRuntimeSkills : [];
  const out: RuntimeSkillEntry[] = [];
  for (const entry of raw) {
    const parsed = parseObject(entry);
    const key = asString(parsed.key, "").trim();
    const runtimeName = asString(parsed.runtimeName, key).trim();
    const source = asString(parsed.source, "").trim();
    if (!key || !runtimeName || !source) continue;
    out.push({
      key,
      runtimeName,
      source,
      sourceStatus: parsed.sourceStatus === "missing" ? "missing" : "available",
      required: parsed.required === true,
    });
  }
  return out;
}

async function readManagedInstructions(
  config: Record<string, unknown>,
  onLog: AdapterExecutionContext["onLog"],
): Promise<{ content: string | null; sourcePath: string | null }> {
  const sourcePath = asString(config.instructionsFilePath, "").trim();
  if (!sourcePath) return { content: null, sourcePath: null };

  try {
    const text = (await fs.readFile(sourcePath, "utf8")).trim();
    if (!text) return { content: null, sourcePath };
    return {
      content: truncateChars(text, MAX_INSTRUCTIONS_CHARS),
      sourcePath,
    };
  } catch (error) {
    await onLog(
      "stderr",
      `[paperclip] Failed to read managed instructions at ${sourcePath}: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    return { content: null, sourcePath };
  }
}

async function readSelectedSkillMarkdown(
  config: Record<string, unknown>,
  onLog: AdapterExecutionContext["onLog"],
): Promise<{ selectedKeys: string[]; sections: string[] }> {
  const entries = parseRuntimeSkillEntries(config);
  if (entries.length === 0) return { selectedKeys: [], sections: [] };

  const desired = new Set(resolvePaperclipDesiredSkillNames(config, entries));
  const selected = entries
    .filter((entry) => desired.has(entry.key) && entry.sourceStatus !== "missing")
    .slice(0, MAX_SKILLS_IN_PROMPT);
  if (selected.length === 0) return { selectedKeys: [], sections: [] };

  const sections: string[] = [];
  for (const entry of selected) {
    const markdownPath = path.join(entry.source, "SKILL.md");
    try {
      const markdown = (await fs.readFile(markdownPath, "utf8")).trim();
      if (!markdown) continue;
      sections.push([
        `### Skill: ${entry.key}`,
        "",
        truncateChars(markdown, MAX_SKILL_CHARS),
      ].join("\n"));
    } catch (error) {
      await onLog(
        "stderr",
        `[paperclip] Failed to read runtime skill ${entry.key} at ${markdownPath}: ${error instanceof Error ? error.message : String(error)}\n`,
      );
    }
  }

  return {
    selectedKeys: selected.map((entry) => entry.key),
    sections,
  };
}

async function buildPromptInput(
  ctx: AdapterExecutionContext,
  config: Record<string, unknown>,
): Promise<{ prompt: string; attachedSkills: string[]; hasManagedInstructions: boolean; instructions: string | null }> {
  const basePrompt = extractMessage(ctx);
  const [instructions, skillBundle] = await Promise.all([
    readManagedInstructions(config, ctx.onLog),
    readSelectedSkillMarkdown(config, ctx.onLog),
  ]);

  const sections = [basePrompt];
  if (skillBundle.sections.length > 0) {
    sections.push(["Paperclip runtime skills:", ...skillBundle.sections].join("\n\n"));
  }

  return {
    prompt: sections.join("\n\n---\n\n"),
    attachedSkills: skillBundle.selectedKeys,
    hasManagedInstructions: Boolean(instructions.content),
    instructions: instructions.content,
  };
}

function parseConfiguredMetadata(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function parseMetadataJson(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "string" || value.trim().length === 0) return null;
  try {
    const parsed = JSON.parse(value);
    return parseConfiguredMetadata(parsed);
  } catch {
    return null;
  }
}

function parseThinkingMode(value: unknown): "auto" | "on" | "off" {
  const normalized = asString(value, "auto").trim().toLowerCase();
  if (normalized === "on" || normalized === "off") return normalized;
  return "auto";
}

function extractMessage(ctx: AdapterExecutionContext): string {
  const agentLabel = asString(ctx.agent.name, "").trim() || "Agent";
  const taskMarkdown = asString(ctx.context.paperclipTaskMarkdown, "").trim();
  if (taskMarkdown.length > 0) {
    return `${agentLabel} heartbeat task:\n\n${taskMarkdown}`;
  }

  const manualTaskMarkdown = asString(ctx.context.manualTaskMarkdown, "").trim();
  if (manualTaskMarkdown.length > 0) {
    return `${agentLabel} heartbeat task:\n\n${manualTaskMarkdown}`;
  }

  const wakePayload = parseObject(ctx.context.paperclipWake);
  const wakeSummary = asString(wakePayload.summary, "").trim();
  if (wakeSummary.length > 0) {
    return wakeSummary;
  }

  if (typeof ctx.context.input === "string" && ctx.context.input.trim().length > 0) {
    return ctx.context.input;
  }

  if (typeof ctx.context.prompt === "string" && ctx.context.prompt.trim().length > 0) {
    return ctx.context.prompt;
  }

  const inputObj = parseObject(ctx.context.input);
  const candidates = [inputObj.value, inputObj.text, inputObj.content, ctx.context.message];
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim().length > 0) {
      return candidate;
    }
  }

  return `${agentLabel} heartbeat task:\n\nExecute the assigned task.`;
}

function extractOutputText(output: unknown): string {
  if (typeof output === "string") return output;
  if (!Array.isArray(output)) return "";

  const chunks: string[] = [];
  for (const item of output) {
    if (!item || typeof item !== "object") continue;
    const typedItem = item as { type?: unknown; content?: unknown };
    if (typedItem.type !== "message") continue;

    if (typeof typedItem.content === "string") {
      chunks.push(typedItem.content);
      continue;
    }

    if (Array.isArray(typedItem.content)) {
      for (const part of typedItem.content) {
        if (part && typeof part === "object" && "text" in part) {
          const text = (part as { text?: unknown }).text;
          if (typeof text === "string" && text.length > 0) chunks.push(text);
        }
      }
    }
  }

  return chunks.join("\n");
}

function toUsage(usage: unknown): AdapterExecutionResult["usage"] | undefined {
  if (!usage || typeof usage !== "object") return undefined;
  const typedUsage = usage as IronclawUsage;

  const inputTokens = asNumber(typedUsage.input_tokens ?? typedUsage.inputTokens, 0);
  const outputTokens = asNumber(typedUsage.output_tokens ?? typedUsage.outputTokens, 0);
  if (inputTokens <= 0 && outputTokens <= 0) return undefined;

  return { inputTokens, outputTokens };
}

export async function execute(ctx: AdapterExecutionContext): Promise<AdapterExecutionResult> {
  const config = parseObject(ctx.config);
  const env = parseObject(config.env);
  const rawBaseUrl = asString(env.IRONCLAW_BASE_URL, "").trim() || asString(config.url, "").trim();
  const rawApiKey = asString(env.IRONCLAW_API_KEY, "").trim() || asString(config.authToken, "").trim();
  const resolvedUrl = isHttpUrl(rawBaseUrl)
    ? rawBaseUrl
    : isHttpUrl(rawApiKey) && rawApiKey
      ? rawApiKey
      : rawBaseUrl;
  const resolvedToken = !isHttpUrl(rawApiKey) && rawApiKey
    ? rawApiKey
    : !isHttpUrl(rawBaseUrl) && rawBaseUrl
      ? rawBaseUrl
      : rawApiKey;
  const url = resolveBaseUrl(resolvedUrl);
  const authToken = resolvedToken;
  const requestedModel = asString(config.model, "").trim();
  const requestModel = requestedModel;
  const rawTimeoutSec = asNumber(config.timeoutSec, 120);
  const timeoutSec = Number.isFinite(rawTimeoutSec)
    ? (rawTimeoutSec <= 0 ? 0 : Math.min(3600, rawTimeoutSec))
    : 120;

  if (!url || !authToken) {
    return {
      exitCode: 1,
      signal: null,
      timedOut: false,
      errorCode: "ironclaw_config_missing",
      errorMessage: "url and authToken are required",
    };
  }

  const promptInput = await buildPromptInput(ctx, config);
  const input = promptInput.prompt;
  const agentLabel = asString(ctx.agent.name, "").trim() || "Agent";
  const wakeSource = asString(ctx.context.wakeSource, "").trim();
  const wakeReason = asString(ctx.context.wakeReason, "").trim();
  const wakeTriggerDetail = asString(ctx.context.wakeTriggerDetail, "").trim();
  const taskKey = asString(ctx.context.taskKey, "").trim() || ctx.runtime.taskKey || "";
  const issueId = asString(ctx.context.issueId, "").trim();
  const forceFreshSession = ctx.context.forceFreshSession === true;
  const strategicContext = parseObject(ctx.context.paperclipStrategicContext);
  const configuredMetadata =
    parseConfiguredMetadata(config.metadata) ?? parseMetadataJson(config.metadataJson) ?? null;
  const temperature = asNumber(config.temperature, Number.NaN);
  const numCtx = Math.max(0, Math.floor(asNumber(config.numCtx ?? config.num_ctx, 0)));
  const thinkingMode = parseThinkingMode(config.thinkingMode ?? config.thinking_mode);
  const body: Record<string, unknown> = {
    input,
    // Ironclaw extension field. Used to persist Paperclip-side invocation
    // identity in gateway conversation metadata.
    x_context: {
      paperclip: {
        source: "paperclip_heartbeat",
        runId: ctx.runId,
        companyId: ctx.agent.companyId,
        agentId: ctx.agent.id,
        agentName: agentLabel,
        wakeSource: wakeSource || null,
        wakeReason: wakeReason || null,
        wakeTriggerDetail: wakeTriggerDetail || null,
        taskKey: taskKey || null,
        issueId: issueId || null,
        strategicContext: Object.keys(strategicContext).length > 0 ? strategicContext : null,
        runtimeSkills: promptInput.attachedSkills,
        managedInstructionsAttached: promptInput.hasManagedInstructions,
        requestControls: {
          temperature: Number.isFinite(temperature) ? temperature : null,
          numCtx: numCtx > 0 ? numCtx : null,
          thinkingMode,
          metadataAttached: Boolean(configuredMetadata),
        },
      },
      conversation: {
        label: buildConversationLabel(agentLabel),
        kind: "paperclip_heartbeat",
      },
    },
  };
  if (promptInput.instructions) {
    body.instructions = promptInput.instructions;
  }
  if (configuredMetadata) {
    body.metadata = configuredMetadata;
  }
  // Forward an explicit model when configured. Omitting the field keeps
  // Ironclaw on its server-side default selection.
  if (requestModel) body.model = requestModel;
  if (Number.isFinite(temperature) && temperature >= 0 && temperature <= 2) {
    body.temperature = temperature;
  }
  if (numCtx > 0) {
    body.num_ctx = numCtx;
  }
  if (thinkingMode !== "auto") {
    body.thinking_mode = thinkingMode;
  }

  const previousResponseId =
    ctx.runtime.sessionParams && typeof ctx.runtime.sessionParams === "object"
      ? asString((ctx.runtime.sessionParams as Record<string, unknown>).responseId, "")
      : "";
  const seededPreviousResponseId = buildSeededPreviousResponseId(ctx.agent.id);
  const effectivePreviousResponseId = forceFreshSession
    ? ""
    : (previousResponseId || seededPreviousResponseId);
  if (effectivePreviousResponseId) {
    body.previous_response_id = effectivePreviousResponseId;
  }

  const controller = new AbortController();
  const timer = timeoutSec > 0
    ? setTimeout(() => controller.abort(), timeoutSec * 1000)
    : null;

  if (ctx.onMeta) {
    await ctx.onMeta({
      adapterType: "ironclaw_http",
      command: `POST ${url}`,
      context: {
        model: requestModel || "(default)",
        requestedModel: requestedModel || "(default)",
        auth: authToken ? "configured" : "missing",
        source: {
          url: asString(env.IRONCLAW_BASE_URL, "").trim().length > 0 ? "env.IRONCLAW_BASE_URL" : "adapterConfig.url",
          token: asString(env.IRONCLAW_API_KEY, "").trim().length > 0 ? "env.IRONCLAW_API_KEY" : "adapterConfig.authToken",
        },
        conversation: {
          strategy: forceFreshSession
            ? "fresh_session"
            : previousResponseId
              ? "session_previous_response_id"
              : "deterministic_agent_seed",
          previousResponseId: effectivePreviousResponseId || null,
        },
        managedInstructionsAttached: promptInput.hasManagedInstructions,
        runtimeSkillsAttached: promptInput.attachedSkills,
      },
      prompt: input,
      promptMetrics: {
        inputChars: input.length,
      },
    });
  }

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${authToken}`,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => "");
      return {
        exitCode: 1,
        signal: null,
        timedOut: false,
        errorCode: "ironclaw_http_error",
        errorMessage: `Ironclaw request failed with status ${response.status}${errorText ? `: ${errorText.slice(0, 200)}` : ""}`,
      };
    }

    const payload = (await response.json().catch(() => ({}))) as Record<string, unknown>;
    const text = extractOutputText(payload.output) || asString(payload.output_text, "");
    if (text) {
      await ctx.onLog("stdout", `${text}\n`);
    }

    const responseId = asString(payload.id, "").trim();

    return {
      exitCode: 0,
      signal: null,
      timedOut: false,
      model: asString(payload.model, requestModel || "") || null,
      usage: toUsage(payload.usage),
      resultJson: payload,
      summary: `Ironclaw HTTP ${requestModel || "default model"}`,
      sessionParams: responseId ? { responseId } : undefined,
      sessionDisplayId: responseId || undefined,
    };
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      return {
        exitCode: null,
        signal: null,
        timedOut: true,
        errorCode: "timeout",
        errorMessage: `Ironclaw request timed out after ${timeoutSec}s`,
      };
    }

    const message = err instanceof Error ? err.message : String(err);
    return {
      exitCode: 1,
      signal: null,
      timedOut: false,
      errorCode: "ironclaw_request_failed",
      errorMessage: message,
    };
  } finally {
    if (timer) clearTimeout(timer);
  }
}
