// dlchat.js — 通译（Tongyi）：Deadlock 聊天实时翻译（游戏内 Panorama 运行时）
// ===========================================================================
// 这个文件同时被两个布局加载：
//   · panorama/layout/chat.xml                    -> 聊天输入框 + 展开的聊天列表
//   · panorama/layout/citadel_hud_top_bar_chat.xml -> 对局中头顶的聊天气泡
// 每个布局各自实例化一份脚本上下文，脚本按"当前上下文里有什么"自适应干活：
//   有 #ChatInput     -> 中文转英文（打中文，连按两下空格，输入框自动变成中英对照）
//   有 #Messages      -> 头顶气泡：英文进，中文出
//   有 #ChatMessages  -> 展开列表：英文进，中文出
//
// 与本地 Python 桥（默认 localhost:8791）的通信
// ---------------------------------------------------------------------------
// Deadlock 移除了 $.AsyncWebRequest（函数还在，但一调用就同步抛
// "AsyncWebRequest has been removed"），运行时 $.CreatePanel("HTML") 也拿不到可用的
// HTML 面板。唯一可行通道：在布局里用 <HTML> 标签声明一个隐藏面板 -> SetURL 打开桥
// 的 /bridge 页面 -> 页面 fetch 桥 API -> 把结果写进 document.title -> 这里轮询
// panel.title。两个硬约束记下来免得再踩：
//   1) 必须用 localhost，不能用 127.0.0.1（HTML 面板对回环 IP 有拦截）
//   2) 通道同一时刻只能有一个在途请求（title 是单槽），所以传输层是串行队列
// ===========================================================================

