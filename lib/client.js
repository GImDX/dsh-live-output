// dsh-live-output client plugin (browser).
// 挂载到 composer dock：实时显示 agent 命令进程的增量输出。
// 数据经同源 SSE (/api/dsh-live-output/stream) 推送，不经模型上下文。

window.__ModuleLoader__.load({
  id: "dsh-live-output",
  factory: function (require) {
    "use strict";
    var React = require("react");
    var e = React.createElement;
    var useState = React.useState;
    var useEffect = React.useEffect;
    var useRef = React.useRef;

    var STYLE = [
      ".dsh-live-output-root { font-family: var(--dsw-font-family, -apple-system, BlinkMacSystemFont, 'Segoe UI', 'PingFang SC', 'Hiragino Sans GB', 'Microsoft YaHei', 'Helvetica Neue', Helvetica, Arial, sans-serif); font-size: 12px; min-width: 0; width: 100%; flex: 1 1 100%; box-sizing: border-box; max-width: 100%; overflow-x: hidden; }",
      ".dsh-live-output-toggle { display: inline-flex; align-items: center; gap: 6px; padding: 4px 10px; border-radius: 6px; border: 1px solid rgba(128,128,128,.4); background: rgba(30,30,30,.6); color: #d4d4d4; cursor: pointer; user-select: none; max-width: 100%; }",
      ".dsh-live-output-toggle:hover { background: rgba(60,60,60,.7); }",
      ".dsh-live-output-toggle-active { border-color: rgba(59,130,246,.8) !important; background: rgba(59,130,246,.28) !important; }",
      ".dsh-live-output-dot { width: 8px; height: 8px; border-radius: 50%; display: inline-block; flex: 0 0 auto; }",
      ".dsh-live-output-dot.open { background: #4ade80; }",
      ".dsh-live-output-dot.connecting { background: #facc15; }",
      ".dsh-live-output-dot.closed { background: #f87171; }",
      ".dsh-live-output-panel { margin-top: 6px; box-sizing: border-box; width: 100%; border: 1px solid rgba(128,128,128,.35); border-radius: 8px; background: #1e1e1e; color: #d4d4d4; overflow: hidden; display: flex; flex-direction: column; min-width: 0; max-width: 100%; }",
      ".dsh-live-output-resize { height: 6px; cursor: row-resize; flex: 0 0 auto; background: rgba(255,255,255,.03); }",
      ".dsh-live-output-resize:hover { background: rgba(59,130,246,.45); }",
      ".dsh-live-output-procs { display: flex; flex-wrap: wrap; align-content: flex-start; gap: 4px; padding: 6px; border-bottom: 1px solid rgba(128,128,128,.25); overflow-y: auto; flex: 0 0 auto; min-width: 0; }",
      ".dsh-live-output-proc { padding: 3px 8px; border-radius: 4px; background: rgba(255,255,255,.06); cursor: pointer; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 260px; font-family: var(--dsw-font-mono, var(--ds-font-family-code, ui-monospace, Consolas, 'PingFang SC', 'Microsoft YaHei', monospace)); }",
      ".dsh-live-output-proc.selected { background: rgba(59,130,246,.35); }",
      ".dsh-live-output-proc.finished { opacity: .55; }",
      ".dsh-live-output-head { padding: 6px 10px; color: #9ca3af; border-bottom: 1px solid rgba(128,128,128,.15); flex: 0 0 auto; white-space: pre-wrap; word-break: break-all; overflow-y: auto; min-width: 0; font-family: var(--dsw-font-mono, var(--ds-font-family-code, ui-monospace, Consolas, 'PingFang SC', 'Microsoft YaHei', monospace)); }",
      ".dsh-live-output-body { flex: 1 1 auto; min-height: 0; overflow-y: auto; padding: 8px 10px; white-space: pre-wrap; word-break: break-all; margin: 0; min-width: 0; font-family: var(--ds-font-family-code, 'SF Mono', 'JetBrains Mono', 'Fira Code', Consolas, 'Liberation Mono', Menlo, Courier, 'PingFang SC', 'Microsoft YaHei', monospace); }",
      ".dsh-live-output-empty { padding: 14px; color: #6b7280; flex: 1 1 auto; }"
    ].join("\n");

    function injectCss() {
      if (document.getElementById("dsh-live-output-style")) return;
      var style = document.createElement("style");
      style.id = "dsh-live-output-style";
      style.textContent = STYLE;
      document.head.appendChild(style);
    }

    function fmtAge(startedAt, finishedAt, now) {
      if (startedAt === null || startedAt === undefined) return "";
      var ms = (finishedAt ?? now) - startedAt;
      if (ms < 0) ms = 0;
      var s = Math.floor(ms / 1000);
      if (s < 60) return s + "s";
      var m = Math.floor(s / 60);
      if (m < 60) return m + "m " + (s % 60) + "s";
      return Math.floor(m / 60) + "h " + (m % 60) + "m";
    }

    function statusText(proc) {
      if (proc.status === "running") return "running";
      if (proc.exitCode !== null && proc.exitCode !== undefined) return "exit " + proc.exitCode;
      if (proc.signal) return "signal " + proc.signal;
      return "finished";
    }

    function fmtClock(ms) {
      var d = new Date(ms);
      function p(n) { return (n < 10 ? "0" : "") + n; }
      return p(d.getHours()) + ":" + p(d.getMinutes()) + ":" + p(d.getSeconds());
    }

    // ---- 输出自动着色 ----
    var ANSI_COLORS = ["#000000", "#cd3131", "#0dbc79", "#e5e510", "#2472c8", "#bc3fbc", "#11a8cd", "#e5e5e5"];
    var ANSI_BRIGHT = ["#666666", "#f14c4c", "#23d18b", "#f5f543", "#3b8eea", "#d670d6", "#29b8db", "#ffffff"];
    var ANSI_RE = /\x1b\[([0-9;]*)m/g;
    // 无 ANSI 时的行级关键词高亮（英文）
    var LINE_PATTERNS = [
      { re: /\b(error|failed|failure|fatal|exception|traceback|denied|abort)\b/i, style: { color: "#f14c4c", fontWeight: "bold" } },
      { re: /\b(warn|warning|deprecated|retry)\b/i, style: { color: "#e5e510" } },
      { re: /\b(success|succeeded|completed|passed|ok)\b/i, style: { color: "#23d18b" } }
    ];

    function applySgr(prev, codes) {
      var next = prev ? { color: prev.color, backgroundColor: prev.backgroundColor, fontWeight: prev.fontWeight, fontStyle: prev.fontStyle, textDecoration: prev.textDecoration } : {};
      if (codes === "" || codes === "0") return {};
      var parts = codes.split(";");
      for (var i = 0; i < parts.length; i++) {
        var c = parseInt(parts[i], 10);
        if (isNaN(c)) continue;
        if (c === 0) { next = {}; }
        else if (c === 1) next.fontWeight = "bold";
        else if (c === 3) next.fontStyle = "italic";
        else if (c === 4) next.textDecoration = "underline";
        else if (c === 22) next.fontWeight = undefined;
        else if (c === 23) next.fontStyle = undefined;
        else if (c === 24) next.textDecoration = undefined;
        else if (c >= 30 && c <= 37) next.color = ANSI_COLORS[c - 30];
        else if (c === 39) next.color = undefined;
        else if (c >= 40 && c <= 47) next.backgroundColor = ANSI_COLORS[c - 40];
        else if (c === 49) next.backgroundColor = undefined;
        else if (c >= 90 && c <= 97) next.color = ANSI_BRIGHT[c - 90];
        else if (c >= 100 && c <= 107) next.backgroundColor = ANSI_BRIGHT[c - 100];
      }
      return next;
    }

    var colorKey = 0;
    /** 含 ANSI 序列的文本：解析 SGR 生成着色 span 序列。 */
    function renderAnsi(text) {
      var nodes = [];
      var lastIndex = 0;
      var style = null;
      var match;
      function push(str, st) {
        if (str === "") return;
        nodes.push(e("span", { key: "a" + (colorKey++), style: st ?? undefined }, str));
      }
      ANSI_RE.lastIndex = 0;
      while ((match = ANSI_RE.exec(text)) !== null) {
        if (match.index > lastIndex) push(text.slice(lastIndex, match.index), style);
        style = applySgr(style, match[1]);
        lastIndex = ANSI_RE.lastIndex;
      }
      if (lastIndex < text.length) push(text.slice(lastIndex), style);
      return nodes;
    }

    /** 无 ANSI 的普通文本：按行做关键词高亮（整行着色）。 */
    function renderPlain(text) {
      var nodes = [];
      var lines = text.split("\n");
      for (var i = 0; i < lines.length; i++) {
        var line = lines[i].replace(/\r$/, "");
        if (i > 0) nodes.push(e("span", { key: "n" + (colorKey++) }, "\n"));
        if (line === "") continue;
        var style = null;
        for (var p = 0; p < LINE_PATTERNS.length; p++) {
          if (LINE_PATTERNS[p].re.test(line)) { style = LINE_PATTERNS[p].style; break; }
        }
        nodes.push(e("span", { key: "n" + (colorKey++), style: style ?? undefined }, line));
      }
      return nodes;
    }

    var RENDER_LIMIT = 64 * 1024;
    /** 渲染输出文本：含 ANSI 走 ANSI 着色，否则行级关键词高亮；超长只渲染尾部。 */
    function renderOutput(text) {
      if (text.indexOf("\x1b") !== -1) {
        if (text.length > RENDER_LIMIT) {
          return [e("span", { key: "cut", style: { color: "#6b7280" } }, "…(\u66f4\u65e9\u8f93\u51fa\u5df2\u7701\u7565)\n")].concat(renderAnsi(text.slice(text.length - RENDER_LIMIT)));
        }
        return renderAnsi(text);
      }
      if (text.length > RENDER_LIMIT) {
        return [e("span", { key: "cut", style: { color: "#6b7280" } }, "…(\u66f4\u65e9\u8f93\u51fa\u5df2\u7701\u7565)\n")].concat(renderPlain(text.slice(text.length - RENDER_LIMIT)));
      }
      return renderPlain(text);
    }

    function LiveOutputPanel(props) {
      var sessionId = (props && props.sessionId) || "";
      var open = useState(false);
      var isOpen = open[0];
      var setOpen = open[1];
      var procsState = useState([]);
      var procs = procsState[0];
      var setProcs = procsState[1];
      var textsState = useState({});
      var texts = textsState[0];
      var setTexts = textsState[1];
      var selState = useState(null);
      var selected = selState[0];
      var setSelected = selState[1];
      var connState = useState("connecting");
      var conn = connState[0];
      var setConn = connState[1];
      var nowState = useState(Date.now());
      var now = nowState[0];
      var setNow = nowState[1];
      var bodyRef = useRef(null);
      var procsRef = useRef([]);
      var followState = useState(function () {
        try {
          return localStorage.getItem("dsh-live-output:follow") !== "off";
        } catch (err) {
          return true;
        }
      });
      var follow = followState[0];
      var setFollow = followState[1];
      var followRef = useRef(follow);
      followRef.current = follow;
      var heightState = useState(function () {
        try {
          var saved = parseInt(localStorage.getItem("dsh-live-output:height"), 10);
          return saved >= 140 && saved <= 640 ? saved : 280;
        } catch (err) {
          return 280;
        }
      });
      var panelH = heightState[0];
      var setPanelH = heightState[1];
      var listHState = useState(function () {
        try {
          var saved = parseInt(localStorage.getItem("dsh-live-output:listHeight"), 10);
          return saved >= 28 && saved <= 320 ? saved : 96;
        } catch (err) {
          return 96;
        }
      });
      var listH = listHState[0];
      var setListH = listHState[1];
      var headHState = useState(function () {
        try {
          var saved = parseInt(localStorage.getItem("dsh-live-output:headHeight"), 10);
          return saved >= 28 && saved <= 240 ? saved : 84;
        } catch (err) {
          return 84;
        }
      });
      var headH = headHState[0];
      var setHeadH = headHState[1];

      function startDrag(ev, onMove, onUp) {
        ev.preventDefault();
        function move(mv) { onMove(mv); }
        function up() {
          document.removeEventListener("mousemove", move);
          document.removeEventListener("mouseup", up);
          onUp();
        }
        document.addEventListener("mousemove", move);
        document.addEventListener("mouseup", up);
      }

      function startResize(ev) {
        var startY = ev.clientY;
        var startH = panelH;
        startDrag(
          ev,
          function (mv) {
            var h = startH + (startY - mv.clientY);
            if (h < 140) h = 140;
            if (h > 640) h = 640;
            setPanelH(h);
          },
          function () {
            setPanelH(function (h) {
              try {
                localStorage.setItem("dsh-live-output:height", String(h));
              } catch (err) {}
              return h;
            });
          }
        );
      }

      function startListResize(ev) {
        var startY = ev.clientY;
        var startH = listH;
        startDrag(
          ev,
          function (mv) {
            // 把手在列表下方：向下拖 = 列表变高
            var h = startH + (mv.clientY - startY);
            if (h < 28) h = 28;
            if (h > 320) h = 320;
            setListH(h);
          },
          function () {
            setListH(function (h) {
              try {
                localStorage.setItem("dsh-live-output:listHeight", String(h));
              } catch (err) {}
              return h;
            });
          }
        );
      }

      function startHeadResize(ev) {
        var startY = ev.clientY;
        var startH = headH;
        startDrag(
          ev,
          function (mv) {
            // 把手在命令区下方：向下拖 = 命令区变高
            var h = startH + (mv.clientY - startY);
            if (h < 28) h = 28;
            if (h > 240) h = 240;
            setHeadH(h);
          },
          function () {
            setHeadH(function (h) {
              try {
                localStorage.setItem("dsh-live-output:headHeight", String(h));
              } catch (err) {}
              return h;
            });
          }
        );
      }

      useEffect(function () {
        injectCss();
      }, []);

      // 每秒刷新“运行时长”
      useEffect(function () {
        if (!isOpen) return;
        var timer = setInterval(function () { setNow(Date.now()); }, 1000);
        return function () { clearInterval(timer); };
      }, [isOpen]);

      // SSE 连接（组件存活期间保持，断线自动重连；会话切换时重建并清空旧数据）
      useEffect(function () {
        procsRef.current = [];
        setProcs([]);
        setTexts({});
        setSelected(null);
        var es = null;
        var closed = false;
        var url = "/api/dsh-live-output/stream" +
          (sessionId ? "?session=" + encodeURIComponent(sessionId) : "");
        function connect() {
          if (closed) return;
          es = new EventSource(url);
          es.onopen = function () { if (!closed) setConn("open"); };
          es.onmessage = function (ev) {
            var msg;
            try { msg = JSON.parse(ev.data); } catch (err) { return; }
            if (msg.type === "proc") {
              var prevArr = procsRef.current;
              var isNew = true;
              for (var i = 0; i < prevArr.length; i++) {
                if (prevArr[i].id === msg.id) { isNew = false; break; }
              }
              var map = {};
              for (var m = 0; m < prevArr.length; m++) map[prevArr[m].id] = prevArr[m];
              map[msg.id] = msg;
              var arr = [];
              for (var k in map) arr.push(map[k]);
              arr.sort(function (a, b) { return a.startedAt - b.startedAt; });
              procsRef.current = arr;
              setProcs(arr);
              // “最后命令”开关开启时，新命令自动切换显示
              if (isNew && followRef.current && msg.status === "running") {
                setSelected(msg.id);
              }
            } else if (msg.type === "delta") {
              setTexts(function (prev) {
                var next = {};
                for (var k in prev) next[k] = prev[k];
                next[msg.id] = (next[msg.id] || "") + msg.text;
                return next;
              });
            }
          };
          es.onerror = function () {
            if (es) { es.close(); es = null; }
            if (!closed) {
              setConn("reconnecting");
              setTimeout(connect, 1500);
            }
          };
        }
        connect();
        return function () {
          closed = true;
          if (es) es.close();
        };
      }, [sessionId]);

      // 自动选中最新进程（已选中的保持不动）
      useEffect(function () {
        setSelected(function (sel) {
          for (var i = 0; i < procs.length; i++) if (procs[i].id === sel) return sel;
          return procs.length > 0 ? procs[procs.length - 1].id : null;
        });
      }, [procs]);

      // 输出自动滚底
      useEffect(function () {
        var el = bodyRef.current;
        if (el) el.scrollTop = el.scrollHeight;
      }, [texts[selected], selected]);

      var runningCount = 0;
      for (var i = 0; i < procs.length; i++) if (procs[i].status === "running") runningCount++;

      var selProc = null;
      for (var j = 0; j < procs.length; j++) if (procs[j].id === selected) selProc = procs[j];

      var toggleChildren = [
        e("span", {
          key: "dot",
          className: "dsh-live-output-dot " + (conn === "open" ? "open" : "connecting")
        }),
        e("span", { key: "label" }, "\u5b9e\u65f6\u8f93\u51fa"),
        runningCount > 0
          ? e("span", { key: "badge", style: { color: "#93c5fd" } }, "(" + runningCount + ")")
          : null
      ];
      if (procs.length === 0) toggleChildren.push(e("span", { key: "none", style: { color: "#6b7280" } }, "\u65e0\u6d3b\u52a8\u8fdb\u7a0b"));

      var panel = null;
      if (isOpen) {
        // 按启动顺序编号（#1 最早），展示时最新在前
        var indexed = [];
        for (var k = 0; k < procs.length; k++) indexed.push({ proc: procs[k], seq: k + 1 });
        indexed.reverse();
        var procNodes = indexed.map(function (item) {
          var p = item.proc;
          var cls = "dsh-live-output-proc";
          if (p.id === selected) cls += " selected";
          if (p.status !== "running") cls += " finished";
          return e(
            "div",
            {
              key: p.id,
              className: cls,
              title: p.preview,
              onClick: function () { setSelected(p.id); }
            },
            e("span", { style: { color: "#9ca3af", display: "inline-block", minWidth: "2.2em" } }, "#" + item.seq),
            e("span", null, "[" + statusText(p) + "] "),
            e("span", { style: { color: "#6b7280" } }, fmtClock(p.startedAt) + " "),
            e("span", { style: { color: "#93c5fd" } }, p.preview !== "" && p.preview !== undefined ? p.preview : ("pid " + p.pid))
          );
        });

        var body;
        if (selProc === null) {
          body = e("div", { className: "dsh-live-output-empty" }, "\u6682\u65e0\u8fdb\u7a0b\uff1a\u5f53 agent \u6267\u884c\u547d\u4ee4\u65f6\uff0c\u8f93\u51fa\u4f1a\u5b9e\u65f6\u663e\u793a\u5728\u8fd9\u91cc");
        } else {
          var text = texts[selected] || "";
          body = e("pre", { className: "dsh-live-output-body", ref: bodyRef }, renderOutput(text));
        }

        panel = e(
          "div",
          { className: "dsh-live-output-panel", style: { height: panelH + "px" } },
          e("div", {
            className: "dsh-live-output-resize",
            onMouseDown: startResize,
            title: "\u62d6\u52a8\u8c03\u6574\u9762\u677f\u9ad8\u5ea6"
          }),
          e("div", {
            className: "dsh-live-output-procs",
            style: { maxHeight: listH + "px" }
          }, procNodes),
          e("div", {
            className: "dsh-live-output-resize",
            onMouseDown: startListResize,
            title: "\u62d6\u52a8\u8c03\u6574\u547d\u4ee4\u5217\u8868\u9ad8\u5ea6"
          }),
          selProc !== null
            ? e(
                "div",
                { className: "dsh-live-output-head", style: { maxHeight: headH + "px" } },
                e(
                  "div",
                  { style: { color: "#e5e7eb" } },
                  selProc.command !== "" && selProc.command !== undefined && selProc.command !== null
                    ? selProc.command
                    : (selProc.preview !== "" && selProc.preview !== undefined ? selProc.preview : ("pid " + selProc.pid))
                ),
                e(
                  "div",
                  { style: { marginTop: "2px" } },
                  statusText(selProc) + "  \u00b7  " + fmtAge(selProc.startedAt, selProc.finishedAt, now) +
                  (selProc.lossy ? "  \u00b7  (\u65e9\u671f\u8f93\u51fa\u5df2\u88ab\u622a\u65ad)" : "")
                )
              )
            : null,
          e("div", {
            className: "dsh-live-output-resize",
            onMouseDown: startHeadResize,
            title: "\u62d6\u52a8\u8c03\u6574\u5f53\u524d\u547d\u4ee4\u533a\u9ad8\u5ea6"
          }),
          body
        );
      }

      return e(
        "div",
        { className: "dsh-live-output-root" },
        e(
          "div",
          { style: { display: "flex", alignItems: "center", gap: "6px", flexWrap: "wrap" } },
          e(
            "button",
            { type: "button", className: "dsh-live-output-toggle", onClick: function () { setOpen(!isOpen); } },
            toggleChildren
          ),
          isOpen
            ? e(
                "button",
                {
                  key: "follow",
                  type: "button",
                  className: "dsh-live-output-toggle" + (follow ? " dsh-live-output-toggle-active" : ""),
                  title: follow
                    ? "\u81ea\u52a8\u663e\u793a\u5e76\u5207\u6362\u6700\u65b0\u547d\u4ee4\uff08\u5df2\u5f00\u542f\uff0c\u70b9\u51fb\u5173\u95ed\uff09"
                    : "\u81ea\u52a8\u663e\u793a\u5e76\u5207\u6362\u6700\u65b0\u547d\u4ee4\uff08\u5df2\u5173\u95ed\uff0c\u70b9\u51fb\u5f00\u542f\uff09",
                  onClick: function () {
                    setFollow(function (f) {
                      try {
                        localStorage.setItem("dsh-live-output:follow", f ? "off" : "on");
                      } catch (err) {}
                      return !f;
                    });
                  }
                },
                e("span", null, "\u6700\u540e\u547d\u4ee4" + (follow ? " \u2713" : ""))
              )
            : null
        ),
        panel
      );
    }

    var plugin = {
      name: "dsh-live-output",
      inject: ["slots"],
      apply: function (ctx) {
        ctx.slots.inject("conversation.composer.dock", function () {
          return ctx.slots.register(
            {
              name: "conversation.composer.dock",
              id: "dsh-live-output",
              order: 10,
              registrant: "dsh-live-output"
            },
            LiveOutputPanel
          );
        });
      }
    };
    return plugin;
  }
});
