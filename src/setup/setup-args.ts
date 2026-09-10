/**
 * `botmux setup <list|add|configure|edit|remove>` 非 TUI（脚本化）模式：argv 解析 + 纯映射。
 *
 * 动机：给 coding agent / 脚本一个**字段级**的稳定接口。以前脚本化 setup 只能
 * 对交互问答「管道喂数字」，TUI 问题序列一变（比如新增一问）答案就静默错位；
 * flag 形式不依赖问题顺序，天然稳定。
 *
 * 本模块保持纯函数（不碰 fs / 网络 / process），可单测；目录存在性校验、
 * 凭证校验（tenant_access_token）、bots.json 读写等副作用留在 cli.ts 执行层。
 */
import {
  applyBotConfigEdits,
  assertOwnerWhenChatGroups,
  hasOwnerEntry,
  type BotConfigEditInput,
} from './bot-config-editor.js';
import { CLI_SELECT_OPTIONS, CLI_SELECTION_ALIASES, resolveCliSelection } from './cli-selection.js';
import type { CliRuntimeConfig } from '../adapters/cli/runtime.js';

/** add / edit 共用的 bot 字段 flag（原始字符串，'-' 表示清空，语义同 TUI 编辑）。 */
export interface SetupBotFlags {
  /** IM transport. Missing keeps the historical Feishu default. */
  platform?: string;
  name?: string;
  /** 仅 add --create-app：飞书开放平台应用名称；留空由执行层生成 botmux-N。 */
  appName?: string;
  appId?: string;
  appSecret?: string;
  /** CLI 选择键：cliId 或网关键（aiden-x-claude / ttadk-x-codex …），见 CLI_SELECT_OPTIONS。 */
  cli?: string;
  cliPath?: string;
  /** JSON CliRuntimeConfig, or '-' to clear it. */
  cliRuntime?: string;
  wrapperCli?: string;
  model?: string;
  backend?: string;
  /** 仓库选择卡片的扫描根目录（逗号分隔多个）。 */
  workingDir?: string;
  /** 固定默认目录：新话题直接在此目录启动、不弹仓库选择卡片；'-' 清空回弹卡模式。 */
  defaultWorkingDir?: string;
  allowedUsers?: string;
  allowedChatGroups?: string;
  showInTeam?: string;
  /** 仅 add：feishu | lark。 */
  brand?: string;
  /** DingTalk robot code, required for proactive messages. */
  robotCode?: string;
  /** WeCom enterprise id. */
  corpId?: string;
  /** WeCom self-built application AgentId. */
  agentId?: string;
  /** WeCom callback Token. */
  callbackToken?: string;
  /** WeCom callback EncodingAESKey. */
  encodingAesKey?: string;
  callbackHost?: string;
  callbackPort?: string;
  callbackPath?: string;
}

export type SetupCommand =
  | { action: 'help' }
  | { action: 'list'; json: boolean }
  | { action: 'add'; json: boolean; createApp: boolean; compatibilityMode: boolean; switchAccount: boolean; openPlatformAuto: boolean; flags: SetupBotFlags }
  | { action: 'configure'; json: boolean; selector: string; switchAccount: boolean }
  | { action: 'edit'; json: boolean; selector: string; flags: SetupBotFlags }
  | { action: 'remove'; json: boolean; selector: string; yes: boolean };

/**
 * `botmux setup` 后面第一个参数是否触发脚本化模式：任何**非 flag** 首参数都算
 * （未知子命令由 parseSetupCommand 报错，而不是掉进交互 TUI 把脚本挂住）。
 * 空参数 / 纯 flag（如 --no-open-platform-auto）仍走原交互 TUI，保持向后兼容。
 */
export function isScriptedSetupInvocation(argv: string[]): boolean {
  const first = argv[0];
  if (first === undefined) return false;
  if (first === '--help' || first === '-h') return true;
  return !first.startsWith('-');
}

