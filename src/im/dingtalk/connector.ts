import { randomUUID } from 'node:crypto';
import {
  DWClient,
  TOPIC_ROBOT,
  type DWClientDownStream,
  type RobotMessage,
} from 'dingtalk-stream';
import { logger } from '../../utils/logger.js';
import { imCapabilities } from '../capabilities.js';
import { portableMessageText } from '../content.js';
import { nativePlatformUserId, platformUserId } from '../platform.js';
import type { ImConnector, ImConnectorEventHandler, UnifiedImInboundMessage } from '../types.js';

export interface DingTalkConnectorConfig {
  appId: string;
  clientId: string;
  clientSecret: string;
  robotCode?: string;
}

interface DingTalkTarget {
  chatId: string;
  chatType: 'group' | 'p2p';
  senderId: string;
  chatName?: string;
  sessionWebhook?: string;
  sessionWebhookExpiresAt?: number;
  robotCode?: string;
}

const DINGTALK_API = 'https://api.dingtalk.com';
const MAX_TARGETS = 2_000;

export class DingTalkConnector implements ImConnector {
  readonly platform = 'dingtalk' as const;
  readonly appId: string;
  readonly capabilities = imCapabilities('dingtalk');

  private readonly config: DingTalkConnectorConfig;
  private client?: DWClient;
  private handler?: ImConnectorEventHandler;
  private accessToken?: { value: string; expiresAt: number };
  private readonly targetsByChat = new Map<string, DingTalkTarget>();
  private readonly targetsByMessage = new Map<string, DingTalkTarget>();
  private readonly seenMessages = new Map<string, number>();

  constructor(config: DingTalkConnectorConfig) {
    this.config = config;
    this.appId = config.appId;
  }

  async start(handler: ImConnectorEventHandler): Promise<void> {
    if (this.client) return;
    this.handler = handler;
    const client = new DWClient({
      clientId: this.config.clientId,
      clientSecret: this.config.clientSecret,
      keepAlive: true,
      debug: process.env.DEBUG === '1',
    });
    client.registerCallbackListener(TOPIC_ROBOT, async (event: DWClientDownStream) => {
      try {
        await this.handleRobotEvent(event);
        client.socketCallBackResponse(event.headers.messageId, { status: 'SUCCESS' });
      } catch (error) {
        logger.error(`[dingtalk:${this.appId}] inbound message failed: ${error instanceof Error ? error.message : String(error)}`);
        // No ACK: DingTalk retries this callback.
        throw error;
      }
    });
    this.client = client;
    await client.connect();
    logger.info(`[dingtalk:${this.appId}] Stream connector started`);
  }

  async stop(): Promise<void> {
    this.client?.disconnect();
    this.client = undefined;
    this.handler = undefined;
  }

  async sendMessage(chatId: string, content: string, format = 'text'): Promise<string> {
    const target = this.targetsByChat.get(chatId) ?? {
      chatId,
      chatType: chatId.startsWith('dt_') ? 'p2p' as const : 'group' as const,
      senderId: nativePlatformUserId('dingtalk', chatId),
      robotCode: this.config.robotCode,
    };
    return this.sendToTarget(target, portableMessageText(content, format));
  }

  async replyMessage(messageId: string, content: string, format = 'text'): Promise<string> {
    const target = this.targetsByMessage.get(messageId);
    if (!target) throw new Error(`DingTalk reply target ${messageId} is unknown or expired`);
    return this.sendToTarget(target, portableMessageText(content, format));
  }

  async updateMessage(_messageId: string, _content: string): Promise<void> {
    // DingTalk text messages are immutable. Final answers arrive as a separate
    // send; dropping intermediate card patches avoids flooding the chat.
  }

  async sendDirectMessage(userId: string, content: string): Promise<void> {
    await this.sendToTarget({
      chatId: platformUserId('dingtalk', userId),
      chatType: 'p2p',
      senderId: nativePlatformUserId('dingtalk', userId),
      robotCode: this.config.robotCode,
    }, portableMessageText(content));
  }

  async getChatContext(chatId: string): Promise<{
    name: string | null;
    description: string | null;
    mode: 'group' | 'p2p';
  }> {
    const target = this.targetsByChat.get(chatId);
    return {
      name: target?.chatName ?? null,
      description: null,
      mode: target?.chatType ?? (chatId.startsWith('dt_') ? 'p2p' : 'group'),
    };
  }

  private remember(key: string, value: DingTalkTarget, map: Map<string, DingTalkTarget>): void {
    if (map.has(key)) map.delete(key);
    map.set(key, value);
    while (map.size > MAX_TARGETS) {
      const oldest = map.keys().next().value as string | undefined;
      if (!oldest) break;
      map.delete(oldest);
    }
  }

