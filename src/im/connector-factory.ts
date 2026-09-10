import { DingTalkConnector } from './dingtalk/connector.js';
import { resolveImPlatform } from './platform.js';
import type { ImConnector, ImPlatform } from './types.js';
import { WeComConnector } from './wecom/connector.js';

export interface ConnectorBotConfig {
  larkAppId: string;
  larkAppSecret: string;
  platform?: ImPlatform;
  brand?: 'feishu' | 'lark';
  dingtalk?: {
    robotCode?: string;
  };
  wecom?: {
    corpId: string;
    agentId: number;
    token: string;
    encodingAesKey: string;
    callbackHost?: string;
    callbackPort: number;
    callbackPath?: string;
  };
}

export interface ConnectorCredentialValidation {
  ok: boolean;
  message: string;
}

export async function validateExternalImCredentials(
  config: ConnectorBotConfig,
): Promise<ConnectorCredentialValidation> {
  const platform = resolveImPlatform(config);
  try {
    if (platform === 'dingtalk') {
      const response = await fetch('https://api.dingtalk.com/v1.0/oauth2/accessToken', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          appKey: config.larkAppId,
          appSecret: config.larkAppSecret,
        }),
        signal: AbortSignal.timeout(15_000),
      });
      const result = await response.json().catch(() => ({})) as Record<string, unknown>;
      return response.ok && typeof result.accessToken === 'string'
        ? { ok: true, message: 'DingTalk credentials verified' }
        : { ok: false, message: String(result.message ?? result.code ?? `HTTP ${response.status}`) };
    }
    if (platform === 'wecom') {
      if (!config.wecom) return { ok: false, message: 'missing wecom config block' };
      const url = new URL('https://qyapi.weixin.qq.com/cgi-bin/gettoken');
      url.searchParams.set('corpid', config.wecom.corpId);
      url.searchParams.set('corpsecret', config.larkAppSecret);
      const response = await fetch(url, { signal: AbortSignal.timeout(15_000) });
      const result = await response.json().catch(() => ({})) as Record<string, unknown>;
      return response.ok && result.errcode === 0 && typeof result.access_token === 'string'
        ? { ok: true, message: 'WeCom credentials verified' }
        : { ok: false, message: String(result.errmsg ?? result.errcode ?? `HTTP ${response.status}`) };
    }
    return { ok: false, message: `${platform} is not an external connector` };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * Build a connector for non-Lark platforms. Feishu/Lark keep their mature
 * SDK implementation while sharing the same outbound registry boundary.
 */
export function createExternalImConnector(config: ConnectorBotConfig): ImConnector | undefined {
  const platform = resolveImPlatform(config);
  if (platform === 'dingtalk') {
    return new DingTalkConnector({
      appId: config.larkAppId,
      clientId: config.larkAppId,
      clientSecret: config.larkAppSecret,
      robotCode: config.dingtalk?.robotCode,
    });
  }
  if (platform === 'wecom') {
    const wecom = config.wecom;
    if (!wecom) throw new Error(`WeCom bot ${config.larkAppId} is missing its wecom config block`);
    return new WeComConnector({
      appId: config.larkAppId,
      corpId: wecom.corpId,
      agentId: wecom.agentId,
      secret: config.larkAppSecret,
      token: wecom.token,
      encodingAesKey: wecom.encodingAesKey,
      callbackHost: wecom.callbackHost,
      callbackPort: wecom.callbackPort,
      callbackPath: wecom.callbackPath,
    });
  }
  return undefined;
}
