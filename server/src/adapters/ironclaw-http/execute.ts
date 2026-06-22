import type { AdapterExecutionContext, AdapterExecutionResult } from "../types.js";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { resolvePaperclipDesiredSkillNames } from "@paperclipai/adapter-utils/server-utils";
import { asNumber, asString, parseObject } from "../utils.js";
const MAX_INSTRUCTIONS_CHARS = 12_000;
const MAX_SKILLS_IN_PROMPT = 6;
const MAX_RUNTIME_SKILL_SUMMARY_CHARS = 240;
const MAX_TOOL_ROUNDTRIPS = 6;
const MAX_TOOL_OUTPUT_CHARS = 20_000;

type ResponseQualityClassification = "empty_text" | "low_signal_short_text" | "normal_text";

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

type RuntimeSkillSummary = {
  key: string;
  summary: string;
};

type CompletionDisposition =
  | "done"
  | "cancelled"
  | "in_review"
  | "blocked"
  | "delegated_followup"
  | "continue_in_progress";

type ParsedCompletion = {
  disposition: CompletionDisposition;
  nextAction: string;
  reason: string | null;
};

type CompletionValidation = {
  ok: boolean;
  errorCode?: "missing_structured_completion" | "invalid_completion_schema";
  message?: string;
  parsed?: ParsedCompletion;
};

type IronclawFunctionCall = {
  callId: string;
  name: string;
  argumentsJson: string;
};

