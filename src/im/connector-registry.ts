import type { ImConnector } from './types.js';

const connectors = new Map<string, ImConnector>();

export function registerImConnector(connector: ImConnector): void {
  const existing = connectors.get(connector.appId);
  if (existing && existing !== connector) {
    throw new Error(`IM connector already registered for ${connector.appId}`);
  }
  connectors.set(connector.appId, connector);
}

export function getImConnector(appId: string): ImConnector | undefined {
  return connectors.get(appId);
}

export function requireImConnector(appId: string): ImConnector {
  const connector = connectors.get(appId);
  if (!connector) throw new Error(`No IM connector registered for ${appId}`);
  return connector;
}

export function unregisterImConnector(appId: string): void {
  connectors.delete(appId);
}

export async function stopAllImConnectors(): Promise<void> {
  const active = [...connectors.values()];
  connectors.clear();
  await Promise.allSettled(active.map(connector => connector.stop()));
}

export function __testOnly_clearImConnectors(): void {
  connectors.clear();
}
