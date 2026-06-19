import type { AdapterConfigFieldsProps } from "../types";
import {
  Field,
  DraftInput,
} from "../../components/agent-config-primitives";

const inputClass =
  "w-full rounded-md border border-border px-2.5 py-1.5 bg-transparent outline-none text-sm font-mono placeholder:text-muted-foreground/40";

export function IronclawHttpConfigFields({
  isCreate,
  values,
  set,
  config,
  eff,
  mark,
}: AdapterConfigFieldsProps) {
  const getSchemaValue = (key: string, defaultValue: unknown): unknown => {
    if (isCreate) {
      return values?.adapterSchemaValues?.[key] ?? defaultValue;
    }
    return config[key] ?? defaultValue;
  };

  const setSchemaValue = (key: string, value: unknown): void => {
    if (isCreate) {
      set?.({
        adapterSchemaValues: {
          ...values?.adapterSchemaValues,
          [key]: value,
        },
      });
    } else {
      mark("adapterConfig", key, value);
    }
  };
  return (
    <>
      <Field
        label="Timeout (seconds)"
        hint="Configure IRONCLAW_BASE_URL and IRONCLAW_API_KEY in Environment variables (secret refs supported)."
      >
        <DraftInput
          value={String(getSchemaValue("timeoutSec", 120))}
          onCommit={(v) => {
            const numVal = Math.max(1, Math.min(3600, parseInt(v) || 120));
            setSchemaValue("timeoutSec", numVal);
          }}
          immediate
          type="number"
          className={inputClass}
          placeholder="120"
          min="1"
          max="3600"
        />
      </Field>
    </>
  );
}
