"""检查覆盖布局保留了游戏要求的完整结构；缺节点会直接导致游戏 FATAL ERROR。"""

from __future__ import annotations

import argparse
import xml.etree.ElementTree as ET
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
BASELINE = ROOT / "tests" / "fixtures" / "game_build_25614556"
LAYOUTS = {"chat.xml": "CitadelChat", "citadel_hud_top_bar_chat.xml": "CitadelHudTopBarChat"}


def _canonical(element: ET.Element | None) -> tuple | None:
    if element is None:
        return None
    # 通译只在官方根面板/输入区添加独立 DLChat 控件，不修改官方子树。
    return (element.tag, tuple(sorted(element.attrib.items())),
            tuple(_canonical(child) for child in element
                  if not child.get("id", "").startswith("DLChat")))


def check_layouts(directory: Path) -> list[str]:
    problems: list[str] = []
    for name, panel_type in LAYOUTS.items():
        try:
            official = ET.parse(BASELINE / name).getroot()
            mod = ET.parse(directory / name).getroot()
        except (OSError, ET.ParseError) as exc:
            problems.append(f"{name}: 无法读取布局/官方基线: {exc}")
            continue
        for snippet in official.findall("./snippets/snippet"):
            snippet_name = snippet.get("name")
            actual = mod.find(f"./snippets/snippet[@name='{snippet_name}']")
            if _canonical(actual) != _canonical(snippet):
                problems.append(f"{name}: 官方模板 {snippet_name} 缺失或结构/属性不匹配 "
                                "(Deadlock Build 25614556)")
        if _canonical(mod.find(panel_type)) != _canonical(official.find(panel_type)):
            problems.append(f"{name}: {panel_type} 的官方面板结构不匹配")
        for style in official.findall("./styles/include"):
            if not any(item.attrib == style.attrib for item in mod.findall("./styles/include")):
                problems.append(f"{name}: 缺少官方样式 {style.get('src')}")
    return problems


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--layout-dir", type=Path, default=ROOT / "mod/panorama/layout")
    args = parser.parse_args()
    problems = check_layouts(args.layout_dir)
    for problem in problems:
        print(problem)
    if not problems:
        print("layout_check: 两份布局的官方模板、面板结构与 Build 25614556 一致")
    return int(bool(problems))


if __name__ == "__main__":
    raise SystemExit(main())
