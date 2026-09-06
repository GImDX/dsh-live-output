// dsh-live-output host plugin.
//
// 目标：让 DSH Web 页面实时看到 agent 执行命令（pwsh/bash 等经 ctx.subprocess
// 运行的一切子进程）的增量输出，而输出**不进模型上下文**（零 token）。
//
// 原理：dsh-subprocess-local 的每个 spawn handle 都带 collected.stdout/stderr
// （SubprocessOutputReader）。readFrom(offset) 是任意游标、非破坏性的增量读，
// 与模型 job_output 的消费游标互不干扰。本插件自维护游标周期读取，
// 把增量经 SSE 推给页面。
//
// 接入点：
//   - ctx.subprocess（服务名 "subprocess"）的 live 集合保存全部活跃句柄；
//   - 包装实例 spawn 方法只为拿到 spec.argv，读取仍走独立游标；
//   - 沙箱执行器（dsh-pwsh-sandbox 等）同样注入 ctx.subprocess，因此沙箱内
//     外的命令都能被观察。
//
// 摘要与归属：
//   - 进程归属会话：spec.env.DSH_SESSION_ID（官方 shell-env 机制注入）；
//   - 显示摘要：在会话事件流（tool/call）里按 command 精确匹配，直接使用
//     agent 调用时的 description；没有摘要的进程原样显示 argv；
//   - 完整命令：从 argv 剥离执行器编码预置（沙箱 runner 的 argv 尾部也带原
//     始命令，同样能提取）。

export const name = "dsh-live-output";
export const inject = ["subprocess", "webServer", "sessions"];

const TICK_MS = 500;                    // 增量轮询周期
const MAX_BUFFER_CHARS = 256 * 1024;    // 每进程内存缓冲上限（字符）
const RETAIN_MS = 10 * 60 * 1000;       // 已结束进程的记录保留时长
const PRUNE_INTERVAL_MS = 60 * 1000;    // 记录清理周期
const HEARTBEAT_MS = 15 * 1000;         // SSE 心跳
const PREVIEW_MAX = 4000;               // 命令预览最大长度（字符；仅防极端 argv）
// dsh-pwsh-local 注入每条命令的编码预置前缀（与官方执行器保持一致）
const ENCODING_PREAMBLE = "[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); $OutputEncoding = [System.Text.UTF8Encoding]::new($false); ";

/** 从 argv（含沙箱 runner 包装的尾部）提取真实 pwsh 命令（剥掉执行器编码预置）。 */
function realPwshCommand(argv) {
  if (!Array.isArray(argv)) return undefined;
  for (let i = 0; i < argv.length - 1; i++) {
    if (String(argv[i]).toLowerCase() === "-command") {
      let cmd = String(argv[i + 1] ?? "");
      if (cmd.startsWith(ENCODING_PREAMBLE)) cmd = cmd.slice(ENCODING_PREAMBLE.length);
      return cmd;
    }
  }
  return undefined;
}

/** 仅放行本页同源的 GET 请求（与社区插件通用做法一致）。 */
function isTrustedRequest(req) {
  if (req.method !== "GET") return false;
  const fetchSite = req.headers["sec-fetch-site"];
  if (typeof fetchSite === "string" && fetchSite !== "same-origin" && fetchSite !== "none") return false;
  const origin = req.headers.origin;
  const host = req.headers.host;
  if (typeof origin === "string" && typeof host === "string") {
    try {
      if (new URL(origin).host !== host) return false;
    } catch {
      return false;
    }
  }
  return true;
}

function writeJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer"
  });
  res.end(payload);
}

