import type { AdapterConfigSchema } from "../types.js";

export function getConfigSchema(): AdapterConfigSchema {
  return {
    fields: [
      {
        key: "timeoutSec",
        label: "Timeout (seconds)",
        type: "number",
        default: 120,
        hint: "Maximum seconds to wait for the response. Set a Base URL (e.g. http://10.12.12.102:3000/) and API key via adapter config. For secrets, prefer env bindings (IRONCLAW_API_KEY secret_ref).",
        meta: { min: 1, max: 3600 },
      },
    ],
  };
}
