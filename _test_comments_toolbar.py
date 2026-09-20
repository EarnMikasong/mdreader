# -*- coding: utf-8 -*-
"""批注与增强编辑工具栏的端到端自检。"""
import argparse
import os
import tempfile
import urllib.parse
from pathlib import Path

from playwright.sync_api import sync_playwright


def select_text(page, selector, text):
    page.locator(selector).evaluate(
        """(el, text) => {
          const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
          let node;
          while ((node = walker.nextNode())) {
            const at = node.nodeValue.indexOf(text);
            if (at >= 0) {
              const range = document.createRange();
              range.setStart(node, at); range.setEnd(node, at + text.length);
              const selection = window.getSelection();
              selection.removeAllRanges(); selection.addRange(range); return;
            }
          }
          throw new Error('未找到选中文本：' + text);
        }""",
        text,
    )


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, default=7333)
    args = parser.parse_args()
    state_dir = Path(os.environ.get("MDREADER_STATE_DIR", str(Path.home() / ".mdreader")))
    token = (state_dir / "token").read_text(encoding="utf-8").strip()
    errors = []
    comment_requests = []

    with tempfile.TemporaryDirectory(prefix="mdreader-comments-") as temp_dir:
        doc = Path(temp_dir) / "批注与编辑.md"
        doc.write_text("# 编辑器测试\n\n这是一段需要批注的正文内容。\n", encoding="utf-8")
        url = "http://127.0.0.1:%d/?t=%s#%s" % (
            args.port, urllib.parse.quote(token), urllib.parse.quote(str(doc)))

        with sync_playwright() as p:
            browser = p.chromium.launch(headless=True)
            page = browser.new_page(viewport={"width": 1440, "height": 900})
            page.on("console", lambda message: errors.append("%s: %s" % (message.type, message.text))
                    if message.type == "error" else None)
            page.on("request", lambda request: comment_requests.append(request.post_data)
                    if "/api/comments" in request.url and request.method == "POST" else None)
            # 应用每 1.5 秒轮询一次待打开文件，因此持续的后台请求会让
            # networkidle 永远不成立；以正文已渲染作为可交互就绪信号。
            page.goto(url, wait_until="domcontentloaded")
            page.locator("#content > p").wait_for(state="visible")

            # 选中原文，提交侧边批注；刷新后仍应存在。
            select_text(page, "#content > p", "需要批注")
            page.locator("#btn-comments").click()
            assert page.locator("#comment-compose").is_visible()
            assert "需要批注" in page.locator("#comment-quote").inner_text()
            page.locator("#comment-input").fill("这段需要补一个真实例子。")
            page.locator("#btn-comment-submit").click()
            page.wait_for_timeout(800)
            assert page.locator(".comment-card").count() == 1, "批注未保存：%r；请求=%r；错误=%r" % (
                page.locator("#toast").inner_text(), comment_requests, errors)
            assert page.locator("#comments-count").inner_text() == "1"
            assert page.evaluate("() => CSS.highlights.get('mdreader-comment').size") == 1
            page.reload(wait_until="domcontentloaded")
            page.locator("#btn-comments").click()
            page.get_by_text("这段需要补一个真实例子。", exact=True).wait_for(state="visible")
            assert page.locator("#comments-count").inner_text() == "1"
            page.get_by_role("button", name="解决").click()
            page.wait_for_function("() => document.querySelector('.comment-card-foot').textContent.includes('已解决')")
            page.once("dialog", lambda dialog: dialog.accept())
            page.get_by_role("button", name="删除").click()
            page.wait_for_function("() => document.querySelector('#comments-count').textContent === '0'")

            # 可视化编辑：链接和引用写回 Markdown。
            page.locator("#btn-edit").click()
            assert page.locator("#content").get_attribute("contenteditable") == "true"
            select_text(page, "#content > p", "正文内容")
            page.once("dialog", lambda dialog: dialog.accept("example.com"))
            page.locator("#fmt-link").click()
            page.locator("#fmt-quote").click()
            page.keyboard.press("Control+s")
            page.wait_for_function("() => document.querySelector('#stat-edit').textContent.includes('已保存')")
            saved = doc.read_text(encoding="utf-8")
            assert "[正文内容](https://example.com)" in saved, saved
            assert "> " in saved, saved

            # 源码模式：工具栏不隐藏，待办、表格、分割线都能插入。
            page.locator("#btn-source").click()
            assert page.locator("#editor").is_visible()
            assert page.locator("#visual-tools").is_visible()
            page.locator("#editor").press("Control+End")
            page.locator("#fmt-task").click()
            page.locator("#fmt-table").click()
            page.locator("#fmt-divider").click()
            source = page.locator("#editor").input_value()
            assert "- [ ]" in source and "| 列 1 |" in source and "---" in source, source

            # 最近查看：按日期分组；移除仅清理本地历史，不碰磁盘文件。
            now = page.evaluate("() => Date.now()")
            page.evaluate("""(now) => localStorage.setItem('md.recents', JSON.stringify([
              { path: 'D:/notes/today.md', name: '今天的文档.md', time: now },
              { path: 'D:/notes/yesterday.md', name: '昨天的文档.md', time: now - 86400000 },
              { path: 'D:/notes/week.md', name: '本周的文档.md', time: now - 3 * 86400000 },
              { path: 'D:/notes/old.md', name: '旧文档.md', time: now - 12 * 86400000 }
            ]))""", now)
            page.reload(wait_until="domcontentloaded")
            page.get_by_role("button", name="最近").click()
            assert page.locator(".recent-group-title").all_inner_texts() == ["今天 · 2", "昨天 · 1", "近 7 天 · 1", "更早 · 1"]
            page.locator(".recent-item", has_text="今天的文档.md").get_by_role("button", name="移除").click()
            assert page.locator(".recent-item").count() == 4
            assert "today.md" not in page.evaluate("() => localStorage.getItem('md.recents')")
            browser.close()

    if errors:
        raise AssertionError("浏览器控制台错误：\n" + "\n".join(errors))
    print("侧边批注：通过")
    print("增强工具栏：通过")
    print("控制台错误：无")


if __name__ == "__main__":
    main()
