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
    ],
  };
}
