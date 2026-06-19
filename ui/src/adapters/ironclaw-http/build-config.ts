import type { CreateConfigValues } from "../../components/AgentConfigForm";

export function buildIronclawHttpConfig(
  v: CreateConfigValues
): Record<string, unknown> {
  const ac: Record<string, unknown> = {};
  if (v.model) ac.model = v.model;

  // Schema-based config values stored under adapterSchemaValues
  const schemaValues = v.adapterSchemaValues ?? {};
  ac.timeoutSec = (schemaValues.timeoutSec as number) ?? 120;

  const temperature = schemaValues.temperature;
  if (typeof temperature === "number" && Number.isFinite(temperature)) {
    ac.temperature = temperature;
  }

  const maxOutputTokens = schemaValues.maxOutputTokens;
  if (typeof maxOutputTokens === "number" && Number.isFinite(maxOutputTokens) && maxOutputTokens > 0) {
    ac.maxOutputTokens = Math.floor(maxOutputTokens);
  }

  return ac;
}
