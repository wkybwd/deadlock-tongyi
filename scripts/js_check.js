/**
 * dlchat.js 离线测试台：用桩替换 Panorama API，把 mod 脚本真跑一遍。
 *
 * 为什么需要它：这个 mod 的失败模式几乎全是"游戏里静默失效"——
 *   · 少写一个字段 -> render() 抛异常 -> show() 在发请求前中断 -> 界面永远停在"读取设置…"
 *   · 布局 onactivate 的名字和脚本对不上 -> 按钮点了没反应
 *   · 译文挂错容器 / 没带底色 -> 字画在白色气泡上等于看不见
 *   · 聊天行被游戏回收复用时，上一条的中文留在新消息里
 * 这些都不用进游戏才能发现：本脚本用 Node 跑一遍，离线就能抓住。
 *
 * 跑法：node scripts/js_check.js              （退出码非 0 = 有问题）
 *       node scripts/js_check.js --verbose    （额外打印各钩子的原始输出）
 * 门禁：scripts/stage_compile.py 在打包 VPK 之前会跑它，非 0 拒绝打包。
 *       注意那边的 preflight 只截取 stdout 前 600 个字符 —— 所以"发现问题:"
 *       这一块排在输出的最前面，问题必须先被看见。
 *
 * 覆盖范围（每节各自包 try/catch：单节出错只记问题，不打断整场）：
 *   ① 加载 + 启动：脚本 eval 一遍，把 $.Schedule 排的回调跑到 boot()
 *   ② 布局契约：两个布局里的 onactivate/onmouseactivate/oninputsubmit 都要有对应全局函数
 *   ③ 自检钩子：DLChatSelfTest / Compact / Queue 的输出里不许有 FAIL
 *   ④ 识别层：按官方 snippet 结构造假聊天行，跑真实扫描（谁该翻、谁该跳、同句只排一次）
 *   ⑤ 挂载点：译文挂在哪个容器下、气泡译文有没有内联底色
 *   ⑥ 双语行内：中文拼进游戏自己的正文格 + 悬停原文收起来
 *   ⑦ 行回收复用：同一行换新消息后，正文要重新拼成新消息的双语，旧中文不能留下
 *   ⑧ 入口点：布局里能点的每个按钮/开关/循环都点一遍，并且要真的让面板发生变化
 *   ⑨ 样式守卫：dlchat.css / dlchat.js 里几个"看不见"类问题的硬条件
 *   ⑩ 运行期消息：$.Msg 里出现 failed / 出错 一律算失败
 */

"use strict";

const fs = require("fs");
const path = require("path");

// ---------------------------------------------------------------- 配置
const root = path.resolve(__dirname, "..");
const JS_PATH = path.join(root, "mod", "panorama", "scripts", "dlchat.js");
const CSS_PATH = path.join(root, "mod", "panorama", "styles", "dlchat.css");
const UI_CSS_PATH = path.join(root, "mod", "panorama", "styles", "dlchat-ui.css");
const LAYOUTS = [
  path.join(root, "mod", "panorama", "layout", "chat.xml"),
  path.join(root, "mod", "panorama", "layout", "citadel_hud_top_bar_chat.xml"),
];

const VERBOSE = process.argv.slice(2).some((a) => a === "--verbose" || a === "-v");
// $.Schedule 排出来的回调最多跑几轮（每轮 = 当前排队的全部回调）。脚本的 every()
// 会一直自我续期，没有上限的话测试台自己就成了死循环。
const MAX_CALLBACK_ROUNDS = 60;
// 分隔符选 "pipe" 时脚本拼进正文的字符串（见 dlchat.js 的 ui.SEP_TEXT）
const SEP_PIPE = " | ";
// 头顶气泡译文的内联底色：官方 HUD 样式作用域不一定覆盖注入的标签，必须写死这一层
const BUBBLE_BG = "rgba(20, 52, 96, 0.95)";
// 布局里自带的游戏函数（原版 snippet 的 onactivate，游戏侧提供），不归我们脚本管
const VANILLA_HANDLER = /^Citadel/;
// 脚本必须导出的离线钩子（布局里点不到，但测试台全靠它们）
const REQUIRED_HOOKS = [
  "DLChatSelfTest", "DLChatSelfTestCompact", "DLChatSelfTestQueue",
  "DLChatSelfTestRows", "DLChatSelfTestAttach", "DLChatSelfTestInline",
  "DLChatSelfTestPending", "DLChatSelfTestPendingFail",
  "DLChatSelfTestConnection", "DLChatSelfTestSettlement",
];
// 布局里出现过的设置键都点一遍（解析布局时会补上布局真正绑定的那些键）
const SETTING_KEYS = [
  "receive_enabled", "send_enabled", "display_mode", "outgoing_mode", "separator",
  "trigger", "keep_alive", "glossary", "provider", "show_original_on_hover",
];
// 带参数的 DLChat* 入口：不能当"零参入口"点（拿 undefined 往下跑会得出假结论）
const withArgEntries = new Set(["DLChatToggle", "DLChatCycle", "DLChatSelfTestCompact",
  "DLChatSelfTestProbe", "DLChatSelfTestAttach", "DLChatSelfTestInline"]);

const problems = [];
const seenProblems = new Set();
const messages = [];       // $.Msg 收集（safe() 兜住的入口异常都从这里出来）
const summary = [];        // 每节结论（通过时打印成 ✓ 行）
const sectionStatus = [];  // 每节 ok/FAIL（紧凑报告用）
const details = [];        // 各钩子的原始输出（--verbose 时打印）
let pendingNotes = null;   // 当前小节里攒的结论，小节失败就丢掉

function fail(text) {
  const one = String(text);
  if (seenProblems.has(one)) return;      // 每轮都抛的同一个异常只说一次
  seenProblems.add(one);
  problems.push(one);
}

function expect(label, ok, detail) {
  if (!ok) fail(label + (detail === undefined ? "" : " -> " + detail));
  return !!ok;
}

function note(text) {
  if (pendingNotes) pendingNotes.push(String(text));
  else summary.push(String(text));
}
function show(text) { details.push(String(text)); }

// 每一节都包一层：单节出错只记一条问题，不把整场跑挂掉。
// 出了问题的节，它那句"结论"就不该再打印成 ✓。
function section(name, fn) {
  const before = problems.length;
  const bucket = [];
  pendingNotes = bucket;
  try {
    fn();
  } catch (e) {
    fail("[" + name + "] 抛异常: " + (e && e.message ? e.message : e));
  }
  pendingNotes = null;
  const bad = problems.length - before;
  sectionStatus.push(name + (bad ? " FAIL(" + bad + ")" : " ok"));
  if (!bad) for (const one of bucket) summary.push(one);
}

// 再跑几轮 $.Schedule 回调（入口点里触发的 every()/轮询要靠它推进）
function runCallbacks(rounds) {
  for (let i = 0; i < rounds && scheduled.length; i++) {
    const batch = scheduled.splice(0, scheduled.length);
    for (const fn of batch) {
      try {
        fn();
      } catch (e) {
        fail("$.Schedule 回调抛异常: " + (e && e.message));
      }
    }
  }
}

