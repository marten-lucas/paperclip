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
  // Ironclaw exposes OpenAI-compatible GET /v1/models
  if (trimmed.endsWith("/v1/models")) return trimmed;
  return `${trimmed.replace(/\/$/, "")}/v1/models`;
}

export async function testEnvironment(
  ctx: AdapterEnvironmentTestContext,
): Promise<AdapterEnvironmentTestResult> {
  const checks: AdapterEnvironmentCheck[] = [];
  const config = parseObject(ctx.config);
  const env = parseObject(config.env);
  const url = asString(env.IRONCLAW_BASE_URL, "").trim() || asString(config.url, "").trim();
  const authToken = asString(env.IRONCLAW_API_KEY, "").trim() || asString(config.authToken, "").trim();

  if (!url) {
    checks.push({
      code: "ironclaw_url_missing",
      level: "error",
      message: "Missing required configuration: url",
      hint: "Set adapterConfig.env.IRONCLAW_BASE_URL (secret/plain env binding) to your Ironclaw base URL.",
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
      hint: "Set adapterConfig.env.IRONCLAW_API_KEY (secret/plain env binding) to a valid Ironclaw bearer token.",
    });
  }

  if (url && authToken) {
    const endpoint = resolveModelsUrl(url);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10_000);
    try {
      // Ironclaw exposes the OpenAI-compatible GET /v1/models endpoint
      const response = await fetch(endpoint, {
        method: "GET",
        headers: {
          authorization: `Bearer ${authToken}`,
        },
        signal: controller.signal,
      });

      if (!response.ok) {
        checks.push({
          code: "ironclaw_models_probe_failed",
          level: "error",
          message: `Model discovery failed with HTTP ${response.status}`,
        });
      } else {
        // OpenAI-compatible format: { data: [{ id, object, ... }], object: "list" }
        const payload = (await response.json().catch(() => ({}))) as { data?: unknown };
        const models = Array.isArray(payload.data)
          ? payload.data
              .filter((item): item is { id: string } => typeof item === "object" && item !== null && typeof (item as { id?: unknown }).id === "string")
              .map((item) => (item as { id: string }).id.trim())
              .filter((id) => id.length > 0)
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
