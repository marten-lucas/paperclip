import type { ServerAdapterModule } from "../types.js";
import { execute } from "./execute.js";
import { testEnvironment } from "./test.js";
import { getConfigSchema } from "./config-schema.js";
import { ironclawHttpModels } from "./models-cache.js";

export const ironclawHttpAdapter: ServerAdapterModule = {
  type: "ironclaw_http",
  execute,
  testEnvironment,
  supportsLocalAgentJwt: true,
  supportsInstructionsBundle: true,
  models: ironclawHttpModels,
  getConfigSchema,
  agentConfigurationDoc: `# ironclaw_http agent configuration

Adapter: ironclaw_http

Core fields:
- env.IRONCLAW_BASE_URL (string, required): Ironclaw gateway API base URL
- env.IRONCLAW_API_KEY (string, required): bearer token for Ironclaw API access (recommended: secret_ref)
- model (string, optional): default model id for requests
- timeoutSec (number, optional): request timeout in seconds (default 120)

Notes:
- Agent instructions should come from the agent Instructions settings, not adapterConfig.instructions.
`,
};