// ---------------------------------------------------------------- 面板桩
// 这个桩要**像真的 Panorama 面板**，否则识别层的 bug 抓不到：
//   · 真的 GetChildCount/GetChild（脚本按这个遍历子面板）
//   · FindChildTraverse 递归整棵子树（按 id 找）
//   · FindChildrenWithClassTraverse 按 class 找
//   · GetParent 返回真的父面板（脚本用 label.GetParent() === host 判断译文还挂在不在原处）
//   · style 是可写对象（脚本往译文标签上写内联样式，气泡译文全靠它拿到底色）
function makePanel(id, type) {
  const p = {
    id: id || "",
    type: type || "Panel",
    text: "",
    visible: true,
    url: "",
    Children: [],
    style: {},
    _classes: new Set(),
    _events: {},
    _attrs: {},
    _parent: null,
    _w: 120,
    _h: 20,
  };
  p.GetWidth = () => p._w;
  p.GetHeight = () => p._h;
  p.AddClass = (c) => { p._classes.add(c); };
  p.RemoveClass = (c) => { p._classes.delete(c); };
  p.SetHasClass = (c, on) => { if (on) p._classes.add(c); else p._classes.delete(c); };
  p.HasClass = (c) => p._classes.has(c);
  p.BHasClass = (c) => p._classes.has(c);
  p.IsValid = () => true;
  p.IsVisible = () => p.visible !== false;
  p.GetParent = () => p._parent;
  p.GetChildCount = () => p.Children.length;
  p.GetChild = (i) => p.Children[i] || null;
  p.GetAttributeString = (name, def) => (name in p._attrs ? p._attrs[name]
    : (def === undefined ? "" : def));
  p.SetAttributeString = (name, value) => { p._attrs[name] = value; };
  p.SetPanelEvent = (name, fn) => { p._events[name] = fn; };
  p.SetURL = (u) => { p.url = u; };
  p.SetFocus = () => {};
  p.DeleteAsync = () => {};   // 引擎里这个接口实测不生效，桩也照"不生效"来
  p.SetParent = (par) => {
    if (par && Array.isArray(par.Children)) { p._parent = par; par.Children.push(p); }
  };
  p.FindChildTraverse = function (want) {
    if (!want) return null;
    for (const kid of p.Children) {
      if (kid.id === want) return kid;
      const deeper = kid.FindChildTraverse(want);
      if (deeper) return deeper;
    }
    return null;
  };
  p.FindChildrenWithClassTraverse = function (cls) {
    const out = [];
    for (const kid of p.Children) {
      if (kid._classes.has(cls)) out.push(kid);
      out.push(...kid.FindChildrenWithClassTraverse(cls));
    }
    return out;
  };
  return p;
}

// 造一个面板并挂到父面板下（测试台搭"假的游戏聊天行"用）
function build(parent, id, classes, text) {
  const p = makePanel(id);
  if (classes) for (const c of classes) p._classes.add(c);
  if (text !== undefined) { p.text = text; p.type = "Label"; }
  if (parent) { p._parent = parent; parent.Children.push(p); }
  return p;
}

// ---- 树上的小工具（断言用，脚本内部看不到这些） ----
function hasClass(p, cls) { return !!p && p._classes.has(cls); }
function labelsUnder(node) {
  const out = [];
  (function walk(p) {
    if (!p) return;
    if (p.type === "Label") out.push(p);
    for (const kid of p.Children) walk(kid);
  })(node);
  return out;
}
function isInside(node, ancestor) {
  let p = node;
  while (p) {
    if (p === ancestor) return true;
    p = p.GetParent();
  }
  return false;
}
function labelWithClass(node, cls) {
  const hit = labelsUnder(node).filter((l) => hasClass(l, cls));
  return hit.length ? hit[0] : null;
}
function rowAllText(row) {
  return labelsUnder(row).map((l) => String(l.text || "")).join(" | ");
}
// 设置面板的"指纹"：点了开关以后它必须变（键名和脚本的表对不上时什么都不变）。
// 取整棵假 DOM 的文字（不按 type 过滤：脚本是直接写 panel.text 的）。
function settingsFingerprint() {
  const out = [];
  (function walk(p) {
    out.push(p.id + "=" + p.text);
    for (const kid of p.Children) walk(kid);
  })(contextPanel);
  return out.join("|");
}

// ---------------------------------------------------------------- 假 DOM
// 节点结构和 id 都照 mod/panorama/layout 下的真实布局搭：
//   · 聊天窗行容器 #ChatMessages（chat.xml: ChatLinesArea > ChatLinesWrapper > ChatMessages）
//   · 头顶气泡容器 #Messages（citadel_hud_top_bar_chat.xml: CitadelHudTopBarChat > Panel#Messages）
//   · 隐藏 HTML 桥面板 #DLChatBridge（**必须造出来**：脚本找不到它会把每个请求判成
//     no_bridge_panel 直接退回，表现是"一行都没翻"，而且看不出是测试台的锅）
//   · 输入框 #ChatInput / 状态标签 #DLChatStatus / 状态灯 #DLChatDot
//   · 设置面板：**布局里声明的每个 id 都建一个**，这样脚本和布局的 id 对不上时，
//     会表现成"标签没被写进去"（能被断言抓到），而不是静默跳过。
const contextPanel = makePanel("ctx");
const bridgePanel = build(contextPanel, "DLChatBridge", ["DLChatBridge"]);
bridgePanel.type = "HTML";
build(contextPanel, "DLChatStatus", ["DLChatStatus"], "dlchat");
const chatLinesArea = build(contextPanel, "ChatLinesArea");
const chatLinesWrapper = build(chatLinesArea, "ChatLinesWrapper");
const chatBox = build(chatLinesWrapper, "ChatMessages");
const topBar = build(contextPanel, "CitadelHudTopBarChat", ["CitadelHudTopBarChat"]);
const bubbleBox = build(topBar, "Messages");
const controls = build(contextPanel, "ChatControls");
const chatInput = build(controls, "ChatInput", [], "");
chatInput.type = "TextEntry";
build(controls, "DLChatDot", ["DLChatDot"]);

// 布局里声明的其余 id（设置面板那一堆）平铺到一个节点下
const MANUAL_IDS = new Set(["ChatMessages", "Messages", "ChatInput", "DLChatBridge",
  "ChatLinesArea", "ChatLinesWrapper", "DLChatStatus", "DLChatDot", "ChatControls",
  "CitadelHudTopBarChat"]);
const layoutHost = build(contextPanel, "DLChatLayoutIds");
const layoutIds = new Set();
const layoutElems = new Map();         // id -> {tag, text}（照布局里的元素类型建，别都当 Panel）
const layoutHandlers = new Set();      // 布局里的 onactivate/onmouseactivate/oninputsubmit
const layoutKeys = {};                 // {DLChatToggle: Set(键), DLChatCycle: Set(键)}
const layoutFiles = [];
for (const file of LAYOUTS) {
  if (!fs.existsSync(file)) { fail("布局文件不存在: " + file); continue; }
  const xml = fs.readFileSync(file, "utf8");
  layoutFiles.push({ file: file, xml: xml });
  for (const m of xml.matchAll(/\bid="([^"]+)"/g)) layoutIds.add(m[1]);
  for (const m of xml.matchAll(/<([A-Za-z][\w]*)\b([^>]*?)\bid="([^"]+)"([^>]*)>/g)) {
    if (layoutElems.has(m[3])) continue;
    const attrs = (m[2] || "") + " " + (m[4] || "");
    const text = attrs.match(/\btext="([^"]*)"/);
    layoutElems.set(m[3], { tag: m[1], text: text ? text[1] : undefined });
  }
  for (const m of xml.matchAll(/on(?:activate|mouseactivate|inputsubmit)="([A-Za-z_][\w]*)\(/g)) {
    layoutHandlers.add(m[1]);
  }
  // 布局里把哪个键绑到了哪个函数上（这就是"这个函数接受哪些键"的权威答案）
  for (const m of xml.matchAll(/(DLChat(?:Toggle|Cycle))\('([^']+)'\)/g)) {
    if (!layoutKeys[m[1]]) layoutKeys[m[1]] = new Set();
    layoutKeys[m[1]].add(m[2]);
  }
}
for (const id of layoutIds) {
  if (MANUAL_IDS.has(id)) continue;
  const spec = layoutElems.get(id) || { tag: "Panel" };
  const p = build(layoutHost, id);
  p.type = spec.tag;                        // 布局里是 Label 就建成 Label（脚本按 type 认标签）
  if (spec.text !== undefined) p.text = spec.text;
}
const pokeKeys = Array.from(new Set([...SETTING_KEYS,
  ...Object.values(layoutKeys).flatMap((s) => Array.from(s))]));

// ---------------------------------------------------------------- $. 桩
const scheduled = [];         // $.Schedule 排的回调（boot 就靠它启动）
const deferredTimeouts = [];  // 长看门狗不在下一轮立即执行（离线轮次不代表真实时间）
const unhandledEvents = {};   // RegisterForUnhandledEvent 注册的事件
const keyBinds = [];          // RegisterKeyBind 结果（F8 热键能不能绑上看它）

