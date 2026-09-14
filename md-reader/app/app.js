/* mdreader —— 前端主逻辑 */
(function () {
'use strict';

var $ = function (s) { return document.querySelector(s); };
var TOKEN = new URLSearchParams(location.search).get('t') || '';

var S = {
  root: '',
  cur: null,            // { path, name, dir, mtime }
  headings: [],
  history: [],
  hIdx: -1,
  searching: false,
  treeData: null
};

/* ------------------------------------------------ 基础工具 */
function api(path, params) {
  var u = new URL(path, location.origin);
  u.searchParams.set('t', TOKEN);
  Object.keys(params || {}).forEach(function (k) {
    if (params[k] !== undefined && params[k] !== null) u.searchParams.set(k, params[k]);
  });
  return u.toString();
}

function get(path, params) {
  return fetch(api(path, params)).then(function (r) { return r.json(); });
}

function toast(msg, ms) {
  var t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toast._t);
  toast._t = setTimeout(function () { t.classList.remove('show'); }, ms || 1800);
}

function esc(s) {
  return String(s).replace(/[&<>"']/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
  });
}

/** Windows 路径拼接：把文档里的相对路径解析成绝对路径 */
function joinPath(dir, rel) {
  try { rel = decodeURIComponent(rel); } catch (e) { /* 原样使用 */ }
  rel = rel.replace(/^file:\/\/\/?/i, '');          // Typora 有时把图片存成 file:/// 绝对路径
  rel = rel.replace(/\\/g, '/');
  if (/^[a-zA-Z]:\//.test(rel) || rel.indexOf('//') === 0) return rel.replace(/\//g, '\\');
  var stack = dir.replace(/\\/g, '/').replace(/\/+$/, '').split('/');
  rel.split('/').forEach(function (seg) {
    if (!seg || seg === '.') return;
    if (seg === '..') { if (stack.length > 1) stack.pop(); }
    else stack.push(seg);
  });
  return stack.join('/').replace(/\//g, '\\');
}

function baseName(p) { return p.replace(/[\\/]+$/, '').split(/[\\/]/).pop(); }

var LS = {
  get: function (k, d) {
    try { var v = localStorage.getItem('md.' + k); return v === null ? d : JSON.parse(v); }
    catch (e) { return d; }
  },
  set: function (k, v) { try { localStorage.setItem('md.' + k, JSON.stringify(v)); } catch (e) {} }
};

/* ------------------------------------------------ Markdown 预处理
   顺序很重要：先摘出 front matter / 脚注 / 公式，再交给 marked，
   否则 $x_1$ 里的下划线会被当成斜体。*/

function preprocess(src) {
  var meta = '';
  var fm = /^﻿?---\r?\n([\s\S]*?)\r?\n---\s*(\r?\n|$)/.exec(src);
  if (fm) { meta = fm[1]; src = src.slice(fm[0].length); }

  var maths = [];
  var refs = [];           // 正文里出现的脚注引用，按出现顺序
  var notes = [];          // { id, md }
  var noteIdx = {};
  var lines = src.replace(/\r\n/g, '\n').split('\n');
  var out = [];
  var inFence = false, fenceCh = '', fenceLen = 0;
  var inMath = false, mathBuf = [];
  var lastNote = null;

  for (var i = 0; i < lines.length; i++) {
    var line = lines[i];

    /* 代码围栏原样保留 */
    var f = /^\s{0,3}(`{3,}|~{3,})/.exec(line);
    if (f) {
      if (!inFence) { inFence = true; fenceCh = f[1][0]; fenceLen = f[1].length; }
      else if (f[1][0] === fenceCh && f[1].length >= fenceLen) { inFence = false; }
      out.push(line); lastNote = null; continue;
    }
    if (inFence) { out.push(line); continue; }

    /* 跨行块级公式 $$ ... $$ */
    if (inMath) {
      if (/\$\$\s*$/.test(line)) {
        mathBuf.push(line.replace(/\$\$\s*$/, ''));
        out.push(ph('MATH', maths.push({ tex: mathBuf.join('\n'), block: true }) - 1));
        inMath = false; mathBuf = [];
      } else mathBuf.push(line);
      continue;
    }
    var t = line.trim();
    if (/^\$\$/.test(t)) {
      var one = /^\$\$([\s\S]+)\$\$$/.exec(t);
      if (one) {
        out.push(ph('MATH', maths.push({ tex: one[1], block: true }) - 1));
      } else {
        inMath = true; mathBuf = [t.replace(/^\$\$/, '')];
      }
      lastNote = null; continue;
    }

    /* 脚注定义  [^1]: 内容 */
    var def = /^\[\^([^\]\s]+)\]:\s?([\s\S]*)$/.exec(line);
    if (def) {
      noteIdx[def[1]] = notes.length + 1;
      notes.push({ id: def[1], md: def[2] });
      lastNote = notes[notes.length - 1];
      continue;
    }
    if (lastNote && /^(\s{4,}|\t)/.test(line)) {       // 脚注的续行
      lastNote.md += '\n' + line.replace(/^(\s{4}|\t)/, '');
      continue;
    }
    if (lastNote && t === '') { lastNote = null; }

    out.push(scanInline(line, maths, refs));
  }
  if (inMath) out.push(mathBuf.join('\n'));            // 没闭合就当普通文本

  return { meta: meta, src: out.join('\n'), maths: maths,
           refs: refs, notes: notes, noteIdx: noteIdx };
}

function ph(kind, n) { return 'zZ' + kind + n + 'Zz'; }

/** 处理一行里的行内代码、行内公式、脚注引用 */
function scanInline(line, maths, refs) {
  var res = '', i = 0, n = line.length;
  while (i < n) {
    var c = line[i];

    if (c === '\\' && i + 1 < n) { res += line[i] + line[i + 1]; i += 2; continue; }

    if (c === '`') {                                   // 行内代码整段跳过
      var m = /^(`+)/.exec(line.slice(i))[1];
      var end = line.indexOf(m, i + m.length);
      if (end === -1) { res += line.slice(i); break; }
      res += line.slice(i, end + m.length);
      i = end + m.length; continue;
    }

    if (c === '$') {                                   // 行内公式 $...$
      var close = -1;
      for (var j = i + 1; j < n; j++) {
        if (line[j] === '\\') { j++; continue; }
        if (line[j] === '$') { close = j; break; }
      }
      var body = close > -1 ? line.slice(i + 1, close) : '';
      if (close > -1 && body.trim() && !/^\s/.test(body) && !/\s$/.test(body) && !/^\d+([,.]\d+)?$/.test(body)) {
        res += ph('MATH', maths.push({ tex: body, block: false }) - 1);
        i = close + 1; continue;
      }
      res += c; i++; continue;
    }

    if (c === '[' && line[i + 1] === '^') {             // 脚注引用
      var e = line.indexOf(']', i + 2);
      if (e > -1) {
        res += ph('FNREF', refs.push(line.slice(i + 2, e)) - 1);
        i = e + 1; continue;
      }
    }

    res += c; i++;
  }
  return res;
}

/* ------------------------------------------------ 渲染 */
marked.setOptions({ gfm: true, breaks: false, pedantic: false });

function renderMarkdown(src) {
  var pre = preprocess(src);
  var html = marked.parse(pre.src);

  /* 还原公式 */
  html = html.replace(/zZMATH(\d+)Zz/g, function (_, n) {
    var m = pre.maths[+n];
    if (!m) return '';
    try {
      return katex.renderToString(m.tex, { displayMode: m.block, throwOnError: false, output: 'html' });
    } catch (e) {
      return '<code class="math-err">' + esc(m.tex) + '</code>';
    }
  });

  /* 还原脚注引用 */
  html = html.replace(/zZFNREF(\d+)Zz/g, function (_, n) {
    var id = pre.refs[+n];
    var num = pre.noteIdx[id];
    if (!num) return '[^' + esc(id) + ']';
    return '<sup><a class="fn-ref" id="fnref-' + esc(id) + '" href="#fn-' + esc(id) + '">[' + num + ']</a></sup>';
  });

  /* 脚注区 */
  if (pre.notes.length) {
    html += '<section class="footnotes"><ol>' + pre.notes.map(function (nt) {
      var body = marked.parse(nt.md || '').trim();
      var back = '<a class="fn-back" href="#fnref-' + esc(nt.id) + '" title="回到正文">↩</a>';
      body = /<\/p>$/.test(body) ? body.replace(/<\/p>$/, back + '</p>') : body + back;
      return '<li id="fn-' + esc(nt.id) + '">' + body + '</li>';
    }).join('') + '</ol></section>';
  }

  if (pre.meta.trim()) {
    html = '<div class="front-matter">' + esc(pre.meta.trim()) + '</div>' + html;
  }
  return html;
}

/* ------------------------------------------------ 渲染后的 DOM 加工 */
function slugify(text, used) {
  var base = text.toLowerCase().trim()
    .replace(/[\s]+/g, '-')
    .replace(/[^\w一-龥\-]/g, '') || 'h';
  var s = base, k = 1;
  while (used[s]) { s = base + '-' + (++k); }
  used[s] = true;
  return s;
}

function enhance(root, docDir) {
  var used = {};
  S.headings = [];

  root.querySelectorAll('h1,h2,h3,h4,h5,h6').forEach(function (h) {
    if (!h.id) h.id = slugify(h.textContent, used); else used[h.id] = true;
    S.headings.push({ el: h, level: +h.tagName[1], text: h.textContent });
  });

  root.querySelectorAll('img').forEach(function (img) {
    var src = img.getAttribute('src') || '';
    if (/^https?:/i.test(src)) {
      img.referrerPolicy = 'no-referrer';           // 绕过 CSDN / 知乎等图床的防盗链
    } else if (!/^(data:|blob:)/i.test(src)) {
      img.src = api('/api/raw', { p: joinPath(docDir, src) });
    }
    img.addEventListener('error', function () {
      var span = document.createElement('span');
      span.className = 'img-broken';
      span.textContent = '🖼 图片缺失：' + src;
      img.replaceWith(span);
    });
    img.addEventListener('click', function () {
      $('#lightbox-img').src = img.src;
      $('#lightbox').classList.remove('hidden');
    });
  });

  root.querySelectorAll('a[href]').forEach(function (a) {
    var href = a.getAttribute('href') || '';
    if (/^(https?:|mailto:)/i.test(href)) {
      a.target = '_blank'; a.rel = 'noopener'; a.classList.add('ext');
    } else if (href.charAt(0) === '#') {
      a.addEventListener('click', function (e) {
        e.preventDefault();
        var el = document.getElementById(decodeURIComponent(href.slice(1)));
        if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
      });
    } else if (href) {
      var hash = '', hi = href.indexOf('#');
      if (hi > -1) { hash = href.slice(hi + 1); href = href.slice(0, hi); }
      var abs = joinPath(docDir, href);
      a.addEventListener('click', function (e) {
        e.preventDefault();
        if (/\.(md|markdown|mdx|txt)$/i.test(abs) || abs.indexOf('.') === -1) openDoc(abs, { anchor: hash });
        else window.open(api('/api/raw', { p: abs }), '_blank');
      });
    }
  });

  root.querySelectorAll('li > input[type=checkbox]').forEach(function (cb) {
    cb.parentElement.classList.add('task');
  });

  root.querySelectorAll('pre > code').forEach(function (code) {
    var lang = (code.className.match(/language-([\w+#-]+)/) || [])[1] || '';
    if (lang === 'mermaid') return renderMermaid(code);

    if (lang && hljs.getLanguage(lang)) {
      try { hljs.highlightElement(code); } catch (e) { /* 保持纯文本 */ }
    }
    var pre = code.parentElement;
    var wrap = document.createElement('div');
    wrap.className = 'code-wrap';
    pre.replaceWith(wrap);
    wrap.appendChild(pre);
    if (lang) {
      var tag = document.createElement('span');
      tag.className = 'lang'; tag.textContent = lang;
      wrap.appendChild(tag);
    }
    var btn = document.createElement('button');
    btn.className = 'copy'; btn.textContent = '复制';
    btn.addEventListener('click', function () {
      navigator.clipboard.writeText(code.textContent).then(function () {
        btn.textContent = '已复制';
        setTimeout(function () { btn.textContent = '复制'; }, 1200);
      });
    });
    wrap.appendChild(btn);
  });
}

/* mermaid 体积大，用到才加载 */
var mermaidP = null;
function loadMermaid() {
  if (!mermaidP) {
    mermaidP = new Promise(function (res, rej) {
      var s = document.createElement('script');
      s.src = '/vendor/mermaid.min.js';
      s.onload = function () { res(window.mermaid); };
      s.onerror = rej;
      document.head.appendChild(s);
    });
  }
  return mermaidP;
}

var mmId = 0;
function renderMermaid(code) {
  var box = document.createElement('div');
  box.className = 'mermaid-box';
  box.textContent = '图表渲染中…';
  code.parentElement.replaceWith(box);
  var src = code.textContent;
  loadMermaid().then(function (mermaid) {
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: 'loose',
      theme: document.documentElement.dataset.theme === 'dark' ? 'dark' : 'default'
    });
    return mermaid.render('mm' + (++mmId), src);
  }).then(function (r) {
    box.innerHTML = r.svg;
  }).catch(function (err) {
    box.innerHTML = '<div class="mermaid-err">Mermaid 渲染失败：' + esc(String(err && err.message || err)) + '</div>';
  });
}

/* ------------------------------------------------ 打开文档 */
function openDoc(path, opt) {
  opt = opt || {};
  return get('/api/doc', { p: path }).then(function (d) {
    if (d.error) { toast(d.error); return; }

    var scroller = $('#scroller');
    var keepTop = opt.keepScroll ? scroller.scrollTop : null;

    S.cur = { path: d.path, name: d.name, dir: d.dir, mtime: d.mtime };
    var content = $('#content');
    content.innerHTML = renderMarkdown(d.content);
    enhance(content, d.dir);

    var short = d.name.replace(/\.(md|markdown|mdx|txt)$/i, '');
    $('#doc-title').textContent = short;
    $('#doc-title').title = d.path;
    document.title = short + ' — Markdown 阅读器';
    $('#stat-path').textContent = d.path;
    updateWordCount(d.content);
    buildOutline();
    markCurrentInTree();

    if (!opt.noHistory) pushHistory(d.path);
    if (!opt.keepScroll) addRecent(d.path, d.name);

    scroller.style.scrollBehavior = 'auto';
    if (keepTop !== null) scroller.scrollTop = keepTop;
    else if (opt.anchor) {
      var el = document.getElementById(opt.anchor);
      scroller.scrollTop = el ? el.offsetTop - 10 : 0;
    } else {
      scroller.scrollTop = LS.get('scroll:' + d.path, 0);
    }
    requestAnimationFrame(function () { scroller.style.scrollBehavior = ''; onScroll(); });

    location.hash = encodeURIComponent(d.path);
    startWatch();
  });
}

function updateWordCount(text) {
  var body = text.replace(/```[\s\S]*?```/g, '');
  var cjk = (body.match(/[一-龥぀-ヿ]/g) || []).length;
  var lat = (body.match(/[A-Za-z0-9_'-]+/g) || []).length;
  var total = cjk + lat;
  $('#stat-words').textContent = total.toLocaleString() + ' 字';
  $('#stat-read').textContent = '约 ' + Math.max(1, Math.round(total / 400)) + ' 分钟';
}

/* 文件被外部编辑器改动时自动刷新 */
var watchTimer = null;
function startWatch() {
  clearInterval(watchTimer);
  watchTimer = setInterval(function () {
    if (!S.cur) return;
    get('/api/stat', { p: S.cur.path }).then(function (r) {
      if (r.mtime && S.cur && r.mtime > S.cur.mtime + 0.001) {
        openDoc(S.cur.path, { keepScroll: true, noHistory: true }).then(function () {
          toast('文件已更新，已重新载入');
        });
      }
    }).catch(function () {});
  }, 1500);
}

/* ------------------------------------------------ 历史 */
function pushHistory(p) {
  if (S.history[S.hIdx] === p) return;
  S.history = S.history.slice(0, S.hIdx + 1);
  S.history.push(p);
  S.hIdx = S.history.length - 1;
  syncHistoryBtns();
}
function syncHistoryBtns() {
  $('#btn-back').disabled = S.hIdx <= 0;
  $('#btn-fwd').disabled = S.hIdx >= S.history.length - 1;
}
function goHistory(delta) {
  var i = S.hIdx + delta;
  if (i < 0 || i >= S.history.length) return;
  S.hIdx = i;
  openDoc(S.history[i], { noHistory: true });
  syncHistoryBtns();
}

/* ------------------------------------------------ 最近打开 */
function addRecent(path, name) {
  var list = LS.get('recents', []).filter(function (r) { return r.path !== path; });
  list.unshift({ path: path, name: name, time: Date.now() });
  LS.set('recents', list.slice(0, 40));
  renderRecent();
}
function renderRecent() {
  var list = LS.get('recents', []);
  var pane = $('#pane-recent');
  if (!list.length) { pane.innerHTML = '<div class="pane-tip">还没有打开过文件。</div>'; return; }
  pane.innerHTML = '';
  list.forEach(function (r) {
    var d = document.createElement('div');
    d.className = 'recent-item';
    d.innerHTML = '<div class="nm">' + esc(r.name) + '</div><div class="sub">' + esc(r.path) + '</div>';
    d.addEventListener('click', function () { openDoc(r.path); });
    pane.appendChild(d);
  });
}

/* ------------------------------------------------ 文件树 */
function loadTree(root) {
  return get('/api/tree', { p: root }).then(function (d) {
    if (d.error) { toast(d.error); return; }
    S.root = d.root;
    S.treeData = d.children;
    $('#root-name').textContent = d.name || d.root;
    $('#root-name').title = d.root;
    renderTree(d.children, '');
    LS.set('lastRoot', d.root);
  });
}

function renderTree(nodes, filter) {
  var pane = $('#pane-tree');
  pane.innerHTML = '';
  if (!nodes || !nodes.length) {
    pane.innerHTML = '<div class="pane-tip">这个文件夹里没有 Markdown 文件。</div>';
    return;
  }
  var frag = build(nodes, 0);
  if (!frag.childNodes.length) pane.innerHTML = '<div class="pane-tip">没有匹配的文件。</div>';
  else pane.appendChild(frag);

  function build(list, depth) {
    var frag = document.createDocumentFragment();
    list.forEach(function (nd) {
      if (nd.type === 'dir') {
        var kids = build(nd.children, depth + 1);
        if (filter && !kids.childNodes.length) return;
        var row = mkRow(nd, depth, true);
        var box = document.createElement('div');
        box.className = 'children';
        box.appendChild(kids);
        var collapsed = !filter && LS.get('fold:' + nd.path, false);
        if (collapsed) { row.classList.add('collapsed'); box.classList.add('collapsed'); }
        row.addEventListener('click', function () {
          var now = box.classList.toggle('collapsed');
          row.classList.toggle('collapsed', now);
          LS.set('fold:' + nd.path, now);
        });
        frag.appendChild(row); frag.appendChild(box);
      } else {
        if (filter && nd.name.toLowerCase().indexOf(filter) === -1) return;
        var r = mkRow(nd, depth, false);
        r.addEventListener('click', function () { openDoc(nd.path); });
        frag.appendChild(r);
      }
    });
    return frag;
  }

  function mkRow(nd, depth, isDir) {
    var row = document.createElement('div');
    row.className = 'node' + (isDir ? ' dir' : ' file');
    row.dataset.path = nd.path;
    row.style.paddingLeft = (6 + depth * 12) + 'px';
    row.innerHTML = (isDir ? '<span class="arrow">▼</span>' : '<span class="arrow"></span>') +
                    '<span class="ic">' + (isDir ? '📁' : '📝') + '</span>' +
                    '<span class="nm">' + esc(nd.name.replace(/\.(md|markdown|mdx|txt)$/i, '')) + '</span>';
    row.title = nd.path;
    return row;
  }
  markCurrentInTree();
}

function markCurrentInTree() {
  document.querySelectorAll('#pane-tree .node.current').forEach(function (n) { n.classList.remove('current'); });
  if (!S.cur) return;
  var el = document.querySelector('#pane-tree .node.file[data-path="' + CSS.escape(S.cur.path) + '"]');
  if (el) {
    el.classList.add('current');
    var par = el.parentElement;
    while (par && par.classList) {                   // 展开所在目录
      if (par.classList.contains('children')) par.classList.remove('collapsed');
      par = par.parentElement;
    }
  }
}

/* ------------------------------------------------ 大纲 */
function buildOutline() {
  var pane = $('#pane-outline');
  pane.innerHTML = '';
  if (!S.headings.length) { pane.innerHTML = '<div class="pane-tip">本文没有标题。</div>'; return; }
  S.headings.forEach(function (h, i) {
    var a = document.createElement('div');
    a.className = 'toc-item';
    a.dataset.lv = h.level;
    a.dataset.i = i;
    a.textContent = h.text;
    a.title = h.text;
    a.addEventListener('click', function () {
      h.el.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
    pane.appendChild(a);
  });
}

function onScroll() {
  var sc = $('#scroller');
  var max = sc.scrollHeight - sc.clientHeight;
  $('#progress-bar').style.width = (max > 0 ? (sc.scrollTop / max * 100) : 0) + '%';

  if (S.cur) {
    clearTimeout(onScroll._s);
    onScroll._s = setTimeout(function () { LS.set('scroll:' + S.cur.path, sc.scrollTop); }, 400);
  }

  var idx = -1;
  for (var i = 0; i < S.headings.length; i++) {
    if (S.headings[i].el.getBoundingClientRect().top <= 120) idx = i; else break;
  }
  var items = $('#pane-outline').children;
  for (var j = 0; j < items.length; j++) items[j].classList.toggle('active', +items[j].dataset.i === idx);
  if (idx > -1 && items[idx] && !onScroll._hold) {
    var it = items[idx], pane = $('#pane-outline');
    if (it.offsetTop < pane.scrollTop || it.offsetTop > pane.scrollTop + pane.clientHeight - 30) {
      pane.scrollTop = it.offsetTop - pane.clientHeight / 2;
    }
  }
}

/* ------------------------------------------------ 文内查找 */
var FIND = { hits: [], idx: -1 };

function clearMarks() {
  var c = $('#content');
  c.querySelectorAll('mark.hit').forEach(function (m) {
    m.replaceWith(document.createTextNode(m.textContent));
  });
  c.normalize();
  FIND.hits = []; FIND.idx = -1;
}

function runFind(q) {
  clearMarks();
  if (!q) { $('#find-count').textContent = '0/0'; return; }
  var needle = q.toLowerCase();
  var walker = document.createTreeWalker($('#content'), NodeFilter.SHOW_TEXT, {
    acceptNode: function (n) {
      if (!n.nodeValue.trim()) return NodeFilter.FILTER_REJECT;
      var p = n.parentElement;
      if (!p || /^(SCRIPT|STYLE)$/.test(p.tagName) || p.closest('.katex')) return NodeFilter.FILTER_REJECT;
      return n.nodeValue.toLowerCase().indexOf(needle) > -1
        ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
    }
  });
  var targets = [], n;
  while ((n = walker.nextNode())) targets.push(n);

  targets.forEach(function (node) {
    var text = node.nodeValue, low = text.toLowerCase(), pos = 0;
    var frag = document.createDocumentFragment(), hit;
    while ((hit = low.indexOf(needle, pos)) > -1) {
      if (hit > pos) frag.appendChild(document.createTextNode(text.slice(pos, hit)));
      var m = document.createElement('mark');
      m.className = 'hit';
      m.textContent = text.substr(hit, q.length);
      frag.appendChild(m);
      pos = hit + q.length;
    }
    if (pos < text.length) frag.appendChild(document.createTextNode(text.slice(pos)));
    node.parentNode.replaceChild(frag, node);
  });

  FIND.hits = Array.prototype.slice.call($('#content').querySelectorAll('mark.hit'));
  if (FIND.hits.length) stepFind(0, true);
  else $('#find-count').textContent = '0/0';
}

function stepFind(delta, absolute) {
  if (!FIND.hits.length) return;
  if (FIND.idx > -1 && FIND.hits[FIND.idx]) FIND.hits[FIND.idx].classList.remove('cur');
  FIND.idx = absolute ? 0 : (FIND.idx + delta + FIND.hits.length) % FIND.hits.length;
  var el = FIND.hits[FIND.idx];
  el.classList.add('cur');
  el.scrollIntoView({ behavior: 'smooth', block: 'center' });
  $('#find-count').textContent = (FIND.idx + 1) + '/' + FIND.hits.length;
}

function openFind() {
  $('#findbar').classList.remove('hidden');
  var inp = $('#find-input');
  inp.focus(); inp.select();
  if (inp.value) runFind(inp.value);
}
function closeFind() {
  $('#findbar').classList.add('hidden');
  clearMarks();
  $('#scroller').focus();
}

/* ------------------------------------------------ 全文搜索 */
function runSearch(kw) {
  if (!S.root) { toast('先打开一个文件夹'); return; }
  S.searching = true;
  var pane = $('#pane-tree');
  pane.innerHTML = '<div class="pane-tip">搜索中…</div>';
  get('/api/search', { p: S.root, q: kw }).then(function (d) {
    pane.innerHTML = '';
    var head = document.createElement('div');
    head.className = 'pane-tip';
    head.innerHTML = '“' + esc(kw) + '” 命中 ' + d.hits.length + ' 个文件 · <a href="#" id="back-tree">返回文件树</a>';
    pane.appendChild(head);
    head.querySelector('#back-tree').addEventListener('click', function (e) {
      e.preventDefault(); $('#filter').value = ''; S.searching = false;
      renderTree(S.treeData, '');
    });
    d.hits.forEach(function (h) {
      var el = document.createElement('div');
      el.className = 'hit-item';
      var low = h.text.toLowerCase(), at = low.indexOf(kw.toLowerCase());
      var snippet = at > -1
        ? esc(h.text.slice(Math.max(0, at - 24), at)) + '<b>' + esc(h.text.substr(at, kw.length)) + '</b>' +
          esc(h.text.slice(at + kw.length, at + kw.length + 50))
        : esc(h.text.slice(0, 70));
      el.innerHTML = '<div class="nm">' + esc(h.name) + '</div><div class="sub">' + snippet + '</div>';
      el.title = h.path + ' : ' + h.line;
      el.addEventListener('click', function () {
        openDoc(h.path).then(function () {
          $('#find-input').value = kw; openFind();
        });
      });
      pane.appendChild(el);
    });
    if (!d.hits.length) pane.appendChild(Object.assign(document.createElement('div'),
      { className: 'pane-tip', textContent: '没有找到。' }));
  });
}

/* ------------------------------------------------ 外观 */
function applyTheme() {
  var mode = LS.get('theme', 'light');
  var dark = mode === 'dark' || (mode === 'auto' &&
    window.matchMedia('(prefers-color-scheme: dark)').matches);
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  $('#hljs-light').disabled = dark;
  $('#hljs-dark').disabled = !dark;
  $('#btn-theme').textContent = mode === 'auto' ? '◑' : (dark ? '●' : '○');
  $('#btn-theme').title = '主题：' + { light: '浅色', dark: '深色', auto: '跟随系统' }[mode];
  applyPalette();
}

/* 背景调色：预设色板或自定义颜色，仅浅色模式下生效 */
var PALETTE_KEYS = ['bg', 'bg-side', 'bg-sunken', 'bg-hover', 'bg-active',
                    'border', 'code-bg', 'quote-bar'];

function shade(hex, delta) {           // 在 HSL 亮度上加减 delta 个百分点
  var n = parseInt(hex.slice(1), 16);
  var r = (n >> 16 & 255) / 255, g = (n >> 8 & 255) / 255, b = (n & 255) / 255;
  var mx = Math.max(r, g, b), mn = Math.min(r, g, b);
  var l = (mx + mn) / 2, d = mx - mn;
  var s = d === 0 ? 0 : d / (1 - Math.abs(2 * l - 1));
  var h = 0;
  if (d !== 0) {
    if (mx === r) h = ((g - b) / d) % 6;
    else if (mx === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h = (h * 60 + 360) % 360;
  }
  l = Math.max(0, Math.min(1, l + delta / 100));
  return 'hsl(' + h.toFixed(0) + ',' + (s * 100).toFixed(0) + '%,' + (l * 100).toFixed(1) + '%)';
}

function applyPalette() {
  var v = LS.get('palette', 'default');
  var el = document.documentElement;
  PALETTE_KEYS.forEach(function (k) { el.style.removeProperty('--' + k); });
  var custom = typeof v === 'string' && v.charAt(0) === '#';
  el.dataset.palette = custom ? 'custom' : v;
  if (custom && el.dataset.theme !== 'dark') {
    [['bg', 0], ['bg-side', -3], ['bg-sunken', -5], ['bg-hover', -7], ['bg-active', -11],
     ['border', -9], ['code-bg', -4], ['quote-bar', -14]].forEach(function (p) {
      el.style.setProperty('--' + p[0], shade(v, p[1]));
    });
  }
  document.querySelectorAll('#palette-pop .sw[data-p]').forEach(function (b) {
    b.classList.toggle('on', b.dataset.p === v);
  });
}

function applySizes() {
  document.documentElement.style.setProperty('--fs', LS.get('fs', 16) + 'px');
  var w = LS.get('width', 860);
  $('#content').classList.toggle('w-full', w === 0);
  if (w) document.documentElement.style.setProperty('--content-w', w + 'px');
  document.body.classList.toggle('no-sidebar', !LS.get('sidebar', true));
  var sw = LS.get('sidebarW', 280);
  $('#sidebar').style.width = sw + 'px';
}

/* ------------------------------------------------ 事件绑定 */
function bind() {
  $('#btn-folder').addEventListener('click', function () {
    toast('请在弹出的窗口里选择文件夹', 2600);
    get('/api/pick', { kind: 'dir' }).then(function (r) { if (r.path) loadTree(r.path); });
  });
  $('#btn-file').addEventListener('click', function () {
    toast('请在弹出的窗口里选择文件', 2600);
    get('/api/pick', { kind: 'file' }).then(function (r) {
      if (!r.path) return;
      openDoc(r.path);
      if (!S.root) loadTree(r.path.replace(/[\\/][^\\/]+$/, ''));
    });
  });
  $('#btn-refresh').addEventListener('click', function () {
    if (S.root) loadTree(S.root).then(function () { toast('已刷新'); });
  });
  $('#btn-reveal').addEventListener('click', function () {
    if (S.cur) get('/api/reveal', { p: S.cur.path });
  });
  $('#btn-print').addEventListener('click', function () { window.print(); });
  $('#btn-back').addEventListener('click', function () { goHistory(-1); });
  $('#btn-fwd').addEventListener('click', function () { goHistory(1); });

  $('#btn-sidebar').addEventListener('click', function () {
    LS.set('sidebar', !LS.get('sidebar', true)); applySizes();
  });
  $('#btn-theme').addEventListener('click', function () {
    var order = ['light', 'dark', 'auto'];
    var next = order[(order.indexOf(LS.get('theme', 'light')) + 1) % 3];
    LS.set('theme', next); applyTheme();
    if (S.cur && $('#content').querySelector('.mermaid-box')) {
      openDoc(S.cur.path, { keepScroll: true, noHistory: true });
    }
  });
  $('#btn-palette').addEventListener('click', function (e) {
    e.stopPropagation();
    $('#palette-pop').classList.toggle('hidden');
  });
  document.querySelectorAll('#palette-pop .sw[data-p]').forEach(function (b) {
    b.addEventListener('click', function () {
      LS.set('palette', b.dataset.p); applyPalette();
    });
  });
  $('#palette-custom').addEventListener('input', function () {
    LS.set('palette', this.value); applyPalette();
  });
  document.addEventListener('click', function (e) {
    var pop = $('#palette-pop');
    if (!pop.classList.contains('hidden') && !pop.contains(e.target) &&
        e.target !== $('#btn-palette')) pop.classList.add('hidden');
  });

  $('#btn-fsinc').addEventListener('click', function () {
    LS.set('fs', Math.min(26, LS.get('fs', 16) + 1)); applySizes();
  });
  $('#btn-fsdec').addEventListener('click', function () {
    LS.set('fs', Math.max(12, LS.get('fs', 16) - 1)); applySizes();
  });
  $('#btn-width').addEventListener('click', function () {
    var opts = [720, 860, 1040, 0];
    var next = opts[(opts.indexOf(LS.get('width', 860)) + 1) % opts.length];
    LS.set('width', next); applySizes();
    toast(next ? '正文宽度 ' + next + 'px' : '正文宽度：铺满');
  });

  /* 标签页 */
  document.querySelectorAll('.tab').forEach(function (tab) {
    tab.addEventListener('click', function () {
      document.querySelectorAll('.tab').forEach(function (t) { t.classList.remove('active'); });
      tab.classList.add('active');
      ['pane-tree', 'pane-outline', 'pane-recent'].forEach(function (id) {
        $('#' + id).classList.toggle('hidden', id !== tab.dataset.pane);
      });
      $('#filter-row').classList.toggle('hidden', tab.dataset.pane !== 'pane-tree');
    });
  });

  /* 筛选 / 搜索 */
  var fi = $('#filter');
  fi.addEventListener('input', function () {
    if (S.searching && !fi.value) { S.searching = false; }
    if (!S.searching) renderTree(S.treeData, fi.value.trim().toLowerCase());
  });
  fi.addEventListener('keydown', function (e) {
    if (e.key === 'Enter' && fi.value.trim()) runSearch(fi.value.trim());
    if (e.key === 'Escape') { fi.value = ''; S.searching = false; renderTree(S.treeData, ''); fi.blur(); }
  });

  /* 查找条 */
  $('#find-input').addEventListener('input', function (e) { runFind(e.target.value); });
  $('#find-input').addEventListener('keydown', function (e) {
    if (e.key === 'Enter') { e.preventDefault(); stepFind(e.shiftKey ? -1 : 1); }
    if (e.key === 'Escape') closeFind();
  });
  $('#find-next').addEventListener('click', function () { stepFind(1); });
  $('#find-prev').addEventListener('click', function () { stepFind(-1); });
  $('#find-close').addEventListener('click', closeFind);
  $('#btn-find').addEventListener('click', openFind);

  $('#lightbox').addEventListener('click', function () { $('#lightbox').classList.add('hidden'); });
  $('#scroller').addEventListener('scroll', onScroll, { passive: true });

  /* 侧栏宽度拖拽 */
  var dragging = false;
  $('#resizer').addEventListener('mousedown', function (e) { dragging = true; e.preventDefault(); });
  window.addEventListener('mousemove', function (e) {
    if (!dragging) return;
    var w = Math.max(180, Math.min(560, e.clientX));
    $('#sidebar').style.width = w + 'px';
  });
  window.addEventListener('mouseup', function () {
    if (!dragging) return;
    dragging = false;
    LS.set('sidebarW', parseInt($('#sidebar').style.width, 10) || 280);
  });

  /* 快捷键 */
  window.addEventListener('keydown', function (e) {
    var ctrl = e.ctrlKey || e.metaKey;
    var typing = /^(INPUT|TEXTAREA)$/.test(e.target.tagName);

    if (ctrl && e.key.toLowerCase() === 'f') { e.preventDefault(); openFind(); return; }
    if (ctrl && e.key.toLowerCase() === 'b') { e.preventDefault(); $('#btn-sidebar').click(); return; }
    if (ctrl && e.key.toLowerCase() === 'o') {
      e.preventDefault(); (e.shiftKey ? $('#btn-file') : $('#btn-folder')).click(); return;
    }
    if (ctrl && e.key.toLowerCase() === 'k') {
      e.preventDefault();
      if (!LS.get('sidebar', true)) $('#btn-sidebar').click();
      document.querySelector('.tab[data-pane="pane-tree"]').click();
      $('#filter').focus(); $('#filter').select(); return;
    }
    if (ctrl && (e.key === '=' || e.key === '+')) { e.preventDefault(); $('#btn-fsinc').click(); return; }
    if (ctrl && e.key === '-') { e.preventDefault(); $('#btn-fsdec').click(); return; }
    if (ctrl && e.key === '0') { e.preventDefault(); LS.set('fs', 16); applySizes(); return; }
    if (e.altKey && e.key === 'ArrowLeft') { e.preventDefault(); goHistory(-1); return; }
    if (e.altKey && e.key === 'ArrowRight') { e.preventDefault(); goHistory(1); return; }
    if (e.key === 'Escape' && !typing) {
      closeFind();
      $('#lightbox').classList.add('hidden');
      $('#palette-pop').classList.add('hidden');
      return;
    }
    if (e.key === 'F3') { e.preventDefault(); stepFind(e.shiftKey ? -1 : 1); }
  });

  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', function () {
    if (LS.get('theme', 'light') === 'auto') applyTheme();
  });
}

/* 另一次启动交接过来的文件 */
function pollPending() {
  setInterval(function () {
    get('/api/pending').then(function (d) {
      if (!d.open || !d.open.length) return;
      var p = d.open[d.open.length - 1];
      if (!p) return;
      if (/\.(md|markdown|mdx|txt)$/i.test(p)) {
        openDoc(p);
        var dir = p.replace(/[\\/][^\\/]+$/, '');
        if (dir !== S.root) loadTree(dir);
      } else {
        loadTree(p);
      }
      window.focus();
    }).catch(function () {});
  }, 1500);
}

/* ------------------------------------------------ 启动 */
function init() {
  applyTheme();
  applySizes();
  renderRecent();
  syncHistoryBtns();
  bind();
  pollPending();

  var hash = location.hash ? decodeURIComponent(location.hash.slice(1)) : '';
  var root = LS.get('lastRoot', '');

  if (hash) {
    openDoc(hash);
    loadTree(hash.replace(/[\\/][^\\/]+$/, ''));
  } else if (root) {
    loadTree(root);
  } else {
    get('/api/ping').then(function (r) { if (r.root) loadTree(r.root); });
  }
}

init();
})();
