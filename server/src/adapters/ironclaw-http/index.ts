import type { AdapterSessionCodec, ServerAdapterModule } from "../types.js";
import { getAdapterSessionManagement } from "@paperclipai/adapter-utils";
import { execute } from "./execute.js";
import { testEnvironment } from "./test.js";
import { getConfigSchema } from "./config-schema.js";
import { ironclawHttpModels, fetchAndCacheIronclawModels } from "./models-cache.js";
import { listIronclawSkills, syncIronclawSkills } from "./skills.js";

function readNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

export const sessionCodec: AdapterSessionCodec = {
  deserialize(raw: unknown) {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
    const record = raw as Record<string, unknown>;
    const responseId = readNonEmptyString(record.responseId) ?? readNonEmptyString(record.response_id);
    if (!responseId) return null;
    return { responseId };
  },
  serialize(params: Record<string, unknown> | null) {
    if (!params) return null;
    const responseId = readNonEmptyString(params.responseId) ?? readNonEmptyString(params.response_id);
    if (!responseId) return null;
    return { responseId };
  },
  getDisplayId(params: Record<string, unknown> | null) {
    if (!params) return null;
    return readNonEmptyString(params.responseId) ?? readNonEmptyString(params.response_id);
  },
};

const sessionManagement =
  getAdapterSessionManagement("ironclaw_http") ??
  {
    supportsSessionResume: true,
    nativeContextManagement: "confirmed" as const,
    defaultSessionCompaction: {
      enabled: true,
      maxSessionRuns: 0,
      maxRawInputTokens: 0,
      maxSessionAgeHours: 0,
    },
  };

// Prime model cache on startup so adapter listings and model pickers can show
// discovered models without requiring a manual "Test connection" click first.
void fetchAndCacheIronclawModels();

export const ironclawHttpAdapter: ServerAdapterModule = {
  type: "ironclaw_http",
  execute,
  testEnvironment,
  sessionCodec,
  sessionManagement,
  listSkills: listIronclawSkills,
  syncSkills: syncIronclawSkills,
  supportsLocalAgentJwt: true,
  supportsInstructionsBundle: true,
  instructionsPathKey: "instructionsFilePath",
  requiresMaterializedRuntimeSkills: false,
  models: ironclawHttpModels,
  listModels: async () => {
    if (ironclawHttpModels.length === 0) await fetchAndCacheIronclawModels();
    return ironclawHttpModels;
  },
  refreshModels: fetchAndCacheIronclawModels,
  detectModel: async () => {
    if (ironclawHttpModels.length === 0) await fetchAndCacheIronclawModels();
    if (ironclawHttpModels.length === 0) return null;
    const candidates = ironclawHttpModels.map((entry) => entry.id).filter((id) => id.length > 0);
    return {
      model: candidates[0]!,
      provider: "ironclaw_http",
      source: "IRONCLAW_BASE_URL:/v1/models",
      candidates,
    };
  },
  getConfigSchema,
  agentConfigurationDoc: `# ironclaw_http agent configuration

Adapter: ironclaw_http

Core fields:
- env.IRONCLAW_BASE_URL (string, required): Ironclaw gateway API base URL
- env.IRONCLAW_API_KEY (string, required): bearer token for Ironclaw API access (recommended: secret_ref)
- model (string, optional): default model id for requests
- instructionsFilePath (string, optional): managed instructions file path; preferred over inline instructions
- temperature (number, optional): response temperature, forwarded as request temperature
- maxOutputTokens (number, optional): response output token cap, forwarded as request max_output_tokens
- metadataJson (string, optional): JSON object string forwarded as request metadata
- timeoutSec (number, optional): request timeout in seconds (default 120)

Notes:
- Agent instructions should come from the agent Instructions settings, not adapterConfig.instructions.
- Paperclip injects managed instructions separately into the Ironclaw instructions field and reserves the prompt body for the task payload.
`,
};