global.$ = {
  GetContextPanel: () => contextPanel,
  Schedule: (seconds, fn) => {
    if (typeof fn !== "function") return;
    if (seconds >= 30) deferredTimeouts.push(fn);
    else scheduled.push(fn);
  },
  CreatePanel: (type, parent, id) => {
    const p = makePanel(id, type);
    if (parent && Array.isArray(parent.Children)) { p._parent = parent; parent.Children.push(p); }
    return p;
  },
  RegisterForUnhandledEvent: (name, fn) => {
    if (!unhandledEvents[name]) unhandledEvents[name] = [];
    unhandledEvents[name].push(fn);
  },
  RegisterKeyBind: (first, key, fn) => { keyBinds.push({ key: key }); },
  DispatchEvent: () => {},
  Msg: (m) => messages.push(String(m)),
  // 引擎现状：函数在、但一调用就同步抛（panorama.dll: "AsyncWebRequest has been removed."）。
  // 桩必须照抄这个行为 —— 脚本"探测直连通道"那段逻辑就是为它写的。
  AsyncWebRequest: () => { throw new Error("AsyncWebRequest has been removed"); },
};

// ---------------------------------------------------------------- 脚本里的定位信息
// ✗ 信息里带上"这条断言对应 dlchat.js 的哪个函数"，省得再去翻文件（行号这里现算，不会过期）
let jsSource = "";
try { jsSource = fs.readFileSync(JS_PATH, "utf8"); } catch (e) { /* 下面会报 */ }
function jsRef(symbol) {
  const lines = jsSource.split("\n");
  for (let i = 0; i < lines.length; i++) {
    if (new RegExp("function\\s+" + symbol + "\\s*\\(").test(lines[i])) {
      return "dlchat.js:" + (i + 1) + " " + symbol + "()";
    }
  }
  return "dlchat.js " + symbol + "()";
}

// ---------------------------------------------------------------- 钩子小工具
function hook(name) {
  return typeof globalThis[name] === "function" ? globalThis[name] : null;
}
function selfTest(name, arg) {
  const fn = hook(name);
  if (!fn) { fail("缺少钩子 " + name + "（离线测试台需要它）"); return ""; }
  let out = "";
  try {
    out = String(fn(arg));
  } catch (e) {
    fail(name + " 抛异常: " + (e && e.message));
    return "";
  }
  show(name + ": " + out);
  for (const part of out.split("|")) {
    if (part.indexOf("FAIL") !== -1) fail(name + " 自检项失败 -> " + part.trim());
  }
  return out;
}
// DLChatSelfTestRows() 的输出格式（dlchat.js 里定的，别随便改）：
//   rows=6(+1) translated=4,own_message=1 | queued=["push"] | detail={...}
function parseRows(out) {
  const res = { total: -1, delta: -1, counts: {}, queued: [] };
  const head = String(out).split("|")[0] || "";
  const m = head.match(/rows=(\d+)\(\+(\d+)\)/);
  if (m) { res.total = Number(m[1]); res.delta = Number(m[2]); }
  for (const part of head.replace(/^rows=\d+\(\+\d+\)/, "").split(",")) {
    const kv = part.trim().match(/^([A-Za-z_]+)=(\d+)$/);
    if (kv) res.counts[kv[1]] = Number(kv[2]);
  }
  const q = String(out).match(/queued=(\[[^\]]*\])/);
  if (q) { try { res.queued = JSON.parse(q[1]); } catch (e) { res.queued = []; } }
  return res;
}
// 跑一次真实扫描（scanAllSurfaces），把脚本自己的报告解析出来
function rowsReport(label) {
  const fn = hook("DLChatSelfTestRows");
  if (!fn) return { out: "", total: -1, delta: -1, counts: {}, queued: [] };
  let out = "";
  try {
    out = String(fn());
  } catch (e) {
    fail("[" + label + "] 扫描抛异常: " + (e && e.message));
    return { out: "", total: -1, delta: -1, counts: {}, queued: [] };
  }
  show(label + ": " + out);
  const parsed = parseRows(out);
  parsed.out = out;
  return parsed;
}
function probeRow(row) {
  const fn = hook("DLChatSelfTestProbe");
  if (!fn || !row) return "(无探针)";
  try { return String(fn(row)); } catch (e) { return "探针抛异常:" + e; }
}

// ---------------------------------------------------------------- 假聊天行
// 结构照官方 snippet（mod/panorama/layout/chat.xml 的 <snippets>，与游戏原版一致）：
//   ChatMessage(类) > MessageBody > [MessageSource[id] > ChannelName + SenderName]
//                              + [MessageContents[id] > Panel.Text > Label]
// 注意正文那个 Label **没有 id**（原版 snippet 就是裸的 <Label text="{s:message_text}"/>），
// 所以脚本必须从 MessageContents 整棵子树收字 —— 测试台也照这个结构造。
function buildChatRow(container, opts) {
  const o = opts || {};
  const row = build(container, "", ["ChatMessage"]);
  const body = build(row, "", ["MessageBody"]);
  const source = build(body, "MessageSource");
  build(source, "", ["ChannelName"], o.channel || "[ALL]");
  build(source, "", ["SenderName"], o.sender || "Someone");
  if (o.localClient) build(source, "", ["SenderLocalClient"]);
  const contents = build(body, "MessageContents");
  let cell = null;
  if (o.ping) {
    build(contents, "", ["Ping"]);
    build(contents, "PingLabel", [], o.text);
  } else {
    const textPanel = build(contents, "", ["Text"]);
    cell = build(textPanel, "", [], o.text);
  }
  return { row: row, contents: contents, cell: cell };
}

// 头顶气泡行，照 citadel_hud_top_bar_chat.xml 的 snippet：
//   ChatMessage > #MessageContents > .ChatBubble > .TextContainer > .MessageWrapper > #MessageText
function buildBubbleRow(container, opts) {
  const o = opts || {};
  const row = build(container, "", ["ChatMessage"]);
  row.AddClass(o.messageType || "MessageType_Text");
  const contents = build(row, "MessageContents");
  const bubble = build(contents, "", ["ChatBubble"]);
  const textContainer = build(bubble, "", ["TextContainer"]);
  build(textContainer, "", ["bubble_bg"]);
  const wrapper = build(textContainer, "", ["MessageWrapper"]);
  let textLabel = null;
  if (o.messageType === "MessageType_PlayerTyping") {
    const anim = build(wrapper, "TypingAnim");
    for (let i = 1; i <= 3; i++) build(anim, "TypingDot" + i, ["dot"]);
  } else {
    build(wrapper, "TargetHeroImage").type = "Image";
    textLabel = build(wrapper, "MessageText", [], o.text || "");
    build(contents, "PingStyleIcon", ["PingStyle"]).type = "Image";
    const subject = build(contents, "", ["SubjectWrapper"]);
    const bg = build(subject, "SubjectIconBG", ["IconBG"]);
    build(bg, "SubjectIcon").type = "Image";
    build(bg, "", ["corrupted_frame"]);
    const cooldown = build(subject, "CooldownTimer");
    build(cooldown, "CooldownText", [], o.cooldown || "");
  }
  if (o.localClient) build(row, "", ["SenderLocalClient"]);
  return { row: row, contents: contents, bubble: bubble, textContainer: textContainer,
    textLabel: textLabel };
}

// 大厅/展开聊天行，照 readMessageRow 的第三套结构：
//   ChatLinesPanel > ChatLineContainer(类) > ChatLine(类) + ChatPersona(类)
// 注意：这个容器**临时挂上、验完就摘**（见"翻译中占位"那一节）。它是三个界面里
// 唯一没被别的用例用到的，常驻的话扫描会每次都把这几行排进翻译，给别的断言添噪音。
const lobbyBox = build(contextPanel, "ChatLinesPanel");
function buildLobbyRow(container, opts) {
  const o = opts || {};
  const row = build(container, "", ["ChatLineContainer"]);
  build(row, "", ["ChatLine"], o.text);
  build(row, "", ["ChatPersona"], o.sender || "Someone");
  return { row: row };
}

// 往脚本自己的译文缓存里塞一条：走 DLChatSelfTestInline（它先 cachePut，再走正常的
// "命中缓存"路径），所以后面不需要桥。种子行放在**扫描容器之外**，免得污染被测行。
const seedHost = build(contextPanel, "DLChatSeedRows");
let seedSeq = 0;
let bubbleRowForAttach = null;      // 识别层造的那条气泡行，挂载点那一节接着用
function seedTranslation(text, chinese) {
  const fn = hook("DLChatSelfTestInline");
  if (!fn) return false;
  const seed = buildChatRow(seedHost, { sender: "Seed" + (++seedSeq), text: text });
  fn(seed.row, text, chinese);
  return true;
}

