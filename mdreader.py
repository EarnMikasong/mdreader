#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
mdreader —— 轻量 Markdown 阅读器（Typora 的阅读替代品）

用法:
    python mdreader.py                 打开上次的文件夹
    python mdreader.py 文档.md          直接阅读某个文件
    python mdreader.py D:\\笔记          把整个文件夹当作文档库打开
    python mdreader.py --port 7333     指定端口

只监听 127.0.0.1，接口需要用户目录下的私有 token，外部网页无法读取你的文件。
"""
import argparse
import hashlib
import http.server
import json
import mimetypes
import os
import secrets
import socket
import subprocess
import sys
import tempfile
import threading
import time
import urllib.parse
import urllib.request
import uuid
import webbrowser
from pathlib import Path

if getattr(sys, "frozen", False):                       # PyInstaller 打包后的运行时
    APP_DIR = Path(getattr(sys, "_MEIPASS", ".")) / "app"
else:
    APP_DIR = Path(__file__).resolve().parent / "app"
# 默认仍保存在用户目录。环境变量只用于隔离测试或便携运行，避免测试污染真实记录。
STATE_DIR = Path(os.environ.get("MDREADER_STATE_DIR", str(Path.home() / ".mdreader"))).expanduser()
DEFAULT_PORT = 7333
APP_VERSION = "1.1.0"
MD_EXT = {".md", ".markdown", ".mdown", ".mkd", ".mdx", ".txt"}
SKIP_DIRS = {".git", ".svn", ".hg", "node_modules", "__pycache__", ".idea", ".vscode",
             "venv", ".venv", "env", "dist", "build", ".next", ".cache", ".obsidian"}
MAX_NODES = 8000
MAX_EDIT_BYTES = 8_000_000
MAX_BODY_BYTES = 12_000_000
MAX_COMMENT_BYTES = 8_000
MAX_COMMENT_QUOTE = 700

# ---------------------------------------------------------------- 运行期状态
STATE = {
    "token": "",
    "root": "",          # 当前文档库根目录
    "pending": [],       # 第二次启动时交接过来、等前端打开的文件
    "last_seen": 0.0,    # 前端最近一次轮询的时间
    "opened": set(),     # 已通过 /api/doc 打开的文件，只有这些文件允许保存
}
COMMENT_LOCK = threading.Lock()


def load_token():
    """token 存在用户目录、跨次启动复用，这样端口固定、浏览器 localStorage 也能延续。"""
    STATE_DIR.mkdir(exist_ok=True)
    f = STATE_DIR / "token"
    if f.exists():
        t = f.read_text(encoding="utf-8").strip()
        if len(t) >= 16:
            return t
    t = secrets.token_urlsafe(24)
    f.write_text(t, encoding="utf-8")
    try:
        os.chmod(f, 0o600)
    except OSError:
        pass
    return t


def load_prefs():
    f = STATE_DIR / "prefs.json"
    if f.exists():
        try:
            return json.loads(f.read_text(encoding="utf-8"))
        except (ValueError, OSError):
            pass
    return {}


def save_prefs(d):
    STATE_DIR.mkdir(exist_ok=True)
    try:
        (STATE_DIR / "prefs.json").write_text(
            json.dumps(d, ensure_ascii=False, indent=1), encoding="utf-8")
    except OSError:
        pass


# ---------------------------------------------------------------- 本地批注
# 批注不写入 Markdown 文件：它们属于阅读器的个人工作层，和原稿分离，
# 不会污染 Git diff，也不会影响其他编辑器打开同一份文档。
def comments_file():
    return STATE_DIR / "comments.json"


def load_comments_store():
    f = comments_file()
    if f.exists():
        try:
            data = json.loads(f.read_text(encoding="utf-8"))
            if isinstance(data, dict) and isinstance(data.get("documents", {}), dict):
                return data
        except (ValueError, OSError):
            pass
    return {"version": 1, "documents": {}}


def save_comments_store(data):
    """保存本地批注。

    NamedTemporaryFile 在部分 Windows 安全软件监控的用户目录会阻塞，因此
    这里使用与偏好设置相同的直接写入策略；批注文件损坏时会自动忽略重建。
    """
    STATE_DIR.mkdir(exist_ok=True)
    target = comments_file()
    target.write_text(json.dumps(data, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")


def comments_for(path):
    key = str(Path(path).resolve())
    with COMMENT_LOCK:
        return load_comments_store().get("documents", {}).get(key, [])


def mutate_comments(path, operation, payload):
    """返回该文档的最新批注列表；只允许操作已在本程序打开过的文件。"""
    target = Path(path).resolve()
    key = str(target)
    if key not in STATE["opened"] or not target.is_file():
        raise PermissionError("只能给已在阅读器中打开的文档添加批注")

    with COMMENT_LOCK:
        store = load_comments_store()
        docs = store.setdefault("documents", {})
        items = docs.setdefault(key, [])
        now = int(time.time())

        if operation == "add":
            quote = str(payload.get("quote", "")).strip()
            body = str(payload.get("body", "")).strip()
            if not quote or not body:
                raise ValueError("请选择文字并填写批注")
            if len(quote) > MAX_COMMENT_QUOTE or len(body.encode("utf-8")) > MAX_COMMENT_BYTES:
                raise ValueError("批注内容过长")
            items.append({
                "id": uuid.uuid4().hex,
                "quote": quote,
                "body": body,
                "prefix": str(payload.get("prefix", ""))[-180:],
                "suffix": str(payload.get("suffix", ""))[:180],
                "created": now,
                "updated": now,
                "resolved": False,
            })
        elif operation in ("resolve", "delete"):
            comment_id = str(payload.get("id", ""))
            index = next((i for i, item in enumerate(items) if item.get("id") == comment_id), -1)
            if index < 0:
                raise ValueError("找不到这条批注")
            if operation == "delete":
                items.pop(index)
            else:
                items[index]["resolved"] = not bool(items[index].get("resolved"))
                items[index]["updated"] = now
        else:
            raise ValueError("未知的批注操作")

        if not items:
            docs.pop(key, None)
        save_comments_store(store)
        return docs.get(key, [])


# ---------------------------------------------------------------- 文件树
def build_tree(root):
    n = [0]

    def walk(d):
        items = []
        try:
            entries = sorted(os.scandir(d), key=lambda e: (not e.is_dir(), e.name.lower()))
        except OSError:
            return items
        for e in entries:
            if n[0] >= MAX_NODES:
                break
            if e.name.startswith("."):
                continue
            try:
                if e.is_dir():
                    if e.name in SKIP_DIRS:
                        continue
                    kids = walk(Path(e.path))
                    if kids:                       # 只保留含 md 的目录
                        n[0] += 1
                        items.append({"type": "dir", "name": e.name,
                                      "path": e.path, "children": kids})
                elif Path(e.name).suffix.lower() in MD_EXT:
                    st = e.stat()
                    n[0] += 1
                    items.append({"type": "file", "name": e.name, "path": e.path,
                                  "mtime": st.st_mtime, "size": st.st_size})
            except OSError:
                continue
        return items

    return walk(root)


def grep_tree(root, needle, limit=80):
    """整个文档库的全文检索，每个文件返回第一条命中。"""
    needle_l = needle.lower()
    hits = []

    def visit(d):
        if len(hits) >= limit:
            return
        try:
            entries = sorted(os.scandir(d), key=lambda e: (not e.is_dir(), e.name.lower()))
        except OSError:
            return
        for e in entries:
            if len(hits) >= limit:
                return
            if e.name.startswith("."):
                continue
            if e.is_dir():
                if e.name not in SKIP_DIRS:
                    visit(Path(e.path))
            elif Path(e.name).suffix.lower() in MD_EXT:
                try:
                    if e.stat().st_size > 4_000_000:
                        continue
                    text = Path(e.path).read_text(encoding="utf-8", errors="replace")
                except OSError:
                    continue
                if needle_l not in text.lower():
                    continue
                for i, line in enumerate(text.splitlines(), 1):
                    if needle_l in line.lower():
                        hits.append({"path": e.path, "name": e.name,
                                     "line": i, "text": line.strip()[:200]})
                        break

    visit(root)
    return hits


# ---------------------------------------------------------------- 原生选择框
def pick_path(kind):
    out = {}

    def run():
        try:
            import tkinter as tk
            from tkinter import filedialog
        except ImportError:
            return
        r = tk.Tk()
        r.withdraw()
        r.attributes("-topmost", True)
        if kind == "dir":
            out["p"] = filedialog.askdirectory(title="选择文档文件夹")
        elif kind == "image":
            out["p"] = filedialog.askopenfilename(
                title="插入图片",
                filetypes=[("图片", "*.png *.jpg *.jpeg *.gif *.webp *.bmp *.svg"),
                           ("所有文件", "*.*")])
        else:
            out["p"] = filedialog.askopenfilename(
                title="打开 Markdown 文件",
                filetypes=[("Markdown", "*.md *.markdown *.mdx *.txt"), ("所有文件", "*.*")])
        r.destroy()

    t = threading.Thread(target=run, daemon=True)
    t.start()
    t.join(180)
    return out.get("p") or ""


# ---------------------------------------------------------------- HTTP
class Handler(http.server.BaseHTTPRequestHandler):
    server_version = "mdreader"

    def log_message(self, *a):
        pass                                       # 控制台保持安静

    def _send(self, code, body, ctype="application/json; charset=utf-8", extra=None):
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        for k, v in (extra or {}).items():
            self.send_header(k, v)
        self.end_headers()
        try:
            self.wfile.write(body)
        except (BrokenPipeError, ConnectionAbortedError, ConnectionResetError):
            pass

    def _json(self, obj, code=200):
        self._send(code, json.dumps(obj, ensure_ascii=False).encode("utf-8"))

    def _err(self, code, msg):
        self._json({"error": msg}, code)

    def _authed(self, q):
        return secrets.compare_digest(q.get("t", [""])[0], STATE["token"])

    def _static(self, rel):
        base = APP_DIR.resolve()
        target = (base / rel.lstrip("/")).resolve()
        if not str(target).startswith(str(base)) or not target.is_file():
            return self._err(404, "not found")
        ctype = mimetypes.guess_type(target.name)[0] or "application/octet-stream"
        if ctype.startswith("text/") or ctype in ("application/javascript", "application/json"):
            ctype += "; charset=utf-8"
        self._send(200, target.read_bytes(), ctype)

    def do_GET(self):
        u = urllib.parse.urlparse(self.path)
        q = urllib.parse.parse_qs(u.query)
        path = u.path

        if path == "/api/ping":
            return self._json({"app": "mdreader", "version": APP_VERSION, "root": STATE["root"],
                               "active": time.time() - STATE["last_seen"] < 12})

        if path in ("/", "/index.html"):
            return self._static("index.html")
        if not path.startswith("/api/"):
            return self._static(path)

        if not self._authed(q):
            return self._err(403, "bad token")

        if path == "/api/tree":
            root = Path(q.get("p", [STATE["root"]])[0])
            if not root.is_dir():
                return self._err(404, "目录不存在")
            STATE["root"] = str(root)
            return self._json({"root": str(root), "name": root.name or str(root),
                               "children": build_tree(root)})

        if path == "/api/doc":
            f = Path(q.get("p", [""])[0])
            if not f.is_file():
                return self._err(404, "文件不存在")
            raw = f.read_bytes()
            try:
                text = raw.decode("utf-8")
            except UnicodeDecodeError:
                text = raw.decode("gbk", errors="replace")
            STATE["opened"].add(str(f.resolve()))
            return self._json({"path": str(f), "name": f.name, "dir": str(f.parent),
                               "mtime": f.stat().st_mtime,
                               "digest": hashlib.sha256(raw).hexdigest(), "content": text})

        if path == "/api/stat":
            f = Path(q.get("p", [""])[0])
            STATE["last_seen"] = time.time()
            return self._json({"mtime": f.stat().st_mtime if f.is_file() else 0})

        if path == "/api/raw":                      # 图片等相对资源
            f = Path(q.get("p", [""])[0])
            if not f.is_file():
                return self._err(404, "not found")
            ctype = mimetypes.guess_type(f.name)[0] or "application/octet-stream"
            return self._send(200, f.read_bytes(), ctype,
                              extra={"Cache-Control": "max-age=60"})

        if path == "/api/search":
            root = Path(q.get("p", [STATE["root"]])[0])
            kw = q.get("q", [""])[0].strip()
            if not kw or not root.is_dir():
                return self._json({"hits": []})
            return self._json({"hits": grep_tree(root, kw)})

        if path == "/api/pick":
            return self._json({"path": pick_path(q.get("kind", ["dir"])[0])})

        if path == "/api/pending":                  # 第二次启动交接过来的文件
            STATE["last_seen"] = time.time()
            items, STATE["pending"] = STATE["pending"], []
            return self._json({"open": items})

        if path == "/api/prefs":
            return self._json(load_prefs())

        if path == "/api/comments":
            source = q.get("p", [""])[0]
            if not source:
                return self._err(400, "缺少文档路径")
            return self._json({"comments": comments_for(source)})

        if path == "/api/reveal":                   # 在资源管理器里定位
            f = Path(q.get("p", [""])[0])
            if f.exists() and sys.platform == "win32":
                subprocess.Popen(["explorer", "/select,", str(f)])
            return self._json({"ok": True})

        return self._err(404, "unknown api")

    def do_POST(self):
        u = urllib.parse.urlparse(self.path)
        q = urllib.parse.parse_qs(u.query)
        n = int(self.headers.get("Content-Length") or 0)
        if n > MAX_BODY_BYTES:
            return self._err(413, "内容过大，无法保存")
        raw = self.rfile.read(n) if n else b"{}"
        try:
            body = json.loads(raw.decode("utf-8"))
        except ValueError:
            body = {}

        if not self._authed(q):
            return self._err(403, "bad token")

        if u.path == "/api/open":                   # 单实例交接
            p = body.get("path", "")
            if p:
                STATE["pending"].append(p)
            return self._json({"ok": True, "active": time.time() - STATE["last_seen"] < 12})

        if u.path == "/api/prefs":
            save_prefs(body)
            return self._json({"ok": True})

        if u.path == "/api/comments":
            path = body.get("path")
            if not isinstance(path, str) or not path:
                return self._err(400, "缺少文档路径")
            try:
                comments = mutate_comments(path, body.get("op"), body)
            except PermissionError as err:
                return self._err(403, str(err))
            except ValueError as err:
                return self._err(400, str(err))
            except OSError:
                return self._err(500, "批注保存失败")
            return self._json({"ok": True, "comments": comments})

        if u.path == "/api/save":
            path = body.get("path")
            content = body.get("content")
            expected_mtime = body.get("mtime")
            expected_digest = body.get("digest")
            if not isinstance(path, str) or not isinstance(content, str):
                return self._err(400, "保存参数不完整")
            try:
                utf8_size = len(content.encode("utf-8"))
            except UnicodeEncodeError:
                return self._err(422, "文档包含无法保存的字符")
            if utf8_size > MAX_EDIT_BYTES:
                return self._err(413, "文档超过 8 MB，无法在编辑器中保存")

            f = Path(path).resolve()
            if str(f) not in STATE["opened"]:
                return self._err(403, "只能保存已在阅读器中打开的文档")
            if f.suffix.lower() not in MD_EXT:
                return self._err(400, "只允许保存 Markdown 或文本文件")
            if not f.is_file():
                return self._err(404, "文件不存在")

            try:
                current_mtime = f.stat().st_mtime
                if expected_mtime is not None and abs(current_mtime - float(expected_mtime)) > 0.001:
                    return self._err(409, "文件已被其他程序修改，请先重新载入再编辑")

                original = f.read_bytes()
                if expected_digest and hashlib.sha256(original).hexdigest() != expected_digest:
                    return self._err(409, "文件已被其他程序修改，请先重新载入再编辑")
                try:
                    original.decode("utf-8")
                    encoding = "utf-8"
                except UnicodeDecodeError:
                    encoding = "gbk"

                # textarea 会把换行统一成 LF；保存时沿用原文件的换行风格。
                content = content.replace("\r\n", "\n")
                if b"\r\n" in original:
                    content = content.replace("\n", "\r\n")
                try:
                    payload = content.encode(encoding)
                except UnicodeEncodeError:
                    return self._err(422, "原文件使用 GBK 编码，新增字符无法保存；请先将文件转换为 UTF-8")

                temp_name = None
                try:
                    with tempfile.NamedTemporaryFile(
                            mode="wb", dir=str(f.parent), prefix=f.name + ".",
                            suffix=".mdreader.tmp", delete=False) as temp:
                        temp_name = temp.name
                        temp.write(payload)
                        temp.flush()
                        os.fsync(temp.fileno())
                    try:
                        os.chmod(temp_name, f.stat().st_mode)
                    except OSError:
                        pass
                    os.replace(temp_name, f)
                    temp_name = None
                finally:
                    if temp_name:
                        try:
                            os.unlink(temp_name)
                        except OSError:
                            pass
            except (OSError, ValueError):
                return self._err(500, "保存失败：文件可能被占用或没有写入权限")

            stat = f.stat()
            return self._json({"ok": True, "mtime": stat.st_mtime, "size": stat.st_size,
                               "digest": hashlib.sha256(payload).hexdigest()})

        return self._err(404, "unknown api")


class Server(http.server.ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = False


# ---------------------------------------------------------------- 启动
def port_in_use(port):
    with socket.socket() as s:
        s.settimeout(0.4)
        return s.connect_ex(("127.0.0.1", port)) == 0


def handoff(port, token, target):
    """已有实例在跑：把文件交给它；返回它那边是否已有活跃页面。"""
    try:
        req = urllib.request.Request(
            "http://127.0.0.1:%d/api/open?t=%s" % (port, urllib.parse.quote(token)),
            data=json.dumps({"path": target}).encode("utf-8"),
            headers={"Content-Type": "application/json"})
        with urllib.request.urlopen(req, timeout=3) as r:
            return json.loads(r.read().decode("utf-8")).get("active", False)
    except OSError:
        return False


def main():
    ap = argparse.ArgumentParser(description="轻量 Markdown 阅读器")
    ap.add_argument("target", nargs="?", default="", help="要打开的 .md 文件或文件夹")
    ap.add_argument("--port", type=int, default=DEFAULT_PORT)
    ap.add_argument("--no-browser", action="store_true")
    args = ap.parse_args()

    token = STATE["token"] = load_token()
    prefs = load_prefs()

    target = Path(args.target).resolve() if args.target else None
    if target and not target.exists():
        print("找不到：%s" % target)
        return 1

    if target and target.is_file():
        STATE["root"] = str(target.parent)
    elif target:
        STATE["root"] = str(target)
    else:
        STATE["root"] = prefs.get("root") or str(Path.home())

    url = "http://127.0.0.1:%d/?t=%s" % (args.port, urllib.parse.quote(token))
    if target:
        url += "#" + urllib.parse.quote(str(target))

    if port_in_use(args.port):                      # 已经有一个在跑，不再起第二个
        active = handoff(args.port, token, str(target) if target else "")
        if not active and not args.no_browser:
            webbrowser.open(url)
        print("已交给运行中的 mdreader")
        return 0

    httpd = Server(("127.0.0.1", args.port), Handler)
    print("  mdreader 已启动")
    print("  地址:   %s" % url)
    print("  根目录: %s" % STATE["root"])
    print("  关掉这个窗口即可退出\n")
    if not args.no_browser:
        threading.Timer(0.4, webbrowser.open, args=(url,)).start()
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\n已退出")
    finally:
        prefs["root"] = STATE["root"]
        save_prefs(prefs)
    return 0


if __name__ == "__main__":
    sys.exit(main())
