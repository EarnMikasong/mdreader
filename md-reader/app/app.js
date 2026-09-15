/* mdreader —— 前端主逻辑 */
(function () {
'use strict';

var $ = function (s) { return document.querySelector(s); };
var TOKEN = new URLSearchParams(location.search).get('t') || '';

var S = {
  root: '',
  cur: null,            // { path, name, dir, mtime, digest }
  headings: [],
  history: [],
  hIdx: -1,
  searching: false,
  treeData: null,
  source: '',
  editing: false,
  editMode: null,       // null | visual（所见即所得）| source（Markdown 源码）
  dirty: false,
  diskChanged: false,
  saving: false
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

function post(path, body) {
  return fetch(api(path), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  }).then(function (r) {
    return r.json().catch(function () { return { error: '服务器返回了无效响应' }; })
      .then(function (d) {
        if (!r.ok) { d.status = r.status; throw d; }
        return d;
      });
  });
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
      return '<span class="md-math' + (m.block ? ' md-math-block' : '') +
        '" data-md-math="' + esc(m.tex) + '" data-md-block="' + (m.block ? '1' : '0') + '">' +
        katex.renderToString(m.tex, { displayMode: m.block, throwOnError: false, output: 'html' }) + '</span>';
    } catch (e) {
      return '<code class="math-err">' + esc(m.tex) + '</code>';
    }
  });

  /* 还原脚注引用 */
  html = html.replace(/zZFNREF(\d+)Zz/g, function (_, n) {
    var id = pre.refs[+n];
    var num = pre.noteIdx[id];
    if (!num) return '[^' + esc(id) + ']';
    return '<sup class="md-fn-ref" data-md-footnote="' + esc(id) + '"><a class="fn-ref" id="fnref-' +
      esc(id) + '" href="#fn-' + esc(id) + '">[' + num + ']</a></sup>';
  });

  /* 脚注区 */
  if (pre.notes.length) {
    var noteSource = pre.notes.map(function (nt) {
      var noteLines = String(nt.md || '').split('\n');
      return '[^' + nt.id + ']: ' + noteLines[0] + noteLines.slice(1).map(function (line) {
        return '\n    ' + line;
      }).join('');
    }).join('\n\n');
    html += '<section class="footnotes md-protected" data-md-source="' + esc(noteSource) + '"><ol>' + pre.notes.map(function (nt) {
      var body = marked.parse(nt.md || '').trim();
      var back = '<a class="fn-back" href="#fnref-' + esc(nt.id) + '" title="回到正文">↩</a>';
      body = /<\/p>$/.test(body) ? body.replace(/<\/p>$/, back + '</p>') : body + back;
      return '<li id="fn-' + esc(nt.id) + '">' + body + '</li>';
    }).join('') + '</ol></section>';
  }

  if (pre.meta.trim()) {
    html = '<div class="front-matter md-protected" data-md-source="---\n' + esc(pre.meta.trim()) +
      '\n---">' + esc(pre.meta.trim()) + '</div>' + html;
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
    img.dataset.mdSrc = src;
    if (/^https?:/i.test(src)) {
      img.referrerPolicy = 'no-referrer';           // 绕过 CSDN / 知乎等图床的防盗链
    } else if (!/^(data:|blob:)/i.test(src)) {
      img.src = api('/api/raw', { p: joinPath(docDir, src) });
    }
    img.addEventListener('error', function () {
      var span = document.createElement('span');
      span.className = 'img-broken';
      span.dataset.mdImage = src;
      span.dataset.mdAlt = img.alt || '';
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
    a.dataset.mdHref = href;
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
  box.classList.add('md-protected');
  box.dataset.mdMermaid = code.textContent;
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

/* ------------------------------------------------ 编辑 / 保存 */
function updateEditStatus() {
  var stat = $('#stat-edit');
  var modeName = S.editMode === 'visual' ? '所见编辑' : '源码编辑';
  stat.textContent = S.saving ? '保存中…' : (S.editing
    ? (S.dirty ? '● 未保存 · ' + modeName : '已保存 · ' + modeName)
    : (S.cur ? '点击正文直接编辑' : ''));
  stat.classList.toggle('dirty', S.dirty);
  $('#btn-save').disabled = !S.dirty || S.saving;
  if (S.cur) {
    var short = S.cur.name.replace(/\.(md|markdown|mdx|txt)$/i, '');
    document.title = (S.dirty ? '● ' : '') + short + ' — Markdown 阅读器';
  }
}

function setEditorMode(mode) {
  S.editMode = mode || null;
  S.editing = !!mode;
  var visual = mode === 'visual';
  var source = mode === 'source';
  var content = $('#content');
  $('#scroller').classList.toggle('editing', source);
  content.classList.toggle('hidden', source);
  content.classList.toggle('visual-editing', visual);
  content.contentEditable = visual ? 'true' : 'false';
  $('#editor-wrap').classList.toggle('hidden', !source);
  $('#visual-tools').classList.toggle('hidden', !visual);
  $('#btn-save').classList.toggle('hidden', !mode);
  $('#btn-cancel').classList.toggle('hidden', !mode);
  $('#btn-source').classList.toggle('hidden', !S.cur);
  $('#btn-source').textContent = source ? '所见' : '源码';
  $('#btn-source').title = source ? '切换所见编辑  Ctrl+E' : '切换 Markdown 源码编辑  Ctrl+E';
  $('#btn-find').disabled = !!mode;
  $('#btn-print').disabled = !!mode;
  content.querySelectorAll('.md-protected, .md-math, img, .copy, .lang').forEach(function (el) {
    if (visual) el.contentEditable = 'false';
    else el.removeAttribute('contenteditable');
  });
  updateEditStatus();
}

function fallbackSourceOffset() {
  var scroller = $('#scroller');
  var max = Math.max(1, scroller.scrollHeight - scroller.clientHeight);
  var pos = Math.round(S.source.length * scroller.scrollTop / max);
  var lineStart = S.source.lastIndexOf('\n', pos);
  return lineStart < 0 ? 0 : lineStart + 1;
}

function sourceOffsetForNode(node) {
  if (!node) return fallbackSourceOffset();
  var text = (node.textContent || '').replace(/\s+/g, ' ').trim();
  if (!text) return fallbackSourceOffset();
  var lengths = [64, 40, 24, 12, 6];
  for (var i = 0; i < lengths.length; i++) {
    var needle = text.slice(0, lengths[i]);
    if (needle.length < Math.min(6, text.length)) continue;
    var at = S.source.indexOf(needle);
    if (at > -1) return at;
  }
  return fallbackSourceOffset();
}

function enterSourceEdit(position) {
  if (!S.cur) return;
  if (S.editMode === 'source') { $('#editor').focus(); return; }
  var source = S.editMode === 'visual' ? visualToMarkdown() : S.source;
  $('#editor').value = source;
  S.dirty = source !== S.source;
  if (!S.editing) S.diskChanged = false;
  setEditorMode('source');
  var editor = $('#editor');
  var pos = Math.max(0, Math.min(typeof position === 'number' ? position : 0, source.length));
  editor.focus();
  editor.setSelectionRange(pos, pos);
  var line = source.slice(0, pos).split('\n').length;
  var lineHeight = parseFloat(getComputedStyle(editor).lineHeight) || 28;
  editor.scrollTop = Math.max(0, (line - 4) * lineHeight);
}

function enterVisualEdit(x, y) {
  if (!S.cur) return;
  if (S.editMode === 'visual') { $('#content').focus(); return; }
  if (S.editMode === 'source') {
    var source = $('#editor').value;
    S.dirty = source !== S.source;
    renderSource(source, S.cur.dir);
  } else {
    S.dirty = false;
    S.diskChanged = false;
  }
  setEditorMode('visual');
  var content = $('#content');
  content.focus();
  if (typeof x === 'number' && typeof y === 'number') {
    var range = document.caretRangeFromPoint ? document.caretRangeFromPoint(x, y) : null;
    if (range && content.contains(range.startContainer)) {
      var sel = window.getSelection();
      sel.removeAllRanges(); sel.addRange(range);
    }
  }
}

function mdText(value) {
  return String(value || '').replace(/\u00a0/g, ' ').replace(/\s*\n\s*/g, ' ')
    .replace(/([\\`*_[\]<>])/g, '\\$1');
}

function inlineMarkdown(node) {
  if (node.nodeType === Node.TEXT_NODE) return mdText(node.nodeValue);
  if (node.nodeType !== Node.ELEMENT_NODE) return '';
  var el = node;
  if (el.classList.contains('copy') || el.classList.contains('lang') || el.classList.contains('fn-back')) return '';
  if (el.classList.contains('md-math')) {
    var tex = el.dataset.mdMath || '';
    return el.dataset.mdBlock === '1' ? '$$\n' + tex + '\n$$' : '$' + tex + '$';
  }
  if (el.classList.contains('md-fn-ref')) return '[^' + (el.dataset.mdFootnote || '') + ']';
  if (el.tagName === 'IMG') {
    return '![' + mdText(el.alt || '') + '](' + (el.dataset.mdSrc || el.getAttribute('src') || '') + ')';
  }
  if (el.classList.contains('img-broken') && el.dataset.mdImage) {
    return '![' + mdText(el.dataset.mdAlt || '') + '](' + el.dataset.mdImage + ')';
  }
  if (el.tagName === 'BR') return '  \n';
  var inner = Array.from(el.childNodes).map(inlineMarkdown).join('');
  if (/^(STRONG|B)$/.test(el.tagName)) return '**' + inner + '**';
  if (/^(EM|I)$/.test(el.tagName)) return '*' + inner + '*';
  if (/^(DEL|S|STRIKE)$/.test(el.tagName)) return '~~' + inner + '~~';
  if (el.tagName === 'CODE') {
    var ticks = inner.indexOf('`') > -1 ? '``' : '`';
    return ticks + inner + ticks;
  }
  if (el.tagName === 'A') {
    var href = el.dataset.mdHref || el.getAttribute('href') || '';
    return href.charAt(0) === '#' && el.classList.contains('fn-ref') ? inner : '[' + inner + '](' + href + ')';
  }
  return inner;
}

function listMarkdown(list, depth) {
  depth = depth || 0;
  var ordered = list.tagName === 'OL';
  var start = parseInt(list.getAttribute('start') || '1', 10);
  return Array.from(list.children).filter(function (el) { return el.tagName === 'LI'; }).map(function (li, index) {
    var nested = Array.from(li.children).filter(function (el) { return /^(UL|OL)$/.test(el.tagName); });
    var body = Array.from(li.childNodes).filter(function (node) {
      return !(node.nodeType === Node.ELEMENT_NODE && /^(UL|OL)$/.test(node.tagName));
    }).map(inlineMarkdown).join('').trim();
    var cb = li.querySelector(':scope > input[type="checkbox"]');
    if (cb) body = '[' + (cb.checked ? 'x' : ' ') + '] ' + body.replace(/^\[[ xX]\]\s*/, '');
    var prefix = ordered ? (start + index) + '. ' : '- ';
    var line = '  '.repeat(depth) + prefix + body;
    nested.forEach(function (child) { line += '\n' + listMarkdown(child, depth + 1); });
    return line;
  }).join('\n');
}

function tableMarkdown(table) {
  var rows = Array.from(table.querySelectorAll('tr')).map(function (tr) {
    return Array.from(tr.children).map(function (cell) {
      return inlineMarkdown(cell).trim().replace(/\|/g, '\\|');
    });
  });
  if (!rows.length) return '';
  var head = rows[0];
  var out = ['| ' + head.join(' | ') + ' |', '| ' + head.map(function () { return '---'; }).join(' | ') + ' |'];
  rows.slice(1).forEach(function (row) { out.push('| ' + row.join(' | ') + ' |'); });
  return out.join('\n');
}

function blockMarkdown(el) {
  if (el.nodeType === Node.TEXT_NODE) return mdText(el.nodeValue).trim();
  if (el.nodeType !== Node.ELEMENT_NODE) return '';
  if (el.dataset.mdSource) return el.dataset.mdSource;
  if (el.dataset.mdMermaid !== undefined) return '```mermaid\n' + el.dataset.mdMermaid + '\n```';
  if (el.classList.contains('code-wrap')) {
    var codeEl = el.querySelector('pre > code');
    var lang = codeEl && (codeEl.className.match(/language-([\w+#-]+)/) || [])[1] || '';
    return '```' + lang + '\n' + (codeEl ? codeEl.textContent.replace(/\n$/, '') : '') + '\n```';
  }
  if (el.tagName === 'PRE') {
    var code = el.querySelector('code');
    var codeLang = code && (code.className.match(/language-([\w+#-]+)/) || [])[1] || '';
    return '```' + codeLang + '\n' + (code ? code.textContent.replace(/\n$/, '') : el.textContent) + '\n```';
  }
  if (/^H[1-6]$/.test(el.tagName)) return '#'.repeat(+el.tagName[1]) + ' ' + inlineMarkdown(el).trim();
  if (el.tagName === 'P') {
    var onlyMath = el.children.length === 1 && el.firstElementChild.classList.contains('md-math-block');
    return onlyMath ? '$$\n' + (el.firstElementChild.dataset.mdMath || '') + '\n$$' : inlineMarkdown(el).trim();
  }
  if (/^(UL|OL)$/.test(el.tagName)) return listMarkdown(el, 0);
  if (el.tagName === 'BLOCKQUOTE') {
    return Array.from(el.children).map(blockMarkdown).join('\n\n').split('\n').map(function (line) {
      return '> ' + line;
    }).join('\n');
  }
  if (el.tagName === 'TABLE') return tableMarkdown(el);
  if (el.tagName === 'HR') return '---';
  if (el.tagName === 'SECTION' && el.classList.contains('footnotes')) return el.dataset.mdSource || '';
  var children = Array.from(el.children);
  if (children.some(function (child) { return /^(DIV|P|H[1-6]|UL|OL|PRE|BLOCKQUOTE|TABLE|HR|SECTION)$/.test(child.tagName); })) {
    return children.map(blockMarkdown).filter(Boolean).join('\n\n');
  }
  return inlineMarkdown(el).trim();
}

function visualToMarkdown() {
  return Array.from($('#content').childNodes).map(blockMarkdown).filter(function (part) {
    return part.trim() !== '';
  }).join('\n\n').replace(/[ \t]+\n/g, '\n').trim() + '\n';
}

function renderSource(source, dir) {
  var content = $('#content');
  content.innerHTML = renderMarkdown(source);
  enhance(content, dir);
  updateWordCount(source);
  buildOutline();
}

function saveDoc() {
  if (!S.cur || !S.editing || !S.dirty || S.saving) return Promise.resolve(false);
  S.saving = true;
  updateEditStatus();
  var mode = S.editMode;
  var source = mode === 'visual' ? visualToMarkdown() : $('#editor').value;
  return post('/api/save', {
    path: S.cur.path, content: source, mtime: S.cur.mtime, digest: S.cur.digest
  })
    .then(function (d) {
      S.source = source;
      S.cur.mtime = d.mtime;
      S.cur.digest = d.digest;
      S.dirty = false;
      S.diskChanged = false;
      renderSource(S.source, S.cur.dir);
      if (mode === 'visual') setEditorMode('visual');
      updateEditStatus();
      toast('已保存');
      return true;
    }).catch(function (err) {
      if (err && err.status === 409) S.diskChanged = true;
      toast(err && err.error || '保存失败，请稍后重试', 4200);
      return false;
    }).then(function (ok) {
      S.saving = false;
      updateEditStatus();
      return ok;
    });
}

function cancelEdit() {
  if (!S.editing) return;
  if (S.dirty && !window.confirm('当前修改尚未保存，确定放弃吗？')) return;
  var restoreVisual = S.editMode === 'visual' && S.dirty;
  var reload = S.diskChanged;
  S.dirty = false;
  S.diskChanged = false;
  setEditorMode(null);
  if (reload && S.cur) {
    openDoc(S.cur.path, { keepScroll: true, noHistory: true });
  } else if (restoreVisual && S.cur) {
    renderSource(S.source, S.cur.dir);
  } else {
    updateWordCount(S.source);
  }
}

/* ------------------------------------------------ 打开文档 */
function openDoc(path, opt) {
  opt = opt || {};
  if (S.dirty && !window.confirm('当前修改尚未保存，确定放弃并打开其他文档吗？')) {
    return Promise.resolve(false);
  }
  return get('/api/doc', { p: path }).then(function (d) {
    if (d.error) { toast(d.error); return; }

    var scroller = $('#scroller');
    var keepTop = opt.keepScroll ? scroller.scrollTop : null;

    S.cur = { path: d.path, name: d.name, dir: d.dir, mtime: d.mtime, digest: d.digest };
    S.source = d.content;
    S.dirty = false;
    S.diskChanged = false;
    setEditorMode(false);
    renderSource(d.content, d.dir);

    var short = d.name.replace(/\.(md|markdown|mdx|txt)$/i, '');
    $('#doc-title').textContent = short;
    $('#doc-title').title = d.path;
    document.title = short + ' — Markdown 阅读器';
    $('#stat-path').textContent = d.path;
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
    var watchedPath = S.cur.path;
    get('/api/stat', { p: watchedPath }).then(function (r) {
      if (r.mtime && S.cur && S.cur.path === watchedPath &&
          Math.abs(r.mtime - S.cur.mtime) > 0.001) {
        if (S.editing) {
          if (!S.diskChanged) toast('磁盘上的文件已变化，保存前请重新载入', 4200);
          S.diskChanged = true;
          return;
        }
        openDoc(watchedPath, { keepScroll: true, noHistory: true }).then(function () {
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
  $('#editor-wrap').classList.toggle('w-full', w === 0);
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
  $('#content').addEventListener('click', function (e) {
    if (!S.cur) return;
    if (S.editMode === 'visual') {
      if (e.target.closest('a, .copy, img')) { e.preventDefault(); e.stopPropagation(); }
      return;
    }
    if (S.editing) return;
    if (e.target.closest('a, button, input, img, .mermaid-box, .katex')) return;
    var block = e.target.closest(
      'h1, h2, h3, h4, h5, h6, p, li, pre, blockquote, table, .front-matter'
    );
    if (block) enterVisualEdit(e.clientX, e.clientY);
  });
  $('#content').addEventListener('dblclick', function (e) {
    if (S.editMode === 'visual' && e.target.closest('.md-protected, .md-math')) {
      e.preventDefault(); enterSourceEdit(sourceOffsetForNode(e.target.closest('.md-protected, .md-math')));
    }
  });
  $('#content').addEventListener('input', function () {
    if (S.editMode !== 'visual') return;
    S.dirty = visualToMarkdown() !== S.source;
    updateWordCount(this.innerText);
    updateEditStatus();
  });
  $('#btn-save').addEventListener('click', saveDoc);
  $('#btn-cancel').addEventListener('click', cancelEdit);
  $('#btn-source').addEventListener('click', function () {
    if (S.editMode === 'source') enterVisualEdit();
    else enterSourceEdit(S.editing ? fallbackSourceOffset() : 0);
  });
  $('#editor').addEventListener('input', function () {
    S.dirty = this.value !== S.source;
    updateWordCount(this.value);
    updateEditStatus();
  });
  $('#editor').addEventListener('keydown', function (e) {
    if (e.key !== 'Tab') return;
    e.preventDefault();
    var start = this.selectionStart, end = this.selectionEnd;
    this.setRangeText('  ', start, end, 'end');
    this.dispatchEvent(new Event('input'));
  });
  $('#visual-tools').addEventListener('mousedown', function (e) {
    if (e.target.closest('button')) e.preventDefault();
  });
  $('#block-style').addEventListener('change', function () {
    document.execCommand('formatBlock', false, this.value);
    $('#content').dispatchEvent(new Event('input'));
    $('#content').focus();
  });
  [['#fmt-bold', 'bold'], ['#fmt-italic', 'italic'], ['#fmt-ul', 'insertUnorderedList'],
   ['#fmt-ol', 'insertOrderedList']].forEach(function (item) {
    $(item[0]).addEventListener('click', function () {
      document.execCommand(item[1], false, null);
      $('#content').dispatchEvent(new Event('input'));
      $('#content').focus();
    });
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
    if (!S.editing && S.cur && $('#content').querySelector('.mermaid-box')) {
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

    if (ctrl && e.key.toLowerCase() === 's') {
      if (S.editing) { e.preventDefault(); saveDoc(); }
      return;
    }
    if (ctrl && e.key.toLowerCase() === 'e') {
      e.preventDefault();
      if (S.editMode === 'source') enterVisualEdit();
      else enterSourceEdit(fallbackSourceOffset());
      return;
    }
    if (S.editing) return;
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

  window.addEventListener('beforeunload', function (e) {
    if (!S.dirty) return;
    e.preventDefault();
    e.returnValue = '';
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