type PaperclipApiCallArgs = {
  method?: string;
  path?: string;
  url?: string;
  query?: Record<string, unknown>;
  body?: unknown;
  headers?: Record<string, unknown>;
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

// Build a deterministic seed previous_response_id. When an issueId is provided
// the seed is scoped to the task so different issues get isolated threads.
// Without an issueId the seed falls back to the agent level, which is used only
// for runs that have no task context (pure timer/manual wakes).
function buildSeededPreviousResponseId(agentId: string, issueId?: string): string {
  const scopeKey = issueId
    ? `paperclip-task-thread:${agentId}:${issueId}`
    : `paperclip-agent-thread:${agentId}`;
  const threadHex = toUuidHex(scopeKey);
  const responseScopeKey = issueId
    ? `paperclip-task-seed-response:${agentId}:${issueId}`
    : `paperclip-agent-seed-response:${agentId}`;
  const responseHex = createHash("sha256")
    .update(responseScopeKey)
    .digest("hex")
    .slice(0, 32);
  return `resp_${responseHex}${threadHex}`;
}

type FreshSessionDecision = {
  forceFresh: boolean;
  reason:
    | "force_fresh_session_requested"
    | "manual_on_demand_without_issue"
    | "retry_of_failed_run_no_prior_session"
    | "default_chained_session";
};

// Determine whether this adapter invocation should start a completely fresh
// Ironclaw conversation rather than continuing the prior one.
//
// Rules (evaluated in priority order):
// 1. Explicit `forceFreshSession` in context always wins.
// 2. When a run is a retry of a failed/timed-out predecessor AND there is no
//    existing live session to continue from, force fresh so the retry does not
//    inherit a contaminated or partially-completed thread.
function decideFreshSession(
  ctx: AdapterExecutionContext,
  previousResponseId: string,
): FreshSessionDecision {
  if (ctx.context.forceFreshSession === true) {
    return { forceFresh: true, reason: "force_fresh_session_requested" };
  }

  const wakeSource = asString(ctx.context.wakeSource, "").trim().toLowerCase();
  const wakeTriggerDetail = asString(ctx.context.wakeTriggerDetail, "").trim().toLowerCase();
  const issueId = asString(ctx.context.issueId, "").trim();
  if (wakeSource === "on_demand" && wakeTriggerDetail === "manual" && !issueId) {
    return { forceFresh: true, reason: "manual_on_demand_without_issue" };
  }

  const retryReason = asString(ctx.context.retryReason, "").trim();
  const retryOfRunId = asString(ctx.context.retryOfRunId, "").trim();
  if ((retryReason || retryOfRunId) && !previousResponseId) {
    return { forceFresh: true, reason: "retry_of_failed_run_no_prior_session" };
  }

  return { forceFresh: false, reason: "default_chained_session" };
}

function buildConversationLabel(agentLabel: string, runId: string, callIsoTime: string): string {
  const base = /\bceo\b/i.test(agentLabel) ? "CEO heartbeat" : `${agentLabel} heartbeat`;
  return `${base} | ${callIsoTime} | run ${runId}`;
}

function buildConversationTitle(agentLabel: string, runId: string, callIsoTime: string): string {
  const base = /\bceo\b/i.test(agentLabel) ? "CEO" : agentLabel;
  return `${base} | ${callIsoTime} | run ${runId}`;
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
): Promise<{ selectedKeys: string[]; summaries: RuntimeSkillSummary[]; selectionRationale: string }> {
  const entries = parseRuntimeSkillEntries(config);
  if (entries.length === 0) {
    return {
      selectedKeys: [],
      summaries: [],
      selectionRationale: "no_runtime_skills_configured",
    };
  }

  const desired = new Set(resolvePaperclipDesiredSkillNames(config, entries));
  const selected = entries
    .filter((entry) => desired.has(entry.key) && entry.sourceStatus !== "missing")
    .slice(0, MAX_SKILLS_IN_PROMPT);
  if (selected.length === 0) {
    return {
      selectedKeys: [],
      summaries: [],
      selectionRationale: "desired_skills_missing_or_unavailable",
    };
  }

  const summaries: RuntimeSkillSummary[] = [];
  for (const entry of selected) {
    const markdownPath = path.join(entry.source, "SKILL.md");
    try {
      const markdown = (await fs.readFile(markdownPath, "utf8")).trim();
      if (!markdown) continue;

      const summaryLine = markdown
        .split(/\r?\n/)
        .map((line) => line.trim())
        .find((line) => line.length > 0 && !line.startsWith("#") && !line.startsWith("---") && !line.startsWith("name:") && !line.startsWith("description:"));
      if (!summaryLine) continue;

      summaries.push({
        key: entry.key,
        summary: truncateChars(summaryLine, MAX_RUNTIME_SKILL_SUMMARY_CHARS),
      });
    } catch (error) {
      await onLog(
        "stderr",
        `[paperclip] Failed to read runtime skill ${entry.key} at ${markdownPath}: ${error instanceof Error ? error.message : String(error)}\n`,
      );
    }
  }

  return {
    selectedKeys: selected.map((entry) => entry.key),
    summaries,
    selectionRationale: "selected_from_paperclip_runtime_skills",
  };
}

function buildInstructionLayer(managedInstructions: string | null, enforceStructuredCompletion: boolean): string | null {
  const executionContract = [
    "Execution contract:",
    "- Act on the current heartbeat task and provide a concrete, actionable response.",
    "- If work is blocked, state the blocker and the exact next action.",
    "- Avoid one-token acknowledgements; provide useful output.",
  ].join("\n");

  const completionContract = enforceStructuredCompletion
    ? [
      "",
      "Required completion format:",
      "- End your response with a single JSON object.",
      "- Use key `paperclip_completion` with fields:",
      "  - disposition: one of done, cancelled, in_review, blocked, delegated_followup, continue_in_progress",
      "  - next_action: non-empty string",
      "  - reason: optional string",
      "- For `in_review`, include at least one of: review_owner, review_path, pending_interaction_id, pending_approval_id.",
      "- For `blocked`, include at least one of: blocked_by, unblock_owner.",
      "- For `delegated_followup`, include at least one of: follow_up_issue_id, follow_up_task_key.",
      "- For `continue_in_progress`, include resume_intent=true or resume_from_run_id.",
    ].join("\n")
    : "";
  const combinedContract = `${executionContract}${completionContract}`;

  if (!managedInstructions) {
    return truncateChars(combinedContract, MAX_INSTRUCTIONS_CHARS);
  }

  return truncateChars(`${managedInstructions}\n\n${combinedContract}`, MAX_INSTRUCTIONS_CHARS);
}

function buildTaskInputLayer(ctx: AdapterExecutionContext): string {
  return extractMessage(ctx);
}

function buildRuntimeSkillContext(skillBundle: {
  selectedKeys: string[];
  summaries: RuntimeSkillSummary[];
  selectionRationale: string;
}): {
  runtimeSkills: string[];
  runtimeSkillSummaries: RuntimeSkillSummary[];
  runtimeSkillSelection: { selectedCount: number; summaryCount: number; rationale: string };
} {
  return {
    runtimeSkills: skillBundle.selectedKeys,
    runtimeSkillSummaries: skillBundle.summaries,
    runtimeSkillSelection: {
      selectedCount: skillBundle.selectedKeys.length,
      summaryCount: skillBundle.summaries.length,
      rationale: skillBundle.selectionRationale,
    },
  };
}

async function buildPromptInput(
  ctx: AdapterExecutionContext,
  config: Record<string, unknown>,
  enforceStructuredCompletion: boolean,
): Promise<{
  taskInput: string;
  instructions: string | null;
  hasManagedInstructions: boolean;
  runtimeSkillMeta: ReturnType<typeof buildRuntimeSkillContext>;
}> {
  const [instructions, skillBundle] = await Promise.all([
    readManagedInstructions(config, ctx.onLog),
    readSelectedSkillMarkdown(config, ctx.onLog),
  ]);

  return {
    taskInput: buildTaskInputLayer(ctx),
    hasManagedInstructions: Boolean(instructions.content),
    instructions: buildInstructionLayer(instructions.content, enforceStructuredCompletion),
    runtimeSkillMeta: buildRuntimeSkillContext(skillBundle),
  };
}

function parseJsonObjectCandidate(value: string): Record<string, unknown> | null {
  const trimmed = value.trim();
  if (!trimmed) return null;

  try {
    const parsed = JSON.parse(trimmed);
    return parseConfiguredMetadata(parsed);
  } catch {
    return null;
  }
}

function extractJsonCandidates(text: string): string[] {
  const candidates: string[] = [];
  const fenceRegex = /```json\s*([\s\S]*?)```/gi;
  for (const match of text.matchAll(fenceRegex)) {
    const candidate = (match[1] ?? "").trim();
    if (candidate) candidates.push(candidate);
  }
  if (text.trim()) candidates.push(text.trim());
  return candidates;
}

function parseStructuredCompletion(text: string): Record<string, unknown> | null {
  for (const candidate of extractJsonCandidates(text)) {
    const parsed = parseJsonObjectCandidate(candidate);
    if (parsed) return parsed;
  }
  return null;
}

function hasNonEmptyString(value: unknown): boolean {
  return typeof value === "string" && value.trim().length > 0;
}

function asDisposition(value: unknown): CompletionDisposition | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  const dispositions: CompletionDisposition[] = [
    "done",
    "cancelled",
    "in_review",
    "blocked",
    "delegated_followup",
    "continue_in_progress",
  ];
  return dispositions.includes(normalized as CompletionDisposition)
    ? (normalized as CompletionDisposition)
    : null;
}

