import type { ServerAdapterModule } from "../types.js";
import { execute } from "./execute.js";
import { testEnvironment } from "./test.js";
import { getConfigSchema } from "./config-schema.js";
import { ironclawHttpModels } from "./models-cache.js";

export const ironclawHttpAdapter: ServerAdapterModule = {
  type: "ironclaw_http",
  execute,
  testEnvironment,
  models: ironclawHttpModels,
  getConfigSchema,
  agentConfigurationDoc: `# ironclaw_http agent configuration

Adapter: ironclaw_http

Core fields:
- url (string, required): Ironclaw gateway API base URL
- authToken (string, required): bearer token for Ironclaw API access
- model (string, optional): default model id for requests
- instructions (string, optional): system instruction text
- timeoutSec (number, optional): request timeout in seconds (default 120)
`,
};
