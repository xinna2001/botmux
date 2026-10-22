/** Browser-safe policy shared by configuration validation and Worker launch. */
/** Verified app-server/remote-resume protocol; coco requires separate support. */
export const RPC_CAPABLE_CLIS = new Set(['codex', 'traex']);

export function resolveCodexRpcInput(
  cliId: string | undefined,
  botOverride: boolean | undefined | null,
  globalDefault: boolean,
  existingAppServer?: unknown,
): boolean {
  if (!cliId || !RPC_CAPABLE_CLIS.has(cliId) || existingAppServer) return false;
  return typeof botOverride === 'boolean' ? botOverride : globalDefault === true;
}

export function traexAutoModelRpcConflict(input: {
  cliId?: string;
  model?: string;
  traexAutoModel?: { enabled?: boolean } | null;
  codexRpcInput?: boolean | null;
  existingAppServer?: unknown;
}, globalDefault: boolean): boolean {
  return input.cliId === 'traex' && input.model?.trim().toLowerCase() === 'auto'
    && input.traexAutoModel?.enabled === true
    && resolveCodexRpcInput(input.cliId, input.codexRpcInput, globalDefault, input.existingAppServer);
}
