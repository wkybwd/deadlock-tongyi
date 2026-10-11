"""本地翻译桥：给 BabelTower 的 Deadlock 游戏内 mod 当"大脑"。

## 为什么要写这个

BabelTower(https://github.com/c1375rick/BabelTower, GPL-3.0) 证明了这条路可行：
游戏内 Panorama 读聊天行 → 通过**隐藏 HTML 面板**访问本地 HTTP 桥 → 译文追加显示在
游戏里。它把"读"和"显示"解决了，但翻译用的是 **Bing 公共接口**（限流、会挂、把聊天
发到微软服务器）或需要 Azure/DeepL 的 Key，词典 2801 条。

我们不改它的 UI（那部分要在游戏里反复调试，且它已经稳定），只**把桥换成我们自己的**：

| 维度 | BabelTower 桥(Node.js) | 本桥(Python) |
|---|---|---|
| 引擎 | Bing 公共接口 / Azure / DeepL / OpenAI | **本地 Ollama Hy-MT2-7B**（默认），可切云端 |
| 隐私 | 聊天内容发往第三方 | **不出本机** |
| 成本 | 限流 / 按量计费 | 0 |
| 术语 | 2801 条内置词典 | **3926 条**（游戏本地化自动生成）+ 118 条整句直译 + 俚语 + 保留英文清单 |
| 术语约束 | 查表替换 | 查表 + 提示词注入 + 译后校验 |
| 运行时 | 需要 Node.js | Python（本机已有），复用既有 translator 代码 |

## 协议（与 BabelTower 兼容，逐字节对齐）

游戏侧不做 HTTP（Deadlock 移除了 `$.WebRequest`），而是让隐藏 HTML 面板加载
`GET /bridge?id=..&op=..&text=..&source=..&target=..`，页面内 JS 同源 fetch 本桥的
受限 API，再把结果写进 `document.title`（`LCT<id>` + JSON），Panorama 轮询读取。

端点：
    GET  /bridge                   隐藏面板页面（结果写回 document.title）
    GET  /api/v1/health            健康检查（mod 用它判断"桥是否在运行"）
    GET  /api/v1/gamenames         英雄/物品名表（mod 启动时同步，用于名称保护）
    POST /api/v1/translate         {text, sourceLanguage, targetLanguage} -> {ok, translation}
    POST /api/v1/test              固定文本试翻
    GET|POST /api/v1/config        读写配置（面板用；本桥只读展示）
    POST /api/v1/log               聊天日志（本桥接受但忽略）
    GET|POST 均支持：游戏侧 $.AsyncWebRequest 只能发 GET，故也接受 ?d=<JSON>

踩过的坑（沿用 BabelTower 的经验）：**必须同时绑 127.0.0.1 和 ::1**。
Windows 上 `localhost` 可能解析成 IPv6 回环，只绑 IPv4 会让游戏判定"桥未运行"。
"""

from __future__ import annotations

import asyncio
import json
import logging
import re
import socket
import threading
import time
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any
from urllib.parse import parse_qs, urlparse

from .. import paths
from ..chat.glossary import Glossary
from ..config import Config
from ..settings import (MODEL_FIELDS, PROVIDERS, AppSettings, apply_to_config,
                        effective_view, is_key_set, load_settings, provider_label,
                        provider_models, reset_settings, save_settings, separator_text,
                        settings_path)
from .settings_page import PAGE as SETTINGS_PAGE
from .image_ipc import IPCError, ImageIPC, MAX_PARTS, png_bytes, validate_id
from ..translate.cache import TranslationCache
from ..translate.client import ChatTranslator, describe_error

logger = logging.getLogger(__name__)

DEFAULT_PORT = 8791
MAX_BODY = 64 * 1024           # 与 BabelTower 一致的请求体上限
MAX_TEXT = 4000                # 单条文本上限
BRIDGE_VERSION = "1.0.0"

# 回给游戏侧译文的**字符预算**。这不是审美问题，是通道的硬约束：
#   1) 结果要经 HTML 文档标题传回（server.py 里 bridge_page 的 asciiJson），
#      所有非 ASCII 都被转成 \uXXXX —— **一个汉字 = 6 个字符**；
#   2) 标题超过 900 字符会被整包替换成 payload_too_long；
#   3) 引擎实测约 479 字符就开始截断（docs/bridge.md）。
# 于是"整包"（含 displayMode/keySet 等 hints，约 260 字符）只能装下这么多：
#   预算 × 6 + 260 < 900  →  预算 ≈ 100 字符以内，取 60 留足安全余量
# （英文预算按"每个字符都可能被转义"的最坏情况算 —— 译文里出现一个全角标点
#   或中文引号就会走 6 倍路径，所以不能因为"英文是 ASCII"就放宽）。
# 而 MAX_TEXT 允许 4000 字符的输入 —— 长消息以前必然撞门禁，玩家看到的是
# "翻译失败"，点开面板是"未知原因"。现在主动截断并**明确告诉前端**，
# 让游戏里能提示"译文过长，已截断"。
TRANSLATION_BUDGET = {"en->zh": 64, "zh->en": 56}
# 截断标记刻意用**纯 ASCII**：整包会被转义成 \uXXXX，一个非 ASCII 字符要占 6 个字符，
# 用 "…" 反而会把预算吃掉 6 个位置（等于白白少显示 5 个汉字）。ASCII 标记 = 1 个字符。
TRUNCATION_SUFFIX = " ..."


def fit_translation(text: str, direction: str) -> tuple[str, bool]:
    """把译文压进通道预算；返回 (文本, 是否截断)。

    截断位置按**目标语言**选断点：
      · 中文（en->zh）没有词边界，所以只认中文标点（。！？；、）——绝不能拿空格
        当断点，否则整段中文会被判成"没有断点"从而硬切，看起来像被吃了半句；
      · 英文（zh->en）认空格和 ASCII 标点，保证不切断单词。
    实在找不到断点就硬截 —— 宁可少半句，也不要让玩家看到"翻译失败"。
    """
    budget = TRANSLATION_BUDGET.get(direction, 100) - len(TRUNCATION_SUFFIX)
    if len(text) <= budget + len(TRUNCATION_SUFFIX):
        return text, False
    head = text[:budget]
    marks = "。！？；、" if direction == "en->zh" else " \t.!?;,\n"
    cut = max(head.rfind(ch) for ch in marks)
    if cut >= budget // 2:            # 找到一个像句尾/词尾的位置
        head = head[:cut + 1]
    return head.rstrip() + TRUNCATION_SUFFIX, True

CJK_RE = re.compile(r"[\u4e00-\u9fff]")
# 非拉丁字母的语言（亚服/欧服混排里俄语很常见）。以前这些消息在 mod 侧就被丢掉，
# 或者被当成英文送进"英译中"的提示词 —— 两者都是静默失败。
CYRILLIC_RE = re.compile(r"[\u0400-\u04ff]")
GREEK_RE = re.compile(r"[\u0370-\u03ff]")

