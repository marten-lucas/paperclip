import type { CreateConfigValues } from "../../components/AgentConfigForm";

export function buildIronclawHttpConfig(
  v: CreateConfigValues
): Record<string, unknown> {
  const ac: Record<string, unknown> = {};
  if (v.url) ac.url = v.url;
  if (v.authToken) ac.authToken = v.authToken;
  if (v.model) ac.model = v.model;
  
  // Schema-based config values stored under adapterSchemaValues
  const schemaValues = v.adapterSchemaValues ?? {};
  if (schemaValues.instructions) ac.instructions = schemaValues.instructions;
  ac.timeoutSec = (schemaValues.timeoutSec as number) ?? 120;
  
  return ac;
}
