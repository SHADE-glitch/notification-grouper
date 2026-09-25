#!/usr/bin/env python3
"""防复发：断言 prefs.js 未给无 subtitle 属性的 Adw 控件传 subtitle。

背景：libadwaita 1.9.1 下 Adw.ButtonRow / Adw.EntryRow 无 subtitle 属性，
传了即崩（No property subtitle on AdwButtonRow）。本脚本在提交前跑。
用法：python3 scripts/check-adw-props.py
"""
import re
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent.parent
PREFS = HERE / "prefs.js"

# 经 GObject.list_properties 实测（libadwaita 1.9.1）无 subtitle 的类
NO_SUBTITLE = ("ButtonRow", "EntryRow")

fail = 0
text = PREFS.read_text()
for cls in NO_SUBTITLE:
    # 匹配 new Adw.ButtonRow({ ... subtitle ... }) 跨行构造
    for m in re.finditer(rf"new\s+Adw\.{cls}\s*\(\{{(.*?)\}}\)", text, re.S):
        body = m.group(1)
        if "subtitle" in body:
            line = text[: m.start()].count("\n") + 1
            print(f"FAIL: Adw.{cls} 传了 subtitle（约行 {line}），会崩：{body.strip()[:80]}")
            fail += 1

if fail:
    print(f"\n共 {fail} 处违规，修复后再提交。")
    sys.exit(1)
print("OK：ButtonRow/EntryRow 均未传 subtitle。")