(function () {
	"use strict";

	// ---------------------------------------------------------------- 配置
	var BRIDGE_HOST = "localhost";     // 不用 127.0.0.1：见文件头注释
	var BRIDGE_PORT = 8791;
	var BRIDGE_BASE = "http://" + BRIDGE_HOST + ":" + BRIDGE_PORT;
	var TITLE_PREFIX = "LCT";          // 与桥页面约定：title = LCT<id><json>
	var MOD_TAG = "tongyi-mod/1.0.0";

	var TITLE_POLL_SECONDS = 0.15;     // title 轮询间隔
	var REQUEST_TIMEOUT = 30;          // 单请求超时（秒）
	var FIRST_TIMEOUT = 30;            // 首次请求：网页引擎初始化可能很慢，给足时间
	var HEALTH_INTERVAL = 15;          // 桥健康探测间隔（别太勤，通道是单槽的）
	var ROW_SCAN_SECONDS = 0.25;       // 聊天行扫描间隔
	var INPUT_SCAN_SECONDS = 0.1;      // 输入框扫描间隔
	var STATUS_HOLD_SECONDS = 5;       // 状态提示停留（秒）
	var SENT_MEMORY_SECONDS = 45;      // 记住自己刚发出去的英文，别把它又翻回中文
	// 模型列表最多预留几行面板。Panorama 的 DeleteAsync 不生效，列表变短时只能把
	// 多出来的旧行挡住，所以需要一个固定的行数上限（本地 Ollama 一般也就几个模型）。
	var MAX_MODEL_ROWS = 12;
	// 同一行翻译失败后最多自动重试几次（桥不通时避免同一句反复占队列）
	var MAX_ROW_RETRY = 2;
	// ---- 别人发来的消息（英→中）的"翻译中"提示 --------------------------------
	// 为什么需要：这条路上中位延迟 1.2 秒（见 dlchat/bridge/server.py 里的实测），
	// 屏幕上一次来几条还要串行排队 —— 玩家看到的就是"英文气泡静静挂在那儿，
	// 一两秒后中文突然冒出来"，没有任何反馈。打字那一路（中→英，169ms）一直有
	// "翻译中…"提示，这条没有，体验上是明显的不对称。
	//
	// 参数取值理由：
	//   · 延迟 0.4 秒才显示：缓存命中是 0ms（桥启动时还预热了词典整句），
	//     无脑显示会让快的那一批闪一下。0.4 秒既能盖住"慢"的观感，又不会闪。
	//   · 失败提示停 6 秒：比状态行（5 秒）略长，因为它就在那条消息上，看得见。
	//   · 占位文字用 "···"：不带会动的动画（Panorama 的动画不一定生效），
	//     中文/英文都读得通。
	var PENDING_SHOW_DELAY = 0.4;      // 超过这么久还没译文才显示"翻译中"
	var PENDING_TEXT = "···";          // 占位文字
	var FAIL_SHOW_SECONDS = 6;         // "翻译失败"停留时长（之后恢复正常外观）
	var PENDING_SWEEP_MAX = 12;        // 每轮最多处理几行（屏幕上也放不下更多）
	var PENDING_SETTLE_BUMP = 5;       // 比请求超时多留几秒才判"卡死"
	// 首次扫到一个聊天容器时，只处理最后几条：历史消息没必要一次翻一大堆
	// （串行队列，一次翻 10 条 = 十几秒的等待）
	var BOOTSTRAP_TAIL = 3;

	var TRIGGER = "   ";               // 触发转换：连按三下空格（设置里可切成两下）
	var CJK_RE = /[\u3400-\u9fbf\uf900-\ufaff\uff00-\uffef]/;
	var ASCII_LETTER_RE = /[A-Za-z]/;
	// 西里尔/希腊字母：Deadlock 的亚服/欧服混排语言里俄语很常见（社区调研里
	// 有整屋子俄语玩家的吐槽帖）。以前这种消息被 looksEnglish 判成"非英文"
	// 直接丢掉 —— 玩家看到的是"这条消息永远不翻"，属于静默失败。
	var CYRILLIC_RE = /[\u0400-\u04ff]/;
	var GREEK_RE = /[\u0370-\u03ff]/;
	// 为什么留这条：Panorama 脚本没法直接看 console，出问题时只能靠"把日志推到桥"。
	// 但**每一条日志都是一次串行往返**（通道是单槽的：一次页面导航 + title 轮询），
	// 一条消息翻译成功能产生 2 条日志 ⇒ 3 条消息 ≈ 6 次导航，通道开销直接翻倍。
	// 所以默认关；联调时把它改成 true 再重新编译。
	var DEBUG = false;                 // 诊断日志推给桥（scripts/mod_log.py 可看）
	// 中→英失败的退避与重试预算（秒）。为什么必须有：
	// 失败时输入框里的中文**连同尾随空格**原样留着，而输入框每 0.1 秒扫一次 ——
	// 没有预算就是每 0.1 秒一个请求的死循环，还会一直占着 fast 通道把
	// 屏幕上的聊天行全堵住（接收路径的重试预算是 MAX_ROW_RETRY，发送路径以前没有）。
	var SEND_MAX_FAILS = 2;            // 同一句连续失败几次后停止自动重试
	var SEND_BACKOFF = [0, 2.0, 5.0];  // 第 n 次失败后的冷却秒数

	// ---------------------------------------------------------------- 小工具
	var tickCount = 0;

	function nowSeconds() {
		try { return Date.now() / 1000; } catch (e) { return tickCount * 0.1; }
	}

	// compact 设置响应用的是**短键**：那个包要经 HTML 文档标题传回游戏，长度是硬约束
	// （实测本地长模型名已经占到 378/380 字符）。桥那边为了给用户自己的模型名腾地方，
	// 把字段名压成了一个词：recv/send/disp/out/hover/trig/keep/gloss/prv/ctx。
	// 这里集中翻译一次，别在业务代码里到处出现 c.recv 这种天书。
	function compact(res) {
		res = res || {};
		return {
			recv: res.recv, send: res.send, disp: res.disp, out: res.out,
			hover: res.hover, trig: res.trig, keep: res.keep, gloss: res.gloss,
			prv: res.prv, sep: res.sep, model: res.model, ctx: res.ctx,
			// 下面这些在响应被裁剪时会缺席，读的时候一律带默认值
			persisted: res.persisted, req: res.req, hit: res.hit,
			latIn: res.latIn, latOut: res.latOut, vram: res.vram,
			loaded: res.loaded, keySet: res.keySet, trimmed: res.trimmed
		};
	}

	// Panorama 没有 setInterval，只能自己用 $.Schedule 串起来
	function every(seconds, fn) {
		function tick() {
			tickCount += 1;
			try { fn(); } catch (e) { /* 面板被销毁等异常不该打断循环 */ }
			try { $.Schedule(seconds, tick); } catch (e) { /* 上下文没了就算了 */ }
		}
		try { $.Schedule(seconds, tick); } catch (e) {}
	}

	function isValid(p) {
		try { return !!p && (!p.IsValid || p.IsValid()); } catch (e) { return false; }
	}

	function childrenOf(p) {
		var out = [];
		if (!isValid(p)) return out;
		// 优先用引擎的 GetChildCount/GetChild：这是 Panorama 的正规接口。
		// `p.Children` 是老写法，新版本不一定给（给不到就永远扫不到任何聊天行 ——
		// 那种失败是静默的：不报错、也没请求）。
		try {
			if (typeof p.GetChildCount === "function" && typeof p.GetChild === "function") {
				var n = p.GetChildCount() || 0;
				for (var i = 0; i < n; i++) {
					var kid = p.GetChild(i);
					if (kid) out.push(kid);
				}
				if (out.length) return out;
			}
		} catch (e) {}
		try {
			var kids = p.Children || [];
			for (var j = 0; j < kids.length; j++) out.push(kids[j]);
		} catch (e) {}
		return out;
	}

	function hasClass(p, name) {
		if (!isValid(p)) return false;
		try { if (typeof p.HasClass === "function") return !!p.HasClass(name); } catch (e) {}
		try { if (typeof p.BHasClass === "function") return !!p.BHasClass(name); } catch (e) {}
		return false;
	}

	function setClass(p, name, on) {
		if (!isValid(p)) return;
		try {
			if (on && typeof p.AddClass === "function") { p.AddClass(name); return; }
			if (!on && typeof p.RemoveClass === "function") { p.RemoveClass(name); return; }
			if (typeof p.SetHasClass === "function") p.SetHasClass(name, !!on);
		} catch (e) {}
	}

	function enc(s) {
		try { return encodeURIComponent(s); } catch (e) { return escape(s); }
	}

	// 调一个"无参、可能不存在"的面板方法（ScrollToBottom / GetFirstChild 这类）。
	// Panorama 的新旧版本方法集不一样：typeof 判断 + try 兜底，缺了就当没这回事，
	// 绝不让一个缺失的可选 API 把整条翻译链路带崩。
	function call0(obj, name) {
		if (!isValid(obj)) return null;
		try {
			if (typeof obj[name] !== "function") return null;
			return obj[name]();
		} catch (e) { return null; }
	}

	// 按 id 找一个**直接子节点**（游戏给聊天行填内容时正文那格是 #MessageContents 的直接子节点；
	// 但 TestEntry 之类会再嵌一层，所以不能只看它）。
	function childById(parent, id) {
		if (!isValid(parent)) return null;
		var kids = childrenOf(parent);
		for (var i = 0; i < kids.length; i++) {
			var kid = "";
			try { kid = kids[i].id || ""; } catch (e) {}
			if (kid === id) return kids[i];
		}
		return null;
	}

	// 深度优先找第一个满足条件的面板
	function findDeep(p, pred, depth) {
		if (!isValid(p) || (depth || 0) > 8) return null;
		var kids = childrenOf(p);
		for (var i = 0; i < kids.length; i++) {
			var kid = kids[i];
			var t = null;
			try { t = kid.type; } catch (e) {}
			if (pred(kid, t)) return kid;
			var deeper = findDeep(kid, pred, (depth || 0) + 1);
			if (deeper) return deeper;
		}
		return null;
	}

	function findByClass(p, cls) {
		return findDeep(p, function (kid) { return hasClass(kid, cls); });
	}

	// 找一个子面板：先按 id（FindChildTraverse 是深度查找），找不到就找同名的类。
	function findChild(root, idOrClass, byClass) {
		if (!isValid(root)) return null;
		if (byClass) return findByClass(root, idOrClass);
		var found = null;
		try { found = root.FindChildTraverse(idOrClass); } catch (e) {}
		return isValid(found) ? found : null;
	}

	// 把一棵子树里所有文字收起来拼成一行。
	// 为什么不"找第一个有字的 Label"：游戏**没给聊天正文那个 Label 起 id**
	// （原版 snippet `ChatMessageContents_Text` 里就是裸的 `<Label text="{s:message_text}" />`），
	// 而一行里第一个有字的往往是发送者名字 —— 猜错的后果是"把玩家名当消息翻"。
	// 从 MessageContents 整棵子树收集，就不用猜了。
	//
	// ⚠ 例外：双语行内模式下，正文那一格里躺着**我们自己写进去的** "英文 | 中文"。
	// 直接收就会把中文当成下一条消息的原文（游戏回收行面板时尤其明显：新英文会被
	// 拼在旧中文后面）。所以先用 readRowText 把"我们写过的那一格"还原成原文。
	// 收到"装着我们那一格的容器"时**立刻停止往下走**：那一格是整份正文，子格子不必再数一遍，
	// 往上的祖先也不会各自再喊一遍。
	function collectText(panel) {
		var out = [];
		(function walk(p, depth) {
			if (!isValid(p) || depth > 6) return;
			var t = readRowText(p).replace(/\s+/g, " ").replace(/^\s+|\s+$/g, "");
			if (t) out.push(t);
			if (inlineCellInside(p)) return;
			var kids = childrenOf(p);
			for (var i = 0; i < kids.length; i++) walk(kids[i], depth + 1);
		})(panel, 0);
		return out.join(" ").replace(/\s+/g, " ").replace(/^\s+|\s+$/g, "");
	}

	// 面板的 class 列表（游戏 CSS 是按 class 匹配的，看到 class 基本就知道排版规则）。
	// Panorama 没有"取全部 class"的接口，只能拿已知的几个逐个问。
	// **id 也要算进去**：有些关键节点（MessageContents / MessageSource / MessageText）
	// 游戏是靠 id 定位的，光看 class 会以为"这个容器什么都没有"。
	function panelClasses(p) {
		if (!isValid(p)) return "";
		var known = ["ChatMessage", "Expired", "MessageBody", "MessageSource", "MessageContents",
			"Text", "Ping", "ChatBubble", "TextContainer", "bubble_bg", "ChatLinesWrapper",
			"ChatLineContainer", "ChatLine", "ChatPersona", "SenderName", "ChannelName",
			"SenderLocalClient", "IsSelf", "DLChatTranslation", "DLChatOriginal",
			"DLChatBilingual", "DLChatTranslatedText", "DLChatChatInline",
			"DLChatPending", "DLChatFailed"];
		var hit = [];
		try { if (p.id) hit.push("#" + p.id); } catch (e) {}
		for (var i = 0; i < known.length; i++) {
			if (hasClass(p, known[i])) hit.push(known[i]);
		}
		return hit.join(".");
	}

	// 结构探针：把"译文挂到了哪儿、那一带长什么样"推给桥（`python scripts\mod_log.py` 能读）。
	// 只在真的插入译文时记一次（不是轮询），不会把串行通道灌满。
	// 用途：像"译文和原文叠在一起"这种现象，光看画面分不清是"容器是横向流"还是
	// "行高固定、不随内容长高" —— 这份 dump 一次就能分清，不用反复进游戏试。
	function logRowStructure(tag, host, rec) {
		try {
			var chain = [];
			var p = host;
			for (var i = 0; i < 3 && isValid(p); i++) {
				var id = "";
				try { id = p.id || ""; } catch (e) {}
				chain.push("{" + (id ? "#" + id : "") + panelClasses(p)
					+ " kids=" + childrenOf(p).length + "}");
				try { p = p.GetParent(); } catch (e) { break; }
			}
			// 尺寸和底色：这三个数是"看不见"类问题的判决书。
			//   lblH = 0  -> 标签压根没被量出高度（布局/宿主问题）
			//   lblH > 0 但画面没有 -> 颜色/底色问题
			//   hostH = 0 -> 宿主本身没尺寸，得换挂载点
			var box = function (x) {
				if (!isValid(x)) return -1;
				var w = -1, h = -1;
				try { w = (typeof x.GetWidth === "function") ? Math.round(x.GetWidth()) : -1; } catch (e) {}
				try { h = (typeof x.GetHeight === "function") ? Math.round(x.GetHeight()) : -1; } catch (e) {}
				return w + "x" + h;
			};
			var bg = "";
			try { bg = (rec && rec.trans && rec.trans.style) ? rec.trans.style.backgroundColor : ""; } catch (e) {}
			var vis = "?";
			try { vis = host.IsVisible(); } catch (e) {}
			log("struct:" + tag, {
				text: String((rec && rec.original) || "").substring(0, 24),
				host: chain.join(" < "),
				vis: vis,
				lbl: box(rec && rec.trans),
				hostBox: box(host),
				bg: bg
			});
		} catch (e) {}
	}

	function isLabel(p) {
		if (!isValid(p)) return false;
		try { if (p.type === "Label") return true; } catch (e) {}
		return false;
	}

	function readText(p) {
		if (!isValid(p)) return "";
		try { return String(p.text == null ? "" : p.text); } catch (e) { return ""; }
	}

	function writeText(p, value) {
		if (!isValid(p)) return false;
		try { p.text = String(value); return true; } catch (e) { return false; }
	}

	// ---- 双语行内模式：让"读过的话"还能读回原文 --------------------------------
	// 聊天窗双语是把中文拼进**游戏自己那格正文**里的（"英文 | 中文"），于是有个副作用：
	// collectText 会把这整串当成消息原文。两个后果，都很难看：
	//   ① 下一条消息的原文里混进上一条的中文（游戏回收行面板时最明显）；
	//   ② 重译时把中文一起送去翻译。
	// 所以写进去的那一刻把"这一格 = 哪个原文"记下来，读的时候再还原。
	// 只认带 DLChatChatInline 的行 —— 游戏换新消息、把这格整段改写时，我们记的那份
	// 就不算数了（回落到读到的文字），不会把旧原文套到新消息头上。
	var inlineRecs = [];

	function inlineFind(panel) {
		for (var i = 0; i < inlineRecs.length; i++) {
			if (inlineRecs[i].panel === panel) return inlineRecs[i];
		}
		return null;
	}

	function inlineRemember(panel, data) {
		var rec = inlineFind(panel);
		if (!rec) { rec = { panel: panel }; inlineRecs.push(rec); }
		rec.original = data.original;       // 那一格原本的文字
		rec.finalText = data.finalText;     // 我们写进去的 "英文 | 中文"（用来判断有没有被游戏改写）
		rec.cell = data.cell || null;       // 我们改写的**那一格**（身份比对；不能靠"有字的格子"列表，
		                                    // 因为悬停原文那个标签也在同一个容器里、也带原文，会被当成正文）
		rec.collected = data.collected;     // 这一格所属整行的正文（还原用）
		while (inlineRecs.length > 48) inlineRecs.shift();   // 聊天行会回收，别无限长
	}

	// 清掉一格的记录。**绝不能顺手把正文写回旧原文** —— 这时候那一格通常已经是
	// 游戏填进去的**新消息**了，写回去等于把新消息吃掉（离线测试台抓过这个 bug）。
	function inlineForget(panel) {
		for (var i = inlineRecs.length - 1; i >= 0; i--) {
			if (inlineRecs[i].panel === panel) inlineRecs.splice(i, 1);
		}
	}

	// 这一格是不是"我们写过的"：文字还跟当时写进去的一模一样才算（游戏改写后即作废）。
	function inlineEntryFor(panel) {
		if (!isValid(panel)) return null;
		var rec = inlineFind(panel);
		if (!rec || !rec.finalText) return null;
		if (readText(panel) !== rec.finalText) return null;
		return rec;
	}

	// 往上找一层"带 DLChatChatInline 的行"。行被游戏回收去显示别的话时，类会被摘掉，
	// 这条也就自然失效了。
	function inlineRowOf(panel) {
		var p = panel;
		for (var i = 0; i < 4 && isValid(p); i++) {
			if (hasClass(p, "DLChatChatInline") && inlineFind(p)) return p;
			try { p = p.GetParent(); } catch (e) { break; }
		}
		return null;
	}

	// 我们改写的那一格在不在这个容器里（用于"读到容器就用整行正文、并且不再往下走"）
	function inlineCellInside(panel) {
		var row = inlineRowOf(panel);
		if (!row) return null;
		var rec = inlineFind(row);
		if (!rec || typeof rec.collected !== "string" || !isValid(rec.cell)) return null;
		// 那一格必须还是"我们写的那份文字"：游戏把行回收去显示新消息时，格里的字被整段改写，
		// 这时候整行正文就作废了 —— 不然会把**上一条消息的原文/译文**当成这一行的内容报出去
		// （离线测试台抓到过：回收后探针仍然读到旧的那句 "go rosh"）。
		if (!inlineEntryFor(rec.cell)) return null;
		var p = rec.cell;
		for (var i = 0; i < 6 && isValid(p); i++) {
			if (p === panel) return rec;
			try { p = p.GetParent(); } catch (e) { break; }
		}
		return null;
	}

	// 读一格文字：
	//   · 我们改写的那一格 -> 还原成纯英文原文（中文不进"原文"）
	//   · 这一格的某个外层容器（而且容器里确实装着那一格）-> 直接用记下的整行正文
	//   · 其它 -> 原样读出
	//
	// ⚠ 两个坑都是离线测试台抓出来的：
	//   ① "是不是那一格"必须**身份比对**（记下来的格子引用），不能拿"容器里有字的格子"去猜 ——
	//      悬停原文那个标签也在同一个容器里、也带着原文，会被误当成正文；
	//   ② 只有"路径上真的经过那一格"的容器才能用整行正文。行的类挂在行容器上，从格子往上走
	//      每一层祖先都看得见它；不加 ② 的话，wrapper 和 #MessageContents 会各喊一遍正文，
	//      拼出来就是 "原文 原文 原文"。
	function readRowText(panel) {
		// 悬停原文那个标签（.DLChatOriginal）是我们自己造的副本，**永远不算正文**。
		// 不然行被游戏回收显示新消息时，它还留着上一条的原文，会被当成"这一行的文字"
		// 拼进去（离线测试台抓到过："need urn go rosh"）。
		if (hasClass(panel, "DLChatOriginal")) return "";
		// "翻译中"占位（.DLChatPending）和"翻译失败"提示（.DLChatFailed）同上，
		// 而且更要紧：它们是**加在原文后面**的，被读成正文的后果不是显示难看，
		// 而是下一轮扫描拿 "he is low ···" / "he is low 翻译失败" 当原文送去翻译
		// （离线测试台两个类各抓到过一次）。
		if (hasClass(panel, "DLChatPending") || hasClass(panel, "DLChatFailed")) return "";
		var own = inlineEntryFor(panel);
		if (own && own.cell === panel && typeof own.original === "string") return own.original;
		var rec = inlineCellInside(panel);
		if (rec) return rec.collected;
		return readText(panel);
	}

	function looksChinese(s) { return CJK_RE.test(s); }

	function looksEnglish(s) { return !CJK_RE.test(s) && ASCII_LETTER_RE.test(s); }

	// 别的语言的字面（主要是俄语，亚服/欧服混排很常见）。
	// 返回一个给桥看的语言提示：桥按它选提示词，而不是把俄语当英文翻。
	function looksSlavic(s) {
		return CYRILLIC_RE.test(s) ? "ru" : (GREEK_RE.test(s) ? "el" : "");
	}

	// ---------------------------------------------------------------- 通道探测
	// 两条通道，优先直连：
	//
	//   1) 直连 GET —— `$.AsyncWebRequest(url, {type:"GET", timeout})` 返回 Promise。
	//      这是引擎自带的 HTTP API（游戏内置的 chat_translator 就用它），每个请求
	//      彼此独立、没有导航竞争。**不能只用 typeof 判断**：函数在、但调用会同步抛
	//      "AsyncWebRequest has been removed"，所以必须真调一次看返回值。
	//   2) HTML 面板 —— 隐藏 <HTML> 面板 SetURL 打开桥的 /bridge 页面，页面 fetch 完
	//      把结果写进 document.title，这边轮询 panel.title。这条通道**首次导航之后
	//      可能不再触发 title 更新**（连续导航会失效），所以只当兜底，并且要盯着
	//      "页面存活标记" lct-alive 判断它到底有没有在干活。
	var channel = {
		mode: null,          // null=未探测  "http"=直连  "panel"=HTML 面板
		httpStyle: "",       // "promise"=新 API  "send"=旧 SendRequest API
		probeError: "",
		pageAlive: false,    // 面板通道：见过 lct-alive
		panelDead: false,    // 面板通道：导航过但一直没反应
		navCount: 0,         // 导航次数
		titleKind: "-",      // title 读回来的类型：s=字符串 o=其它 n=空
		srcAccepted: "-",    // SetURL 后能不能从 src 属性读回地址
		pingLocal: null,     // /ping 探针：localhost 能否加载并读回标题
		pingIp: null,        // /ping 探针：127.0.0.1 同上
		panelOnScreen: null, // 面板是否真的渲染中（聊天框开着才算）
		eventsRegistered: 0, // 成功注册了几个 HTML 面板事件
		eventErrors: 0,      // 注册失败数
		eventCount: 0,       // 收到过多少个面板事件（主通道是否活着）
		lastEventName: "",   // 最后一个事件名
		lastEventText: "",   // 最后一个事件带来的文本（前 400 字符）
		hotkey: "?",         // 快捷键绑定结果：恒为 "none"（F8 已废弃，见 noHotkey 注释）
		hints: {             // 桥随响应带回来的渲染提示（跟随设置即时生效）
			displayMode: "bilingual",
			outgoingMode: "bilingual",
			separator: " | ",
			showOriginal: true,
			receiveEnabled: true,
			sendEnabled: true,
			trigger: "double_space"
		}
	};

	// 双语模式下中英之间拼什么。
	// 优先用面板里选的（保存后立刻生效，不用等桥回话）；没读过设置就用桥下发的。
	function separatorText() {
		var local = ui.local && ui.local.separator;
		if (local && ui.SEP_TEXT[local]) return ui.SEP_TEXT[local];
		var s = channel.hints.separator;
		return (typeof s === "string" && s) ? s : " | ";
	}

	// 译文显示方式。**和 separatorText 同样的优先级**：游戏内设置面板上选的先算数，
	// 免得"刚在面板里切了显示方式、译文却还是老样子"（要等桥下一轮响应才生效）。
	function displayMode() {
		var local = ui.local && ui.local.display_mode;
		if (local) return local;
		return channel.hints.displayMode || "bilingual";
	}

	// 运行时能力报告：探测结果都塞进这一行，方便一眼定位
	var apiProbe = {
		arity: -1,       // $.AsyncWebRequest.length（形参个数，能提示签名）
		retType: "-",    // 返回值类型：undef/null/object/function...
		keys: "-",       // 返回值自己的键（如果是对象）
		cbShape: "",     // 哪种调用形态的回调真的被触发了
		cbBody: ""       // 触发时拿到的内容（前 40 字符）
	};

	// 穷举调用形态：函数存在但返回既不是 Promise 也没有 SendRequest 时，
	// 很可能签名变了（比如 (url, callback) 或 options 里带 success）。这里每种形态
	// 都挂一个回调，谁真的被触发就说明签名是哪一种 —— 触发成功就等于拿到了可用通道。
	function probeApiShapes(url, done) {
		try { apiProbe.arity = $.AsyncWebRequest.length; } catch (e) {}
		var shapes = [
			{ key: "cb2", call: function (cb) { return $.AsyncWebRequest(url, cb); } },
			{ key: "optcb", call: function (cb) {
				return $.AsyncWebRequest(url, { type: "GET", timeout: 3000 }, cb); } },
			{ key: "inner", call: function (cb) {
				return $.AsyncWebRequest(url, { type: "GET", timeout: 3000,
					success: cb, onload: cb, callback: cb }); } },
			{ key: "obj", call: function (cb) {
				return $.AsyncWebRequest({ url: url, type: "GET", timeout: 3000 }, cb); } }
		];
		var idx = 0;
		function next() {
			if (idx >= shapes.length) { done(); return; }
			var shape = shapes[idx++];
			var settled = false;
			function finish(ok, body) {
				if (settled) return;
				settled = true;
				if (ok && !apiProbe.cbShape) {
					apiProbe.cbShape = shape.key;
					apiProbe.cbBody = String(body || "").substring(0, 40);
					done();
					return;
				}
				next();
			}
			var ret;
			try {
				ret = shape.call(function (a, b) {
					// 回调实参形态未知：谁看起来像 JSON 就用谁
					var cand = (typeof a === "string") ? a : (typeof b === "string" ? b : "");
					var good = false;
					try { JSON.parse(cand); good = true; } catch (e) { good = false; }
					finish(good, cand);
				});
			} catch (e) {
				next();
				return;
			}
			if (apiProbe.retType === "-") {
				apiProbe.retType = (ret === undefined) ? "undef"
					: (ret === null ? "null" : typeof ret);
				if (ret && typeof ret === "object") {
					var ks = [];
					try {
						for (var k in ret) { ks.push(k); if (ks.length >= 4) break; }
					} catch (e) {}
					apiProbe.keys = ks.length ? ks.join(",") : "(none)";
				}
			}
			try { $.Schedule(2.0, function () { finish(false, ""); }); }
			catch (e) { finish(false, ""); }
		}
		next();
	}

	// 一行诊断码，直接显示在状态行里。格式：
	//   P:<探测> A:<形参个数> R:<返回类型> K:<返回对象键> C:<可用回调形态>
	//   S:<SetURL> T:<title 类型> A:<存活标记> N:<导航次数> R:<src 回读> G:<ping>
	// HTML 面板事件的读回通道
	// ---------------------------------------------------------------------------
	// 这是**主通道**：隐藏面板导航后，引擎会抛出 HTML 面板相关事件，标题就在事件参数里。
	// 只轮询 panel.title 是不够的 —— 实测这个版本里 panel.title 一直是空的（诊断码 T:n），
	// 于是页面明明加载成功了我们也读不到，表现成"面板未加载"。事件名是引擎接口事实，
	// 逐个注册、谁先带来我们要的字符串就用谁。
	var PANEL_EVENTS = [
		"HTMLContentLoaded", "HTMLLoadPage", "HTMLStartRequest", "HTMLFinishRequest",
		"HTMLURLChanged", "HTMLChangedTitle", "HTMLTitle"
	];

	// 事件参数形态未知：字符串直接用，对象则挨个试常见字段，再退到属性读取
	function eventText(arg) {
		if (arg == null) return "";
		try { if (typeof arg === "string") return arg; } catch (e) {}
		var keys = ["title", "url", "src", "text"];
		for (var i = 0; i < keys.length; i++) {
			try {
				var v = arg[keys[i]];
				if (typeof v === "string" && v) return v;
			} catch (e) {}
		}
		try {
			if (typeof arg.GetAttributeString === "function") {
				return String(arg.GetAttributeString("title", "")
					|| arg.GetAttributeString("url", "")
					|| arg.GetAttributeString("src", "") || "");
			}
		} catch (e) {}
		return "";
	}

	function registerPanelEvents() {
		channel.eventsRegistered = 0;
		for (var i = 0; i < PANEL_EVENTS.length; i++) {
			(function (name) {
				try {
					$.RegisterForUnhandledEvent(name, function () {
						var parts = [];
						for (var a = 0; a < arguments.length; a++) {
							var t = eventText(arguments[a]);
							if (t) parts.push(t);
						}
						if (!parts.length) return;
						channel.eventCount += 1;
						channel.lastEventName = name;
						channel.lastEventText = parts.join(" ").substring(0, 400);
						bus.onPanelText(channel.lastEventText);
					});
					channel.eventsRegistered += 1;
				} catch (e) {
					channel.eventErrors += 1;
				}
			})(PANEL_EVENTS[i]);
		}
	}

	// ---------------------------------------------------------------- 设置面板
	// 交互全部本地完成：打开时读一次、保存时写一次，中间不逐键走网络。
	// 布局里的 onactivate="DLChatXxx()" 需要全局函数，所以最后用 globalThis 导出。
	var ui = {
		open: false,
		dirty: false,
		local: null,            // 本地编辑中的设置
		models: [],
		modelBtns: [],      // [{name, btn}] 模型下拉项（只建一次，绝不重建）
		listOpen: false,    // 模型下拉是否展开
		remote: null,           // 上一次从桥读回来的完整视图
		keySet: true,           // 云端来源的密钥是否配好（没配就在面板上点出来）

		// 翻译来源：单字母码由桥定义（l=本地 Ollama / d=DeepSeek 云端 / o=其他兼容端点）。
		// 用一个字是因为 compact 响应要经 HTML 文档标题传回游戏，长度是硬约束。
		PROVIDER: {
			byCode: { l: "local", d: "deepseek", o: "openai" },
			byName: { local: "l", deepseek: "d", openai: "o" },
			order: ["local", "deepseek"],
			label: { local: "本地 Ollama", deepseek: "DeepSeek 云端", openai: "其他端点" },
			short: { local: "本地", deepseek: "DeepSeek", openai: "其他" }
		},

		CYCLE: {
			display_mode: ["replace", "bilingual"],
			// 发出去的消息：只发英文 / 中英都发
			outgoing_mode: ["english_only", "bilingual"],
			// 双语模式下中英之间拼什么。三种都给出来，因为"竖线在游戏字体里
			// 渲染成什么样"只能进游戏才看得出来 —— 一眼不对就换下一个。
			separator: ["pipe", "full", "space"],
			// Ctrl+Enter 需要 TextEntry 的键盘事件，这条通道还没验证过，
			// 先只暴露两种空格触发 —— 不给用户摆一个按了没反应的选项。
			trigger: ["triple_space", "double_space"],
			keep_alive: ["5m", "30m", "60m", "-1"],
			// 上下文轮数：短句消歧用（"on him"/"no" 这类没有上句就没法翻），
			// 但轮数越多 token 成本越高、也越容易把上一句的主语带进来。
			// 只给 0/1/2 三档：再多对聊天翻译没有收益。
			context_rounds: [0, 1, 2],
			// 只放已验证能用的两条：本地 Ollama / DeepSeek 云端
			provider: ["local", "deepseek"]
		},
		LABEL: {
			// 聊天窗的「双语」= 中文拼在正文里（英文 | 中文），不是另起一行 —— 文案跟着改，
			// 免得设置面板上写的东西和游戏里看到的不一样。
			display_mode: { replace: "只显示中文", bilingual: "英文 | 中文" },
			outgoing_mode: { english_only: "只发英文", bilingual: "中英都发" },
			// 标签直接显示拼出来的效果，一眼能看出选的是哪种
			separator: { pipe: "中文 | 英文", full: "中文 ｜ 英文",
				space: "中文  英文" },
			trigger: { triple_space: "三下空格", double_space: "两下空格",
				ctrl_enter: "Ctrl+Enter" },
			keep_alive: { "5m": "5 分钟", "30m": "30 分钟", "60m": "60 分钟",
				"-1": "常驻不卸载" },
			// 数字键在对象里会变成字符串，两种写法都查一下
			context_rounds: { "0": "不带上文", "1": "带 1 轮（推荐）", "2": "带 2 轮" }
		},

		// 选项名 -> 真正拼进输入框的字符串（和桥的 SEPARATOR_TEXT 对齐）
		SEP_TEXT: { pipe: " | ", full: " ｜ ", space: "  " },
		// 桥传回来的是单字母码（p/f/s），这里转回选项名
		SEP_NAME: { p: "pipe", f: "full", s: "space" },

		// 当前面板上选中的来源。读设置还没回来时用**默认来源**（= DeepSeek 云端，
		// 和 config.yaml / settings.py 里的默认值保持一致）：以前这里写死 "local"，
		// 面板刚打开、响应还没到的那一瞬间会显示"本地 Ollama"，和实际默认不符。
		providerName: function () {
			return (this.local && this.local.provider) || "deepseek";
		},

		isCloud: function () {
			return this.providerName() !== "local";
		},

		el: function (id) {
			var root = null;
			try { root = $.GetContextPanel(); } catch (e) { return null; }
			var found = null;
			try { found = root.FindChildTraverse(id); } catch (e) {}
			return isValid(found) ? found : null;
		},

		setText: function (id, text) {
			var el = this.el(id);
			if (el) writeText(el, text);
		},

		// 取模型列表（单独一次请求，避免把设置响应撑大）。
		// force=true 用于切换来源：列表是按来源拿的，不强制重取就会一直显示上一个
		// 来源的模型名 —— 云端来源配着本地模型名，选了必然报错。
		loadModels: function (then, force) {
			var self = this;
			if (this.models.length && !force && then) { then(); return; }
			this.status("读取模型列表…");
			// 发**全名**（"local"/"deepseek"）：桥两种写法都认，但全名在日志里能看懂
			bus.send("models", { provider: this.providerName() }, REQUEST_TIMEOUT,
				function (res) {
				if (res && res.ok) {
					self.models = res.models || [];
					self.buildModelList();          // 只建一次，之后只切高亮
					if (!self.models.length) {
						self.status(self.isCloud()
							? "这个来源没有可选模型"
							: "没读到本机模型（Ollama 在跑吗？装了模型吗？）");
					} else {
						self.status("共 " + self.models.length + " 个模型，点一项切换");
					}
				} else {
					self.status("读取模型列表失败：" + shortError(res && res.error));
				}
				if (then) then();
			});
		},

		// 把本地状态刷到界面（纯本地，立即生效，不等待网络）
		render: function () {
			var s = this.local;
			if (!s) return;
			this.setText("DLChatSet_receive_l", s.receive_enabled ? "开" : "关");
			this.setText("DLChatSet_send_l", s.send_enabled ? "开" : "关");
			this.setText("DLChatSet_hover_l", s.show_original_on_hover ? "开" : "关");
			this.setText("DLChatSet_glossary_l", s.glossary ? "开" : "关");
			this.setText("DLChatSet_display_l",
				(this.LABEL.display_mode[s.display_mode] || s.display_mode));
			this.setText("DLChatSet_outgoing_l",
				(this.LABEL.outgoing_mode[s.outgoing_mode] || s.outgoing_mode));
			this.setText("DLChatSet_trigger_l",
				(this.LABEL.trigger[s.trigger] || s.trigger));
			this.setText("DLChatSet_sep_l",
				(this.LABEL.separator[s.separator] || s.separator));
			this.setText("DLChatSet_keep_l",
				(this.LABEL.keep_alive[s.keep_alive] || s.keep_alive));
			this.setText("DLChatSet_ctx_l",
				(this.LABEL.context_rounds[String(s.context_rounds)]
					|| (String(s.context_rounds) + " 轮")));
			var pname = this.providerName();
			this.setText("DLChatSet_provider_l",
				(this.PROVIDER.label[pname] || pname));
			var toggles = {
				DLChatSet_receive: s.receive_enabled,
				DLChatSet_send: s.send_enabled,
				DLChatSet_hover: s.show_original_on_hover,
				DLChatSet_glossary: s.glossary
			};
			for (var id in toggles) {
				var control = this.el(id);
				setClass(control, "DLChatValueOn", !!toggles[id]);
				setClass(control, "DLChatValueOff", !toggles[id]);
			}
			var saveButton = this.el("DLChatSetSave");
			setClass(saveButton, "DLChatSaveDirty", !!this.dirty);
			this.setText("DLChatSetSaveLabel", this.dirty ? "保存更改" : "保存设置");
			// 云端来源里"模型常驻"没有意义（那是 Ollama 的 keep_alive），收起来，
			// 免得摆一个点了没反应的开关。
			var keepRow = this.el("DLChatSetRow6");
			if (keepRow) setClass(keepRow, "DLChatRowHidden", this.isCloud());
			// "双语分隔符"只在双语模式下才有意义，单语模式收起来
			var sepRow = this.el("DLChatSetRowSep");
			if (sepRow) {
				setClass(sepRow, "DLChatRowHidden", s.outgoing_mode !== "bilingual");
			}
			this.setText("DLChatSetModelLabel", s.model + "  v");
			this.renderFailure();
			this.highlightModel();
		},

		// "最近错误"那一行：一直留着，直到下一次翻译成功才清掉。
		// 状态行那句提示几秒就没了，打团时根本看不到，得有个地方能事后回看。
		renderFailure: function () {
			var row = this.el("DLChatSetFailRow");
			var label = this.el("DLChatSetFail");
			var has = !!lastFailure.text;
			if (row) setClass(row, "DLChatRowHidden", !has);
			// 清空时也要写一遍：只隐藏不擦字的话，标签里还留着上一轮的错，
			// 下次再显示出来就是旧消息（"保存后又看不到"那类困惑就是这么来的）。
			if (label) writeText(label, has ? lastFailure.text : "");
		},

		// 只切高亮，绝不重建面板：早先版本每次点击都重建模型列表，而 DeleteAsync
		// 在这个环境里没生效，于是每点一下开关就多出一行模型名（用户实测到的现象）。
		highlightModel: function () {
			var list = this.modelBtns || [];        // 防御：字段缺失时不要抛异常
			for (var i = 0; i < list.length; i++) {
				var item = list[i];
				if (!isValid(item.btn)) continue;
				setClass(item.btn, "DLChatModelOn", item.name === this.local.model);
			}
		},

		// 模型列表只在拿到列表后建一次
		buildModelList: function () {
			var host = this.el("DLChatSetModelList");
			if (!host) return;
			this.modelBtns = [];
			var keep = this.models.length;
			// 同一个 id 的 CreatePanel 会复用已有面板，且 DeleteAsync 在 Panorama 里
			// 不生效（实测）—— 所以列表变短时不能靠"删"，要把多出来的旧项挡住，
			// 否则切一次来源就多留几行上一个来源的模型名。
			for (var j = 0; j < MAX_MODEL_ROWS; j++) {
				var stale = null;
				try { stale = host.FindChildTraverse("DLChatModel_" + j); } catch (e) {}
				if (isValid(stale)) setClass(stale, "DLChatRowHidden", j >= keep);
			}
			for (var i = 0; i < this.models.length; i++) {
				(function (name, self, index) {
					try {
						var btn = $.CreatePanel("Button", host, "DLChatModel_" + index);
						if (!btn) return;
						setClass(btn, "DLChatModelBtn", true);
						setClass(btn, "DLChatRowHidden", false);
						var label = $.CreatePanel("Label", btn, "");
						if (label) writeText(label, name);
						// 用 SetPanelEvent 而不是布局属性：模型名里有 : 和 /，
						// 拼进 onactivate="..." 字符串既难看又容易出错
						if (typeof btn.SetPanelEvent === "function") {
							btn.SetPanelEvent("onactivate", function () { self.pickModel(name); });
						}
						self.modelBtns.push({ name: name, btn: btn });
					} catch (e) {}
				})(this.models[i], this, i);
			}
			this.highlightModel();
		},

		toggleModelList: function () {
			var list = this.el("DLChatSetModelList");
			if (!list) return;
			this.listOpen = !this.listOpen;
			setClass(list, "DLChatSetModelListOpen", this.listOpen);
			if (!this.listOpen) return;
			if (!(this.modelBtns || []).length) {
				this.status("读取模型列表…");
				this.loadModels();
			} else {
				this.status("点一项切换模型，然后按「保存并生效」");
			}
		},

		pickModel: function (name) {
			if (!this.local) return;
			this.local.model = name;
			this.dirty = true;
			this.listOpen = false;
			var list = this.el("DLChatSetModelList");
			if (list) setClass(list, "DLChatSetModelListOpen", false);
			this.render();
			this.status("已选：" + name + "（按「保存并生效」应用）");
		},

		// 切换来源：模型列表必须重新取，而且旧来源的模型名要立刻清掉 ——
		// 否则会出现"来源=DeepSeek、模型=hf.co/tencent/Hy-MT2..."这种组合，
		// 保存后云端收到一个不存在的模型名，报的错还很难懂。
		//
		// 为什么不能清空列表控件再重建：Panorama 里 DeleteAsync 不生效（实测），
		// 每次重建都会把旧项留在界面上、越堆越多。所以改成"不删只重建"：
		// 同一个 id 的 CreatePanel 会复用已有面板，多余的旧项用可见性挡住。
		onProviderChanged: function () {
			var self = this;
			this.models = [];
			this.modelBtns = [];
			this.listOpen = false;
			var list = this.el("DLChatSetModelList");
			if (list) setClass(list, "DLChatSetModelListOpen", false);
			if (this.local) this.local.model = "";
			var pname = this.providerName();
			this.status("已切到「" + (this.PROVIDER.label[pname] || pname)
				+ "」，读取模型列表…");
			this.loadModels(function () {
				if (!self.local) return;
				if (!self.local.model && self.models.length) {
					// 新来源还没选模型：默认取第一个（云端就是 deepseek-flash）
					self.local.model = self.models[0];
					self.dirty = true;
					self.render();
					self.status("默认模型：" + self.models[0]
						+ "（要换就点上面的「翻译模型」）");
				} else {
					self.render();
				}
			}, true);
		},

		status: function (text) { this.setText("DLChatSetStatus", text); },
		testText: function (text) { this.setText("DLChatSetTest", text); },

		// 把 compact 响应的短键解成面板内部用的名字。
		// 桥那边为了省标题通道的长度把字段名压成了一个词（recv/send/disp/…），
		// 集中在这里翻译一次，别让 c.recv 这种天书散落到业务代码里。
		decodeCompact: function (res) {
			var c = compact(res);
			if (c.disp === undefined || c.trig === undefined || c.model === undefined) {
				return null;                    // 地基字段缺了 = 响应不完整
			}
			return {
				receive_enabled: !!c.recv,
				send_enabled: !!c.send,
				display_mode: c.disp,
				outgoing_mode: c.out || "bilingual",
				show_original_on_hover: !!c.hover,
				trigger: c.trig,
				keep_alive: c.keep,
				glossary: !!c.gloss,
				provider: this.PROVIDER.byCode[c.prv] || "local",
				// 分隔符：桥传单字母码 p/f/s，认不出就用半角竖线
				separator: this.SEP_NAME[c.sep] || "pipe",
				// 上下文轮数（短句消歧）。缺省 1：老桥没有这个字段时行为要和
				// 新的默认值一致，不能变成 0（否则"升级后突然不带上下文了"）。
				context_rounds: (c.ctx === 0 || c.ctx) ? Number(c.ctx) : 1,
				model: c.model
			};
		},

		// 收到设置响应后落到面板状态（show / 自检共用这一条路）
		applyCompact: function (res) {
			var c = compact(res);
			var decoded = this.decodeCompact(res);
			if (!decoded) return false;
			this.remote = res;
			this.local = decoded;
			this.dirty = false;
			this.persisted = !!c.persisted;
			this.backend = res.backend || null;
			this.keySet = c.keySet !== false;
			this.render();
			this.status(this.summary());
			return true;
		},

		// 打开面板：显示 + 读一次设置（compact，避免标题被截断）
		show: function () {
			var panel = this.el("DLChatSettings");
			if (!panel) return;
			setClass(panel, "DLChatSettingsOpen", true);
			this.open = true;
			if (this.local) this.render();
			this.status("读取设置…");
			var self = this;
			bus.send("settings", { view: "compact" }, REQUEST_TIMEOUT, function (res) {
				if (!res || !res.ok) {
					self.status("读取失败：" + shortError(res && res.error));
					return;
				}
				if (res.trimmed) {
					// 桥发现响应太长（模型名很长时会），主动裁掉了统计字段。
					// 面板照常能用，但得说一声，免得看到"请求 0"以为桥没在工作。
					self.status("⚠ 模型名较长，响应被裁剪，统计数字可能少显示"
						+ "（功能不受影响）");
				}
				// 截断/半包检测：字段缺了就说明响应不完整。以前这种情况会静默显示一片
				// undefined，看着像"设置全丢了"。
				if (!self.applyCompact(res)) {
					self.status("读取到的设置不完整（响应可能被截断）"
						+ (res.error ? "：" + res.error : "")
						+ "，请点「重新读取」；若反复出现请告知");
				}
			});
		},

		summary: function () {
			// compact 视图是短键 + 扁平数字（req/hit/latIn/latOut/vram/loaded）。
			// 早期版本这里读的是 resource.stats 那条路径 —— 对 compact 响应永远是 0，
			// 所以状态行一直显示"请求 0 / 命中 0"，看着像没在工作。
			var s = compact(this.remote);
			var beText = "";
			var pname = this.providerName();
			if (!this.keySet && pname !== "local") {
				beText = " · ⚠ 没配 API Key（浏览器开 http://localhost:8791/settings 填一次）";
			} else if (this.isCloud()) {
				// 云端没有"显存里的模型"这回事，别拿 Ollama 的 vram 去吓用户
				beText = " · " + (this.PROVIDER.short[pname] || pname);
			} else if (s.loaded === false) beText = " · 模型未载入（下一条会慢）";
			else if (typeof s.vram === "number" && s.vram >= 0) {
				beText = " · 模型 " + s.vram + "% 在显存"
					+ (s.vram < 99 ? "（部分在 CPU，会变慢）" : "");
			}
			var link = bus.bridgeUp ? "已连通"
				: (bus.consecutiveFailures >= 2 ? "当前界面暂未连通" : "检测中");
			return "设置来源：" + (this.persisted ? "已保存" : "默认值")
				+ " · 连接：" + link
				+ beText
				+ " · 请求 " + (s.req || 0) + " / 命中 " + (s.hit || 0)
				+ " · 延迟 英→中 " + (s.latIn ? s.latIn + "ms" : "-")
				+ "，中→英 " + (s.latOut ? s.latOut + "ms" : "-");
		},

		hide: function () {
			var panel = this.el("DLChatSettings");
			if (panel) setClass(panel, "DLChatSettingsOpen", false);
			this.open = false;
		}
	};

	// 快捷键：**不提供了**。曾经用 $.RegisterKeyBind 试绑 F8（panel / namespace 两种
	// 首参都试过），实测按了没反应 —— Panorama 这边绑不出可用的全局键。
	// 打开设置面板请用聊天命令 /tongyi，或输入框那行的「设置」按钮。
	// channel.hotkey 这个字段保留：串口工具（scripts/mod_log.py）会读它，恒为 "none"。
	function noHotkey() {
		channel.hotkey = "none";
	}

	// 所有入口包一层：单点出错只影响那一次操作，并且把原因显示出来
	function safe(name, fn) {
		return function () {
			try {
				return fn.apply(null, arguments);
			} catch (e) {
				try { ui.status(name + " 出错：" + e); } catch (e2) {}
				try { $.Msg("[dlchat] " + name + " failed: " + e + "\n"); } catch (e3) {}
			}
		};
	}

	// 自检钩子：给离线测试台（scripts/js_check.js）用，直接驱动界面内部路径。
	// 为什么需要：设置读取只在拿到桥响应后才发生，离线跑不到那条路 —— 而"少一个
	// 字段就让整块界面卡死"正是发生在那里（真踩过）：render() 抛异常 -> show() 在
	// 发请求之前中断 -> 状态行永远停在"读取设置…"。这里只做本地渲染，不联网。
	//
	// 第二个钩子喂一份**真实的 compact 响应**（含短键）走一遍解码 + 渲染，
	// 这样"桥改了字段名、面板没跟上"这类事故不用进游戏就能发现。
	function exportSelfTest() {
		globalThis.DLChatSelfTest = function () {
			var report = [];
			function step(name, fn) {
				try { fn(); report.push(name + ":ok"); }
				catch (e) { report.push(name + ":FAIL(" + e + ")"); }
			}
			step("render", function () {
				ui.models = ["test/model-a", "test/model-b"];
				ui.local = {
					receive_enabled: true, send_enabled: false,
					display_mode: "bilingual", outgoing_mode: "bilingual",
					show_original_on_hover: false,
					trigger: "double_space", keep_alive: "-1", glossary: true,
					provider: "local",
					model: "test/model-b"
				};
				ui.render();
			});
			step("cycleOutgoing", function () { ui.local.outgoing_mode = "english_only"; ui.render(); });
			step("cycleProvider", function () {
				// 只切本地状态并重绘：不联网（loadModels 那条路留给联调阶段验）
				ui.local.provider = "deepseek";
				ui.local.model = "deepseek-flash";
				ui.render();
				if (!ui.isCloud()) throw new Error("provider 判定没生效");
			});
			step("cycleProviderBack", function () {
				ui.local.provider = "local";
				ui.local.model = "test/model-b";
				ui.render();
			});
			step("providerLabel", function () { ui.setText("DLChatSet_provider_l", "x"); });
			step("buildModelList", function () { ui.buildModelList(); });
			step("toggleModelList", function () { ui.toggleModelList(); });
			step("pickModel", function () { ui.pickModel("test/model-a"); });
			step("summary", function () { ui.summary(); });
			step("status", function () { ui.status("selftest"); });
			step("hide", function () { ui.hide(); });
			return report.join(" | ");
		};

		globalThis.DLChatSelfTestCompact = function (res) {
			var out = [];
			function step(name, fn) {
				try { var v = fn(); out.push(name + ":" + (v === undefined ? "ok" : v)); }
				catch (e) { out.push(name + ":FAIL(" + e + ")"); }
			}
			step("applyCloud", function () {
				if (!ui.applyCompact(res)) throw new Error("applyCompact 返回 false");
				if (ui.local.provider !== "deepseek") {
					throw new Error("来源没解出来: " + ui.local.provider);
				}
				if (ui.local.model !== "deepseek-flash") {
					throw new Error("模型没解出来: " + ui.local.model);
				}
				if (ui.local.display_mode !== "bilingual") throw new Error("显示方式没解出来");
				if (ui.local.trigger !== "double_space") throw new Error("触发键没解出来");
				if (ui.keySet !== false) throw new Error("keySet 没解出来");
				if (!ui.isCloud()) throw new Error("isCloud 判定错");
				// 分隔符：桥传单字母码，要解成选项名并拼出真正的字符串
				var want = res.sep === "f" ? "full" : (res.sep === "s" ? "space" : "pipe");
				if (ui.local.separator !== want) {
					throw new Error("分隔符没解出来: " + ui.local.separator);
				}
				if (!separatorText()) throw new Error("separatorText 返回空");
				return "status=" + ui.summary() + " sep=" + separatorText();
			});
			step("summaryNumbers", function () {
				var s = ui.summary();
				if (s.indexOf("请求 7") < 0) throw new Error("统计数字没渲染: " + s);
				if (s.indexOf("Key") < 0) throw new Error("缺 Key 没提示: " + s);
				return "ok";
			});
			step("truncatedResponse", function () {
				// 半包（少掉地基字段）必须被识别成"不完整"，而不是渲染出一片 undefined
				if (ui.applyCompact({ ok: true, recv: true })) {
					throw new Error("半包响应竟然被接受了");
				}
				return "ok";
			});
			return out.join(" | ");
		};

		// 传输层探针：给离线测试台看"请求到底发出去了没有"
		globalThis.DLChatSelfTestBus = function () {
			try {
				return "mode=" + channel.mode + " probe=" + channel.probeError
					+ " up=" + bus.bridgeUp + " inflight=" + (bus.inflight ? bus.inflight.op : "-")
					+ " queued=" + bus.queue.length
					+ " panel=" + !!bus.findPanel();
			} catch (e) { return "bus_probe_threw:" + e; }
		};
		globalThis.DLChatSelfTestConnection = function () {
			var oldUp = bus.bridgeUp, oldFailures = bus.consecutiveFailures;
			var label = status.el(), oldText = readText(label), oldHideAt = status.hideAt;
			var panelStatus = ui.el("DLChatSetStatus"), oldPanelText = readText(panelStatus);
			var dot = ui.el("DLChatDot"), out = [];
			function check(name, up, failures, res, phrase, cls) {
				bus.bridgeUp = up;
				bus.consecutiveFailures = failures;
				updateDot();
				showHealthResult(res);
				var actual = readText(label);
				out.push(name + ":" + (actual.indexOf(phrase) !== -1
					&& hasClass(dot, cls) ? "ok" : "FAIL(" + actual + ")"));
			}
			try {
				check("transient", true, 1, { ok: false, error: "timeout" },
					"可用", "DLChatDotWarn");
				check("checking", false, 1, { ok: false, error: "timeout" },
					"确认连接", "DLChatDotWarn");
				check("unavailable", false, 2, { ok: false, error: "timeout" },
					"当前界面暂未连通", "DLChatDotBad");
				check("recovered", true, 0, { ok: true },
					"就绪", "DLChatDotOk");
			} finally {
				bus.bridgeUp = oldUp;
				bus.consecutiveFailures = oldFailures;
				updateDot();
				if (label) writeText(label, oldText);
				if (panelStatus) writeText(panelStatus, oldPanelText);
				status.hideAt = oldHideAt;
			}
			return out.join(" | ");
		};
		globalThis.DLChatSelfTestProbe = function (row) {
			try {
				var info = readMessageRow(row, "chat");
				if (!info) return "info=null";
				return "text=" + JSON.stringify(info.text)
					+ " surface=" + info.surface
					+ " own=" + info.own + " quick=" + info.quick
					+ " sender=" + JSON.stringify(info.sender)
					+ " skip=" + JSON.stringify(shouldSkipRow(info))
					+ " hasContents=" + isValid(info.contents);
			} catch (e) {
				return "probe_threw:" + e;
			}
		};

		// 识别层摘要：给离线测试台用。它**主动调用真实扫描函数**（不是复制一套逻辑），
		// 所以"读一行"的规则改了、测试台立刻跟着变。
		// 挂载点验证：把译文**真的画一遍**，然后报告它挂到了哪个容器下面。
		// 不需要桥：先往本地缓存塞一条译文，再走正常的"命中缓存"路径。
		// 这条是给"译文贴错容器"（气泡跑到外面、聊天窗叠字）兜底的断言。
		globalThis.DLChatSelfTestAttach = function (row, text, chinese) {
			try {
				var info = readMessageRow(row, "chat");
				if (!info) return "info=null";
				var rec = {
					panel: row, contents: info.contents, textLabel: info.textLabel || null,
					original: info.text, own: false, quick: false, surface: info.surface,
					chinese: "", orig: null, trans: null, logged: true,
					applied: false, pending: false, retry: 0
				};
				cachePut(text, chinese);
				translateRowText(rec, text);
				var parent = null;
				var parentClasses = "";
				try {
					parent = rec.trans ? rec.trans.GetParent() : null;
					parentClasses = panelClasses(parent);
				} catch (e) {}
				var hostClasses = panelClasses(rec.contents);
				// 底色和尺寸：这两个是"看不见"类问题的判据。
				// 官方聊天样式会把字画在白色气泡上，所以译文必须自带底色；
				// 官方容器又有固定尺寸和 overflow，所以译文必须有贴合内容的宽高。
				var bg = "";
				try { bg = (rec.trans && rec.trans.style) ? rec.trans.style.backgroundColor : ""; } catch (e) {}
				var box = function (x) {
					if (!isValid(x)) return "-";
					var w = -1, h = -1;
					try { w = (typeof x.GetWidth === "function") ? Math.round(x.GetWidth()) : -1; } catch (e) {}
					try { h = (typeof x.GetHeight === "function") ? Math.round(x.GetHeight()) : -1; } catch (e) {}
					return w + "x" + h;
				};
				return "surface=" + info.surface
					+ " host=" + (hostClasses || "(none)")
					+ " textParent=" + (parentClasses || "(none)")
					+ " attached=" + isValid(rec.trans)
					+ " sameHost=" + (parent === rec.contents)
					+ " bg=" + JSON.stringify(bg)
					+ " lbl=" + box(rec.trans)
					+ " hostBox=" + box(rec.contents);
			} catch (e) {
				return "attach_threw:" + e;
			}
		};

		// 聊天窗"双语行内"自检：**不改全局模式**（host 里的 hints 是桥下发的，测试台不该动），
		// 直接验那两件最容易做错的事 ——
		//   ① 正文那一格写成了 "英文 + 分隔符 + 中文"（而不是另起一个标签挂在气泡下面被裁掉）；
		//   ② 行上带 DLChatChatInline，用来把"悬停显示原文"那份收掉。
		// 返回的字符串是给离线测试台断言用的，格式别随便改。
		globalThis.DLChatSelfTestInline = function (row, text, chinese) {
			try {
				var info = readMessageRow(row, "chat");
				if (!info) return "info=null";
				var rec = {
					panel: row, contents: info.contents, textLabel: info.textLabel || null,
					original: info.text, own: false, quick: false, surface: "chat",
					chinese: "", orig: null, trans: null, logged: true,
					applied: false, pending: false, retry: 0
				};
				var settled = false;
				cachePut(text, chinese);
				translateRowText(rec, text);
				if (!rec.pending && rec.applied) settled = true;
				var host = translationHost(rec);
				var target = rec.textLabel;
				if (!isValid(target)) target = findTextLabel(host);
				var shown = readText(target);
				var origLbl = isValid(rec.orig) ? readText(rec.orig) : "(none)";
				var want = rec.original + (separatorText() || " | ") + chinese;
				return "surface=" + info.surface
					+ " settled=" + settled
					+ " text=" + JSON.stringify(shown)
					+ " want=" + JSON.stringify(want)
					+ " match=" + (shown.indexOf(chinese) !== -1
						&& shown.indexOf(rec.original) === 0)
					+ " inline=" + hasClass(row, "DLChatChatInline")
					+ " bilingualClass=" + hasClass(row, "DLChatBilingual")
					+ " orig=" + JSON.stringify(origLbl);
			} catch (e) {
				return "inline_threw:" + e;
			}
		};

		globalThis.DLChatSelfTestRows = function () {			var before = rows.length;
			try { scanAllSurfaces(); } catch (e) { return "scan:FAIL(" + e + ")"; }
			var counts = {};
			var queued = [];
			for (var i = 0; i < rows.length; i++) {
				var r = rows[i];
				var key = r.skipped || ((r.pending || r.applied) ? "translated" : "unknown");
				counts[key] = (counts[key] || 0) + 1;
				// "本轮新排进翻译的"：算完就清标记，避免跨轮重复计数
				if (r.queuedNow) { queued.push(r.original); r.queuedNow = false; }
			}
			var parts = [];
			for (var k in counts) parts.push(k + "=" + counts[k]);
			var detail = [];
			for (var m = 0; m < rows.length; m++) {
				var one = rows[m];
				if (!one.skipped) {
					detail.push(JSON.stringify({
						t: one.original, s: one.surface, p: !!one.pending,
						a: !!one.applied, r: one.retry || 0
					}));
				}
			}
			return "rows=" + rows.length + "(+" + (rows.length - before) + ") "
				+ parts.sort().join(",") + " | queued=" + JSON.stringify(queued)
				+ (detail.length ? " | detail=" + detail.join(" ") : "");
		};

		// 给测试台的探针：**用真正扫描时那个入口**（readMessageRow）读一行，而不是
		// 自己按 class 猜。scanAllSurfaces 判定"这一行是什么文字"用的就是它，
		// 所以占位有没有污染正文，只有它能给出实话。
		// （老钩子 DLChatSelfTestProbe 把 surface 硬写成 "chat"，对气泡行会读错地方。）
		function probeRowInfo(row) {
			try {
				var info = readMessageRow(row, null);
				if (!info) return "info=null";
				return "surface=" + info.surface + " text=" + JSON.stringify(info.text)
					+ " skip=" + JSON.stringify(shouldSkipRow(info));
			} catch (e) { return "probe_threw:" + e; }
		}

		// "翻译中"占位的自检：别人发来的消息要等 1 秒多才有译文，中间这一段
		// 屏幕上原本什么都不发生。这里把**真实的那条路**跑一遍（不是复制一套逻辑）：
		//   ① 延迟没到 -> 不许显示（缓存命中 0ms，无脑显示会闪）
		//   ② 延迟到了 -> 占位要出现，而且**不能被当成消息原文**读回去
		//   ③ 译文到了   -> 原地换成译文，占位收干净
		//   ④ 行被回收   -> 旧占位收掉，按新消息重来
		// 时间靠把 pendingSince 往前拨来推进（测试台的 $.Schedule 桩不带时间）。
		// keepRow=true 时不模拟"行被回收"，留给测试台接着验别的（比如再扫一轮）。
		globalThis.DLChatSelfTestPending = function (row, text, chinese, keepRow) {
			try {
				var info = readMessageRow(row, "chat");
				if (!info) return "info=null";
				cacheForget(text);                       // 别让别的用例灌进来的缓存干扰
				var rec = rowRecord(row);
				if (!rec) {
					rec = {
						panel: row, contents: info.contents, textLabel: info.textLabel || null,
						original: info.text, own: false, quick: false, surface: info.surface,
						chinese: "", orig: null, trans: null, logged: true,
						applied: false, pending: false, retry: 0,
						pendingLabel: null, pendingShown: false, pendingShownText: null,
						pendingSince: 0, settleBy: 0, queuedAt: 0, inlinePending: false,
						failed: false, fails: 0, failedMarked: false, failedAt: 0
					};
					rows.push(rec);
				}
				var out = [];
				translateRowText(rec, text);              // 真实入口：进 pending、发请求
				pendingTick(nowSeconds());                // 延迟没到
				out.push("early=" + (rec.pendingShown ? "shown" : "none"));
				rec.pendingSince = 0;                     // 把时钟往前拨到"早就该显示了"
				pendingTick(nowSeconds());
				out.push("delayed=" + (rec.pendingShown ? "shown" : "none"));
				out.push("label=" + JSON.stringify(readText(rec.pendingLabel)));
				out.push("cls=" + hasClass(rec.pendingLabel, "DLChatPending"));
				// 内联底色：气泡那一路全靠它（官方 HUD 的长选择器不覆盖我们注入的标签）。
				// 顺手验"占位和真译文的底色确实不一样" —— 一样的话玩家分不出翻没翻好。
				var pendBg = "";
				try { pendBg = (rec.pendingLabel && rec.pendingLabel.style) ? rec.pendingLabel.style.backgroundColor : ""; } catch (e) {}
				out.push("bg=" + JSON.stringify(pendBg));
				// 这一格（聊天窗就是游戏自己的正文格）现在长什么样：测试台拿它确认
				// "英文 | ···"。要在这里报，**不能**等回收那一步之后再读（那时已被改成新消息）。
				out.push("cell=" + JSON.stringify(readText(rec.textLabel)));
				// 占位绝不能进"消息原文"：否则下一轮会拿 "he is low ···" 去翻译。
				// clean 查的是 collectText，probe 查的是**真正扫描用的** readMessageRow
				// （两个都得干净：collectText 是它的一部分，但只有 probe 能看出
				// "占位挂在行容器下、被祖先那一层拼进去"这种漏网）。
				out.push("clean=" + (collectText(rec.panel) === text));
				out.push("probe={" + probeRowInfo(rec.panel) + "}");
				applyTranslation(rec, chinese);           // 译文到达
				out.push("after=" + JSON.stringify(readText(rec.trans)));
				out.push("afterCls=" + hasClass(rec.trans, "DLChatPending"));
				// 真译文必须把 .DLChatTranslation 加回来（两个类是互斥的，见 setPendingVisual）
				out.push("afterTransCls=" + hasClass(rec.trans, "DLChatTranslation"));
				var afterBg = "";
				try { afterBg = (rec.trans && rec.trans.style) ? rec.trans.style.backgroundColor : ""; } catch (e) {}
				out.push("afterBg=" + JSON.stringify(afterBg));
				out.push("afterClean=" + (collectText(rec.panel) === text));
				out.push("afterProbe={" + probeRowInfo(rec.panel) + "}");
				out.push("samePanel=" + (rec.pendingLabel === rec.trans));
				if (keepRow === "keep") return out.join(" ");
				// 行被游戏回收去显示别的消息：旧占位必须收掉，否则会挂在新消息下面
				var cell = rec.textLabel;
				if (isValid(cell)) writeText(cell, "push now");
				pendingTick(nowSeconds());
				out.push("recycledGone=" + !rec.pendingShown);
				out.push("recycledRead=" + JSON.stringify(readRowText(cell)));
				return out.join(" ");
			} catch (e) {
				return "pending_threw:" + e;
			}
		};

		// 翻不出来的自检：原来这种情况是**完全没有反馈**（英文留在那儿，什么都不说）。
		// 现在至少在这一行上标一下，而且失败提示不能被读成消息原文。
		globalThis.DLChatSelfTestPendingFail = function (row, text) {
			try {
				var info = readMessageRow(row, "chat");
				if (!info) return "info=null";
				cacheForget(text);
				var rec = rowRecord(row);
				if (!rec) {
					rec = {
						panel: row, contents: info.contents, textLabel: info.textLabel || null,
						original: info.text, own: false, quick: false, surface: info.surface,
						chinese: "", orig: null, trans: null, logged: true,
						applied: false, pending: false, retry: 0,
						pendingLabel: null, pendingShown: false, pendingShownText: null,
						pendingSince: 0, settleBy: 0, queuedAt: 0, inlinePending: false,
						failed: false, fails: 0, failedMarked: false, failedAt: 0
					};
					rows.push(rec);
				}
				translateRowText(rec, text);
				rec.pendingSince = 0;
				pendingTick(nowSeconds());
				markRowFailed(rec, "timeout");            // 等价于"请求卡死 / 重试预算用完"
				pendingTick(nowSeconds());
				var out = [];
				out.push("failed=" + rec.failedMarked);
				out.push("text=" + JSON.stringify(readText(rec.pendingLabel)));
				out.push("cls=" + hasClass(rec.pendingLabel, "DLChatFailed"));
				out.push("clean=" + (collectText(rec.panel) === text));
				rec.failedAt = nowSeconds() - FAIL_SHOW_SECONDS - 1;   // 提示停留时间到
				pendingTick(nowSeconds());
				out.push("cleared=" + !rec.failedMarked);
				// 提示收掉之后这一格还剩什么：聊天窗不能留一个孤零零的分隔符（"英文 |"）
				out.push("cellAfter=" + JSON.stringify(readText(rec.textLabel)));
				return out.join(" ");
			} catch (e) {
				return "pending_fail_threw:" + e;
			}
		};

		// 错误文案：玩家看到的那句话，必须永远是可读的原因。
		// 血泪教训：曾经把整个响应对象传给 shortError()，String({}) -> "[object Object]"，
		// 游戏里显示"翻译失败（[object Object]）"——等于没给任何排查线索。
		// 这里把"传对象 / 传空 / 传机器码 / 传中文说明"四种形态都钉住。
		globalThis.DLChatSelfTestErrors = function () {
			var out = [];
			function step(name, fn) {
				try { out.push(name + "=" + fn()); }
				catch (e) { out.push(name + ":FAIL(" + e + ")"); }
			}
			// 1) 完整响应对象（就是出 bug 的那次调用形态）
			step("objectRes", function () {
				return shortError({ ok: false, error: "API Key 无效或未设置" });
			});
			// 2) 对象里没有可读原因
			step("objectNoReason", function () {
				return shortError({ ok: false });
			});
			// 3) 空的 / 未定义的响应（桥没回包）
			step("emptyObj", function () { return shortError({}); });
			step("undef", function () { return shortError(undefined); });
			step("nullRes", function () { return shortError(null); });
			// 4) 机器码要翻译成人话
			step("codeTimeout", function () { return shortError("timeout_no_response"); });
			step("codeTooLong", function () { return shortError("payload_too_long"); });
			// 5) 桥返回的中文说明要原样给出（不能砍掉"去哪配 Key"）
			step("chineseHint", function () {
				return shortError("API Key 无效或未设置（在 http://localhost:8791/settings 里填）");
			});
			// 6) 断言：任何形态都不许出现 [object Object]
			var shapes = [{ ok: false, error: "x" }, {}, undefined, null, 0, "internal_error: boom"];
			for (var i = 0; i < shapes.length; i++) {
				var got = String(shortError(shapes[i]));
				if (got.indexOf("[object") !== -1) out.push("BAD_objectString=" + got);
			}
			return out.join(" ");
		};
		globalThis.DLChatSelfTestSettlement = function () {
			var text = "selftest-settle-once";
			var previousFailure = lastFailure;
			var previousAlive = channel.pageAlive;
			var result = [];
			try {
				lastFailure = { text: "", at: 0 };
				var rec = { pending: true, panel: null, contents: null, fails: 0 };
				settleRowText(text, "已译", [rec], { ok: true });
				result.push("success:" + (!rec.pending && !lastFailure.text ? "ok" : "FAIL"));
				settleRowText(text, "", [rec], null); // 已收尾的行不能再报“桥没响应”
				result.push("duplicate:" + (!lastFailure.text ? "ok" : "FAIL"));

				var job = { op: "translate" }, calls = 0;
				var fake = { inflight: job, panel: null, applyResult: function () { calls += 1; } };
				channel.pageAlive = true;
				bus.timeoutPanel.call(fake, job);
				bus.timeoutPanel.call(fake, job);
				result.push("timeoutOnce:" + (calls === 1 && !fake.inflight ? "ok" : "FAIL"));
			} catch (e) {
				result.push("threw:FAIL(" + e + ")");
			} finally {
				cacheForget(text);
				lastFailure = previousFailure;
				channel.pageAlive = previousAlive;
			}
			return result.join(" | ");
		};

		// 本轮新增的三块逻辑也拉进离线测试台：都是"纯计算"，不需要桥在线。
		//   · 输入正文的清洗（换行/连续空格）
		//   · 译文缓存（同一句只翻一次）
		//   · 队列优先级（玩家输入插队）
		globalThis.DLChatSelfTestQueue = function () {
			var out = [];
			function step(name, fn) {
				try { var v = fn(); out.push(name + ":" + (v === undefined ? "ok" : v)); }
				catch (e) { out.push(name + ":FAIL(" + e + ")"); }
			}

			step("sanitize", function () {
				if (sanitizeBody("小心\n对面  绕后 ") !== "小心 对面 绕后") {
					throw new Error("清洗结果: " + JSON.stringify(sanitizeBody("小心\n对面  绕后 ")));
				}
				if (sanitizeBody("中文\r\n\r\n英文") !== "中文 英文") {
					throw new Error("换行没压平");
				}
				if (sanitizeBody(null) !== "") throw new Error("null 没处理");
				return "ok";
			});

			step("cache", function () {
				// 这是测试台自己的缓存实例：不往真实缓存里灌测试数据
				var map = {}, order = [];
				function get(t) {
					var hit = map[t];
					if (typeof hit !== "string") return null;
					var at = order.indexOf(t);
					if (at !== -1) { order.splice(at, 1); order.push(t); }
					return hit;
				}
				function put(t, v) {
					if (typeof map[t] !== "string") order.push(t);
					map[t] = v;
					while (order.length > 3) delete map[order.shift()];
				}
				put("b b b", "撤撤撤");
				if (get("b b b") !== "撤撤撤") throw new Error("命中不了");
				// 超过上限要被淘汰（防内存无限长）
				put("a", "1"); put("b", "2"); put("c", "3");
				if (get("b b b") !== null) throw new Error("超上限没淘汰");
				// 换行/空格不同的同一句必须算不同 key（不能张冠李戴）
				if (get("b b  b") !== null) throw new Error("key 被错误归一化");
				return "ok";
			});

			step("priority", function () {
				// 队列是严格串行的，玩家自己触发的（lane=fast）必须排到前面去，
				// 否则要排在屏幕上那堆聊天行后面 —— 那是体感上最像"卡住"的地方。
				var q = [], seq = 0;
				function push(lane) {
					var job = { n: ++seq, lane: lane || "bg" };
					if (lane === "fast") {
						var at = 0;
						while (at < q.length && q[at].lane === "fast") at++;
						q.splice(at, 0, job);
					} else {
						q.push(job);
					}
					return job;
				}
				push(); push(); push();                 // 三条后台（聊天行）
				var mine = push("fast");                // 玩家输入
				if (q[0] !== mine) throw new Error("插队没生效，队首是 " + q[0].n);
				var mine2 = push("fast");               // 再来一条玩家输入
				if (q[1] !== mine2) throw new Error("第二条插队位置不对");
				if (q[2].lane !== "bg") throw new Error("后台任务被挤没了");
				return "ok";
			});

			return out.join(" | ");
		};
	}

	function exportGlobals() {
		try {
			globalThis.DLChatOpenSettings = safe("打开设置", function () { ui.show(); });
			globalThis.DLChatCloseSettings = safe("关闭设置", function () { ui.hide(); });
			globalThis.DLChatToggle = safe("切换", function (key) {
				if (!ui.local) return;
				ui.local[key] = !ui.local[key];
				ui.dirty = true;
				ui.render();
			});
			globalThis.DLChatCycle = safe("循环", function (key) {
				if (!ui.local) return;
				var list = ui.CYCLE[key] || [];
				if (!list.length) return;
				var cur = list.indexOf(ui.local[key]);
				ui.local[key] = list[(cur + 1) % list.length];
				ui.dirty = true;
				if (key === "provider") ui.onProviderChanged();
				ui.render();
			});
			globalThis.DLChatSaveSettings = safe("保存", function () {
				if (!ui.local) {
					// 读取还没回来就点保存：明确告诉用户，不要静默什么都不做
					ui.status("还没读取到设置，等状态行变成桥信息后再保存");
					return;
				}
				ui.status("保存中…");
				// prv 是来源的单字母码：桥据此切 base_url、必要时把模型名换成该来源的
				// 有效值（比如从本地模型名切到 deepseek-flash）。
				var payload = {};
				for (var k in ui.local) payload[k] = ui.local[k];
				payload.prv = ui.PROVIDER.byName[ui.local.provider] || "";
				bus.send("settings", payload, REQUEST_TIMEOUT, function (res) {
					if (res && res.ok) {
						ui.remote = res.settings || null;
						ui.dirty = false;
						ui.persisted = true;
						// 回执里带上来源/模型/密钥状态，面板立刻显示新状态，不用重新读一遍
						var back = res.settings || {};
						if (back.pv) {
							ui.local.provider = ui.PROVIDER.byCode[back.pv]
								|| ui.local.provider;
						}
						if (back.model) ui.local.model = back.model;
						ui.render();
						ui.status("已保存并生效"
							+ (res.saved ? "（已写入设置文件，重启后依然有效）" : "")
							+ (res.modelReloaded ? "（模型已重载，首次翻译会慢几秒）" : "")
							+ (res.partial ? "（回执不完整，不影响生效）" : ""));
					} else {
						ui.status("保存失败：" + shortError(res && res.error));
					}
				});
			});
			globalThis.DLChatToggleModels = safe("模型下拉", function () { ui.toggleModelList(); });
			globalThis.DLChatReloadSettings = safe("重新读取", function () { ui.show(); });
			// 翻错了/超时了之后的补救：重译聊天区里最近一条英文
			globalThis.DLChatRetranslateLast = safe("重译最近一条", function () {
				retranslateLast();
			});
			globalThis.DLChatShowHistory = safe("最近译文", function () {
				showHistoryPage();
			});
			globalThis.DLChatTestSettings = safe("试翻", function () {
				ui.testText("测试中…（本地首次要等模型载入；云端要等一次网络往返）");
				bus.send("settings/test",
					{ text: "he is low, dive him" }, 90, function (res) {
						if (res && res.ok) {
							ui.testText("英→中 " + res.translation + "  (" + res.ms + "ms)"
								+ "   |   中→英 " + res.back + "  (" + res.backMs + "ms)");
						} else if (res && res.hint) {
							// 密钥没配这种情况桥会额外给一句"去哪配"，直接显示出来
							ui.testText("测试失败：" + shortError(res.error) + " —— " + res.hint);
						} else {
							ui.testText("测试失败：" + shortError(res && res.error));
						}
					});
			});
		} catch (e) {
			// 这里如果出错，说明布局里的 onactivate 名字和脚本对不上
			try { $.Msg("[dlchat] exportGlobals failed: " + e + "\n"); } catch (e2) {}
		}
	}

	// 状态灯：绿=能用（正常）、黄=最近有失败但还在凑合、红=不通
	// 注意不要把"走兜底通道"标成黄：引擎已经删掉了直连 API
	// （panorama.dll: "ERROR: AsyncWebRequest has been removed."），
	// 面板通道就是这个版本唯一的通道，把它当成异常会让灯永远是黄的、等于没信息。
	// 通道类型放到设置面板的状态行里显示，那才是看细节的地方。
	function updateDot() {
		var dot = ui.el("DLChatDot");
		if (!dot) return;
		var up = bus.bridgeUp;
		var degraded = (up && bus.consecutiveFailures > 0)
			|| (!up && bus.consecutiveFailures > 0 && bus.consecutiveFailures < 2);
		setClass(dot, "DLChatDotOk", up && !degraded);
		setClass(dot, "DLChatDotWarn", degraded);
		setClass(dot, "DLChatDotBad", !up && bus.consecutiveFailures >= 2);
	}

	function diag() {
		var p = channel.mode === "http"
			? ("ok-" + (channel.httpStyle || "?"))
			: (channel.probeError || "?").replace(/^threw:/, "threw");
		return "P:" + p.substring(0, 12)
			+ " A:" + apiProbe.arity
			+ " R:" + apiProbe.retType
			+ " K:" + apiProbe.keys.substring(0, 16)
			+ " C:" + (apiProbe.cbShape || "-")
			+ " V:" + (channel.panelOnScreen === null ? "-" : (channel.panelOnScreen ? 1 : 0))
			+ " E:" + channel.eventCount + "/" + channel.eventsRegistered
			+ " T:" + channel.titleKind
			+ " N:" + channel.navCount
			+ " G:" + (channel.pingLocal === null ? "-" : (channel.pingLocal ? 1 : 0))
			+ "/" + (channel.pingIp === null ? "-" : (channel.pingIp ? 1 : 0));
	}

	// 面板是不是真的"在屏幕上"：一路往上看父节点，任何一层 visible=false 就说明
	// 整棵子树都没渲染。**这点很关键**：聊天面板关着的时候 CitadelChat 是收起的，
	// 里面的 HTML 面板不会渲染 —— 此时 SetURL 导航会被丢掉，而且有可能把面板弄成
	// "死面板"，之后怎么导航都没反应（"面板未加载"就是这么来的）。
	function panelOnScreen(panel) {
		if (!isValid(panel)) return false;
		var node = panel;
		for (var depth = 0; depth < 8 && isValid(node); depth++) {
			try { if (node.visible === false) return false; } catch (e) {}
			try {
				if (typeof node.IsVisible === "function" && !node.IsVisible()) return false;
			} catch (e) {}
			try { node = node.GetParent(); } catch (e) { break; }
		}
		return true;
	}

	// 等面板真的显示出来再发请求；期间只轮询、不导航
	function waitForPanel(deadline, done) {
		var panel = bus.findPanel();
		if (!panel) { done(false); return; }
		if (panelOnScreen(panel)) { done(true); return; }
		if (nowSeconds() > deadline) { done(false); return; }
		try { $.Schedule(0.5, function () { waitForPanel(deadline, done); }); }
		catch (e) { done(false); }
	}

	// 导航探针：让隐藏面板加载桥的 /ping 页（**没有任何 fetch**，标题就是标记串）。
	// 这一步把"面板导航/标题读回"和"桥页面里的 fetch"彻底分开：
	//   G:1  -> 面板通道本身是好的，问题在 /bridge 页面
	//   G:0  -> 面板导航压根不工作（URL 被拦，或者那根本不是可用的 HTML 面板）
	// 同时分别试 localhost 和 127.0.0.1，验证"回环 IP 被拦"的说法。
	function panelPing(host, marker, tries, done) {
		var panel = bus.findPanel();
		if (!panel || typeof panel.SetURL !== "function") { done(false); return; }
		if (!panelOnScreen(panel)) { done(false); return; }
		var url = "http://" + host + ":" + BRIDGE_PORT + "/ping?m=" + marker;
		try { panel.SetURL(url); } catch (e) { done(false); return; }
		var deadline = nowSeconds() + 8;
		function poll() {
			var title = bus.readTitle();
			if (title && title.indexOf(marker) !== -1) { done(true); return; }
			if (nowSeconds() > deadline) {
				if (tries > 1) { panelPing(host, marker, tries - 1, done); return; }
				done(false);
				return;
			}
			try { $.Schedule(0.2, poll); } catch (e) { done(false); }
		}
		try { $.Schedule(0.2, poll); } catch (e) { done(false); }
	}

	function probePanelNavigation(done) {
		panelPing("localhost", "DLPINGL", 1, function (okLocal) {
			channel.pingLocal = okLocal;
			if (okLocal) {
				// 本地回环通了就够了，不用再折腾 IP 形式
				channel.pingIp = channel.pingIp === null ? false : channel.pingIp;
				done();
				return;
			}
			panelPing("127.0.0.1", "DLPINGI", 1, function (okIp) {
				channel.pingIp = okIp;
				done();
			});
		});
	}

	function probeHttpChannel() {
		if (channel.mode !== null) return channel.mode === "http";
		var hasFn = false;
		try { hasFn = typeof $.AsyncWebRequest === "function"; } catch (e) {}
		if (!hasFn) {
			channel.mode = "panel";
			channel.probeError = "no_fn";
			return false;
		}
		var url = BRIDGE_BASE + "/api/v1/health";
		// 形态 1：现代 API，返回 Promise<string>
		try {
			var probe = $.AsyncWebRequest(url, { type: "GET", timeout: 3000 });
			if (probe && typeof probe.then === "function") {
				channel.mode = "http";
				channel.httpStyle = "promise";
				try { probe.then(function () {}, function () {}); } catch (e) {}
				return true;
			}
			// 形态 2：旧 API，返回一个带 SendRequest 的请求对象
			if (probe && typeof probe.SendRequest === "function") {
				channel.mode = "http";
				channel.httpStyle = "send";
				return true;
			}
			channel.probeError = "no_promise_no_sendrequest";
		} catch (e) {
			// 典型：AsyncWebRequest has been removed（函数在但一调就抛）
			channel.probeError = "threw:" + e;
			try {
				var retry = $.AsyncWebRequest(url);
				if (retry && typeof retry.SendRequest === "function") {
					channel.mode = "http";
					channel.httpStyle = "send";
					return true;
				}
				channel.probeError += "|retry_none";
			} catch (e2) {
				channel.probeError += "|retry_threw";
			}
		}
		channel.mode = "panel";
		return false;
	}

	// ---------------------------------------------------------------- 传输层
	// 串行队列 + 唯一请求 id：title 是单槽通道，靠 id 前缀区分"这是谁的响应"，
	// 迟到的旧响应因为 id 不同会被直接丢弃，不会串台。
	var bus = {
		panel: null,
		seq: 0,
		inflight: null,
		queue: [],
		bridgeUp: false,
		consecutiveFailures: 0,
		firstDone: false,

		findPanel: function () {
			if (isValid(this.panel)) return this.panel;
			var root = null;
			try { root = $.GetContextPanel(); } catch (e) { return null; }
			var found = null;
			try { found = root.FindChildTraverse("DLChatBridge"); } catch (e) {}
			if (!found) found = findByClass(root, "DLChatBridge");
			if (found) this.panel = found;
			return found;
		},

		readTitle: function () {
			// 三个来源合起来看：面板事件（主） + panel.title + 属性回读（兜底）
			var parts = [];
			if (channel.lastEventText) parts.push(channel.lastEventText);
			var p = this.panel;
			if (isValid(p)) {
				try { var t = p.title; if (typeof t === "string" && t) parts.push(t); } catch (e) {}
				try {
					var a = p.GetAttributeString("title", "");
					if (a) parts.push(a);
				} catch (e) {}
			}
			return parts.join(" ");
		},

		// 面板事件来了：先看有没有我们要的响应，再交给等着的请求去判定
		onPanelText: function (text) {
			var hay = String(text || "");
			if (hay.indexOf("lct-alive") !== -1) channel.pageAlive = true;
			var cur = this.inflight;
			if (!cur || !cur.panelMode || !cur.id) return;
			var marker = TITLE_PREFIX + cur.id;
			var idx = hay.indexOf(marker);
			if (idx === -1) return;
			var body = hay.substring(idx + marker.length);
			// 事件文本后面可能粘着别的字段，截到最后一个 } 为止
			var end = body.lastIndexOf("}");
			if (end !== -1) body = body.substring(0, end + 1);
			var data = parseLoose(body);
			if (!data) { channel.lastBadBody = body.substring(0, 120); }
			this.inflight = null;
			this.applyResult(cur, data || { ok: false, error: "event_bad_json" });
		},

		// 发一个请求：op 走桥的路由（translate / health / log ...），payload 是 JSON 对象。
		//
		// lane="fast" 是**插队**：队列严格串行（一次只有一个在途请求），而聊天行翻译
		// 会一次性排很多条。玩家按了触发键、或者点了「试翻/保存」，不该排在那些后面
		// 干等（6 条英文 ≈ 5 秒）—— 那是体感上最像"卡住"的地方。插队只改顺序，
		// 不改任何协议。
		send: function (op, payload, timeout, cb, lane) {
			var job = { op: op, payload: payload, cb: cb,
				timeout: timeout || REQUEST_TIMEOUT, lane: lane || "bg" };
			if (lane === "fast") {
				var at = 0;
				while (at < this.queue.length && this.queue[at].lane === "fast") at++;
				this.queue.splice(at, 0, job);
			} else {
				this.queue.push(job);
			}
			this.pump();
		},

		// 只用来推诊断日志，不关心结果
		log: function (payload) {
			if (!DEBUG) return;
			this.send("log", payload, 8, null);
		},

		pump: function () {
			if (this.inflight || !this.queue.length) return;
			var job = this.queue[0];
			if (probeHttpChannel()) {
				this.queue.shift();
				this.sendViaHttp(job);
				return;
			}
			var panel = this.findPanel();
			if (!panel || typeof panel.SetURL !== "function") {
				this.queue.shift();
				if (job.cb) job.cb({ ok: false, error: "no_bridge_panel" });
				return;
			}
			this.queue.shift();
			this.sendViaPanel(job, panel);
		},

		// ---- 通道 1：引擎 HTTP 直连（每条请求独立，最可靠）----
		sendViaHttp: function (job) {
			var body = job.payload ? JSON.stringify(job.payload) : "{}";
			var url = BRIDGE_BASE + "/api/v1/" + job.op + "?d=" + enc(body);
			var self = this;
			var settle = function (result) {
				if (self.inflight !== job) return;      // 已超时处理过
				self.inflight = null;
				self.applyResult(job, result);
			};
			var parse = function (resp) {
				if (resp && typeof resp === "object") return resp;   // 引擎直接给了对象
				var data = parseLoose(String(resp));                 // 允许被截断的回执
				return data || { ok: false, error: "http_bad_json" };
			};
			this.inflight = job;
			try {
				$.Schedule((job.timeout || REQUEST_TIMEOUT) + 5, function () {
					settle({ ok: false, error: "http_timeout" });
				});
			} catch (e) {}
			try {
				var req = $.AsyncWebRequest(url, {
					type: "GET", timeout: (job.timeout || REQUEST_TIMEOUT) * 1000
				});
				if (req && typeof req.SendRequest === "function") {
					req.SendRequest(function (status, resp) {
						settle(parse(resp !== undefined ? resp : status));
					});
					return;
				}
				if (req && typeof req.then === "function") {
					req.then(function (resp) { settle(parse(resp)); },
						function (err) {
							settle({ ok: false, error: "http_failed:" + (err && err.message ? err.message : err) });
						});
					return;
				}
				// 启动时探测到的是"回调形态"，就按那个形态发
				if (channel.httpStyle === "cb" && channel.cbShape) {
					this.callWithCallback(channel.cbShape, url, job, settle, parse);
					return;
				}
				channel.mode = "panel";             // 探测通过但这里没给可用对象
				channel.probeError = "no_promise_at_call";
				settle({ ok: false, error: "http_no_promise" });
			} catch (e) {
				channel.mode = "panel";                 // 直连真抛了，退回面板通道
				channel.probeError = "call_threw:" + e;
				settle({ ok: false, error: "http_threw" });
			}
		},

		// 按探测到的签名形态发请求（每种形态的回调被触发过才走这里）
		callWithCallback: function (shape, url, job, settle, parse) {
			var timeout = (job.timeout || REQUEST_TIMEOUT) * 1000;
			var cb = function (a, b) {
				var cand = (typeof a === "string") ? a : (typeof b === "string" ? b : a);
				settle(parse(cand));
			};
			try {
				if (shape === "cb2") $.AsyncWebRequest(url, cb);
				else if (shape === "optcb") $.AsyncWebRequest(url, { type: "GET", timeout: timeout }, cb);
				else if (shape === "inner") {
					$.AsyncWebRequest(url, { type: "GET", timeout: timeout,
						success: cb, onload: cb, callback: cb });
				} else if (shape === "obj") {
					$.AsyncWebRequest({ url: url, type: "GET", timeout: timeout }, cb);
				} else {
					settle({ ok: false, error: "cb_shape_unknown" });
				}
			} catch (e) {
				settle({ ok: false, error: "cb_threw:" + e });
			}
		},

		// ---- 通道 2：HTML 面板 + document.title（兜底）----
		sendViaPanel: function (job, panel) {
			// 早期版本在这里有一道"面板没显示就不导航"的闸门：出发点是想避免把面板
			// 弄成死面板，但它会把任务无限推回队首 -> 整个传输层卡死（游戏里表现为
			// 状态行永远停在"读取设置…"）。那是个基于猜测的优化，撤掉：直接导航，
			// 失败就按超时处理，至少不会卡住队列。
			this.seq += 1;
			var id = "d" + this.seq;
			var body = job.payload ? JSON.stringify(job.payload) : "";
			// 把我们的超时也告诉页面：页面自己默认 8 秒就放弃，而冷启动的一次
			// 翻译可能就要 6-8 秒（游戏占着 GPU 时更久），回执会变成 bridge_timeout
			var ms = Math.min(Math.round((job.timeout || REQUEST_TIMEOUT) * 1000), 120000);
			var url = BRIDGE_BASE + "/bridge?id=" + id + "&op=" + job.op
				+ "&timeoutMs=" + ms + "&d=" + enc(body) + "&_=" + this.seq;
			var timeout = this.firstDone ? job.timeout : Math.max(job.timeout, FIRST_TIMEOUT);
			job.id = id;
			job.deadline = nowSeconds() + timeout;
			job.panelMode = true;
			this.inflight = job;
			channel.navCount += 1;

			// 导航：SetURL 优先，然后确认面板真的收下了地址（回读 src / url）。
			// 收不下就换别的写法试，并把结果记进诊断码，省得来回猜。
			var accepted = false;
			try {
				if (typeof panel.SetURL === "function") { panel.SetURL(url); accepted = true; }
			} catch (e) { channel.probeError = "seturl_threw:" + e; }
			try {
				if (!accepted && panel.url !== undefined) { panel.url = url; accepted = true; }
			} catch (e) {}
			try {
				if (!accepted && typeof panel.SetAttributeString === "function") {
					panel.SetAttributeString("src", url);
					accepted = true;
				}
			} catch (e) {}

			var readBack = "";
			try {
				if (typeof panel.GetAttributeString === "function") {
					readBack = String(panel.GetAttributeString("src", "") || "");
				}
			} catch (e) {}
			if (!readBack) { try { readBack = String(panel.url || ""); } catch (e) {} }
			channel.srcAccepted = (readBack.indexOf("/bridge?") !== -1) ? 1 : 0;

			if (!accepted) {
				this.inflight = null;
				this.applyResult(job, { ok: false, error: "seturl_failed:no_method" });
				return;
			}
			var self = this;
			// poll 依赖面板定时器持续运行；单独留一个看门狗，防止轮询中断后队列卡死。
			// 以真正开始导航为起点计时，排队等待不算进单请求超时。
			try { $.Schedule(timeout + 0.5, function () { self.timeoutPanel(job); }); } catch (e) {}
			try { $.Schedule(TITLE_POLL_SECONDS, function () { self.poll(); }); } catch (e) {}
		},

		timeoutPanel: function (job) {
			if (this.inflight !== job) return;        // 已收到结果或已由 poll 判超时
			this.inflight = null;
			if (!channel.pageAlive) {
				channel.panelDead = true;
				this.panel = null;
			}
			this.applyResult(job, {
				ok: false,
				error: channel.pageAlive ? "timeout_no_response" : "timeout_no_page"
			});
		},

		poll: function () {
			var cur = this.inflight;
			if (!cur || !cur.panelMode) return;
			var title = this.readTitle();
			channel.titleKind = title ? "s" : "n";
			if (title) {
				if (title.indexOf("lct-alive") === 0) channel.pageAlive = true;
				var prefix = TITLE_PREFIX + cur.id;
				var at = title.indexOf(prefix);
				if (at !== -1) {
					var data = parseLoose(title.substring(at + prefix.length));
					this.inflight = null;
					this.applyResult(cur, data || { ok: false, error: "bad_json" });
					return;
				}
			}
			if (nowSeconds() > cur.deadline) {
				this.timeoutPanel(cur);
				return;
			}
			var self = this;
			try { $.Schedule(TITLE_POLL_SECONDS, function () { self.poll(); }); } catch (e) {}
		},

		// 统一的收尾：更新桥状态 + 回调 + 跑下一个
		applyResult: function (job, result) {
			this.firstDone = true;
			var err = String((result && result.error) || "");
			if (result && result.ok) {
				this.consecutiveFailures = 0;
				this.bridgeUp = true;
			} else if (job.op === "health" || /timeout|seturl|no_bridge_panel|http_failed|http_threw/.test(err)) {
				this.consecutiveFailures += 1;
			}
			if (this.consecutiveFailures >= 2) this.bridgeUp = false;
			// 每次响应都可能带着渲染提示（显示方式/开关/触发键），跟着走就不用重装 mod
			if (result && typeof result === "object") {
				if (result.displayMode) channel.hints.displayMode = result.displayMode;
				if (result.outgoingMode) channel.hints.outgoingMode = result.outgoingMode;
				if (typeof result.showOriginal === "boolean") {
					channel.hints.showOriginal = result.showOriginal;
				}
				if (typeof result.receiveEnabled === "boolean") {
					channel.hints.receiveEnabled = result.receiveEnabled;
				}
				if (typeof result.sendEnabled === "boolean") {
					channel.hints.sendEnabled = result.sendEnabled;
				}
				if (result.trigger) channel.hints.trigger = result.trigger;
				if (typeof result.separator === "string" && result.separator) {
					channel.hints.separator = result.separator;
				}
			}
			updateDot();
			if (job.cb) {
				// 回调里出错不能把整条队列带走：之前这里裸调，回调一抛异常
				// pump 就再也不会被排上，后面所有翻译全部静默停摆。
				try { job.cb(result); }
				catch (e) {
					try { $.Msg("[dlchat] callback failed: " + e + "\n"); } catch (e2) {}
					log("callback_failed:" + job.op, { error: String(e) });
				}
			}
			var self = this;
			try { $.Schedule(0.01, function () { self.pump(); }); } catch (e) {}
		}
	};

	function log(msg, extra) {
		bus.log({ msg: String(msg), mod: MOD_TAG, extra: extra || null });
	}

	// 宽松解析：标题通道有长度上限，响应可能被截断。
	// 截断时 JSON.parse 会失败，但"操作到底成没成"往往能从 `"ok":true` 看出来 ——
	// 这种情况返回 {ok:true, partial:true}，让界面提示"已生效（回执不完整）"，
	// 而不是把一次成功的保存报成失败。根治办法仍是不发大包（桥侧已改成小回执）。
	function parseLoose(text) {
		var body = String(text || "").replace(/^\s+|\s+$/g, "");
		if (body.charAt(0) !== "{") {
			var start = body.indexOf("{");
			if (start === -1) return null;
			body = body.substring(start);
		}
		try { return JSON.parse(body); } catch (e) {}
		// 退一步：按最后一个 } 截断再试
		var cut = body.lastIndexOf("}");
		if (cut > 0) {
			try { return JSON.parse(body.substring(0, cut + 1)); } catch (e) {}
		}
		if (/"ok"\s*:\s*true/.test(body)) return { ok: true, partial: true };
		if (/"ok"\s*:\s*false/.test(body)) return { ok: false, partial: true, error: "partial_error" };
		return null;
	}

	// ---------------------------------------------------------------- 状态提示
	// 状态提示只显示在一个地方（聊天输入框上方），而且尽量短：对局里视野宝贵。
	var status = {
		label: null,
		hideAt: 0,

		el: function () {
			if (isValid(this.label)) return this.label;
			var root = null;
			try { root = $.GetContextPanel(); } catch (e) { return null; }
			var found = null;
			try { found = root.FindChildTraverse("DLChatStatus"); } catch (e) {}
			if (found) this.label = found;
			return found;
		},

		show: function (text, seconds) {
			var el = this.el();
			if (!el) return;
			writeText(el, text);
			try { el.visible = true; } catch (e) {}
			this.hideAt = nowSeconds() + (seconds || STATUS_HOLD_SECONDS);
		},

		tick: function () {
			if (!this.hideAt || nowSeconds() < this.hideAt) return;
			this.hideAt = 0;
			var el = this.el();
			if (el) { try { el.visible = false; } catch (e) {} }
		}
	};

	// ---------------------------------------------------------------- 失败留痕
	var lastFailure = { text: "", at: 0 };
	// 同一批聊天行会一起失败（桥不通时屏幕上几条同时超时），状态行和面板各刷一遍太吵。
	// 同一个原因在 NOTE_DEDUP_SECONDS 内只报一次；换了原因或者过了窗口照常报。
	var NOTE_DEDUP_SECONDS = 6;
	var lastNote = { text: "", at: 0 };

	function failureReason(res, fallback) {
		if (res && res.error) return String(res.error);
		// 回包被通道截断时 parseLoose 只能给 {ok:true, partial:true}：
		// 没有 error 字段，以前一律落到"未知原因"——玩家拿着这句话没法排查。
		if (res && res.partial) return "回包被截断（内容太长），已按不完整处理";
		if (!res) return "桥没响应（超时）";
		return fallback || "未知原因";
	}

	function noteFailure(direction, res, source) {
		var why = failureReason(res);
		lastFailure = { text: direction + " 失败：" + why, at: nowSeconds() };
		var key = direction + "|" + why;
		var now = nowSeconds();
		if (key === lastNote.text && now - lastNote.at < NOTE_DEDUP_SECONDS) {
			// 同一个原因刚报过：日志照记（排查要看全量），状态行/面板不再重复刷
			log("failed_dup:" + direction + ":" + String(source || "").substring(0, 60),
				{ error: why });
			return;
		}
		lastNote = { text: key, at: now };
		// 状态行给人话，但**不再砍成 24 个字符**：桥返回的中文说明里
		// "去哪配 Key"这种关键信息正好在尾巴上（短错误码仍然缩写）。
		status.show(shortError(why), 8);
		log("failed:" + direction + ":" + String(source || "").substring(0, 60),
			{ error: why });
		ui.renderFailure();
	}

	function clearFailure() {
		if (!lastFailure.text) return;
		lastFailure = { text: "", at: 0 };
		lastNote = { text: "", at: 0 };     // 失败已经过去：同一个原因下次要能重新报出来
		ui.renderFailure();
	}

	// ---------------------------------------------------------------- 自己发出去的消息
	// 我们把手打的中文换成英文再发出去，这条英文消息会像别人的消息一样回流到聊天区。
	//
	// 判据分两层，**第一层才是主判据**：
	//   ①（主）引擎给的标记：行里有 `SenderLocalClient` 面板，或行自带 `IsSelf` 类。
	//      原版布局的 snippet `ChatMessageSender_LocalClient` 就是这个，引擎渲染
	//      本地玩家的消息时会把这块塞进行里。**不依赖我们记得什么，格式怎么变都不失效。**
	//   ②（兜底）我们自己刚发出去的内容。要记**两种形式**：翻译前的原文 + 写进输入框的
	//      最终文本 —— 因为游戏渲染出来的未必和输入框里那串一模一样（前缀/截断/换行），
	//      只比对最终文本的话，一比就漏，表现就是"自己发的英文被翻回来了"。
	var sent = [];

	function rememberSent(original, finalText) {
		var now = nowSeconds();
		var forms = [];
		if (original) forms.push(String(original));
		if (finalText) forms.push(String(finalText));
		if (!forms.length) return;
		sent.push({ forms: forms, t: now });
		if (sent.length > 20) sent.shift();
	}

	function isOwnMessageByText(text) {
		var t = nowSeconds();
		var want = String(text || "").replace(/\s+/g, " ").replace(/^\s+|\s+$/g, "");
		if (!want) return false;
		for (var i = sent.length - 1; i >= 0; i--) {
			if (t - sent[i].t > SENT_MEMORY_SECONDS) continue;
			for (var j = 0; j < sent[i].forms.length; j++) {
				if (sent[i].forms[j] === want) return true;
			}
		}
		return false;
	}

	// 引擎标记：这一行是不是"我发的"
	function isOwnRow(row) {
		if (!isValid(row)) return false;
		if (hasClass(row, "IsSelf")) return true;
		// class 而不是 id：原版 snippet 写的是 <Panel class="SenderLocalClient" />
		if (findByClass(row, "SenderLocalClient")) return true;
		var byId = null;
		try { byId = row.FindChildTraverse("SenderLocalClient"); } catch (e) {}
		return isValid(byId);
	}

	// 游戏自带的快捷语 / Ping：**游戏自己已经本地化过了**（原版 snippet
	// `ChatMessageContents_Ping` → `PingLabel`），我们再翻一遍就会出现
	// 「敌人消失！」被当成外文再翻一次的怪现象。
	function isQuickChatRow(row, contents) {
		if (isValid(contents)) {
			if (hasClass(contents, "Ping")) return true;
			var ping = null;
			try { ping = contents.FindChildTraverse("PingLabel"); } catch (e) {}
			if (isValid(ping)) return true;
		}
		if (!isValid(row)) return false;
		if (hasClass(row, "Ping")) return true;
		// Build 25614556 的气泡共用 ChatMessage 模板，普通文字也有图标/冷却节点。
		// 必须按引擎消息类型判断，不能看到 TargetHeroImage 就把所有聊天当作 Ping。
		var bubble = findByClass(row, "ChatBubble");
		var quickTypes = ["MessageType_AbilityPing", "MessageType_MapPing",
			"MessageType_PingWheel", "MessageType_ItemDraftReaction"];
		for (var i = 0; i < quickTypes.length; i++) {
			if (hasClass(row, quickTypes[i]) || hasClass(bubble, quickTypes[i])) return true;
		}
		var any = null;
		try { any = row.FindChildTraverse("PingLabel"); } catch (e) {}
		return isValid(any);
	}

	// ---------------------------------------------------------------- 读一行聊天
	// 游戏里有**三个**能出现聊天的地方，结构各不相同。挨个判断，绝不用"猜第一个有字的
	// 标签"这种兜底 —— 那个兜底会拿到发送者名字，等于把玩家名当消息翻。
	//
	//   ① 左下角聊天窗（按回车打开的）：ChatMessages > ChatMessage(类)
	//        正文在 MessageContents 子树里收集；发送者在 MessageSource 里
	//   ② 对局头顶气泡：Team1Chat/Team2Chat > Messages > ChatMessage(类) + ChatBubble(类)
	//        正文在气泡里的 MessageText（这个 id 只在气泡里存在）
	//   ③ 大厅/展开聊天：ChatLinesPanel > ChatLineContainer(类)
	//        正文在 ChatLine(类) 那一支
	//
	// 返回 null = 这一行不用管（读不到字、或是不该翻的）。
	function readMessageRow(row, surface) {
		if (!isValid(row)) return null;
		var contents = null;
		var text = "";
		var sender = "";
		var textLabel = null;

		if (surface === "lobby" || hasClass(row, "ChatLineContainer")) {
			// ③ 大厅行
			var line = findByClass(row, "ChatLine");
			text = collectText(line) || collectText(row);
			var persona = findByClass(row, "ChatPersona");
			sender = readText(persona);
			surface = "lobby";
		} else if (surface === "bubble" || hasClass(row, "ChatBubble")
			|| findByClass(row, "ChatBubble")) {
			// ② 头顶气泡行：没有 MessageSource，发送者拿不到。
			//
			// 官方布局（build_mod\vanilla\panorama\layout\citadel_hud_top_bar_chat.xml）：
			//   ChatMessage > #MessageContents > .ChatBubble > .TextContainer > .MessageWrapper > Label#MessageText
			// 官方样式（citadel_hud_top_bar_chat.vcss_c）里明确写着：
			//   .ChatMessage #MessageContents { flow-children: down; }
			//   .ChatMessage .ChatBubble .TextContainer { min-height: 24px; max-width: 240px; ... }
			// 所以译文挂在 **#MessageContents** 上最稳：它是纵向流，译文天然排在气泡正下方，
			// 而且不会挤进 .TextContainer 里跟 .bubble_bg（width/height:100%）抢位置。
			var bubble = findByClass(row, "ChatBubble") || row;
			try { textLabel = bubble.FindChildTraverse("MessageText"); } catch (e) {}
			// 输入中动画没有正文节点；不得退回整棵子树收字，否则会翻译冷却/状态文字。
			if (!isValid(textLabel) || hasClass(row, "MessageType_PlayerTyping")) return null;
			var box = null;
			try { box = row.FindChildTraverse("MessageContents"); } catch (e) {}
			contents = box || bubble;
			text = readText(textLabel);
			surface = "bubble";
		} else {
			// ① 聊天窗行
			var source = null;
			try { source = row.FindChildTraverse("MessageSource"); } catch (e) {}
			try { contents = row.FindChildTraverse("MessageContents"); } catch (e) {}
			// 正文：从 MessageContents 整棵子树收集（正文 Label 没有 id，不能按 id 找）
			text = collectText(contents);
			if (!text) text = collectText(row);
			var senderLabel = findByClass(source, "SenderName")
				|| findByClass(row, "SenderName");
			sender = readText(senderLabel);
			surface = "chat";
		}

		text = String(text || "").replace(/\s+/g, " ").replace(/^\s+|\s+$/g, "");
		if (!text) return null;
		return {
			text: text,
			sender: sender || "",
			surface: surface,
			contents: contents,
			textLabel: isLabel(textLabel) ? textLabel : null,
			own: isOwnRow(row),
			quick: isQuickChatRow(row, contents)
		};
	}

	// 一行要不要翻：所有"不翻"的理由集中在这里，方便一眼复核。
	// 顺序有意为之：**先判身份（谁发的/是不是游戏快捷语），再判长度** ——
	// 否则一条很短的自有消息会被记成"too_short"，看着像"长度拦住的"，
	// 实际是身份判断没跑到（排查时会带偏）。
	function shouldSkipRow(info) {
		if (!info || !info.text) return "empty";
		if (info.quick) return "quick_chat";           // 游戏已本地化，翻了就是重复翻
		if (info.own) return "own_message";            // 我发的，别翻回来
		if (isOwnMessageByText(info.text)) return "own_text";
		if (info.text.charAt(0) === "/") return "command";
		if (info.text.replace(/\s/g, "").length < 2) return "too_short";
		// 非拉丁字母的语言（俄语/希腊语）也要翻：以前 looksEnglish 把西里尔语
		// 判成"非英文"直接丢掉 → 玩家看到的是"这条消息永远不翻"（静默失败）。
		// 现在交给桥按语言提示处理，桥的提示词会说明源语言不是英文。
		if (!looksEnglish(info.text) && !looksSlavic(info.text)) return "not_translatable";
		if (channel.hints.receiveEnabled === false) return "receive_disabled";
		return "";
	}

	// ---------------------------------------------------------------- 聊天行翻译
	var rows = [];          // 见 handleRow 里的字段说明
	var origSeq = 0;        // 给"原文标签"起唯一 id
	// 每个界面各自记住"上次扫到第几行"（增量扫描）
	var scanState = { chat: { count: 0 }, bubble: { count: 0 }, lobby: { count: 0 } };
	// 末尾这几行每轮都重新看一眼：游戏会回收复用行面板，行数不变但内容换了
	// （只靠"上次扫到第几行"永远轮不到它们）。取 4 是因为屏幕上的聊天区也就同时显示
	// 几条，末 4 条足够覆盖"刚被复用、正要翻"的行，代价只是每轮多读几行文字。
	var RECHECK_TAIL = 4;

	function rowRecord(row) {
		for (var i = 0; i < rows.length; i++) if (rows[i].panel === row) return rows[i];
		return null;
	}

	// 只清理"属于这个容器、但已经从容器里消失"的行。
	//
	// ⚠ 必须按容器过滤：rows 是三个界面共用的。如果拿 A 界面的子面板去比对，
	// B 界面的行会被当成"已消失"清掉 —— 表现是"扫完气泡，聊天窗的记录全丢了"，
	// 于是每 250ms 重新翻一遍（离线测试台抓到过这个）。
	function pruneRows(live, surface) {
		var kept = [];
		for (var i = 0; i < rows.length; i++) {
			var r = rows[i];
			if (surface && r.surface !== surface) { kept.push(r); continue; }
			if (!isValid(r.panel)) continue;
			var stillThere = false;
			for (var j = 0; j < live.length; j++) if (live[j] === r.panel) { stillThere = true; break; }
			if (stillThere) kept.push(r);
		}
		rows = kept;
	}

	// 译文往哪儿贴：
	//   聊天窗（双语）—— **拼进正文那一格**（"英文 | 中文"），见 applyChatInlineTranslation
	//   气泡（双语）  —— 在"正文容器"下面另起一行（#MessageContents 是纵向流）
	//   替换模式      —— 直接把正文那段文字换掉，原文塞进一个默认收起、悬停才显示的标签
	function translationHost(rec) {
		var host = rec.contents;
		if (isValid(host)) return host;
		if (isValid(rec.panel)) return rec.panel;
		return null;
	}

	// ---------------------------------------------------------------- "翻译中"占位
	// 别人发来的消息要等 1 秒多才有译文（打字那一路只有 0.17 秒），中间那一段
	// 屏幕上什么都不发生。这里给这一行补一个**弱化的占位**，翻好之后原地换成译文，
	// 让"正在翻"和"翻完了"一眼分得出来。
	//
	// 三条铁律（都是踩过的坑换来的）：
	//   ① **绝不新建第二个标签**：替换模式的兜底靠 findTextLabel 的"子树里唯一一格
	//      有字的 Label"，多一个节点就会让它找不到目标。所以占位和译文**共用同一个面板**
	//      （rec.trans / 聊天窗那一格）。
	//   ② 占位和行内拼接都必须能被 readRowText 识破（见那里的 .DLChatPending 分支），
	//      否则占位文字会被当成消息原文再翻一遍。
	//   ③ 延迟显示：缓存命中是 0ms，慢了才显示 —— 否则每条消息都要闪一下。

	// 报文流：占位的显示/隐藏都不动 rec.chinese / rec.applied（那是"已翻好"的语义），
	// 两者之间的一致性全靠 rec.pending / rec.pendingShown 这一对。
	function hidePendingLabel(rec) {
		rec.pendingShownText = null;
		if (!rec || !rec.pendingShown) return;
		if (rec.inlinePending && isValid(rec.pendingLabel)) {
			// 聊天窗行内模式：占位是**写进游戏自己那格正文**的（"英文 | ···"），
			// 而且这一格同时供 readRowText 还原原文。退场时必须两步一起做：
			// 把格子还原、再摘掉 inline 记录。只删记录不还原的话，读行会读到
			// "英文 | ···"，被判成"这一行换内容了"再翻一遍（占位符被送去翻译）。
			//
			// ⚠ 还原成**纯原文**，不保留分隔符。踩过的坑：还原成 "英文 |" 时，
			// 万一接下来没有再显示占位（失败重试预算用完、或失败提示到点收掉），
			// 这一格就留着一个悬空的分隔符；下一轮扫描读到 "need urn |"，把它当成
			// **新的消息原文**又排进翻译（离线测试台的 queued 里抓到过 "need urn |"）。
			var before = readText(rec.pendingLabel);
			if (before === rec.original + (separatorText() || " | ") + PENDING_TEXT
				|| before === rec.original + (separatorText() || " | ") + "翻译失败") {
				writeText(rec.pendingLabel, rec.original);
			}
			inlineForget(rec.panel);
			setClass(rec.panel, "DLChatChatInline", false);
			rec.inlinePending = false;
		} else if (isValid(rec.pendingLabel)) {
			setClass(rec.pendingLabel, "DLChatPending", false);
			setClass(rec.pendingLabel, "DLChatFailed", false);
			try { rec.pendingLabel.visible = false; } catch (e) {}
		}
		rec.pendingShown = false;
	}

	// 占位和译文用的是同一个面板（见铁律 ①）：拿到还能用的那个，没有就新建一个。
	// sameHost 那个判断是给"聊天行被游戏回收复用"留的 —— 行换到别的容器时旧标签不能再写。
	function transLabelFor(rec, host) {
		if (isValid(rec.trans) && sameHost(rec.trans, host)) return rec.trans;
		try {
			rec.trans = $.CreatePanel("Label", host, "DLChatTrans" + (++origSeq));
			if (rec.trans) setClass(rec.trans, "DLChatTranslation", true);
		} catch (e) {}
		return rec.trans;
	}

	function setPendingVisual(rec, label, text, failed) {
		if (!isValid(label)) return;
		writeText(label, text);
		// 两个类**互斥**（.DLChatTranslation / .DLChatPending / .DLChatFailed）。
		// 为什么非要摘掉 .DLChatTranslation：它写着 `color: #ffffff`，而内联样式的
		// `color` 是个函数式颜色（ToPanelEventColor(...)），Panorama 解析不了这种
		// 语法时会**静默丢掉该属性** -> 占位就变成"白字 + 浅底"，在白气泡旁边看不见。
		// 反过来真译文到达时也要把这个类加回来（见 applyTranslation）。
		setClass(label, "DLChatTranslation", false);
		setClass(label, "DLChatPending", !failed);
		setClass(label, "DLChatFailed", !!failed);
		try { label.visible = true; } catch (e) {}
		rec.pendingLabel = label;
		rec.pendingShown = true;
		rec.pendingShownText = String(text);
		applyBubbleInlineStyle(label, !failed);   // 气泡：内联兜底（带 pending 配色）
	}

	// 聊天窗（行内双语）：临时写成 "英文 | ···"。
	// 有意**不建 rec.orig、不加 DLChatOriginalHidden** —— 原文这会儿就在眼前，
	// 而且那两个是"翻好之后"的状态，提前加上会让随后那次真翻译读到脏数据。
	// 但 **inlineRemember + 行上的 DLChatChatInline 必须现在就做**：这一格已经被我们
	// 改成了 "英文 | ···"，不记的话 readRowText 会把占位当成消息正文读出去
	// （离线测试台抓到过：clean=false -> 下一轮就会拿 "he is low ···" 去翻译）。
	function showChatInlinePending(rec) {
		var host = translationHost(rec);
		if (!isValid(host)) return false;
		var target = rec.textLabel;
		if (!isValid(target)) target = findChatTextCell(host);
		if (!isValid(target)) return false;
		if (rec.pendingShown && rec.pendingLabel === target) return true;   // 已经在显示
		hidePendingLabel(rec);                    // 先把旧的那份收掉，避免两份同时挂着
		var sep = separatorText() || " | ";
		var before = readText(target);            // 记下这格"原本的文字"（还原用）
		writeText(target, rec.original + sep + PENDING_TEXT);
		inlineRemember(target, {
			original: before || rec.original,
			finalText: rec.original + sep + PENDING_TEXT,
			cell: target
		});
		if (isValid(rec.panel)) {
			setClass(rec.panel, "DLChatChatInline", true);
			inlineRemember(rec.panel, {
				original: rec.original,
				finalText: rec.original + sep + PENDING_TEXT,
				cell: target,
				collected: rec.original
			});
		}
		rec.textLabel = target;
		rec.pendingLabel = target;
		rec.inlinePending = true;
		rec.pendingShown = true;
		rec.pendingShownText = PENDING_TEXT;
		return true;
	}

	function showPendingLabel(rec) {
		if (!isValid(rec.panel)) return;
		if (rec.surface === "chat") {
			if (showChatInlinePending(rec)) return;
			// 聊天窗找不到正文格：退回气泡那套（至少别丢反馈）
		}
		var host = translationHost(rec);
		if (!isValid(host)) return;
		try { host.style.flowChildren = "down"; } catch (e) {}
		setPendingVisual(rec, transLabelFor(rec, host), PENDING_TEXT, false);
	}

	// 失败提示：借用同一个标签（不新建节点），翻好了会原地被译文覆盖。
	function markRowFailed(rec, why) {
		if (!rec) return;
		rec.failedMarked = true;
		rec.failedAt = nowSeconds();
		rec.pending = false;
		rec.applied = false;
		if (!isValid(rec.panel)) return;
		var host = translationHost(rec);
		if (!isValid(host)) return;
		var label = rec.trans;
		if (isValid(label) && hasClass(label, "DLChatPending")) {
			setPendingVisual(rec, label, "翻译失败", true);   // 占位原地变失败提示
		} else if (rec.inlinePending && isValid(rec.pendingLabel)) {
			// 行内模式：正文格就是"译文"，把 "英文 | ···" 换成 "英文 | 翻译失败"。
			// 那格同时供 readRowText 还原原文，所以 inline 记录要跟着改成新内容
			// （inlineEntryFor 是"文字一模一样才算数"，不改就自动作废 -> 会被读成原文）。
			var sep = separatorText() || " | ";
			var finalText = rec.original + sep + "翻译失败";
			writeText(rec.pendingLabel, finalText);
			inlineRemember(rec.pendingLabel, {
				original: rec.original, finalText: finalText, cell: rec.pendingLabel
			});
			if (isValid(rec.panel)) {
				inlineRemember(rec.panel, {
					original: rec.original, finalText: finalText,
					cell: rec.pendingLabel, collected: rec.original
				});
			}
			rec.pendingShown = true;
			rec.pendingShownText = "翻译失败";
		} else {
			setPendingVisual(rec, transLabelFor(rec, host), "翻译失败", true);
		}
		log("row_failed:" + String(rec.original || "").substring(0, 40),
			{ why: String(why || "").substring(0, 80) });
	}

	function hasPendingFor(text) {
		var list = pendingByText[text];
		return !!(list && list.length);
	}

	// 这 0.25 秒一轮的扫描里，pending 的行会被 handleRow 直接跳过（"正在等译文，别重复发"），
	// 所以延迟显示、卡死判定、失败重排队都放在这里推进。复用已有的 0.5 秒 tick，
	// 不新增定时器（Panorama 的 Schedule 不是免费的）。
	function pendingTick(now) {
		var settled = [];
		var work = 0;
		for (var i = 0; i < rows.length && work < PENDING_SWEEP_MAX; i++) {
			var rec = rows[i];
			if (!isValid(rec.panel)) continue;

			// ① 行被游戏回收拿去显示别的消息了吗？
			// 这一步**每轮都要做**，不能因为"占位已经显示了"就跳过 ——
			// 聊天行是复用面板，不查的话旧占位会一直挂在新消息下面。
			// rowTextNow 会被 readRowText 还原：行内拼接和失败提示都不算"换了内容"。
			if (rowTextNow(rec.panel, rec.surface) !== rec.original) {
				hidePendingLabel(rec);
				continue;                              // 剩下的交给 handleRow 当新行处理
			}

			// ② 失败提示停留期：到点收掉。收掉后如果还欠着翻译（failed），
			//    下面的重排队会接手，占位会再出现一次 —— 观感上像"一直没翻出来"。
			if (rec.pendingShownText && rec.failedMarked
				&& now - (rec.failedAt || 0) > FAIL_SHOW_SECONDS) {
				hidePendingLabel(rec);
				rec.failedMarked = false;
			}

			if (rec.pending) {
				if (rec.pendingShown) continue;        // 已经显示着，别每轮重写
				work += 1;
				if (now - (rec.pendingSince || 0) >= PENDING_SHOW_DELAY) {
					showPendingLabel(rec);
					continue;
				}
				if ((rec.retry || 0) >= MAX_ROW_RETRY && now >= (rec.settleBy || 0)) {
					markRowFailed(rec, "timeout");     // 请求卡死且重试预算用完
				}
				continue;
			}

			if (rec.failedMarked) continue;
			if (rec.failed && !hasPendingFor(rec.original)) {
				settled.push(rec);                     // 排到循环后面再动：别边遍历边改状态
			}
		}
		// 失败后重排队（有界：rec.retry 记着已经失败过几次，超预算就只留失败提示）
		for (var k = 0; k < settled.length; k++) {
			var one = settled[k];
			one.failed = false;
			one.chinese = "";
			one.applied = false;
			translateRowText(one, one.original);
		}
	}

	function applyTranslation(rec, chinese) {
		var host = translationHost(rec);
		if (!isValid(host)) return;
		// 留一份到"最近译文"：聊天行大约 10 秒就淡出，之后原文和译文都没了，
		// 翻错了也没法回看（"重译最近一条"只对还在面板树里的行有效）。
		historyRemember(rec.original, chinese, rec.surface);
		// 让宿主容器"向下排"。译文是追加的子元素，容器不纵向排的话它会被排到
		// 右边、或者叠在原文上。官方样式里气泡的 #MessageContents 和聊天窗的
		// MessageBody 本来就都是 down，这里只是保证万一不是也排得对。
		try { host.style.flowChildren = "down"; } catch (e) {}
		var bilingual = displayMode() === "bilingual";

		if (bilingual) {
			// 聊天窗走"行内拼接"（正文 + 分隔符 + 译文，和输入框/发出去的消息同一个写法），
			// 它有自己的挂载逻辑和一条硬约束，见 applyChatInlineTranslation。
			if (rec.surface === "chat") {
				// 正文格里那份 "英文 | ···" 先退场（hidePendingLabel 会把它还原成
				// "英文 | " 并摘掉 inline 记录），下面整体改写成 "英文 | 中文"
				hidePendingLabel(rec);
				if (applyChatInlineTranslation(rec, host, chinese)) return;
				// 找不到可改写的正文 Label 时往下走，退回"独立标签"那条老路（至少不丢内容）
			}
			// 气泡（头顶）与兜底：译文标签挂在正文容器下面
			// （容器已改成纵向流，所以译文稳定出现在正文下方）
			// 占位和译文**共用一个标签**（见 transLabelFor 的说明）：占位已经建过就原地改写，
			// 少一个节点，也顺带避开 findTextLabel 的"唯一一格有字"约束。
			var label = transLabelFor(rec, host);
			if (isValid(label)) {
				// 占位那份类/可见性要先摘掉，并把 .DLChatTranslation 加回来：
				// 这里不清的话，翻好了还带着 pending 的浅色样式；而在真机上两个类同时
				// 挂着时，.DLChatTranslation 的 `color: #ffffff` 会让内联那层解析失败被丢掉。
				setClass(label, "DLChatTranslation", true);
				setClass(label, "DLChatPending", false);
				setClass(label, "DLChatFailed", false);
				try { label.visible = true; } catch (e) {}
				rec.pendingShown = false;
				rec.pendingShownText = null;
				writeText(label, chinese);
				// 气泡行额外写一遍内联样式：官方 HUD 顶栏那套样式的作用域不一定覆盖到
				// 我们注入的标签（BabelTower 就在这里踩过：套了类也取不到底色，
				// 退化成"透明底浅色字"看不见）。内联样式优先级最高，绕开作用域问题。
				if (rec.surface === "bubble") applyBubbleInlineStyle(label);
			}
			if (isValid(rec.panel)) setClass(rec.panel, "DLChatBilingual", true);
			rec.chinese = chinese;
			rec.applied = true;
			if (!rec.logged) { rec.logged = true; logRowStructure(rec.surface, host, rec); }
			return;
		}
		hidePendingLabel(rec);                     // 替换模式要改写正文，占位（挂在容器上的）先收掉

		// 替换模式：把正文那段文字改写掉
		var target = rec.textLabel;
		if (!isValid(target)) target = findTextLabel(host);
		if (!isValid(target)) return;                   // 找不到可改写的节点就不动（宁可不动，也别乱写）
		if (!isValid(rec.orig)) {
			try {
				rec.orig = $.CreatePanel("Label", host, "DLChatOrig" + (++origSeq));
				if (rec.orig) setClass(rec.orig, "DLChatOriginal", true);
			} catch (e) {}
		}
		if (isValid(rec.orig)) writeText(rec.orig, rec.original);
		writeText(target, chinese);
		setClass(target, "DLChatTranslatedText", true);
		// 刚从"双语行内"切过来的行：正文里还留着 "英文 | 中文"，要还原成纯英文再改写，
		// 否则悬停看到的是中英混排。
		clearChatInline(rec);
		rec.textLabel = target;
		rec.chinese = chinese;
		rec.applied = true;
		if (isValid(rec.panel)) setClass(rec.panel, "DLChatTranslated", true);
		if (!rec.logged) { rec.logged = true; logRowStructure(rec.surface, host, rec); }
	}

	// 正文那一格到底是哪个面板。
	//
	// ⚠ 不能像 findTextLabel 那样"找子树里唯一有字的 Label"就完事：第二次给同一行写译文时，
	// 那一格已经有字了，而 findTextLabel 从宿主（#MessageContents）往下走，会越过正文格、
	// 直接把**宿主自己**（甚至更外层的行容器）当成目标 —— 结果是把 "英文 | 中文" 写进
	// #ChatMessages，整行文字被反复拼接（离线测试台抓到过这个）。
	// 官方结构是 #MessageContents > Panel.Text > Label，所以按这个形状精确取；取不到再退回旧办法。
	function findChatTextCell(host) {
		// 游戏原版 snippet（chat.vxml_c，见 build_mod/vanilla/panorama/layout/chat.xml:15）是：
		//     <snippet name="ChatMessageContents_Text"><Panel class="Text"><Label text="{s:message_text}" /></Panel></snippet>
		// **Text 是 class，不是 id** —— 一开始按 id 找（childById）在真机上永远匹配不到，
		// 于是一路退到"子树里唯一有字的 Label"那条老路，多一个标签就找不着（离线测试台抓到过）。
		var text = findByClass(host, "Text");
		if (isValid(text)) {
			var kids = childrenOf(text);
			for (var i = 0; i < kids.length; i++) {
				if (isLabel(kids[i])) return kids[i];
			}
		}
		var byId = childById(host, "Text");            // 有的版本可能给了 id，顺手兜一层
		if (isValid(byId)) {
			var kids2 = childrenOf(byId);
			for (var j = 0; j < kids2.length; j++) {
				if (isLabel(kids2[j])) return kids2[j];
			}
		}
		for (var d = 0; d < 4 && isValid(host); d++) {
			var lbl = findTextLabel(host);
			if (isValid(lbl)) return lbl;
			try { host = host.GetParent(); } catch (e) { break; }
		}
		return null;
	}

	// 聊天窗双语：把中文**拼进正文那一格**，而不是另起一个标签挂在下面。
	//
	// 为什么要改成这样（这是本次修复的核心）：
	//   ① 独立标签只能排在气泡**下面**。而聊天区是写死的 height: 200px + overflow: squish scroll，
	//      最新一条又恰好贴在容器边界上，输入框那一行（#ChatControls，background-color: #000e，
	//      只是 opacity: 0 并不收起）又是**后画的兄弟节点** —— 于是最新一条的"下方"同时被
	//      裁切和遮挡，译文建出来了却看不见（mod.log 里那条 kids=2 就是证据）。
	//   ② 拼进正文那一格，文字就在游戏自己的白气泡内部：气泡本来就会跟着文字长高、换行，
	//      没有"多出来的那块空间"可以被裁；而且和输入框里 "中文 | 英文" 的写法完全一致。
	//
	// 代价（已知并接受）：消息会高一截，聊天区能同时显示的行数变少。
	function applyChatInlineTranslation(rec, host, chinese) {
		var target = rec.textLabel;
		if (!isValid(target)) target = findChatTextCell(host);
		if (!isValid(target)) return false;             // 找不到就交给调用方走兜底
		var sep = separatorText() || " | ";

		if (!isValid(rec.orig)) {
			try {
				rec.orig = $.CreatePanel("Label", host, "DLChatOrig" + (++origSeq));
				if (rec.orig) setClass(rec.orig, "DLChatOriginal", true);
			} catch (e) {}
		}
		if (isValid(rec.orig)) {
			writeText(rec.orig, rec.original);
			// 双语行内模式下原文就在眼前，悬停那份不显示（CSS 按这个类收掉）；
			// 换成"替换原文"时会把类摘掉，它自己回来。
			setClass(rec.orig, "DLChatOriginalHidden", true);
		}
		// 写之前先把这一格"原本的文字"记下来：行内拼接后它就不是原文了，
		// 而下一轮扫描读到的必须是原文（否则中文会被当成下一条消息的原话）。
		var before = readText(target);
		var finalText = rec.original + sep + chinese;
		writeText(target, finalText);
		setClass(target, "DLChatTranslatedText", true);
		inlineRemember(target, {
			original: before || rec.original,
			finalText: finalText,
			cell: target
		});
		if (isValid(rec.panel)) {
			setClass(rec.panel, "DLChatChatInline", true);
			setClass(rec.panel, "DLChatBilingual", false);   // 不再用"独立标签"那套样式
			// 行容器也记一份"整行正文"：这样别处从 MessageContents 那一层收集文字时，
			// 拿到的是干净的英文原文，而不是再拼一遍 "英文 | 中文"。
			inlineRemember(rec.panel, {
				original: rec.original,
				finalText: finalText,
				cell: target,
				collected: rec.original
			});
		}
		rec.textLabel = target;
		rec.trans = target;      // "译文落在哪儿"的答案：就是正文那一格（自检/日志读它）
		rec.chinese = chinese;
		rec.applied = true;
		keepChatPinned(rec.panel);
		if (!rec.logged) { rec.logged = true; logRowStructure(rec.surface, host, rec); }
		return true;
	}

	// 把一行从"双语行内"状态里退出来：摘掉类、丢掉记录。
	// ⚠ **不要**把正文写回 rec.original：这行此刻往往已经被游戏填进了新消息，
	// 写回去就是把新消息吃掉（离线测试台抓过这个 bug）。正文的还原只在"替换原文"
	// 那条路上做，而那条路会自己写目标格。
	function clearChatInline(rec) {
		if (!rec || !hasClass(rec.panel, "DLChatChatInline")) return;
		setClass(rec.panel, "DLChatChatInline", false);
		inlineForget(rec.panel);
		if (isValid(rec.textLabel)) inlineForget(rec.textLabel);
		if (isValid(rec.orig)) {
			setClass(rec.orig, "DLChatOriginalHidden", false);
			// 这一行已经被游戏填进新消息了：挂在行上的"悬停原文"必须跟着换成新原文，
			// 否则它留着的还是上一条，切到"替换原文"或悬停时看到的就是旧消息。
			writeText(rec.orig, rec.original || "");
		}
	}

	// 把聊天区重新钉回"最新那一端"。
	// 引擎不会因为新增内容而自动滚动（CS2 自己的 chat.js 也是每次追加后显式调一次）；
	// 而 #ChatMessages 是 scaleY(-1) 翻转过的，所以 ScrollToBottom() 在翻转空间里
	// 对应的是**视觉上的顶端 = 最新消息那一端**，正是我们要的。
	function keepChatPinned(row) {
		if (hasClass(row, "ChatMessage")) return;       // 有行上下文时只处理聊天行
		var root = null;
		try { root = $.GetContextPanel(); } catch (e) { return; }
		var box = view("ChatMessages", root);
		if (!isValid(box) || box === root) return;
		call0(box, "ScrollToBottom");
	}

	// 我们创建的那个译文标签是不是还挂在同一个宿主下（聊天行会回收复用）
	function sameHost(label, host) {
		try { return label.GetParent() === host; } catch (e) { return true; }
	}

	// 气泡译文的内联样式兜底。
	// 为什么非要有这一手：官方 HUD 顶栏那套样式（citadel_hud_top_bar_chat.vcss_c）
	// 用的是 `.ChatMessage .ChatBubble .TextContainer #MessageText` 这种**长选择器**，
	// 我们注入的标签不在那条链上，套自己类名又可能受作用域影响 -> 结果就是
	// "标签建出来了、也有文字，但是透明底 + 浅色字，等于看不见"。
	// 内联样式优先级最高，与作用域无关，所以气泡这一路直接写死。
	//
	// pending=true 是"还没翻好"的弱化配色：占位和真译文**用同一个标签**，
	// 所以必须能在两者之间来回切（占位 -> 译文 -> 失败提示）。
	function applyBubbleInlineStyle(label, pending) {
		if (!isValid(label)) return;
		var s = null;
		try { s = label.style; } catch (e) { return; }
		if (!s) return;
		try {
			s.backgroundColor = pending ? "rgba(20, 52, 96, 0.55)" : "rgba(20, 52, 96, 0.95)";
			s.color = pending ? "#cfe8ff" : "#ffffff";
			s.fontSize = pending ? "13px" : "15px";
			s.fontStyle = "normal";
			s.fontWeight = pending ? "500" : "600";
			s.border = pending ? "1px solid rgba(120, 180, 255, 0.30)"
				: "1px solid rgba(120, 180, 255, 0.55)";
			s.borderRadius = "4px";
			s.padding = "3px 8px";
			s.marginTop = "3px";
			s.marginLeft = "20px";
			s.maxWidth = "220px";
			s.whiteSpace = "normal";
			s.width = "fit-children";
			s.height = "fit-children";
			s.textShadow = "0px 1px 2px rgba(0, 0, 0, 0.6)";
		} catch (e) {}
	}

	// 在正文容器里找"该被改写的那段文字"：只有一格非空 Label 时才敢用。
	// 多于一格就分不清哪格是正文（比如气泡里还带发送者），宁可不动。
	function findTextLabel(host) {
		var found = [];
		(function walk(p, depth) {
			if (!isValid(p) || depth > 6) return;
			if (isLabel(p) && readText(p).replace(/\s/g, "").length) found.push(p);
			var kids = childrenOf(p);
			for (var i = 0; i < kids.length; i++) walk(kids[i], depth + 1);
		})(host, 0);
		return found.length === 1 ? found[0] : null;
	}

	// 处理一行。rec 的字段：
	//   panel    游戏给的行面板（回收复用的单位）
	//   contents 正文容器（译文往这下面贴）
	//   original 原文（用来判断"这个面板是不是换了内容"）
	//   applied  已经翻好了  pending 正在翻  retry 欠几次重试
	function handleRow(row, surface) {
		var info = readMessageRow(row, surface);
		var rec = rowRecord(row);

		if (rec) {
			if (rec.pending) return;                     // 正在等译文，别重复发
			if (!info) { rec.applied = false; return; }   // 这一行暂时读不到字
			if (rec.applied && !rec.retry
				&& info.text === rec.original) return;    // 翻过了、内容没变
			if (info.text !== rec.original || info.own) {
				// 面板被回收拿去显示别的消息了（聊天行会复用）：当新行重来
				clearChatInline(rec);                    // 上一轮的 "英文 | 中文" / 悬停原文要清掉
				hidePendingLabel(rec);                   // 上一轮的"翻译中/翻译失败"占位也要收掉
				rec.original = info.text;
				rec.contents = info.contents;
				rec.textLabel = info.textLabel || null;
				rec.own = info.own;
				rec.quick = info.quick;
				rec.surface = surface;
				rec.applied = false;
				rec.chinese = "";
				rec.retry = 0;
				rec.fails = 0;                       // 换了一条新消息：重试预算重新算
				rec.logged = false;
			}
		} else {
			rec = {
				panel: row, contents: info.contents, textLabel: info.textLabel || null,
				original: info.text, own: info.own, quick: info.quick,
				surface: surface,
				chinese: "", orig: null, trans: null, logged: false,
				applied: false, pending: false, retry: 0,
				// "翻译中"占位那一套（见 pendingTick）
				pendingLabel: null, pendingShown: false, pendingShownText: null,
				pendingSince: 0, settleBy: 0, queuedAt: 0, inlinePending: false,
				failed: false, fails: 0, failedMarked: false, failedAt: 0
			};
			rows.push(rec);
		}

		var why = shouldSkipRow(info);
		if (why) {
			// 记成"已处理"，免得每 250ms 重新判断同一行
			rec.applied = true;
			rec.chinese = info.text;
			rec.skipped = why;
			return;
		}
		rec.skipped = "";
		rec.retry = 0;
		translateRowText(rec, info.text);
	}

	// ---- 同一句话只翻一次 ----------------------------------------------------
	// 为什么需要：同一句 "b b b" 在聊天区出现两行就发两次请求。桥那边有缓存，
	// 但**队列是串行的**，第二次照样占一个槽位（本机 100~200ms，云端 300~600ms），
	// 排队时就是白等。这里在客户端记一份"翻过的"，命中直接用。
	var CACHE_MAX = 64;
	var cacheMap = {};       // text -> 译文
	var cacheOrder = [];     // 最近使用的 text（末尾最新），满了淘汰最老的

	function cacheGet(text) {
		var hit = cacheMap[text];
		if (typeof hit !== "string") return null;
		var at = cacheOrder.indexOf(text);
		if (at !== -1) { cacheOrder.splice(at, 1); cacheOrder.push(text); }
		return hit;
	}

	function cachePut(text, chinese) {
		if (!text || !chinese) return;
		if (typeof cacheMap[text] !== "string") cacheOrder.push(text);
		cacheMap[text] = chinese;
		while (cacheOrder.length > CACHE_MAX) {
			var old = cacheOrder.shift();
			delete cacheMap[old];
		}
	}

	function cacheForget(text) {
		delete cacheMap[text];
		var at = cacheOrder.indexOf(text);
		if (at !== -1) cacheOrder.splice(at, 1);
	}

	// 同一个句子正在翻的时候，后面来的相同句子挂到同一批等待者上（single-flight）：
	// 既不多发请求，也不会漏掉任何一行的显示。
	var pendingByText = {};

	function translateRowText(rec, text) {
		var now = nowSeconds();
		rec.pending = true;
		rec.retry = 0;
		rec.failed = false;
		// ⚠ rec.retry 是"这一批等待者收到过几次空回包"，每开一批都会归零 —— 它**不能**
		// 当重试上限用（那样就等于无限重试）。累计失败次数单独记在 rec.fails 上，
		// 只有这一行真的换了内容才清零（见 handleRow 的"面板被回收"分支）。
		rec.pendingSince = now;            // 大于 PENDING_SHOW_DELAY 才显示"翻译中"
		rec.settleBy = now + REQUEST_TIMEOUT + PENDING_SETTLE_BUMP;
		rec.queuedAt = now;
		var cached = cacheGet(text);
		if (cached !== null) {
			rec.pending = false;
			hidePendingLabel(rec);         // 命中缓存是 0ms：占位绝不该出现（免得闪一下）
			rec.fails = 0;
			applyTranslation(rec, cached);
			return;
		}
		var waiters = pendingByText[text];
		if (waiters) { waiters.push(rec); return; }   // 同一句正在翻：挂上去，不再发请求

		waiters = pendingByText[text] = [rec];
		rec.queuedNow = true;      // 给离线测试台数"这一轮真的发了几条请求"
		// 源语言：俄语/希腊语按字面报给桥（桥会换提示词），其余交给桥的自动判断。
		// 以前这里写死 "en" —— 俄语消息要么被丢掉、要么被当成英文硬翻。
		var srcLang = looksSlavic(text) || "auto";
		bus.send("translate", {
			text: text, sourceLanguage: srcLang, targetLanguage: "zh-Hans"
		}, REQUEST_TIMEOUT, function (res) {
			var list = pendingByText[text] || [];
			delete pendingByText[text];                // 所有权转移给这一批（重排队会另开一批）
			var out = (res && res.ok && res.translation) ? res.translation : "";
			settleRowText(text, out, list, res);
		});
	}

	// 一批等待者的收尾：翻好了贴译文，没翻出来按"有界重试"处理。
	// 超时由 bus 在请求真正发出后处理，回调到这里时只收尾仍在等待的行。
	// ⚠ 别在这里 delete pendingByText[text]：同一句话可能在收尾之后马上开了**新的一批**
	// （失败重排队），按 text 删会把新批次从表里摘掉，后面的同句消息就挂不上去了。
	// 列表的所有权归调用方：回调捕获 list 时就把它从表里摘下来。
	function settleRowText(text, out, list, res) {
		if (!list) return;
		var settled = false;
		for (var i = 0; i < list.length; i++) {
			var one = list[i];
			if (!one.pending) continue;                // 已经被别的路径收掉了，别重复处理
			one.pending = false;
			settled = true;
			if (out) {
				one.fails = 0;
				applyTranslation(one, out);
			} else if (isValid(one.panel)) {
				one.applied = false;
				one.retry = (one.retry || 0) + 1;
				one.fails = (one.fails || 0) + 1;
				// 失败提示挂在这一行上（原来这种"翻不出来"完全没有反馈），到点收掉；
				// 超过重试预算就只留提示、不再自动重发（靠不置 rec.failed 实现，见 pendingTick）
				markRowFailed(one, res ? res.error : "no_response");
				one.failed = (one.fails <= MAX_ROW_RETRY);
			}
		}
		if (!settled) return;                         // 迟到的兜底/回包不能制造一次失败
		if (out) {
			cachePut(text, out);
			clearFailure();
			log("in:" + text + " => " + out, { viaCache: !!(res && res.viaCache) });
			// 桥按通道预算截断过这条译文：在状态行说明一次，让玩家知道
			// 屏幕上的中文是"到这儿为止"，而不是模型少翻了半句
			if (res && res.truncated) {
				status.show("这条消息太长，译文已截断显示（原文 " + text.length
					+ " 字符）", 6);
			}
			// 同一个游戏面板可能已经换了内容，新内容按"新行"再走一遍
			for (var k = 0; k < list.length; k++) markRowDirty(list[k]);
		} else {
			noteFailure("英→中", res, text);
		}
	}

	// 面板被游戏回收复用后，行上的文字换了：清掉记录，下次扫描当新行处理
	function markRowDirty(rec) {
		if (!isValid(rec.panel) || !rec.applied) return;
		var info = readMessageRow(rec.panel, rec.surface);
		if (!info) return;
		if (info.text === rec.original) return;   // 还是同一句，正常
		rec.applied = false;
		rec.chinese = "";
		rec.original = info.text;
	}

	// 重译最近一条：翻错了、或者第一次失败时的补救手段（桌面版有 Alt+R，mod 之前没有）
	function retranslateLast() {
		for (var i = rows.length - 1; i >= 0; i--) {
			var rec = rows[i];
			if (!isValid(rec.panel)) continue;
			var original = rec.original || "";
			if (!original || !looksEnglish(original)) continue;
			if (rec.own) continue;                     // 自己发的不重译
			if (rec.pending) { status.show("这一条正在翻译，稍等", 4); return true; }
			cacheForget(original);
			rec.applied = false;
			rec.chinese = "";
			rec.retry = 0;
			translateRowText(rec, original);
			status.show("重译中：" + original.substring(0, 30), 6);
			log("retranslate:" + original);
			return true;
		}
		status.show("没有可重译的英文消息", 4);
		return false;
	}

	// ---------------------------------------------------------------- 最近译文（历史回看）
	// 为什么需要：游戏大约 10 秒就把聊天行淡出，翻错了、或者打团时没顾上看，
	// 之后就再也找不回来了 —— "重译最近一条"只对**还在面板树里**的行有效。
	// 这里在每次译文贴上去的时候留一份（原文 + 译文 + 时间），可以事后回看。
	var HISTORY_MAX = 20;
	var historyList = [];

	function historyRemember(original, chinese, surface) {
		if (!original || !chinese) return;
		// 同一句连续出现（刷屏、或同一个面板被复用）只留一条，避免历史被重复项塞满
		var last = historyList[historyList.length - 1];
		if (last && last.original === original && last.chinese === chinese) return;
		// 同一条消息可能被贴两次译文（先失败后重试成功、或"重译最近一条"改了口径）：
		// 找到最近一条同原文的记录就地改写，别在历史里堆两条互相矛盾的译文。
		for (var i = historyList.length - 1; i >= 0 && i >= historyList.length - 5; i--) {
			if (historyList[i].original === original) {
				historyList[i].chinese = chinese;
				historyList[i].at = nowSeconds();
				return;
			}
		}
		historyList.push({
			original: original, chinese: chinese,
			surface: surface || "", at: nowSeconds()
		});
		while (historyList.length > HISTORY_MAX) historyList.shift();
	}

	function historyText() {
		if (!historyList.length) return "";
		var lines = [];
		for (var i = historyList.length - 1; i >= 0; i--) {
			var h = historyList[i];
			lines.push((i + 1 < historyList.length ? "· " : "▶ ")
				+ h.original.substring(0, 40) + " → " + h.chinese.substring(0, 40));
		}
		return lines.join("\n");
	}

	// 面板里没有可滚动的多行区域（布局没改），所以按"一屏几条"分页显示在状态区。
	var historyPage = 0;

	function showHistoryPage() {
		if (!historyList.length) {
			status.show("还没有译文记录（翻译过别人的消息后这里就有）", 6);
			return false;
		}
		var perPage = 3;
		var pages = Math.ceil(historyList.length / perPage);
		if (historyPage >= pages) historyPage = 0;
		var start = historyList.length - 1 - historyPage * perPage;
		var chunk = [];
		for (var i = start; i > start - perPage && i >= 0; i--) {
			var h = historyList[i];
			chunk.push(h.original.substring(0, 24) + " → " + h.chinese.substring(0, 24));
		}
		status.show("最近译文（" + (historyPage + 1) + "/" + pages + "）："
			+ chunk.join("　｜　") + "　（再点一次看更早）", 10);
		historyPage += 1;
		return true;
	}

	// ---------------------------------------------------------------- 扫描
	// 三个界面各扫各的，**互不短路**（一个界面有活动不能把另外两个跳过：
	// 头顶气泡和聊天窗经常同时有消息）。每个容器记住"上次扫到第几行"，
	// 只处理新增的 —— 省 CPU，也天然是"按到来顺序翻"。
	//
	// ⚠ 但"只处理新增的"不够：**游戏会回收复用聊天行**（同一块面板换一句新话）。
	// 那种情况下行数不变、位置也不变，只靠 state.count 永远轮不到它 —— 表现就是
	// "某一行之后，聊天窗再也不出中文了"（离线测试台用回收场景抓到过）。
	// 所以末尾 RECHECK_TAIL 行每轮都重新看一眼：内容还是原样就什么都不做（handleRow 里有
	// "翻过了、内容没变"的短路），真被换掉了才当成新行重译。
	//
	// surface: "chat"（聊天窗）/ "bubble"（头顶气泡）/ "lobby"（大厅展开聊天）
	function scanSurface(container, surface) {
		if (!isValid(container)) return;
		var live = childrenOf(container);
		pruneRows(live, surface);
		var state = scanState[surface];
		if (!state) state = scanState[surface] = { count: 0 };
		// 列表变短 = 聊天被清空/重建，从头再来
		if (live.length < state.count) state.count = 0;
		var from = state.count;
		// 首次（或刚重建）时只处理最后几条：历史消息没必要一次翻一大堆
		if (from === 0 && live.length > BOOTSTRAP_TAIL) from = live.length - BOOTSTRAP_TAIL;
		// 从旧到新处理，译文出现顺序和聊天一致
		for (var i = from; i < live.length; i++) handleRow(live[i], surface);
		state.count = live.length;
		// 末尾几条可能"发送者/正文"是晚一拍才填上的，多扫一遍兜住
		var tailFrom = Math.max(0, live.length - 2);
		for (var j = tailFrom; j < live.length; j++) handleRow(live[j], surface);
		// 见 changedRows 的说明：已被处理过、但可能被游戏就地改写的行，也要重新看一眼
		recheckChangedRows(live, surface);
	}

	// 一行正文的当前文字（读不出来返回 null = 这一行现在不用管）。
	// 用 recordFor 而不是 rowRecord：它是"行 -> 记录"的唯一入口，和 handleRow 看的是同一份数据。
	function rowTextNow(row, surface) {
		var info = null;
		try { info = readMessageRow(row, surface); } catch (e) { return null; }
		return (info && info.text) ? info.text : null;
	}

	// 已处理过的行里，挑出"正文和当时记的不一样"的重新交给 handleRow。
	//
	// 为什么必须有这一步：**游戏会回收复用聊天行**（同一块面板换一句新话），行数不变、
	// 位置也不变，只靠"上次扫到第几行"永远轮不到它。早期的做法只重扫末尾两行，结果
	// "倒数第二行被复用"就漏了（离线测试台用回收场景一步步抓出来的）。
	// 这里改成重扫"我们真的写过译文的、最近的那几行"：只有写过的行才可能被复用改写，
	// 数量恒定，代价与历史消息条数无关。
	function recheckChangedRows(live, surface) {
		var checked = 0;
		for (var i = rows.length - 1; i >= 0 && checked < RECHECK_TAIL; i--) {
			var rec = rows[i];
			if (!rec || !rec.applied || rec.pending) continue;
			if (surface && rec.surface !== surface) continue;
			var here = false;
			for (var k = 0; k < live.length; k++) if (live[k] === rec.panel) { here = true; break; }
			if (!here) continue;
			checked += 1;
			var now = rowTextNow(rec.panel, surface);
			if (!now || now === rec.original) continue;   // 还是同一句，正常
			handleRow(rec.panel, surface);
		}
	}

	function scanAllSurfaces() {
		var root = null;
		try { root = $.GetContextPanel(); } catch (e) { return; }
		if (!isValid(root)) return;
		scanSurface(view("ChatMessages", root), "chat");
		scanSurface(bubbleContainer(root), "bubble");
		scanSurface(view("ChatLinesPanel", root), "lobby");
	}

	// 按 id 找容器（找不到返回 null，交给下一层兜底）
	function view(id, root) {
		var found = null;
		try { found = root.FindChildTraverse(id); } catch (e) {}
		return isValid(found) ? found : null;
	}

	// 头顶气泡的容器。
	//
	// 官方布局（build_mod\vanilla\panorama\layout\citadel_hud_top_bar_chat.xml，反解自 pak01）是：
	//     CitadelHudTopBarChat > Panel#Messages
	// **没有 Team1Chat / Team2Chat** —— 那两个 id 只在别的（旧版/他人）布局里存在。
	// 我们一开始照那个层级找，两个都不在 -> 返回 null -> 气泡行一条都没扫过
	// （开机日志里头顶条那个界面报 `surfaces=none`，就是这个原因）。
	// 所以顺序反过来：先看"Messages 是不是就在手边"，再退回旧层级兜底。
	function bubbleContainer(root) {
		if (!isValid(root)) return null;

		// ① 本地图：root 自己就是 Messages，或它的直接子级里有 Messages
		var self = null;
		try { self = root.id || ""; } catch (e) {}
		if (self === "Messages") return root;
		var direct = directChildById(root, "Messages");
		if (direct) return direct;

		// ② 旧层级：Team1Chat / Team2Chat > Messages （别的游戏版本可能长这样）
		var ids = ["Team1Chat", "Team2Chat"];
		for (var i = 0; i < ids.length; i++) {
			var chat = view(ids[i], root);
			var box = chat ? view("Messages", chat) : null;
			if (box) return box;
		}

		// ③ 再兜一层：按官方类名找实例，再看它下面有没有 Messages
		var chats = [];
		try {
			if (typeof root.FindChildrenWithClassTraverse === "function") {
				chats = root.FindChildrenWithClassTraverse("CitadelHudTopBarChat") || [];
			}
		} catch (e) {}
		for (var j = 0; j < chats.length; j++) {
			if (chats[j] === root) continue;
			var box2 = view("Messages", chats[j]);
			if (box2) return box2;
		}

		// ④ 最后：整棵树里第一个叫 Messages 的面板（FindChildTraverse 是深度查找）
		return view("Messages", root);
	}

	// 只在直接子级里按 id 找一个面板（不递归）。
	// 为什么需要它：气泡容器 Messages 是**根面板的直接子级**，
	// 直接找比全树深搜更准，也不会误抓到别处的同名面板。
	function directChildById(parent, id) {
		var kids = childrenOf(parent);
		for (var i = 0; i < kids.length; i++) {
			var k = kids[i];
			var kid = "";
			try { kid = k.id || ""; } catch (e) {}
			if (kid === id) return k;
		}
		return null;
	}

	// ---------------------------------------------------------------- 输入框：中文 -> 英文
	var inputBusy = false;
	// 发送路径的失败记忆：{sig, n, until}
	//   sig   = 正文 + 错误码（换一句话就重新计数）
	//   n     = 连续失败次数
	//   until = 冷却到这个时刻（秒，用 tickCount 的秒数）
	var sendFail = { sig: "", n: 0, until: 0 };

	function sendBlocked() {
		return nowSeconds() < (sendFail.until || 0);
	}

	// 拔掉输入框末尾的触发串，让它不再命中触发条件。
	// 这是"停止自激"的关键一步：光复位 inputBusy 不够 —— 0.1 秒后扫描器会
	// 再一次看到那两个尾随空格，于是又发一次请求（实测就是这个死循环）。
	// 不走 $.Msg：那个通道在游戏里看不到（要靠推日志），而这条路径本来就是
	// "出问题了才走到"，状态行会同时给出人话提示。
	function clearTriggerSpaces(inp, trigger) {
		try {
			var text = readText(inp);
			if (text.length < trigger.length) return false;
			if (text.substring(text.length - trigger.length) !== trigger) return false;
			writeText(inp, text.substring(0, text.length - trigger.length));
			log("send_retry_stop:" + text.length);
			return true;
		} catch (e) { return false; }
	}

	// 触发键：默认三下空格；设置里可改成两下
	function triggerString() {
		return channel.hints.trigger === "double_space" ? "  " : TRIGGER;
	}

	// 把要说的话规整成**一行**：
	//   · 换行 -> 空格。游戏聊天框里按 Shift+Enter 会真的换行，带着换行去翻译，
	//     译文里就有换行，发出去变成两条消息（也顺带破坏"自己发的消息"识别）。
	//   · 连续空白 -> 一个空格。两个空格是触发键，不能留在正文里。
	//   · 首尾空白去掉。
	function sanitizeBody(text) {
		return String(text == null ? "" : text).replace(/\s+/g, " ").replace(/^\s+|\s+$/g, "");
	}

	// 聊天框里输入 /tongyi（或 /通译、/设置、旧的 /dlchat）也能打开面板：不依赖任何
	// 键位绑定，检测到就把输入框清空、打开面板 —— 不会把这条命令发出去。
	// ⚠ 只有带 / 的 ASCII 命令能 toLowerCase：中文别名要先原样比一遍（lower 对中文无害但没必要）。
	function checkSettingsCommand(inp) {
		var raw = readText(inp).replace(/^\s+|\s+$/g, "");
		var lower = raw.toLowerCase();
		if (lower === "/tongyi" || lower === "/dlchat" || lower === "/cfg"
			|| raw === "/通译" || raw === "/设置") {
			writeText(inp, "");
			ui.show();
			status.show("已打开通译设置", 3);
			return true;
		}
		return false;
	}

	function scanInput() {
		var root = null;
		try { root = $.GetContextPanel(); } catch (e) { return; }
		var inp = null;
		try { inp = root.FindChildTraverse("ChatInput"); } catch (e) {}
		if (!isValid(inp) || inputBusy) return;
		if (checkSettingsCommand(inp)) return;
		if (channel.hints.sendEnabled === false) return;      // 设置里关掉了中->英
		// 上一句刚失败过：冷却期内不重发（否则会每 0.1 秒打一个请求，
		// 把单槽通道占满、屏幕上别人的聊天行全排在后面）
		if (sendBlocked()) return;

		var trigger = triggerString();
		var text = readText(inp);
		if (text.length < trigger.length + 2) return;
		if (text.substring(text.length - trigger.length) !== trigger) return;

		var body = sanitizeBody(text.substring(0, text.length - trigger.length));
		if (!body || !looksChinese(body)) return;    // 只处理中文，纯英文原样放着

		inputBusy = true;
		status.show("翻译中…", 30);
		var expected = text;                          // 翻译期间用户可能继续打字，回来要对比
		// lane="fast"：玩家自己触发的，插到队首 —— 不排在屏幕上那堆聊天行后面
		bus.send("translate", {
			text: body, sourceLanguage: "zh", targetLanguage: "en"
		}, REQUEST_TIMEOUT, function (res) {
			inputBusy = false;
			if (!(res && res.ok && res.translation)) {
				// 失败要**有界**：同一句连续失败到上限就拔掉触发空格并明确告知，
				// 不能让它每 0.1 秒自己重发一次（那是个死循环，还会饿死接收路径）
				var sig = body + "|" + ((res && res.error) || "no_response");
				if (sendFail.sig !== sig) sendFail = { sig: sig, n: 0, until: 0 };
				sendFail.n += 1;
				sendFail.until = nowSeconds()
					+ (SEND_BACKOFF[Math.min(sendFail.n, SEND_BACKOFF.length - 1)] || 5);
				noteFailure("中→英", res, body);
				// ⚠️ 必须传 res.error 而不是 res：shortError 里第一句是 String(err)，
				// 传整个响应对象会显示成 "[object Object]"（实测在游戏里就是这样，
				// 玩家看到一句"翻译失败（[object Object]）"，等于没有原因）。
				// fallback 用 failureReason()，它能把"回包被截断 / 桥没响应"也说清楚。
				var why = shortError((res && res.error) || failureReason(res));
				status.show("翻译失败：" + why, 8);
				if (sendFail.n >= SEND_MAX_FAILS) {
					clearTriggerSpaces(inp, trigger);
					status.show("翻译失败，已停止自动重试（" + why
						+ "）；处理后可重新按空格触发", 10);
				}
				return;
			}
			sendFail = { sig: "", n: 0, until: 0 };       // 成功就清空失败记忆
			if (readText(inp) !== expected) {
				// 输入框内容在等结果的时候变了：不能覆盖玩家正在打的字
				status.show("输入已改变，未替换（译文：" + res.translation + "）", 8);
				log("out_stale:" + body + " => " + res.translation);
				return;
			}
			// 发出去的内容按设置决定：只发英文，还是中英都留
			var finalText = res.translation;
			if (channel.hints.outgoingMode === "bilingual") {
				finalText = body + separatorText() + res.translation;
			}
			// 两种形式都记：原文（游戏可能原样显示这句中文）+ 最终文本（也可能照搬）
			rememberSent(body, finalText);
			writeText(inp, finalText);
			try { if (typeof inp.SetFocus === "function") inp.SetFocus(); } catch (e) {}
			clearFailure();
			status.show((channel.hints.outgoingMode === "bilingual"
				? "已转成英文（中英都发），回车发送" : "已转成英文，回车发送"),
				STATUS_HOLD_SECONDS);
			log("out:" + body + " => " + finalText);
		}, "fast");
	}

	function watchInput() {
		var root = null;
		try { root = $.GetContextPanel(); } catch (e) { return false; }
		var inp = null;
		try { inp = root.FindChildTraverse("ChatInput"); } catch (e) {}
		if (!isValid(inp)) return false;
		// 有事件钩子就挂一个（键入立刻响应）；轮询照旧保留做兜底
		try {
			if (typeof inp.SetPanelEvent === "function") {
				inp.SetPanelEvent("ontextentrychange", function () { scanInput(); });
			}
		} catch (e) {}
		return true;
	}

	// ---------------------------------------------------------------- 启动
	// 状态提示只显示在一个地方（聊天输入框上方），而且尽量短：对局里视野宝贵。
	// 失败时把**具体原因**塞进提示里，这样看一眼截图就能定位是哪一段断了。
	//
	// 注意最后那一条：只有"传输层的机器码"才缩写，**桥返回的中文说明原样保留**。
	// 以前一律砍成 24 个字符，"API Key 无效或未设置（在 http://localhost:8791/settings
	// 里填）"正好在尾巴上被砍掉 —— 最该看到的那句没了。
	function shortError(err) {
		// 传进来的是**错误字符串**（res.error / 机器码），但历史上有过把整个响应
		// 对象传进来的写法，String({}) 会得到 "[object Object]" —— 玩家看到的就是
		// "翻译失败（[object Object]）"，等于没有任何原因。这里主动兜住：
		// 对象就取它的 .error / .message，取不到就说"未知错误"。
		if (err && typeof err === "object") {
			err = err.error || err.message || err.reason || "";
			if (!err) return "未知错误（桥没给原因）";
		}
		var e = String(err || "unknown");
		if (e.indexOf("[object ") === 0) return "未知错误（桥没给原因）";
		if (e.indexOf("timeout_no_page") === 0) return "面板未加载";
		if (e.indexOf("timeout_no_response") === 0) return "面板无响应";
		if (e.indexOf("timeout") === 0 || e === "http_timeout") return "超时";
		if (e.indexOf("no_bridge_panel") === 0) return "无桥面板";
		if (e.indexOf("seturl_failed") === 0) return "SetURL 失败";
		if (e.indexOf("http_failed") === 0) return "直连失败";
		if (e.indexOf("http_threw") === 0 || e.indexOf("http_no_promise") === 0) return "直连不可用";
		// 桥侧的机器码也要说人话：这些以前会原样透出（玩家看不懂 payload_too_long）
		if (e.indexOf("payload_too_long") === 0) return "内容太长，通道装不下（换短句重试）";
		if (e.indexOf("bridge_timeout") === 0) return "桥处理超时";
		if (e.indexOf("internal_error") === 0) return "桥内部错误：" + e.substring(0, 60);
		if (e.indexOf("empty_text") === 0) return "空文本，没什么可翻的";
		if (e.indexOf("bad_json") === 0) return "请求格式不对（桥版本可能不匹配）";
		// 已经像人话（含中文或空格）：原样给出去，别再砍
		if (/[\u4e00-\u9fff]/.test(e) || e.indexOf(" ") !== -1) {
			return e.length > 80 ? e.substring(0, 80) + "…" : e;
		}
		return e.substring(0, 24);
	}

	function showHealthResult(res) {
			if (res && res.ok) {
				status.show(channel.mode === "http" ? "通译 就绪（直连）"
					: "通译 就绪（面板）", 4);
			} else if (bus.bridgeUp) {
				// 单次探测失败不能推翻同一界面的成功翻译。
				status.show("通译 可用 · 状态检测稍后重试", 5);
			} else if (bus.consecutiveFailures < 2) {
				status.show("通译 正在确认连接…", 5);
			} else {
				// 两个布局各有独立通道；只报告当前界面，不能断言整个桥已停。
				status.show("通译 当前界面暂未连通，正在重试", 8);
				ui.status("当前界面连接诊断：" + shortError(res && res.error)
					+ (channel.panelDead ? " · 面板失效" : "")
					+ " [" + diag() + "]");
			}
	}

	function healthTick() {
		bus.send("health", null, REQUEST_TIMEOUT, showHealthResult);
	}

	function boot() {
		// 整个启动流程包一层：出错就把原因写到状态行上。
		// 之前脚本一旦在启动时抛异常，游戏里看到的是"状态灯灰色 + 状态行停在初始值"，
		// 从外面完全看不出发生了什么 —— 现在至少能一眼看到崩在哪。
		try {
			bootInner();
		} catch (e) {
			try { status.show("通译 脚本错误：" + e, 60); } catch (e2) {}
			try { $.Msg("[dlchat] boot failed: " + e + "\n"); } catch (e3) {}
		}
	}

	function bootInner() {
		var root = null;
		try { root = $.GetContextPanel(); } catch (e) { return; }
		var hasTopBar = false, hasChatList = false, hasInput = false;
		try { hasTopBar = isValid(root.FindChildTraverse("Messages")); } catch (e) {}
		try { hasChatList = isValid(root.FindChildTraverse("ChatMessages")); } catch (e) {}
		try { hasInput = isValid(root.FindChildTraverse("ChatInput")); } catch (e) {}

		var scope = hasTopBar ? "topbar" : (hasInput ? "chat" : "unknown");
		var panelFound = isValid(bus.findPanel());
		var canHttp = probeHttpChannel();

		// 主通道：HTML 面板事件。必须在任何导航之前注册，否则第一批事件会漏掉。
		registerPanelEvents();
		// 布局里的 onactivate 只能调到全局名字，这里把设置面板的入口挂上去
		exportGlobals();
		noHotkey();
		exportSelfTest();
		updateDot();

		// 头顶气泡那块不显示状态：对局里一直挂着一行字太吵，而且同一个提示
		// 会在两个布局里各显示一份。翻译本身照常工作。
		var quiet = hasTopBar && !hasInput;

		// 三个聊天容器各找到了没有 —— 这是"收不到消息"时第一个要看的数字。
		// 聊天窗 = ChatMessages，气泡 = 根面板下的 Messages，大厅 = ChatLinesPanel
		function surfacesFound() {
			var root = null;
			try { root = $.GetContextPanel(); } catch (e) { return "?"; }
			if (!isValid(root)) return "?";
			var bits = [];
			if (view("ChatMessages", root)) bits.push("chat");
			if (bubbleContainer(root)) bits.push("bubble");
			if (view("ChatLinesPanel", root)) bits.push("lobby");
			return bits.length ? bits.join("+") : "none";
		}

		log("boot", {
			scope: scope, mod: MOD_TAG, topBar: hasTopBar, chatList: hasChatList,
			input: hasInput, bridgePanel: panelFound, channel: channel.mode,
			probe: channel.probeError, events: channel.eventsRegistered,
			eventErrors: channel.eventErrors, hotkey: channel.hotkey,
			surfaces: surfacesFound()
		});

		if (!quiet) {
			if (!panelFound && !canHttp) {
				status.show("通译：没有可用通道（布局未生效？）", 15);
				return;
			}
			status.show("通译 通道：" + (canHttp ? "直连" : "面板"), 6);
		}

		var probeUrl = BRIDGE_BASE + "/api/v1/health";
		function startRequests() {
			if (channel.mode === "panel" && !quiet) {
				status.show("通译 等面板显示…", 12);
			}
			// 面板通道必须等面板真的渲染出来（聊天面板打开）再动它
			var waitDeadline = nowSeconds() + 90;
			waitForPanel(waitDeadline, function (onScreen) {
				channel.panelOnScreen = onScreen;
				if (channel.mode === "panel" && !onScreen && !quiet) {
					status.show("通译：面板未显示（打开聊天框再试）", 8);
				}
				var afterApi = function () {
					if (channel.mode === "panel") {
						probePanelNavigation(function () {
							if (!quiet && channel.mode === "panel") {
								status.show("通译 探针 G:" + (channel.pingLocal ? 1 : 0)
									+ "/" + (channel.pingIp ? 1 : 0), 6);
							}
							healthTick();
						});
						return;
					}
					healthTick();
				};
				if (channel.mode === "panel" && channel.probeError === "no_promise_no_sendrequest") {
					probeApiShapes(probeUrl, function () {
						if (apiProbe.cbShape) {
							channel.mode = "http";
							channel.httpStyle = "cb";
							log("api callback shape found: " + apiProbe.cbShape, apiProbe);
						}
						afterApi();
					});
					return;
				}
				afterApi();
			});
		}
		try { $.Schedule(2.0, startRequests); } catch (e) { startRequests(); }
		every(HEALTH_INTERVAL, function () {
			if (bus.bridgeUp) return;      // 已确认在线就别占通道
			// 面板通道已经判定失效时，允许重新探测一次直连 API：
			// 启动早期探测有可能因为引擎还没就绪而失败，不能一次判死。
			if (channel.mode === "panel" && channel.panelDead) {
				channel.mode = null;
				channel.panelDead = false;
				probeHttpChannel();
			}
			healthTick();
		});

		// 三个界面一起扫（互不短路）：聊天窗 / 头顶气泡 / 大厅展开聊天。
		// 每 0.25 秒一次，但每个界面内部只处理"新增的行"，所以绝大多数 tick 是空转。
		every(ROW_SCAN_SECONDS, function () { scanAllSurfaces(); });
		if (hasInput) {
			watchInput();
			every(INPUT_SCAN_SECONDS, scanInput);
		}
		every(0.5, function () {
			status.tick();
			// "翻译中"占位要按时间推进：延迟 0.4 秒才显示、失败提示到点收掉、
			// 失败的行重排队。放在这里是为了复用已有的 tick，不新增定时器。
			pendingTick(nowSeconds());
		});
	}

	try { $.Schedule(0.3, boot); } catch (e) {}
})();
