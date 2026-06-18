import type {
  AdapterEnvironmentCheck,
  AdapterEnvironmentTestContext,
  AdapterEnvironmentTestResult,
} from "../types.js";
import { asString, parseObject } from "../utils.js";
import { refreshIronclawHttpModels } from "./models-cache.js";

function summarizeStatus(checks: AdapterEnvironmentCheck[]): AdapterEnvironmentTestResult["status"] {
  if (checks.some((check) => check.level === "error")) return "fail";
  if (checks.some((check) => check.level === "warn")) return "warn";
  return "pass";
}

function resolveModelsUrl(rawUrl: string): string {
  const trimmed = rawUrl.trim();
  if (!trimmed) return "";
  if (trimmed.endsWith("/api/webchat/v2/llm/list-models")) return trimmed;
  return `${trimmed.replace(/\/$/, "")}/api/webchat/v2/llm/list-models`;
}

export async function testEnvironment(
  ctx: AdapterEnvironmentTestContext,
): Promise<AdapterEnvironmentTestResult> {
  const checks: AdapterEnvironmentCheck[] = [];
  const config = parseObject(ctx.config);
  const url = asString(config.url, "").trim();
  const authToken = asString(config.authToken, "").trim();

  if (!url) {
    checks.push({
      code: "ironclaw_url_missing",
      level: "error",
      message: "Missing required configuration: url",
      hint: "Set Gateway API URL to your Ironclaw base URL.",
    });
  } else {
    try {
      const parsed = new URL(url);
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
        checks.push({
          code: "ironclaw_url_protocol_invalid",
          level: "error",
          message: `Unsupported URL protocol: ${parsed.protocol}`,
          hint: "Use http:// or https:// URLs.",
        });
      } else {
        checks.push({
          code: "ironclaw_url_valid",
          level: "info",
          message: `Valid URL format: ${url}`,
        });
      }
    } catch {
      checks.push({
        code: "ironclaw_url_invalid",
        level: "error",
        message: `Invalid URL format: ${url}`,
      });
    }
  }

  if (!authToken) {
    checks.push({
      code: "ironclaw_auth_missing",
      level: "error",
      message: "Missing required configuration: authToken",
      hint: "Set Gateway API Token to a valid Ironclaw bearer token.",
    });
  }

  if (url && authToken) {
    const endpoint = resolveModelsUrl(url);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10_000);
    try {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${authToken}`,
        },
        body: "{}",
        signal: controller.signal,
      });

      if (!response.ok) {
        checks.push({
          code: "ironclaw_models_probe_failed",
          level: "error",
          message: `Model discovery failed with HTTP ${response.status}`,
        });
      } else {
        const payload = (await response.json().catch(() => ({}))) as { models?: unknown };
        const models = Array.isArray(payload.models)
          ? payload.models.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
          : [];

        refreshIronclawHttpModels(models);
        checks.push({
          code: "ironclaw_connected",
          level: models.length > 0 ? "info" : "warn",
          message: models.length > 0
            ? `Connected to Ironclaw. Discovered ${models.length} model(s).`
            : "Connected to Ironclaw but no models were discovered.",
          detail: models.length > 0 ? models.slice(0, 5).join(", ") : null,
        });
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      checks.push({
        code: "ironclaw_connection_error",
        level: "error",
        message: `Connection error: ${message}`,
      });
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    adapterType: ctx.adapterType,
    status: summarizeStatus(checks),
    checks,
    testedAt: new Date().toISOString(),
  };
}
