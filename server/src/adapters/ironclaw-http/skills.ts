import path from "node:path";
import { fileURLToPath } from "node:url";
import type { AdapterSkillContext, AdapterSkillSnapshot } from "../types.js";
import {
  buildRuntimeMountedSkillSnapshot,
  readPaperclipRuntimeSkillEntries,
  resolvePaperclipDesiredSkillNames,
} from "@paperclipai/adapter-utils/server-utils";

const __moduleDir = path.dirname(fileURLToPath(import.meta.url));

async function buildIronclawSkillSnapshot(config: Record<string, unknown>): Promise<AdapterSkillSnapshot> {
  const availableEntries = await readPaperclipRuntimeSkillEntries(config, __moduleDir);
  const desiredSkills = resolvePaperclipDesiredSkillNames(config, availableEntries);
  return buildRuntimeMountedSkillSnapshot({
    adapterType: "ironclaw_http",
    availableEntries,
    desiredSkills,
    configuredDetail: "Will be inlined into the outbound Ironclaw prompt on the next run.",
  });
}

export async function listIronclawSkills(ctx: AdapterSkillContext): Promise<AdapterSkillSnapshot> {
  return buildIronclawSkillSnapshot(ctx.config);
}

export async function syncIronclawSkills(
  ctx: AdapterSkillContext,
  _desiredSkills: string[],
): Promise<AdapterSkillSnapshot> {
  return buildIronclawSkillSnapshot(ctx.config);
}
