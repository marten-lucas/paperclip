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

  const numCtx = schemaValues.numCtx;
  if (typeof numCtx === "number" && Number.isFinite(numCtx) && numCtx > 0) {
    ac.numCtx = Math.floor(numCtx);
  }

  const thinkingMode = schemaValues.thinkingMode;
  if (thinkingMode === "auto" || thinkingMode === "on" || thinkingMode === "off") {
    ac.thinkingMode = thinkingMode;
  }

  return ac;
}
