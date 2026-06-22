import type { AdapterExecutionContext, AdapterExecutionResult } from "../types.js";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { resolvePaperclipDesiredSkillNames } from "@paperclipai/adapter-utils/server-utils";
import { asNumber, asString, parseObject } from "../utils.js";
import {
  validateCompletionObject,
  coercePrimitiveType,
  extractJsonFromText,
  generateValidationDiagnostic,
  reconcileFinishReason,
  extractToolCallFromText,
  hasToolCallsInContent,
} from "./validation.js";
import { attemptCompletionRecovery, formatRecoveryDiagnostic } from "./tool-call-repair.js";

// Phase A: Balanced prompt budget with deduplication and model switch
// Model switch to mistral-nemo:12b enables reliable JSON reasoning at 4KB
// Section Separation in Ironclaw core (reasoning.rs) provides 28% dedup
// Paperclip default instructions compressed from 11.7KB to ~3KB
const MAX_INSTRUCTIONS_CHARS = 4_000; // Increased from 2_500 with dedup guardrails
const MAX_SKILLS_IN_PROMPT = 6;
const MAX_RUNTIME_SKILL_SUMMARY_CHARS = 240;

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
  const retryOfIronclawError = asString(ctx.context.retryOfIronclawError, "").trim().toLowerCase();
  if ((retryReason || retryOfRunId)) {
    // Force fresh session if retrying after adapter disposition validation failure
    if (retryOfIronclawError === "ironclaw_missing_disposition" || retryOfIronclawError === "ironclaw_invalid_disposition") {
      return { forceFresh: true, reason: "retry_of_failed_run_no_prior_session" };
    }
    // Or if no prior session exists to continue from
    if (!previousResponseId) {
      return { forceFresh: true, reason: "retry_of_failed_run_no_prior_session" };
    }
  }

  return { forceFresh: false, reason: "default_chained_session" };
}

function buildConversationLabel(agentLabel: string): string {
  if (/\bceo\b/i.test(agentLabel)) return "CEO heartbeat";
  return `${agentLabel} heartbeat`;
}

