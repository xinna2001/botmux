import type { ImCapabilities, ImPlatform } from './types.js';

export const IM_CAPABILITY_MATRIX: Readonly<Record<ImPlatform, ImCapabilities>> = {
  feishu: {
    receiveText: true,
    sendText: true,
    reply: true,
    updateMessage: true,
    cards: true,
    cardActions: true,
    reactions: true,
    files: true,
    threads: true,
    proactiveMessages: true,
  },
  lark: {
    receiveText: true,
    sendText: true,
    reply: true,
    updateMessage: true,
    cards: true,
    cardActions: true,
    reactions: true,
    files: true,
    threads: true,
    proactiveMessages: true,
  },
  dingtalk: {
    receiveText: true,
    sendText: true,
    reply: true,
    updateMessage: false,
    cards: false,
    cardActions: false,
    reactions: false,
    files: false,
    threads: false,
    proactiveMessages: true,
  },
  wecom: {
    receiveText: true,
    sendText: true,
    reply: true,
    updateMessage: false,
    cards: false,
    cardActions: false,
    reactions: false,
    files: false,
    threads: false,
    proactiveMessages: true,
  },
};

export function imCapabilities(platform: ImPlatform): ImCapabilities {
  return IM_CAPABILITY_MATRIX[platform];
}
