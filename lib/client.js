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
    var useLayoutEffect = React.useLayoutEffect;
    var useRef = React.useRef;

    var STYLE = [
      // root 为文档流底部窗口容器：宽度与官方发送框卡片同宽同中心（100% 取宿主
      // InputBar root 内容宽，上限 --dsh-composer-card-max-width），纵向排列按钮行
      // 与面板（面板占据真实布局空间，不再绝对定位浮层）。flex:none 保持单行不换行。
      ".dsh-live-output-root { font-family: var(--dsw-font-family, -apple-system, BlinkMacSystemFont, 'Segoe UI', 'PingFang SC', 'Hiragino Sans GB', 'Microsoft YaHei', 'Helvetica Neue', Helvetica, Arial, sans-serif); font-size: 12px; min-width: 0; flex: none; box-sizing: border-box; width: 100%; max-width: var(--dsh-composer-card-max-width, 780px); display: flex; flex-direction: column; gap: 6px; }",
      ".dsh-live-output-toggle { display: inline-flex; align-items: center; gap: 6px; padding: 4px 10px; border-radius: 6px; border: 1px solid rgba(128,128,128,.4); background: rgba(30,30,30,.6); color: #d4d4d4; cursor: pointer; user-select: none; max-width: 100%; }",
      ".dsh-live-output-toggle:hover { background: rgba(60,60,60,.7); }",
      ".dsh-live-output-toggle-active { border-color: rgba(59,130,246,.8) !important; background: rgba(59,130,246,.28) !important; }",
      ".dsh-live-output-dot { width: 8px; height: 8px; border-radius: 50%; display: inline-block; flex: 0 0 auto; }",
      ".dsh-live-output-dot.open { background: #4ade80; }",
      ".dsh-live-output-dot.connecting { background: #facc15; }",
      ".dsh-live-output-dot.closed { background: #f87171; }",
      ".dsh-live-output-panel { box-sizing: border-box; border: 1px solid rgba(128,128,128,.35); border-radius: 8px; background: #1e1e1e; color: #d4d4d4; overflow: hidden; display: flex; flex-direction: column; min-width: 0; max-width: 100%; }",
      ".dsh-live-output-resize { height: 6px; cursor: row-resize; flex: 0 0 auto; background: rgba(255,255,255,.03); }",
      ".dsh-live-output-resize:hover { background: rgba(59,130,246,.45); }",
      ".dsh-live-output-procs { display: flex; flex-wrap: wrap; align-content: flex-start; gap: 4px; padding: 6px; border-bottom: 1px solid rgba(128,128,128,.25); overflow-y: auto; flex: 0 0 auto; min-width: 0; }",
      ".dsh-live-output-proc { padding: 3px 8px; border-radius: 4px; background: rgba(255,255,255,.06); cursor: pointer; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 260px; font-family: var(--dsw-font-mono, var(--ds-font-family-code, ui-monospace, Consolas, 'PingFang SC', 'Microsoft YaHei', monospace)); }",
      ".dsh-live-output-proc.selected { background: rgba(59,130,246,.35); }",
      ".dsh-live-output-proc.finished { opacity: .55; }",
      ".dsh-live-output-head { padding: 3px 10px; color: #9ca3af; border-bottom: 1px solid rgba(128,128,128,.15); flex: 0 0 auto; white-space: pre-wrap; word-break: break-all; overflow-y: auto; min-width: 0; font-family: var(--dsw-font-mono, var(--ds-font-family-code, ui-monospace, Consolas, 'PingFang SC', 'Microsoft YaHei', monospace)); }",
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

    // git 系列输出（show/diff/log/status 等）行型着色：git 在非 TTY 管道下
    // 默认不带 ANSI 颜色，这里按行型结构补色（L1）。
    var GIT_STYLES = {
      header: { color: "#29b8db", fontWeight: "bold" },   // diff --git
      meta: { color: "#6b7280" },                          // index / \ No newline
      fileOld: { color: "#f14c4c", fontWeight: "bold" },   // --- a/x
      fileNew: { color: "#23d18b", fontWeight: "bold" },   // +++ b/x
      hunk: { color: "#3b8eea" },                          // @@ -1,4 +1,5 @@
      add: { color: "#23d18b" },                           // +行
      del: { color: "#f14c4c" },                           // -行
      commitHash: { color: "#e5e510", fontWeight: "bold" },// commit <hash>
      commitMeta: { color: "#9ca3af" },                    // Author:/Date:/Merge:
      stat: { color: "#9ca3af" },                          // N files changed ...
      statusTitle: { color: "#29b8db", fontWeight: "bold" },// On branch / Changes not staged
      statusModified: { color: "#e5e510" },
      statusNew: { color: "#23d18b" },
      statusDeleted: { color: "#f14c4c" },
      statusClean: { color: "#23d18b" }
    };

    /** git 行型分类：命中返回 style，否则 null（随后回退关键词高亮）。 */
    function gitLineClassify(line) {
      if (/^diff --git /.test(line)) return GIT_STYLES.header;
      if (/^index [0-9a-f]{7,}\.\.[0-9a-f]{7,}/.test(line)) return GIT_STYLES.meta;
      if (/^--- /.test(line)) return GIT_STYLES.fileOld;
      if (/^\+\+\+ /.test(line)) return GIT_STYLES.fileNew;
      if (/^@@ -\d/.test(line)) return GIT_STYLES.hunk;
      if (/^\\ No newline/.test(line)) return GIT_STYLES.meta;
      if (/^commit [0-9a-f]{7,40}/.test(line)) return GIT_STYLES.commitHash;
      if (/^(Author|Date|Commit|Merge):/.test(line)) return GIT_STYLES.commitMeta;
      if (/^\s*\d+ files? changed,/.test(line)) return GIT_STYLES.stat;
      if (/^On branch |^Your branch /.test(line)) return GIT_STYLES.statusTitle;
      if (/^Changes (not staged|to be committed)/.test(line)) return GIT_STYLES.statusTitle;
      if (/^\s*modified:/.test(line)) return GIT_STYLES.statusModified;
      if (/^\s*new file:/.test(line)) return GIT_STYLES.statusNew;
      if (/^\s*deleted:/.test(line)) return GIT_STYLES.statusDeleted;
      if (/^nothing to commit/.test(line)) return GIT_STYLES.statusClean;
      return null;
    }

    /** 是否启用 git 行型着色：命令感知（主）+ 文本结构门控（兜底，防止普通输出误伤）。 */
    function gitMode(command, text) {
      if (typeof command === "string" && /\bgit\b/.test(command) &&
          /(show|diff|log|status|pull|fetch|merge|cherry-pick|stash|blame|range-diff|rebase)/.test(command)) {
        return true;
      }
      if (/(^|\n)diff --git /.test(text)) return true;
      if (/^@@ -\d/m.test(text)) return true;
      if (/^commit [0-9a-f]{7,40}/m.test(text)) return true;
      if (/^On branch /m.test(text)) return true;
      return false;
    }

    // L2：代码自动着色——轻量行级 tokenizer（零依赖）。命令感知触发：
    // cat/type/more/Get-Content/gc 等“显示文件内容”的命令输出按代码着色，
    // 普通命令不受影响。
    var CODE_STYLES = {
      keyword: { color: "#569cd6" },   // 关键字
      string: { color: "#ce9178" },    // 字符串
      comment: { color: "#6a9955" },   // 注释
      number: { color: "#b5cea8" }     // 数字
    };
    var CODE_KEYWORD_RE = /^(function|class|return|def|import|from|for|while|if|else|elif|switch|case|break|continue|const|let|var|new|this|try|catch|finally|throw|async|await|yield|lambda|struct|enum|interface|extends|implements|public|private|protected|static|void|int|float|double|bool|type|namespace|using|package|require|export|default|true|false|True|False|None|null|nil|undefined|and|or|not|in|is|as|with|pass|raise|except|print|echo|exit|do)$/;
    var CODE_WORD_RE = /[A-Za-z_$][A-Za-z0-9_$]*/;
    var CODE_NUM_RE = /^(0x[0-9a-fA-F]+|\d+(\.\d+)?)/;

    /** 单行轻量 token 化：字符串/注释/数字/关键字分段，返回 [{text, style}]。 */
    function renderCodeLine(line) {
      var frags = [];
      var i = 0;
      var n = line.length;
      var plainStart = 0;
      function flushPlain(end) {
        if (end > plainStart) frags.push({ text: line.slice(plainStart, end), style: null });
      }
      while (i < n) {
        var ch = line[i];
        if (ch === "'" || ch === '"' || ch === "`") {
          flushPlain(i);
          var j = i + 1;
          while (j < n) {
            if (line[j] === "\\") { j += 2; continue; }
            if (line[j] === ch) { j++; break; }
            j++;
          }
          frags.push({ text: line.slice(i, j), style: CODE_STYLES.string });
          i = j;
          plainStart = j;
          continue;
        }
        if (ch === "#") {
          flushPlain(i);
          frags.push({ text: line.slice(i), style: CODE_STYLES.comment });
          return frags;
        }
        if (ch === "/" && line[i + 1] === "/" && line[i - 1] !== ":") {
          flushPlain(i);
          frags.push({ text: line.slice(i), style: CODE_STYLES.comment });
          return frags;
        }
        if (ch === "-" && line[i + 1] === "-" && /^\s*--/.test(line)) {
          flushPlain(i);
          frags.push({ text: line.slice(i), style: CODE_STYLES.comment });
          return frags;
        }
        if (ch >= "0" && ch <= "9") {
          flushPlain(i);
          var m = CODE_NUM_RE.exec(line.slice(i));
          var len = m ? m[0].length : 1;
          frags.push({ text: line.slice(i, i + len), style: CODE_STYLES.number });
          i += len;
          plainStart = i;
          continue;
        }
        if (/[A-Za-z_$]/.test(ch)) {
          var wm = CODE_WORD_RE.exec(line.slice(i));
          var word = wm ? wm[0] : ch;
          var st = CODE_KEYWORD_RE.test(word) ? CODE_STYLES.keyword : null;
          if (st !== null) {
            flushPlain(i);
            frags.push({ text: word, style: st });
            i += word.length;
            plainStart = i;
            continue;
          }
          i += word.length;
          continue;
        }
        i++;
      }
      flushPlain(n);
      return frags;
    }

    /** 是否启用代码着色：命令感知；超长文本退化（防 token 化开销）。 */
    function codeMode(command, text) {
      if (text.length > 32 * 1024) return false;
      return typeof command === "string" &&
        /(^|[\s;&|])(cat|type|more)(\s|$)|Get-Content|(^|[\s;&|])gc(\s|$)/.test(command);
    }

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

    /** 无 ANSI 的普通文本：git 行型 → 代码 token 级 → diff 前缀 → 关键词。 */
    function renderPlain(text, gitEnabled, codeEnabled) {
      var nodes = [];
      var lines = text.split("\n");
      for (var i = 0; i < lines.length; i++) {
        var line = lines[i].replace(/\r$/, "");
        if (i > 0) nodes.push(e("span", { key: "n" + (colorKey++), style: undefined }, "\n"));
        if (line === "") continue;
        if (codeEnabled && !gitEnabled) {
          var frags = renderCodeLine(line);
          for (var f = 0; f < frags.length; f++) {
            if (frags[f].text === "") continue;
            nodes.push(e("span", { key: "n" + (colorKey++), style: frags[f].style ?? undefined }, frags[f].text));
          }
          continue;
        }
        var style = null;
        if (gitEnabled) {
          style = gitLineClassify(line);
          if (style === null && /^\+[^+]/.test(line)) style = GIT_STYLES.add;
          if (style === null && /^-[^-]/.test(line)) style = GIT_STYLES.del;
        }
        if (style === null) {
          for (var p = 0; p < LINE_PATTERNS.length; p++) {
            if (LINE_PATTERNS[p].re.test(line)) { style = LINE_PATTERNS[p].style; break; }
          }
        }
        nodes.push(e("span", { key: "n" + (colorKey++), style: style ?? undefined }, line));
      }
      return nodes;
    }

    var RENDER_LIMIT = 64 * 1024;
    /** 渲染输出文本：含 ANSI 走 ANSI 着色，否则 git/代码/关键词高亮；超长只渲染尾部。 */
    function renderOutput(text, command) {
      var gitEnabled = gitMode(command, text);
      var codeEnabled = gitEnabled ? false : codeMode(command, text);
      if (text.indexOf("\x1b") !== -1) {
        if (text.length > RENDER_LIMIT) {
          return [e("span", { key: "cut", style: { color: "#6b7280" } }, "…(\u66f4\u65e9\u8f93\u51fa\u5df2\u7701\u7565)\n")].concat(renderAnsi(text.slice(text.length - RENDER_LIMIT)));
        }
        return renderAnsi(text);
      }
      if (text.length > RENDER_LIMIT) {
        return [e("span", { key: "cut", style: { color: "#6b7280" } }, "…(\u66f4\u65e9\u8f93\u51fa\u5df2\u7701\u7565)\n")].concat(renderPlain(text.slice(text.length - RENDER_LIMIT), gitEnabled, codeEnabled));
      }
      return renderPlain(text, gitEnabled, codeEnabled);
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
      var panelRef = useRef(null);
      var toggleRowRef = useRef(null);
      var dragHRef = useRef(null); // 拖动中的视觉高度（null = 未拖动）

      // 面板为文档流元素，宽度由 root CSS 与官方发送框卡片对齐，无需测量

      /** 查找发送框下方统计栏行容器（文本特征“N 轮 · M 步”）。 */
      function findStatsRow() {
        var nodes = document.querySelectorAll("div, span");
        for (var i = 0; i < nodes.length; i++) {
          var n = nodes[i];
          if (n.children.length > 0) continue;
          var t = n.textContent || "";
          if (/\u8f6e\s*\u00b7\s*\d+\s*\u6b65/.test(t) && n.getBoundingClientRect().height > 0) {
            return n.parentElement || n;
          }
        }
        return null;
      }

      /** 官方发送框卡片（data-composer-card 为官方显式属性，比哈希类名稳定）。 */
      function findComposerCard() {
        return document.querySelector("[data-composer-card]");
      }
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
          // v2：默认/最小固定为一行的 28px，列表不再随命令数量膨胀
          var saved = parseInt(localStorage.getItem("dsh-live-output:listHeight.v2"), 10);
          return saved >= 28 && saved <= 320 ? saved : 28;
        } catch (err) {
          return 28;
        }
      });
      var listH = listHState[0];
      var setListH = listHState[1];
      var headHState = useState(function () {
        try {
          // v2：默认/最小改为一行的 28px（旧键 84 三行默认值不再沿用）
          var saved = parseInt(localStorage.getItem("dsh-live-output:headHeight.v2"), 10);
          return saved >= 28 && saved <= 240 ? saved : 28;
        } catch (err) {
          return 28;
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
        var pendingH = panelH;
        var card = findComposerCard();
        var stats = findStatsRow();
        var row = toggleRowRef.current;
        // 拖拽期间文档流冻结（不 setState，占位高度不变）：面板视觉层为
        // absolute bottom:0 的内层，实时改 height 让顶边跟手（底边贴视口底不动）；
        // 面板上方的按钮行、发送框、统计栏用 transform 同步上移 Δ——视觉一致、
        // 布局零重排（reflow 根除）。松手一次性提交真实高度并复位 transform。
        function apply(h) {
          var shift = -(h - startH);
          dragHRef.current = h;
          if (panelRef.current) panelRef.current.style.height = h + "px";
          if (row) row.style.transform = "translateY(" + shift + "px)";
          if (card) card.style.transform = "translateY(" + shift + "px)";
          if (stats) stats.style.transform = "translateY(" + shift + "px)";
        }
        apply(startH);
        startDrag(
          ev,
          function (mv) {
            var h = startH + (startY - mv.clientY);
            if (h < 140) h = 140;
            if (h > 640) h = 640;
            pendingH = h;
            apply(h);
          },
          function () {
            dragHRef.current = null;
            if (row) row.style.transform = "";
            if (card) card.style.transform = "";
            if (stats) stats.style.transform = "";
            setPanelH(function () {
              try {
                localStorage.setItem("dsh-live-output:height", String(pendingH));
              } catch (err) {}
              return pendingH;
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
                localStorage.setItem("dsh-live-output:listHeight.v2", String(h));
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
                localStorage.setItem("dsh-live-output:headHeight.v2", String(h));
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

      // 展开时：把面板高度压到视口可用空间（仅内存，不覆盖用户保存值），
      // 保证文档流面板整体可见（面板底不超出视口），再滚入视野兜底。
      // 用 useLayoutEffect 在绘制前同步 clamp，避免首帧以保存高度（可能很大）闪一帧。
      useLayoutEffect(function () {
        if (!isOpen) return;
        var el = panelRef.current;
        if (!el) return;
        var rootEl = el.parentElement;
        var rr = rootEl ? rootEl.getBoundingClientRect() : null;
        if (rr) {
          // 面板顶 = root 内按钮行下方，底部留 8px 边距
          var avail = window.innerHeight - rr.bottom - 14;
          if (avail < 140) avail = 140;
          if (panelH > avail) setPanelH(avail);
        }
        var raf = requestAnimationFrame(function () {
          var el2 = panelRef.current;
          if (el2) el2.scrollIntoView({ block: "nearest" });
        });
        return function () { cancelAnimationFrame(raf); };
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
          es.onopen = function () {
            // 不清空本地文本：重连时服务端按 offset 幂等重发（见 onmessage delta），
            // 清空会导致内容塌缩、scrollTop 归零并触发滚底，破坏用户阅读位置。
            if (!closed) setConn("open");
          };
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
                var cur = prev[msg.id] || "";
                if (msg.offset !== undefined && msg.offset !== null) {
                  // 从 offset 起替换（幂等）：重连全量重发（offset 0）得到相同字符串，
                  // React 跳过渲染且不触发滚底；增量（offset=当前长度）等价追加；
                  // 丢帧（offset<当前长度）截断重建。offset 缺失时退回追加。
                  next[msg.id] = cur.slice(0, msg.offset) + msg.text;
                } else {
                  next[msg.id] = cur + msg.text;
                }
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

      // 展开时无条件滚到底（初始显示最新输出，而非开头）
      useEffect(function () {
        if (!isOpen) return;
        var el = bodyRef.current;
        if (el) el.scrollTop = el.scrollHeight;
      }, [isOpen]);

      // 输出自动滚底：仅当用户已在底部附近时才跟随；手动上滚阅读历史时不打扰
      useEffect(function () {
        var el = bodyRef.current;
        if (!el) return;
        if (el.scrollHeight - el.scrollTop - el.clientHeight <= 40) {
          el.scrollTop = el.scrollHeight;
        }
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
          body = e("pre", { className: "dsh-live-output-body", ref: bodyRef }, renderOutput(text, selProc ? selProc.command : undefined));
        }

        panel = e(
          "div",
          {
            className: "dsh-live-output-panel-anchor",
            style: { position: "relative", height: panelH + "px" }
          },
          e(
            "div",
            {
              className: "dsh-live-output-panel",
              ref: panelRef,
              style: {
                position: "absolute",
                bottom: 0,
                left: 0,
                right: 0,
                height: (dragHRef.current !== null ? dragHRef.current : panelH) + "px"
              }
            },
          e("div", {
            className: "dsh-live-output-resize",
            onMouseDown: startResize,
            title: "\u62d6\u52a8\u8c03\u6574\u9762\u677f\u9ad8\u5ea6"
          }),
          e("div", {
            className: "dsh-live-output-procs",
            style: { height: listH + "px" }
          }, procNodes),
          e("div", {
            className: "dsh-live-output-resize",
            onMouseDown: startListResize,
            title: "\u62d6\u52a8\u8c03\u6574\u547d\u4ee4\u5217\u8868\u9ad8\u5ea6"
          }),
          selProc !== null
            ? e(
                "div",
                { className: "dsh-live-output-head", style: { height: headH + "px" } },
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
          )
        );
      }

      return e(
        "div",
        { className: "dsh-live-output-root" },
        e(
          "div",
          { ref: toggleRowRef, style: { display: "flex", alignItems: "center", gap: "6px", flexWrap: "wrap" } },
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
