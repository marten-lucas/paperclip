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
        label="Temperature"
        hint="Optional response temperature forwarded to Ironclaw."
      >
        <DraftInput
          value={String(getSchemaValue("temperature", ""))}
          onCommit={(v) => {
            const trimmed = v.trim();
            if (!trimmed) {
              setSchemaValue("temperature", undefined);
              return;
            }
            const parsed = Number.parseFloat(trimmed);
            if (!Number.isFinite(parsed)) return;
            const clamped = Math.max(0, Math.min(2, parsed));
            setSchemaValue("temperature", Number(clamped.toFixed(2)));
          }}
          immediate
          type="number"
          className={inputClass}
          placeholder="e.g. 0.2"
          min="0"
          max="2"
          step="0.1"
        />
      </Field>

      <Field
        label="Max output tokens"
        hint="Optional output token cap forwarded as max_output_tokens."
      >
        <DraftInput
          value={String(getSchemaValue("maxOutputTokens", ""))}
          onCommit={(v) => {
            const trimmed = v.trim();
            if (!trimmed) {
              setSchemaValue("maxOutputTokens", undefined);
              return;
            }
            const parsed = Number.parseInt(trimmed, 10);
            if (!Number.isFinite(parsed)) return;
            const clamped = Math.max(1, Math.min(100000, parsed));
            setSchemaValue("maxOutputTokens", clamped);
          }}
          immediate
          type="number"
          className={inputClass}
          placeholder="e.g. 4000"
          min="1"
          max="100000"
        />
      </Field>

      <Field
        label="Ollama context window (num_ctx)"
        hint="Optional Ollama context window size for VRAM/context management."
      >
        <DraftInput
          value={String(getSchemaValue("numCtx", ""))}
          onCommit={(v) => {
            const trimmed = v.trim();
            if (!trimmed) {
              setSchemaValue("numCtx", undefined);
              return;
            }
            const parsed = Number.parseInt(trimmed, 10);
            if (!Number.isFinite(parsed)) return;
            const clamped = Math.max(1, Math.min(262144, parsed));
            setSchemaValue("numCtx", clamped);
          }}
          immediate
          type="number"
          className={inputClass}
          placeholder="e.g. 8192"
          min="1"
          max="262144"
          step="1"
        />
      </Field>

      <Field
        label="Thinking mode"
        hint="Controls Ollama thinking behavior: auto keeps provider defaults."
      >
        <select
          className={inputClass}
          value={String(getSchemaValue("thinkingMode", "auto"))}
          onChange={(event) => {
            const value = event.target.value;
            if (value === "on" || value === "off" || value === "auto") {
              setSchemaValue("thinkingMode", value);
            }
          }}
        >
          <option value="auto">auto</option>
          <option value="on">on</option>
          <option value="off">off</option>
        </select>
      </Field>
    </>
  );
}
