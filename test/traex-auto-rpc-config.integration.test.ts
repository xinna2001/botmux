import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  __testOnly_resetBotRegistry, getBot, loadBotConfigs, parseBotConfigsFromText, registerBot,
} from '../src/bot-registry.js';
import { setLarkAppId, startIpcServer } from '../src/core/dashboard-ipc-server.js';
import { invalidateGlobalConfigCache } from '../src/global-config.js';
import { config } from '../src/config.js';
import { resolveCodexRpcInput } from '../src/services/codex-rpc-input-policy.js';
import { botDefaultsPayload } from '../src/dashboard/bot-payload.js';
import { applyConfigField, findConfigField } from '../src/services/bot-config-store.js';

describe('Auto and global RPC configuration compatibility', () => {
  it('rejects inherited RPC atomically and persists a per-bot terminal override without changing its RPC peer', async () => {
    const root = mkdtempSync(join(tmpdir(), 'auto-rpc-config-'));
    const oldBots = process.env.BOTS_CONFIG;
    const oldGlobal = process.env.BOTMUX_GLOBAL_CONFIG_FILE;
    const botsPath = join(root, 'bots.json');
    const globalPath = join(root, 'global.json');
    process.env.BOTS_CONFIG = botsPath;
    process.env.BOTMUX_GLOBAL_CONFIG_FILE = globalPath;
    const globalText = JSON.stringify({ dashboard: { codexRpcInput: true } });
    writeFileSync(globalPath, globalText);
    const peer = { larkAppId: 'rpc_peer', larkAppSecret: 'fixture', cliId: 'codex' };
    writeFileSync(botsPath, JSON.stringify([
      { larkAppId: 'auto_target', larkAppSecret: 'fixture', cliId: 'traex' }, peer,
    ]));
    invalidateGlobalConfigCache();
    __testOnly_resetBotRegistry();
    loadBotConfigs().forEach(registerBot);
    setLarkAppId('auto_target');
    const server = await startIpcServer({ host: '127.0.0.1', port: 0 });
    const base = `http://127.0.0.1:${server.port}`;
    const pool = { enabled: true, models: ['first', 'backup'], queueTimeoutMs: 30_000 };
    const save = (extra: object = {}) => fetch(`${base}/api/bot-agent`, {
      method: 'PUT', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ cliId: 'traex', model: 'auto', traexAutoModel: pool, ...extra }),
    });
    try {
      const before = readFileSync(botsPath, 'utf8');
      const rejected = await save();
      expect(rejected.status).toBe(400);
      expect(await rejected.json()).toMatchObject({ ok: false, error: 'traex_auto_model_rpc_conflict' });
      expect(readFileSync(botsPath, 'utf8')).toBe(before);
      expect(getBot('auto_target').config.traexAutoModel).toBeUndefined();
      const accepted = await save({ codexRpcInput: false });
      expect(accepted.status).toBe(200);
      expect(await accepted.json()).toMatchObject({
        ok: true, codexRpcInput: false, codexRpcInputDefault: true, codexRpcInputEffective: false,
      });
      expect(JSON.parse(readFileSync(botsPath, 'utf8'))).toEqual([
        expect.objectContaining({ codexRpcInput: false, traexAutoModel: pool }), peer,
      ]);
      const loaded = loadBotConfigs();
      expect(loaded[0].codexRpcInput).toBe(false);
      expect(loaded[1].codexRpcInput).toBeUndefined();
      expect(resolveCodexRpcInput(loaded[0].cliId, loaded[0].codexRpcInput, config.codexRpcInputDefault)).toBe(false);
      expect(resolveCodexRpcInput(loaded[1].cliId, loaded[1].codexRpcInput, config.codexRpcInputDefault)).toBe(true);
      // An old client omitting the field preserves the explicit false.
      expect((await save()).status).toBe(200);
      const defaults = await (await fetch(`${base}/api/bot-default-oncall`)).json();
      expect(defaults).toMatchObject({
        codexRpcInput: false, codexRpcInputDefault: true, codexRpcInputEffective: false,
        traexAutoModelBlockedReason: null,
      });
      const spec = findConfigField('codexRpcInput')!;
      // /config writers must not recreate the same conflict.
      const reset = await applyConfigField('auto_target', spec, null);
      expect(reset).toMatchObject({ ok: false, reason: 'traex_auto_model_rpc_conflict' });
      const force = await applyConfigField('auto_target', spec, true);
      expect(force).toMatchObject({ ok: false, reason: 'traex_auto_model_rpc_conflict' });
      expect((await applyConfigField('rpc_peer', spec, false)).ok).toBe(true);
      expect(getBot('rpc_peer').config.codexRpcInput).toBe(false);
      expect(loadBotConfigs()[1].codexRpcInput).toBe(false);
      expect((await applyConfigField('rpc_peer', spec, null)).ok).toBe(true);
      expect(getBot('rpc_peer').config.codexRpcInput).toBeUndefined();
      expect(readFileSync(globalPath, 'utf8')).toBe(globalText);
    } finally {
      await server.close();
      setLarkAppId('');
      __testOnly_resetBotRegistry();
      if (oldBots === undefined) delete process.env.BOTS_CONFIG; else process.env.BOTS_CONFIG = oldBots;
      if (oldGlobal === undefined) delete process.env.BOTMUX_GLOBAL_CONFIG_FILE; else process.env.BOTMUX_GLOBAL_CONFIG_FILE = oldGlobal;
      invalidateGlobalConfigCache();
      rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);

  it('exposes legacy conflicts, including after a global default change, and preserves true/false/absent on load', () => {
    const root = mkdtempSync(join(tmpdir(), 'auto-rpc-legacy-'));
    const previous = process.env.BOTMUX_GLOBAL_CONFIG_FILE;
    process.env.BOTMUX_GLOBAL_CONFIG_FILE = join(root, 'global.json');
    const descriptor = { larkAppId: 'legacy_auto', cliId: 'traex', model: 'auto',
      traexAutoModel: { enabled: true as const, models: ['first'], queueTimeoutMs: 30_000 } };
    try {
      writeFileSync(process.env.BOTMUX_GLOBAL_CONFIG_FILE, JSON.stringify({ dashboard: { codexRpcInput: false } }));
      invalidateGlobalConfigCache();
      expect(botDefaultsPayload(descriptor, {})).toMatchObject({ traexAutoModelBlockedReason: null });
      writeFileSync(process.env.BOTMUX_GLOBAL_CONFIG_FILE, JSON.stringify({ dashboard: { codexRpcInput: true } }));
      invalidateGlobalConfigCache();
      expect(botDefaultsPayload(descriptor, {})).toMatchObject({
        codexRpcInputEffective: true, traexAutoModelBlockedReason: 'rpc_input',
      });
      expect(botDefaultsPayload({ ...descriptor, codexRpcInput: false }, {})).toMatchObject({
        codexRpcInputEffective: false, traexAutoModelBlockedReason: null,
      });
      const loaded = parseBotConfigsFromText(JSON.stringify([
        { ...descriptor, larkAppSecret: 'fixture' },
        { larkAppId: 'off', larkAppSecret: 'fixture', cliId: 'traex', codexRpcInput: false },
        { larkAppId: 'on', larkAppSecret: 'fixture', cliId: 'codex', codexRpcInput: true },
      ]));
      expect(loaded.map(bot => bot.codexRpcInput)).toEqual([undefined, false, true]);
      expect(resolveCodexRpcInput('claude-code', undefined, true)).toBe(false);
      expect(resolveCodexRpcInput('codex', true, true, 'external-server')).toBe(false);
    } finally {
      if (previous === undefined) delete process.env.BOTMUX_GLOBAL_CONFIG_FILE; else process.env.BOTMUX_GLOBAL_CONFIG_FILE = previous;
      invalidateGlobalConfigCache();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
