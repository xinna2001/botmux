import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { decrypt, getSignature } from '@wecom/crypto';
import { XMLParser } from 'fast-xml-parser';
import { logger } from '../../utils/logger.js';
import { imCapabilities } from '../capabilities.js';
import { portableMessageText } from '../content.js';
import { nativePlatformUserId, platformUserId } from '../platform.js';
import type { ImConnector, ImConnectorEventHandler, UnifiedImInboundMessage } from '../types.js';

export interface WeComConnectorConfig {
  appId: string;
  corpId: string;
  agentId: number;
  secret: string;
  token: string;
  encodingAesKey: string;
  callbackHost?: string;
  callbackPort: number;
  callbackPath?: string;
}

interface WeComTarget {
  chatId: string;
  chatType: 'group' | 'p2p';
  userId: string;
}

const WECOM_API = 'https://qyapi.weixin.qq.com/cgi-bin';
const MAX_CALLBACK_BYTES = 1024 * 1024;
const MAX_TARGETS = 2_000;

const xmlParser = new XMLParser({
  ignoreAttributes: true,
  parseTagValue: false,
  trimValues: false,
  processEntities: false,
});

function secureEqual(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

function xmlRecord(xml: string): Record<string, unknown> {
  const parsed = xmlParser.parse(xml) as Record<string, unknown>;
  const root = parsed.xml;
  if (!root || typeof root !== 'object' || Array.isArray(root)) {
    throw new Error('WeCom callback XML has no <xml> root');
  }
  return root as Record<string, unknown>;
}

function stringField(record: Record<string, unknown>, name: string): string {
  const value = record[name];
  return value === undefined || value === null ? '' : String(value);
}

export class WeComConnector implements ImConnector {
  readonly platform = 'wecom' as const;
  readonly appId: string;
  readonly capabilities = imCapabilities('wecom');

  private readonly config: WeComConnectorConfig;
  private handler?: ImConnectorEventHandler;
  private server?: Server;
  private accessToken?: { value: string; expiresAt: number };
  private readonly targetsByChat = new Map<string, WeComTarget>();
  private readonly targetsByMessage = new Map<string, WeComTarget>();
  private readonly seenMessages = new Map<string, number>();

  constructor(config: WeComConnectorConfig) {
    this.config = config;
    this.appId = config.appId;
  }

  async start(handler: ImConnectorEventHandler): Promise<void> {
    if (this.server) return;
    this.handler = handler;
    const server = createServer((request, response) => {
      void this.handleHttp(request, response).catch(error => {
        logger.warn(`[wecom:${this.appId}] callback failed: ${error instanceof Error ? error.message : String(error)}`);
        if (!response.headersSent) response.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' });
        if (!response.writableEnded) response.end('invalid request');
      });
    });
    this.server = server;
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => {
        server.off('listening', onListening);
        reject(error);
      };
      const onListening = () => {
        server.off('error', onError);
        resolve();
      };
      server.once('error', onError);
      server.once('listening', onListening);
      server.listen(this.config.callbackPort, this.config.callbackHost ?? '0.0.0.0');
    });
    logger.info(
      `[wecom:${this.appId}] callback listening on `
      + `${this.config.callbackHost ?? '0.0.0.0'}:${this.config.callbackPort}${this.callbackPath()}`,
    );
  }

  async stop(): Promise<void> {
    const server = this.server;
    this.server = undefined;
    this.handler = undefined;
    if (!server) return;
    await new Promise<void>(resolve => server.close(() => resolve()));
  }

  async sendMessage(chatId: string, content: string, format = 'text'): Promise<string> {
    const target = this.targetsByChat.get(chatId) ?? {
      chatId,
      chatType: chatId.startsWith('ww_') ? 'p2p' as const : 'group' as const,
      userId: nativePlatformUserId('wecom', chatId),
    };
    return this.sendToTarget(target, portableMessageText(content, format));
  }

  async replyMessage(messageId: string, content: string, format = 'text'): Promise<string> {
    const target = this.targetsByMessage.get(messageId);
    if (!target) throw new Error(`WeCom reply target ${messageId} is unknown`);
    return this.sendToTarget(target, portableMessageText(content, format));
  }

  async updateMessage(_messageId: string, _content: string): Promise<void> {
    // Self-built application text messages are immutable. Final answers arrive
    // as a separate send; dropping card patches avoids duplicate notifications.
  }

  async sendDirectMessage(userId: string, content: string): Promise<void> {
    const nativeId = nativePlatformUserId('wecom', userId);
    await this.sendToTarget({
      chatId: platformUserId('wecom', nativeId),
      chatType: 'p2p',
      userId: nativeId,
    }, portableMessageText(content));
  }

  async getChatContext(chatId: string): Promise<{
    name: null;
    description: null;
    mode: 'group' | 'p2p';
  }> {
    const target = this.targetsByChat.get(chatId);
    return {
      name: null,
      description: null,
      mode: target?.chatType ?? (chatId.startsWith('ww_') ? 'p2p' : 'group'),
    };
  }

  private callbackPath(): string {
    const raw = this.config.callbackPath?.trim() || '/wecom/callback';
    return raw.startsWith('/') ? raw : `/${raw}`;
  }

  private remember(key: string, value: WeComTarget, map: Map<string, WeComTarget>): void {
    if (map.has(key)) map.delete(key);
    map.set(key, value);
    while (map.size > MAX_TARGETS) {
      const oldest = map.keys().next().value as string | undefined;
      if (!oldest) break;
      map.delete(oldest);
    }
  }

  private verifySignature(signature: string, timestamp: string, nonce: string, encrypted: string): void {
    const expected = getSignature(this.config.token, timestamp, nonce, encrypted);
    if (!secureEqual(signature, expected)) throw new Error('WeCom callback signature mismatch');
  }

  private decryptPayload(encrypted: string): string {
    const result = decrypt(this.config.encodingAesKey, encrypted);
    if (result.id !== this.config.corpId) {
      throw new Error('WeCom callback CorpID mismatch');
    }
    return result.message;
  }

  private async handleHttp(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = new URL(request.url ?? '/', 'http://localhost');
    if (url.pathname !== this.callbackPath()) {
      response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      response.end('not found');
      return;
    }
    const signature = url.searchParams.get('msg_signature') ?? '';
    const timestamp = url.searchParams.get('timestamp') ?? '';
    const nonce = url.searchParams.get('nonce') ?? '';

    if (request.method === 'GET') {
      const echo = url.searchParams.get('echostr') ?? '';
      if (!signature || !timestamp || !nonce || !echo) throw new Error('incomplete WeCom verification query');
      this.verifySignature(signature, timestamp, nonce, echo);
      const plaintext = this.decryptPayload(echo);
      response.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
      response.end(plaintext);
      return;
    }
    if (request.method !== 'POST') {
      response.writeHead(405, { allow: 'GET, POST' });
      response.end();
      return;
    }

    const body = await this.readBody(request);
    const envelope = xmlRecord(body);
    const encrypted = stringField(envelope, 'Encrypt');
    if (!signature || !timestamp || !nonce || !encrypted) throw new Error('incomplete encrypted WeCom callback');
    this.verifySignature(signature, timestamp, nonce, encrypted);
    const message = xmlRecord(this.decryptPayload(encrypted));

    // Acknowledge only after the turn has crossed Botmux's admission boundary.
    // The handler returns after queue/fork acceptance, not after model inference.
    await this.handleMessage(message, body);
    response.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
    response.end('success');
  }

  private readBody(request: IncomingMessage): Promise<string> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      let size = 0;
      request.on('data', (chunk: Buffer | string) => {
        const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        size += data.length;
        if (size > MAX_CALLBACK_BYTES) {
          reject(new Error('WeCom callback body exceeds 1 MiB'));
          request.destroy();
          return;
        }
        chunks.push(data);
      });
      request.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      request.on('error', reject);
    });
  }

  private async handleMessage(message: Record<string, unknown>, raw: string): Promise<void> {
    if (!this.handler) return;
    const msgType = stringField(message, 'MsgType').toLowerCase();
    if (msgType !== 'text') {
      logger.info(`[wecom:${this.appId}] ignored unsupported message type ${msgType || 'unknown'}`);
      return;
    }
    const nativeSenderId = stringField(message, 'FromUserName').trim();
    const senderId = platformUserId('wecom', nativeSenderId);
    const nativeChatId = stringField(message, 'ChatId').trim();
    const chatType: 'group' | 'p2p' = nativeChatId ? 'group' : 'p2p';
    const chatId = nativeChatId || senderId;
    const messageId = stringField(message, 'MsgId').trim()
      || `ww_${createHash('sha256').update(raw).digest('hex').slice(0, 24)}`;
    if (!senderId || !chatId) throw new Error('WeCom callback is missing sender identity');
    if (this.seenMessages.has(messageId)) return;
    this.seenMessages.set(messageId, Date.now());
    while (this.seenMessages.size > MAX_TARGETS) {
      const oldest = this.seenMessages.keys().next().value as string | undefined;
      if (!oldest) break;
      this.seenMessages.delete(oldest);
    }

    const target: WeComTarget = { chatId, chatType, userId: nativeSenderId };
    this.remember(chatId, target, this.targetsByChat);
    this.remember(messageId, target, this.targetsByMessage);
    const createTime = Number(stringField(message, 'CreateTime'));
    const inbound: UnifiedImInboundMessage = {
      platform: 'wecom',
      appId: this.appId,
      messageId,
      chatId,
      chatType,
      text: stringField(message, 'Content').trim(),
      sender: {
        id: senderId,
        platformId: nativeSenderId,
        type: 'user',
      },
      createdAt: Number.isFinite(createTime) && createTime > 0 ? createTime * 1_000 : Date.now(),
      raw: message,
    };
    try {
      await this.handler.onMessage(inbound);
    } catch (error) {
      this.seenMessages.delete(messageId);
      throw error;
    }
  }

  private async getAccessToken(): Promise<string> {
    const now = Date.now();
    if (this.accessToken && this.accessToken.expiresAt > now) return this.accessToken.value;
    const url = new URL(`${WECOM_API}/gettoken`);
    url.searchParams.set('corpid', this.config.corpId);
    url.searchParams.set('corpsecret', this.config.secret);
    const response = await fetch(url, { signal: AbortSignal.timeout(15_000) });
    const result = await response.json() as Record<string, unknown>;
    if (!response.ok || result.errcode !== 0 || typeof result.access_token !== 'string') {
      throw new Error(`WeCom token API ${response.status}: ${String(result.errmsg ?? result.errcode ?? 'unknown error')}`);
    }
    const expiresIn = Number(result.expires_in) || 7_200;
    this.accessToken = {
      value: result.access_token,
      expiresAt: now + Math.max(60, expiresIn - 300) * 1_000,
    };
    return result.access_token;
  }

  private async post(path: string, body: unknown): Promise<Record<string, unknown>> {
    const token = await this.getAccessToken();
    const url = new URL(`${WECOM_API}${path}`);
    url.searchParams.set('access_token', token);
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    });
    const result = await response.json().catch(() => ({})) as Record<string, unknown>;
    if (!response.ok || result.errcode !== 0) {
      throw new Error(`WeCom API ${response.status}: ${String(result.errmsg ?? result.errcode ?? 'unknown error')}`);
    }
    return result;
  }

  private async sendToTarget(target: WeComTarget, content: string): Promise<string> {
    const result = target.chatType === 'group'
      ? await this.post('/appchat/send', {
          chatid: target.chatId,
          msgtype: 'text',
          text: { content },
          safe: 0,
        })
      : await this.post('/message/send', {
          touser: target.userId,
          msgtype: 'text',
          agentid: this.config.agentId,
          text: { content },
          safe: 0,
          enable_duplicate_check: 1,
          duplicate_check_interval: 600,
        });
    const id = String(result.msgid ?? `ww_${randomUUID()}`);
    this.remember(id, target, this.targetsByMessage);
    return id;
  }
}
