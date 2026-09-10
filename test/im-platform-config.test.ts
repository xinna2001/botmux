import { afterEach, describe, expect, it } from 'vitest';
import {
  __testOnly_resetBotRegistry,
  getBot,
  parseBotConfigsFromText,
  registerBot,
} from '../src/bot-registry.js';
import { imCapabilities } from '../src/im/capabilities.js';
import { nativePlatformUserId, platformUserId, resolveImPlatform } from '../src/im/platform.js';
import { buildTurnParticipantsFrom } from '../src/core/reply-target.js';
import { classifyMentionIdentifiers } from '../src/services/send-policy.js';

afterEach(() => __testOnly_resetBotRegistry());

describe('IM platform config', () => {
  it('keeps legacy configs on Feishu and normalizes Lark platform region', () => {
    const [legacy] = parseBotConfigsFromText(JSON.stringify([
      { larkAppId: 'cli_legacy', larkAppSecret: 'secret' },
    ]));
    expect(resolveImPlatform(legacy)).toBe('feishu');

    const [lark] = parseBotConfigsFromText(JSON.stringify([
      { larkAppId: 'cli_lark', larkAppSecret: 'secret', platform: 'lark' },
    ]));
    expect(resolveImPlatform(lark)).toBe('lark');
    expect(lark.brand).toBe('lark');
  });

  it('parses DingTalk and avoids constructing a Lark SDK client', () => {
    const [config] = parseBotConfigsFromText(JSON.stringify([{
      larkAppId: 'ding-client',
      larkAppSecret: 'ding-secret',
      platform: 'dingtalk',
      dingtalk: { robotCode: 'ding-robot' },
      allowedUsers: ['dt_staff_1'],
    }]));
    registerBot(config);
    expect(getBot(config.larkAppId).client).toBeNull();
    expect(config.dingtalk?.robotCode).toBe('ding-robot');
  });

  it('fails closed on incomplete WeCom callback configuration', () => {
    expect(() => parseBotConfigsFromText(JSON.stringify([{
      larkAppId: 'wecom-agent',
      larkAppSecret: 'secret',
      platform: 'wecom',
      wecom: { corpId: 'corp', agentId: 1 },
    }]))).toThrow(/wecom\.token/);
  });

  it('prefixes platform user ids without double-prefixing', () => {
    expect(platformUserId('dingtalk', 'staff-1')).toBe('dt_staff-1');
    expect(platformUserId('dingtalk', 'dt_staff-1')).toBe('dt_staff-1');
    expect(nativePlatformUserId('wecom', 'ww_user-1')).toBe('user-1');
  });

  it('publishes explicit capability differences', () => {
    expect(imCapabilities('feishu').cards).toBe(true);
    expect(imCapabilities('dingtalk').cards).toBe(false);
    expect(imCapabilities('wecom').threads).toBe(false);
  });

  it('keeps native DingTalk and WeCom ids executable for mention-back', () => {
    expect(buildTurnParticipantsFrom(
      { openId: 'dt_staff-1', name: 'Alice' },
      undefined,
      'bot_dingtalk',
      () => false,
    )).toEqual({
      participants: [{ openId: 'dt_staff-1', name: 'Alice' }],
      incomplete: false,
    });
    expect(classifyMentionIdentifiers([
      { identifier: 'ww_user-1', name: 'Owner' },
    ], false)).toMatchObject({
      ok: true,
      openIdMentions: [{ identifier: 'ww_user-1', name: 'Owner' }],
      toResolve: [],
    });
  });
});
