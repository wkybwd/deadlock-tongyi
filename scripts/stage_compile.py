"""把 mod/panorama 源码编译成 Panorama 编译产物（*_c），并打包成可安装的 VPK。

工具链（实测结论，别再绕弯路）
---------------------------------------------------------------------------
Deadlock 零售版**不带**能在游戏里生效的 Panorama 编译器：

  · CS2 零售版自带的 resourcecompiler.exe 会拒绝挂载自身安装目录之外的 pak
    （file sandbox），把工程嵌进 CS2 目录后又缺 Workshop Tools 才有的 modtools.dll；
  · Deadlock 自己只带了 resourcecompiler.dll，没有 exe，且缺 modeldoc_utils.dll。

社区把 CS2 Workshop Tools 与 Deadlock 的修正合并成 **CSDK 12**，正是为这件事准备的。
本脚本用它的编译器，并只认 ``game\\bin_cs2\\win64`` 这一套：
另外三套（bin / bin_tools / bin_server）的 particles.dll 与 resourcecompiler.dll
schema 不一致，会在启动时报 "Schema mismatches reported! Aborting"。

resourcecompiler 的两个"路径即配置"的行为（踩过才知道）
---------------------------------------------------------------------------
  1. mod 名与 game 根目录都是从**输入文件路径**推断的，必须是
     ``<CSDK>\\content\\citadel_addons\\<addon>\\panorama\\...``
     这种形状，否则直接 "Unable to determine mod from file"；
  2. 输出路径必须显式给 ``-o``，且会被规范化成 .vxml_c / .vjs_c / .vcss_c。

用法：
    python scripts/stage_compile.py                # 编译
    python scripts/stage_compile.py --pack         # 编译 + 打包 VPK
    python scripts/stage_compile.py --pack --install   # 再装进游戏 addons 目录
"""

from __future__ import annotations

import argparse
import hashlib
import json
import shutil
import struct
import subprocess
import sys
import zlib
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
sys.stdout.reconfigure(encoding="utf-8", errors="replace")

ROOT = Path(__file__).resolve().parents[1]
MOD_SRC = ROOT / "mod" / "panorama"

# ---------------------------------------------------------------------------
# 产物布局：**所有东西都进 build/**，根目录不再散落产物
# ---------------------------------------------------------------------------
# 历史教训：这里曾经把产物写在 dist_mod/（两种脚本各写一份）、build_mod/、
# build_pkgs/、dist/… 根目录一度摆着 5 个产出目录、400 个文件，而真正的交付物
# 只有 1 个 zip。现在统一成：
#
#     build/
#     ├── tongyi-players.zip        ← 唯一交付物
#     ├── tongyi-launch.exe         ← 桥（Steam 启动选项 / 排查用）
#     ├── tongyi-pak01_dir.vpk      ← mod 包（DMM 导入这个 **文件**）
#     └── .work/…                   ← 中间产物，平时不用看
#
# 两个刻意的改动：
#   1. VPK 只写**一份**。以前为了对齐 DMM 的"选文件夹导入"流程，同一个包写
#      两份（dist_mod/ 和 dist_mod/dlchat_local/），两份一分叉就会出现"改完
#      游戏里没变化、还不报错"。现在 DMM 直接选这个文件，不需要第二份。
#   2. 中间产物带点前缀（`.work`），排在文件管理器里最下面，不会和交付物混在一起。
BUILD = ROOT / "build"
WORK = BUILD / ".work"
VPK_NAME = "tongyi-pak01_dir.vpk"

CSDK_ROOT = Path(r"D:\csdk12\Reduced_CSDK_12")
CSDK_COMPILER = CSDK_ROOT / "game" / "bin_cs2" / "win64" / "resourcecompiler.exe"

DEADLOCK = Path(r"D:\software\steam\steamapps\common\Deadlock")
GAME_ADDONS = DEADLOCK / "game" / "citadel" / "addons"

ADDON = "dlchat"
GAME = "citadel"

