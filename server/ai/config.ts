import fs from 'node:fs';
import type { AiEffort, AiSettingsInput, AiStatus } from '../../shared/types';
import { writeFileAtomicPrivate } from '../config/paths';

export const DEFAULT_AI_MODEL = 'claude-opus-5-5';
export const DEFAULT_AI_EFFORT: AiEffort = 'medium';
export const AI_EFFORTS: readonly AiEffort[] = ['low', 'medium', 'high', 'xhigh'];

export interface AiConfig {
  /** null: no key in settings.json / ANTHROPIC_API_KEY -> the SDK's default resolution (e.g. an `ant` profile) */
  apiKey: string | null;
  keySource: AiStatus['keySource'];
  model: string;
  effort: AiEffort;
  /** DB_AUDIT_AI=off: AI descriptions are turned off entirely (no client is ever created) */
  disabled: boolean;
}

/**
 * AI settings live in data/settings.json next to the numeric tunables (`apiKey`, `aiModel`, `aiEffort`).
 * The file is rewritten atomically with mode 0600 and every other key is preserved. The key is never
 * returned by the API and never logged.
 */
export class AiConfigStore {
  constructor(
    private readonly file: string,
    private readonly env: NodeJS.ProcessEnv = process.env,
  ) {}

  private readRaw(): Record<string, unknown> {
    if (!fs.existsSync(this.file)) return {};
    try {
      const v = JSON.parse(fs.readFileSync(this.file, 'utf8')) as unknown;
      return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
    } catch {
      return {};
    }
  }

  get(): AiConfig {
    const raw = this.readRaw();
    const stored = typeof raw.apiKey === 'string' && raw.apiKey.trim() ? raw.apiKey.trim() : null;
    const env = this.env.ANTHROPIC_API_KEY?.trim() || null;
    const model = typeof raw.aiModel === 'string' && raw.aiModel.trim() ? raw.aiModel.trim() : DEFAULT_AI_MODEL;
    const effort = AI_EFFORTS.includes(raw.aiEffort as AiEffort) ? (raw.aiEffort as AiEffort) : DEFAULT_AI_EFFORT;
    return {
      apiKey: stored ?? env,
      keySource: stored ? 'settings' : env ? 'env' : null,
      model,
      effort,
      disabled: (this.env.DB_AUDIT_AI ?? '').toLowerCase() === 'off',
    };
  }

  status(): AiStatus {
    const c = this.get();
    return { configured: !c.disabled && c.keySource !== null, keySource: c.disabled ? null : c.keySource, model: c.model, effort: c.effort };
  }

  update(input: AiSettingsInput): AiStatus {
    const raw = this.readRaw();
    if (input.apiKey === null) delete raw.apiKey;
    else if (typeof input.apiKey === 'string') raw.apiKey = input.apiKey.trim();
    if (input.model !== undefined) raw.aiModel = input.model.trim();
    if (input.effort !== undefined) raw.aiEffort = input.effort;
    writeFileAtomicPrivate(this.file, JSON.stringify(raw, null, 2) + '\n');
    return this.status();
  }
}