# 来源在游戏通道里的单字母编码（字段名和取值都要短，见 settings_view 的注释）
_PROVIDER_CODE = {"local": "l", "deepseek": "d", "openai": "o"}
_PROVIDER_BY_CODE = {v: k for k, v in _PROVIDER_CODE.items()}

# 双语分隔符的单字母编码（同样是为了省标题通道的长度）
_SEPARATOR_CODE = {"pipe": "p", "full": "f", "space": "s"}
_SEPARATOR_BY_CODE = {v: k for k, v in _SEPARATOR_CODE.items()}


def decode_separator(raw: Any) -> str | None:
    """认单字母码、也认真名；认不出返回 None（= 不变）。"""
    text = str(raw or "").strip()
    if not text:
        return None
    if text in _SEPARATOR_BY_CODE:
        return _SEPARATOR_BY_CODE[text]
    if text in _SEPARATOR_CODE:
        return text
    return None


def decode_provider(raw: Any) -> str | None:
    """把面板传来的来源解开：认单字母码、也认真名。认不出就返回 None（= 不变）。"""
    text = str(raw or "").strip()
    if not text:
        return None
    if text in _PROVIDER_BY_CODE:
        return _PROVIDER_BY_CODE[text]
    if text in _PROVIDER_CODE:
        return text
    return None


# compact 响应的长度上限（字符）。游戏侧是把它写进 HTML 文档标题再读回来的，
# 实测 479 字符会被截断成半截 JSON —— 前端只解析出 {"ok":true}，面板上一片
# undefined，而且看起来像"设置全丢了"。所以这里主动兜底：宁可少几个统计字段，
# 也不能让包被路截断。字段按"丢了不心疼"的顺序往外扔。
#
# 注意 compact 用的是**短键**（recv/send/hover/disp/out/trig/keep/gloss/prv），
# 不是 AppSettings 里的字段名：一个字符就是一个字符，长键名加起来能吃掉 60 多个，
# 而那些位置本该留给用户自己起的模型名。mod 那边有对应的解码表。
COMPACT_SOFT_LIMIT = 440
COMPACT_DROP_ORDER = ("vram", "loaded", "latOut", "latIn", "hit", "req", "persisted")


def _fit_compact(payload: dict[str, Any]) -> dict[str, Any]:
    """把 compact 包压到上限以内。

    两段式：先按"丢了不心疼"的顺序扔可选统计，再压模型名的显示长度。核心字段
    （开关 / 来源 / 显示方式 / 触发键）一个都不丢 —— 少了它们面板会以为响应被截断
    而整块不渲染，那才是真正不能用的情况。
    """
    if len(json.dumps(payload, ensure_ascii=False)) < COMPACT_SOFT_LIMIT:
        return payload

    def size() -> int:
        return len(json.dumps(payload, ensure_ascii=False))

    trimmed = False
    for key in COMPACT_DROP_ORDER:
        if size() < COMPACT_SOFT_LIMIT:
            return payload
        if key in payload:
            payload.pop(key, None)
            trimmed = True

    # 统计字段全扔了还超长 -> 只可能是模型名本身太长（用户自己起的，70+ 字符很正常）
    model = str(payload.get("model") or "")
    for keep in (96, 64, 48, 32, 24):
        if size() < COMPACT_SOFT_LIMIT:
            break
        if len(model) <= keep:
            break
        payload["model"] = model[:keep - 1] + "…"
        trimmed = True

    if trimmed:
        # trimmed 自己也占字符：得算进预算里，否则会出现"裁完刚好又超一点"。
        payload["trimmed"] = True
        if size() >= COMPACT_SOFT_LIMIT:
            logger.warning("compact 响应仍然偏长（%d 字符，模型名 %d 字符）："
                           "面板可能只解析出半截 JSON", size(), len(model))
        else:
            logger.warning("compact 响应过长，已裁剪（模型名 %d 字符，最终 %d 字符）",
                           len(model), size())
    return payload


def _no_proxy_opener() -> urllib.request.OpenerDirector:
    """访问本机服务（Ollama）时显式绕过系统代理。

    这台机器上有 v2rayN 在 127.0.0.1:10808 上做系统代理，httpx/urllib 默认可能
    把本地请求也塞进代理，表现是"偶发 503 / 卡住"。项目里对翻译客户端已经这么做了，
    这里保持一致。
    """
    return urllib.request.build_opener(urllib.request.ProxyHandler({}))