const BOT_FIELD_FLAGS: Record<string, keyof SetupBotFlags> = {
  '--platform': 'platform',
  '--name': 'name',
  '--app-name': 'appName',
  '--app-id': 'appId',
  '--app-secret': 'appSecret',
  '--cli': 'cli',
  '--cli-path': 'cliPath',
  '--cli-runtime': 'cliRuntime',
  '--wrapper-cli': 'wrapperCli',
  '--model': 'model',
  '--backend': 'backend',
  '--working-dir': 'workingDir',
  '--default-working-dir': 'defaultWorkingDir',
  '--allowed-users': 'allowedUsers',
  '--allowed-chat-groups': 'allowedChatGroups',
  '--show-in-team': 'showInTeam',
  '--brand': 'brand',
  '--robot-code': 'robotCode',
  '--corp-id': 'corpId',
  '--agent-id': 'agentId',
  '--callback-token': 'callbackToken',
  '--encoding-aes-key': 'encodingAesKey',
  '--callback-host': 'callbackHost',
  '--callback-port': 'callbackPort',
  '--callback-path': 'callbackPath',
};

export const SETUP_CLI_USAGE = `botmux setup — 脚本化（非 TUI）用法

  botmux setup list [--json]
      列出已配置机器人（--json 输出完整字段，secret 脱敏）。

  botmux setup add --create-app --allowed-users <owner> [--app-name <name>] [选项]
      首次扫码创建飞书应用；后续有效登录态下确认账号/企业后免扫码添加。
      --app-name 留空自动使用 botmux-N；更换账号用 --switch-account。
      owner 请用完整邮箱、手机号或 union_id on_xxx；新应用尚不存在，不能
      预先拥有可用的 open_id ou_xxx。managed Agent 若传入 daemon 注入的
      当前 session owner，会由来源应用转换为 on_。
      默认继续完成权限、长连接事件、redirect 与发版；可用
      --no-open-platform-auto 跳过后半段自动配置。

  botmux setup add --create-app --compatibility-mode --allowed-users <owner> [选项]
      显式使用官方 SDK 兼容模式，可能需要额外扫码。兼容模式不支持
      --app-name，应用名称由平台决定。

  botmux setup add --app-id <cli_xxx> --app-secret <secret> --allowed-users <owner> [选项]
      使用已有凭证添加机器人。必填：--app-id / --app-secret / --allowed-users。
      owner 可用完整邮箱、手机号、union_id on_xxx，或该应用自己签发的
      open_id ou_xxx；写盘前会用凭证校验，失败不写盘。

  botmux setup add --platform dingtalk --app-id <ClientID> --app-secret <ClientSecret>
      --robot-code <RobotCode> --allowed-users <dt_staffId> [选项]
      添加钉钉企业内部应用机器人，使用 Stream 模式收消息。

  botmux setup add --platform wecom --app-id <本地唯一ID> --app-secret <Secret>
      --corp-id <CorpID> --agent-id <AgentId> --callback-token <Token>
      --encoding-aes-key <43字符Key> --callback-port <port>
      --allowed-users <ww_UserID> [选项]
      添加企业微信自建应用；回调路径默认 /wecom/callback，需要公网 HTTPS 反代。

  botmux setup configure <进程名|AppID> [--switch-account] [--json]
      对已添加的机器人重跑开放平台权限、长连接事件、redirect 与发版。
      用于 add 返回 partial 后继续，不会重复创建应用；成功后自动尝试上线。
      登录账号不对时加 --switch-account 明确重新扫码。

  botmux setup edit <进程名|AppID> [字段选项...]
      按字段修改机器人（如 botmux setup edit botmux-0 --cli codex）。
      至少给一个字段选项；值传 - 表示清空该字段。

  botmux setup remove <进程名|AppID> --yes
      删除机器人（非交互删除必须显式 --yes 确认）。

字段选项（add / edit 通用；edit 中未给出的字段保持不变）：
  --name <n>                 botmux status 显示名（进程名后缀）
  --app-name <n>             新建的飞书应用名称（仅 add --create-app）
  --app-id <cli_xxx>         飞书应用 App ID（edit 时改绑另一个应用）
  --app-secret <secret>      App Secret
  --cli <key>                CLI 适配器：cliId 或网关键（claude-code / codex /
                             traecli / aiden-x-claude / ttadk-x-codex …；
                             traecli 映射到 TRAE CLI 2.0（内部 cliId=traex）
  --cli-path <path>          CLI 可执行文件路径覆盖
  --cli-runtime <JSON|->     Codex-compatible runtime 描述；JSON 含 id、
                             displayName、executable、update，传 - 清空
  --wrapper-cli <prefix>     通用启动前缀（如 "aiden x claude"），覆盖 --cli 推导值
  --model <m>                CLI 模型名
  --backend <b>              会话后端 pty | tmux | herdr | zellij | zmx
                             traex + herdr 插件安装需在 Dashboard Settings 中显式开启并填写可信 source/ref
  --working-dir <dirs>       仓库选择卡片的扫描根目录（逗号分隔多个）
  --default-working-dir <d>  固定默认目录：新话题直接在此目录启动、不弹仓库
                             选择卡片；传 - 清空、回到弹卡模式
  --allowed-users <a,b>      管理员名单（推荐完整邮箱 / 手机号 / on_xxx；
                             ou_xxx 仅限已有目标应用自身，勿跨 Bot 复制）
  --allowed-chat-groups <g>  可对话群 chat_id（oc_xxx，逗号分隔）
  --show-in-team <bool>      平台团队页是否展示（默认 true）
  --brand <feishu|lark>      租户类型（仅 add）
  --platform <platform>      IM 平台：feishu | lark | dingtalk | wecom
  --robot-code <code>        钉钉机器人 RobotCode
  --corp-id <id>             企业微信 CorpID
  --agent-id <id>            企业微信自建应用 AgentId
  --callback-token <token>   企业微信回调 Token
  --encoding-aes-key <key>   企业微信回调 EncodingAESKey（43 字符）
  --callback-host <host>     企业微信回调监听地址（默认 0.0.0.0）
  --callback-port <port>     企业微信回调监听端口
  --callback-path <path>     企业微信回调路径（默认 /wecom/callback）

通用选项：
  --json                     输出机器可读 JSON（含 ok / error 字段）
  --create-app               add 时扫码创建应用，不再要求 --app-id/--app-secret
  --compatibility-mode       显式使用 SDK 兼容模式（可能需要额外扫码）
  --switch-account           add --create-app / configure 时重新扫码并覆盖登录态
  --open-platform-auto       add 成功后执行开放平台自动配置（默认跳过；
                             --create-app 时默认开启）
  --no-open-platform-auto    跳过开放平台权限/发版自动配置
`;

