# -*- mode: python ; coding: utf-8 -*-
"""PyInstaller 打包配置：产出**桥 + 启动器**，供玩家包和 Steam 启动选项使用。

产出（路径由命令行决定，统一约定见下）：
  build/.work/bridge/tongyi-launch.exe      无窗口。给 Steam 启动选项用：
                                            先起翻译桥，再启动游戏，游戏退出后自己结束
                                            （桥在同一个进程里，所以不会留残留进程）。
  build/.work/bridge/tongyi-launch-cli.exe  控制台版，排查时能看到输出。
  这两个 exe 随后会被 packaging/package_player_zip.bat 连同 mod 打进
  build/tongyi-players.zip —— **那才是唯一交付物**。

统一约定（别再往项目根目录写产物）：中间产物全在 build/.work/ 下，
交付物全在 build/ 顶层。所以打包命令是：

  python -m PyInstaller --clean --noconfirm --distpath build/.work --workpath build/.work/pyinstaller packaging/bridge.spec

依赖只有 openai / pydantic / PyYAML（见 pyproject.toml），所以包体很小。
这里曾经和 packaging/deadlock-tongyi.spec（桌面版）并列存在，那个 spec 连同
桌面版代码一起在 2026-09-20 删除 —— 它要收集 PySide6 + onnxruntime，
产物 250~400MB，而现役链路一个字都用不到。
"""

from pathlib import Path

from PyInstaller.utils.hooks import collect_data_files

SPEC_DIR = Path(SPECPATH).resolve()               # noqa: F821 - PyInstaller 注入
ROOT = SPEC_DIR.parent

datas = []
hiddenimports = []

# 只收运行时读取的数据，避免把本机 benchmark 结果等临时文件带进玩家包。
runtime_data = (
    "glossary.json", "phrases.json", "phrases_zh.json", "slang.json",
    "keep_as_is.json", "deadlock_zh2en.json", "zh_term_blocklist.json",
    "en_term_blocklist.json", "gamenames.json",
)
datas += [(str(ROOT / "data" / name), "data") for name in runtime_data]
datas += [(str(ROOT / "config.yaml"), ".")]
datas += [(str(ROOT / "README.md"), ".")]

hiddenimports += ["yaml", "pydantic", "openai", "httpx", "httpcore", "anyio"]
# 本地地址要直连（绕过系统代理），httpx 的 SSL/代理实现得被收集进来
datas += collect_data_files("certifi")

# 排除项是**载荷性**的，不是"保险"：现役依赖只有 openai/pydantic/PyYAML，
# 但 PyInstaller 会在**装了什么就收什么**的环境里跑（本机全局 Python 里还留着
# 桌面版那套），实测不排干净包体会从 58MB 涨到 102MB —— numpy 20MB(data)+5.8MB、
# PIL 12.7MB、cryptography 9.4MB、_sounddevice_data 0.6MB 全是这么进来的。
excludes = [
    "torch", "torchaudio", "torchvision", "funasr", "modelscope",
    "faster_whisper", "ctranslate2", "sounddevice", "edge_tts",
    "matplotlib", "scipy", "pandas", "sklearn", "notebook", "IPython", "tkinter",
    "PyQt5", "PyQt6", "PySide2", "PySide6", "shiboken6",
    "rapidocr", "onnxruntime", "dxcam", "mss", "PIL", "numpy",
    "keyboard", "pyperclip", "win32gui", "win32api", "win32clipboard",
    # cryptography 9.4MB：pip show 显示 **Required-by 为空**，dlchat 里没有一处 import，
    # 是某个包的 optional 依赖被 PyInstaller 的 hook 顺手收进来的。
    # TLS 走标准库 ssl + 包里的 libssl/libcrypto，跟它无关（已用真实 HTTPS 请求验证）。
    "cryptography",
    "tests", "scripts",
]

a = Analysis(                                     # noqa: F821
    [str(SPEC_DIR / "entry_launch.py")],
    pathex=[str(ROOT)],
    binaries=[],
    datas=datas,
    hiddenimports=hiddenimports,
    hookspath=[],
    runtime_hooks=[],
    excludes=excludes,
    noarchive=False,
)
pyz = PYZ(a.pure)                                 # noqa: F821

exe_gui = EXE(                                    # noqa: F821
    pyz, a.scripts, [],
    exclude_binaries=True,
    name="tongyi-launch",
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=False,                                    # UPX 压缩最容易招杀软误报
    console=False,                                # 无窗口：Steam 启动时不该弹黑框
    icon=str(SPEC_DIR / "icon.ico"),
)
exe_cli = EXE(                                    # noqa: F821
    pyz, a.scripts, [],
    exclude_binaries=True,
    name="tongyi-launch-cli",
    debug=False,
    strip=False,
    upx=False,
    console=True,                                 # 排查用，保留输出
    icon=str(SPEC_DIR / "icon.ico"),
)
coll = COLLECT(                                   # noqa: F821
    exe_gui, exe_cli,
    a.binaries, a.datas,
    strip=False,
    upx=False,
    name="bridge",
)