function buildConversationTitle(agentLabel: string): string {
  if (/\bceo\b/i.test(agentLabel)) return "CEO";
  return agentLabel;
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

  // Phase A OpenClaw pattern: Always include completion contract, even with managed instructions
  // This ensures validateIssueCompletionContract can reliably find the schema
  const completionContract = [
    "",
    "Required completion format (JSON object at response end):",
    "- disposition: done|cancelled|in_review|blocked|delegated_followup|continue_in_progress",
    "- next_action: non-empty string describing next step",
    "- reason: optional explanation",
  ].join("\n");
  
  const combinedContract = `${executionContract}${completionContract}`;

  if (!managedInstructions) {
    return truncateChars(combinedContract, MAX_INSTRUCTIONS_CHARS);
  }

  // Phase A: Always include completion contract, even with managed instructions
  // OpenClaw pattern: Consistent contract prevents validation errors
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

function parseJsonValueCandidate(value: string): unknown {
  const trimmed = value.trim();
  if (!trimmed) return null;

  try {
    return JSON.parse(trimmed);
  } catch {
    // Support the malformed wrapper pattern "{[ ... ]}" seen in production logs.
    if (trimmed.startsWith("{[") && trimmed.endsWith("]}")) {
      const repaired = trimmed.slice(1, -1).trim();
      try {
        return JSON.parse(repaired);
      } catch {
        // Continue with fallback parsing.
      }
    }

    // If the payload contains trailing text/tags, parse only the first balanced JSON value.
    const startsAt = trimmed.search(/[\[{]/);
    if (startsAt < 0) return null;
    const candidate = trimmed.slice(startsAt);
    const opener = candidate[0];
    const closer = opener === "{" ? "}" : "]";
    let depth = 0;
    let inString = false;
    let escaped = false;

    for (let i = 0; i < candidate.length; i += 1) {
      const ch = candidate[i];
      if (inString) {
        if (escaped) {
          escaped = false;
          continue;
        }
        if (ch === "\\") {
          escaped = true;
          continue;
        }
        if (ch === '"') {
          inString = false;
        }
        continue;
      }

      if (ch === '"') {
        inString = true;
        continue;
      }

      if (ch === opener) {
        depth += 1;
        continue;
      }

      if (ch === closer) {
        depth -= 1;
        if (depth === 0) {
          const prefix = candidate.slice(0, i + 1);
          try {
            return JSON.parse(prefix);
          } catch {
            return null;
          }
        }
      }
    }
  }

  return null;
}

function normalizeStructuredCompletionShape(parsed: unknown): Record<string, unknown> | null {
  const objectShape = parseObject(parsed);
  if (Object.keys(objectShape).length > 0) {
    return objectShape;
  }

  if (Array.isArray(parsed) && parsed.length > 0) {
    const firstObject = parseObject(parsed[0]);
    if (Object.keys(firstObject).length > 0) {
      return firstObject;
    }
  }

  return null;
}

function parseStructuredCompletion(text: string): Record<string, unknown> | null {
  const candidates: string[] = [];
  const fenceRegex = /```json\s*([\s\S]*?)```/gi;
  for (const match of text.matchAll(fenceRegex)) {
    const candidate = (match[1] ?? "").trim();
    if (candidate) candidates.push(candidate);
  }
  if (text.trim()) candidates.push(text.trim());

  for (const candidate of candidates) {
    const parsed = parseJsonValueCandidate(candidate);
    const normalized = normalizeStructuredCompletionShape(parsed);
    if (normalized) return normalized;
  }

  // Phase A OpenClaw pattern: Tool call repair fallback
  // If direct parsing fails, attempt recovery via plain-text extraction
  const recovery = attemptCompletionRecovery(text);
  if (recovery.recovered) {
    return recovery.recovered as Record<string, unknown>;
  }

  return null;
}

function hasNonEmptyString(value: unknown): boolean {
  return typeof value === "string" && value.trim().length > 0;
}

function asDisposition(value: unknown): CompletionDisposition | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase();
  const alias = normalized === "in_progress" ? "continue_in_progress" : normalized;
  const dispositions: CompletionDisposition[] = [
    "done",
    "cancelled",
    "in_review",
    "blocked",
    "delegated_followup",
    "continue_in_progress",
  ];
  return dispositions.includes(alias as CompletionDisposition)
    ? (alias as CompletionDisposition)
    : null;
}

function validateIssueCompletionContract(text: string): CompletionValidation {
  const parsed = parseStructuredCompletion(text);
  
  // Phase A: Attempt recovery if structured completion not found
  if (!parsed) {
    // Try JSON repair first
    const jsonRepair = extractJsonFromText(text);
    if (jsonRepair) {
      return validateParsedCompletion(jsonRepair);
    }

    // Try plain-text tool call extraction
    const toolCallRepair = extractToolCallFromText(text);
    if (toolCallRepair.success && toolCallRepair.toolCall) {
      const repaired = {
        paperclip_completion: {
          disposition: toolCallRepair.toolCall.name,
          next_action: JSON.stringify(toolCallRepair.toolCall.arguments),
        },
      };
      return validateParsedCompletion(repaired);
    }

    // All recovery attempts failed
    return {
      ok: false,
      errorCode: "missing_structured_completion",
      message: "Ironclaw response did not include the required structured completion JSON. Repair attempts failed.",
    };
  }

  return validateParsedCompletion(parsed);
}

/**
 * Helper: Validate a parsed completion object
 */
function validateParsedCompletion(parsed: unknown): CompletionValidation {
  const completion = parseObject(parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>).paperclip_completion ?? parsed : parsed);
  let disposition = asDisposition(completion.disposition);
  let nextAction = asString(completion.next_action ?? completion.nextAction, "").trim();
  const reason = asString(completion.reason, "").trim() || null;

  // Phase A OpenClaw pattern: Intelligent coercion for common LLM mistakes
  // If disposition is a string from a union type, try coercion
  if (!disposition && completion.disposition) {
    const coercedDisposition = coercePrimitiveType(completion.disposition, "string");
    if (typeof coercedDisposition === "string") {
      disposition = asDisposition(coercedDisposition);
    }
  }

  // Coerce nextAction if needed
  if (!nextAction && completion.next_action) {
    const coercedAction = coercePrimitiveType(completion.next_action, "string");
    if (typeof coercedAction === "string") {
      nextAction = coercedAction.trim();
    }
  }

  if (!disposition || !nextAction) {
    const diagnosticMessage = generateValidationDiagnostic(
      {
        isValid: false,
        errors: [
          !disposition ? `Invalid disposition: ${completion.disposition}` : "",
          !nextAction ? `Invalid next_action: ${completion.next_action}` : "",
        ].filter(Boolean),
      },
      "validateParsedCompletion"
    );
    return {
      ok: false,
      errorCode: "invalid_completion_schema",
      message: "Structured completion must include disposition and non-empty next_action. " + diagnosticMessage,
    };
  }

  // Validate disposition-specific requirements
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
        label: buildConversationLabel(agentLabel),
        title: buildConversationTitle(agentLabel),
        kind: "paperclip_heartbeat",
      },
    },
  };
  if (promptInput.instructions) {
    body.instructions = promptInput.instructions;
    // Debug: Log instructions length and tail for structured completion verification
    const instLen = promptInput.instructions.length;
    const instTail = promptInput.instructions.slice(-600);
    await ctx.onLog(
      "stderr",
      `[paperclip-debug] Instructions: ${instLen} chars, managed=${promptInput.hasManagedInstructions}, model=${requestModel || "(default)"}, tail:\n${instTail}\n`,
    );
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
    const responseStatus = asString(payload.status, "").trim().toLowerCase();
    if (responseStatus === "failed") {
      const responseError = parseObject(payload.error);
      const responseErrorMessage = asString(responseError.message, "").trim();
      return {
        exitCode: 1,
        signal: null,
        timedOut: false,
        errorCode: "ironclaw_response_failed",
        errorMessage: responseErrorMessage || "Ironclaw response status=failed",
        resultJson: payload,
      };
    }

    const text = extractOutputText(payload.output) || asString(payload.output_text, "");
    const responseQuality = classifyResponseText(text);
    const lowSignalDetected = responseQuality === "low_signal_short_text";
    const continuationMode = effectivePreviousResponseId ? "chained" : "fresh";
    const retryRecommendation = lowSignalDetected ? "fresh_session" : "none";

    // Phase A OpenClaw Pattern: Finish Reason Reconciliation
    // Reconcile provider-inconsistent finish_reason with actual content
    const rawFinishReason = asString(payload.finish_reason, "").trim() || undefined;
    const hasToolCalls = hasToolCallsInContent(text);
    const hasTextContent = text.trim().length > 0;
    const finishReasonReconciliation = reconcileFinishReason(
      rawFinishReason,
      hasToolCalls,
      hasTextContent
    );

    payload.paperclip_response_quality = {
      classification: responseQuality,
      textLength: text.trim().length,
      continuation_mode: continuationMode,
      low_signal_detected: lowSignalDetected,
      retry_recommendation: retryRecommendation,
      finishReason: {
        raw: rawFinishReason || "unknown",
        reconciled: finishReasonReconciliation.reason,
        reconciled_applied: finishReasonReconciliation.reconciled,
        reconciliation_note: finishReasonReconciliation.diagnostic,
      },
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

    // Phase A: Enhanced error logging with recovery diagnostics
    if (!completionValidation.ok) {
      const recovery = attemptCompletionRecovery(text);
      const recoveryLog = recovery.recovered
        ? `[RECOVERY ATTEMPTED] ${formatRecoveryDiagnostic(recovery.diagnostic)}`
        : `[NO RECOVERY POSSIBLE] ${formatRecoveryDiagnostic(recovery.diagnostic)}`;

      await ctx.onLog(
        "stderr",
        `[paperclip] Error: missing or invalid issue disposition contract in Ironclaw response (${completionValidation.errorCode ?? "invalid_completion_schema"}). ${completionValidation.message ?? ""}\n${recoveryLog}\n`,
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
