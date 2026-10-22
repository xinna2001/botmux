# TraeX 自动模型切换测试说明

测试分支：[`xinna2001/botmux` 的 `feat/traex-auto-model-testing`](https://github.com/xinna2001/botmux/tree/feat/traex-auto-model-testing)。

本分支基于官方 `master` 的 `5af1d2e8`，包含自动模型切换及 macOS Skill 快照打开标志修复。功能默认关闭，仅支持 Botmux 直接管理的本地 TraeX 终端会话。完整策略见[设计说明](design/2026-10-21-traex-auto-model.md)。

## 获取与运行

需要 Node.js 22+、Bun 1.4.3、已登录的 TraeX CLI；使用 tmux 后端时还需要 tmux。

```bash
git clone --branch feat/traex-auto-model-testing --single-branch \
  https://github.com/xinna2001/botmux.git botmux-auto-model-test
cd botmux-auto-model-test
bun install --frozen-lockfile
bun run build
```

在已有 Botmux 测试环境切到这份源码：

```bash
bun run use:here
bun run daemon:restart
```

首次使用 Botmux 的同学先按仓库 [README](../README.md) 完成初始化，再运行本分支。运行后从 Dashboard 进入 Bot 配置 → 选择 TraeX Bot → 常用 → Agent 配置，打开「实验功能：自动模型切换」，按偏好顺序添加模型并点击「保存并生效」。新话题加载新配置；已有话题可在空闲时 `/restart` 加载。

页面作用说明为「模型排队时，自动切换到模型池中其他不排队的模型。」；详细策略在旁边问号提示中。「话题内每轮重新择优」默认关闭。

若页面提示 daemon PATH 找不到 `traex`，先在运行 Botmux 的机器执行 `command -v traex`。终端能找到而页面提示缺失，说明后台进程的 PATH 与终端不同；将实际可执行文件所在目录加入服务启动 PATH，再重启核验。自动模型功能没有安装或卸载 TraeX，也没有改动 CLI 可用性检测逻辑。

## 人工验证

| 操作 | 预期结果 |
| --- | --- |
| 不开启实验功能 | 保持原有手动选模型行为 |
| 添加至少五个模型，调整顺序、思考强度与上下文 | 模型池无数量上限，各模型保存独立档位 |
| 打开启用、编辑模型池但不保存，刷新页面 | 开关按服务端已保存配置显示；原来关闭的开关恢复关闭 |
| 刷新后重新打开实验开关 | 模型顺序、各模型档位、阈值及话题内重新择优偏好恢复 |
| 保存启用后刷新 | 开关保持启用，正式配置保留 |
| 取消勾选并保存关闭，再刷新、重新打开 | 刷新后保持关闭，重新打开仍保留模型池偏好 |
| 开新话题，首选模型可用 | 从模型池第一项开始；卡片显示实际模型 |
| 当前模型持续容量排队超过配置阈值，默认 30 秒 | 按顺序检查后续模型，不使用池外模型 |
| 第二项负载 100%，第三项负载更低 | 优先尝试第二项 |
| 已选备选实际也排队 | 短暂确认后检查下一项，不为每个备选再等完整 30 秒 |
| 后续模型都拥挤或模型池耗尽 | 选择完整快照中的池内最低负载模型，随后保持等待 |
| 关闭「话题内每轮重新择优」，同话题再发输入 | 保持已选模型；最终等待状态也保留 |
| 开启「话题内每轮重新择优」，同话题再发输入 | 新回合重新从首选开始 |
| 切换后查看原生会话与输入记录 | 续接同一个原生会话 ID；原始问题只提交一次 |
| 自动切换恢复时查看 Skill 目录 | 未变 Botmux Skill 目录不再重复交付；目录变化仍交付 |
| 关闭模型下拉菜单 | 悬浮滚动条随菜单消失 |

真实排队与负载由服务决定，人工测试未遇到的场景可用下述隔离测试验证。TraeX 自身在恢复时追加的原生 developer 说明仍由 CLI 管理；不能据此判断每次都是新话题。模型切换共享可见历史，无法迁移未写入历史的内部思考。

## 隔离回归

以下 Worker 测试使用模拟 TraeX CLI，验证真实 Worker、输入队列、PTY 与原生会话恢复流程，不发真实模型推理请求：

```bash
bun run test -- test/traex-auto-model.test.ts \
  test/traex-auto-model-settings.test.ts \
  test/traex-auto-model-preferences.test.ts \
  test/traex-auto-model-worker.test.ts \
  test/traex-model-load.test.ts \
  test/traex-auto-model.integration.test.ts
```

编译二进制与 tmux 路径：

```bash
bun run build:bun
BOTMUX_TEST_WORKER_BINARY="$PWD/dist-bin/botmux" \
  bun run test -- test/traex-auto-model.integration.test.ts
```

macOS 本地编译二进制若被系统拒绝执行，按仓库构建说明完成本地签名；源码 Worker 测试不依赖此步骤。

## 本分支已完成的验证

- `bun run build`：通过，包括 TypeScript、脚本和测试 mock 类型检查、公开域名检查、嵌入资源检查。
- 14 个相关测试文件、172 项测试：全部通过，覆盖模型策略、配置读写与组件交互、Skill 快照、Worker 输入追踪、主干重启恢复及测试卫生检查。
- `test/traex-auto-model.integration.test.ts`：源码 Worker/PTY 四个场景全部通过；编译二进制/tmux 四个场景全部通过。
- `bun run verify:binary`：编译二进制的签名、命令加载、版本、Skill manifest、插件生命周期、自启动、Dashboard HTTP 和嵌入前端资源检查全部通过。

上述验证运行于 macOS arm64。模拟 CLI 的隔离测试证明队列和恢复行为；真实服务的排队概率及跨平台运行情况仍需同学按人工验证表反馈。

草稿开关分离修正追加验证：99 项相关回归通过；真实浏览器操作验证未保存启用后刷新关闭、重新打开恢复偏好、保存启用后刷新保持、保存关闭后刷新关闭且草稿保留。浏览器使用真实组件与隔离的模拟配置接口。

## 反馈记录

请记录分支提交号（`git rev-parse HEAD`）、操作系统、TraeX 版本、模型池顺序及独立档位、开关状态、排队触发前后模型、原生会话 ID 是否一致，以及相关截图或去除凭据后的日志。负载百分比与队列名次只提供选择线索，不是精确剩余等待时间。
