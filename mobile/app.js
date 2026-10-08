/* ==========================================================================
   移动后台 · 框架 app.js
   --------------------------------------------------------------------------
   对外暴露单一全局对象 window.DS，模块（modules/*.js）通过 DS 提供的 API 工作。
   完整接口文档见 README.md「模块开发接口」章节。
   ========================================================================== */
(function () {
  'use strict';

  /* ======================================================================
     0. 常量
     ====================================================================== */
  var LSKEY = {
    conn: 'dsh.conn.v1',
    theme: 'dsh.theme.v1',
    mode: 'dsh.mode.v1',
    pin: 'dsh.pin.v1',
    lock: 'dsh.lockon.v1',
    setup: 'dsh.setupdone.v1',
    last: 'dsh.last.v1',
    page: 'dsh.pages.v1',
    prjLocal: 'dsh.prj.projects.v1'   // 项目后台的本地回退数据（「清除本机数据」会一并删除）
  };

  // 三个数据源。url 预填（非机密），key 必须由用户自己粘贴，绝不写死在代码里。
  var CONN_DEF = {
    cad: { icon: '📡', name: 'CAD 授权 · 散线转文字', hint: '用户 / 授权 / 订单 / 套餐', url: 'https://uwgqflcjuixmdhgzlvmb.supabase.co' },
    xhy: { icon: '🔐', name: 'XHY Toolbox 授权', hint: '授权 / 设备 / 激活 / 版本', url: 'https://ofdouqimwsplrhjcfdbv.supabase.co' },
    prj: { icon: '📋', name: '项目后台', hint: '项目 / 任务 / 笔记 / 代码片段（表名 projects）', url: 'https://uwgqflcjuixmdhgzlvmb.supabase.co' }
  };

  var THEMES = [
    { id: 'warm', name: '暖白' },
    { id: 'celadon', name: '青瓷' },
    { id: 'mist', name: '雾蓝' },
    { id: 'night', name: '深夜' }
  ];

  var COLOR = { ok: 'var(--success)', err: 'var(--danger)', warn: 'var(--warn)', info: 'var(--accent)', muted: 'var(--muted)' };

  /* ======================================================================
     1. 基础工具
     ====================================================================== */
  function $(sel, root) { return (root || document).querySelector(sel); }
  function $$(sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); }
  function isArr(v) { return Object.prototype.toString.call(v) === '[object Array]'; }
  function isObj(v) { return v && typeof v === 'object' && !isArr(v); }

  function esc(v) {
    if (v === null || v === undefined) return '';
    return String(v)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function pad2(n) { return (n < 10 ? '0' : '') + n; }

  function toDate(t) {
    if (!t) return null;
    if (t instanceof Date) return isNaN(t.getTime()) ? null : t;
    var s = String(t);
    var d = new Date(s);
    if (!isNaN(d.getTime())) return d;
    // 兼容 "2026-08-13 09:30:00"（部分浏览器对空格分隔不友好）
    d = new Date(s.replace(' ', 'T'));
    return isNaN(d.getTime()) ? null : d;
  }

  function fmtTime(t, withSec) {
    var d = toDate(t);
    if (!d) return '-';
    return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()) + ' ' +
      pad2(d.getHours()) + ':' + pad2(d.getMinutes()) + (withSec ? ':' + pad2(d.getSeconds()) : '');
  }
  function fmtDate(t) {
    var d = toDate(t);
    if (!d) return '-';
    return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
  }
  function fmtAgo(t) {
    var d = toDate(t);
    if (!d) return '-';
    var s = Math.floor((Date.now() - d.getTime()) / 1000);
    if (s < 0) return fmtTime(t);
    if (s < 60) return '刚刚';
    if (s < 3600) return Math.floor(s / 60) + ' 分钟前';
    if (s < 86400) return Math.floor(s / 3600) + ' 小时前';
    if (s < 86400 * 30) return Math.floor(s / 86400) + ' 天前';
    return fmtDate(t);
  }
  function fmtMoney(n, sym) {
    var v = parseFloat(n);
    if (isNaN(v)) v = 0;
    return (sym === undefined ? '¥' : sym) + v.toFixed(2);
  }
  function fmtNum(n) {
    var v = parseFloat(n);
    if (isNaN(v)) return '0';
    return String(v).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  }
  function daysLeft(t) {
    var d = toDate(t);
    if (!d) return null;
    return Math.ceil((d.getTime() - Date.now()) / 86400000);
  }
  function short(s, n) {
    if (s === null || s === undefined) return '-';
    s = String(s);
    n = n || 8;
    return s.length > n ? s.substring(0, n) + '…' : s;
  }
  function uid() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  }
  function clone(o) { try { return JSON.parse(JSON.stringify(o)); } catch (e) { return o; } }
  function numOr(v, d) { var n = parseFloat(v); return isNaN(n) ? (d === undefined ? 0 : d) : n; }

  /* ---------------- 本地存储 ---------------- */
  function lsGet(k, d) {
    try {
      var raw = localStorage.getItem(k);
      if (raw === null || raw === undefined) return d;
      return JSON.parse(raw);
    } catch (e) { return d; }
  }
  function lsSet(k, v) {
    try { localStorage.setItem(k, JSON.stringify(v)); return true; }
    catch (e) { toast('本机存储写入失败：' + e.message, 'err'); return false; }
  }
  function lsDel(k) { try { localStorage.removeItem(k); } catch (e) { } }

  /* ======================================================================
     2. Toast / 弹层
     ====================================================================== */
  function toast(msg, type, ms) {
    var wrap = $('#toasts');
    if (!wrap) { return; }
    var el = document.createElement('div');
    el.className = 'toast ' + (type || '');
    el.textContent = String(msg === undefined ? '' : msg);
    wrap.appendChild(el);
    setTimeout(function () {
      el.style.transition = 'opacity .25s, transform .25s';
      el.style.opacity = '0';
      el.style.transform = 'translateY(8px)';
      setTimeout(function () { if (el.parentNode) el.parentNode.removeChild(el); }, 260);
    }, ms || 2200);
  }

  var ovStack = [];

  function pushOverlay(node, onClose) {
    $('#overlays').appendChild(node);
    var entry = { node: node, onClose: onClose || null };
    // 只为「第一层」弹层压一条历史记录，保证返回键行为可预测
    if (ovStack.length === 0) {
      try { history.pushState({ dshOv: 1 }, ''); } catch (e) { }
    }
    ovStack.push(entry);
    return entry;
  }

  function removeTop() {
    var entry = ovStack.pop();
    if (!entry) return null;
    if (entry.node.parentNode) entry.node.parentNode.removeChild(entry.node);
    if (entry.onClose) { try { entry.onClose(); } catch (e) { } }
    return entry;
  }

  function popOverlay(fromHistory) {
    var had = ovStack.length;
    removeTop();
    // 主动关闭（点 X / 点遮罩）且弹层已清空时，把之前压入的历史记录弹掉
    if (!fromHistory && had > 0 && ovStack.length === 0) {
      try { history.back(); } catch (e) { }
    }
  }

  function closeTopOverlay() { popOverlay(false); }

  function closeAllOverlays() {
    while (ovStack.length) removeTop();
  }

  // 手机返回键 / 手势：先关最上层弹层，还有剩下的就补一条守卫记录
  window.addEventListener('popstate', function () {
    if (!ovStack.length) return;
    removeTop();
    if (ovStack.length) {
      try { history.pushState({ dshOv: 1 }, ''); } catch (e) { }
    }
  });

  /**
   * 底部弹层
   * opts: {title, html|node, buttons:[{text,cls,onClick(close)}], center, onReady(bodyEl, close), wide}
   * 返回 {node, close}
   */
  function sheet(opts) {
    opts = opts || {};
    var ov = document.createElement('div');
    ov.className = 'ov' + (opts.center ? ' center' : '');

    var bd = document.createElement('div');
    bd.className = 'ov-bd';
    ov.appendChild(bd);

    var box = document.createElement('div');
    box.className = 'sheet';
    if (opts.wide) box.style.maxWidth = '680px';

    var head = '';
    if (!opts.center) head += '<div class="sheet-grip"><i></i></div>';
    if (opts.title || !opts.center) {
      head += '<div class="sheet-head"><div class="sheet-title">' + esc(opts.title || '') + '</div>' +
        '<button class="sheet-x" data-dsh-close>&times;</button></div>';
    }
    var bodyHtml = opts.html !== undefined ? opts.html : '';
    var footHtml = '';
    if (opts.buttons && opts.buttons.length) {
      footHtml = '<div class="sheet-foot">' + opts.buttons.map(function (b, i) {
        return '<button class="btn ' + (b.cls || '') + '" data-dsh-btn="' + i + '">' + esc(b.text) + '</button>';
      }).join('') + '</div>';
    }
    box.innerHTML = head + '<div class="sheet-body"></div>' + footHtml;
    var body = $('.sheet-body', box);
    if (opts.node) body.appendChild(opts.node);
    else body.innerHTML = bodyHtml;
    ov.appendChild(box);

    var closed = false;
    function close() {
      if (closed) return;
      closed = true;
      popOverlay(false);
    }

    bd.addEventListener('click', function () { if (opts.dismissable !== false) close(); });
    var xBtn = $('[data-dsh-close]', box);
    if (xBtn) xBtn.addEventListener('click', function () { close(); });
    if (opts.buttons) {
      opts.buttons.forEach(function (b, i) {
        var btn = $('[data-dsh-btn="' + i + '"]', box);
        if (btn) btn.addEventListener('click', function () {
          var r = b.onClick ? b.onClick(close) : undefined;
          if (r !== false && !b.keepOpen) close();
        });
      });
    }
    if (opts.onReady) opts.onReady(body, close);
    pushOverlay(ov, opts.onClose);
    return { node: box, body: body, close: close };
  }

  function closeSheet() { closeTopOverlay(); }

  function confirmBox(opts) {
    if (typeof opts === 'string') opts = { msg: opts };
    opts = opts || {};
    return new Promise(function (resolve) {
      var done = false;
      function fin(v) { if (done) return; done = true; resolve(v); }
      sheet({
        center: true,
        title: opts.title || '确认操作',
        html: '<div style="font-size:14.5px;line-height:1.7;color:var(--text2)">' + (opts.html || esc(opts.msg || '确定要执行这个操作吗？')) + '</div>',
        buttons: [
          { text: opts.cancelText || '取消', cls: 'btn-outline', onClick: function () { fin(false); } },
          { text: opts.okText || '确定', cls: opts.danger ? 'btn-danger' : 'btn-primary', onClick: function () { fin(true); } }
        ],
        onClose: function () { fin(false); }
      });
    });
  }

  function promptBox(opts) {
    if (typeof opts === 'string') opts = { msg: opts };
    opts = opts || {};
    return new Promise(function (resolve) {
      var done = false;
      function fin(v) { if (done) return; done = true; resolve(v); }
      sheet({
        center: true,
        title: opts.title || '请输入',
        html: '<div class="field" style="margin:0">' +
          (opts.msg ? '<div style="font-size:13.5px;color:var(--text2);margin-bottom:9px;line-height:1.6">' + esc(opts.msg) + '</div>' : '') +
          '<input class="inp" data-dsh-p type="' + (opts.type || 'text') + '" placeholder="' + esc(opts.placeholder || '') + '" value="' + esc(opts.value === undefined ? '' : opts.value) + '">' +
          (opts.help ? '<div class="help">' + esc(opts.help) + '</div>' : '') + '</div>',
        buttons: [
          { text: '取消', cls: 'btn-outline', onClick: function () { fin(null); } },
          {
            text: opts.okText || '确定', cls: 'btn-primary', onClick: function (close) {
              var v = ($('[data-dsh-p]') || {}).value;
              fin(v === undefined ? null : v);
            }
          }
        ],
        onReady: function (body) {
          var inp = $('[data-dsh-p]', body);
          if (inp) {
            setTimeout(function () { inp.focus(); }, 120);
            inp.addEventListener('keydown', function (e) { if (e.key === 'Enter') { fin(inp.value); closeTopOverlay(); } });
          }
        },
        onClose: function () { fin(null); }
      });
    });
  }

  function alertBox(msg, title) {
    return new Promise(function (resolve) {
      sheet({
        center: true, title: title || '提示',
        html: '<div style="font-size:14.5px;line-height:1.7;color:var(--text2);word-break:break-word">' + esc(msg) + '</div>',
        buttons: [{ text: '知道了', cls: 'btn-primary', onClick: function () { resolve(true); } }],
        onClose: function () { resolve(true); }
      });
    });
  }

  /* ======================================================================
     3. 委托事件（模块首选方式，避免 onclick 字符串拼接注入）
     ====================================================================== */
  var actMap = {};
  var actSeq = 0;

  function on(name, fn) { actMap[name] = fn; }

  /** 生成 data-act 属性；payload 任意 JSON 可序列化值 */
  function act(name, payload) {
    return ' data-act="' + esc(name) + '" data-p="' + esc(encodeURIComponent(JSON.stringify(payload === undefined ? null : payload))) + '"';
  }

  /**
   * 绑定 .self 行为；用法：
   *   DS.bind(el, 'tap', 'user:open', fn)
   * 或直接监听全局：
   *   DS.on('user:open', fn)
   */
  function bind(root, evt, name, fn) {
    if (fn) on(name, fn);
    (root || document).addEventListener(evt || 'click', function (e) {
      var t = e.target.closest ? e.target.closest('[data-act="' + name + '"]') : null;
      if (!t) return;
      e.preventDefault();
      var raw = t.getAttribute('data-p');
      var payload = null;
      try { payload = raw ? JSON.parse(decodeURIComponent(raw)) : null; } catch (err) { payload = null; }
      (actMap[name] || function () { })(payload, e, t);
    });
  }

  // 全局委托：任何 [data-act] 点击都会找到注册的处理器
  document.addEventListener('click', function (e) {
    var t = e.target.closest ? e.target.closest('[data-act]') : null;
    if (!t) return;
    var name = t.getAttribute('data-act');
    var fn = actMap[name];
    if (!fn) return;
    e.preventDefault();
    var raw = t.getAttribute('data-p');
    var payload = null;
    try { payload = raw ? JSON.parse(decodeURIComponent(raw)) : null; } catch (err) { payload = null; }
    fn(payload, e, t);
  });

  // 分页按钮委托
  document.addEventListener('click', function (e) {
    var t = e.target.closest ? e.target.closest('[data-ds-go]') : null;
    if (!t) return;
    e.preventDefault();
    var key = t.getAttribute('data-ds-pager');
    var go = t.getAttribute('data-ds-go');
    var st = pagerState(key);
    if (go === 'prev') st.page = Math.max(0, st.page - 1);
    else if (go === 'next') st.page = st.page + 1;
    else st.page = numOr(go, 0);
    savePagerState(key);
    var handler = actMap['__pager:' + key];
    if (handler) handler(st.page, t);
  });

  // 搜索框委托：回车触发
  document.addEventListener('keydown', function (e) {
    var t = e.target.closest ? e.target.closest('[data-ds-search]') : null;
    if (!t || (e.key !== 'Enter' && e.keyCode !== 13)) return;
    e.preventDefault();
    t.blur();
    var k = t.getAttribute('data-ds-search');
    var fn = actMap['__search:' + k];
    if (fn) fn(t.value, t);
  });

  // 搜索框委托：清空
  document.addEventListener('click', function (e) {
    var t = e.target.closest ? e.target.closest('[data-ds-clearsearch]') : null;
    if (!t) return;
    e.preventDefault();
    var k = t.getAttribute('data-ds-clearsearch');
    var st = pagerState(k);
    st.search = ''; st.page = 0; savePagerState(k);
    var fn = actMap['__search:' + k];
    if (fn) fn('', t);
  });

  /* ======================================================================
     4. 连接配置
     ====================================================================== */
  function allConns() { return lsGet(LSKEY.conn, {}) || {}; }

  function getConn(name) {
    var def = CONN_DEF[name] || {};
    var saved = allConns()[name] || {};
    var url = (saved.url || def.url || '').replace(/\/+$/, '');
    var key = saved.key || '';
    return {
      name: name,
      icon: def.icon || '🔗',
      label: def.name || name,
      hint: def.hint || '',
      url: url,
      key: key,
      rest: url ? url + '/rest/v1' : '',
      configured: !!(url && key)
    };
  }

  function setConn(name, url, key) {
    var all = allConns();
    all[name] = { url: (url || '').replace(/\/+$/, ''), key: key || '' };
    lsSet(LSKEY.conn, all);
  }

  function connNames() { return Object.keys(CONN_DEF); }

  /* ======================================================================
     5. Supabase REST 客户端
     ====================================================================== */
  function buildQuery(opts) {
    var qs = [];
    qs.push('select=' + encodeURIComponent(opts.select || '*'));
    if (opts.filters) {
      Object.keys(opts.filters).forEach(function (k) {
        var v = opts.filters[k];
        if (v === undefined || v === null) return;
        qs.push(encodeURIComponent(k) + '=eq.' + encodeURIComponent(v));
      });
    }
    if (opts.neq) {
      Object.keys(opts.neq).forEach(function (k) {
        var v = opts.neq[k];
        if (v === undefined || v === null) return;
        qs.push(encodeURIComponent(k) + '=neq.' + encodeURIComponent(v));
      });
    }
    if (opts.orFilter) qs.push('or=(' + opts.orFilter + ')');
    if (opts.extraFilters) {
      opts.extraFilters.forEach(function (f) { if (f) qs.push(f); });
    }
    if (opts.order) {
      var ord = String(opts.order);
      // 已经带方向（含 PostgREST 的 nullsfirst/nullslast 后缀）就原样使用
      if (!/\.(asc|desc)(\.(nullsfirst|nullslast))?$/i.test(ord)) {
        var dir = opts.ascending === false ? 'desc' : 'asc';
        if (/\.(nullsfirst|nullslast)$/i.test(ord)) {
          // 'last_seen.nullslast' -> 'last_seen.asc.nullslast'
          ord = ord.replace(/\.(nullsfirst|nullslast)$/i, '.' + dir + '.$1');
        } else {
          ord += '.' + dir;
        }
      }
      qs.push('order=' + encodeURIComponent(ord));
    }
    if (opts.limit) qs.push('limit=' + opts.limit);
    if (opts.offset) qs.push('offset=' + opts.offset);
    return qs.join('&');
  }

  function humanErr(status, data) {
    var msg = '';
    if (data && typeof data === 'object') msg = data.message || data.error || data.hint || '';
    else if (typeof data === 'string') msg = data.slice(0, 300);
    if (!msg) msg = 'HTTP ' + status;
    var hint = '';
    if (status === 401) hint = '（apikey 无效）';
    else if (status === 403) hint = '（RLS 拒绝：需要 service_role key，或该表策略不允许）';
    else if (status === 404) hint = '（URL 错误或表不存在）';
    else if (status === 400) hint = '（请求参数或字段名有误）';
    else if (status === 409) hint = '（唯一键冲突）';
    return { message: msg + hint, status: status, raw: data };
  }

  /** 是否带了任何过滤条件 */
  function hasFilter(opts) {
    return !!opts.query ||
      (opts.filters && Object.keys(opts.filters).length > 0) ||
      (opts.neq && Object.keys(opts.neq).length > 0) ||
      !!opts.orFilter ||
      (opts.extraFilters && opts.extraFilters.filter(Boolean).length > 0);
  }

  /**
   * DS.api(conn, table, opts) -> Promise<{data, error, count}>
   * opts: {
   *   select, filters:{col:val}, neq:{col:val}, orFilter:'a.ilike.*x*,b.ilike.*x*',
   *   extraFilters:['status=eq.active'], order:'created_at', ascending:false,
   *   limit, offset, pageSize, rangeFrom, rangeTo, countOnly,
   *   method:'GET'|'POST'|'PATCH'|'DELETE', data, single, upsert, onConflict,
   *   prefer, headers
   * }
   */
  function api(connName, table, opts) {
    opts = opts || {};
    var c = getConn(connName);
    if (!c.configured) {
      return Promise.resolve({ data: null, error: { message: '未配置「' + c.label + '」的 Supabase 连接', unconfigured: true }, count: 0 });
    }
    var method = (opts.method || 'GET').toUpperCase();

    // ---- 安全护栏 ----------------------------------------------------------
    // PATCH / DELETE 如果没有携带任何过滤条件，PostgREST 会作用于整张表。
    // 这类「清空全表」的误操作代价极高，所以默认直接拒绝，必须显式传 allowAll: true。
    if ((method === 'PATCH' || method === 'DELETE') && !opts.allowAll && !hasFilter(opts)) {
      return Promise.resolve({
        data: null,
        error: {
          message: '已阻止危险的 ' + method + ' 请求：没有指定任何过滤条件，执行会作用于整张表。' +
            '确实需要请显式传 allowAll: true。',
          guard: true
        },
        count: 0
      });
    }

    var url = c.rest + '/' + encodeURIComponent(table);
    var qs = '';
    if (method === 'POST') {
      // 插入 / upsert：只带 select，让 Prefer: return=representation 返回需要的列
      qs = opts.select ? 'select=' + encodeURIComponent(opts.select) : '';
    } else {
      qs = buildQuery(opts);
      if (method === 'DELETE') {
        // PostgREST 的 DELETE 不接受 select
        qs = qs.split('&').filter(function (p) { return p.indexOf('select=') !== 0; }).join('&');
      }
    }
    if (qs) url += '?' + qs;

    var headers = { apikey: c.key, Authorization: 'Bearer ' + c.key };

    if (opts.headers) Object.keys(opts.headers).forEach(function (k) { headers[k] = opts.headers[k]; });

    var body = null;
    if (method !== 'GET' && method !== 'DELETE') {
      headers['Content-Type'] = 'application/json';
      if (opts.data !== undefined) body = JSON.stringify(opts.data);
    } else if (method === 'DELETE' && opts.data !== undefined) {
      headers['Content-Type'] = 'application/json';
      body = JSON.stringify(opts.data);
    }

    var prefer = [];
    if (method !== 'GET' && method !== 'DELETE') prefer.push('return=' + (opts.returning || 'representation'));
    if (opts.upsert) prefer.push('resolution=merge-duplicates');
    if (opts.countOnly && opts.rangeFrom === undefined) { headers['Range'] = '0-0'; prefer.push('count=exact'); }
    if (opts.rangeFrom !== undefined) {
      headers['Range'] = opts.rangeFrom + '-' + (opts.rangeTo === undefined ? opts.rangeFrom + (opts.pageSize || 19) : opts.rangeTo);
      prefer.push('count=exact');
    }
    if (opts.prefer) prefer = prefer.concat(isArr(opts.prefer) ? opts.prefer : [opts.prefer]);
    if (prefer.length) headers['Prefer'] = prefer.join(',');
    if (opts.single) headers['Accept'] = 'application/vnd.pgrst.object+json';
    if (opts.upsert && opts.onConflict) url += (url.indexOf('?') >= 0 ? '&' : '?') + 'on_conflict=' + encodeURIComponent(opts.onConflict);

    return fetch(url, { method: method, headers: headers, body: body, cache: 'no-store' })
      .then(function (res) {
        var count = 0;
        var cr = res.headers.get('Content-Range');
        if (cr) { var m = cr.match(/\/(\d+)/); if (m) count = parseInt(m[1], 10); }
        return res.text().then(function (txt) {
          var data = null;
          if (txt) { try { data = JSON.parse(txt); } catch (e) { data = txt; } }
          if (!res.ok) return { data: null, error: humanErr(res.status, data), count: 0 };
          if (res.status === 204 || !txt) return { data: [], error: null, count: count };
          if (!isArr(data)) data = [data];
          return { data: data, error: null, count: count || data.length };
        });
      })
      .catch(function (e) {
        var m = e && e.message ? e.message : String(e);
        var hint = /Failed to fetch|NetworkError|Load failed/i.test(m)
          ? '（网络不通、被代理拦截，或该 Supabase 项目已暂停）' : '';
        return { data: null, error: { message: m + hint }, count: 0 };
      });
  }

  /** 拉取全部（自动翻页，最多 maxRows 行） */
  function apiAll(connName, table, opts, maxRows) {
    opts = opts || {};
    maxRows = maxRows || 2000;
    var pageSize = 1000;
    var out = [];
    function step(from) {
      var o = clone(opts);
      o.rangeFrom = from;
      o.rangeTo = from + pageSize - 1;
      return api(connName, table, o).then(function (r) {
        if (r.error) return r;
        out = out.concat(r.data || []);
        if (!r.data || r.data.length < pageSize || out.length >= maxRows) return { data: out, error: null, count: out.length };
        return step(from + pageSize);
      });
    }
    return step(0);
  }

  /* 连接设置弹层 */
  function connSheet(name, onSaved) {
    var c = getConn(name);
    var def = CONN_DEF[name] || {};
    return sheet({
      title: c.icon + ' ' + c.label,
      html:
        '<div class="banner info">密钥只保存在本机浏览器，不会上传到任何服务器。</div>' +
        field({ label: 'Supabase URL', name: 'url', value: c.url || def.url || '', placeholder: 'https://xxxx.supabase.co', inputmode: 'url' }) +
        field({ label: 'API Key', name: 'key', value: '', type: 'password', placeholder: c.key ? '已保存（留空则不修改）' : '粘贴 anon 或 service_role key', help: '管理操作（增删改）需要 service_role key。' }) +
        '<div class="btn-row" style="margin-top:4px">' +
        '<button class="btn btn-sm btn-outline" data-dsh-test>测试连接</button>' +
        '<button class="btn btn-sm btn-outline" data-dsh-clear>清除</button>' +
        '</div>' +
        '<div data-dsh-msg style="margin-top:10px;font-size:12.5px"></div>',
      buttons: [
        { text: '取消', cls: 'btn-outline' },
        {
          text: '保存', cls: 'btn-primary', onClick: function (close) {
            var root = $('.sheet-body');
            var url = ($('[data-name="url"]', root) || {}).value.trim();
            var keyIn = ($('[data-name="key"]', root) || {}).value.trim();
            var key = keyIn || c.key;
            if (!url) { toast('请填写 Supabase URL', 'err'); return false; }
            if (!key) { toast('请填写 API Key', 'err'); return false; }
            setConn(name, url, key);
            toast('已保存', 'ok');
            if (onSaved) onSaved();
          }
        }
      ],
      onReady: function (body) {
        var msg = $('[data-dsh-msg]', body);
        $('[data-dsh-test]', body).addEventListener('click', function () {
          var url = ($('[data-name="url"]', body) || {}).value.trim().replace(/\/+$/, '');
          var key = ($('[data-name="key"]', body) || {}).value.trim();
          if (!url || !key) { msg.textContent = '请先填写 URL 和 Key'; msg.style.color = 'var(--danger)'; return; }
          msg.textContent = '测试中…'; msg.style.color = 'var(--muted)';
          fetch(url + '/rest/v1/', { headers: { apikey: key, Authorization: 'Bearer ' + key }, cache: 'no-store' })
            .then(function (r) {
              if (r.ok || r.status === 200 || r.status === 204 || r.status === 404 || r.status === 400) {
                msg.textContent = '✅ 连接成功（HTTP ' + r.status + '）'; msg.style.color = 'var(--success)';
              } else {
                msg.textContent = '⚠️ 返回 HTTP ' + r.status + '，请检查 Key 类型或 URL'; msg.style.color = 'var(--warn)';
              }
            })
            .catch(function (e) { msg.textContent = '❌ ' + e.message; msg.style.color = 'var(--danger)'; });
        });
        $('[data-dsh-clear]', body).addEventListener('click', function () {
          var all = allConns(); delete all[name]; lsSet(LSKEY.conn, all);
          $('[data-name="url"]', body).value = def.url || '';
          $('[data-name="key"]', body).value = '';
          toast('已清除 ' + name, 'info');
        });
      }
    });
  }

  /** 确保连接可用；不可用则弹出配置并返回 false */
  function requireConn(name) {
    var c = getConn(name);
    if (c.configured) return Promise.resolve(true);
    return new Promise(function (resolve) {
      connSheet(name, function () { resolve(getConn(name).configured); });
      if (ovStack.length) {
        var entry = ovStack[ovStack.length - 1];
        var prev = entry.onClose;
        entry.node.addEventListener('click', function () { });
        ovStack[ovStack.length - 1] = {
          node: entry.node,
          onClose: function () { if (prev) prev(); if (!getConn(name).configured) resolve(false); }
        };
      }
    });
  }

  /* ======================================================================
     6. 表单构造
     ====================================================================== */
  function fId(name) { return 'f_' + name.replace(/[^a-zA-Z0-9_]/g, '_'); }

  function field(o) {
    o = o || {};
    var type = o.type || 'text';
    if (type === 'password') type = 'text';
    return '<div class="field">' +
      (o.label ? '<label for="' + fId(o.name) + '">' + esc(o.label) + (o.required ? ' <span style="color:var(--danger)">*</span>' : '') + '</label>' : '') +
      '<input class="inp' + (o.mono ? ' mono' : '') + '" id="' + fId(o.name) + '" data-name="' + esc(o.name) + '" data-kind="text"' +
      ' type="' + (o.inputType || (o.type === 'password' ? 'password' : (o.type === 'number' ? 'number' : 'text'))) + '"' +
      (o.inputmode ? ' inputmode="' + o.inputmode + '"' : '') +
      (o.min !== undefined ? ' min="' + o.min + '"' : '') +
      (o.max !== undefined ? ' max="' + o.max + '"' : '') +
      (o.step !== undefined ? ' step="' + o.step + '"' : '') +
      ' placeholder="' + esc(o.placeholder || '') + '" value="' + esc(o.value === undefined || o.value === null ? '' : o.value) + '">' +
      (o.help ? '<div class="help">' + o.help + '</div>' : '') +
      '</div>';
  }

  function input(o) { o = o || {}; return field(o); }

  function number(o) { o = o || {}; o.type = 'number'; o.inputmode = 'decimal'; return field(o); }

  function password(o) { o = o || {}; o.inputType = 'password'; return field(o); }

  function textarea(o) {
    o = o || {};
    return '<div class="field">' +
      (o.label ? '<label for="' + fId(o.name) + '">' + esc(o.label) + '</label>' : '') +
      '<textarea class="txa" id="' + fId(o.name) + '" data-name="' + esc(o.name) + '" data-kind="text"' +
      ' rows="' + (o.rows || 4) + '" placeholder="' + esc(o.placeholder || '') + '">' + esc(o.value || '') + '</textarea>' +
      (o.help ? '<div class="help">' + esc(o.help) + '</div>' : '') +
      '</div>';
  }

  function select(o) {
    o = o || {};
    var opts = (o.options || []).map(function (it) {
      var v, l;
      if (isArr(it)) { v = it[0]; l = it[1]; }
      else if (isObj(it)) { v = it.value; l = it.label; }
      else { v = it; l = it; }
      return '<option value="' + esc(v) + '"' + (String(v) === String(o.value) ? ' selected' : '') + '>' + esc(l) + '</option>';
    }).join('');
    return '<div class="field">' +
      (o.label ? '<label for="' + fId(o.name) + '">' + esc(o.label) + '</label>' : '') +
      '<select class="sel" id="' + fId(o.name) + '" data-name="' + esc(o.name) + '" data-kind="' + (o.multi ? 'multi' : 'text') + '"' + (o.multi ? ' multiple size="' + (o.size || 5) + '"' : '') + '>' + opts + '</select>' +
      (o.help ? '<div class="help">' + esc(o.help) + '</div>' : '') +
      '</div>';
  }

  function toggle(o) {
    o = o || {};
    return '<div class="switch" data-name="' + esc(o.name) + '" data-kind="bool"' + (o.checked ? ' data-on="1"' : '') + '>' +
      '<div><div class="switch-t">' + esc(o.label || '') + '</div>' + (o.sub ? '<div class="switch-s">' + esc(o.sub) + '</div>' : '') + '</div>' +
      '<button type="button" class="sw' + (o.checked ? ' on' : '') + '"></button></div>';
  }

  // 开关点击切换
  document.addEventListener('click', function (e) {
    var sw = e.target.closest ? e.target.closest('.sw') : null;
    if (!sw) return;
    var holder = sw.closest('.switch');
    if (!holder) return;
    sw.classList.toggle('on');
    holder.setAttribute('data-on', sw.classList.contains('on') ? '1' : '0');
  });

  /** 收集表单数据 */
  function formData(root) {
    root = root || document;
    var out = {};
    $$('[data-name]', root).forEach(function (el) {
      var n = el.getAttribute('data-name');
      var kind = el.getAttribute('data-kind') || 'text';
      if (kind === 'bool') { out[n] = el.getAttribute('data-on') === '1'; return; }
      if (kind === 'multi') {
        out[n] = $$('option', el).filter(function (o) { return o.selected; }).map(function (o) { return o.value; });
        return;
      }
      var v = el.value;
      if (el.type === 'number') v = v === '' ? null : parseFloat(v);
      out[n] = v;
    });
    return out;
  }

  function setForm(root, obj) {
    root = root || document;
    Object.keys(obj || {}).forEach(function (n) {
      var el = $('[data-name="' + n + '"]', root);
      if (!el) return;
      var kind = el.getAttribute('data-kind') || 'text';
      var v = obj[n];
      if (kind === 'bool') {
        el.setAttribute('data-on', v ? '1' : '0');
        var sw = $('.sw', el);
        if (sw) sw.classList.toggle('on', !!v);
      } else if (kind === 'multi') {
        $$('option', el).forEach(function (o) { o.selected = (v || []).indexOf(o.value) >= 0; });
      } else {
        el.value = v === null || v === undefined ? '' : v;
      }
    });
  }

  function validate(root, rules) {
    // rules: {name:{required,label,min,max,type:'number'|'email'}}
    var data = formData(root);
    for (var i = 0; i < (rules || []).length; i++) {
      var r = rules[i];
      var v = data[r.name];
      if (r.required && (v === '' || v === null || v === undefined)) return { ok: false, msg: '请填写「' + (r.label || r.name) + '」' };
      if (r.type === 'number' && v !== null && v !== '' && isNaN(parseFloat(v))) return { ok: false, msg: '「' + (r.label || r.name) + '」必须是数字' };
      if (r.min !== undefined && v !== '' && v !== null && parseFloat(v) < r.min) return { ok: false, msg: '「' + (r.label || r.name) + '」不能小于 ' + r.min };
      if (r.max !== undefined && v !== '' && v !== null && parseFloat(v) > r.max) return { ok: false, msg: '「' + (r.label || r.name) + '」不能大于 ' + r.max };
      if (r.type === 'email' && v && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)) return { ok: false, msg: '「' + (r.label || r.name) + '」格式不正确' };
    }
    return { ok: true, data: data };
  }

  /* ======================================================================
     7. 展示组件
     ====================================================================== */
  function loading(text) { return '<div class="loading"><span class="spin"></span>' + esc(text || '加载中…') + '</div>'; }
  function empty(text, icon) {
    return '<div class="empty"><span class="e-ic">' + (icon || '🗂') + '</span>' + esc(text || '暂无数据') + '</div>';
  }
  function errBox(msg) {
    return '<div class="err-box">⚠️ ' + (msg || '出错了') + '</div>';
  }
  function card(html, opts) {
    opts = opts || {};
    var inner = '';
    if (opts.title) {
      inner += '<div class="card-title">' + esc(opts.title) + (opts.right || '') + '</div>';
    }
    return '<section class="card' + (opts.tight ? ' tight' : '') + '">' + inner + html + '</section>';
  }
  function chip(text, type, sm) {
    return '<span class="chip ' + (type || '') + (sm ? ' sm' : '') + '">' + esc(text) + '</span>';
  }
  function dot(text, type) {
    return '<span class="chip ' + (type || '') + '"><span style="font-size:8px">●</span> ' + esc(text) + '</span>';
  }
  function stat(o) {
    return '<div class="stat">' +
      '<div class="stat-top">' +
      '<div class="stat-ic" style="' + (o.color ? 'background:' + o.color + '22;color:' + o.color : '') + '">' + (o.icon || '📊') + '</div>' +
      (o.sub ? '<span class="stat-sub" style="' + (o.subType ? 'background:' + COLOR[o.subType] + '22;color:' + COLOR[o.subType] : 'background:var(--accent-bg);color:var(--muted)') + '">' + esc(o.sub) + '</span>' : '') +
      '</div>' +
      '<div class="stat-val" style="' + (o.color ? 'color:' + o.color : '') + '">' + (o.raw ? o.value : esc(o.value)) + '</div>' +
      '<div class="stat-lbl">' + esc(o.label || '') + '</div>' +
      '</div>';
  }
  function statGrid(items) { return '<div class="stat-grid">' + items.map(stat).join('') + '</div>'; }

  /** 列表条目 */
  function li(o) {
    o = o || {};
    var inner = '';
    if (o.ic) inner += '<div class="li-ic" style="' + (o.icColor ? 'background:' + o.icColor + '22;color:' + o.icColor : '') + '">' + o.ic + '</div>';
    inner += '<div class="li-body"><div class="li-title">' + (o.rawTitle ? o.title : esc(o.title)) + '</div>' +
      (o.sub ? '<div class="li-sub">' + (o.rawSub ? o.sub : esc(o.sub)) + '</div>' : '') + '</div>';
    if (o.right) inner += '<div class="li-right">' + (o.rawRight ? o.right : esc(o.right)) + '</div>';
    if (o.badge) inner += '<div class="li-right">' + o.badge + '</div>';
    if (o.onClick) inner += '<div class="li-arrow">›</div>';
    var attrs = o.onClick ? ' data-act="' + esc(o.onClick.name || o.onClick) + '" data-p="' + esc(encodeURIComponent(JSON.stringify(o.onClick.payload === undefined ? null : o.onClick.payload))) + '"' : '';
    return '<li class="li"' + attrs + (o.attrs || '') + '>' + inner + '</li>';
  }

  function list(items) { return '<ul class="list">' + items.join('') + '</ul>'; }

  function kv(items) {
    return items.map(function (it) {
      if (!it) return '';
      var k = isArr(it) ? it[0] : it.k;
      var v = isArr(it) ? it[1] : it.v;
      var mono = isArr(it) ? false : it.mono;
      return '<div class="kv"><div class="kv-k">' + esc(k) + '</div><div class="kv-v' + (mono ? ' mono' : '') + '">' + (isArr(it) ? esc(v === null || v === undefined || v === '' ? '-' : v) : (it.raw ? v : esc(v === null || v === undefined || v === '' ? '-' : v))) + '</div></div>';
    }).join('');
  }

  function actions(items) {
    return '<div class="btn-row">' + items.map(function (b) {
      if (!b) return '';
      var attrs = b.onClick ? ' data-act="' + esc(b.onClick.name) + '" data-p="' + esc(encodeURIComponent(JSON.stringify(b.onClick.payload === undefined ? null : b.onClick.payload))) + '"' : '';
      return '<button class="btn ' + (b.cls || 'btn-outline') + (b.sm === false ? '' : ' btn-sm') + '"' + attrs + (b.disabled ? ' disabled' : '') + '>' + (b.raw ? b.text : esc(b.text)) + '</button>';
    }).join('') + '</div>';
  }

  function kvgrid(items) {
    return '<div class="kvgrid">' + items.map(function (it) {
      if (!it) return '';
      return '<div class="kvi"><div class="k">' + esc(isArr(it) ? it[0] : it.k) + '</div><div class="v">' + esc((isArr(it) ? it[1] : it.v) === undefined || (isArr(it) ? it[1] : it.v) === null || (isArr(it) ? it[1] : it.v) === '' ? '-' : (isArr(it) ? it[1] : it.v)) + '</div></div>';
    }).join('') + '</div>';
  }

  function bar(pct) {
    return '<div class="bar"><i style="width:' + Math.max(0, Math.min(100, numOr(pct, 0))) + '%"></i></div>';
  }

  function banner(text, type) { return '<div class="banner ' + (type || 'info') + '">' + (text) + '</div>'; }

  function searchBox(key, placeholder, value) {
    return '<div class="search">' +
      '<span class="s-ic">🔍</span>' +
      '<input id="ds-search-' + esc(key) + '" data-ds-search="' + esc(key) + '" type="search" enterkeyhint="search"' +
      ' placeholder="' + esc(placeholder || '搜索…，回车确认') + '" value="' + esc(value || '') + '">' +
      (value ? '<span class="s-clear" data-ds-clearsearch="' + esc(key) + '">✕</span>' : '') +
      '</div>';
  }

  function onSearch(key, fn) { actMap['__search:' + key] = fn; }

  function fchips(list, active, actName) {
    return '<div class="filter-row">' + list.map(function (c) {
      return '<button class="fchip' + (String(c.v) === String(active) ? ' active' : '') + '"' +
        ' data-act="' + esc(actName) + '" data-p="' + esc(encodeURIComponent(JSON.stringify(c.v))) + '">' +
        esc(c.l) + (c.n !== undefined ? ' <span style="opacity:.7">' + c.n + '</span>' : '') + '</button>';
    }).join('') + '</div>';
  }

  function pagerHtml(key, total, size) {
    var st = pagerState(key);
    var pages = Math.max(1, Math.ceil((total || 0) / (size || st.size)));
    var p = Math.min(st.page, pages - 1);
    if (total === 0 || pages <= 1) {
      return '<div class="pager"><div class="pager-info">共 ' + (total || 0) + ' 条</div><div></div></div>';
    }
    return '<div class="pager">' +
      '<div class="pager-info">共 <strong>' + total + '</strong> 条 · ' + (p + 1) + '/' + pages + ' 页</div>' +
      '<div class="pager-btns">' +
      '<button class="btn btn-sm btn-outline"' + (p <= 0 ? ' disabled' : '') + ' data-ds-pager="' + esc(key) + '" data-ds-go="prev">上一页</button>' +
      '<button class="btn btn-sm btn-outline"' + (p + 1 >= pages ? ' disabled' : '') + ' data-ds-pager="' + esc(key) + '" data-ds-go="next">下一页</button>' +
      '</div></div>';
  }

  /* ---- 分页状态 ---- */
  var pagerMem = {};   // key -> {page,size,search,filter}
  var pagesMem = lsGet(LSKEY.page, {}) || {};

  function pagerState(key, size) {
    if (!pagerMem[key]) {
      var saved = pagesMem[key] || {};
      pagerMem[key] = { page: saved.page || 0, size: size || saved.size || 20, search: saved.search || '', filter: saved.filter || 'all', extra: {} };
    }
    if (size) pagerMem[key].size = size;
    return pagerMem[key];
  }
  function savePagerState(key) {
    var st = pagerMem[key];
    if (!st) return;
    pagesMem[key] = { page: st.page, size: st.size, search: st.search, filter: st.filter };
    lsSet(LSKEY.page, pagesMem);
  }
  function pagerReset(key, keep) {
    var st = pagerState(key);
    st.page = 0;
    if (!keep || keep.indexOf('search') < 0) st.search = '';
    if (!keep || keep.indexOf('filter') < 0) st.filter = 'all';
    savePagerState(key);
    return st;
  }
  function onPager(key, fn) { actMap['__pager:' + key] = fn; }

  /* ======================================================================
     8. 剪贴板 / 其他
     ====================================================================== */
  function copy(text) {
    var s = String(text === undefined || text === null ? '' : text);
    function fallback() {
      try {
        var ta = document.createElement('textarea');
        ta.value = s;
        ta.style.cssText = 'position:fixed;top:-1000px;opacity:0';
        document.body.appendChild(ta);
        ta.select();
        var ok = document.execCommand('copy');
        document.body.removeChild(ta);
        toast(ok ? '已复制' : '复制失败，请长按选择', ok ? 'ok' : 'err');
      } catch (e) { toast('复制失败', 'err'); }
    }
    if (navigator.clipboard && navigator.clipboard.writeText && window.isSecureContext) {
      navigator.clipboard.writeText(s).then(function () { toast('已复制', 'ok'); }, fallback);
    } else fallback();
  }

  function download(filename, content, mime) {
    try {
      var blob = new Blob([content], { type: mime || 'application/json;charset=utf-8' });
      var a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = filename;
      document.body.appendChild(a); a.click();
      setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 400);
      toast('已导出 ' + filename, 'ok');
    } catch (e) { toast('导出失败：' + e.message, 'err'); }
  }

  function pickFile(accept) {
    return new Promise(function (resolve) {
      var inp = document.createElement('input');
      inp.type = 'file';
      if (accept) inp.accept = accept;
      inp.style.display = 'none';
      document.body.appendChild(inp);
      inp.addEventListener('change', function () {
        var f = inp.files && inp.files[0];
        inp.remove();
        if (!f) return resolve(null);
        var fr = new FileReader();
        fr.onload = function () { resolve({ name: f.name, text: String(fr.result) }); };
        fr.onerror = function () { resolve(null); };
        fr.readAsText(f, 'utf-8');
      });
      inp.click();
    });
  }

  function totalOf(res) {
    // 兼容 PostgREST 返回：priority 用 count，拿不到就用数组长度
    if (!res) return 0;
    if (typeof res.count === 'number' && res.count > 0) return res.count;
    return (res.data || []).length;
  }

  function timeRange(fromKey, toKey) {
    // 便捷：返回 'YYYY-MM-DD' 当天的 ISO 边界
    var d = new Date();
    if (fromKey) { /* noop */ }
    return d;
  }

  function todayStart() {
    var d = new Date(); d.setHours(0, 0, 0, 0); return d.toISOString();
  }
  function daysAgoISO(n) {
    var d = new Date(); d.setHours(0, 0, 0, 0); d.setDate(d.getDate() - (n || 0)); return d.toISOString();
  }
  function daysLaterISO(n) {
    var d = new Date(); d.setHours(0, 0, 0, 0); d.setDate(d.getDate() + (n || 0)); return d.toISOString();
  }

  /* ======================================================================
     9. 路由 / 模块注册
     ====================================================================== */
  var modules = [];
  var modMap = {};
  var cur = { module: null, page: null };
  var pageMem = lsGet(LSKEY.last, { module: null, pages: {} }) || { module: null, pages: {} };

  function registerModule(mod) {
    if (!mod || !mod.id) throw new Error('模块必须有 id');
    mod.pages = mod.pages && mod.pages.length ? mod.pages : [{ id: 'main', title: mod.name }];
    mod.conns = mod.conns || [];
    modules.push(mod);
    modMap[mod.id] = mod;
    return mod;
  }

  function moduleOf(id) { return modMap[id]; }

  function go(moduleId, pageId) {
    var mod = modMap[moduleId];
    if (!mod) { toast('模块不存在：' + moduleId, 'err'); return; }
    cur.module = moduleId;
    cur.page = pageId || pageMem.pages[moduleId] || mod.pages[0].id;
    if (!mod.pages.some(function (p) { return p.id === cur.page; })) cur.page = mod.pages[0].id;
    pageMem.module = moduleId;
    pageMem.pages[moduleId] = cur.page;
    lsSet(LSKEY.last, pageMem);
    closeAllOverlays();
    renderChrome();
    renderPage();
    window.scrollTo(0, 0);
  }

  function goPage(pageId) { go(cur.module, pageId); }

  function refresh() { renderPage(); }

  function setTitle(t, sub) {
    $('#top-title').textContent = t || '';
    $('#top-sub').textContent = sub || '';
  }
  function setSubtitle(sub) { $('#top-sub').textContent = sub || ''; }

  function setBadge(moduleId, n) {
    var tab = $('[data-modtab="' + moduleId + '"]');
    if (!tab) return;
    var el = $('.t-dot', tab);
    if (!n) { if (el) el.remove(); return; }
    if (!el) {
      el = document.createElement('span');
      el.className = 't-dot';
      tab.appendChild(el);
    }
    el.textContent = n > 99 ? '99+' : String(n);
  }

  function renderChrome() {
    // 底部 tab
    var tb = $('#tabbar');
    tb.innerHTML = modules.map(function (m) {
      return '<button class="tab' + (m.id === cur.module ? ' active' : '') + '" data-modtab="' + esc(m.id) + '"' +
        ' data-act="__goto" data-p="' + esc(encodeURIComponent(JSON.stringify([m.id, null]))) + '">' +
        '<span class="t-ic">' + (m.icon || '•') + '</span><span>' + esc(m.tabName || m.name) + '</span></button>';
    }).join('');

    // 二级导航
    var mod = modMap[cur.module];
    var st = $('#subtabs');
    if (!mod || mod.pages.length <= 1) { st.classList.add('hidden'); st.innerHTML = ''; return; }
    st.classList.remove('hidden');
    st.innerHTML = mod.pages.map(function (p) {
      return '<button class="subtab' + (p.id === cur.page ? ' active' : '') + '"' +
        ' data-act="__gotopage" data-p="' + esc(encodeURIComponent(JSON.stringify(p.id))) + '">' +
        (p.icon ? p.icon + ' ' : '') + esc(p.title) + '</button>';
    }).join('');
  }

  function renderPage() {
    var mod = modMap[cur.module];
    var box = $('#content');
    if (!mod) { box.innerHTML = errBox('没有可用模块'); return; }

    var page = mod.pages.filter(function (p) { return p.id === cur.page; })[0] || mod.pages[0];
    setTitle(page.title, mod.subtitle || mod.name);

    // 连接检查
    var missing = mod.conns.filter(function (n) { return !getConn(n).configured; });
    if (missing.length) {
      box.innerHTML = card(
        '<div class="empty" style="padding:28px 12px">' +
        '<span class="e-ic">🔗</span>' +
        '<div style="font-size:15px;font-weight:600;color:var(--text);margin-bottom:6px">需要先连接数据源</div>' +
        '<div class="muted tiny" style="margin-bottom:16px;line-height:1.7">' + esc(mod.name) + ' 需要以下连接：<br>' +
        missing.map(function (n) { var c = getConn(n); return c.icon + ' ' + esc(c.label); }).join('<br>') +
        '</div>' +
        missing.map(function (n) {
          return '<button class="btn btn-primary btn-block" data-act="__conn" data-p="' + esc(encodeURIComponent(JSON.stringify(n))) + '">配置 ' + esc(getConn(n).label) + '</button>';
        }).join('') +
        '</div>', { tight: true }
      );
      return;
    }

    try {
      mod.render(cur.page, box, { module: mod, page: page });
    } catch (e) {
      box.innerHTML = errBox('模块渲染异常：' + esc(e.message));
      if (window.console) console.error(e);
    }
  }

  on('__goto', function (payload) { go(payload[0], payload[1]); });
  on('__gotopage', function (payload) { goPage(payload); });
  on('__conn', function (payload) { connSheet(payload, function () { renderPage(); }); });

  /* ======================================================================
     10. 内置「设置」模块
     ====================================================================== */
  function settingRow(title, sub, right, actName, payload) {
    return li({
      title: title, sub: sub, rawTitle: true,
      right: right,
      onClick: actName ? { name: actName, payload: payload } : null
    });
  }

  function renderSettings(pageId, box) {
    if (pageId === 'conn') { renderSettingsConn(box); return; }
    if (pageId === 'security') { renderSettingsSecurity(box); return; }
    if (pageId === 'about') { renderSettingsAbout(box); return; }

    var theme = lsGet(LSKEY.theme, 'warm');
    var mode = lsGet(LSKEY.mode, 'auto');
    var lockOn = lsGet(LSKEY.lock, false);

    var html = '';
    html += '<div class="section-h">数据源连接</div>';
    html += card(list(connNames().map(function (n) {
      var c = getConn(n);
      return li({
        ic: c.icon,
        title: c.label,
        sub: c.configured ? (c.url.replace(/^https?:\/\//, '').split('.')[0] + ' · 已配置') : '未配置',
        badge: dot(c.configured ? '已连接' : '未连接', c.configured ? 'ok' : 'err'),
        onClick: { name: 'set:conn', payload: n }
      });
    })), { tight: true });

    html += '<div class="section-h">外观</div>';
    html += card(
      '<div class="field" style="margin-bottom:12px"><label>主题</label>' +
      fchips(THEMES.map(function (t) { return { v: t.id, l: t.name }; }), theme, 'set:theme') +
      '</div>' +
      '<div class="field mb0"><label>深浅模式</label>' +
      fchips([{ v: 'auto', l: '跟随系统' }, { v: 'light', l: '浅色' }, { v: 'dark', l: '深色' }], mode, 'set:mode') +
      '</div>', { tight: true });

    html += '<div class="section-h">安全</div>';
    html += card(list([
      settingRow('应用密码（PIN）', '打开应用时需输入 4-8 位数字', dot(lockOn ? '已开启' : '未开启', lockOn ? 'ok' : 'muted'), 'set:security'),
      settingRow('清除本机全部数据', '连接、密码、页面记忆都会被删除', '', 'set:wipe')
    ]), { tight: true });

    html += '<div class="section-h">关于</div>';
    html += card(list([
      settingRow('版本信息与使用帮助', 'PWA 安装、外网访问、模块说明', '', 'set:about')
    ]), { tight: true });

    box.innerHTML = html;
  }

  function renderSettingsConn(box) {
    box.innerHTML =
      card('<div class="tiny muted" style="line-height:1.8">' +
        '每个模块可以连接不同的 Supabase 项目。key 只存在这台手机的浏览器里，代码里没有任何密钥。' +
        '<br><br><strong>只读</strong>：用 anon key，能看不能改。<br><strong>可管理</strong>：用 service_role key，可增删改。' +
        '</div>', { tight: true }) +
      card(list(connNames().map(function (n) {
        var c = getConn(n);
        return li({
          ic: c.icon, title: c.label, sub: c.url ? c.url.replace(/^https?:\/\//, '') : '未填写',
          badge: dot(c.configured ? '已连接' : '未连接', c.configured ? 'ok' : 'err'),
          onClick: { name: 'set:conn', payload: n }
        });
      })), { tight: true });
  }

  function renderSettingsSecurity(box) {
    var on = lsGet(LSKEY.lock, false);
    box.innerHTML = card(
      toggle({ name: 'lockon', label: '启用应用密码', sub: '每次打开需要输入 PIN', checked: on }) +
      '<div class="field" style="margin-top:6px">' +
      '<label>设置新的 PIN（4-8 位数字，留空表示不修改）</label>' +
      '<input class="inp" data-name="pin" inputmode="numeric" maxlength="8" placeholder="例如 1234">' +
      '<div class="help">忘记 PIN 只能在锁屏页点击「清除本机数据」重来（数据库里的数据不受影响）。若要删除旧 PIN，先关闭上面的开关再保存。</div>' +
      '</div>' +
      '<button class="btn btn-primary btn-block" data-act="set:savesecurity">保存安全设置</button>',
      { tight: true }
    );
  }

  function renderSettingsAbout(box) {
    box.innerHTML =
      card('<div class="kv"><div class="kv-k">应用</div><div class="kv-v">移动后台 · 手机端管理台</div></div>' +
        '<div class="kv"><div class="kv-k">形态</div><div class="kv-v">PWA 网页应用，可"添加到主屏幕"</div></div>' +
        '<div class="kv"><div class="kv-k">已装模块</div><div class="kv-v">' + modules.map(function (m) { return esc(m.name); }).join('、') + '</div></div>' +
        '<div class="kv"><div class="kv-k">运行方式</div><div class="kv-v">纯静态前端，浏览器直连 Supabase，不经过任何中转服务器</div></div>',
        { tight: true }) +
      card('<div class="card-title">怎么装到手机主屏幕</div>' +
        '<div class="tiny" style="line-height:1.9;color:var(--text2)">' +
        '<strong>iPhone / Safari</strong>：点底部「分享」→「添加到主屏幕」。<br>' +
        '<strong>安卓 / Chrome</strong>：点右上角「⋮」→「安装应用」或「添加到主屏幕」。<br>' +
        '装好后会全屏运行，和 App 一样，断网时打开也能看到界面。' +
        '</div>', { tight: true }) +
      card('<div class="card-title">安全提示</div>' +
        '<div class="tiny" style="line-height:1.9;color:var(--text2)">' +
        'service_role key 拥有数据库完全权限。本应用不把它写进代码，只存在你的手机里。<br>' +
        '请务必给手机设置锁屏密码；不要在公共设备上保存 key。<br>' +
        '如果怀疑 key 泄露，到 Supabase 控制台重新生成即可。' +
        '</div>', { tight: true });
  }

  function applyTheme() {
    var theme = lsGet(LSKEY.theme, 'warm');
    var mode = lsGet(LSKEY.mode, 'auto');
    document.documentElement.setAttribute('data-theme', theme);
    var dark = mode === 'dark' || (mode === 'auto' && window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches);
    document.documentElement.setAttribute('data-mode', dark ? 'dark' : 'light');
    var meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', dark ? '#171716' : '#f6f1e8');
    if (dark && theme !== 'night') {
      // 深浅模式 = 夜间配色
      document.documentElement.setAttribute('data-theme', 'night');
    }
  }

  on('set:conn', function (name) { connSheet(name, function () { renderPage(); }); });
  on('set:theme', function (t) { lsSet(LSKEY.theme, t); applyTheme(); renderPage(); });
  on('set:mode', function (m) { lsSet(LSKEY.mode, m); applyTheme(); renderPage(); });
  on('set:security', function () { go('settings', 'security'); });
  on('set:about', function () { go('settings', 'about'); });
  on('set:connpage', function () { go('settings', 'conn'); });
  on('set:wipe', function () {
    confirmBox({ title: '清除本机数据', msg: '连接信息、PIN、页面记忆都会被删除。数据库里的数据不受影响。', okText: '确认清除', danger: true })
      .then(function (ok) {
        if (!ok) return;
        Object.keys(LSKEY).forEach(function (k) { lsDel(LSKEY[k]); });
        toast('已清除，正在重启…', 'ok');
        setTimeout(function () { location.reload(); }, 700);
      });
  });
  on('set:savesecurity', function () {
    var root = $('#content');
    var d = formData(root);
    var pin = String(d.pin || '').trim();
    if (pin) {
      if (!/^\d{4,8}$/.test(pin)) { toast('PIN 必须是 4-8 位数字', 'err'); return; }
      setPin(pin).then(function () {
        lsSet(LSKEY.lock, !!d.lockon);
        toast('安全设置已保存', 'ok');
        renderPage();
      });
    } else {
      if (!d.lockon) lsDel(LSKEY.pin);
      lsSet(LSKEY.lock, !!d.lockon && !!lsGet(LSKEY.pin, null));
      if (d.lockon && !lsGet(LSKEY.pin, null)) { toast('请先设置一个 PIN', 'err'); return; }
      toast('安全设置已保存', 'ok');
      renderPage();
    }
  });

  registerModule({
    id: 'settings',
    name: '设置',
    tabName: '设置',
    icon: '⚙️',
    subtitle: '连接 · 外观 · 安全',
    pages: [
      { id: 'main', title: '设置' },
      { id: 'conn', title: '数据源连接' },
      { id: 'security', title: '安全' },
      { id: 'about', title: '关于' }
    ],
    render: renderSettings
  });

  /* ======================================================================
     11. PIN 锁
     ====================================================================== */
  function hashPin(pin, salt) {
    var text = salt + '::' + pin;
    if (window.crypto && window.crypto.subtle && window.isSecureContext) {
      try {
        return window.crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)).then(function (buf) {
          return Array.prototype.map.call(new Uint8Array(buf), function (b) { return ('0' + b.toString(16)).slice(-2); }).join('');
        });
      } catch (e) { /* fallthrough */ }
    }
    // 非安全上下文（局域网 http）下的退化实现：只是混淆，不是加密
    var h1 = 0x811c9dc5, h2 = 0x1000193;
    for (var i = 0; i < text.length; i++) {
      var c = text.charCodeAt(i);
      h1 = (h1 ^ c) * 16777619 >>> 0;
      h2 = ((h2 << 5) + h2 + c) >>> 0;
    }
    return Promise.resolve('w' + h1.toString(16) + h2.toString(16));
  }

  function setPin(pin) {
    var salt = uid() + uid();
    return hashPin(pin, salt).then(function (h) {
      lsSet(LSKEY.pin, { salt: salt, hash: h });
      return true;
    });
  }

  function checkPin(pin) {
    var rec = lsGet(LSKEY.pin, null);
    if (!rec) return Promise.resolve(true);
    return hashPin(pin, rec.salt).then(function (h) { return h === rec.hash; });
  }

  function showLock() {
    var rec = lsGet(LSKEY.pin, null);
    if (!lsGet(LSKEY.lock, false) || !rec) return false;
    var buf = '';
    var lockEl = $('#lock');
    var dots = $('#pin-dots');
    var pad = $('#pin-pad');
    lockEl.classList.remove('hidden');
    $('#app').classList.add('hidden');

    var keys = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '', '0', 'del'];
    pad.innerHTML = keys.map(function (k) {
      if (k === '') return '<div class="pin-key blank"></div>';
      if (k === 'del') return '<div class="pin-key del" data-k="del">⌫</div>';
      return '<div class="pin-key" data-k="' + k + '">' + k + '</div>';
    }).join('');

    function draw() {
      dots.innerHTML = '';
      for (var i = 0; i < 6; i++) {
        var d = document.createElement('div');
        d.className = 'pin-dot' + (i < buf.length ? ' on' : '');
        dots.appendChild(d);
      }
    }
    draw();

    pad.onclick = function (e) {
      var k = e.target.closest('[data-k]');
      if (!k) return;
      var v = k.getAttribute('data-k');
      if (v === 'del') buf = buf.slice(0, -1);
      else if (buf.length < 8) buf += v;
      draw();
      if (buf.length >= 4) {
        checkPin(buf).then(function (ok) {
          if (ok) {
            lockEl.classList.add('hidden');
            $('#app').classList.remove('hidden');
            buf = '';
            boot2();
          } else if (buf.length >= 8) {
            dots.classList.add('shake');
            setTimeout(function () { dots.classList.remove('shake'); }, 420);
            buf = ''; draw();
            toast('密码不对，再试一次', 'err');
          }
        });
      }
    };
    $('#lock-forget').onclick = function () {
      confirmBox({ title: '清除本机数据', msg: '将删除本机保存的连接和 PIN，数据库数据不受影响。', okText: '清除并重启', danger: true })
        .then(function (ok) {
          if (!ok) return;
          Object.keys(LSKEY).forEach(function (k) { lsDel(LSKEY[k]); });
          location.reload();
        });
    };
    return true;
  }

  /* ======================================================================
     12. 启动流程
     ====================================================================== */
  function renderSetup() {
    var box = $('#setup-conns');
    var html = '';
    connNames().forEach(function (n) {
      var c = getConn(n);
      html += '<div class="field" style="text-align:left">' +
        '<label>' + c.icon + ' ' + esc(c.label) + '</label>' +
        '<input class="inp" data-setup-name="' + esc(n) + '" placeholder="粘贴 API Key（可稍后在设置里填）" value="">' +
        '<div class="help">' + esc(c.url) + '</div>' +
        '</div>';
    });
    box.innerHTML = html;
    $('#setup-save').onclick = function () {
      var any = false;
      $$('[data-setup-name]').forEach(function (inp) {
        var n = inp.getAttribute('data-setup-name');
        var v = inp.value.trim();
        if (v) { setConn(n, CONN_DEF[n].url, v); any = true; }
      });
      lsSet(LSKEY.setup, true);
      $('#setup').classList.add('hidden');
      if (any) toast('已保存，可以开始了', 'ok');
      startApp();
    };
    $('#setup-skip').onclick = function () {
      lsSet(LSKEY.setup, true);
      $('#setup').classList.add('hidden');
      startApp();
    };
  }

  function startApp() {
    $('#boot').classList.add('hidden');
    if (showLock()) return;
    $('#app').classList.remove('hidden');
    boot2();
  }

  var booted = false;
  function boot2() {
    if (booted) return;
    booted = true;
    // PWA 快捷方式（manifest.shortcuts）会带 #scan / #xhy / #pr 打开
    var hash = String(location.hash || '').replace(/^#/, '').split('/')[0];
    var first = pageMem.module && modMap[pageMem.module] ? pageMem.module : modules[0].id;
    if (hash && modMap[hash] && modMap[hash].pages.some(function (p) { return p.id === pageMem.pages[hash]; })) {
      first = hash;
    } else if (hash && modMap[hash]) {
      first = hash;
      pageMem.pages[hash] = modMap[hash].pages[0].id;
    }
    go(first, pageMem.pages[first]);
    registerSW();
  }

  function registerSW() {
    if (!('serviceWorker' in navigator)) return;
    if (location.protocol === 'file:') return;
    navigator.serviceWorker.register('sw.js').catch(function () { });
  }

  document.addEventListener('DOMContentLoaded', function () {
    applyTheme();
    if (window.matchMedia) {
      try {
        window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', function () {
          applyTheme();
        });
      } catch (e) { }
    }

    $('#btn-refresh').addEventListener('click', function () {
      var b = this;
      b.classList.add('busy');
      refresh();
      setTimeout(function () { b.classList.remove('busy'); }, 600);
    });
    $('#btn-settings').addEventListener('click', function () { go('settings', 'main'); });

    // 离线提示
    window.addEventListener('online', function () { toast('网络已恢复', 'ok'); });
    window.addEventListener('offline', function () { toast('已离线，部分数据可能无法加载', 'warn'); });

    setTimeout(function () {
      if (!lsGet(LSKEY.setup, false) && !connNames().some(function (n) { return getConn(n).configured; })) {
        $('#boot').classList.add('hidden');
        $('#setup').classList.remove('hidden');
        renderSetup();
      } else {
        startApp();
      }
    }, 350);
  });

  /* ======================================================================
     13. 导出
     ====================================================================== */
  window.DS = {
    // 工具
    $: $, $$: $$, esc: esc, uid: uid, clone: clone, isArr: isArr, isObj: isObj, numOr: numOr, short: short,
    fmtTime: fmtTime, fmtDate: fmtDate, fmtAgo: fmtAgo, fmtMoney: fmtMoney, fmtNum: fmtNum,
    daysLeft: daysLeft, toDate: toDate, todayStart: todayStart, daysAgoISO: daysAgoISO, daysLaterISO: daysLaterISO,
    lsGet: lsGet, lsSet: lsSet, lsDel: lsDel,

    // 弹层
    toast: toast, sheet: sheet, closeSheet: closeSheet, closeAllOverlays: closeAllOverlays,
    confirm: confirmBox, prompt: promptBox, alert: alertBox,

    // 事件
    on: on, act: act, bind: bind,

    // 连接与数据
    connNames: connNames, conn: getConn, setConn: setConn, connSheet: connSheet, requireConn: requireConn,
    api: api, apiAll: apiAll, totalOf: totalOf,

    // 表单
    field: field, input: input, number: number, password: password, textarea: textarea, select: select, toggle: toggle,
    formData: formData, setForm: setForm, validate: validate,

    // 展示
    loading: loading, empty: empty, errBox: errBox, card: card, chip: chip, dot: dot, stat: stat, statGrid: statGrid,
    li: li, list: list, kv: kv, kvgrid: kvgrid, actions: actions, bar: bar, banner: banner,
    searchBox: searchBox, fchips: fchips, pagerHtml: pagerHtml,
    pager: pagerState, pagerReset: pagerReset, onPager: onPager, savePagerState: savePagerState, onSearch: onSearch,

    // 杂项
    copy: copy, download: download, pickFile: pickFile, COLOR: COLOR, THEMES: THEMES,

    // 路由
    registerModule: registerModule, module: moduleOf, modules: function () { return modules.slice(); },
    go: go, goPage: goPage, refresh: refresh, setTitle: setTitle, setSubtitle: setSubtitle, setBadge: setBadge,
    get current() { return { module: cur.module, page: cur.page }; }
  };
})();
