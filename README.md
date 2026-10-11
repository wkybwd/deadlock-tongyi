# 通译｜Deadlock 聊天双向翻译

让英文聊天直接显示中文，也能把你输入的中文翻译成英文发出去。

## 功能

- **看懂聊天**：队友和对手发送的英文消息会在游戏聊天框中显示中文，可选择双语或只显示译文。
- **用中文回复**：输入中文后连按两下空格，输入框会变成中英对照内容，确认后按回车发送。
- **游戏内调整**：用 `/tongyi` 打开设置面板，调整收发开关、显示方式和翻译来源。

## 下载

从 [GitHub Releases](https://github.com/wkybwd/deadlock-tongyi/releases/latest) 下载最新版 `tongyi-players.zip`。这是 Windows 玩家安装包，包含翻译桥和游戏内 mod，**无需安装 Python**。

`v0.2.4` 修复 2026-10 游戏更新后一直显示「面板未加载」「当前界面暂未联通」的问题，改用本机图片通信，并保留 2026-09-30 新版聊天布局兼容修复。

**已有用户更新：**退出游戏，使用新版 ZIP 中的 `tongyi_launch` 启动器文件，并在 DMM 移除旧版通译、导入新版 VPK；翻译桥和模组必须一起更新。保留个人配置，已有 API Key 无需重填。若更换启动器目录，重新运行 `START_HERE.bat` 并粘贴 Steam 启动选项。源码构建说明见 [launcher.md](docs/launcher.md) 和 [mod-build.md](docs/mod-build.md)。

**推荐使用默认的 DeepSeek API。** 使用前需到 [DeepSeek 开放平台](https://platform.deepseek.com/)充值购买 API 调用额度，并创建自己的 **API Key（Token）**。安装包不包含 Key；API 调用[按用量计费](https://api-docs.deepseek.com/quick_start/pricing/)。

## 安装

1. 将 ZIP 解压到普通文件夹，避免放在 `Program Files`。
2. 双击 `tongyi_launch\START_HERE.bat`。脚本会把 Steam 启动选项复制到剪贴板；在 Steam 中打开「库 → Deadlock → 属性 → 启动选项」，按 `Ctrl+V` 粘贴。
3. 安装 [Deadlock Mod Manager（DMM）](https://deadlockmods.app/)。在 **My Mods → 添加本地 mod** 中选择解压后的 `mod\tongyi-pak01_dir.vpk` 文件，再到「我的模组」里启用通译。
4. 在 DMM 点击 **Launch Modded** 启动游戏，再在浏览器打开 [本机设置页](http://localhost:8791/settings)，粘贴你的 DeepSeek API Key 并保存。设置页只在游戏运行、翻译桥启动后可访问。

游戏大版本更新后，请使用适配新版的通译 VPK，并通过 DMM 重新应用加载配置。如果出现 `TargetHeroImage` 或 `TypingIndicatorChatMessage` 的 FATAL ERROR，说明仍加载了旧聊天布局；卸载旧版后还需检查 `addons` 中是否残留重复包，详见 [mod 排查说明](docs/mod-usage.md#排查)。

## 使用

- 进入游戏后，收到的英文聊天会自动显示译文。翻译桥会随游戏启动和退出。
- 在聊天框输入中文，**连按两下空格**触发翻译，确认输入框中的内容后按回车发送。
- 在聊天框输入 `/tongyi` 并回车，可打开游戏内设置面板。需要鼠标时按 `Tab`；修改设置后点击顶部的「保存更改」。