class BridgeApp:
    """桥的业务逻辑（与 HTTP 层分开，便于单测）。"""

    def __init__(self, cfg: Config, glossary: Glossary | None = None):
        self.cfg = cfg
        self.glossary = glossary or Glossary()
        self.cache = TranslationCache(max_size=2048)
        # 用户设置（覆盖层）：模型/provider/开关/显示方式等
        self.settings = load_settings(cfg)
        self._latencies: dict[str, list[float]] = {"en->zh": [], "zh->en": []}
        self._models_cache: tuple[float, list[str]] = (0.0, [])
        # 桥走"低延迟档"：聊天行彼此独立，不需要多轮上下文（省 prefill），
        # 输出也短（一条消息没几个字），把 max_tokens 收紧。
        # 实测：中→英 中位 169ms，英→中 中位 1216ms（游戏在跑、GPU 被抢的情况下）。
        self.translator = ChatTranslator(
            apply_to_config(cfg, self.settings).translate, self.glossary)
        self._loop: asyncio.AbstractEventLoop | None = None
        self._lock = threading.Lock()
        self.stats = {"requests": 0, "cache_hits": 0, "errors": 0}
        # 游戏侧（Panorama JS）没法直接看 console，于是把诊断信息 POST 到 /api/v1/log，
        # 这里留一份环形缓冲 + 落盘，联调时用 `python scripts/mod_log.py` 直接读。
        self.game_log: list[dict[str, Any]] = []
        self._log_path = paths.log_dir() / "mod.log"
        self.access_log_path = paths.log_dir() / "http.log"
        self._last_activity = 0.0        # 上次真正翻译的时间（keep-alive 用）
        self._keepalive_stop = threading.Event()
        self.warm_cache()

    def warm_cache(self) -> int:
        """把词典整句直接灌进缓存：这些命中就是 0ms，不用等模型。

        · phrases.json（英→中，118 条聊天轮盘/快捷语）
        · phrases_zh.json（中→英，50 条中文常用语）
        """
        count = 0
        for en, zh in self.glossary.phrases.items():
            self.cache.put(en, "en->zh", zh)
            count += 1
        for zh, en in self.glossary.phrases_zh.items():
            self.cache.put(zh, "zh->en", en)
            count += 1
        logger.info("桥缓存预热 %d 条词典整句（命中即 0ms）", count)
        return count

    # ---------- 生命周期 ----------

    def start_loop(self) -> None:
        """在后台线程跑一个 asyncio 事件循环（translator 是 async 的）。"""
        if self._loop is not None:
            return
        ready = threading.Event()

        def _run() -> None:
            loop = asyncio.new_event_loop()
            asyncio.set_event_loop(loop)
            self._loop = loop
            ready.set()
            loop.run_forever()

        threading.Thread(target=_run, daemon=True, name="bridge-loop").start()
        ready.wait(5)

    def close(self) -> None:
        if self._loop is None:
            return
        try:
            asyncio.run_coroutine_threadsafe(self.translator.close(), self._loop).result(3)
        except Exception:  # noqa: BLE001
            pass
        self._loop.call_soon_threadsafe(self._loop.stop)
        self._loop = None

    def warmup(self) -> bool:
        """预热翻译后端（把模型载入显存），避免游戏里第一条等太久。

        云端没配密钥时**直接跳过**：否则启动会干等一次完整的超时（几十秒），
        而玩家看到的只是"桥起不来"。
        """
        if not is_key_set(self.settings):
            logger.warning("跳过预热：%s 还没配 API Key"
                           "（浏览器打开 http://localhost:8791/settings 填一次）",
                           provider_label(self.settings.provider))
            return False
        try:
            return bool(self._run_async(self.translator.prewarm()))
        except Exception as e:  # noqa: BLE001
            logger.warning("桥预热失败: %s", e)
            return False

    # ---------- 翻译 ----------

    def translate(self, text: str, source: str = "auto",
                  target: str = "zh-Hans") -> dict[str, Any]:
        text = (text or "").strip()
        if not text:
            return {"ok": False, "error": "empty_text"}
        if len(text) > MAX_TEXT:
            text = text[:MAX_TEXT]
        self.stats["requests"] += 1

        direction = self._direction(text, source, target)
        # 开关：按方向判断，关掉的方向直接原样返回（游戏侧也会显示"已关闭"）
        if direction == "en->zh" and not self.settings.receive_enabled:
            return {"ok": True, "translation": text, "skipped": "receive_disabled",
                    **self._ui_hints()}
        if direction == "zh->en" and not self.settings.send_enabled:
            return {"ok": True, "translation": text, "skipped": "send_disabled",
                    **self._ui_hints()}
        if direction is None:                      # 已经是目标语言 -> 不用翻
            return {"ok": True, "translation": text,
                    "detectedLanguage": "zh" if CJK_RE.search(text) else "en",
                    "skipped": "already_target_language", **self._ui_hints()}

        # 没选模型时直接说清楚。否则请求会带着空模型名出去，拿回一句
        # "model is required" —— 玩家看不懂，也猜不到要回面板点一下模型。
        if not (self.settings.model or "").strip():
            return {"ok": False,
                    "error": "还没选翻译模型：聊天框输入 /tongyi 打开面板 → 点「翻译模型」选一个",
                    **self._ui_hints()}

        started = time.perf_counter()
        # 源语言：用于挑提示词（英/俄各一套）。mod 会把俄语按字面报上来，
        # 没报就按文本自己判断 —— 不能把俄语当英文硬翻。
        # 必须在缓存查询之前算出来：缓存命中那条回包也要带上它。
        src_lang = self._detect_language(text)
        cached = self.cache.get(text, direction)
        if cached:
            self.stats["cache_hits"] += 1
            return {"ok": True, "translation": cached,
                    "detectedLanguage": self._detected(direction, src_lang), "viaCache": True,
                    **self._ui_hints()}

        try:
            out = self._run_async(self.translator.translate_full(text, direction,
                                                                 src_lang))
        except Exception as e:  # noqa: BLE001
            self.stats["errors"] += 1
            detail = describe_error(e)
            logger.warning("桥翻译失败: %s", detail)
            return {"ok": False, "error": f"translate_failed: {detail}",
                    **self._ui_hints()}

        if not out:
            self.stats["errors"] += 1
            # 具体原因（key 错 / 欠费 / 限流 / 超时 / 只输出了思考）由 client 归类好，
            # 原样带到游戏面板 —— 这是本工具唯一需要用户自己配的东西，不能只说"失败"。
            detail = (getattr(self.translator, "last_error", "")
                      or "模型返回空译文")
            return {"ok": False, "error": detail, **self._ui_hints()}
        self.cache.put(text, direction, out)
        self._record_latency(direction, (time.perf_counter() - started) * 1000)
        self._last_activity = time.time()      # keep-alive 用它判断"刚翻译过"
        raw_len = len(out)
        out, truncated = fit_translation(out, direction)
        if truncated:
            logger.info("译文超出通道预算，已截断（%s，%d -> %d 字）",
                        direction, raw_len, len(out))
        result = {"ok": True, "translation": out,
                  "detectedLanguage": self._detected(direction, src_lang), **self._ui_hints()}
        if truncated:
            # 前端据此提示"译文过长，已截断"——以前这种情况直接是通道截断 +
            # "翻译失败/未知原因"，玩家完全不知道发生了什么
            result["truncated"] = True
        return result

    def _record_latency(self, direction: str, ms: float) -> None:
        bucket = self._latencies.setdefault(direction, [])
        bucket.append(ms)
        if len(bucket) > 200:
            del bucket[:-200]

    def _ui_hints(self) -> dict[str, Any]:
        """随每次响应带回去的渲染提示：mod 不用重新打包就能跟随设置变化。"""
        return {
            "displayMode": self.settings.display_mode,
            "showOriginal": self.settings.show_original_on_hover,
            "outgoingMode": self.settings.outgoing_mode,
            "receiveEnabled": self.settings.receive_enabled,
            "sendEnabled": self.settings.send_enabled,
            "trigger": self.settings.trigger,
            # 双语模式下中英之间拼什么（mod 拼输入框那串字时用它）
            "separator": separator_text(self.settings.separator),
            # 翻译来源 + 密钥是否配好：mod 的面板据此显示"云端（缺 Key）"并点出来
            "provider": self.settings.provider,
            "keySet": is_key_set(self.settings),
        }

    # ---------- 设置 ----------

    def settings_view(self, compact: bool = False,
                      with_backend: bool = True) -> dict[str, Any]:
        """compact=True 时只回游戏内面板必需的小字段。

        为什么需要 compact：游戏内那条通道是把响应写进 HTML 文档标题再读回来的，
        标题有长度限制，字段一多就会被截断 -> JSON 解析失败（表现是"读取失败：bad_json"）。
        所以核心字段和模型列表分开取，模型列表等玩家真的要选模型时再单独要一次。
        """
        view = effective_view(self.settings, dict(self.stats), self._latencies)
        if compact:
            lat = (view.get("resource") or {}).get("latencyMs") or {}
            stats = (view.get("resource") or {}).get("stats") or {}
            be = self.backend_status() if with_backend else {}
            # 这个包会经 HTML 文档标题传给游戏，**长度就是硬约束**：
            # 之前塞进完整 backend 对象把长度推到 479 字符，结果被截断 ->
            # 前端只解析出 {"ok":true} -> 面板上一片 undefined。
            # 所以这里只放短键 + 数字，最后再过一道 _fit_compact 兜底
            # （模型名是用户自己起的，长度由不得我们）。
            payload = {
                "ok": True,
                "recv": view["receive_enabled"],
                "send": view["send_enabled"],
                "disp": view["display_mode"],
                "out": view["outgoing_mode"],
                "hover": view["show_original_on_hover"],
                "trig": view["trigger"],
                "keep": view["keep_alive"],
                "gloss": view["glossary"],
                # 上下文轮数（0/1/2）：短句消歧用，游戏内面板可改。
                # 短键 ctx —— 这个包要经 HTML 标题通道传回，长度是硬约束。
                "ctx": view["context_rounds"],
                "model": view["model"],
                # 来源用单字母码 "l"/"d"/"o"：见 COMPACT_SOFT_LIMIT 上面的注释
                "prv": _PROVIDER_CODE.get(self.settings.provider, "o"),
                # 双语模式中英之间拼什么（"p" 竖线 / "f" 全角竖线 / "s" 空格）
                "sep": _SEPARATOR_CODE.get(self.settings.separator, "p"),
                # 云端没配密钥时面板要明说（这一个字符组的代价换"少走一趟弯路"）
                "keySet": is_key_set(self.settings),
                "persisted": settings_path().exists(),
                "req": stats.get("requests", 0),
                "hit": stats.get("cache_hits", 0),
                "latIn": lat.get("en->zh", 0),
                "latOut": lat.get("zh->en", 0),
                "vram": be.get("vramPercent", -1),
                "loaded": be.get("modelLoaded", None),
            }
            return _fit_compact(payload)
        view["models"] = self.local_models().get("models", [])
        view["backend"] = self.backend_status()
        view["ok"] = True
        return view

    def update_settings(self, payload: dict[str, Any]) -> dict[str, Any]:
        """保存并热应用。只有影响模型调用的字段变化时才重建 translator。"""
        is_reset = bool(payload.get("reset"))
        if is_reset:
            reset_settings()
            new = load_settings(self.cfg)
        else:
            raw = self.settings.model_dump()
            # 空密钥**不落盘**：AppSettings.api_key 的语义是"没配过就去读 config.yaml"
            # （含 ${ENV} 展开），所以存一个 "" 进去、回读时又变成 config 里的值，
            # 会被下面那道"回读校验"判成 settings_not_persisted（真机上就是
            # "保存失败"，其实什么都没坏）。留空 = 保留当前生效值。
            if not str(payload.get("api_key") or "").strip():
                payload = {k: v for k, v in payload.items() if k != "api_key"}
            # mod 面板把来源发成单字母码。**必须先把 payload 里那个键取出来**：
            # raw 里本来就有 provider 字段（当前生效值），如果只是"payload 有的键拷进 raw"，
            # prv 会因为不是 AppSettings 字段而被丢掉，接着去读 raw["provider"] 又会读到
            # 那个旧值 —— 结果就是"接口回 ok、来源没变"的静默失败（实测踩到过）。
            want_provider = decode_provider(payload.get("prv")
                                            or payload.get("pv")
                                            or payload.get("provider"))
            for key, value in payload.items():
                if key in raw:
                    raw[key] = value
            if want_provider:
                raw["provider"] = want_provider
                raw["base_url"] = ((PROVIDERS.get(want_provider) or {}).get("base_url")
                                   or raw.get("base_url", ""))
                # 换了来源之后，原来那个模型名多半在新来源里不存在（本地那串
                # hf.co/tencent/... 发给云端只会换回一个看不懂的报错），换成该来源第一个。
                preset = provider_models(want_provider)
                if raw.get("model") not in preset:
                    if preset:
                        raw["model"] = preset[0]
                    else:
                        # 本地 Ollama 没有固定清单：问一下它装了哪些模型，取第一个。
                        # 留空的话，下一次翻译会直接 400 "model is required"。
                        raw["model"] = (self._ollama_models(
                            (PROVIDERS.get("local") or {}).get("base_url") or "")
                            or [""])[0]
            try:
                new = AppSettings(**raw)
            except Exception as e:  # noqa: BLE001  pydantic ValidationError
                return {"ok": False, "error": f"invalid_settings: {e}"}
            save_settings(new)

        model_changed = any(
            getattr(new, f) != getattr(self.settings, f)
            for f in MODEL_FIELDS if hasattr(new, f))
        self.settings = new
        if model_changed:
            self._rebuild_translator()

        # 落盘并**当场回读校验**：设置这种"用户以为存住了"的东西，
        # 不允许出现"接口说成功、磁盘上没有"的静默失败。
        # 注意"恢复默认"是删文件，不适用这条校验（自检就抓到过这个误报）。
        path = settings_path()
        if not is_reset:
            try:
                back = load_settings(self.cfg)
            except Exception as e:  # noqa: BLE001
                return {"ok": False, "error": f"verify_failed: {e}"}
            if not path.exists():
                return {"ok": False, "error": "settings_file_missing_after_save"}
            if back.model_dump() != new.model_dump():
                return {"ok": False, "error": "settings_not_persisted"}

        self.record_game_log({"op": "settings-saved" if not is_reset else "settings-reset",
                              "msg": "设置已写入" if not is_reset else "已恢复默认",
                              "path": str(path), "model": new.model,
                              "modelReloaded": model_changed})
        # 回执必须是**小包**：游戏侧通道是把响应写进 HTML 文档标题再读回来的，
        # 太长会被截断（实测 897 字符的回执会截断成非法 JSON，前端报 event_bad_json）。
        return {"ok": True, "modelReloaded": model_changed,
                "saved": not is_reset,
                # 回执不带 backend（显存信息）：加了就会超过 500 字符上限被通道截断，
                # 自检的门禁就是这么抓到的。读取设置时才带。
                "settings": self.settings_view(compact=True, with_backend=False)}

    def _rebuild_translator(self) -> None:
        """换模型/换端点后重建 translator，并清空缓存（否则旧译文继续命中）。"""
        old = self.translator
        try:
            self.translator = ChatTranslator(
                apply_to_config(self.cfg, self.settings).translate, self.glossary)
        except Exception as e:  # noqa: BLE001
            logger.warning("重建 translator 失败: %s", e)
            self.translator = old
            return
        self.cache = TranslationCache(max_size=2048)
        # 模型清单缓存也要作废：它按来源缓存，换了来源还留着旧来源的列表，
        # 面板上就会列出"选了必然报错"的模型名。
        self._models_cache = (0.0, [])
        self.warm_cache()
        try:
            if self._loop is not None:
                asyncio.run_coroutine_threadsafe(old.close(), self._loop)
        except Exception:  # noqa: BLE001
            pass

    def settings_test(self, text: str = "he is low, dive him") -> dict[str, Any]:
        """设置页的"试翻一句"：两个方向各来一次，带延迟。"""
        out: dict[str, Any] = {"ok": True, "provider": self.settings.provider,
                               "model": self.settings.model}
        if not is_key_set(self.settings):
            out["keySet"] = False
            out["hint"] = (f"{provider_label(self.settings.provider)} 需要 API Key："
                           "在 http://localhost:8791/settings 里填一次，永久生效")
            # 没配密钥就别去发请求：那一下必然 401，还要白等一个网络往返，
            # 而"ok:true + 一段提示"更容易被当成"能用"。
            return {"ok": False, "error": "API Key 未配置", "keySet": False,
                    "hint": out["hint"], "provider": self.settings.provider,
                    "model": self.settings.model}
        t0 = time.perf_counter()
        fwd = self.translate(text, "en", "zh-Hans")
        out["ms"] = round((time.perf_counter() - t0) * 1000)
        if not fwd.get("ok"):
            return {"ok": False, "error": fwd.get("error", "unknown"),
                    "provider": self.settings.provider,
                    "model": self.settings.model,
                    "keySet": is_key_set(self.settings)}
        out["translation"] = fwd.get("translation")
        t1 = time.perf_counter()
        back = self.translate("他残血，上", "zh", "en")
        out["backMs"] = round((time.perf_counter() - t1) * 1000)
        out["back"] = back.get("translation") if back.get("ok") else back.get("error")
        return out

    def list_models(self, provider: str | None = None) -> dict[str, Any]:
        """给 mod 的模型下拉用的模型列表，**按来源分流**。

        以前这里写死查 Ollama 的 /api/tags：一旦来源切到云端，面板上列出的还是本机
        Ollama 的模型名，选了必然报错。云端没有"列出可用模型"的可靠接口，所以用
        settings.PROVIDERS 里的固定清单 —— 顺便省掉游戏内那次几百毫秒的串行往返
        （游戏通道是单槽串行，每次请求都要等前一个落地）。

        返回里的 provider 是**解析后**的来源，面板据此确定该显示什么。
        """
        want = provider or self.settings.provider
        if want == "local":
            if provider and provider != self.settings.provider:
                # 面板停在"本地"、但还没保存时点开列表：按面板上的来源去问 Ollama，
                # 别用当前生效的 base_url（那是云端的，问了也是空）。
                base = ((PROVIDERS.get("local") or {}).get("base_url") or "").rstrip("/")
            else:
                base = (self.settings.base_url or "").rstrip("/")
            return {"ok": True, "provider": "local",
                    "models": self._ollama_models(base)}
        models = provider_models(want)
        return {"ok": True, "provider": want, "models": models,
                "cloud": True, "labels": [provider_label(want)]}

    def _ollama_models(self, base: str) -> list[str]:
        """列出本机 Ollama 已安装的模型。失败返回空表，不抛错。"""
        now = time.time()
        cached_at, cached = self._models_cache
        if cached and now - cached_at < 30:
            return cached
        root = base[:-3] if base.endswith("/v1") else base
        models: list[str] = []
        if root:
            try:
                with _no_proxy_opener().open(root + "/api/tags", timeout=5) as resp:
                    data = json.loads(resp.read().decode("utf-8"))
                models = sorted(m.get("name", "") for m in data.get("models", [])
                                if m.get("name"))
            except Exception as e:  # noqa: BLE001
                logger.debug("读取 Ollama 模型列表失败: %s", e)
        self._models_cache = (now, models)
        return models

    def local_models(self) -> dict[str, Any]:
        """兼容旧调用（测试与 /api/v1/models 的默认路径）。"""
        return self.list_models()

    # ---------- 后端 / 显存状态 ----------

    def backend_status(self) -> dict[str, Any]:
        """问 Ollama：模型现在在不在显存里、跑在 GPU 还是 CPU。

        用途：出现"连续超时"时，最可能的原因是显存被游戏挤爆、模型被丢到 CPU。
        把这个报出来，游戏内面板就能直接显示，不用靠猜。
        """
        if self.settings.provider != "local":
            return {}                 # 云端没有 Ollama /api/ps，不能绕过代理去探测它
        base = (self.settings.base_url or "").rstrip("/")
        root = base[:-3] if base.endswith("/v1") else base
        if not root:
            return {}
        try:
            with _no_proxy_opener().open(root + "/api/ps", timeout=4) as resp:
                data = json.loads(resp.read().decode("utf-8"))
        except Exception as e:  # noqa: BLE001
            return {"reachable": False, "error": str(e)[:80]}
        mine = None
        for m in data.get("models", []):
            if m.get("name") == self.settings.model:
                mine = m
        total = (mine or {}).get("size") or 0
        vram = (mine or {}).get("size_vram") or 0
        # Ollama 有的版本不给 processor 字段，用 size/size_vram 自己算更靠得住：
        # 全部在显存 -> 100%；只放了一部分 -> 剩下的在 CPU 上跑，会明显变慢。
        pct = round(vram / total * 100) if total else 0
        return {
            "reachable": True,
            "modelLoaded": mine is not None,
            "processor": (mine or {}).get("processor", "") or (
                f"{pct}% GPU" if pct else ""),
            "vramPercent": pct,
            "sizeVramMb": round(vram / 2**20),
            "sizeTotalMb": round(total / 2**20),
        }

    # ---------- keep-alive：别让模型从显存里掉出去 ----------

    def start_keepalive(self, interval_s: float = 180.0) -> None:
        """定时发一个 1 token 的请求，把模型钉在显存里。

        Ollama 空闲到 keep_alive 时限就把模型卸载，下一条翻译要重新载入 6.8 GB；
        游戏占着 GPU 时这一下就可能超过客户端超时 —— 玩家体感就是"时好时坏"。
        """
        if getattr(self, "_keepalive_thread", None):
            return

        def loop() -> None:
            while not self._keepalive_stop.wait(interval_s):
                try:
                    # 只有本地 Ollama 需要保活；云端（DeepSeek 等）没有"显存里的模型"
                    # 这回事，发过去纯属白烧 token。按 provider 判断，比按 URL 猜可靠。
                    if self.settings.provider != "local":
                        continue
                    base = self.settings.base_url or ""
                    if "11434" not in base and "localhost" not in base:
                        continue
                    if time.time() - self._last_activity < interval_s * 0.8:
                        continue                      # 刚翻译过，不用管
                    root = base.rstrip("/")
                    root = root[:-3] if root.endswith("/v1") else root
                    body = json.dumps({
                        "model": self.settings.model, "prompt": "ok",
                        "stream": False, "keep_alive": self.settings.keep_alive,
                        "options": {"num_predict": 1},
                    }).encode("utf-8")
                    req = urllib.request.Request(
                        root + "/api/generate", data=body,
                        headers={"Content-Type": "application/json"})
                    _no_proxy_opener().open(req, timeout=30).read()
                    logger.info("keep-alive：模型仍钉在显存里")
                except Exception as e:  # noqa: BLE001
                    logger.debug("keep-alive 失败（不影响翻译）: %s", e)

        self._keepalive_thread = threading.Thread(
            target=loop, daemon=True, name="bridge-keepalive")
        self._keepalive_thread.start()

    def close_keepalive(self) -> None:
        self._keepalive_stop.set()

    def test(self) -> dict[str, Any]:
        """mod 设置面板里的「测试」按钮。"""
        r = self.translate("hello", "en", "zh-Hans")
        if not r.get("ok"):
            return {"ok": False, "error": r.get("error", "unknown")}
        return {"ok": True, "translation": r["translation"],
                "message": "连接成功（本地模型）"}

    # ---------- 游戏侧日志 ----------

    def record_game_log(self, payload: dict[str, Any]) -> dict[str, Any]:
        """收下 Panorama JS 发来的诊断行（同时落盘，方便事后翻）。"""
        entry = {"t": time.time(), **payload}
        with self._lock:
            self.game_log.append(entry)
            if len(self.game_log) > 500:
                del self.game_log[:-500]
        try:
            self._log_path.parent.mkdir(parents=True, exist_ok=True)
            with self._log_path.open("a", encoding="utf-8") as fh:
                fh.write(json.dumps(entry, ensure_ascii=False) + "\n")
        except Exception:  # noqa: BLE001
            pass
        return {"ok": True}

    def read_game_log(self, since: float = 0.0, limit: int = 200) -> dict[str, Any]:
        with self._lock:
            rows = [e for e in self.game_log if e.get("t", 0) > since]
        return {"ok": True, "count": len(rows), "entries": rows[-limit:]}

    def clear_game_log(self) -> dict[str, Any]:
        with self._lock:
            self.game_log.clear()
        return {"ok": True}

    # ---------- 元信息 ----------

    def health(self) -> dict[str, Any]:
        # provider 必须报**当前生效的**来源：以前写死 local:<config 里的模型>，
        # 切到云端后这一行就是假的，排查时会把人带偏。
        active = f"{self.settings.provider}:{self.settings.model}"
        return {
            "ok": True,
            "name": "deadlock-tongyi bridge",
            "version": BRIDGE_VERSION,
            "provider": active,
            "providers": [active, "openai-compatible"],
            "fallbackProviders": [],
            "chatLog": {"enabled": False, "dir": "logs/chat"},
            "stats": dict(self.stats),
            "model": self.settings.model,
            "providerLabel": provider_label(self.settings.provider),
            "keySet": is_key_set(self.settings),
            # 健康检查必须立即返回；显存信息在读取设置时单独探测。
            "backend": {},
            "glossary": {"terms": len(self.glossary.terms),
                         "phrases": len(self.glossary.phrases),
                         "slang": len(self.glossary.slang)},
        }

    def game_names(self) -> dict[str, Any]:
        """英雄/物品名表，供 mod 做"名称保护"（名字不翻译）。"""
        data = _load_game_names()
        if not data:
            data = {en: item["zh"] for en, item in self.glossary.terms.items()
                    if item.get("cat") in ("hero", "item")}
        return {"ok": True, "count": len(data), "names": data}

    def config_view(self) -> dict[str, Any]:
        """给 mod 设置面板看的配置（只读展示；不含任何密钥）。"""
        return {
            "ok": True,
            "config": {
                "provider": self.settings.provider,
                "providerLabel": provider_label(self.settings.provider),
                "defaults": {"targetLanguage": "zh-Hans", "displayMode": "bilingual"},
                "sourceLanguage": "auto",          # 桥按文本自动判断（游戏侧也会传）
                "localModel": self.cfg.translate.model,
                "model": self.settings.model,
                "baseUrl": self.settings.base_url,
                "dictionary": {"enabled": True,
                               "phraseCount": len(self.glossary.phrases)},
                "bridge": {"engine": "python", "version": BRIDGE_VERSION},
            },
        }

    # ---------- 内部 ----------

    def _run_async(self, coro):
        if self._loop is None:
            self.start_loop()
        return asyncio.run_coroutine_threadsafe(coro, self._loop).result(120)

    @staticmethod
    def _detected(direction: str, src_lang: str = "") -> str:
        """回包里的 detectedLanguage。

        以前这里是"按方向猜"（en->zh 一律报 en），俄语消息会被报成英文 ——
        面板上的"检测语言"是假的，排查时会把人带偏。现在优先用真检测结果。
        """
        if src_lang in ("zh", "en", "ru", "el"):
            return src_lang
        return "en" if direction == "en->zh" else "zh"

    @staticmethod
    def _detect_language(text: str) -> str:
        """按字面判断源语言，给提示词和方向用。

        返回 "zh" / "ru" / "el" / "en"。判断顺序很重要：中文优先（汉字最独特），
        其次是西里尔/希腊字母，剩下的当英文。
        """
        if CJK_RE.search(text):
            return "zh"
        if CYRILLIC_RE.search(text):
            return "ru"
        if GREEK_RE.search(text):
            return "el"
        return "en"

    @staticmethod
    def _direction(text: str, source: str, target: str) -> str | None:
        """(文本, 源语言, 目标语言) -> 内部方向；None 表示不需要翻译。"""
        tgt = (target or "zh-Hans").lower()
        want_zh = tgt.startswith("zh")
        src = (source or "auto").lower()
        if src.startswith("zh"):
            return None if want_zh else "zh->en"
        if src.startswith("en"):
            return "en->zh" if want_zh else None
        # 俄语/希腊语：目标不是中文时没有对应的提示词，直接原样返回（不硬翻）
        if src.startswith(("ru", "el")):
            return "en->zh" if want_zh else None
        # auto：按文本自己判断（汉字最独特，其次西里尔/希腊，剩下当英文）
        if src == "auto":
            detected = BridgeApp._detect_language(text)
            if detected == "zh":
                return None if want_zh else "zh->en"
            if detected in ("ru", "el"):
                return "en->zh" if want_zh else None
        return "en->zh" if want_zh else None