function validateIssueCompletionContract(text: string): CompletionValidation {
  const parsed = parseStructuredCompletion(text);
  if (!parsed) {
    return {
      ok: false,
      errorCode: "missing_structured_completion",
      message: "Ironclaw response did not include the required structured completion JSON.",
    };
  }

  const completion = parseObject(parsed.paperclip_completion ?? parsed);
  const disposition = asDisposition(completion.disposition);
  const nextAction = asString(completion.next_action ?? completion.nextAction, "").trim();
  const reason = asString(completion.reason, "").trim() || null;

  if (!disposition || !nextAction) {
    return {
      ok: false,
      errorCode: "invalid_completion_schema",
      message: "Structured completion must include disposition and non-empty next_action.",
    };
  }

  if (disposition === "in_review") {
    const hasReviewPath =
      hasNonEmptyString(completion.review_owner)
      || hasNonEmptyString(completion.review_path)
      || hasNonEmptyString(completion.pending_interaction_id)
      || hasNonEmptyString(completion.pending_approval_id);
    if (!hasReviewPath) {
      return {
        ok: false,
        errorCode: "invalid_completion_schema",
        message: "Disposition in_review requires review_owner, review_path, pending_interaction_id, or pending_approval_id.",
      };
    }
  }

  if (disposition === "blocked") {
    const hasBlockerPath = hasNonEmptyString(completion.blocked_by) || hasNonEmptyString(completion.unblock_owner);
    if (!hasBlockerPath) {
      return {
        ok: false,
        errorCode: "invalid_completion_schema",
        message: "Disposition blocked requires blocked_by or unblock_owner.",
      };
    }
  }

  if (disposition === "delegated_followup") {
    const hasFollowUpPath =
      hasNonEmptyString(completion.follow_up_issue_id) || hasNonEmptyString(completion.follow_up_task_key);
    if (!hasFollowUpPath) {
      return {
        ok: false,
        errorCode: "invalid_completion_schema",
        message: "Disposition delegated_followup requires follow_up_issue_id or follow_up_task_key.",
      };
    }
  }

  if (disposition === "continue_in_progress") {
    const resumeIntent = completion.resume_intent === true;
    const hasResumeRun = hasNonEmptyString(completion.resume_from_run_id);
    if (!resumeIntent && !hasResumeRun) {
      return {
        ok: false,
        errorCode: "invalid_completion_schema",
        message: "Disposition continue_in_progress requires resume_intent=true or resume_from_run_id.",
      };
    }
  }

  return {
    ok: true,
    parsed: {
      disposition,
      nextAction,
      reason,
    },
  };
}

