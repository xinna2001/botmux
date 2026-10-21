import { createElement } from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { BotAgentSection } from '../src/dashboard/web/bot-defaults-page.js';
import { ModelPickerField } from '../src/dashboard/web/field-controls.js';
import { __testOnly_resetBotRegistry, getBot, loadBotConfigs, registerBot } from '../src/bot-registry.js';
import { setLarkAppId, startIpcServer } from '../src/core/dashboard-ipc-server.js';
import { resolveSessionLaunchModelChoice } from '../src/core/session-model.js';
import { TraexAutoModelController } from '../src/services/traex-auto-model.js';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('../src/adapters/cli/model-catalog-json.js', async importOriginal => ({
  ...await importOriginal<typeof import('../src/adapters/cli/model-catalog-json.js')>(),
  detectModelCapabilitiesViaExec: vi.fn(async () => [
    { slug: 'gpt-5.6-sol', serviceTiers: [], reasoningEfforts: ['low', 'medium', 'high', 'xhigh'],
      contextVariants: [{ id: 'standard', contextWindow: 272000 }, { id: 'max', contextWindow: 800000 }] },
    { slug: 'gpt-6-astra', serviceTiers: [], reasoningEfforts: ['low', 'medium', 'high', 'xhigh'],
      contextVariants: [{ id: 'standard', contextWindow: 272000 }, { id: 'max', contextWindow: 800000 }] },
  ]),
}));

