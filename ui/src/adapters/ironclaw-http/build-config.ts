import type { CreateConfigValues } from "../../components/AgentConfigForm";

export function buildIronclawHttpConfig(
  v: CreateConfigValues
): Record<string, unknown> {
  const ac: Record<string, unknown> = {};
  if (v.model) ac.model = v.model;
  
  // Schema-based config values stored under adapterSchemaValues
  const schemaValues = v.adapterSchemaValues ?? {};
  ac.timeoutSec = (schemaValues.timeoutSec as number) ?? 120;
  
  return ac;
}