# 源码扩展名 -> 编译产物扩展名（resourcecompiler 自己也会规范化，这里保持一致）
COMPILED_EXT = {".js": ".vjs_c", ".css": ".vcss_c", ".xml": ".vxml_c"}

VPK_SIGNATURE = 0x55AA1234
ARCHIVE_INLINE = 0x7FFF

# 包里必须出现的资源（少了游戏会静默不生效，没有任何报错）
REQUIRED_PATHS = (
    "panorama/layout/chat.vxml_c",
    "panorama/layout/citadel_hud_top_bar_chat.vxml_c",
    "panorama/scripts/dlchat.vjs_c",
    "panorama/styles/dlchat.vcss_c",
    "panorama/styles/dlchat-ui.vcss_c",
)


# ---------------------------------------------------------------------------
# VPK 写入（已验证与引擎产物逐字节同构：单文件、数据内联、48 字节 MD5 段）
# ---------------------------------------------------------------------------

def write_vpk(files: dict[str, bytes], out_path: Path) -> Path:
    tree: dict[str, dict[str, dict[str, bytes]]] = {}
    for full, data in files.items():
        path = full.replace("\\", "/")
        if "." not in path.rsplit("/", 1)[-1]:
            raise ValueError(f"没有扩展名，VPK 无法索引: {full}")
        head, ext = path.rsplit(".", 1)
        directory, _, name = head.rpartition("/")
        tree.setdefault(ext, {}).setdefault(directory, {})[name] = data

    def cstr(s: str) -> bytes:
        return s.encode("utf-8") + b"\x00"

    tree_bytes = bytearray()
    data_bytes = bytearray()
    for ext in sorted(tree):
        tree_bytes += cstr(ext)
        for directory in sorted(tree[ext]):
            tree_bytes += cstr(directory)
            for name in sorted(tree[ext][directory]):
                payload = tree[ext][directory][name]
                tree_bytes += cstr(name)
                tree_bytes += struct.pack(
                    "<IHHIIH", zlib.crc32(payload) & 0xFFFFFFFF, 0,
                    ARCHIVE_INLINE, len(data_bytes), len(payload), 0xFFFF)
                data_bytes += payload
            tree_bytes += b"\x00"
        tree_bytes += b"\x00"
    tree_bytes += b"\x00"

    header = struct.pack("<IIIIIII", VPK_SIGNATURE, 2, len(tree_bytes),
                         len(data_bytes), 0, 48, 0)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_bytes(bytes(header) + bytes(tree_bytes) + bytes(data_bytes)
                         + b"\x00" * 48)
    return out_path


def read_vpk_index(path: Path) -> list[str]:
    data = path.read_bytes()
    _sig, ver, tree_size = struct.unpack_from("<III", data, 0)
    pos = 28 if ver == 2 else 12
    end = pos + tree_size
    out: list[str] = []

    def rs(p: int) -> tuple[str, int]:
        e = data.index(b"\x00", p)
        return data[p:e].decode("utf-8", "replace"), e + 1

    while pos < end:
        ext, pos = rs(pos)
        if ext == "":
            break
        while True:
            directory, pos = rs(pos)
            if directory == "":
                break
            while True:
                name, pos = rs(pos)
                if name == "":
                    break
                _crc, preload, _arch, _off, _len, _term = struct.unpack_from(
                    "<IHHIIH", data, pos)
                pos += 18 + preload
                out.append(f"{directory}/{name}.{ext}" if directory
                           else f"{name}.{ext}")
    return out


# ---------------------------------------------------------------------------
# 编译
# ---------------------------------------------------------------------------

