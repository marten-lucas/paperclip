import type { AdapterConfigSchema } from "../types.js";

export function getConfigSchema(): AdapterConfigSchema {
  return {
    fields: [
      {
        key: "timeoutSec",
        label: "Timeout (seconds)",
        type: "number",
        default: 120,
        hint: "Maximum seconds to wait for the response. Configure IRONCLAW_BASE_URL and IRONCLAW_API_KEY in Environment variables (use secret refs for token).",
        meta: { min: 1, max: 3600 },
      },
      {
        key: "temperature",
        label: "Temperature",
        type: "number",
        hint: "Optional response temperature forwarded to Ironclaw.",
        meta: { min: 0, max: 2, step: 0.1 },
      },
      {
        key: "maxOutputTokens",
        label: "Max output tokens",
        type: "number",
        hint: "Optional output token cap forwarded as max_output_tokens.",
        meta: { min: 1, max: 100_000 },
      },
      {
        key: "metadataJson",
        label: "Metadata JSON",
        type: "textarea",
        hint: "Optional JSON object string forwarded as request metadata.",
      },
    ],
  };
}
