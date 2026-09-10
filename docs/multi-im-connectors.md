# 多 IM 连接器改造说明

## 当前状态

本分支在保留飞书/Lark 原有实现的基础上，增加了钉钉 Stream 和企业微信自建应用连接器。

- 已完成类型检查、自动化测试、正式构建和自包含二进制冒烟测试。
- 尚未使用真实钉钉、企业微信开发者应用和测试群进行端到端联调。
- 当前定位为可继续联调的第一阶段实现，不应视为已经通过生产环境验收。
- 凭证只应保存在本机 `~/.botmux/bots.json`，不得提交到 Git。

## 本次改动

1. 增加统一 IM Connector 契约、平台注册表和能力矩阵。
2. 保持飞书/Lark 原有 SDK、长连接、卡片和事件分发路径不变。
3. 增加钉钉官方 `dingtalk-stream` SDK 接入：
   - Stream 模式接收单聊和群聊文本。
   - 优先使用消息携带的 `sessionWebhook` 回复。
   - Webhook 过期后使用机器人主动发送 API。
4. 增加企业微信自建应用接入：
   - HTTP GET 回调地址验证。
   - HTTP POST 签名校验和 AES 消息解密。
   - 通过自建应用消息 API 主动回复。
5. 扩展 `botmux setup add`，支持脚本化添加钉钉和企业微信机器人。
6. 非飞书平台自动使用固定工作目录，避免进入仅飞书卡片支持的仓库选择流程。
7. 非飞书平台把现有卡片降级为可读文本；不支持的消息更新、表情和附件能力安全跳过。

内部仍使用 `larkAppId` 作为 Bot 和会话数据库的稳定键，避免迁移现有数据。钉钉中该字段保存 Client ID；企业微信中可填写一个本机唯一 Bot ID。

## 能力矩阵

| 能力 | 飞书/Lark | 钉钉 Stream | 企业微信自建应用 |
| --- | --- | --- | --- |
| 文本收发 | 支持 | 支持 | 支持 |
| 单聊 | 支持 | 支持 | 支持 |
| 群聊 | 支持 | 支持 | 仅支持应用可发送的群聊 ID |
| 话题/线程 | 支持 | 不支持，映射为 chat scope | 不支持，映射为 chat scope |
| 互动卡片/按钮 | 支持 | 降级为文本 | 降级为文本 |
| 原消息更新 | 支持 | 不支持 | 不支持 |
| 表情 | 支持 | 跳过 | 跳过 |
| 附件 | 支持 | 暂未实现 | 暂未实现 |
| 是否需要公网回调 | 否 | 否 | 是，需要 HTTPS 反向代理 |

## 钉钉配置

在钉钉开放平台创建企业内部应用，添加机器人能力，选择 Stream 模式，订阅机器人消息并发布应用。

```bash
botmux setup add \
  --platform dingtalk \
  --app-id "$DINGTALK_CLIENT_ID" \
  --app-secret "$DINGTALK_CLIENT_SECRET" \
  --robot-code "$DINGTALK_ROBOT_CODE" \
  --allowed-users "dt_$DINGTALK_OWNER_STAFF_ID" \
  --default-working-dir "$HOME/projects"
```

## 企业微信配置

在企业微信管理后台创建自建应用并配置接收消息。回调监听端口需要通过 HTTPS 反向代理暴露，只转发配置的回调路径。

```bash
botmux setup add \
  --platform wecom \
  --app-id "wecom-agent-1000002" \
  --app-secret "$WECOM_APP_SECRET" \
  --corp-id "$WECOM_CORP_ID" \
  --agent-id "1000002" \
  --callback-token "$WECOM_CALLBACK_TOKEN" \
  --encoding-aes-key "$WECOM_ENCODING_AES_KEY" \
  --callback-host "127.0.0.1" \
  --callback-port "8788" \
  --callback-path "/wecom/callback" \
  --allowed-users "ww_$WECOM_OWNER_USER_ID" \
  --default-working-dir "$HOME/projects"
```

平台回调地址示例：`https://bot.example.com/wecom/callback`。

## 后续真机验证

取得真实开发者应用后，建议按以下顺序验证：

1. 各平台先发送一条私聊文本，确认只创建一个会话。
2. Agent 使用 `botmux send --mention-back` 回复，确认用户收到一次且无重复。
3. 再验证群聊文本、重连、重复事件去重和主动发送。
4. 钉钉等待 `sessionWebhook` 过期后，验证主动发送 API 回退。
5. 企业微信验证公网 HTTPS、回调 URL 校验、签名错误拒绝和应用可见范围。
6. 最后再扩展图片、文件、原生卡片和平台级群成员能力。

## 已知边界

- 飞书文档、会议、团队名册、卡片操作、附件和表情能力尚未抽象到其他平台。
- 企业微信普通客户群并不是通用双向 Bot 表面；群发送依赖企业应用可访问的群聊 ID。
- 暂未建立跨平台 Bot 身份与 `@` 映射。
- 真机验证前不要把本分支替换为当前正在使用的全局 Botmux 二进制。
