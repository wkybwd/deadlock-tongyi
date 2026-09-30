from __future__ import annotations

import shutil
import tempfile
import unittest
import xml.etree.ElementTree as ET
from pathlib import Path

from scripts.check_mod_layouts import ROOT, check_layouts


class ModLayoutTests(unittest.TestCase):
    def test_current_layouts_preserve_official_contract(self):
        self.assertEqual(check_layouts(ROOT / "mod/panorama/layout"), [])

    def test_game_crash_regressions_are_rejected(self):
        # 两个玩家实际遇到的 fatal error，以及同次更新新增的其他原生结构。
        cases = [
            ("citadel_hud_top_bar_chat.xml", ".//Image[@id='TargetHeroImage']"),
            ("citadel_hud_top_bar_chat.xml", "./snippets/snippet[@name='TypingIndicatorChatMessage']"),
            ("citadel_hud_top_bar_chat.xml", ".//Panel[@id='CooldownTimer']"),
            ("chat.xml", ".//Image[@id='TargetHeroImage']"),
        ]
        for filename, xpath in cases:
            with self.subTest(filename=filename, xpath=xpath), tempfile.TemporaryDirectory() as tmp:
                directory = Path(tmp) / "layout"
                shutil.copytree(ROOT / "mod/panorama/layout", directory)
                path = directory / filename
                tree = ET.parse(path)
                target = tree.getroot().find(xpath)
                self.assertIsNotNone(target)
                parent = next(node for node in tree.iter() if target in list(node))
                parent.remove(target)
                tree.write(path, encoding="utf-8")
                self.assertTrue(check_layouts(directory))

    def test_wrong_node_type_or_html_attribute_is_rejected(self):
        for attribute in ("tag", "html"):
            with self.subTest(attribute=attribute), tempfile.TemporaryDirectory() as tmp:
                directory = Path(tmp) / "layout"
                shutil.copytree(ROOT / "mod/panorama/layout", directory)
                path = directory / "citadel_hud_top_bar_chat.xml"
                tree = ET.parse(path)
                if attribute == "tag":
                    tree.find(".//Image[@id='TargetHeroImage']").tag = "Panel"
                else:
                    tree.find(".//Label[@id='MessageText']").set("html", "false")
                tree.write(path, encoding="utf-8")
                self.assertTrue(check_layouts(directory))


if __name__ == "__main__":
    unittest.main()
