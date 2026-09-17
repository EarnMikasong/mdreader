# -*- coding: utf-8 -*-
"""编辑自检：验证保存、重新渲染和外部修改冲突保护。"""
import argparse
import json
import os
import tempfile
import urllib.parse
from pathlib import Path

from playwright.sync_api import sync_playwright


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, default=7333)
    args = parser.parse_args()

    token = (Path.home() / ".mdreader" / "token").read_text(encoding="utf-8").strip()
    errors = []
    save_requests = []
    doc_responses = []

    with tempfile.TemporaryDirectory(prefix="mdreader-edit-") as temp_dir:
        doc = Path(temp_dir) / "编辑测试.md"
        original = "# 编辑测试\n\n初始 **粗体** 内容与 $x^2$。\n\n[^n]: 保留的脚注\n"
        external = "# 编辑测试\n\n这是外部程序写入的内容。\n"
        doc.write_text(original, encoding="utf-8")

        url = "http://127.0.0.1:%d/?t=%s#%s" % (
            args.port,
            urllib.parse.quote(token),
            urllib.parse.quote(str(doc)),
        )

        with sync_playwright() as p:
            browser = p.chromium.launch(headless=True)
            page = browser.new_page(viewport={"width": 1280, "height": 800})
            page.on("console", lambda m: errors.append("console.%s: %s" % (m.type, m.text))
                    if m.type == "error" else None)
            page.on("pageerror", lambda e: errors.append("pageerror: %s" % e))
            page.on("request", lambda request: save_requests.append(json.loads(request.post_data))
                    if "/api/save" in request.url and request.post_data else None)
            page.on("response", lambda response: doc_responses.append(response.json())
                    if "/api/doc" in response.url and response.ok else None)

            page.goto(url)
            page.wait_for_load_state("networkidle")
            assert doc_responses and doc_responses[-1].get("digest"), \
                "打开文档响应缺少内容指纹：%r" % doc_responses
            paragraph = page.locator("#content > p").first
            paragraph.click(position={"x": 120, "y": 12})
            assert page.locator("#content").get_attribute("contenteditable") == "true"
            assert page.locator("#editor").is_hidden()
            assert "所见编辑" in page.locator("#stat-edit").inner_text()
            paragraph.evaluate("""el => {
              const range = document.createRange();
              range.selectNodeContents(el); range.collapse(false);
              const sel = window.getSelection(); sel.removeAllRanges(); sel.addRange(range);
            }""")
            page.keyboard.type(" 新增内容。")
            paragraph.evaluate("""el => {
              const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
              let node;
              while ((node = walker.nextNode())) {
                const at = node.nodeValue.indexOf('新增内容');
                if (at >= 0) {
                  const range = document.createRange();
                  range.setStart(node, at); range.setEnd(node, at + 4);
                  const sel = window.getSelection(); sel.removeAllRanges(); sel.addRange(range);
                  break;
                }
              }
            }""")
            page.locator("#fmt-bold").click()
            assert "未保存" in page.locator("#stat-edit").inner_text()
            page.screenshot(
                path=str(Path(tempfile.gettempdir()) / "mdreader-edit-mode.png"),
                full_page=False,
            )

            page.keyboard.press("Control+s")
            page.wait_for_function(
                "() => document.querySelector('#stat-edit').textContent.includes('已保存')"
            )
            visual_saved = doc.read_text(encoding="utf-8")
            assert "**粗体**" in visual_saved
            assert "$x^2$" in visual_saved
            assert "[^n]: 保留的脚注" in visual_saved
            assert "**新增内容**" in visual_saved
            assert page.locator("#content").is_visible()
            assert page.locator("#editor").is_hidden()
            assert "已保存" in page.locator("#stat-edit").inner_text()

            # Markdown 源码模式仍然保留，并可切回所见模式。
            page.locator("#btn-source").click()
            assert page.locator("#editor").is_visible()
            source_status = page.locator("#stat-edit").inner_text()
            assert "源码编辑" in source_status, "切换源码后的状态：%r" % source_status
            page.locator("#editor").press("Control+End")
            page.locator("#editor").type("\n源码模式追加。\n")
            page.keyboard.press("Control+s")
            page.wait_for_function(
                "() => document.querySelector('#stat-edit').textContent.includes('已保存')"
            )
            assert "源码模式追加" in doc.read_text(encoding="utf-8")
            page.locator("#btn-source").click()
            assert page.locator("#content").is_visible()
            assert "源码模式追加" in page.locator("#content").inner_text()

            page.locator("#btn-cancel").click()
            page.locator("#content").wait_for(state="visible")
            rendered_text = page.locator("#content").inner_text().replace("²", "2")
            assert "新增内容" in rendered_text and "粗体" in rendered_text, \
                "所见编辑保存后正文异常：%r" % rendered_text
            assert "点击正文" in page.locator("#stat-edit").inner_text()
            saved_mtime = doc.stat().st_mtime

            # 所见模式放弃修改时，必须恢复最后一次保存的渲染结果。
            paragraph = page.locator("#content > p").first
            paragraph.click()
            paragraph.evaluate("""el => {
              const range = document.createRange(); range.selectNodeContents(el); range.collapse(false);
              const sel = window.getSelection(); sel.removeAllRanges(); sel.addRange(range);
            }""")
            page.keyboard.type(" 应放弃")
            page.once("dialog", lambda dialog: dialog.accept())
            page.locator("#btn-cancel").click()
            assert "应放弃" not in page.locator("#content").inner_text()

            # 模拟外部程序改盘并保留原 mtime；内容指纹仍必须识别冲突。
            page.locator("#btn-source").click()
            page.locator("#editor").fill(visual_saved + "\n本地尚未保存的草稿。\n")
            doc.write_text(external, encoding="utf-8")
            os.utime(doc, (saved_mtime, saved_mtime))
            page.keyboard.press("Control+s")
            page.wait_for_timeout(900)

            toast_text = page.locator("#toast").inner_text()
            assert len(save_requests) == 3 and save_requests[-1].get("digest"), \
                "保存请求缺少内容指纹：%r" % save_requests
            assert "其他程序修改" in toast_text, \
                "未出现冲突提示，实际提示：%r；请求：%r" % (toast_text, save_requests[-1])
            assert page.locator("#editor").is_visible()
            assert doc.read_text(encoding="utf-8") == external

            page.once("dialog", lambda dialog: dialog.accept())
            page.locator("#btn-cancel").click()
            page.get_by_text("这是外部程序写入的内容。", exact=True).wait_for(state="visible")
            assert "外部程序写入的内容" in page.locator("#content").inner_text()
            browser.close()

    print("编辑保存：通过")
    print("冲突保护：通过")
    unexpected_errors = [error for error in errors if "status of 409 (Conflict)" not in error]
    if unexpected_errors:
        raise AssertionError("浏览器控制台错误：\n" + "\n".join(unexpected_errors))
    print("控制台错误：无")


if __name__ == "__main__":
    main()