export function apply(ctx) {
  const logger = ctx.logger(name);
  const sessions = ctx.sessions;

  // —— 观察注册表 ——
  const byHandle = new WeakMap(); // 去重：handle -> 已登记
  const list = [];                // 渲染用扁平列表（按启动顺序）
  let counter = 0;

  function sessionOfSpec(spec) {
    const env = spec?.env;
    if (env === undefined || env === null) return undefined;
    const sid = env.DSH_SESSION_ID;
    return typeof sid === "string" && sid !== "" ? sid : undefined;
  }

  /** 在会话事件流里找最近一条 command 完全匹配的工具调用，返回其 description。 */
  function findDescription(sessionId, cmd) {
    const session = sessions?.get(sessionId);
    const events = session?.events;
    if (!Array.isArray(events)) return undefined;
    const floor = Math.max(0, events.length - 300);
    for (let i = events.length - 1; i >= floor; i--) {
      const ev = events[i];
      if (ev?.type !== "tool/call") continue;
      const toolName = ev.data?.name;
      if (toolName !== "pwsh" && toolName !== "bash") continue;
      let args;
      try {
        args = JSON.parse(ev.data.arguments);
      } catch {
        continue;
      }
      if (args?.command === cmd && typeof args.description === "string" && args.description.trim() !== "") {
        return args.description.trim();
      }
    }
    return undefined;
  }

  /** 提取一条命令的展示信息：摘要（对话 description，无则原样）与完整命令。 */
  function describe(spec) {
    const argv = spec?.argv;
    if (!Array.isArray(argv) || argv.length === 0) return { summary: "", command: "" };
    const raw = argv.map((a) => String(a)).join(" ");
    const sid = sessionOfSpec(spec);
    let cmd = realPwshCommand(argv);
    if (cmd === undefined) {
      for (let i = 0; i < argv.length - 1; i++) {
        const a = String(argv[i]);
        if (a === "-lc" || a === "-c") {
          cmd = String(argv[i + 1] ?? "");
          break;
        }
      }
    }
    // 有对话摘要直接用；没有则原样显示
    if (cmd !== undefined && sid !== undefined) {
      const desc = findDescription(sid, cmd);
      if (desc !== undefined) return { summary: desc, command: cmd };
      return { summary: raw, command: cmd };
    }
    return { summary: raw, command: raw };
  }

  function register(handle, spec) {
    if (byHandle.has(handle)) return byHandle.get(handle);
    const shown = describe(spec);
    const rec = {
      id: `proc-${++counter}`,
      handle,
      pid: handle?.pid,
      sessionId: sessionOfSpec(spec),
      preview: shown.summary,
      command: shown.command,
      startedAt: Date.now(),
      finishedAt: undefined,
      exit: undefined,
      stdoutOffset: 0,
      stderrOffset: 0,
      buffer: "",
      lossy: false
    };
    byHandle.set(handle, rec);
    list.push(rec);
    if (typeof handle?.done?.then === "function") {
      handle.done.then(
        (outcome) => {
          drain(rec); // 结算时补读最后增量：短命进程（< 一个 tick）的输出不依赖 tick 时序
          rec.finishedAt = Date.now();
          rec.exit = outcome ?? {};
          broadcast();
        },
        () => {
          drain(rec);
          rec.finishedAt = Date.now();
          broadcast();
        }
      );
    }
    return rec;
  }

  function append(rec, text) {
    if (!text) return;
    rec.buffer += text;
    if (rec.buffer.length > MAX_BUFFER_CHARS) {
      rec.buffer = rec.buffer.slice(rec.buffer.length - MAX_BUFFER_CHARS);
      rec.lossy = true;
    }
  }

  function readOnce(rec) {
    const collected = rec.handle?.collected;
    const out = collected?.stdout?.readFrom(rec.stdoutOffset);
    const err = collected?.stderr?.readFrom(rec.stderrOffset);
    if (out !== undefined) {
      rec.stdoutOffset = out.nextOffset;
      if (out.lossy) rec.lossy = true;
      append(rec, out.text);
    }
    if (err !== undefined) {
      rec.stderrOffset = err.nextOffset;
      if (err.lossy) rec.lossy = true;
      append(rec, err.text);
    }
  }

  /** 读取一次当前增量并推进游标；异常不打断 tick 循环。 */
  function drain(rec) {
    try {
      readOnce(rec);
    } catch (error) {
      logger.warn(`dsh-live-output: read failed for ${rec.id}: ${String(error)}`);
    }
  }

  // —— 包装 spawn：只为捕获 spec（读取不依赖它） ——
  const subprocess = ctx.subprocess;
  let originalSpawn;
  let spawnPatched = false;
  if (subprocess === undefined) {
    logger.warn("ctx.subprocess is unavailable; dsh-live-output will observe nothing");
  } else if (typeof subprocess.spawn === "function" && !subprocess.__dshLiveOutputPatched) {
    const bound = subprocess.spawn.bind(subprocess);
    originalSpawn = subprocess.spawn;
    subprocess.spawn = function dshLiveOutputSpawn(spec) {
      const handle = bound(spec);
      try {
        register(handle, spec);
      } catch (error) {
        logger.warn(`failed to register spawned handle: ${String(error)}`);
      }
      return handle;
    };
    subprocess.__dshLiveOutputPatched = true;
    spawnPatched = true;
  }

  function tick() {
    // 兜底：把 live 集合里未被包装路径登记过的句柄也纳入观察（无命令预览）。
    const live = subprocess?.live;
    if (live instanceof Set) {
      for (const handle of live) {
        if (!byHandle.has(handle)) register(handle, { argv: [] });
      }
    }
    for (const rec of [...list]) {
      if (rec.finishedAt !== undefined) continue; // 已结束进程不再读（结算时已由 drain 补读）
      drain(rec);
    }
    broadcast();
  }

  // —— SSE 广播 ——
  const connections = new Set(); // { res, session, sent: Map<procId, len>, states: Map<procId, json> }

  function stateOf(rec) {
    const finished = rec.finishedAt !== undefined;
    return {
      id: rec.id,
      pid: rec.pid,
      sessionId: rec.sessionId ?? null,
      preview: rec.preview,
      command: rec.command,
      startedAt: rec.startedAt,
      finishedAt: rec.finishedAt ?? null,
      status: finished ? "finished" : "running",
      exitCode: rec.exit?.exitCode ?? null,
      signal: rec.exit?.signal ?? null,
      lossy: rec.lossy
    };
  }

  function visibleFor(rec, session) {
    return session === undefined || session === null || session === "" || rec.sessionId === session;
  }

  function framesFor(conn) {
    const frames = [];
    for (const rec of list) {
      if (!visibleFor(rec, conn.session)) continue;
      const sentLen = conn.sent.get(rec.id) ?? 0;
      if (rec.buffer.length > sentLen) {
        frames.push({ type: "delta", id: rec.id, text: rec.buffer.slice(sentLen) });
        conn.sent.set(rec.id, rec.buffer.length);
      }
      const state = JSON.stringify(stateOf(rec));
      if (conn.states.get(rec.id) !== state) {
        frames.push({ type: "proc", ...stateOf(rec) });
        conn.states.set(rec.id, state);
      }
    }
    return frames;
  }

  function broadcast() {
    for (const conn of [...connections]) {
      try {
        const frames = framesFor(conn);
        if (frames.length > 0) {
          for (const frame of frames) conn.res.write(`data: ${JSON.stringify(frame)}\n\n`);
        }
      } catch {
        // 连接已坏：交给 close 事件清理
      }
    }
  }

  const timers = [];
  timers.push(setInterval(tick, TICK_MS));
  timers.push(setInterval(() => {
    const now = Date.now();
    for (let i = list.length - 1; i >= 0; i--) {
      const rec = list[i];
      if (rec.finishedAt !== undefined && now - rec.finishedAt > RETAIN_MS) list.splice(i, 1);
    }
  }, PRUNE_INTERVAL_MS));
  timers.push(setInterval(() => {
    for (const conn of [...connections]) {
      try {
        conn.res.write(`: ping ${Date.now()}\n\n`);
      } catch {}
    }
  }, HEARTBEAT_MS));

  // —— 路由 ——
  ctx.effect(() => ctx.webServer.register({
    kind: "exact",
    path: "/api/dsh-live-output/snapshot",
    handler(req, res) {
      if (!isTrustedRequest(req)) {
        writeJson(res, 403, { ok: false, reason: "cross-origin-request" });
        return;
      }
      let session;
      try {
        session = new URL(req.url ?? "/", "http://localhost").searchParams.get("session") ?? "";
      } catch {
        session = "";
      }
      writeJson(res, 200, {
        ok: true,
        processes: list
          .filter((rec) => visibleFor(rec, session))
          .map((rec) => ({ ...stateOf(rec), text: rec.buffer.slice(-64 * 1024) }))
      });
    }
  }), "dsh-live-output: snapshot route");

  ctx.effect(() => ctx.webServer.register({
    kind: "exact",
    path: "/api/dsh-live-output/stream",
    handler(req, res) {
      if (!isTrustedRequest(req)) {
        writeJson(res, 403, { ok: false, reason: "cross-origin-request" });
        return;
      }
      let session = "";
      try {
        session = new URL(req.url ?? "/", "http://localhost").searchParams.get("session") ?? "";
      } catch {}
      res.writeHead(200, {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-store",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no"
      });
      const conn = { res, session, sent: new Map(), states: new Map() };
      connections.add(conn);
      // 首帧：该会话的全量快照（进程元数据 + 已有缓冲）
      for (const rec of list) {
        if (!visibleFor(rec, conn.session)) continue;
        const state = stateOf(rec);
        conn.res.write(`data: ${JSON.stringify({ type: "proc", ...state })}\n\n`);
        if (rec.buffer.length > 0) {
          conn.res.write(`data: ${JSON.stringify({ type: "delta", id: rec.id, text: rec.buffer })}\n\n`);
        }
        conn.sent.set(rec.id, rec.buffer.length);
        conn.states.set(rec.id, JSON.stringify(state));
      }
      req.on("close", () => {
        connections.delete(conn);
      });
    }
  }), "dsh-live-output: stream route");

  // —— 清理 ——
  ctx.effect(() => () => {
    for (const timer of timers) clearInterval(timer);
    for (const conn of [...connections]) {
      try {
        conn.res.end();
      } catch {}
    }
    connections.clear();
    if (spawnPatched && subprocess !== undefined) {
      try {
        subprocess.spawn = originalSpawn;
      } catch {}
    }
  }, "dsh-live-output: dispose");
}
