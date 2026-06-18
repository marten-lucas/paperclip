import type { AdapterModel } from "../types.js";

export const ironclawHttpModels: AdapterModel[] = [];

export function refreshIronclawHttpModels(models: string[]): void {
  ironclawHttpModels.splice(0, ironclawHttpModels.length, ...models
    .map((model) => model.trim())
    .filter((model) => model.length > 0)
    .map((model) => ({ id: model, label: model })));
}