function parseBotFieldFlags(
  tokens: string[],
  opts: { allowFields: boolean; action: string },
): { flags: SetupBotFlags; json: boolean; yes: boolean; createApp: boolean; compatibilityMode: boolean; switchAccount: boolean; openPlatformAuto: boolean; openPlatformAutoSpecified: boolean; positional: string[] } {
  const flags: SetupBotFlags = {};
  const positional: string[] = [];
  let json = false;
  let yes = false;
  let createApp = false;
  let compatibilityMode = false;
  let switchAccount = false;
  let openPlatformAuto = false;
  let openPlatformAutoSpecified = false;

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (token === '--json') { json = true; continue; }
    if (token === '--yes' || token === '-y') { yes = true; continue; }
    if (token === '--create-app') { createApp = true; continue; }
    if (token === '--compatibility-mode') { compatibilityMode = true; continue; }
    if (token === '--switch-account') { switchAccount = true; continue; }
    if (token === '--open-platform-auto') { openPlatformAuto = true; openPlatformAutoSpecified = true; continue; }
    if (token === '--no-open-platform-auto') { openPlatformAuto = false; openPlatformAutoSpecified = true; continue; }

    if (token.startsWith('--')) {
      const eq = token.indexOf('=');
      const flag = eq >= 0 ? token.slice(0, eq) : token;
      const field = BOT_FIELD_FLAGS[flag];
      if (!field) {
        throw new Error(`未知参数 ${flag}。查看用法：botmux setup help`);
      }
      if (!opts.allowFields) {
        throw new Error(`${opts.action} 不接受字段参数 ${flag}。查看用法：botmux setup help`);
      }
      let value: string;
      if (eq >= 0) {
        value = token.slice(eq + 1);
      } else {
        const next = tokens[i + 1];
        // '-' 是合法的清空值；以 '--' 开头的下一个 token 视为漏填了取值。
        if (next === undefined || next.startsWith('--')) {
          throw new Error(`${flag} 缺少取值。查看用法：botmux setup help`);
        }
        value = next;
        i++;
      }
      flags[field] = value;
      continue;
    }
    positional.push(token);
  }
  return { flags, json, yes, createApp, compatibilityMode, switchAccount, openPlatformAuto, openPlatformAutoSpecified, positional };
}