def _load_game_names() -> dict[str, str]:
    path = paths.data_dir() / "gamenames.json"
    if not path.exists():
        return {}
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception:  # noqa: BLE001
        return {}


# ---------------------------------------------------------------------------
# 隐藏 HTML 面板页面：同源 fetch 本桥 API，结果写进 document.title
# （Panorama 侧轮询 panel.title，按 "LCT<id>" 前缀匹配响应）
# ---------------------------------------------------------------------------

# ---------------------------------------------------------------------------
# 极简探针页：只有一个标题，不做任何 fetch
# 用途：游戏里的隐藏 HTML 面板先加载这个页面。
#   · 能读回标题  -> 面板导航 + panel.title 读回都是通的，问题在 /bridge 页面的 fetch
#   · 读不回标题  -> 面板导航本身就不工作（URL 被拦 / 面板不是真的 HTML 面板）
# ---------------------------------------------------------------------------

def ping_page(params: dict[str, list[str]]) -> str:
    raw = (params.get("m") or ["DLPING"])[0]
    marker = re.sub(r"[^A-Za-z0-9_\-]", "", raw)[:32] or "DLPING"
    return ("<!DOCTYPE html><html><head><meta charset=\"utf-8\">"
            f"<title>{marker}</title></head><body>{marker}"
            f"<script>document.title='{marker}';</script></body></html>")


