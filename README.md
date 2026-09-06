# dsh-live-output

DSH Web 实时输出面板：在页面输入框下方的 dock 里实时显示 agent 执行命令的**增量输出**。

## 特点

- **零 token**：输出经独立观察通道推送到页面，**不进模型上下文**，不消耗模型 token，也不干扰模型 `job_output` 的增量读取。
- **无侵入观察**：基于官方 `ctx.subprocess` 服务的 `live` 句柄集合与 `SubprocessOutputReader.readFrom(offset)` 任意游标读取；沙箱内外的命令都能被观察。
- **实时**：host 侧每 500ms 轮询增量，经同源 SSE 推送到页面。
- **安全**：路由仅接受同源 GET（`sec-fetch-site` + Origin/Host 校验）；不读取任何凭据；不外发数据；每进程内存缓冲上限 256KB，已结束进程记录保留 10 分钟。

## 安装

```powershell
dsh plugin --profile web add .\dsh-live-output
```

验证层已加载：

```powershell
dsh --profile web --dump-config
# 应出现 "# == dsh-live-output" 层
```

然后**重启 DSH Web**。

## 使用

- 页面输入框下方的 dock 出现「实时输出」按钮（带连接状态点与运行中进程数角标）。
- 点击展开面板：进程列表（命令预览、状态、退出码）+ 选中进程的实时滚动输出。
- agent 执行命令时（前台或后台任务），输出会分批实时出现；命令结束后记录保留 10 分钟可回看。

## 说明与限制

- **会话隔离**：面板只显示当前页面所在会话的命令。归属依据是官方 shell-env 机制注入命令进程的 `DSH_SESSION_ID`；没有该标记的宿主级进程不会显示。
- 命令预览来自包装 `ctx.subprocess.spawn` 捕获的 `spec.argv`；个别未经过该包装路径的进程仍会显示（无预览，仅 pid）。
- 输出在内存缓冲被截断时（每进程超过 256KB）会标记「早期输出已被截断」。
- DSH 仍是 Developer Preview：本插件依赖内部 seam（`subprocess` 服务的 `live`/`collected` 结构），DSH 升级后可能需要同步调整。
- 仅建议在 DSH Web 绑定 127.0.0.1（官方默认且强制）的环境使用。

## 开发

```powershell
node --check lib/index.js   # host 语法检查
node --check lib/client.js  # client 语法检查
```

## License

MIT