function trimToolOutput(value: unknown): string {
  const rendered = typeof value === "string" ? value : JSON.stringify(value);
  if (rendered.length <= MAX_TOOL_OUTPUT_CHARS) return rendered;
  return `${rendered.slice(0, MAX_TOOL_OUTPUT_CHARS)}\n...[truncated by Paperclip tool bridge]`;
}

function extractFunctionCalls(output: unknown): IronclawFunctionCall[] {
  if (!Array.isArray(output)) return [];

  const calls: IronclawFunctionCall[] = [];
  for (const item of output) {
    if (!item || typeof item !== "object") continue;
    const typed = item as Record<string, unknown>;
    if (typed.type !== "function_call") continue;
    const callId = asString(typed.call_id, "").trim();
    const name = asString(typed.name, "").trim();
    const argumentsJson = asString(typed.arguments, "").trim();
    if (!callId || !name) continue;
    calls.push({ callId, name, argumentsJson });
  }

  return calls;
}

function resolvePaperclipApiBaseUrl(ctx: AdapterExecutionContext): string {
  const fromContext = asString((ctx.context as Record<string, unknown>).paperclipApiUrl, "").trim();
  const fromEnv = asString(process.env.PAPERCLIP_API_URL, "").trim();
  const candidate = fromContext || fromEnv;
  if (!candidate) return "";
  return candidate.replace(/\/+$/, "");
}

function buildPaperclipApiToolSpec(): Record<string, unknown> {
  return {
    type: "function",
    name: "paperclip_api_call",
    description: "Call the Paperclip API for issue/task workflow operations using the current run identity.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        method: { type: "string", enum: ["GET", "POST", "PATCH", "PUT", "DELETE"] },
        path: { type: "string", description: "Paperclip API path beginning with /api/" },
        url: { type: "string", description: "Optional absolute URL to Paperclip API (same host only)." },
        query: { type: "object", additionalProperties: true },
        body: { type: ["object", "array", "string", "number", "boolean", "null"] },
        headers: { type: "object", additionalProperties: { type: "string" } },
      },
      required: [],
    },
  };
}

function parseToolArgs(call: IronclawFunctionCall): PaperclipApiCallArgs {
  const parsed = parseJsonObjectCandidate(call.argumentsJson) ?? {};
  return {
    method: asString(parsed.method, "").trim(),
    path: asString(parsed.path, "").trim(),
    url: asString(parsed.url, "").trim(),
    query: parseObject(parsed.query),
    body: parsed.body,
    headers: parseObject(parsed.headers),
  };
}

function appendQueryParams(url: URL, query: Record<string, unknown>) {
  for (const [key, value] of Object.entries(query)) {
    if (value == null) continue;
    if (Array.isArray(value)) {
      for (const entry of value) {
        if (entry == null) continue;
        url.searchParams.append(key, String(entry));
      }
      continue;
    }
    url.searchParams.set(key, String(value));
  }
}