// ================================================================ ① 加载 + 启动
section("加载", function () {
  if (!jsSource) { fail("读不到 mod 脚本: " + JS_PATH); return; }
  if (jsSource.charCodeAt(0) === 0xfeff) fail("dlchat.js 带 BOM（Panorama 侧会出问题）");
  try {
    eval(jsSource);   // eslint-disable-line no-eval
  } catch (e) {
    fail("脚本加载即抛异常: " + (e && e.message));
  }
});

section("启动", function () {
  let ran = 0;
  for (let round = 0; round < MAX_CALLBACK_ROUNDS && scheduled.length; round++) {
    const batch = scheduled.splice(0, scheduled.length);
    for (const fn of batch) {
      ran += 1;
      try {
        fn();
      } catch (e) {
        fail("$.Schedule 回调抛异常: " + (e && e.message));
      }
    }
  }
  expect("启动: 脚本必须排出 $.Schedule 回调（boot 靠它启动）", ran > 0, "回调 0 个");
  const missing = REQUIRED_HOOKS.filter((k) => typeof globalThis[k] !== "function");
  expect("启动: boot 跑通之后必须导出全部离线钩子", missing.length === 0, "缺 " + missing.join(","));
  const busProbe = hook("DLChatSelfTestBus");
  if (busProbe) show("传输层: " + String(busProbe()));
  const statusEl = contextPanel.FindChildTraverse("DLChatStatus");
  const statusText = statusEl ? String(statusEl.text) : "";
  expect("启动: 状态标签必须被脚本写过（还是布局初值 = boot 没跑到底）",
    statusText !== "dlchat", "DLChatStatus=" + JSON.stringify(statusText));
  expect("启动: 状态标签里不能出现脚本错误", statusText.indexOf("脚本错误") === -1, statusText);
  note("启动：脚本加载 + boot 跑通（" + ran + " 个 $.Schedule 回调，"
    + Object.keys(unhandledEvents).length + " 个面板事件，热键绑定 " + keyBinds.length + " 次）");
});

// ================================================================ ② 布局契约
section("布局契约", function () {
  const chatLayout = layoutFiles.find((item) => item.file === LAYOUTS[0]);
  expect("布局契约: 设置界面的样式必须由聊天布局加载",
    !!chatLayout && chatLayout.xml.indexOf("panorama/styles/dlchat-ui.vcss_c") !== -1
      && fs.existsSync(UI_CSS_PATH), "dlchat-ui.css 未加载或不存在");
  if (chatLayout && fs.existsSync(UI_CSS_PATH)) {
    const xml = chatLayout.xml;
    const css = fs.readFileSync(UI_CSS_PATH, "utf8");
    const panelRule = css.match(/\.DLChatSettings\s*\{([^}]*)\}/);
    const bodyRule = css.match(/\.DLChatSetBody\s*\{([^}]*)\}/);
    const saveLabelRule = css.match(/\.DLChatBtnPrimary Label\s*\{([^}]*)\}/);
    expect("布局契约: 保存按钮必须位于滚动区之前的固定页头",
      xml.indexOf('id="DLChatSetSave"') > 0
        && xml.indexOf('id="DLChatSetSave"') < xml.indexOf('class="DLChatSetBody"'),
      "保存按钮可能被内容区挤出屏幕");
    expect("布局契约: 内容区必须占用固定面板的剩余高度并滚动",
      !!panelRule && /\bheight\s*:\s*\d+px\s*;/.test(panelRule[1])
        && !!bodyRule && /height\s*:\s*fill-parent-flow\(1\.0\)/.test(bodyRule[1])
        && /overflow\s*:\s*squish scroll/.test(bodyRule[1]),
      "面板高度或内容区滚动约束缺失");
    expect("布局契约: 保存按钮文字必须水平和垂直居中",
      !!saveLabelRule && /horizontal-align\s*:\s*center/.test(saveLabelRule[1])
        && /vertical-align\s*:\s*center/.test(saveLabelRule[1]),
      "保存按钮文字可能贴在左上角");
  }
  const ours = [];
  for (const name of layoutHandlers) {
    if (VANILLA_HANDLER.test(name)) continue;      // 原版自带函数，跳过
    ours.push(name);
    expect("布局入口 " + name + "(): 脚本里没有这个全局函数（按钮点了没反应）",
      typeof globalThis[name] === "function", "typeof=" + typeof globalThis[name]);
  }
  expect("布局契约: 两个布局里至少要解析出我们自己的入口", ours.length > 0, "0 个");
  // 脚本按名字找的面板 id，布局里必须都有（少一个 = 那块界面永远不更新/点了没反应）。
  // id 直接从脚本里抽，不写死清单：两边一起改名时这里不会假报。
  const scriptIds = new Set();
  for (const m of jsSource.matchAll(/(?:\.el|setText|FindChildTraverse)\("(DLChat[A-Za-z0-9_]*)"\)/g)) {
    scriptIds.add(m[1]);
  }
  const missIds = Array.from(scriptIds).filter((id) => !layoutIds.has(id));
  expect("布局契约: 脚本按名字找的面板 id 必须都在布局里", missIds.length === 0,
    "布局里找不到: " + missIds.join(", "));
  show("布局入口: 共 " + layoutHandlers.size + " 个，我们自己的 " + ours.length + " 个："
    + ours.slice().sort().join(", "));
  show("布局设置键: " + Array.from(layoutKeys).sort().join(", "));
  note("布局契约：" + layoutHandlers.size + " 个布局入口（我们的 " + ours.length
    + " 个）全部已注册，设置面板 id 齐全");
});

// ================================================================ ③ 脚本自检钩子
section("自检钩子", function () {
  selfTest("DLChatSelfTest");
  // 喂一份**真实的 compact 响应**（短键）：桥为了省 HTML 标题通道的长度把字段名压成了
  // 一个词，两端对不上就是"设置全丢"，只有真喂一次才抓得住。
  // 必须自洽：密钥没配（keySet:false）+ 云端来源（prv:"d"），面板才会显示"没配 Key"那句；
  // sep 用桥真正发的单字母码 p/f/s（p=pipe），面板据此选出分隔符。
  const compact = {
    ok: true, up: true, recv: true, send: true, disp: "bilingual", out: "bilingual",
    hover: true, trig: "double_space", keep: "-1", gloss: true, sep: "p",
    prv: "d", model: "deepseek-flash", keySet: false, persisted: true,
    req: 7, hit: 3, latIn: 812, latOut: 210, vram: -1, loaded: true,
  };
  selfTest("DLChatSelfTestCompact", compact);
  selfTest("DLChatSelfTestQueue");
  selfTest("DLChatSelfTestConnection");
  selfTest("DLChatSelfTestSettlement");
  // 状态行必须真的被写进布局里那个标签（脚本和布局的 id 对不上时这里是空的）
  const st = contextPanel.FindChildTraverse("DLChatSetStatus");
  const stText = st ? String(st.text) : "";
  expect("自检钩子: 设置面板状态行要显示桥信息（布局 id 对不上时这里是空的）",
    stText.indexOf("Key") !== -1, "DLChatSetStatus=" + JSON.stringify(stText));
  note("自检钩子：设置短键、队列与连接状态全部无 FAIL");
});

