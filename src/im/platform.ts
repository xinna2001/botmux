import type { ImPlatform } from './types.js';

export interface PlatformTaggedConfig {
  platform?: ImPlatform;
  brand?: 'feishu' | 'lark';
}

export function resolveImPlatform(config: PlatformTaggedConfig): ImPlatform {
  if (config.platform) return config.platform;
  return config.brand === 'lark' ? 'lark' : 'feishu';
}

export function isLarkPlatform(config: PlatformTaggedConfig): boolean {
  const platform = resolveImPlatform(config);
  return platform === 'feishu' || platform === 'lark';
}

export function platformUserId(platform: ImPlatform, nativeId: string): string {
  const id = nativeId.trim();
  if (!id) return '';
  if (platform === 'dingtalk') return id.startsWith('dt_') ? id : `dt_${id}`;
  if (platform === 'wecom') return id.startsWith('ww_') ? id : `ww_${id}`;
  return id;
}

export function nativePlatformUserId(platform: ImPlatform, id: string): string {
  if (platform === 'dingtalk' && id.startsWith('dt_')) return id.slice(3);
  if (platform === 'wecom' && id.startsWith('ww_')) return id.slice(3);
  return id;
}
