# 通译（Tongyi）mod：编译与安装

我们自己的 Deadlock 聊天翻译 mod（不依赖 BabelTower）。这份文档记录的是**实测踩出来的**
工具链事实——这些结论花了不少时间才确认，改动构建链前先读一遍，能省掉重复试错。

## 一、结论先行

| 事项 | 结论 |
|------|------|
| 编译器 | 必须用 **CSDK 12** 的 `game\bin_cs2\win64\resourcecompiler.exe` |
| 工程目录形状 | 输入路径必须是 `<CSDK>\content\citadel_addons\<addon>\panorama\...` |
| 输出 | 必须显式 `-o`，产物扩展名规范化为 `.vxml_c / .vjs_c / .vcss_c` |
| 安装 | 编译产物打成 VPK，替换 `Deadlock\game\citadel\addons\pak01_dir.vpk`（仅 `--install`） |
| 游戏内通信 | 隐藏 `<HTML>` 面板 + `document.title` 轮询（`localhost`，串行单槽） |

## 二、为什么不能直接用 CS2 / Deadlock 自带的 resourcecompiler

三个坑，逐个排掉的：

1. **CS2 零售版的 `resourcecompiler.exe` 只认自己安装目录内的东西。**
   工程放在 `C:\...` 时它报 `stage\game\core\pak01.vpk Failed to load file (missing)`——
   文件明明存在。把同样的工程挪进 CS2 安装目录（`<CS2>\content\citadel_addons\...` +
   `<CS2>\game\citadel\...`）后，pak 立刻挂载成功。也就是说它的 FileSystem 有个
   **安装根目录 sandbox**。
2. **过了 sandbox 之后缺 Workshop Tools 的模块。** CS2 零售版 `bin\win64` 里没有
   `modtools.dll`，报 `CAppSystemDict:Unable to load module modtools (Dependency of
   application), error 126`。社区所谓的 "Reduced CSDK 12" 就是把 CS2 Workshop Tools
   与 Deadlock 的修正合并出来的工具集，正是缺这一块。
3. **Deadlock 自己带的 `resourcecompiler.dll`（54 MB）配 CS2 的壳能跑，但缺
   `modeldoc_utils.dll`。** 从 CS2 目录借这个 DLL 会报 `error 127`（导出符号对不上，
   两边 engine DLL 版本不一致），此路不通。

所以：`python scripts/fetch_csdk.py --download`（约 2.4 GiB，解到 `D:\csdk12`）。
注意 CSDK 官方文档提醒**不要放在 OneDrive 同步目录**（桌面/文档）里，会出权限问题。

### CSDK 里四套二进制，只有 `bin_cs2` 能用

`bin` / `bin_tools` / `bin_server` 的 `particles.dll` 与 `resourcecompiler.dll` 的
schema 对不上，编译直接中止：

```
ParticleFloatType_t
    Mismatch - Member Count
    Module 1 - resourcecompiler.dll:particleslib
    Module 2 - particles.dll:particleslib
ERROR: Schema mismatches reported! Aborting to prevent data corruption.
```

`bin_cs2`（文档里说"只用于 GUIMapCompiler"）反而是自洽的那一套：

```
OK: 1 compiled, 0 failed, 0 skipped, 0m:01s
```

### resourcecompiler 的两个"路径即配置"行为

- **mod 名与 game 根目录来自输入路径**：`<root>\content\citadel_addons\<addon>\panorama\x.js`
  → mod=`<addon>`，game root=`<root>\game`。路径不对就报
  `Unable to determine mod from file "..."`。
- **`-game <目录>`** 指定 gameinfo 所在目录（帮助文本写的是 "path to a gameinfo.gi file"，
  实际给目录，给文件会报 `Can't find 'gameinfo.gi\gameinfo.gi'`）。

## 三、构建流程（`scripts/stage_compile.py`）

```
mod/panorama/{layout,scripts,styles}         我们的源码
        │  同步到 <CSDK>\content\citadel_addons\dlchat\panorama
        ▼
bin_cs2\win64\resourcecompiler.exe -i <源文件> -o <CSDK>\game\citadel_addons\dlchat\panorama\*.{vxml_c,vjs_c,vcss_c}
        │
        ▼
build\tongyi-pak01_dir.vpk                   我们自己写的 VPK 打包器（与引擎产物逐字节同构）
        │
        ▼
Deadlock\game\citadel\addons\pak01_dir.vpk   安装（只有 --install 才走这一步，旧文件备份成 .bak）
```

