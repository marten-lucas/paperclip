import type { AdapterModel } from "../types.js";

export const ironclawHttpModels: AdapterModel[] = [];

export function refreshIronclawHttpModels(models: string[]): void {
  ironclawHttpModels.splice(0, ironclawHttpModels.length, ...models
    .map((model) => model.trim())
    .filter((model) => model.length > 0)
    .map((model) => ({ id: model, label: model })));
}

/**
 * Resolve URL + token from environment variables.
 * Supports the same keys the adapter config env binding uses so operators
 * can point the global service env at the Ironclaw instance and have model
 * discovery work automatically on startup / refresh.
 */
function resolveEnvCredentials(): { url: string; token: string } | null {
  const url = (process.env.IRONCLAW_BASE_URL ?? "").trim();
  const token = (process.env.IRONCLAW_API_KEY ?? "").trim();
  if (!url || !token) return null;
  return { url, token };
}

function resolveModelsEndpoint(rawUrl: string): string {
  if (rawUrl.endsWith("/v1/models")) return rawUrl;
  return `${rawUrl.replace(/\/$/, "")}/v1/models`;
}

/**
 * Fetch models from the Ironclaw /v1/models endpoint using env-level
 * credentials and populate the shared in-memory cache.
 * Returns the updated list, or the existing cache if credentials are absent.
 */
export async function fetchAndCacheIronclawModels(): Promise<AdapterModel[]> {
  const creds = resolveEnvCredentials();
  if (!creds) return ironclawHttpModels;

  const endpoint = resolveModelsEndpoint(creds.url);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);
  try {
    const response = await fetch(endpoint, {
      method: "GET",
      headers: { authorization: `Bearer ${creds.token}` },
      signal: controller.signal,
    });
    if (!response.ok) return ironclawHttpModels;

    const payload = (await response.json().catch(() => ({}))) as { data?: unknown };
    const ids = Array.isArray(payload.data)
      ? payload.data
          .filter((item): item is { id: string } =>
            typeof item === "object" && item !== null && typeof (item as { id?: unknown }).id === "string",
          )
          .map((item) => (item as { id: string }).id.trim())
          .filter((id) => id.length > 0)
      : [];

    if (ids.length > 0) refreshIronclawHttpModels(ids);
    return ironclawHttpModels;
  } catch {
    return ironclawHttpModels;
  } finally {
    clearTimeout(timer);
  }
}

export function resetIronclawHttpModelsForTests(): void {
  ironclawHttpModels.splice(0, ironclawHttpModels.length);
}