ALLOWED_OPS = {"translate", "test", "health", "config", "gamenames", "log",
               "settings", "settings/test", "models"}


def bridge_page(params: dict[str, list[str]]) -> str:
    def one(key: str, default: str = "") -> str:
        values = params.get(key) or []
        return values[0] if values else default

    req_id = json.dumps(one("id", "x"))
    # 注意：op 里可能有斜杠（settings/test），白名单要跟着放行，
    # 否则会被降级成 translate —— 表现就是设置页"读取失败：bad_json"。
    raw_op = re.sub(r"[^a-z/]", "", one("op", "translate")).strip("/")
    op = raw_op if raw_op in ALLOWED_OPS else "translate"   # 白名单，别把参数直接拼进 JS
    script = f"""
(function () {{
  var id = {req_id};
  var q = new URLSearchParams(location.search);
  var op = '{op}';
  var done = false;
  // 标题通道必须**纯 ASCII**：Panorama 的 panel.title 对非 ASCII 的处理没有保证，
  // 中文一旦在路上被转成 '?'，游戏里就会看到一堆问号。JSON.stringify 不会转义非 ASCII，
  // 所以这里自己把所有 >0x7f 的字符转成 \\uXXXX（JSON.parse 会还原）。
  function asciiJson(value) {{
    return JSON.stringify(value).replace(/[\\u007f-\\uffff]/g, function (c) {{
      return '\\\\u' + ('000' + c.charCodeAt(0).toString(16)).slice(-4);
    }});
  }}
  function out(payload) {{
    var s = 'LCT' + id + asciiJson(payload);
    // 长度硬门禁：标题太长会被引擎截断，前端只能解析出半截 JSON，
    // 表现成"面板上莫名其妙一片 undefined"。宁可明确报错，也不要静默残包。
    if (s.length > 900) {{
      s = 'LCT' + id + asciiJson({{ok: false, error: 'payload_too_long',
                                   len: s.length}});
    }}
    try {{ document.title = s; }} catch (e) {{}}
  }}
  try {{ document.title = 'lct-alive'; }} catch (e) {{}}
  var timeoutMs = Math.max(Number(q.get('timeoutMs')) || 8000, 8000);
  setTimeout(function () {{ if (!done) {{ done = true; out({{ok:false, error:'bridge_timeout'}}); }} }}, timeoutMs);
  var req = {{
    operation: op,
    text: q.get('text') || '',
    sourceLanguage: q.get('source') || 'auto',
    targetLanguage: q.get('target') || 'zh-Hans',
    timeoutMs: Number(q.get('timeoutMs')) || undefined
  }};
  var d = q.get('d');
  if (d) {{ try {{ req = JSON.parse(d); }} catch (e) {{}} }}
  var opts = {{ method: 'POST', headers: {{ 'Content-Type': 'application/json' }},
               body: JSON.stringify(req) }};
  if (op === 'health' || op === 'gamenames') {{ opts = {{ method: 'GET' }}; }}
  fetch('/api/v1/' + op, opts)
    .then(function (r) {{ return r.json(); }})
    .then(function (j) {{ if (done) return; done = true; out(j); }})
    .catch(function (e) {{ if (done) return; done = true; out({{ok:false, error:String(e)}}); }});
}})();
"""
    return ("<!DOCTYPE html><html><head><meta charset=\"utf-8\">"
            "<title>lct-bridge</title></head><body>"
            f"<script>{script}</script></body></html>")


