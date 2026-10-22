# TraeX 自动模型切换 .10 修复说明

本次修复处理自动换模型后的恢复卡住：TraeX 已显示可以输入的界面，但没有重新绘制完整的模型/目录启动横幅，Botmux 仍保留“启动中”判断，最终触发 90 秒超时。

## 修复行为

- 从当前终端视口识别原生空输入框、模型与上下文状态栏，解除已完成的启动等待。
- 如果静默检查在启动期间已结束，在视口连续静默两秒后重新检查就绪。
- 保留工作中、容量排队、未提交草稿、选择器和结构化任务生命周期的拦截。
- 换模型仍恢复同一个原生会话；原问题只提交一次，后续输入在允许提交时放行。
- 编译包在入口阶段恢复后台进程日志，普通命令的 JSON 输出继续保持安静。

本机 `.10` 热修包以官方 3.48.0 为基础，测试分支以官方 `master` 的 `5af1d2e8` 为基础；两者包含相同的本次修复，构建版本名称分别标识，代码以提交号为准。

## 获取和运行

首次安装、接管已有服务及启动故障诊断参考[测试说明](traex-auto-model-testing.md)。已有测试 checkout 更新到最新测试分支后重新构建：

```bash
git pull --ff-only
node -e 'const fs=require("node:fs");const p="package.json";const pkg=JSON.parse(fs.readFileSync(p,"utf8"));pkg.version="3.48.0-test.traex-auto-model.10";fs.writeFileSync(p,JSON.stringify(pkg,null,2)+"\n")'
bun run build
node dist/cli.js --version
bun run use:here
bun run daemon:restart
```

源码构建的版本应显示 `3.48.0-test.traex-auto-model.10`。模型池及原输入配置保留，Auto 启用时继续自动适配终端输入。

## 复测重点

开启 Auto 后触发模型排队，观察切换恢复：即使恢复画面没有完整启动横幅，只显示原生输入框和模型/上下文状态栏，也应继续原任务。切换后原生会话 ID 保持，原问题不重复发送；排队、忙碌、草稿及选择器画面应继续阻止错误提交。

故障修复不要求重新创建话题或重新上传已有图片。现场恢复验证独立于模拟 CLI 测试；模拟场景验证启动与输入队列流程。