/** Parse only the JSON envelope here; structural validation remains centralized
 * in applyBotConfigEdits -> normalizeCliRuntimeConfig so add/edit/TUI callers
 * cannot drift onto different runtime rules. */
function parseCliRuntimeFlag(raw: string | undefined): CliRuntimeConfig | null | undefined {
  if (raw === undefined) return undefined;
  const value = raw.trim();
  if (value === '-') return null;
  if (!value) throw new Error('--cli-runtime 必须是 JSON 对象或 -');
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch (err) {
    throw new Error(`--cli-runtime 不是合法 JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
  return parsed as CliRuntimeConfig;
}

/** 解析 `botmux setup` 的脚本化子命令 argv。非法输入抛 Error（message 面向用户）。 */
export function parseSetupCommand(argv: string[]): SetupCommand {
  const [action, ...rest] = argv;
  if (action === 'help' || action === '--help' || action === '-h') return { action: 'help' };

  if (action === 'list') {
    const { json, switchAccount, positional } = parseBotFieldFlags(rest, { allowFields: false, action: 'list' });
    if (switchAccount) throw new Error('--switch-account 仅适用于 add --create-app 或 configure。');
    if (positional.length > 0) throw new Error(`list 不接受多余参数: ${positional.join(' ')}`);
    return { action: 'list', json };
  }

  if (action === 'add') {
    const { flags, json, createApp, compatibilityMode, switchAccount, openPlatformAuto, openPlatformAutoSpecified, positional } = parseBotFieldFlags(rest, { allowFields: true, action: 'add' });
    if (positional.length > 0) throw new Error(`add 不接受位置参数: ${positional.join(' ')}（字段一律用 --flag 形式）`);
    if (createApp && (flags.appId?.trim() || flags.appSecret?.trim())) {
      throw new Error('--create-app 不能与 --app-id/--app-secret 同时使用。');
    }
    if (!createApp && flags.appName !== undefined) {
      throw new Error('--app-name 必须与 add --create-app 一起使用。');
    }
    if (compatibilityMode && !createApp) {
      throw new Error('--compatibility-mode 必须与 add --create-app 一起使用。');
    }
    if (switchAccount && !createApp) {
      throw new Error('--switch-account 必须与 add --create-app 一起使用。');
    }
    if (switchAccount && compatibilityMode) {
      throw new Error('--switch-account 不适用于 SDK 兼容模式。');
    }
    if (compatibilityMode && flags.appName?.trim()) {
      throw new Error('兼容模式不支持 --app-name；请移除该参数，应用名称将由平台决定。');
    }
    const platform = flags.platform?.trim().toLowerCase();
    if (createApp && platform && platform !== 'feishu' && platform !== 'lark') {
      throw new Error('--create-app 仅支持 feishu/lark；钉钉和企业微信请使用已有应用凭证。');
    }
    if (openPlatformAutoSpecified && platform && platform !== 'feishu' && platform !== 'lark') {
      throw new Error('--open-platform-auto 仅支持 feishu/lark。');
    }
    return {
      action: 'add',
      json,
      createApp,
      compatibilityMode,
      switchAccount,
      openPlatformAuto: openPlatformAutoSpecified ? openPlatformAuto : createApp,
      flags,
    };
  }

  if (action === 'configure') {
    const {
      json,
      yes,
      createApp,
      compatibilityMode,
      switchAccount,
      openPlatformAutoSpecified,
      positional,
    } = parseBotFieldFlags(rest, { allowFields: false, action: 'configure' });
    if (yes || createApp || compatibilityMode || openPlatformAutoSpecified) {
      throw new Error('configure 只接受机器人标识、--switch-account 和 --json。查看用法：botmux setup help');
    }
    if (positional.length === 0) throw new Error('configure 需要指定机器人（进程名 botmux-N 或 AppID）。');
    if (positional.length > 1) throw new Error(`configure 只接受一个机器人标识: ${positional.join(' ')}`);
    return { action: 'configure', json, selector: positional[0], switchAccount };
  }

  if (action === 'edit') {
    const { flags, json, switchAccount, positional } = parseBotFieldFlags(rest, { allowFields: true, action: 'edit' });
    if (switchAccount) throw new Error('--switch-account 仅适用于 add --create-app 或 configure。');
    if (positional.length === 0) throw new Error('edit 需要指定机器人（进程名 botmux-N 或 AppID）。');
    if (positional.length > 1) throw new Error(`edit 只接受一个机器人标识: ${positional.join(' ')}`);
    return { action: 'edit', json, selector: positional[0], flags };
  }

  if (action === 'remove') {
    const { json, yes, switchAccount, positional } = parseBotFieldFlags(rest, { allowFields: false, action: 'remove' });
    if (switchAccount) throw new Error('--switch-account 仅适用于 add --create-app 或 configure。');
    if (positional.length === 0) throw new Error('remove 需要指定机器人（进程名 botmux-N 或 AppID）。');
    if (positional.length > 1) throw new Error(`remove 只接受一个机器人标识: ${positional.join(' ')}`);
    return { action: 'remove', json, selector: positional[0], yes };
  }

  throw new Error(`未知 setup 子命令 "${action}"。查看用法：botmux setup help`);
}

/**
 * add flags → 可落盘 bot 对象（纯映射，不做目录存在性 / 凭证校验）。
 * 必填缺失、CLI 选择键非法、owner 缺失等一律抛 Error。
 */
export function buildBotFromAddFlags(flags: SetupBotFlags): Record<string, any> {
  const missing: string[] = [];
  if (!flags.appId?.trim()) missing.push('--app-id');
  if (!flags.appSecret?.trim()) missing.push('--app-secret');
  if (!flags.allowedUsers?.trim()) missing.push('--allowed-users');
  if (missing.length > 0) throw new Error(`add 缺少必填参数: ${missing.join(' ')}`);

  const explicitBrand = flags.brand?.trim().toLowerCase();
  if (explicitBrand !== undefined && explicitBrand !== 'feishu' && explicitBrand !== 'lark') {
    throw new Error(`--brand 必须是 feishu 或 lark: ${flags.brand}`);
  }
  const platform = (flags.platform ?? explicitBrand ?? 'feishu').trim().toLowerCase();
  if (!['feishu', 'lark', 'dingtalk', 'wecom'].includes(platform)) {
    throw new Error(`--platform 必须是 feishu、lark、dingtalk 或 wecom: ${flags.platform}`);
  }
  const brand = explicitBrand ?? (platform === 'lark' ? 'lark' : 'feishu');
  if (brand !== 'feishu' && brand !== 'lark') {
    throw new Error(`--brand 必须是 feishu 或 lark: ${flags.brand}`);
  }
  if ((platform === 'dingtalk' || platform === 'wecom') && flags.brand !== undefined) {
    throw new Error('--brand 仅适用于 feishu/lark。');
  }
  if ((platform === 'feishu' || platform === 'lark') && flags.brand !== undefined && brand !== platform) {
    throw new Error('--platform 与 --brand 指向了不同的飞书区域。');
  }

  const sel = resolveCliSelection((flags.cli ?? 'claude-code').trim());
  const base: Record<string, any> = {
    larkAppId: flags.appId!.trim(),
    larkAppSecret: flags.appSecret!.trim(),
    cliId: sel.cliId,
    ...(sel.wrapperCli ? { wrapperCli: sel.wrapperCli } : {}),
    ...(platform === 'dingtalk' || platform === 'wecom' ? { platform } : {}),
    // 与 TUI 同口径：feishu 不落 brand 字段，bots.json 保持干净。
    ...(platform === 'lark' || brand === 'lark' ? { brand: 'lark' } : {}),
  };
  if (platform === 'dingtalk') {
    const robotCode = flags.robotCode?.trim();
    if (!robotCode) throw new Error('dingtalk 缺少必填参数: --robot-code');
    base.dingtalk = { robotCode };
  }
  if (platform === 'wecom') {
    const missingWeCom: string[] = [];
    if (!flags.corpId?.trim()) missingWeCom.push('--corp-id');
    if (!flags.agentId?.trim()) missingWeCom.push('--agent-id');
    if (!flags.callbackToken?.trim()) missingWeCom.push('--callback-token');
    if (!flags.encodingAesKey?.trim()) missingWeCom.push('--encoding-aes-key');
    if (!flags.callbackPort?.trim()) missingWeCom.push('--callback-port');
    if (missingWeCom.length > 0) {
      throw new Error(`wecom 缺少必填参数: ${missingWeCom.join(' ')}`);
    }
    const agentId = Number(flags.agentId);
    const callbackPort = Number(flags.callbackPort);
    if (!Number.isInteger(agentId) || agentId <= 0) {
      throw new Error('--agent-id 必须是正整数');
    }
    if (!Number.isInteger(callbackPort) || callbackPort < 1 || callbackPort > 65535) {
      throw new Error('--callback-port 必须是 1-65535 的整数');
    }
    if (flags.encodingAesKey!.trim().length !== 43) {
      throw new Error('--encoding-aes-key 必须正好 43 个字符');
    }
    base.wecom = {
      corpId: flags.corpId!.trim(),
      agentId,
      token: flags.callbackToken!.trim(),
      encodingAesKey: flags.encodingAesKey!.trim(),
      callbackPort,
      ...(flags.callbackHost?.trim() ? { callbackHost: flags.callbackHost.trim() } : {}),
      ...(flags.callbackPath?.trim() ? { callbackPath: flags.callbackPath.trim() } : {}),
    };
  }

  const externalPlatform = platform === 'dingtalk' || platform === 'wecom';
  const externalDefaultWorkingDir = externalPlatform
    ? flags.defaultWorkingDir ?? flags.workingDir?.split(',')[0]?.trim() ?? '~'
    : flags.defaultWorkingDir;
  if (externalPlatform && externalDefaultWorkingDir === '-') {
    throw new Error(`${platform} 当前不支持仓库选择卡片，--default-working-dir 不能清空`);
  }
  const input: BotConfigEditInput = {
    name: flags.name,
    cliRuntime: parseCliRuntimeFlag(flags.cliRuntime),
    cliPathOverride: flags.cliPath,
    model: flags.model,
    backendType: flags.backend,
    // 固定默认目录模式（只给 --default-working-dir）不强写 workingDir，
    // 扫描根回退默认 ~；其余情况与 TUI 一致，总是落 workingDir（留空 → '~'）。
    workingDir: flags.workingDir ?? (externalDefaultWorkingDir ? undefined : '~'),
    defaultWorkingDir: externalDefaultWorkingDir,
    allowedUsers: flags.allowedUsers,
    allowedChatGroups: flags.allowedChatGroups,
    showInTeam: flags.showInTeam,
    // 显式 --wrapper-cli 覆盖 --cli 推导出的前缀（undefined 时不动 base 里的值）。
    wrapperCli: flags.wrapperCli,
  };
  const bot = applyBotConfigEdits(base, input);
  if (!hasOwnerEntry(bot.allowedUsers)) {
    throw new Error('--allowed-users 至少需要一个完整邮箱、手机号、飞书身份 ID，或平台用户 ID（dt_xxx / ww_xxx）作为 owner。');
  }
  assertOwnerWhenChatGroups(bot);
  return bot;
}

/**
 * edit flags → BotConfigEditInput（纯映射）。--cli 走 resolveCliSelection：
 * 选普通 CLI 会清掉旧 wrapperCli（与 TUI 一致），显式 --wrapper-cli 再覆盖。
 */
export function editInputFromFlags(flags: SetupBotFlags): BotConfigEditInput {
  if (flags.appName !== undefined) {
    throw new Error('--app-name 仅与 add --create-app 一起使用。');
  }
  if (flags.brand !== undefined) {
    throw new Error('--brand 仅在 add 时可指定（brand 绑定租户域名，换租户请 remove 后重新 add）。');
  }
  const platformOnlyFlags: Array<[keyof SetupBotFlags, string]> = [
    ['platform', '--platform'],
    ['robotCode', '--robot-code'],
    ['corpId', '--corp-id'],
    ['agentId', '--agent-id'],
    ['callbackToken', '--callback-token'],
    ['encodingAesKey', '--encoding-aes-key'],
    ['callbackHost', '--callback-host'],
    ['callbackPort', '--callback-port'],
    ['callbackPath', '--callback-path'],
  ];
  const unsupported = platformOnlyFlags.find(([key]) => flags[key] !== undefined);
  if (unsupported) {
    throw new Error(`${unsupported[1]} 仅在 add 时可指定；切换 IM 平台请 remove 后重新 add。`);
  }
  const input: BotConfigEditInput = {};
  if (flags.name !== undefined) input.name = flags.name;
  if (flags.appId !== undefined) input.larkAppId = flags.appId;
  if (flags.appSecret !== undefined) input.larkAppSecret = flags.appSecret;
  if (flags.cli !== undefined) {
    const sel = resolveCliSelection(flags.cli.trim());
    input.cliChoice = sel.cliId;
    input.wrapperCli = sel.wrapperCli ?? null;
    // An explicit CLI selection means its built-in/wrapper distribution.
    // `--cli-runtime` below can replace this null with a custom descriptor.
    input.cliRuntime = null;
  }
  if (flags.wrapperCli !== undefined) input.wrapperCli = flags.wrapperCli;
  if (flags.cliRuntime !== undefined) input.cliRuntime = parseCliRuntimeFlag(flags.cliRuntime);
  if (flags.cliPath !== undefined) input.cliPathOverride = flags.cliPath;
  if (flags.model !== undefined) input.model = flags.model;
  if (flags.backend !== undefined) input.backendType = flags.backend;
  if (flags.workingDir !== undefined) input.workingDir = flags.workingDir;
  if (flags.defaultWorkingDir !== undefined) input.defaultWorkingDir = flags.defaultWorkingDir;
  if (flags.allowedUsers !== undefined) input.allowedUsers = flags.allowedUsers;
  if (flags.allowedChatGroups !== undefined) input.allowedChatGroups = flags.allowedChatGroups;
  if (flags.showInTeam !== undefined) input.showInTeam = flags.showInTeam;
  return input;
}

/** 合法 --cli 取值（报错提示用）。 */
export function cliSelectionKeys(): string[] {
  return [...CLI_SELECT_OPTIONS.map(o => o.key), ...Object.keys(CLI_SELECTION_ALIASES)];
}

/** list --json 输出前的 secret 脱敏（CLI 输出可能被贴进聊天/日志）。 */
export function maskAppSecret(secret: unknown): string {
  if (typeof secret !== 'string' || !secret) return '';
  if (secret.length <= 8) return '••••';
  return `${secret.slice(0, 4)}••••${secret.slice(-4)}`;
}
