# -*- coding: utf-8 -*-
"""渲染自检：把示例文档跑一遍，检查各功能是否真的生效。"""
import json
import os
import sys
import tempfile
from pathlib import Path

from playwright.sync_api import sync_playwright

STATE_DIR = Path(os.environ.get("MDREADER_STATE_DIR", str(Path.home() / ".mdreader")))
TOKEN = (STATE_DIR / "token").read_text(encoding="utf-8").strip()
DOC = str(Path(__file__).resolve().parent / "示例文档" / "功能演示.md")
PORT = int(os.environ.get("MDREADER_TEST_PORT", "7333"))
URL = "http://127.0.0.1:%d/?t=%s#%s" % (PORT, TOKEN, DOC.replace("\\", "%5C"))

errors = []
SHOT_DIR = Path(tempfile.gettempdir())

with sync_playwright() as p:
    browser = p.chromium.launch(headless=True)
    page = browser.new_page(viewport={"width": 1440, "height": 950})
    page.on("console", lambda m: errors.append("console.%s: %s" % (m.type, m.text))
            if m.type == "error" else None)
    page.on("pageerror", lambda e: errors.append("pageerror: %s" % e))

    page.goto(URL)
    page.wait_for_load_state("networkidle")
    page.wait_for_timeout(2500)          # 等 mermaid 异步渲染

    checks = page.evaluate("""() => {
      const c = document.querySelector('#content');
      const q = s => c.querySelectorAll(s).length;
      return {
        标题: document.querySelector('#doc-title').textContent,
        front_matter: q('.front-matter'),
        标题数: q('h1,h2,h3'),
        大纲条目: document.querySelectorAll('#pane-outline .toc-item').length,
        文件树条目: document.querySelectorAll('#pane-tree .node.file').length,
        表格: q('table'),
        任务项: q('li.task'),
        代码块: q('.code-wrap'),
        高亮片段: q('.hljs-keyword, .hljs-string, .hljs-title'),
        复制按钮: q('.code-wrap .copy'),
        行内公式: c.querySelectorAll('.katex:not(.katex-display .katex)').length,
        块级公式: q('.katex-display'),
        公式报错: q('.math-err'),
        mermaid_svg: q('.mermaid-box svg'),
        mermaid_err: q('.mermaid-err'),
        脚注条目: q('.footnotes li'),
        脚注引用: q('.fn-ref'),
        缺图提示: q('.img-broken'),
        外链标记: q('a.ext'),
        字数: document.querySelector('#stat-words').textContent,
        残留占位符: (c.textContent.match(/zZ(MATH|FNREF)/g) || []).length,
        金额误判: c.textContent.includes('$100 和 $200'),
      };
    }""")

    print("=== 渲染检查 ===")
    for k, v in checks.items():
        print("  %-14s %s" % (k, v))

    page.screenshot(path=str(SHOT_DIR / "mdreader-shot-light.png"), full_page=False)

    # 大纲 / 站内跳转 / 查找 / 深色主题
    page.click('.tab[data-pane="pane-outline"]')
    page.wait_for_timeout(200)
    page.click('#pane-outline .toc-item:nth-child(6)')
    page.wait_for_timeout(600)

    page.keyboard.press("Control+f")
    page.fill("#find-input", "公式")
    page.wait_for_timeout(400)
    find_count = page.inner_text("#find-count")
    page.keyboard.press("Escape")
    left_marks = page.evaluate("document.querySelectorAll('#content mark.hit').length")

    page.click("#btn-theme")          # light -> dark
    page.wait_for_timeout(1500)
    theme = page.evaluate("document.documentElement.dataset.theme")
    dark_ok = page.evaluate("!document.querySelector('#hljs-dark').disabled")
    page.screenshot(path=str(SHOT_DIR / "mdreader-shot-dark.png"), full_page=False)

    # 站内 md 链接跳转
    page.click("#btn-theme")          # dark -> auto
    page.click('.tab[data-pane="pane-tree"]')
    page.click('text=第二篇')
    page.wait_for_timeout(800)
    title2 = page.inner_text("#doc-title")
    page.keyboard.press("Alt+ArrowLeft")
    page.wait_for_timeout(800)
    title_back = page.inner_text("#doc-title")

    print("\n=== 交互检查 ===")
    print("  查找命中        %s" % find_count)
    print("  Esc 后残留高亮  %s" % left_marks)
    print("  主题切换        %s (深色样式生效=%s)" % (theme, dark_ok))
    print("  点开第二篇      %s" % title2)
    print("  Alt+← 回到      %s" % title_back)

    browser.close()

print("\n=== 控制台错误 ===")
if errors:
    for e in errors[:12]:
        print("  " + e)
else:
    print("  无")
