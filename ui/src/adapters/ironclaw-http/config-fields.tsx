import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import type { CompanySecret } from "@paperclipai/shared";
import type { AdapterConfigFieldsProps } from "../types";
import {
  Field,
  DraftInput,
} from "../../components/agent-config-primitives";
import { useCompany } from "../../context/CompanyContext";
import { queryKeys } from "../../lib/queryKeys";
import { secretsApi } from "../../api/secrets";

const inputClass =
  "w-full rounded-md border border-border px-2.5 py-1.5 bg-transparent outline-none text-sm font-mono placeholder:text-muted-foreground/40";

type SecretRefBinding = {
  type: "secret_ref";
  secretId: string;
  version?: "latest" | number;
};

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

function readPlainEnvBinding(env: Record<string, unknown>, key: string): string {
  const raw = env[key];
  if (typeof raw === "string") return raw;
  if (typeof raw === "object" && raw !== null && !Array.isArray(raw)) {
    const record = raw as { type?: unknown; value?: unknown };
    if (record.type === "plain" && typeof record.value === "string") return record.value;
  }
  return "";
}

function readSecretRefEnvBinding(env: Record<string, unknown>, key: string): SecretRefBinding | null {
  const raw = env[key];
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const record = raw as { type?: unknown; secretId?: unknown; version?: unknown };
  if (record.type !== "secret_ref" || typeof record.secretId !== "string" || !record.secretId.trim()) {
    return null;
  }
  const version = typeof record.version === "number" ? record.version : "latest";
  return { type: "secret_ref", secretId: record.secretId, version };
}

export function IronclawHttpConfigFields({
  isCreate,
  values,
  set,
  config,
  eff,
  mark,
}: AdapterConfigFieldsProps) {
  const { selectedCompanyId } = useCompany();
  const { data: availableSecrets = [] } = useQuery({
    queryKey: selectedCompanyId ? queryKeys.secrets.list(selectedCompanyId) : ["secrets", "none"],
    queryFn: () => secretsApi.list(selectedCompanyId!),
    enabled: Boolean(selectedCompanyId),
  });

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

  const readEnv = (): Record<string, unknown> => {
    if (isCreate) {
      return asRecord(values?.envBindings);
    }
    return asRecord(eff("adapterConfig", "env", config.env ?? {}));
  };

  const writeEnv = (env: Record<string, unknown>) => {
    if (isCreate) {
      set?.({ envBindings: env, envVars: "" });
      return;
    }
    mark("adapterConfig", "env", env);
  };

  const updatePlainEnv = (key: string, value: string) => {
    const env = { ...readEnv() };
    const trimmed = value.trim();
    if (!trimmed) {
      delete env[key];
      writeEnv(env);
      return;
    }
    env[key] = { type: "plain", value };
    writeEnv(env);
  };

  const updateSecretEnv = (key: string, secretId: string) => {
    const env = { ...readEnv() };
    if (!secretId.trim()) {
      delete env[key];
      writeEnv(env);
      return;
    }
    env[key] = { type: "secret_ref", secretId, version: "latest" };
    writeEnv(env);
  };

  const env = readEnv();
  const gatewayUrl = readPlainEnvBinding(env, "IRONCLAW_BASE_URL");
  const keySecretRef = readSecretRefEnvBinding(env, "IRONCLAW_API_KEY");
  const keyPlain = readPlainEnvBinding(env, "IRONCLAW_API_KEY");
  const keyMode: "plain" | "secret" = keySecretRef ? "secret" : "plain";
  const keySecretId = keySecretRef?.secretId ?? "";
  const keySecretOptions = useMemo(
    () => availableSecrets.filter((secret) => secret.status === "active"),
    [availableSecrets],
  );

  const renderSecretOptionLabel = (secret: CompanySecret) => {
    const suffix = secret.latestVersion > 0 ? ` (v${secret.latestVersion})` : "";
    return `${secret.name}${suffix}`;
  };

  return (
    <>
      <Field
        label="Ironclaw Gateway URL"
        hint="Base URL des Ironclaw Gateways, z.B. https://ironclaw.example/api/v1/responses"
      >
        <DraftInput
          value={gatewayUrl}
          onCommit={(v) => updatePlainEnv("IRONCLAW_BASE_URL", v)}
          immediate
          className={inputClass}
          placeholder="https://.../api/v1/responses"
        />
      </Field>

      <Field
        label="Ironclaw Gateway Key"
        hint="Kann als Plain-Value oder als Secret-Referenz gespeichert werden (env.IRONCLAW_API_KEY)."
      >
        <div className="space-y-2">
          <select
            className={inputClass}
            value={keyMode}
            onChange={(event) => {
              const nextMode = event.target.value === "secret" ? "secret" : "plain";
              if (nextMode === "secret") {
                const firstSecretId = keySecretOptions[0]?.id ?? "";
                updateSecretEnv("IRONCLAW_API_KEY", keySecretId || firstSecretId);
                return;
              }
              if (keyPlain) {
                updatePlainEnv("IRONCLAW_API_KEY", keyPlain);
                return;
              }
              updatePlainEnv("IRONCLAW_API_KEY", "");
            }}
          >
            <option value="plain">Plain value</option>
            <option value="secret">Secret reference</option>
          </select>

          {keyMode === "secret" ? (
            <select
              className={inputClass}
              value={keySecretId}
              onChange={(event) => updateSecretEnv("IRONCLAW_API_KEY", event.target.value)}
            >
              <option value="">Secret auswählen...</option>
              {keySecretOptions.map((secret) => (
                <option key={secret.id} value={secret.id}>
                  {renderSecretOptionLabel(secret)}
                </option>
              ))}
            </select>
          ) : (
            <DraftInput
              value={keyPlain}
              onCommit={(v) => updatePlainEnv("IRONCLAW_API_KEY", v)}
              immediate
              type="password"
              className={inputClass}
              placeholder="sk-..."
            />
          )}
        </div>
      </Field>

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
