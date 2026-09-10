import { createServer } from 'node:http';
import { encrypt, getSignature } from '@wecom/crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DingTalkConnector } from '../src/im/dingtalk/connector.js';
import { WeComConnector } from '../src/im/wecom/connector.js';
import type { UnifiedImInboundMessage } from '../src/im/types.js';

const activeConnectors: Array<{ stop(): Promise<void> }> = [];
afterEach(async () => {
  await Promise.all(activeConnectors.splice(0).map(connector => connector.stop()));
  vi.unstubAllGlobals();
});

async function unusedPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  await new Promise<void>(resolve => server.close(() => resolve()));
  return port;
}

describe('DingTalk connector', () => {
  it('normalizes a Stream robot callback into the shared inbound contract', async () => {
    const connector = new DingTalkConnector({
      appId: 'ding-app',
      clientId: 'ding-app',
      clientSecret: 'secret',
      robotCode: 'robot-code',
    });
    let received: UnifiedImInboundMessage | undefined;
    (connector as any).handler = { onMessage: async (message: UnifiedImInboundMessage) => { received = message; } };
    await (connector as any).handleRobotEvent({
      headers: { messageId: 'stream-event-1' },
      data: JSON.stringify({
        conversationId: 'cid-group',
        conversationType: '2',
        msgId: 'ding-message-1',
        msgtype: 'text',
        text: { content: '  hello DingTalk  ' },
        senderStaffId: 'staff-1',
        senderId: 'encrypted-sender',
        senderNick: 'Alice',
        createAt: 1_700_000_000_000,
        sessionWebhook: 'https://example.invalid/session',
        sessionWebhookExpiredTime: 1_800_000_000_000,
        robotCode: 'robot-code',
      }),
    });
    expect(received).toMatchObject({
      platform: 'dingtalk',
      appId: 'ding-app',
      messageId: 'ding-message-1',
      chatId: 'cid-group',
      chatType: 'group',
      text: 'hello DingTalk',
      sender: { id: 'dt_staff-1', platformId: 'staff-1', name: 'Alice', type: 'user' },
    });
  });

  it('sends proactive group text through the official OpenAPI shape', async () => {
    const calls: Array<{ url: string; body?: any }> = [];
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, body: init?.body ? JSON.parse(String(init.body)) : undefined });
      return new Response(
        JSON.stringify(url.endsWith('/oauth2/accessToken')
          ? { accessToken: 'token', expireIn: 7200 }
          : { processQueryKey: 'process-1' }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }));
    const connector = new DingTalkConnector({
      appId: 'ding-app',
      clientId: 'ding-app',
      clientSecret: 'secret',
      robotCode: 'robot-code',
    });
    await expect(connector.sendMessage('cid-group', 'hello')).resolves.toBe('process-1');
    expect(calls[1]).toMatchObject({
      url: 'https://api.dingtalk.com/v1.0/robot/groupMessages/send',
      body: {
        robotCode: 'robot-code',
        openConversationId: 'cid-group',
        msgKey: 'sampleText',
      },
    });
  });
});

describe('WeCom connector', () => {
  it('verifies and decrypts callback GET/POST payloads', async () => {
    const port = await unusedPort();
    const corpId = 'ww-corp-id';
    const token = 'callback-token';
    const encodingAesKey = 'abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG';
    const connector = new WeComConnector({
      appId: 'wecom-agent',
      corpId,
      agentId: 1000002,
      secret: 'secret',
      token,
      encodingAesKey,
      callbackHost: '127.0.0.1',
      callbackPort: port,
      callbackPath: '/callback',
    });
    activeConnectors.push(connector);
    let resolveInbound!: (message: UnifiedImInboundMessage) => void;
    const inbound = new Promise<UnifiedImInboundMessage>(resolve => { resolveInbound = resolve; });
    await connector.start({ onMessage: async message => resolveInbound(message) });

    const timestamp = '1700000000';
    const nonce = 'nonce-1';
    const echoCipher = encrypt(encodingAesKey, 'verified', corpId);
    const echoSignature = getSignature(token, timestamp, nonce, echoCipher);
    const echoUrl = new URL(`http://127.0.0.1:${port}/callback`);
    echoUrl.searchParams.set('msg_signature', echoSignature);
    echoUrl.searchParams.set('timestamp', timestamp);
    echoUrl.searchParams.set('nonce', nonce);
    echoUrl.searchParams.set('echostr', echoCipher);
    const echoResponse = await fetch(echoUrl);
    expect(await echoResponse.text()).toBe('verified');

    const messageXml = [
      '<xml>',
      '<ToUserName><![CDATA[wecom-agent]]></ToUserName>',
      '<FromUserName><![CDATA[user-1]]></FromUserName>',
      '<CreateTime>1700000000</CreateTime>',
      '<MsgType><![CDATA[text]]></MsgType>',
      '<Content><![CDATA[hello WeCom]]></Content>',
      '<MsgId>message-1</MsgId>',
      '</xml>',
    ].join('');
    const messageCipher = encrypt(encodingAesKey, messageXml, corpId);
    const messageSignature = getSignature(token, timestamp, nonce, messageCipher);
    const callbackUrl = new URL(`http://127.0.0.1:${port}/callback`);
    callbackUrl.searchParams.set('msg_signature', messageSignature);
    callbackUrl.searchParams.set('timestamp', timestamp);
    callbackUrl.searchParams.set('nonce', nonce);
    const response = await fetch(callbackUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/xml' },
      body: `<xml><Encrypt><![CDATA[${messageCipher}]]></Encrypt></xml>`,
    });
    expect(await response.text()).toBe('success');
    await expect(inbound).resolves.toMatchObject({
      platform: 'wecom',
      appId: 'wecom-agent',
      messageId: 'message-1',
      chatId: 'ww_user-1',
      chatType: 'p2p',
      text: 'hello WeCom',
      sender: { id: 'ww_user-1', platformId: 'user-1', type: 'user' },
    });
  });

  it('sends direct text with the self-built application API', async () => {
    const calls: Array<{ url: string; body?: any }> = [];
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, body: init?.body ? JSON.parse(String(init.body)) : undefined });
      return new Response(
        JSON.stringify(url.includes('/gettoken')
          ? { errcode: 0, access_token: 'token', expires_in: 7200 }
          : { errcode: 0, errmsg: 'ok', msgid: 'wecom-message-1' }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }));
    const connector = new WeComConnector({
      appId: 'wecom-agent',
      corpId: 'ww-corp-id',
      agentId: 1000002,
      secret: 'secret',
      token: 'callback-token',
      encodingAesKey: 'abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG',
      callbackPort: 8788,
    });
    await expect(connector.sendMessage('ww_user-1', 'hello')).resolves.toBe('wecom-message-1');
    expect(calls[1].url).toContain('/cgi-bin/message/send?access_token=token');
    expect(calls[1].body).toMatchObject({
      touser: 'user-1',
      agentid: 1000002,
      msgtype: 'text',
      text: { content: 'hello' },
    });
  });
});