  private async handleRobotEvent(event: DWClientDownStream): Promise<void> {
    if (!this.handler) return;
    let message: RobotMessage;
    try {
      message = JSON.parse(event.data) as RobotMessage;
    } catch {
      throw new Error('invalid robot callback JSON');
    }
    if (message.msgtype !== 'text' || typeof message.text?.content !== 'string') {
      logger.info(`[dingtalk:${this.appId}] ignored unsupported message type ${String(message.msgtype)}`);
      return;
    }
    const nativeSenderId = String(message.senderStaffId || message.senderId || '').trim();
    const senderId = platformUserId('dingtalk', nativeSenderId);
    const chatType = message.conversationType === '1' ? 'p2p' : 'group';
    const chatId = chatType === 'p2p'
      ? senderId
      : String(message.conversationId).trim();
    if (!message.msgId || !chatId || !senderId) throw new Error('robot callback is missing routing identity');
    if (this.seenMessages.has(message.msgId)) return;

    const target: DingTalkTarget = {
      chatId,
      chatType,
      senderId: nativeSenderId,
      chatName: (message as RobotMessage & { conversationTitle?: string }).conversationTitle?.trim() || undefined,
      sessionWebhook: message.sessionWebhook,
      sessionWebhookExpiresAt: Number(message.sessionWebhookExpiredTime) || undefined,
      robotCode: message.robotCode || this.config.robotCode,
    };
    this.remember(chatId, target, this.targetsByChat);
    this.remember(message.msgId, target, this.targetsByMessage);

    const inbound: UnifiedImInboundMessage = {
      platform: 'dingtalk',
      appId: this.appId,
      messageId: message.msgId,
      chatId,
      chatType,
      text: message.text.content.trim(),
      sender: {
        id: senderId,
        platformId: nativeSenderId,
        name: message.senderNick?.trim() || undefined,
        type: 'user',
      },
      createdAt: Number(message.createAt) || Date.now(),
      raw: message,
    };
    await this.handler.onMessage(inbound);
    this.seenMessages.set(message.msgId, Date.now());
    while (this.seenMessages.size > MAX_TARGETS) {
      const oldest = this.seenMessages.keys().next().value as string | undefined;
      if (!oldest) break;
      this.seenMessages.delete(oldest);
    }
  }

  private async getAccessToken(): Promise<string> {
    const now = Date.now();
    if (this.accessToken && this.accessToken.expiresAt > now) return this.accessToken.value;
    const response = await fetch(`${DINGTALK_API}/v1.0/oauth2/accessToken`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        appKey: this.config.clientId,
        appSecret: this.config.clientSecret,
      }),
      signal: AbortSignal.timeout(15_000),
    });
    const result = await response.json().catch(() => ({})) as Record<string, unknown>;
    const value = typeof result.accessToken === 'string' ? result.accessToken : '';
    if (!response.ok || !value) {
      throw new Error(`DingTalk token API ${response.status}: ${String(result.message ?? result.code ?? 'unknown error')}`);
    }
    const expireIn = Number(result.expireIn) || 7_200;
    this.accessToken = { value, expiresAt: now + Math.max(60, expireIn - 300) * 1_000 };
    return value;
  }

  private async post(url: string, body: unknown): Promise<Record<string, unknown>> {
    const token = await this.getAccessToken();
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-acs-dingtalk-access-token': token,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    });
    const result = await response.json().catch(() => ({})) as Record<string, unknown>;
    const code = result.code ?? result.errcode;
    if (!response.ok || (code !== undefined && code !== 0 && code !== '0')) {
      throw new Error(`DingTalk API ${response.status}: ${String(result.message ?? result.errmsg ?? code ?? 'unknown error')}`);
    }
    return result;
  }

  private async sendToTarget(target: DingTalkTarget, content: string): Promise<string> {
    const token = await this.getAccessToken();
    if (
      target.sessionWebhook
      && (!target.sessionWebhookExpiresAt || target.sessionWebhookExpiresAt > Date.now() + 5_000)
    ) {
      const response = await fetch(target.sessionWebhook, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-acs-dingtalk-access-token': token,
        },
        body: JSON.stringify({ msgtype: 'text', text: { content } }),
        signal: AbortSignal.timeout(15_000),
      });
      const result = await response.json().catch(() => ({})) as Record<string, unknown>;
      if (response.ok && (result.errcode === undefined || result.errcode === 0)) {
        const id = String(result.processQueryKey ?? result.messageId ?? `dt_${randomUUID()}`);
        this.remember(id, target, this.targetsByMessage);
        return id;
      }
      logger.warn(`[dingtalk:${this.appId}] session webhook failed; falling back to proactive API`);
    }

    const robotCode = target.robotCode || this.config.robotCode;
    if (!robotCode) throw new Error('DingTalk robotCode is required after sessionWebhook expiry');
    const result = target.chatType === 'group'
      ? await this.post(`${DINGTALK_API}/v1.0/robot/groupMessages/send`, {
          robotCode,
          openConversationId: target.chatId,
          msgKey: 'sampleText',
          msgParam: JSON.stringify({ content }),
        })
      : await this.post(`${DINGTALK_API}/v1.0/robot/oToMessages/batchSend`, {
          robotCode,
          userIds: [target.senderId],
          msgKey: 'sampleText',
          msgParam: JSON.stringify({ content }),
        });
    const id = String(result.processQueryKey ?? result.messageId ?? `dt_${randomUUID()}`);
    this.remember(id, target, this.targetsByMessage);
    return id;
  }
}
