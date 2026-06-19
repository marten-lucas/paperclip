import type { AdapterExecutionContext, AdapterExecutionResult } from "../types.js";
import { asNumber, asString, parseObject } from "../utils.js";

type IronclawUsage = {
  input_tokens?: number;
  output_tokens?: number;
  inputTokens?: number;
  outputTokens?: number;
};

function resolveBaseUrl(rawUrl: string): string {
  const trimmed = rawUrl.trim();
  if (!trimmed) return "";
  if (trimmed.endsWith("/api/v1/responses")) return trimmed;
  return `${trimmed.replace(/\/$/, "")}/api/v1/responses`;
}

function extractMessage(ctx: AdapterExecutionContext): string {
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

  return "Execute the assigned task.";
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
  const resolvedUrl = asString(env.IRONCLAW_BASE_URL, "").trim() || asString(config.url, "").trim();
  const resolvedToken = asString(env.IRONCLAW_API_KEY, "").trim() || asString(config.authToken, "").trim();
  const url = resolveBaseUrl(resolvedUrl);
  const authToken = resolvedToken;
  const requestedModel = asString(config.model, "").trim();
  const requestModel = requestedModel.toLowerCase() === "default" ? "default" : "";
  const timeoutSec = Math.max(1, Math.min(3600, asNumber(config.timeoutSec, 120)));

  if (!url || !authToken) {
    return {
      exitCode: 1,
      signal: null,
      timedOut: false,
      errorCode: "ironclaw_config_missing",
      errorMessage: "url and authToken are required",
    };
  }

  const input = extractMessage(ctx);
  const body: Record<string, unknown> = {
    input,
  };
  // Ironclaw currently supports the implicit default model only.
  // Send "model" only when the caller explicitly requests "default".
  if (requestModel) body.model = requestModel;

  const previousResponseId =
    ctx.runtime.sessionParams && typeof ctx.runtime.sessionParams === "object"
      ? asString((ctx.runtime.sessionParams as Record<string, unknown>).responseId, "")
      : "";
  if (previousResponseId) {
    body.previous_response_id = previousResponseId;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutSec * 1000);

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
      model: asString(payload.model, requestModel || null),
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
    clearTimeout(timer);
  }
}