# ---------------------------------------------------------------------------
# HTTP 层
# ---------------------------------------------------------------------------

class _Handler(BaseHTTPRequestHandler):
    app: BridgeApp                      # 由 BridgeServer 注入
    image_ipc: ImageIPC
    server_version = "dlchat-bridge/" + BRIDGE_VERSION

    # 访问日志：游戏里的隐藏 HTML 面板到底有没有来访问过桥？
    # 这个问题靠游戏内 UI 看不出来（面板加载失败时游戏侧一无所知），
    # 但桥这边只要收到过请求就有铁证。UA 还能告诉我们用的是哪个 webview。
    def _access_log(self, note: str = "") -> None:
        try:
            path = self.path[:220]
            ua = (self.headers.get("User-Agent") or "")[:80]
            host = (self.headers.get("Host") or "")[:40]
            line = (f"{time.strftime('%H:%M:%S')} {self.command} {path} "
                    f"host={host} ua={ua} {note}\n")
            log_path = self.app.access_log_path
            log_path.parent.mkdir(parents=True, exist_ok=True)
            with log_path.open("a", encoding="utf-8") as fh:
                fh.write(line)
        except Exception:  # noqa: BLE001
            pass

    # 静音默认的 stderr 访问日志
    def log_message(self, fmt: str, *args: Any) -> None:  # noqa: A003
        # parse_request may reject an HTTP version before assigning self.path.
        # Its default error logger still includes the original query string.
        words = getattr(self, "requestline", "").split()
        target = getattr(self, "path", "") or (words[1] if len(words) > 1 else "")
        if "/ipc/" in target.split("?", 1)[0]:
            return
        logger.debug("bridge: " + fmt, *args)

    # ---- 工具 ----

    def _send(self, status: int, body: bytes, ctype: str) -> None:
        self.send_response(status)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        try:
            self.wfile.write(body)
        except Exception:  # noqa: BLE001
            pass

    def _json(self, obj: Any, status: int = 200) -> None:
        self._send(status, json.dumps(obj, ensure_ascii=False).encode("utf-8"),
                   "application/json; charset=utf-8")

    def _read_body(self) -> Any:
        length = int(self.headers.get("Content-Length") or 0)
        if length <= 0:
            return None
        if length > MAX_BODY:
            return None
        raw = self.rfile.read(length)
        try:
            return json.loads(raw.decode("utf-8"))
        except Exception:  # noqa: BLE001
            return None

    @staticmethod
    def _body_from_query(query: dict[str, list[str]], body: Any, path: str) -> Any:
        """GET 兼容：游戏侧 $.AsyncWebRequest 只能发 GET，请求体走 ?d=<JSON>。"""
        if body:
            return body
        if query.get("d"):
            try:
                return json.loads(query["d"][0])
            except Exception:  # noqa: BLE001
                return None
        if path.endswith("/translate"):
            return {
                "text": (query.get("text") or [""])[0],
                "sourceLanguage": (query.get("source") or ["auto"])[0],
                "targetLanguage": (query.get("target") or ["zh-Hans"])[0],
            }
        if "/settings" in path:
            # 设置页/面板靠 ?d= 传参；没有 d 就当"读取"
            return None
        return None

    # ---- 路由 ----

    def do_GET(self) -> None:  # noqa: N802
        parsed = urlparse(self.path)
        if parsed.path.startswith("/ipc/"):
            self._image_request(parsed.path, parsed.query)
            return
        query = parse_qs(parsed.query)
        self._access_log()
        if parsed.path == "/bridge":
            html = bridge_page(query).encode("utf-8")
            self._send(200, html, "text/html; charset=utf-8")
            return
        if parsed.path == "/ping":
            self._send(200, ping_page(query).encode("utf-8"),
                       "text/html; charset=utf-8")
            return
        if parsed.path in ("/settings", "/settings/"):
            self._send(200, SETTINGS_PAGE.encode("utf-8"),
                       "text/html; charset=utf-8")
            return
        self._dispatch(parsed.path, query, None)

    def do_POST(self) -> None:  # noqa: N802
        parsed = urlparse(self.path)
        if parsed.path.startswith("/ipc/"):
            self._json({"ok": False, "error": "ipc_get_required"}, 405)
            return
        query = parse_qs(parsed.query)
        self._access_log()
        self._dispatch(parsed.path, query, self._read_body())

    def _image_request(self, path: str, raw_query: str) -> None:
        # These URLs may contain chat text or settings. Do not send them through
        # either access logger, including on malformed requests.
        try:
            if len(raw_query) > MAX_BODY - 1024:
                raise IPCError(400, "ipc_query_too_large")
            query = parse_qs(raw_query, keep_blank_values=True, max_num_fields=8,
                             errors="strict")

            def one(key: str) -> str:
                values = query.get(key) or []
                if len(values) != 1 or not values[0]:
                    raise IPCError(400, "ipc_bad_query")
                return values[0]

            if path == "/ipc/probe.png":
                self._send(200, png_bytes(17, 29), "image/png")
                return
            if path not in ("/ipc/start.png", "/ipc/read.png"):
                raise IPCError(404, "ipc_not_found")
            request_id = one("id")
            validate_id(request_id)
            if path == "/ipc/start.png":
                op = one("op")
                if op not in ALLOWED_OPS:
                    raise IPCError(400, "ipc_bad_op")

                def reject_constant(value: str) -> None:
                    raise ValueError("Non-finite JSON number")

                try:
                    payload = json.loads(one("d"), parse_constant=reject_constant)
                except (ValueError, RecursionError):
                    raise IPCError(400, "ipc_bad_json") from None
                if not isinstance(payload, dict):
                    raise IPCError(400, "ipc_bad_json")
                self.image_ipc.start(request_id, op, payload)
                self._send(200, png_bytes(1, 1), "image/png")
                return
            part_text = one("part")
            if not part_text.isascii() or not part_text.isdecimal() or len(part_text) > 5:
                raise IPCError(400, "ipc_bad_part")
            part = int(part_text)
            if part >= MAX_PARTS:
                raise IPCError(400, "ipc_bad_part")
            # The cache-busting nonce does not select or execute a job.
            if "nonce" in query:
                validate_id(one("nonce"))
            first, second = self.image_ipc.read_pair(request_id, part)
            self._send(200, png_bytes(first + 1, second + 1), "image/png")
        except IPCError as error:
            self._json({"ok": False, "error": error.error}, error.status)
        except (ValueError, UnicodeError):
            self._json({"ok": False, "error": "ipc_bad_query"}, 400)

    def _dispatch(self, path: str, query: dict[str, list[str]], body: Any) -> None:
        result, status = _api_result(self.app, path, query, body)
        self._json(result, status)


