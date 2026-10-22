import { createElement } from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BotAgentSection } from '../src/dashboard/web/bot-defaults-page.js';
import { orchestrateCodexRpcInit, type RpcInitEffects } from '../src/codex-rpc-lifecycle.js';
import { requestSessionRestart, __testOnly_resetRestartCoordinator } from '../src/core/worker-pool.js';
import * as registry from '../src/bot-registry.js';
import * as globals from '../src/global-config.js';
import { classifyMergedRestart } from '../src/core/restart-followup-policy.js';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

afterEach(() => {
  __testOnly_resetRestartCoordinator();
  vi.restoreAllMocks();
});

describe('RPC override in UI and session restart', () => {
  it('blocks a conflicting Auto save, then submits an explicit bot-only false after operator selection', async () => {
    let saved: any;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
      if (init?.method === 'PUT') saved = JSON.parse(String(init.body));
      return Response.json(init?.method === 'PUT'
        ? { ...saved, ok: true, codexRpcInputDefault: true, codexRpcInputEffective: false }
        : { models: ['first', 'backup'], source: 'live' });
    });
    let view: TestRenderer.ReactTestRenderer | undefined;
    try {
      await act(async () => { view = TestRenderer.create(createElement(BotAgentSection, {
        bot: { larkAppId: 'ui_rpc', cliId: 'traex', model: 'first', codexRpcInputDefault: true },
        sessionFallback: 'traex', patchBot: vi.fn(),
        cliState: { options: [{ id: 'traex', label: 'TraeX' }], ttadkModelDefault: '', ttadkModelSuggestions: [] },
      })); });
      act(() => view!.root.findByProps({ 'data-input': 'autoModelEnabled' }).props.onChange({ currentTarget: { checked: true } }));
      expect(view!.root.findByProps({ 'data-auto-model-conflict': '' }).props.role).toBe('alert');
      expect(view!.root.findByProps({ 'data-action': 'save-auto-model' }).props.disabled).toBe(true);
      await act(async () => { await view!.root.findByProps({ 'data-action': 'save-agent' }).props.onClick(); });
      expect(saved).toBeUndefined();
      act(() => view!.root.findByProps({ dataInput: 'agentRpcInput' }).props.onChange('off'));
      expect(view!.root.findAllByProps({ 'data-auto-model-conflict': '' })).toHaveLength(0);
      await act(async () => { await view!.root.findByProps({ 'data-action': 'save-agent' }).props.onClick(); });
      expect(saved).toMatchObject({ codexRpcInput: false, model: 'auto',
        traexAutoModel: { enabled: true, models: ['first'] } });
    } finally { if (view) act(() => view!.unmount()); }
  });

  it('carries the effective bot override on a real restart IPC and keeps an RPC mode change distinct when requests merge', () => {
    vi.spyOn(globals, 'readGlobalConfig').mockReturnValue({ dashboard: { codexRpcInput: true } });
    vi.spyOn(registry, 'getBot').mockReturnValue({ config: {
      larkAppId: 'restart_rpc', cliId: 'traex', model: 'first', codexRpcInput: false,
    } } as any);
    const send = vi.fn();
    const session: any = { larkAppId: 'restart_rpc', session: { sessionId: 'rpc-carrier', cliId: 'traex' },
      worker: { killed: false, send } };
    requestSessionRestart(session, { source: 'slash', notify: vi.fn(async () => {}) } as any);
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ type: 'restart', codexRpcInput: false }));
    expect(classifyMergedRestart({ windowLaunch: { codexRpcInput: true },
      requested: { codexRpcInput: false }, convergencePending: false })).toBe('converge');
  });

  it('replaces only a proven old RPC viewer when RPC was turned off and aborts on an unconfirmed removal', async () => {
    const cfg: any = { type: 'init', cliId: 'traex', backendType: 'tmux', codexRpcInput: false,
      resume: true, cliSessionId: 'native', sessionId: 'viewer', prompt: '' };
    const killVerify = vi.fn(async () => true);
    const fx: RpcInitEffects = {
      paneInfo: () => ({ name: 'bmx-viewer', live: true }), paneIsRemote: () => true,
      prepare: vi.fn(async () => {}), engage: vi.fn(async () => 'resumed'),
      killVerify, teardownEngine: vi.fn(), log: vi.fn(), notify: vi.fn(),
    };
    expect(await orchestrateCodexRpcInit(cfg, fx)).toMatchObject({ engaged: false, abortSpawn: false });
    expect(killVerify).toHaveBeenCalledWith('bmx-viewer');
    expect(fx.engage).not.toHaveBeenCalled();
    killVerify.mockClear();
    expect(await orchestrateCodexRpcInit(cfg, { ...fx, paneIsRemote: () => false })).toMatchObject({ abortSpawn: false });
    expect(killVerify).not.toHaveBeenCalled();
    killVerify.mockResolvedValue(false);
    expect(await orchestrateCodexRpcInit(cfg, fx)).toMatchObject({ abortSpawn: true });
    expect(fx.notify).toHaveBeenCalled();
  });
});