```bat
python scripts\stage_compile.py --pack            :: 只编译+打包（本机走这条）
python scripts\stage_compile.py --install         :: 编译+打包+直接装进 addons
```

> 本机约定走 **DMM 导入**（见 [mod-usage.md](mod-usage.md)），所以日常只用 `--pack`，
> 拿到 `build\tongyi-pak01_dir.vpk` 后在 DMM 里重新导入。
> `--install` 是"手动管 addons"那条路，两条路别同时用。

> **为什么只产出一份 VPK**：以前为了对齐 DMM 的"选文件夹导入"流程，同一个包会写两份
> （`dist_mod\` 一份、`dist_mod\dlchat_local\` 一份）。两份一旦分叉，表现是
> "我改了但游戏里没变化、而且不报错"——实测踩过。现在 DMM 直接选这个文件，不需要第二份。
>
> **产物统一在 `build/`**：交付物（zip / vpk / 启动器）放顶层，中间产物放 `build\.work\`。
> 根目录不再出现 `dist*/build_*` 之类的目录，磁盘紧张时 `rm -rf build` 即可。

> 装的时候 Deadlock 必须完全退出：引擎会锁住 `addons\pak01_dir.vpk`，
> 占用时报 `PermissionError: [WinError 32] 另一个程序正在使用此文件`。
>
> Deadlock Mod Manager 也把它的 mod 装在这个位置（`.dmm.json` 记录启用列表）。
> 我们的 VPK 会顶掉当前那个 `pak01_dir.vpk`，所以要么在 DMM 里停用 BabelTower，
> 要么就别在 DMM 里再点应用——否则它会把文件合并回去。

## 三·五、最容易踩的静默失败：VPK 内路径必须带 `panorama/` 前缀

VPK 的根是 **addon 目录**（`game/citadel_addons/<addon>/`），不是里面的 `panorama/`：

```
正确:  panorama/layout/chat.vxml_c        <- 游戏按这个路径去覆盖原版
错误:  layout/chat.vxml_c                 <- 游戏根本不会去这儿找
```

搞错前缀的后果是**完全静默**：游戏正常启动、聊天照常工作、不报任何错、
桥的日志一条都没有 —— 看起来就像"mod 没做对"，其实只是没被加载。
第一版就是这么翻车的（包内 4 个文件全少了一层 `panorama/`）。

`stage_compile.pack()` 现在用 `REQUIRED_PATHS` 兜底：缺任何一个关键资源就直接中止，
不让这种包出门。对照基准是 BabelTower 的包（它是能用的），路径形状完全一致。

另外，加了个"布局是否真的生效"的探针：`#DLChatStatus` 的初值写死成 `dlchat`。
布局一旦加载，输入框旁就会出现这个字样（哪怕脚本挂了）；
布局没生效则什么都不会出现。省得再靠猜。

## 四、游戏内运行时（Panorama）的三个硬约束1. **`$.AsyncWebRequest` 已被移除**——函数还在，但一调用就同步抛
   `AsyncWebRequest has been removed`。只用 `typeof` 检查会误判成"可用"。
2. **运行时 `$.CreatePanel("HTML", ...)` 拿不到可用的 HTML 面板**，必须在布局 XML 里
   用 `<HTML id="..." />` 声明，再用 `FindChildTraverse` 找。
3. **HTML 面板的 URL 必须用 `localhost`，不能用 `127.0.0.1`**（对回环 IP 有拦截）。
   桥因此必须同时绑 `127.0.0.1` 和 `::1`（`BridgeServer` 已经这么做了）。

通信协议：`SetURL` 打开 `http://localhost:8791/bridge?id=<id>&op=<op>&d=<JSON>`，
页面 fetch 桥 API，把结果写进 `document.title`，Panorama 轮询 `panel.title`。
因为是单槽通道，**同一时刻只能有一个在途请求**——我们的传输层是串行队列，
用递增的唯一 id 前缀匹配响应，迟到的旧响应直接丢弃。

### 编码坑（实测）

