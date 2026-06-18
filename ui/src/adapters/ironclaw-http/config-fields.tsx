import type { AdapterConfigFieldsProps } from "../types";
import {
  Field,
  DraftInput,
  DraftTextarea,
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
        label="Gateway API URL"
        hint="Base URL for Ironclaw gateway (e.g., http://10.12.12.102:3000)"
      >
        <DraftInput
          value={
            isCreate
              ? values!.url
              : eff("adapterConfig", "url", String(config.url ?? ""))
          }
          onCommit={(v) =>
            isCreate
              ? set!({ url: v })
              : mark("adapterConfig", "url", v || undefined)
          }
          immediate
          className={inputClass}
          placeholder="http://10.12.12.102:3000"
        />
      </Field>

      <Field
        label="Gateway API Token"
        hint="Bearer token used to authenticate with the Ironclaw API"
      >
        <DraftInput
          value={
            isCreate
              ? values!.authToken ?? ""
              : eff("adapterConfig", "authToken", String(config.authToken ?? ""))
          }
          onCommit={(v) =>
            isCreate
              ? set!({ authToken: v })
              : mark("adapterConfig", "authToken", v || undefined)
          }
          immediate
          className={inputClass}
          placeholder="Bearer token..."
          type="password"
        />
      </Field>

      <Field label="Model" hint="Default model id for requests (optional)">
        <DraftInput
          value={
            isCreate
              ? values!.model ?? ""
              : eff("adapterConfig", "model", String(config.model ?? ""))
          }
          onCommit={(v) =>
            isCreate
              ? set!({ model: v })
              : mark("adapterConfig", "model", v || undefined)
          }
          immediate
          className={inputClass}
          placeholder="qwen3:8b"
        />
      </Field>

      <Field
        label="System Instructions"
        hint="Optional system prompt passed to Ironclaw for every request"
      >
        <DraftTextarea
          value={String(getSchemaValue("instructions", ""))}
          onCommit={(v) => setSchemaValue("instructions", v)}
          immediate
          placeholder="You are a helpful assistant..."
          minRows={3}
        />
      </Field>

      <Field
        label="Timeout (seconds)"
        hint="Maximum seconds to wait for the response (1-3600, default 120)"
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