def _api_result(app: BridgeApp, path: str, query: dict[str, list[str]], body: Any) -> tuple[Any, int]:
    """Execute the same API operation for JSON HTTP and asynchronous image jobs."""
    try:
        if path == "/api/v1/health":
            return app.health(), 200
        if path == "/api/v1/gamenames":
            return app.game_names(), 200
        if path == "/api/v1/config":
            return app.config_view(), 200
        if path in ("/api/v1/translate", "/api/v1/test"):
            payload = _Handler._body_from_query(query, body, path)
            if path.endswith("/test"):
                return app.test(), 200
            if not payload or not str(payload.get("text", "")).strip():
                return {"ok": False, "error": "bad_json"}, 400
            result = app.translate(
                str(payload.get("text", "")),
                str(payload.get("sourceLanguage") or "auto"),
                str(payload.get("targetLanguage") or "zh-Hans"),
            )
            return result, 200 if result.get("ok") else 502
        if path == "/api/v1/settings":
            payload = _Handler._body_from_query(query, body, path) or {}
            if not payload or payload.get("view"):
                return app.settings_view(compact=payload.get("view") == "compact"), 200
            return app.update_settings(payload), 200
        if path == "/api/v1/settings/test":
            payload = _Handler._body_from_query(query, body, path) or {}
            return app.settings_test(str(payload.get("text") or "he is low, dive him")), 200
        if path == "/api/v1/models":
            payload = _Handler._body_from_query(query, body, path) or {}
            raw = payload.get("provider") or payload.get("prv") or payload.get("pv")
            return app.list_models(decode_provider(raw)), 200
        if path == "/api/v1/log":
            payload = _Handler._body_from_query(query, body, path)
            if payload and (payload.get("msg") or payload.get("op")):
                if payload.get("op") == "read":
                    return app.read_game_log(float(payload.get("since") or 0),
                                             int(payload.get("limit") or 200)), 200
                if payload.get("op") == "clear":
                    return app.clear_game_log(), 200
                return app.record_game_log(payload), 200
            return app.read_game_log(
                float((query.get("since") or [0])[0] or 0),
                int((query.get("limit") or [200])[0] or 200)), 200
        return {"ok": False, "error": "not_found"}, 404
    except Exception as error:  # Exception messages can contain request secrets.
        logger.error("桥内部错误（%s）", type(error).__name__)
        return {"ok": False, "error": "internal_error"}, 500