def preflight(content_pano: Path) -> list[str]:
    """编译前的硬门禁：JS 语法 + XML 良构。

    血泪教训：一次脚本化重构把 exportGlobals 的收尾括号切掉了，包照样打出来、照样
    装进游戏，表现是"状态灯灰色、状态行停在初始文本、翻译完全不工作"——脚本整个
    没跑，但没有任何报错。所以语法检查必须在打包之前拦住。
    """
    problems: list[str] = []

    node = shutil.which("node")
    for js in sorted(content_pano.rglob("*.js")):
        if not node:
            problems.append(f"{js.name}: 找不到 node，无法做语法检查")
            continue
        proc = subprocess.run([node, "--check", str(js)],
                              capture_output=True, text=True, errors="replace")
        if proc.returncode != 0:
            detail = (proc.stderr or proc.stdout).strip().splitlines()
            problems.append(f"{js.name}: JS 语法错误 -> "
                            + " | ".join(detail[-4:])[:300])

    import xml.etree.ElementTree as ET
    for xml in sorted(content_pano.rglob("*.xml")):
        try:
            ET.parse(xml)
        except ET.ParseError as e:
            problems.append(f"{xml.name}: XML 不合法 -> {e}")

    # XML 良构不能保证引擎兼容：缺少官方节点/模板会让游戏直接退出。
    from scripts.check_mod_layouts import check_layouts
    problems.extend(check_layouts(content_pano / "layout"))

    # 离线跑一遍 mod 脚本：用桩替换 Panorama API，执行 boot + 每个按钮入口，
    # 并校验布局里的 onactivate 都能在脚本里找到。这类"游戏里静默失效"的问题
    # （少个字段就整块卡住、按钮点了没反应）必须在这里拦住。
    if node:
        for check in ("js_check.js", "image_ipc_check.js"):
            proc = subprocess.run([node, str(ROOT / "scripts" / check)],
                                  capture_output=True, text=True, errors="replace",
                                  cwd=str(ROOT))
            if proc.returncode != 0:
                problems.append(check + ": " + (proc.stdout or proc.stderr).strip()[:600])

    return problems


def compile_all() -> list[tuple[str, str, int, str]]:
    if not CSDK_COMPILER.exists():
        raise SystemExit(
            f"找不到 CSDK 编译器: {CSDK_COMPILER}\n"
            "先跑 python scripts/fetch_csdk.py --download 并把压缩包解到 D:\\csdk12")

    content_pano = CSDK_ROOT / "content" / f"{GAME}_addons" / ADDON / "panorama"
    game_pano = CSDK_ROOT / "game" / f"{GAME}_addons" / ADDON / "panorama"
    if content_pano.exists():
        shutil.rmtree(content_pano)
    if game_pano.exists():
        shutil.rmtree(game_pano)
    shutil.copytree(MOD_SRC, content_pano)

    problems = preflight(content_pano)
    if problems:
        raise SystemExit("[preflight] 源码有问题，拒绝打包：\n  - "
                         + "\n  - ".join(problems))

    sources = sorted(p for p in content_pano.rglob("*")
                     if p.is_file() and p.suffix.lower() in COMPILED_EXT)
    if not sources:
        raise SystemExit(f"mod/panorama 下没有可编译文件: {MOD_SRC}")

    results: list[tuple[str, str, int, str]] = []
    for src in sources:
        rel = src.relative_to(content_pano)
        out = game_pano / rel.with_suffix(COMPILED_EXT[src.suffix.lower()])
        out.parent.mkdir(parents=True, exist_ok=True)
        proc = subprocess.run(
            [str(CSDK_COMPILER), "-nop4", "-i", str(src), "-o", str(out)],
            capture_output=True, text=True, errors="replace", cwd=str(CSDK_ROOT))
        text = proc.stdout + proc.stderr
        ok = proc.returncode == 0 and out.exists()
        note = ""
        if not ok:
            note = " | ".join(ln.strip() for ln in text.splitlines()
                              if ln.strip() and "Creating device" not in ln)[-300:]
        results.append((rel.as_posix(), "OK" if ok else "FAIL",
                        out.stat().st_size if out.exists() else 0, note))
    return game_pano, results


