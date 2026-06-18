import type { AdapterConfigSchema } from "../types.js";

export function getConfigSchema(): AdapterConfigSchema {
  return {
    fields: [
      {
        key: "url",
        label: "Gateway API URL",
        type: "text",
        required: true,
        hint: "Base URL for Ironclaw gateway (for example: http://10.12.12.102:3000).",
      },
      {
        key: "authToken",
        label: "Gateway API Token",
        type: "text",
        required: true,
        hint: "Bearer token used to authenticate with the Ironclaw API.",
        meta: { secret: true },
      },
      {
        key: "model",
        label: "Model",
        type: "combobox",
        hint: "Default model id for requests. Leave empty to use Ironclaw defaults.",
      },
      {
        key: "instructions",
        label: "System Instructions",
        type: "textarea",
        hint: "Optional system prompt passed to Ironclaw for every request.",
      },
      {
        key: "timeoutSec",
        label: "Timeout (seconds)",
        type: "number",
        default: 120,
        hint: "Maximum seconds to wait for the response.",
        meta: { min: 1, max: 3600 },
      },
    ],
  };
}