class _V6Server(ThreadingHTTPServer):
    address_family = socket.AF_INET6


class BridgeServer:
    """同时绑 127.0.0.1 和 ::1 的本地桥（游戏用 localhost，可能解析到 IPv6）。"""

    def __init__(self, app: BridgeApp, port: int = DEFAULT_PORT):
        self.app = app
        self.port = port
        self.image_ipc = ImageIPC(lambda op, payload: _api_result(
            self.app, "/api/v1/" + op, {}, payload)[0])
        self._servers: list[ThreadingHTTPServer] = []
        self._threads: list[threading.Thread] = []

    def start(self) -> int:
        handler = type("_BoundHandler", (_Handler,), {"app": self.app,
                                                    "image_ipc": self.image_ipc})
        for cls, host in ((ThreadingHTTPServer, "127.0.0.1"), (_V6Server, "::1")):
            try:
                srv = cls((host, self.port), handler)
            except OSError as e:
                logger.warning("绑定 %s:%d 失败（忽略）: %s", host, self.port, e)
                continue
            t = threading.Thread(target=srv.serve_forever, daemon=True,
                                 name=f"bridge-{host}")
            t.start()
            self._servers.append(srv)
            self._threads.append(t)
            logger.info("翻译桥监听 http://%s:%d", host, self.port)
        if not self._servers:
            raise RuntimeError(f"端口 {self.port} 无法绑定（可能已有实例在运行）")
        return self.port

    @property
    def running(self) -> bool:
        return bool(self._servers)

    def stop(self) -> None:
        for srv in self._servers:
            try:
                srv.shutdown()
                srv.server_close()
            except Exception:  # noqa: BLE001
                pass
        self._servers.clear()
        self._threads.clear()