def pack(game_pano: Path) -> Path:
    """把 addon 目录打成 VPK。

    **路径必须带 `panorama/` 前缀**：VPK 的根就是 addon 目录
    （`game/citadel_addons/<addon>/`），游戏按 `panorama/layout/chat.vxml_c`
    去覆盖原版资源。早期版本从 `.../panorama` 目录本身开始打包，包里就成了
    `layout/chat.vxml_c`——游戏根本不会去那儿找，表现是"mod 完全没反应、
    日志一条没有"，而且不报任何错。这里用 REQUIRED_PATHS 兜住这类静默失败。
    """
    files: dict[str, bytes] = {}
    for f in sorted(game_pano.rglob("*")):
        if f.is_file():
            files[f"panorama/{f.relative_to(game_pano).as_posix()}"] = f.read_bytes()

    missing = [p for p in REQUIRED_PATHS if p not in files]
    if missing:
        raise SystemExit(f"[pack] 包内缺少关键资源（游戏会静默忽略）: {missing}")

    out = BUILD / VPK_NAME
    out.parent.mkdir(parents=True, exist_ok=True)
    write_vpk(files, out)
    print(f"[pack] {len(files)} 个文件 -> {out} ({out.stat().st_size} B)")
    for name in read_vpk_index(out):
        print(f"        {name}")
    print(f"[pack] 在 DMM 里导入这个**文件**: {out}")
    return out


def install(vpk: Path, targets: list[str] | None = None) -> None:
    """装进游戏的 addons 目录。

    DMM 会把导入的包按加载顺序重命名成 `pakNN_dir.vpk`（我们这边它改成了
    `pak02_dir.vpk`），所以不能只认 `pak01_dir.vpk`：`--targets` 用来显式补上，
    另外会在 build/.work/installed.json 里记住"上一版写过的路径 + 内容哈希"，
    下次自动跟着 DMM 的改名走（只覆盖内容还是我们上一版的文件，不动别人的）。
    """
    GAME_ADDONS.mkdir(parents=True, exist_ok=True)
    data = vpk.read_bytes()
    digest = hashlib.sha256(data).hexdigest()

    manifest = _load_manifest()
    prev_hash = manifest.get("hash")
    want = {"pak01_dir.vpk", *(manifest.get("paths") or []), *(targets or [])}
    for f in sorted(GAME_ADDONS.glob("pak*_dir.vpk")):
        if prev_hash and _sha256(f) == prev_hash:
            want.add(f.name)

    written: list[str] = []
    for name in sorted(want):
        target = GAME_ADDONS / name
        if not target.parent == GAME_ADDONS:
            print(f"[install] 跳过非法路径: {name}")
            continue
        if target.exists() and _sha256(target) != prev_hash:
            backup = target.with_suffix(target.suffix + ".bak")
            if not backup.exists():
                shutil.copy2(target, backup)
                print(f"[install] 备份原有 {name} -> {backup.name}")
        shutil.copy2(vpk, target)
        written.append(name)
        print(f"[install] {vpk.name} -> {target}")

    _save_manifest({"hash": digest, "paths": written})


MANIFEST = WORK / "installed.json"


def _sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def _load_manifest() -> dict:
    if not MANIFEST.exists():
        return {}
    try:
        return json.loads(MANIFEST.read_text(encoding="utf-8"))
    except Exception:  # noqa: BLE001
        return {}


def _save_manifest(data: dict) -> None:
    MANIFEST.parent.mkdir(parents=True, exist_ok=True)
    MANIFEST.write_text(json.dumps(data, indent=2), encoding="utf-8")


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--pack", action="store_true", help="编译后打包 VPK")
    ap.add_argument("--install", action="store_true", help="打包后装进游戏 addons")
    ap.add_argument("--targets", nargs="*", default=None,
                    help="额外覆盖的 addons 内文件名，例如 DMM 改名后的 pak02_dir.vpk")
    args = ap.parse_args()

    game_pano, results = compile_all()
    ok = 0
    for rel, state, size, note in results:
        print(f"  {rel:42} {state:4} {size:>8} B  {note}")
        ok += state == "OK"
    print(f"[compile] {ok}/{len(results)} 成功")

    if args.install:
        args.pack = True
    if args.pack and ok == len(results):
        vpk = pack(game_pano)
        if args.install:
            install(vpk, args.targets)
    return 0 if ok == len(results) else 1


if __name__ == "__main__":
    raise SystemExit(main())