// ================================================================ ④ 识别层
section("识别层", function () {
  if (!hook("DLChatSelfTestRows")) return;
  // ① 别人说英文：必须排进翻译
  const mine = buildChatRow(chatBox, { sender: "Enemy", text: "mid no" });
  const r1 = rowsReport("识别-别人说话");
  expect("识别层: 别人说的英文要排进翻译", (r1.counts.translated || 0) === 1
    && r1.queued.indexOf("mid no") !== -1, r1.out);
  expect("识别层: 英文消息不该被判成 not_english", !r1.counts.not_english, r1.out);
  show("探针(别人说话): " + probeRow(mine.row));

  // ② 我自己发的（引擎标记 SenderLocalClient）：跳过，否则就是自己翻自己
  buildChatRow(chatBox, { sender: "Me", text: "b", localClient: true });
  const r2 = rowsReport("识别-自己发的");
  expect("识别层: 自己发的（SenderLocalClient 标记）不能翻", (r2.counts.own_message || 0) === 1,
    r2.out);
  expect("识别层: 自己发的消息不能被排进翻译", r2.queued.indexOf("b") === -1, r2.out);

  // ③ 游戏自带的 Ping/快捷语：游戏已经本地化过了，再翻一遍就是重复翻
  buildChatRow(chatBox, { sender: "Mate", text: "敌人消失！", ping: true });
  const r3 = rowsReport("识别-快捷语");
  expect("识别层: MessageContents 带 Ping 类的行要跳过", (r3.counts.quick_chat || 0) === 1,
    r3.out);

  // ④ 同一句出现两次：只发一次请求（客户端去重 + 同句 single-flight）
  buildChatRow(chatBox, { sender: "A", text: "push" });
  buildChatRow(chatBox, { sender: "B", text: "push" });
  const r4 = rowsReport("识别-同句两次");
  const pushes = r4.queued.filter((t) => t === "push").length;
  expect("识别层: 同一句出现两次只该排一次翻译", pushes === 1,
    "排了 " + pushes + " 次 -> " + r4.out);

  // ⑤ 增量扫描：容器没变化时不该重复处理
  const r5 = rowsReport("识别-重复扫描");
  expect("识别层: 没有新行时第二次扫描不该处理新东西", r5.delta === 0, "增量 (+" + r5.delta + ")");

  // ⑥ 头顶气泡完全另一套结构，也必须认出来
  const bub = buildBubbleRow(bubbleBox, { text: "he is low" });
  const r6 = rowsReport("识别-头顶气泡");
  expect("识别层: 气泡行也要被认出来并排进翻译",
    r6.queued.indexOf("he is low") !== -1, r6.out);
  expect("识别层: 气泡行的 surface 要是 bubble", r6.out.indexOf('"s":"bubble"') !== -1, r6.out);
  bubbleRowForAttach = bub;
  note("识别层：别人说话会翻、自己发的跳过、Ping 跳过、同句只排一次、重复扫描 (+0)、气泡认得出");
});

section("新版聊天结构", function () {
  const host = build(contextPanel, "DLChatNewLayoutTest");
  const normal = buildBubbleRow(host, { text: "push now", cooldown: "Ready in 12s" });
  const normalProbe = probeRow(normal.row);
  expect("新版结构: 普通聊天含有图标节点仍须翻译，正文不能混入冷却文字",
    normalProbe.indexOf('text="push now"') !== -1
      && normalProbe.indexOf("quick_chat") === -1
      && normalProbe.indexOf("Ready in") === -1, normalProbe);
  for (const type of ["MessageType_AbilityPing", "MessageType_MapPing",
    "MessageType_PingWheel", "MessageType_ItemDraftReaction"]) {
    const ping = buildBubbleRow(host, { text: "Enemy missing", messageType: type });
    const result = probeRow(ping.row);
    expect("新版结构: 游戏消息 " + type + " 不参与翻译",
      result.indexOf("quick_chat") !== -1, result);
  }
  const typing = buildBubbleRow(host, { messageType: "MessageType_PlayerTyping" });
  // 即使状态子树里出现文字，也不能被识别成玩家正文。
  build(typing.bubble, "TypingStatus", [], "Typing...");
  expect("新版结构: 输入中动画没有可翻译正文", probeRow(typing.row) === "info=null",
    probeRow(typing.row));
  const empty = buildBubbleRow(host, { text: "", cooldown: "Ready in 12s" });
  expect("新版结构: 空正文不能退回读取冷却标签", probeRow(empty.row) === "info=null",
    probeRow(empty.row));
  note("新版聊天：嵌套正文、四种系统消息、输入中动画和冷却文字均正确识别");
});

// ================================================================ ⑤ 挂载点
section("挂载点", function () {
  const attach = hook("DLChatSelfTestAttach");
  if (!attach) { fail("缺少钩子 DLChatSelfTestAttach（离线测试台需要它）"); return; }
  // 气泡：译文必须落在气泡行的 #MessageContents 下（官方样式确认它是 flow-children:down，
  // 挂到 .TextContainer 里会跟 .bubble_bg 抢位置），而且必须**自带内联底色**——
  // 官方 HUD 顶栏那套长选择器不覆盖我们注入的标签，透明底 = 白气泡上看不见。
  const bub = bubbleRowForAttach || buildBubbleRow(bubbleBox, { text: "he is low" });
  let out = "";
  try { out = String(attach(bub.row, "he is low", "他残血")); } catch (e) { out = "抛出:" + e; }
  show("气泡挂载点: " + out);
  expect("挂载点(气泡): 要认成气泡行", out.indexOf("surface=bubble") !== -1, out);
  expect("挂载点(气泡): 译文要挂在气泡行的 #MessageContents 下",
    out.indexOf("host=#MessageContents") !== -1, out);
  expect("挂载点(气泡): 译文必须真的建出来了", out.indexOf("attached=true") !== -1, out);
  expect("挂载点(气泡): 译文标签必须带内联底色（透明底 = 看不见）",
    out.indexOf('bg="' + BUBBLE_BG + '"') !== -1, out);
  const trans = labelWithClass(bub.contents, "DLChatTranslation");
  expect("挂载点(气泡): 译文标签要落在 #MessageContents 这一支里",
    !!trans && isInside(trans, bub.contents), trans ? "(找到了)" : "(没找到)");
  expect("挂载点(气泡): 译文标签里要是中文译文",
    !!trans && String(trans.text).indexOf("他残血") !== -1, trans ? String(trans.text) : "-");

  // 聊天窗：译文要落在这一行的 #MessageContents 分支里（行内模式下就是游戏自己那格正文）
  const fresh = buildChatRow(chatBox, { sender: "C", text: "need help" });
  try { out = String(attach(fresh.row, "need help", "需要帮忙")); } catch (e) { out = "抛出:" + e; }
  show("聊天窗挂载点: " + out);
  expect("挂载点(聊天窗): 译文要落在 #MessageContents 这一支里",
    out.indexOf("host=#MessageContents") !== -1, out);
  const zh = labelsUnder(fresh.contents).filter((l) => String(l.text).indexOf("需要帮忙") !== -1);
  expect("挂载点(聊天窗): 中文要出现在 #MessageContents 的子树里（不能跑到行外面去）",
    zh.length > 0 && zh.every((l) => isInside(l, fresh.contents)),
    "整行文字=" + JSON.stringify(rowAllText(fresh.row)));
  note("挂载点：气泡译文挂 #MessageContents + 内联底色，聊天窗译文落在 #MessageContents 这一支");
});

// ================================================================ ⑥ 双语行内
section("双语行内", function () {
  const inline = hook("DLChatSelfTestInline");
  if (!inline) { fail("缺少钩子 DLChatSelfTestInline（离线测试台需要它）"); return; }
  const row = buildChatRow(chatBox, { sender: "D", text: "push mid" });
  let out = "";
  try { out = String(inline(row.row, "push mid", "推中")); } catch (e) { out = "抛出:" + e; }
  show("聊天窗双语行内: " + out);
  const want = "push mid" + SEP_PIPE + "推中";
  expect("行内双语: 正文那一格应写成「原文 + 分隔符 + 译文」",
    out.indexOf("match=true") !== -1 && out.indexOf('want="' + want + '"') !== -1, out);
  expect("行内双语: 行上要带 DLChatChatInline、不能再带 DLChatBilingual（后者是「挂在下面」那套样式）",
    out.indexOf("inline=true") !== -1 && out.indexOf("bilingualClass=false") !== -1, out);
  expect("行内双语: 悬停用的原文标签要保住英文原文", out.indexOf('orig="push mid"') !== -1, out);
  expect("行内双语: 游戏自己那格正文里就是「英文 | 中文」", String(row.cell.text) === want,
    "单元格=" + JSON.stringify(row.cell.text));
  const orig = labelWithClass(row.row, "DLChatOriginal");
  expect("行内双语: 悬停原文要带 DLChatOriginalHidden（CSS 靠这个类把它收起来）",
    !!orig && hasClass(orig, "DLChatOriginalHidden") && String(orig.text) === "push mid",
    orig ? ("类=" + Array.from(orig._classes).join(",") + " 文字=" + JSON.stringify(orig.text))
      : "(没找到)");
  // 行内模式的全部意义就是"读过的话还能读回原文"：脚本自己的读行函数必须给出干净的英文。
  // 读不干净的直接后果：下一次扫描认为"这一行换内容了"，于是拿重复拼接的假原文再翻一遍。
  const probe = probeRow(row.row);
  show("行内后探针: " + probe);
  expect("行内双语: 脚本自己的读行函数必须能读回干净原文（不能把中文或重复的原文拼进来）",
    probe.indexOf('text="push mid"') !== -1,
    probe + "（" + jsRef("readRowText") + " / " + jsRef("collectText") + "）");
  note("行内双语：正文格 = 英文 | 中文，行带 DLChatChatInline（不带 DLChatBilingual），悬停原文保住并收起");
});