async function executePaperclipApiToolCall(
  ctx: AdapterExecutionContext,
  call: IronclawFunctionCall,
): Promise<{ call_id: string; output: string }> {
  const baseUrl = resolvePaperclipApiBaseUrl(ctx);
  const authToken = asString(ctx.authToken, "").trim();
  if (!baseUrl || !authToken) {
    return {
      call_id: call.callId,
      output: trimToolOutput({
        ok: false,
        error: "paperclip_api_unavailable",
        message: "Paperclip API base URL or auth token is unavailable for tool execution.",
      }),
    };
  }

  const args = parseToolArgs(call);
  const method = (args.method || "GET").toUpperCase();
  const allowedMethods = new Set(["GET", "POST", "PATCH", "PUT", "DELETE"]);
  if (!allowedMethods.has(method)) {
    return {
      call_id: call.callId,
      output: trimToolOutput({
        ok: false,
        error: "invalid_method",
        message: `Unsupported method: ${method}`,
      }),
    };
  }

  let resolvedUrl: URL;
  try {
    if (args.url) {
      const candidate = new URL(args.url);
      const expected = new URL(baseUrl);
      if (candidate.origin !== expected.origin || !candidate.pathname.startsWith("/api/")) {
        return {
          call_id: call.callId,
          output: trimToolOutput({
            ok: false,
            error: "invalid_url_scope",
            message: "Tool URL must target the configured Paperclip host and /api/* path.",
          }),
        };
      }
      resolvedUrl = candidate;
    } else {
      const normalizedPath = args.path || "";
      if (!normalizedPath.startsWith("/api/")) {
        return {
          call_id: call.callId,
          output: trimToolOutput({
            ok: false,
            error: "invalid_path_scope",
            message: "Tool path must start with /api/.",
          }),
        };
      }
      resolvedUrl = new URL(`${baseUrl}${normalizedPath}`);
    }
  } catch (error) {
    return {
      call_id: call.callId,
      output: trimToolOutput({
        ok: false,
        error: "invalid_url",
        message: error instanceof Error ? error.message : String(error),
      }),
    };
  }

  appendQueryParams(resolvedUrl, args.query ?? {});
  const headers: Record<string, string> = {
    authorization: `Bearer ${authToken}`,
    accept: "application/json",
    "x-paperclip-run-id": ctx.runId,
  };
  for (const [key, value] of Object.entries(args.headers ?? {})) {
    if (typeof value !== "string") continue;
    const lower = key.toLowerCase();
    if (lower === "authorization" || lower === "cookie") continue;
    headers[key] = value;
  }

  const requestInit: RequestInit = {
    method,
    headers,
  };
  if (args.body !== undefined && method !== "GET") {
    headers["content-type"] = "application/json";
    requestInit.body = JSON.stringify(args.body);
  }

  try {
    const response = await fetch(resolvedUrl.toString(), requestInit);
    const bodyText = await response.text().catch(() => "");
    const bodyJson = parseJsonObjectCandidate(bodyText);
    return {
      call_id: call.callId,
      output: trimToolOutput({
        ok: response.ok,
        status: response.status,
        statusText: response.statusText,
        url: resolvedUrl.toString(),
        body: bodyJson ?? bodyText,
      }),
    };
  } catch (error) {
    return {
      call_id: call.callId,
      output: trimToolOutput({
        ok: false,
        error: "request_failed",
        message: error instanceof Error ? error.message : String(error),
      }),
    };
  }
}

