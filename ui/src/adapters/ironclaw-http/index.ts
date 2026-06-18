import type { UIAdapterModule } from "../types";
import { parseHttpStdoutLine } from "../http/parse-stdout";
import { IronclawHttpConfigFields } from "./config-fields";
import { buildIronclawHttpConfig } from "./build-config";

export const ironclawHttpUIAdapter: UIAdapterModule = {
  type: "ironclaw_http",
  label: "Ironclaw HTTP",
  parseStdoutLine: parseHttpStdoutLine,
  ConfigFields: IronclawHttpConfigFields,
  buildAdapterConfig: buildIronclawHttpConfig,
};