// ================================================================ ⑥b 翻译中占位
// 为什么单独把关：别人发来的消息要等 1 秒多才有译文（打字那一路只有 0.17 秒），
// 中间那一段原来屏幕上什么都不发生。占位是**加在原文后面的一个标签**，
// 加错了的后果比"没提示"严重得多 —— 它会被当成消息原文再翻一遍。
section("翻译中占位", function () {
  const pending = hook("DLChatSelfTestPending");
  if (!pending) { fail("缺少钩子 DLChatSelfTestPending（离线测试台需要它）"); return; }

  // ① 聊天窗（行内双语）：占位拼进正文那一格
  const row = buildChatRow(chatBox, { sender: "P", text: "he is low" });
  let out = "";
  try { out = String(pending(row.row, "he is low", "他残血")); } catch (e) { out = "抛出:" + e; }
  show("聊天窗翻译中: " + out);
  expect("占位(聊天窗): 延迟没到不该显示（缓存命中 0ms，无脑显示会闪一下）",
    out.indexOf("early=none") !== -1, out);
  expect("占位(聊天窗): 延迟到了要显示占位", out.indexOf("delayed=shown") !== -1, out);
  expect("占位(聊天窗): 占位文字是 ···（行内模式报的是那一格的整串）",
    out.indexOf('cell="he is low' + SEP_PIPE + '···"') !== -1, out);
  expect("占位(聊天窗): 行内模式在正文格里拼「英文 | ···」",
    out.indexOf("cell=") !== -1, out);
  expect("占位(聊天窗): 占位不能被当成消息原文读回去（否则会拿 'he is low ···' 去翻）",
    out.indexOf("clean=true") !== -1, out);
  expect("占位(聊天窗): 译文到了以后占位要换成译文、类也要摘掉",
    out.indexOf('after="he is low | 他残血"') !== -1 && out.indexOf("afterCls=false") !== -1,
    out);
  expect("占位(聊天窗): 译文到达后正文格是「英文 | 中文」（after 报的就是这一格的文字）",
    out.indexOf('after="he is low' + SEP_PIPE + '他残血"') !== -1, out);
  expect("占位(聊天窗): 占位和译文要落在同一格（不能多出一个节点，"
    + "替换模式的兜底靠 findTextLabel 的『唯一一格有字』）",
    out.indexOf("samePanel=true") !== -1, out);
  // 行被游戏回收复用：旧占位必须收掉，否则会挂在新消息下面
  expect("占位(聊天窗): 行被回收去显示新消息后，旧占位要收掉", out.indexOf("recycledGone=true") !== -1, out);
  expect("占位(聊天窗): 回收后的正文要读成新消息的原文", out.indexOf('recycledRead="push now"') !== -1, out);

  // ② 头顶气泡：占位是挂在 #MessageContents 下的独立标签，必须有内联底色兜底
  const bub = buildBubbleRow(bubbleBox, { text: "mid no" });
  try { out = String(pending(bub.row, "mid no", "中路没人")); } catch (e) { out = "抛出:" + e; }
  show("气泡翻译中: " + out);
  expect("占位(气泡): 延迟到了要显示占位", out.indexOf("delayed=shown") !== -1, out);
  expect("占位(气泡): 占位要带 DLChatPending 类（CSS 靠它做弱化配色）",
    out.indexOf("cls=true") !== -1, out);
  expect("占位(气泡): 占位不能被当成消息原文读回去", out.indexOf("clean=true") !== -1, out);
  // 这条是真正的门禁：气泡的占位是挂在**行容器**（#MessageContents）下面的，
  // collectText 会从行/气泡/TextContainer 各层把子标签拼一遍 —— 只让占位标签自己
  // 返回空是不够的，必须保证"真正扫描用的" readMessageRow 读出来的还是纯英文。
  expect("占位(气泡): 扫描入口（readMessageRow）读出来必须是纯英文原文，"
    + "不能被拼进 ···（否则下一轮会把 'mid no ···' 当原文送去翻译）",
    out.indexOf('probe={surface=bubble text="mid no"') !== -1, out);
  expect("占位(气泡): 译文到达后扫描入口读出来仍是纯英文原文",
    out.indexOf('afterProbe={surface=bubble text="mid no"') !== -1, out);
  expect("占位(气泡): 占位必须自带内联底色（透明底 = 白气泡旁边看不见）",
    out.indexOf('bg="rgba(20, 52, 96, 0.55)"') !== -1, out);
  expect("占位(气泡): 占位和真译文的底色要不一样（一样就分不出翻没翻好）",
    out.indexOf('bg="rgba(20, 52, 96, 0.55)"') !== -1
    && out.indexOf('afterBg="rgba(20, 52, 96, 0.95)"') !== -1, out);
  expect("占位(气泡): 译文到达后要把 .DLChatTranslation 加回来（它和 .DLChatPending 互斥："
    + "同时挂着时真机上内联 color 会被静默丢掉）",
    out.indexOf("afterTransCls=true") !== -1 && out.indexOf("afterCls=false") !== -1, out);
  expect("占位(气泡): 译文到达后占位原地变成译文（同一个面板）",
    out.indexOf('after="中路没人"') !== -1 && out.indexOf("afterCls=false") !== -1
    && out.indexOf("samePanel=true") !== -1, out);
  const lbl = labelsUnder(bub.contents).filter((l) => String(l.text).indexOf("···") !== -1);
  expect("占位(气泡): 翻好之后气泡里不能还留着 ···（否则气泡下面永远挂一行省略号）",
    lbl.length === 0, "还剩 " + lbl.length + " 个: "
    + JSON.stringify(lbl.map((l) => l.text)));
  // 气泡译文必须自带内联底色这条老约束对占位同样成立：占位也是画在白气泡旁边
  expect("占位(气泡): 占位标签必须带内联底色（透明底 = 看不见）",
    /applyBubbleInlineStyle\s*\(\s*label\s*,\s*(!failed|true|false)/.test(jsSource)
    || /function\s+applyBubbleInlineStyle\s*\(\s*label\s*,\s*pending/.test(jsSource),
    "dlchat.js 里没找到（" + jsRef("applyBubbleInlineStyle") + "）");
  // ③ 大厅 / 展开聊天：第三套结构（ChatLineContainer > ChatLine），走"独立标签"那条路。
  //    这一条是为了确认占位不是只在气泡上有效 —— 三个界面都扫，哪个漏了都会静默无反馈。
  const lob = buildLobbyRow(lobbyBox, { text: "go mid", sender: "L" });
  try { out = String(pending(lob.row, "go mid", "去中路", "keep")); } catch (e) { out = "抛出:" + e; }
  show("大厅翻译中: " + out);
  expect("占位(大厅): 大厅行也要认出来并显示占位", out.indexOf("delayed=shown") !== -1, out);
  expect("占位(大厅): 扫描入口读大厅行要读成纯英文原文（不能被拼进 ···）",
    out.indexOf('probe={surface=lobby text="go mid"') !== -1, out);
  expect("占位(大厅): 译文到达后要换成译文、扫描入口仍读成纯英文原文",
    out.indexOf('after="去中路"') !== -1
    && out.indexOf('afterProbe={surface=lobby text="go mid"') !== -1, out);
  lobbyBox._parent.Children = lobbyBox._parent.Children.filter((k) => k !== lobbyBox);
  note("翻译中占位：延迟 0.4s 才显示、原文读得干净、译文原地替换、行回收后收掉"
    + "（聊天窗 + 头顶气泡 + 大厅）");
});

// ================================================================ ⑥c 翻译失败提示
// 翻不出来的情况和"正在翻"一样没有反馈：英文静静留在那儿、什么都不说。
// 现在占位原地变成"翻译失败"，同样**不能**被读成消息原文。
section("翻译失败提示", function () {
  const failT = hook("DLChatSelfTestPendingFail");
  if (!failT) { fail("缺少钩子 DLChatSelfTestPendingFail（离线测试台需要它）"); return; }
  const row = buildChatRow(chatBox, { sender: "Q", text: "need urn" });
  let out = "";
  try { out = String(failT(row.row, "need urn")); } catch (e) { out = "抛出:" + e; }
  show("聊天窗翻译失败: " + out);
  expect("失败提示(聊天窗): 失败态要标出来", out.indexOf("failed=true") !== -1, out);
  expect("失败提示(聊天窗): 正文格应写成「英文 | 翻译失败」",
    out.indexOf('text="need urn' + SEP_PIPE + '翻译失败"') !== -1, out);
  expect("失败提示(聊天窗): 失败提示不能被当成消息原文读回去",
    out.indexOf("clean=true") !== -1, out);  expect("失败提示(聊天窗): 停留时间到了要收掉（不能一直挂在那儿）",
    out.indexOf("cleared=true") !== -1, out);
  expect("失败提示(聊天窗): 收掉之后那一格要还原成**纯原文**（留一个悬空分隔符 "
    + "'need urn |' 的话，下一轮扫描会把它当成新消息原文又翻一遍）",
    out.indexOf('cellAfter="need urn"') !== -1, out);

  const bub = buildBubbleRow(bubbleBox, { text: "need help" });
  try { out = String(failT(bub.row, "need help")); } catch (e) { out = "抛出:" + e; }
  show("气泡翻译失败: " + out);
  expect("失败提示(气泡): 失败提示要带 DLChatFailed 类（暖色，和『进行中』区分开）",
    out.indexOf("cls=true") !== -1, out);
  expect("失败提示(气泡): 失败提示不能被当成消息原文读回去",
    out.indexOf("clean=true") !== -1, out);
  note("翻译失败提示：占位原地变『翻译失败』、读行仍干净、到点自动收掉");
});

// ================================================================ ⑥·五 错误文案
// 玩家看到的那句话必须永远是可读的原因。真机踩过：把整个响应对象传给
// shortError()，String({}) -> "[object Object]"，游戏里显示
// "翻译失败，已停止自动重试（[object Object]）" —— 等于没有排查线索。
section("错误文案", function () {
  const errs = hook("DLChatSelfTestErrors");
  if (!errs) { fail("缺少钩子 DLChatSelfTestErrors（离线测试台需要它）"); return; }
  let out = "";
  try { out = String(errs()); } catch (e) { out = "抛出:" + e; }
  show("错误文案自检: " + out);

  expect("错误文案: 传完整响应对象时要取出里面的 error（不是 [object Object]）",
    out.indexOf("objectRes=API Key 无效") !== -1, out);
  expect("错误文案: 对象里没有原因时要给一句人话",
    out.indexOf("objectNoReason=未知错误") !== -1, out);
  expect("错误文案: 空对象不能说 [object Object]",
    out.indexOf("emptyObj=未知错误") !== -1, out);
  expect("错误文案: undefined/null 要有兜底",
    out.indexOf("undef=") !== -1 && out.indexOf("nullRes=") !== -1, out);
  expect("错误文案: 机器码要翻译成人话",
    out.indexOf("codeTimeout=面板无响应") !== -1
    && out.indexOf('codeTooLong=内容太长') !== -1, out);
  expect("错误文案: 桥返回的中文说明要原样保留（里面写着去哪配 Key）",
    out.indexOf("8791/settings") !== -1, out);
  expect("错误文案: 任何输入形态都不许出现 [object Object]",
    out.indexOf("BAD_objectString") === -1, out);
  note("错误文案：对象/空/机器码/中文说明四种形态都能给出一句能照着修的话");
});

// ================================================================ ⑦ 行回收复用
section("回收复用", function () {
  if (!hook("DLChatSelfTestRows") || !hook("DLChatSelfTestInline")) return;
  // 先把**两句**译文都塞进脚本自己的缓存（用扫描容器之外的种子行），这样这一行走的
  // 是"命中缓存"那条正常路径，不需要桥。
  // 为什么两句都提前塞：改写之后任何一次 handleRow（扫描、或者临时调试钩子）都会立刻
  // 重译这一行；此刻缓存里要是还没有新译文，它就会去发请求（离线永远等不到回执）并卡在
  // pending 上，后面的扫描再也碰不到它 —— 那是测试台自己的坑，不是脚本的 bug。
  if (!seedTranslation("go rosh", "打肉山")) return;
  if (!seedTranslation("need urn", "需要骨灰")) return;
  const recycled = buildChatRow(chatBox, { sender: "E", text: "go rosh" });
  const first = rowsReport("回收-第一次扫描");
  expect("回收复用: 第一条消息要先被翻成行内双语",
    String(recycled.cell.text) === "go rosh" + SEP_PIPE + "打肉山",
    "单元格=" + JSON.stringify(recycled.cell.text) + " -> " + first.out);

  // 游戏把这一行回收去显示新消息：**同一行、同一格**，整格文字被改写（原版 snippet 的
  // 正文 Label 没有 id，游戏就是往这一格写新消息）。我们挂在行上的类和标签都还在。
  recycled.cell.text = "need urn";
  const second = rowsReport("回收-改写后扫描");
  expect("回收复用: 改写后正文那一格要重新拼成「新英文 + 分隔符 + 新译文」",
    String(recycled.cell.text) === "need urn" + SEP_PIPE + "需要骨灰",
    "单元格=" + JSON.stringify(recycled.cell.text)
    + "；脚本自己读到的是 " + JSON.stringify(probeRow(recycled.row))
    + "；本轮排进翻译的是 " + JSON.stringify(second.queued)
    + "；扫描 " + String(second.out).split("|")[0].trim()
    + "（" + jsRef("readRowText") + " / " + jsRef("inlineRemember") + "）");
  expect("回收复用: 上一条的中文不能留在新消息里",
    rowAllText(recycled.row).indexOf("打肉山") === -1,
    "整行文字=" + JSON.stringify(rowAllText(recycled.row)));
  note("回收复用：同一行换新消息后重新拼成新消息的双语，上一条的中文不再出现");
});

// ================================================================ ⑧ 入口点
section("入口点", function () {
  // 零参入口（打开/关闭设置、保存、试翻、重译、重读…）先点一遍：这类"点了没反应"
  // 的问题在游戏里只会表现为界面不动，离线这轮能直接抓到异常。
  let poked = 0;
  const zeroArg = Object.getOwnPropertyNames(globalThis)
    .filter((k) => k.indexOf("DLChat") === 0 && typeof globalThis[k] === "function")
    .filter((k) => !withArgEntries.has(k))
    .sort();
  for (const name of zeroArg) {
    try { globalThis[name](); poked += 1; } catch (e) {
      fail("入口 " + name + "() 抛异常: " + e);
    }
  }
  expect("入口点: 至少要导出并跑通一批零参入口", zeroArg.length >= 8,
    "只有 " + zeroArg.length + " 个: " + zeroArg.join(","));

  // 开关/循环：**布局里绑给这个函数的每个键**都点一遍，而且点完必须真的看得见变化
  // （键名和脚本里的 CYCLE/本地字段对不上时，点了什么都不会变 —— 那正是"按钮没反应"）
  let boundPoked = 0;
  for (const name of ["DLChatToggle", "DLChatCycle"]) {
    if (typeof globalThis[name] !== "function") { fail("缺少入口 " + name); continue; }
    const bound = (layoutKeys[name] ? Array.from(layoutKeys[name]) : []).sort();
    for (const key of bound) {
      const before = settingsFingerprint();
      try {
        globalThis[name](key);
        poked += 1;
        boundPoked += 1;
      } catch (e) {
        fail("入口 " + name + "('" + key + "') 抛异常: " + e);
        continue;
      }
      expect("入口 " + name + "('" + key + "'): 布局里绑了这个键，但点了以后设置面板没有任何变化",
        settingsFingerprint() !== before, "面板指纹没变");
    }
  }
  // 另一个方向的兜底：布局里没绑、但脚本表里有的键也都点一遍（只要求不抛异常）
  for (const name of ["DLChatToggle", "DLChatCycle"]) {
    if (typeof globalThis[name] !== "function") continue;
    for (const key of pokeKeys) {
      if (layoutKeys[name] && layoutKeys[name].has(key)) continue;
      try { globalThis[name](key); poked += 1; } catch (e) {
        fail("入口 " + name + "('" + key + "') 抛异常: " + e);
      }
    }
  }
  // 模型下拉项是脚本自己 CreatePanel 出来的：点一下它挂的 onactivate（等价于玩家点模型名）
  const list = contextPanel.FindChildTraverse("DLChatSetModelList");
  const modelBtn = list ? list.FindChildTraverse("DLChatModel_0") : null;
  const modelLabelEl = contextPanel.FindChildTraverse("DLChatSetModelLabel");
  if (modelBtn && modelBtn._events && typeof modelBtn._events.onactivate === "function") {
    const nameLabel = labelsUnder(modelBtn)[0];
    const modelName = nameLabel ? String(nameLabel.text) : "";
    try { modelBtn._events.onactivate(); poked += 1; } catch (e) {
      fail("模型下拉项 onactivate 抛异常: " + e);
    }
    expect("入口点: 点模型名之后面板上要显示选中的模型",
      !!modelLabelEl && String(modelLabelEl.text).indexOf(modelName) === 0,
      "DLChatSetModelLabel=" + JSON.stringify(modelLabelEl ? modelLabelEl.text : null)
      + " 期望以 " + JSON.stringify(modelName) + " 开头");
  } else {
    fail("入口点: 模型列表项没建出来（buildModelList / SetPanelEvent 那条路断了）");
  }

  // 输入框那条路：聊天命令打开设置；打中文 + 连按触发键送去中→英
  // 主命令是 /tongyi（游戏内显示名「通译」），/通译、/设置、/cfg 是别名，
  // 旧的 /dlchat 保留兼容 —— 五个都要能开面板，别名挂掉是静默失效（没人会收到报错）。
  var settingsPanel = contextPanel.FindChildTraverse("DLChatSettings");
  const cmdCases = ["/tongyi", "/通译", "/dlchat", "/设置"];
  cmdCases.forEach(function (cmd) {
    if (hasClass(settingsPanel, "DLChatSettingsOpen")
      && typeof globalThis.DLChatCloseSettings === "function") {
      try { globalThis.DLChatCloseSettings(); runCallbacks(3); } catch (e) {}   // 先关掉，才能验"这次真的开了"
    }
    chatInput.text = cmd;
    runCallbacks(6);
    poked += 1;
    expect("入口点: 聊天命令 " + cmd + " 要打开设置面板并清空输入框",
      String(chatInput.text) === ""
      && hasClass(settingsPanel, "DLChatSettingsOpen"),
      "输入框=" + JSON.stringify(chatInput.text));
  });
  chatInput.text = "绕后 小心   ";      // 中文 + 三下空格（channel.hints.trigger 默认 triple_space）
  runCallbacks(6);
  const statusEl = contextPanel.FindChildTraverse("DLChatStatus");
  expect("入口点: 中文 + 触发键要进翻译（状态行应显示翻译中）",
    !!statusEl && String(statusEl.text).indexOf("翻译") !== -1,
    "DLChatStatus=" + JSON.stringify(statusEl ? statusEl.text : null));
  chatInput.text = "";
  expect("入口点: 至少要点到一批入口", poked >= 10, "只点到 " + poked + " 个");
  note("入口点：" + poked + " 个入口（零参入口 + 布局里每个设置键的开关/循环 + 模型下拉项 + "
    + "/tongyi 命令与中文触发）全部无异常");
});

// ================================================================ ⑨ 样式守卫
section("样式守卫", function () {
  const css = fs.readFileSync(CSS_PATH, "utf8");
  const rule = css.match(/\.DLChatTranslation\s*\{([^}]*)\}/);
  if (!rule) {
    fail("样式守卫: dlchat.css 里找不到 .DLChatTranslation 规则");
  } else {
    const block = rule[1].replace(/\s+/g, " ").trim();
    expect("样式守卫: .DLChatTranslation 必须自带底色（浅色字画白气泡上 = 看不见）",
      /background-color\s*:/.test(rule[1]), block.slice(0, 90));
    expect("样式守卫: .DLChatTranslation 要 width: fit-children（官方容器有固定尺寸和 overflow）",
      /width\s*:\s*fit-children/.test(rule[1]), block.slice(0, 90));
    expect("样式守卫: .DLChatTranslation 要 height: fit-children",
      /height\s*:\s*fit-children/.test(rule[1]), block.slice(0, 90));
  }
  expect("样式守卫: 气泡译文必须有内联样式兜底（applyBubbleInlineStyle + backgroundColor）",
    /function\s+applyBubbleInlineStyle/.test(jsSource) && /backgroundColor/.test(jsSource),
    "dlchat.js 里没找到（" + jsRef("applyBubbleInlineStyle") + "）");
  let hidden = false;
  for (const m of css.matchAll(/([^{}]*DLChatChatInline[^{}]*)\{([^}]*)\}/g)) {
    if (/visibility\s*:\s*collapse/.test(m[2])) hidden = true;
  }
  expect("样式守卫: 行内双语模式要把悬停原文收起来（要有提到 DLChatChatInline 且 visibility: collapse 的规则）",
    hidden, "没找到这样的规则");
  // "翻译中"占位：和真译文**共用同一个标签**，几何属性必须一致（否则占位换译文时气泡会跳），
  // 只有颜色/字号允许不同。这条规则缺了的话，占位在真机上会退化成"没底色的浅色字"。
  const pendRule = css.match(/\.DLChatPending\s*\{([^}]*)\}/);
  if (!pendRule) {
    fail("样式守卫: dlchat.css 里找不到 .DLChatPending 规则（占位会没有底色，等于看不见）");
  } else {
    const block = pendRule[1].replace(/\s+/g, " ").trim();
    expect("样式守卫: .DLChatPending 要自带底色（浅色字画白气泡上 = 看不见）",
      /background-color\s*:/.test(pendRule[1]), block.slice(0, 90));
    expect("样式守卫: .DLChatPending 要 width/height: fit-children（和真译文一致，换的时候不跳）",
      /width\s*:\s*fit-children/.test(pendRule[1]) && /height\s*:\s*fit-children/.test(pendRule[1]),
      block.slice(0, 90));
    expect("样式守卫: .DLChatPending 的配色/字号要和 .DLChatTranslation 分得开（一眼看出还没翻好）",
      /font-size\s*:\s*13px/.test(pendRule[1]) && /opacity\s*:/.test(pendRule[1]),
      block.slice(0, 90));
  }
  expect("样式守卫: 失败提示要有自己的类（.DLChatFailed），颜色和『进行中』分开",
    /\.DLChatFailed\s*\{/.test(css), "没找到 .DLChatFailed 规则");
  note("样式守卫：.DLChatTranslation 自带底色 + fit-children，气泡内联底色兜底，行内模式收起悬停原文，"
    + "占位/失败提示各自有配色");
});