describe('TraeX auto-model settings', () => {
  it('launches a retained topic model only for the same native session and unchanged policy', () => {
    const policy = { enabled: true as const, models: ['first', 'second'], queueTimeoutMs: 30_000 };
    const controller = new TraexAutoModelController(policy);
    controller.observeRunningModel('second');
    const session = { cliId: 'traex' as const, cliSessionId: 'native', traexAutoModelRuntime: controller.runtimeState('native') };
    const bot = { cliId: 'traex' as const, model: 'auto', traexAutoModel: policy };
    expect(resolveSessionLaunchModelChoice({ session }, bot).model).toBe('second');
    expect(resolveSessionLaunchModelChoice({ session: { ...session, cliSessionId: 'fresh' } }, bot).model).toBe('first');
    expect(resolveSessionLaunchModelChoice({ session }, { ...bot, traexAutoModel: { ...policy, reselectPerTurn: true } }).model).toBe('first');
  });

  it('round-trips ordered pools through disk, live registry, GET defaults and launch resolution', async () => {
    const root = mkdtempSync(join(tmpdir(), 'botmux-auto-settings-'));
    const path = join(root, 'bots.json');
    const previous = process.env.BOTS_CONFIG;
    process.env.BOTS_CONFIG = path;
    writeFileSync(path, JSON.stringify([{ larkAppId: 'auto_test', larkAppSecret: 'secret', cliId: 'traex' }]));
    __testOnly_resetBotRegistry();
    loadBotConfigs().forEach(registerBot);
    setLarkAppId('auto_test');
    const server = await startIpcServer({ host: '127.0.0.1', port: 0 });
    const base = `http://127.0.0.1:${server.port}`;
    const save = (body: object) => fetch(`${base}/api/bot-agent`, {
      method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    });
    try {
      const pool = { enabled: true, models: ['gpt-5.6-sol', 'gpt-6-astra', 'glm-5.1'], queueTimeoutMs: 12_000 };
      const saved = await save({ cliId: 'traex', model: 'auto', traexAutoModel: pool });
      expect(await saved.json()).toMatchObject({ ok: true, model: 'auto', traexAutoModel: pool });
      expect(saved.status).toBe(200);
      expect(JSON.parse(readFileSync(path, 'utf8'))[0].traexAutoModel).toEqual(pool);
      expect(getBot('auto_test').config.traexAutoModel).toEqual(pool);
      const defaults = await fetch(`${base}/api/bot-default-oncall`);
      expect(await defaults.json()).toMatchObject({ model: 'auto', traexAutoModel: pool });
      const loaded = loadBotConfigs()[0]!;
      expect(resolveSessionLaunchModelChoice({ session: { cliId: 'traex' } }, loaded)).toEqual({
        model: pool.models[0], traexAutoModel: pool,
      });
      // Old clients omitting the field preserve it; an invalid pool is atomic.
      expect((await save({ cliId: 'traex', model: 'auto' })).status).toBe(200);
      const configuredPool = { ...pool, modelSettings: {
        'gpt-5.6-sol': { reasoningEffort: 'xhigh', modelBackendVariant: 'max' },
        'gpt-6-astra': { reasoningEffort: 'high', modelBackendVariant: 'standard' },
        'glm-5.1': {},
      } };
      const configured = await save({ cliId: 'traex', model: 'auto', traexAutoModel: configuredPool });
      const configuredBody = await configured.json();
      expect(configuredBody.ok, JSON.stringify(configuredBody)).toBe(true);
      expect(configuredBody).toMatchObject({ traexAutoModel: configuredPool });
      expect(configured.status).toBe(200);
      expect(getBot('auto_test').config.traexAutoModel).toEqual(configuredPool);
      const invalidEffort = await save({ cliId: 'traex', model: 'auto', traexAutoModel: {
        ...configuredPool, modelSettings: { 'gpt-6-astra': { reasoningEffort: 'ultra' } },
      } });
      expect(invalidEffort.status).toBe(400);
      const before = readFileSync(path, 'utf8');
      expect((await save({ cliId: 'traex', model: 'auto', traexAutoModel: { ...pool, models: ['auto'] } })).status).toBe(400);
      expect(readFileSync(path, 'utf8')).toBe(before);
      expect((await save({ cliId: 'traex', model: 'auto', traexAutoModel: null })).status).toBe(400);
      expect((await save({ cliId: 'traex', model: pool.models[0], traexAutoModel: null })).status).toBe(200);
      expect(getBot('auto_test').config.traexAutoModel).toBeUndefined();
      expect(resolveSessionLaunchModelChoice({ session: { cliId: 'claude-code' } }, {
        cliId: 'claude-code', model: 'auto', traexAutoModel: pool as any,
      })).toEqual({ model: 'auto' });
    } finally {
      await server.close();
      setLarkAppId('');
      __testOnly_resetBotRegistry();
      if (previous === undefined) delete process.env.BOTS_CONFIG; else process.env.BOTS_CONFIG = previous;
      rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);

  it('starts off, edits order, and saves the virtual model with only configured entries', async () => {
    const previous = globalThis.fetch;
    let saved: any;
    globalThis.fetch = vi.fn(async (_url: string, init?: RequestInit) => {
      if (init?.method === 'PUT') saved = JSON.parse(init.body as string);
      return { ok: true, status: 200, json: async () => init?.method === 'PUT'
        ? { ok: true, cliId: 'traex', model: 'auto', traexAutoModel: saved.traexAutoModel }
        : { models: ['m1', 'm2', 'm3'], source: 'live', profiles: [] } };
    }) as any;
    const patchBot = vi.fn();
    let rendered: TestRenderer.ReactTestRenderer | undefined;
    try {
      await act(async () => {
        rendered = TestRenderer.create(createElement(BotAgentSection, {
          bot: { larkAppId: 'auto_ui', cliId: 'traex', model: 'm1' }, sessionFallback: 'traex',
          cliState: { options: [{ id: 'traex', label: 'TraeX' }], ttadkModelDefault: '', ttadkModelSuggestions: [] }, patchBot,
        }));
      });
      const root = rendered!.root;
      expect(root.findByProps({ 'data-input': 'autoModelEnabled' }).props.checked).toBe(false);
      act(() => root.findByProps({ 'data-input': 'autoModelEnabled' }).props.onChange({ currentTarget: { checked: true } }));
      expect(root.findByProps({ 'data-input': 'autoModelReselectPerTurn' }).props.checked).toBe(false);
      expect(root.findAllByType('span').some(span => span.children.includes('话题内每轮重新择优'))).toBe(true);
      act(() => root.findByProps({ 'data-action': 'autoModelAdd' }).props.onClick());
      act(() => root.findAllByType(ModelPickerField).find(field => field.props.dataInput === 'autoModel1')!.props.onChange('m2'));
      act(() => root.findAllByProps({ 'aria-label': '上移模型' })[1]!.props.onClick());
      act(() => root.findByProps({ dataInput: 'autoModelEffort0' }).props.onChange('high'));
      act(() => root.findByProps({ dataInput: 'autoModelContext0' }).props.onChange('max'));
      act(() => root.findByProps({ 'data-input': 'autoModelTimeout' }).props.onChange({ currentTarget: { value: '15' } }));
      await act(async () => { await root.findByProps({ 'data-action': 'save-agent' }).props.onClick(); });
      expect(saved).toMatchObject({ model: 'auto', traexAutoModel: { enabled: true, models: ['m2', 'm1'],
        modelSettings: { m2: { reasoningEffort: 'high', modelBackendVariant: 'max' }, m1: {} },
        reselectPerTurn: false, queueTimeoutMs: 15_000, switchCooldownMs: 60_000 } });
      expect(patchBot).toHaveBeenLastCalledWith('auto_ui', expect.objectContaining({ traexAutoModel: saved.traexAutoModel }));
    } finally {
      if (rendered) act(() => rendered!.unmount());
      globalThis.fetch = previous;
    }
  });

  it('keeps unsaved selections after remount and a fresh server object, then clears the draft only on successful save', async () => {
    const previous = globalThis.fetch;
    const entries = new Map<string, string>();
    vi.stubGlobal('window', { localStorage: {
      getItem: (key: string) => entries.get(key) ?? null,
      setItem: (key: string, value: string) => { entries.set(key, value); },
      removeItem: (key: string) => { entries.delete(key); },
    } });
    let saved: any;
    globalThis.fetch = vi.fn(async (_url: string, init?: RequestInit) => {
      if (init?.method === 'PUT') saved = JSON.parse(init.body as string);
      return { ok: true, status: 200, json: async () => init?.method === 'PUT'
        ? { ok: true, cliId: 'traex', model: 'auto', traexAutoModel: saved.traexAutoModel }
        : { models: ['GPT-6.1-Sol'], source: 'live', modelCapabilities: [{
          slug: 'GPT-6.1-Sol', serviceTiers: [], reasoningEfforts: ['low', 'medium', 'high', 'xhigh'],
          contextVariants: [{ id: 'standard', contextWindow: 475000 }, { id: 'max', contextWindow: 800000 }],
        }] } };
    }) as any;
    const props = {
      bot: { larkAppId: 'auto_draft', cliId: 'traex', model: 'GPT-6.1-Sol' },
      sessionFallback: 'traex', cliState: { options: [{ id: 'traex', label: 'TraeX' }],
        ttadkModelDefault: '', ttadkModelSuggestions: [] }, patchBot: vi.fn(),
    };
    let rendered: TestRenderer.ReactTestRenderer | undefined;
    try {
      await act(async () => { rendered = TestRenderer.create(createElement(BotAgentSection, props)); });
      act(() => rendered!.root.findByProps({ 'data-input': 'autoModelEnabled' }).props.onChange({ currentTarget: { checked: true } }));
      expect(rendered!.root.findByProps({ dataInput: 'autoModelEffort0' }).props.value).toBe('xhigh');
      expect(rendered!.root.findByProps({ dataInput: 'autoModelContext0' }).props.value).toBe('max');
      act(() => rendered!.root.findByProps({ dataInput: 'autoModelContext0' }).props.onChange('standard'));
      act(() => rendered!.root.findByProps({ 'data-input': 'autoModelReselectPerTurn' }).props.onChange({ currentTarget: { checked: true } }));
      expect(entries.size).toBe(1); // persisted at edit edge, before refresh
      act(() => rendered!.unmount());
      await act(async () => { rendered = TestRenderer.create(createElement(BotAgentSection, { ...props, bot: { ...props.bot } })); });
      expect(rendered!.root.findByProps({ 'data-input': 'autoModelEnabled' }).props.checked).toBe(true);
      expect(rendered!.root.findByProps({ 'data-input': 'autoModelReselectPerTurn' }).props.checked).toBe(true);
      expect(rendered!.root.findByProps({ dataInput: 'autoModelContext0' }).props.value).toBe('standard');
      expect(rendered!.root.findByProps({ dataInput: 'autoModelEffort0' }).props.value).toBe('xhigh');
      await act(async () => { await rendered!.root.findByProps({ 'data-action': 'save-auto-model' }).props.onClick(); });
      expect(saved.traexAutoModel.modelSettings['GPT-6.1-Sol']).toEqual({ reasoningEffort: 'xhigh', modelBackendVariant: 'standard' });
      expect(saved.traexAutoModel.reselectPerTurn).toBe(true);
      expect(entries.size).toBe(0);
    } finally {
      if (rendered) act(() => rendered!.unmount());
      globalThis.fetch = previous;
      vi.unstubAllGlobals();
    }
  });
});
