import { isCodexReasoningEffort, reasoningEffortsForCliModel } from '../../services/codex-reasoning-effort.js';
import { resolveTraexAutoModelSettings, type TraexAutoModelConfig, type TraexAutoModelSettings } from '../../services/traex-auto-model.js';
import type { ModelCapabilities } from './bot-defaults.js';

/** Pick the strongest combination advertised for the largest context variant.
 * Variant reasoning limits outrank the model-wide union (e.g. ultra may be
 * advertised only outside Standard/Max). Missing metadata never invents Max. */
export function strongestTraexModelSettings(model: string, capability?: ModelCapabilities): TraexAutoModelSettings {
  const variant = capability?.contextVariants?.length
    ? capability.contextVariants.reduce((largest, item) => item.contextWindow > largest.contextWindow ? item : largest)
    : undefined;
  const efforts = variant?.reasoningEfforts ?? capability?.reasoningEfforts
    ?? reasoningEffortsForCliModel('traex', model);
  const reasoningEffort = [...['ultra', 'max', 'xhigh', 'high', 'medium', 'low'] as const]
    .find(effort => efforts.includes(effort));
  return {
    ...(reasoningEffort ? { reasoningEffort } : {}),
    ...(variant ? { modelBackendVariant: variant.id } : {}),
  };
}

export interface TraexAutoModelDraft {
  enabled: boolean;
  reselectPerTurn: boolean;
  models: string[];
  modelSettings: Record<string, TraexAutoModelSettings>;
  timeoutSeconds: string;
  cooldownSeconds: string;
}

export function autoModelDraftFromConfig(
  config?: TraexAutoModelConfig,
  legacy: TraexAutoModelSettings = {},
): TraexAutoModelDraft {
  return {
    enabled: config?.enabled === true,
    reselectPerTurn: config?.reselectPerTurn === true,
    models: config?.models ?? [],
    modelSettings: Object.fromEntries((config?.models ?? []).map(model => [
      model, resolveTraexAutoModelSettings(config!, model, legacy),
    ])),
    timeoutSeconds: String((config?.queueTimeoutMs ?? 30_000) / 1_000),
    cooldownSeconds: String((config?.switchCooldownMs ?? 60_000) / 1_000),
  };
}

export interface AutoModelDraftStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}
const keyFor = (botId: string) => `botmux:traex-auto-model-draft:v1:${encodeURIComponent(botId)}`;
export function autoModelDraftStorage(): AutoModelDraftStorage | undefined {
  try { return typeof window !== 'undefined' ? window.localStorage : undefined; }
  catch { return undefined; }
}

export function readAutoModelDraft(botId: string, storage = autoModelDraftStorage()): TraexAutoModelDraft | undefined {
  try {
    const raw = storage?.getItem(keyFor(botId));
    if (!raw) return undefined;
    const value = JSON.parse(raw);
    if (value.version !== 1 || typeof value.draft?.enabled !== 'boolean'
      || !Array.isArray(value.draft.models) || !value.draft.models.every((model: unknown) => typeof model === 'string')
      || typeof value.draft.timeoutSeconds !== 'string' || typeof value.draft.cooldownSeconds !== 'string'
      || !value.draft.modelSettings || typeof value.draft.modelSettings !== 'object'
      || Array.isArray(value.draft.modelSettings)) return undefined;
    for (const settings of Object.values(value.draft.modelSettings) as any[]) {
      if (!settings || typeof settings !== 'object'
        || (settings.reasoningEffort !== undefined && !isCodexReasoningEffort(settings.reasoningEffort))
        || (settings.modelBackendVariant !== undefined && settings.modelBackendVariant !== 'standard' && settings.modelBackendVariant !== 'max')) {
        return undefined;
      }
    }
    if (value.draft.reselectPerTurn !== undefined && typeof value.draft.reselectPerTurn !== 'boolean') return undefined;
    return { ...value.draft, reselectPerTurn: value.draft.reselectPerTurn === true };
  } catch { return undefined; }
}

/** Called synchronously at the edit edge so reload cannot outrun a debounced
 * timer or effect. Only per-bot model preferences are stored, no credentials. */
export function writeAutoModelDraft(botId: string, draft: TraexAutoModelDraft, storage = autoModelDraftStorage()): boolean {
  try {
    if (!storage) return false;
    storage.setItem(keyFor(botId), JSON.stringify({ version: 1, draft }));
    return true;
  } catch { return false; }
}

export function clearAutoModelDraft(botId: string, storage = autoModelDraftStorage()): void {
  try { storage?.removeItem(keyFor(botId)); } catch { /* restricted browser storage */ }
}