// ================================================================ ⑩ 运行期消息
section("运行期消息", function () {
  for (const m of messages) {
    if (m.indexOf("failed") !== -1 || m.indexOf("出错") !== -1) {
      fail("运行期报错: " + m.trim());
    }
  }
  note("运行期消息：$.Msg " + messages.length + " 条，里面没有 failed / 出错");
});

// ================================================================ 结果
// 输出顺序有意为之：**先给结论（✗ 清单），再给通过的小节**。
// stage_compile.py 的 preflight 只截取 stdout 前 600 个字符，问题必须排在前面才看得见。
const out = [];
out.push("js_check: dlchat.js 离线测试台 —— 布局入口 " + layoutHandlers.size
  + " 个（我们的 " + Array.from(layoutHandlers).filter((n) => !VANILLA_HANDLER.test(n)).length
  + " 个），$.Msg " + messages.length + " 条");
out.push("分节结果: " + sectionStatus.join(" | "));
if (problems.length) {
  out.push("发现问题:");
  for (const p of problems) out.push("  ✗ " + p);
  out.push("通过的小节:");
  for (const s of summary) out.push("  ✓ " + s);
} else {
  for (const s of summary) out.push("  ✓ " + s);
}
if (VERBOSE) {
  out.push("详情:");
  for (const d of details) out.push("  " + d);
}
console.log(out.join("\n"));
process.exit(problems.length ? 1 : 0);