async function executeFunctionCalls(
  ctx: AdapterExecutionContext,
  calls: IronclawFunctionCall[],
): Promise<Array<{ type: "function_call_output"; call_id: string; output: string }>> {
  const outputs: Array<{ type: "function_call_output"; call_id: string; output: string }> = [];
  for (const call of calls) {
    if (call.name === "paperclip_api_call") {
      const toolResult = await executePaperclipApiToolCall(ctx, call);
      outputs.push({ type: "function_call_output", call_id: toolResult.call_id, output: toolResult.output });
      continue;
    }

    outputs.push({
      type: "function_call_output",
      call_id: call.callId,
      output: trimToolOutput({ ok: false, error: "unknown_tool", name: call.name }),
    });
  }
  return outputs;
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
    const wakeSource = asString(ctx.context.wakeSource, "").trim().toLowerCase();
    const wakeTriggerDetail = asString(ctx.context.wakeTriggerDetail, "").trim().toLowerCase();
    const issueId = asString(ctx.context.issueId, "").trim();
    const taskKey = asString(ctx.context.taskKey, "").trim() || ctx.runtime.taskKey || "";
    const lowerManualContext = manualTaskMarkdown.toLowerCase();
    const needsManualSynthesis =
      wakeSource === "on_demand"
      && wakeTriggerDetail === "manual"
      && !issueId
      && !taskKey
      && lowerManualContext.includes("objective: continue the active assignment and report status/progress");

    if (needsManualSynthesis) {
      return [
        `${agentLabel} heartbeat task:`,
        "",
        "Manual wake task context:",
        manualTaskMarkdown,
        "",
        "Execution focus:",
        "- Reconstruct the active assignment from available run/thread context before taking action.",
        "- Continue that assignment with concrete progress, delegated actions, or explicit blockers.",
        "- Do not switch to unrelated generic helpdesk workflows.",
        "- If assignment context is missing, request the exact missing identifier (issueId/taskKey) and stop.",
      ].join("\n");
    }

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

function classifyResponseText(text: string): ResponseQualityClassification {
  const normalized = text.trim();
  if (!normalized) return "empty_text";

  const lowSignalTokens = new Set(["based"]);
  if (lowSignalTokens.has(normalized.toLowerCase())) {
    return "low_signal_short_text";
  }

  if (normalized.length > 16) return "normal_text";
  const tokenCount = normalized.split(/\s+/).filter(Boolean).length;
  return tokenCount <= 3 ? "low_signal_short_text" : "normal_text";
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

  const issueId = asString(ctx.context.issueId, "").trim();
  const issueBoundRun = issueId.length > 0;
  const promptInput = await buildPromptInput(ctx, config, issueBoundRun);
  const input = promptInput.taskInput;
  const callIsoTime = new Date().toISOString();
  const agentLabel = asString(ctx.agent.name, "").trim() || "Agent";
  const wakeSource = asString(ctx.context.wakeSource, "").trim();
  const wakeReason = asString(ctx.context.wakeReason, "").trim();
  const wakeTriggerDetail = asString(ctx.context.wakeTriggerDetail, "").trim();
  const taskKey = asString(ctx.context.taskKey, "").trim() || ctx.runtime.taskKey || "";
  const strategicContext = parseObject(ctx.context.paperclipStrategicContext);
  const configuredMetadata =
    parseConfiguredMetadata(config.metadata) ?? parseMetadataJson(config.metadataJson) ?? null;
  const temperature = asNumber(config.temperature, Number.NaN);
  const numCtx = Math.max(0, Math.floor(asNumber(config.numCtx ?? config.num_ctx, 0)));
  const thinkingMode = parseThinkingMode(config.thinkingMode ?? config.thinking_mode);
  const previousResponseId =
    ctx.runtime.sessionParams && typeof ctx.runtime.sessionParams === "object"
      ? asString((ctx.runtime.sessionParams as Record<string, unknown>).responseId, "")
      : "";
  // Task-scoped seed: isolate threads per issue so distinct tasks never share
  // the same Ironclaw conversation history.
  const seededPreviousResponseId = buildSeededPreviousResponseId(ctx.agent.id, issueId || undefined);
  const freshSessionDecision = decideFreshSession(ctx, previousResponseId);
  const effectivePreviousResponseId = freshSessionDecision.forceFresh
    ? ""
    : (previousResponseId || seededPreviousResponseId);
  const body: Record<string, unknown> = {
    input,
    // Ironclaw extension: per-request response timeout in seconds.
    // `0` means no Ironclaw-side response timeout.
    timeout_sec: timeoutSec,
    // Force non-streaming mode so the adapter always receives a single
    // JSON payload and can reliably persist previous_response_id chaining.
    stream: false,
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
        runtimeSkills: promptInput.runtimeSkillMeta.runtimeSkills,
        runtimeSkillSummaries: promptInput.runtimeSkillMeta.runtimeSkillSummaries,
        runtimeSkillSelection: promptInput.runtimeSkillMeta.runtimeSkillSelection,
        managedInstructionsAttached: promptInput.hasManagedInstructions,
        continuationPolicy: {
          continuationMode: effectivePreviousResponseId ? "chained" : "fresh",
          freshSessionReason: freshSessionDecision.reason,
          conversationStrategy: freshSessionDecision.forceFresh
            ? (freshSessionDecision.reason === "retry_of_failed_run_no_prior_session"
              ? "retry_fresh_session"
              : freshSessionDecision.reason === "manual_on_demand_without_issue"
                ? "manual_wake_fresh_session"
              : "fresh_session")
            : previousResponseId
              ? "session_previous_response_id"
              : (issueId ? "task_scoped_seed" : "deterministic_agent_seed"),
          lowSignalDetected: false,
          retryRecommendation: "none",
        },
        requestControls: {
          timeoutSec,
          temperature: Number.isFinite(temperature) ? temperature : null,
          numCtx: numCtx > 0 ? numCtx : null,
          thinkingMode,
          metadataAttached: Boolean(configuredMetadata),
        },
      },
      conversation: {
        label: buildConversationLabel(agentLabel, ctx.runId, callIsoTime),
        title: buildConversationTitle(agentLabel, ctx.runId, callIsoTime),
        kind: "paperclip_heartbeat",
      },
    },
  };
  if (resolvePaperclipApiBaseUrl(ctx) && asString(ctx.authToken, "").trim()) {
    body.tools = [buildPaperclipApiToolSpec()];
  }
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
          strategy: freshSessionDecision.forceFresh
            ? (freshSessionDecision.reason === "retry_of_failed_run_no_prior_session"
              ? "retry_fresh_session"
              : freshSessionDecision.reason === "manual_on_demand_without_issue"
                ? "manual_wake_fresh_session"
              : "fresh_session")
            : previousResponseId
              ? "session_previous_response_id"
              : (issueId ? "task_scoped_seed" : "deterministic_agent_seed"),
          previousResponseId: effectivePreviousResponseId || null,
        },
        managedInstructionsAttached: promptInput.hasManagedInstructions,
        runtimeSkillsAttached: promptInput.runtimeSkillMeta.runtimeSkills,
      },
      prompt: input,
      promptMetrics: {
        inputChars: input.length,
      },
    });
  }

  try {
    const sendResponsesRequest = async (requestBody: Record<string, unknown>) => {
      const response = await fetch(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${authToken}`,
        },
        body: JSON.stringify(requestBody),
        signal: controller.signal,
      });

      if (!response.ok) {
        const errorText = await response.text().catch(() => "");
        const lowerError = errorText.toLowerCase();
        if (
          requestBody.tools
          && lowerError.includes("caller-supplied 'tools' require engine v2")
        ) {
          return {
            ok: false as const,
            errorCode: "ironclaw_engine_v2_required",
            errorMessage: "Ironclaw rejected caller tools because engine v2 is not enabled.",
            errorText,
          };
        }

        return {
          ok: false as const,
          errorCode: "ironclaw_http_error",
          errorMessage: `Ironclaw request failed with status ${response.status}${errorText ? `: ${errorText.slice(0, 200)}` : ""}`,
          errorText,
        };
      }

      const payload = (await response.json().catch(() => ({}))) as Record<string, unknown>;
      const responseStatus = asString(payload.status, "").trim().toLowerCase();
      if (responseStatus === "failed") {
        const responseError = parseObject(payload.error);
        const responseErrorMessage = asString(responseError.message, "").trim();
        return {
          ok: false as const,
          errorCode: "ironclaw_response_failed",
          errorMessage: responseErrorMessage || "Ironclaw response status=failed",
          payload,
        };
      }

      return { ok: true as const, payload };
    };

    let payload: Record<string, unknown> = {};
    let currentBody: Record<string, unknown> = body;
    for (let round = 0; round <= MAX_TOOL_ROUNDTRIPS; round += 1) {
      const responseResult = await sendResponsesRequest(currentBody);
      if (!responseResult.ok) {
        return {
          exitCode: 1,
          signal: null,
          timedOut: false,
          errorCode: responseResult.errorCode,
          errorMessage: responseResult.errorMessage,
          resultJson: responseResult.payload,
        };
      }

      payload = responseResult.payload;
      const functionCalls = extractFunctionCalls(payload.output);
      if (functionCalls.length === 0) break;
      if (round === MAX_TOOL_ROUNDTRIPS) {
        return {
          exitCode: 1,
          signal: null,
          timedOut: false,
          errorCode: "ironclaw_tool_roundtrip_limit",
          errorMessage: `Tool call loop exceeded ${MAX_TOOL_ROUNDTRIPS} roundtrips.`,
          resultJson: payload,
        };
      }

      await ctx.onLog(
        "stdout",
        `[paperclip] Ironclaw requested ${functionCalls.length} tool call(s); executing tool bridge round ${round + 1}.\n`,
      );
      const toolOutputs = await executeFunctionCalls(ctx, functionCalls);
      const responseId = asString(payload.id, "").trim();
      if (!responseId) {
        return {
          exitCode: 1,
          signal: null,
          timedOut: false,
          errorCode: "ironclaw_missing_response_id_for_tool_roundtrip",
          errorMessage: "Ironclaw tool roundtrip response is missing id.",
          resultJson: payload,
        };
      }

      currentBody = {
        input: toolOutputs,
        timeout_sec: timeoutSec,
        stream: false,
        previous_response_id: responseId,
        x_context: body.x_context,
      };
      if (promptInput.instructions) currentBody.instructions = promptInput.instructions;
      if (configuredMetadata) currentBody.metadata = configuredMetadata;
      if (requestModel) currentBody.model = requestModel;
      if (Number.isFinite(temperature) && temperature >= 0 && temperature <= 2) {
        currentBody.temperature = temperature;
      }
      if (numCtx > 0) currentBody.num_ctx = numCtx;
      if (thinkingMode !== "auto") currentBody.thinking_mode = thinkingMode;
    }

    const text = extractOutputText(payload.output) || asString(payload.output_text, "");
    const responseQuality = classifyResponseText(text);
    const lowSignalDetected = responseQuality === "low_signal_short_text";
    const continuationMode = effectivePreviousResponseId ? "chained" : "fresh";
    const retryRecommendation = lowSignalDetected ? "fresh_session" : "none";

    payload.paperclip_response_quality = {
      classification: responseQuality,
      textLength: text.trim().length,
      continuation_mode: continuationMode,
      low_signal_detected: lowSignalDetected,
      retry_recommendation: retryRecommendation,
    };

    const completionValidation = issueBoundRun
      ? validateIssueCompletionContract(text)
      : { ok: true };
    payload.paperclip_completion_validation = completionValidation.ok
      ? { ok: true, enforced: issueBoundRun, parsed: completionValidation.parsed ?? null }
      : {
        ok: false,
        enforced: true,
        errorCode: completionValidation.errorCode ?? "invalid_completion_schema",
        message: completionValidation.message ?? "Structured completion validation failed.",
      };

    if (text) {
      await ctx.onLog("stdout", `${text}\n`);
    }

    if (!completionValidation.ok) {
      await ctx.onLog(
        "stderr",
        `[paperclip] Error: missing or invalid issue disposition contract in Ironclaw response (${completionValidation.errorCode ?? "invalid_completion_schema"}). ${completionValidation.message ?? ""}\n`,
      );
      return {
        exitCode: 1,
        signal: null,
        timedOut: false,
        errorCode: completionValidation.errorCode === "missing_structured_completion"
          ? "ironclaw_missing_disposition"
          : "ironclaw_invalid_disposition",
        errorMessage: completionValidation.message ?? "Structured completion validation failed.",
        resultJson: payload,
      };
    }

    if (responseQuality === "low_signal_short_text") {
      await ctx.onLog(
        "stderr",
        `[paperclip] Warning: low_signal_short_text response from Ironclaw (${JSON.stringify(text.trim())}); continuation_mode=${continuationMode}, retry_recommendation=${retryRecommendation}.\n`,
      );
    } else if (responseQuality === "empty_text") {
      await ctx.onLog(
        "stderr",
        `[paperclip] Warning: empty_text response from Ironclaw; continuation_mode=${continuationMode}.\n`,
      );
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