`document.title` 对非 ASCII 的处理没有保证，中文可能在路上变成 `?`。桥页面里所有响应
都先做 `\uXXXX` 转义（`asciiJson`），标题通道全程纯 ASCII。

另一个坑出在**测试脚本**上：PowerShell 的 `Invoke-RestMethod -Body '<含中文的JSON>'`
会把中文编坏，桥收到乱码后模型会回一句 `wtf`——一度以为是翻译链路坏了。
所以自检脚本一律**显式 UTF-8**（`scripts/bridge_selftest.py` 里
`sys.stdout.reconfigure(encoding="utf-8")` 那一行就是为这个加的）。

## 五、联调工具

| 工具 | 用途 |
|------|------|
| `node scripts\js_check.js` | **改 JS 之后先跑这个**：离线测试台，13 个分节（识别层/挂载点/双语行内/占位/失败提示/回收复用/入口点…），不需要开游戏 |
| `python scripts\bridge_selftest.py` | 桥的协议自检（op 白名单、compact 长度门禁、设置读写、试翻），**需要桥已经在跑**。它会临时改设置（含"恢复默认"）再还原 —— 现在会先整文件备份 `settings.json` 并在 `finally` 里放回，所以不会再吃你的 API Key；但**跑之前仍建议确认桥是通的**（跑挂了也能还原） |
| `python scripts/mod_log.py` | 读游戏侧推到桥上的诊断日志（boot/翻译/失败） |
| `python scripts/probe_backend.py` | 四种请求形态问模型，排查后端 |
| `python scripts/probe_pipeline.py` | 逐层排查 BridgeApp → ChatTranslator → 模型 |
| `python scripts/extract_vpk.py` | 从游戏 pak 里按路径提取文件 |
| `python scripts/red2.py` | 解析/导出 `*_c` 的块结构（RED2/DATA/LaCo…） |
| `tools\vrf\Source2Viewer-CLI.exe -i x.vxml_c -d` | 把编译后的布局反解回 XML |

`mod/panorama/layout/*.xml` 的基线就是从游戏自身的 `chat.vxml_c` /
`citadel_hud_top_bar_chat.vxml_c` 反解出来的，改动处都标了 `[dlchat]`。
Valve 更新 UI 后重新反解一次照着抄即可。

### 2026-09-30 布局基线（Build 25614556）

`tests/fixtures/game_build_25614556/` 保存从本机官方 VPK 反解的两份布局。
`python scripts/check_mod_layouts.py` 对比官方模板、面板骨架和样式引用；
`stage_compile.py` 已把这项检查接入编译前门禁。它是离线版本契约，不会自动判断后续游戏更新。

本次新增 `TargetHeroImage`、`MessageWrapper`、Ping/冷却信息和
`TypingIndicatorChatMessage` 模板，必须保留节点类型、层级与属性；缺少节点或模板会直接
触发游戏 FATAL ERROR。不能只在根节点补同名空面板。后续更新应先反解官方布局、核对差异，
再更新源码与测试基线，并验证重新编译的 VPK，而不是仅放宽校验。

运行逻辑按 `MessageType_AbilityPing/MapPing/PingWheel/ItemDraftReaction` 跳过系统消息，
输入中动画没有正文，气泡只读取 `MessageText`。图标和冷却节点也存在于普通聊天模板中，
不能用这些节点是否存在来判断消息类型。

## 六、诊断日志开关（`DEBUG`）

`mod/panorama/scripts/dlchat.js` 顶部有 `var DEBUG = false;`。

**默认关**，这不是疏忽：游戏侧没法直接看 console，只能把日志 POST 到桥
（`python scripts\mod_log.py` 读），而**每一条日志都是一次串行往返** ——
通道是单槽的（一次页面导航 + title 轮询），一次成功翻译产生 2 条日志，
3 条消息就是 6 次额外导航，等于通道开销翻倍。

排查问题（"为什么这句没翻"）时：

1. 把 `DEBUG` 改成 `true`
2. `node scripts\js_check.js` 过一遍（确认没写坏）
3. `python scripts\stage_compile.py --pack` → DMM 重新导入
4. 复现问题 → `python scripts\mod_log.py` 看 `in:` / `out:` / `failed:` 行
5. **改回 `false` 再编译一次**（别把调试包留给日常玩）
