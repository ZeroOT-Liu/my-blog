/* ==========================================================================
   模块：项目后台（手机优先）· modules/pr.js
   --------------------------------------------------------------------------
   用途：
     把桌面版「项目后台」(5-个人博客/admin.html 里的 tab-pr-admin / pr-* 那一套)
     改造成手机优先的 PWA 模块，并把存储从「只存在电脑浏览器 localStorage」升级为
       1) 首选云端 Supabase —— 手机和电脑看到同一份数据；
       2) 云端不可用时自动降级为 localStorage —— 数据只存在这台手机。

   连接名：'prj'（app.js 的 CONN_DEF.prj，默认指向 uwgqflcjuixmdhgzlvmb）
   表名：  projects

   云端表结构（见 sql/projects_table.sql）：
     id          uuid        主键，默认 gen_random_uuid()
     name        text        项目名称
     client      text        客户
     tech        text        技术栈
     tags        text[]      标签
     status      text        active | paused | done
     amount      numeric     金额
     paid        numeric     已回款
     deadline    date        截止日期
     notes       text        项目笔记
     tasks       jsonb       任务清单 [{id,name,owner,weight,done}]
     code        jsonb       代码片段 [{id,title,lang,body}]
     history     jsonb       动态 [{text,time}]
     sort_order  int         排序
     created_at  timestamptz 默认 now()
     updated_at  timestamptz 默认 now()

   本机离线回退：localStorage key = 'dsh.prj.projects.v1'（数组，元素字段同上）

   页面（二级导航）：
     list   项目列表（搜索 / 状态筛选 / 分页 / 新建）
     detail 项目详情（概览 / KPI 进度 / 动态 / 任务 / 笔记 / 代码片段 / 删除）
     stats  统计
     more   更多（导出 JSON / 导入 JSON / 本机数据管理 / 连接状态）
   项目详情是独立页面（框架的弹层栈不支持嵌套弹层，页面最稳），
   页面内有「‹ 返回项目列表」，也可以用底部二级导航切换。
   页面状态 key 前缀统一为 pr.
   ========================================================================== */
(function () {
  'use strict';

  var DS = window.DS;
  if (!DS) return;

  /* ======================================================================
     0. 常量
     ====================================================================== */
  var CONN = 'prj';                       // 连接名（app.js CONN_DEF.prj）
  var TABLE = 'projects';                 // 云端表名
  var LOCAL_KEY = 'dsh.prj.projects.v1';  // 本地回退存储 key
  var LIST_KEY = 'pr.list';               // 列表分页 / 搜索状态 key
  var PAGE_SIZE = 10;                     // 每页条数
  var HISTORY_MAX = 60;                   // 每个项目最多保留多少条动态
  var MAX_ROWS = 2000;                    // 云端一次最多拉取多少行

  var STATUS_LABEL = { active: '进行中', paused: '暂停', done: '已交付' };
  var STATUS_TYPE = { active: '', paused: 'warn', done: 'ok' };
  var STATUS_ORDER = ['active', 'paused', 'done'];

  // 降级原因（DS.banner 里展示给用户看的话）
  var REASON = {
    unconfigured: '还没有配置「项目后台」的 Supabase 连接（设置 → 数据源连接 → 📋 项目后台）',
    notable: '云端表 public.projects 不存在，或 URL 不对（HTTP 404）。请先在 Supabase 执行 sql/projects_table.sql',
    denied: '云端拒绝了访问（HTTP 401/403）。管理数据需要 service_role key，或该表策略不允许',
    network: '连不上云端（网络不通 / 被代理拦截 / Supabase 项目已暂停）',
    other: '云端返回了错误'
  };

  /* ======================================================================
     1. 小工具（全部 ES5，不使用 find / includes / 箭头函数）
     ====================================================================== */
  function numOr(v, d) { return DS.numOr(v, d); }

  function isUuid(v) {
    return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(v || ''));
  }

  function nowISO() { return new Date().toISOString(); }

  function toTime(t) {
    var d = DS.toDate(t);
    return d ? d.getTime() : 0;
  }

  /** 通用「转数组」：真数组原样返回，JSON 字符串尝试解析 */
  function anyToArr(v) {
    if (DS.isArr(v)) return v;
    if (typeof v === 'string') {
      var s = v.trim();
      if (!s) return [];
      if (s.charAt(0) === '[') {
        try {
          var p = JSON.parse(s);
          if (DS.isArr(p)) return p;
        } catch (e) { }
      }
      return [];
    }
    return [];
  }

  /** 标签：数组 / "a,b" 字符串 / JSON 数组字符串都可以 */
  function tagsToArr(v) {
    if (DS.isArr(v)) return cleanTags(v);
    if (typeof v === 'string') {
      var s = v.trim();
      if (!s) return [];
      if (s.charAt(0) === '[') {
        try {
          var p = JSON.parse(s);
          if (DS.isArr(p)) return cleanTags(p);
        } catch (e) { }
      }
      return parseTags(s);
    }
    return [];
  }

  function cleanTags(list) {
    var out = [];
    for (var i = 0; i < list.length; i++) {
      var t = String(list[i] === null || list[i] === undefined ? '' : list[i]).trim();
      if (t && out.indexOf(t) < 0) out.push(t);
    }
    return out;
  }

  /** "CAD, Web 工具；研发" -> ['CAD','Web','工具','研发'] */
  function parseTags(v) {
    if (DS.isArr(v)) return cleanTags(v);
    var s = String(v === null || v === undefined ? '' : v);
    return cleanTags(s.split(/[,，;；\s]+/));
  }

  function statusOf(v) {
    return (v === 'paused' || v === 'done') ? v : 'active';
  }

  function indexOfId(list, id) {
    for (var i = 0; i < list.length; i++) {
      if (String(list[i].id) === String(id)) return i;
    }
    return -1;
  }

  function indexOfTask(p, tid) {
    var t = (p && p.tasks) || [];
    for (var i = 0; i < t.length; i++) {
      if (String(t[i].id) === String(tid)) return i;
    }
    return -1;
  }

  function indexOfCode(p, cid) {
    var c = (p && p.code) || [];
    for (var i = 0; i < c.length; i++) {
      if (String(c[i].id) === String(cid)) return i;
    }
    return -1;
  }

  /* ======================================================================
     2. 数据规整（云端 / 本地 / 导入 都走这里）
     ====================================================================== */
  function normTask(t) {
    t = t || {};
    return {
      id: t.id ? String(t.id) : DS.uid(),
      name: t.name === null || t.name === undefined ? '' : String(t.name),
      owner: t.owner === null || t.owner === undefined ? '' : String(t.owner),
      weight: numOr(t.weight, 1) || 1,
      done: !!t.done
    };
  }

  function normCode(c) {
    c = c || {};
    return {
      id: c.id ? String(c.id) : DS.uid(),
      title: c.title === null || c.title === undefined ? '' : String(c.title),
      lang: c.lang === null || c.lang === undefined ? '' : String(c.lang),
      body: c.body === null || c.body === undefined ? '' : String(c.body)
    };
  }

  function normHistory(h) {
    h = h || {};
    return {
      text: h.text === null || h.text === undefined ? '' : String(h.text),
      time: h.time ? String(h.time) : nowISO()
    };
  }

  /** 把任意来源（云端行 / localStorage / 导入 JSON）规整成模块内部结构 */
  function normalize(raw) {
    var p = raw || {};
    var out = {};
    out.id = p.id ? String(p.id) : DS.uid();
    out.name = p.name === null || p.name === undefined ? '' : String(p.name);
    out.client = p.client === null || p.client === undefined ? '' : String(p.client);
    out.tech = p.tech === null || p.tech === undefined ? '' : String(p.tech);
    out.tags = tagsToArr(p.tags);
    out.status = statusOf(p.status);
    out.amount = numOr(p.amount, 0);
    out.paid = numOr(p.paid, 0);
    out.deadline = p.deadline ? String(p.deadline).slice(0, 10) : '';
    out.notes = p.notes === null || p.notes === undefined ? '' : String(p.notes);
    out.sort_order = numOr(p.sort_order, 0);
    out.created_at = p.created_at ? String(p.created_at) : nowISO();
    out.updated_at = p.updated_at ? String(p.updated_at) : out.created_at;

    var i, arr;
    out.tasks = [];
    arr = anyToArr(p.tasks);
    for (i = 0; i < arr.length; i++) out.tasks.push(normTask(arr[i]));

    out.code = [];
    arr = anyToArr(p.code);
    for (i = 0; i < arr.length; i++) out.code.push(normCode(arr[i]));

    out.history = [];
    arr = anyToArr(p.history);
    for (i = 0; i < arr.length; i++) out.history.push(normHistory(arr[i]));
    out.history = out.history.slice(0, HISTORY_MAX);

    return out;
  }

  /** 生成要写进云端的载荷（不带 created_at，updated_at 由触发器 / 这里维护） */
  function toPayload(p, withId) {
    var o = {
      name: p.name || '未命名项目',
      client: p.client || '',
      tech: p.tech || '',
      tags: p.tags || [],
      status: statusOf(p.status),
      amount: numOr(p.amount, 0),
      paid: numOr(p.paid, 0),
      deadline: p.deadline ? p.deadline : null,
      notes: p.notes || '',
      tasks: p.tasks || [],
      code: p.code || [],
      history: p.history || [],
      sort_order: numOr(p.sort_order, 0),
      updated_at: nowISO()
    };
    if (withId) o.id = p.id;
    return o;
  }

  function sortList(arr) {
    return arr.slice().sort(function (a, b) {
      var sa = numOr(a.sort_order, 0);
      var sb = numOr(b.sort_order, 0);
      if (sa !== sb) return sa - sb;
      return toTime(b.created_at) - toTime(a.created_at); // 同序号时新的在前
    });
  }

  function replaceOrPush(all, item) {
    var i = indexOfId(all, item.id);
    if (i >= 0) all[i] = item; else all.push(item);
    return all;
  }

  /* ======================================================================
     3. 业务计算
     ====================================================================== */
  /** 完成率（按任务权重，权重缺失时按 1 计） */
  function prProgress(p) {
    var list = (p && p.tasks) || [];
    if (!list.length) return 0;
    var total = 0, done = 0, i;
    for (i = 0; i < list.length; i++) {
      var w = numOr(list[i].weight, 1) || 1;
      total += w;
      if (list[i].done) done += w;
    }
    return total ? Math.round(done / total * 100) : 0;
  }

  function taskStat(p) {
    var list = (p && p.tasks) || [];
    var done = 0, i;
    for (i = 0; i < list.length; i++) if (list[i].done) done++;
    return { total: list.length, done: done };
  }

  function prRemain(p) {
    return Math.max(0, numOr(p.amount, 0) - numOr(p.paid, 0));
  }

  function isOverdue(p) {
    if (p.status === 'done' || !p.deadline) return false;
    var d = DS.daysLeft(p.deadline);
    return d !== null && d < 0;
  }

  function addHistory(p, text) {
    var list = DS.isArr(p.history) ? p.history.slice() : [];
    list.unshift({ text: String(text || ''), time: nowISO() });
    p.history = list.slice(0, HISTORY_MAX);
  }

  function filterProjects(all, kw, status) {
    var q = String(kw || '').toLowerCase();
    var out = [];
    for (var i = 0; i < all.length; i++) {
      var p = all[i];
      if (status && status !== 'all' && p.status !== status) continue;
      if (q) {
        var text = [p.name, p.client, p.tech].concat(p.tags || []).join(' ').toLowerCase();
        if (text.indexOf(q) < 0) continue;
      }
      out.push(p);
    }
    return out;
  }

  function countByStatus(list) {
    var c = { all: list.length, active: 0, paused: 0, done: 0 };
    for (var i = 0; i < list.length; i++) {
      if (c[list[i].status] !== undefined) c[list[i].status]++;
    }
    return c;
  }

  function statsOf(list) {
    var o = {
      total: list.length, active: 0, paused: 0, done: 0,
      amount: 0, paid: 0, remain: 0, overdue: 0, avg: 0,
      tasks: 0, tasksDone: 0
    };
    for (var i = 0; i < list.length; i++) {
      var p = list[i];
      if (o[p.status] !== undefined) o[p.status]++;
      o.amount += numOr(p.amount, 0);
      o.paid += numOr(p.paid, 0);
      o.remain += prRemain(p);
      if (isOverdue(p)) o.overdue++;
      o.avg += prProgress(p);
      var tk = p.tasks || [];
      o.tasks += tk.length;
      for (var j = 0; j < tk.length; j++) if (tk[j].done) o.tasksDone++;
    }
    o.avg = o.total ? Math.round(o.avg / o.total) : 0;
    return o;
  }

  /* ======================================================================
     4. 存储层（云端 Supabase 优先，出错自动降级为 localStorage）
     ====================================================================== */
  function localRaw() {
    var v = DS.lsGet(LOCAL_KEY, null);
    if (!DS.isArr(v)) v = [];
    var out = [];
    for (var i = 0; i < v.length; i++) out.push(normalize(v[i]));
    return sortList(out);
  }

  function localWrite(list) {
    var arr = sortList(list);
    DS.lsSet(LOCAL_KEY, arr);
    return arr;
  }

  /** 本地写入（新增或覆盖） */
  function localUpsert(p) {
    var all = localRaw();
    var it = normalize(p);
    var now = nowISO();
    it.updated_at = now;
    if (!it.created_at) it.created_at = now;
    all = replaceOrPush(all, it);
    localWrite(all);
    return it;
  }

  function localRemove(id) {
    var all = localRaw();
    var i = indexOfId(all, id);
    if (i >= 0) all.splice(i, 1);
    localWrite(all);
  }

  function errKind(err) {
    if (!err) return 'other';
    if (err.unconfigured) return 'unconfigured';
    var s = err.status;
    if (s === 404) return 'notable';
    if (s === 401 || s === 403) return 'denied';
    var m = String(err.message || '');
    if (/Failed to fetch|NetworkError|Load failed|网络不通/i.test(m)) return 'network';
    return 'other';
  }

  var Store = {
    mode: 'cloud',      // 'cloud' | 'local'
    reasonKind: '',
    reason: '',
    cache: [],          // 内存中的项目数组（归一化后的对象）
    cloudIds: {},       // 云端确实存在的 id（决定 PATCH 还是 POST）

    /** 降级到本地模式（不弹 toast，由调用方决定提示） */
    degrade: function (kind, rawMsg) {
      if (Store.mode === 'local' && Store.reasonKind === kind) return;
      Store.mode = 'local';
      Store.reasonKind = kind || 'other';
      Store.reason = REASON[Store.reasonKind] || REASON.other;
      if (rawMsg) Store.reason += '。云端返回：' + String(rawMsg).slice(0, 160);
      // 本机还没有任何数据时，把当前已读到的云端数据镜像一份，避免切换后列表突然变空
      try {
        if (DS.lsGet(LOCAL_KEY, null) === null && Store.cache.length) {
          localWrite(Store.cache);
        }
      } catch (e) { }
    },

    resetCloud: function () {
      Store.mode = 'cloud';
      Store.reasonKind = '';
      Store.reason = '';
      Store.cloudIds = {};
    },

    /** 读取全部项目 -> Promise<{data, error, mode}> */
    list: function () {
      // 之前因为「没配置」降级的，用户可能刚在设置里填好 key -> 自动再试云端
      if (Store.mode === 'local' && Store.reasonKind === 'unconfigured' && DS.conn(CONN).configured) {
        Store.resetCloud();
      }
      if (Store.mode === 'local') {
        Store.cache = localRaw();
        return Promise.resolve({ data: Store.cache, error: null, mode: 'local' });
      }
      if (!DS.conn(CONN).configured) {
        Store.degrade('unconfigured');
        Store.cache = localRaw();
        return Promise.resolve({ data: Store.cache, error: null, mode: 'local' });
      }
      return DS.apiAll(CONN, TABLE, { select: '*', order: 'sort_order', ascending: true }, MAX_ROWS)
        .then(function (res) {
          if (res.error) {
            Store.degrade(errKind(res.error), res.error.message);
            Store.cache = localRaw();
            return { data: Store.cache, error: null, mode: 'local', cloudError: res.error };
          }
          var rows = res.data || [];
          var ids = {};
          var arr = [];
          for (var i = 0; i < rows.length; i++) {
            var p = normalize(rows[i]);
            ids[p.id] = true;
            arr.push(p);
          }
          Store.cloudIds = ids;
          Store.cache = sortList(arr);
          return { data: Store.cache, error: null, mode: 'cloud' };
        });
    },

    /** 取单个项目（优先内存缓存，取不到再拉一次） */
    get: function (id) {
      var i = indexOfId(Store.cache, id);
      if (i >= 0) return Promise.resolve(Store.cache[i]);
      return Store.list().then(function () {
        var j = indexOfId(Store.cache, id);
        return j >= 0 ? Store.cache[j] : null;
      });
    },

    cachePut: function (p) {
      var i = indexOfId(Store.cache, p.id);
      if (i >= 0) Store.cache[i] = p; else Store.cache.push(p);
      Store.cache = sortList(Store.cache);
    },

    cacheRemove: function (id) {
      var i = indexOfId(Store.cache, id);
      if (i >= 0) Store.cache.splice(i, 1);
    },

    /**
     * 新增 / 保存一个项目
     * opts: { okMsg, silent }
     * -> Promise<{data, error, degraded}>
     */
    upsert: function (p, opts) {
      opts = opts || {};

      // ---- 本地模式（或连接没配好）----
      if (Store.mode === 'local' || !DS.conn(CONN).configured) {
        if (Store.mode === 'cloud') {
          Store.degrade('unconfigured');
          Store.cache = localRaw();
        }
        var savedLocal = localUpsert(p);
        Store.cache = localRaw();
        if (!opts.silent) DS.toast((opts.okMsg || '已保存') + '（本机）', 'ok');
        return Promise.resolve({ data: savedLocal, error: null, degraded: true, mode: 'local' });
      }

      // ---- 云端模式 ----
      var existing = Store.cloudIds[String(p.id)] === true;
      var payload = toPayload(p, false);
      var o;
      if (existing) {
        o = { method: 'PATCH', filters: { id: p.id }, data: payload };
      } else {
        o = { method: 'POST', data: payload };
        if (isUuid(p.id)) {
          // 带 uuid 主键插入：用 upsert，重复导入同一份数据不会报 409，而是覆盖
          payload.id = p.id;
          o.upsert = true;
          o.onConflict = 'id';
        }
      }

      return DS.api(CONN, TABLE, o).then(function (res) {
        if (res.error) {
          DS.toast('云端保存失败：' + res.error.message, 'err');
          Store.degrade(errKind(res.error), res.error.message);
          var saved = localUpsert(p);   // 不让用户白填，先落到本机
          Store.cache = localRaw();
          DS.toast('已改存到本机（本地模式）', 'warn');
          return { data: saved, error: res.error, degraded: true, mode: 'local' };
        }
        var rows = res.data || [];
        var out = rows.length ? normalize(rows[0]) : normalize(p);
        Store.cloudIds[out.id] = true;
        Store.cachePut(out);
        if (!opts.silent) DS.toast(opts.okMsg || '已保存', 'ok');
        return { data: out, error: null, mode: 'cloud' };
      });
    },

    /** 删除项目 -> Promise<{error, degraded}> */
    remove: function (id, opts) {
      opts = opts || {};

      if (Store.mode === 'local' || !DS.conn(CONN).configured) {
        if (Store.mode === 'cloud') {
          Store.degrade('unconfigured');
          Store.cache = localRaw();
        }
        localRemove(id);
        Store.cacheRemove(id);
        if (!opts.silent) DS.toast(opts.okMsg || '已删除（本机）', 'ok');
        return Promise.resolve({ error: null, degraded: true, mode: 'local' });
      }

      return DS.api(CONN, TABLE, { method: 'DELETE', filters: { id: id } }).then(function (res) {
        if (res.error) {
          DS.toast('云端删除失败：' + res.error.message, 'err');
          Store.degrade(errKind(res.error), res.error.message);
          localRemove(id);
          Store.cacheRemove(id);
          DS.toast('已从本机删除（本地模式）', 'warn');
          return { error: res.error, degraded: true, mode: 'local' };
        }
        Store.cacheRemove(id);
        delete Store.cloudIds[String(id)];
        if (!opts.silent) DS.toast(opts.okMsg || '已删除', 'ok');
        return { error: null, mode: 'cloud' };
      });
    },

    /**
     * 批量导入 / 同步（同 id 覆盖，其余追加）
     * -> Promise<{ok, fail:[], mode}>
     */
    mergeAll: function (arr, opts) {
      opts = opts || {};
      var items = [];
      var i;
      for (i = 0; i < arr.length; i++) items.push(normalize(arr[i]));

      if (Store.mode === 'local' || !DS.conn(CONN).configured) {
        if (Store.mode === 'cloud') Store.degrade('unconfigured');
        var all = localRaw();
        for (i = 0; i < items.length; i++) all = replaceOrPush(all, items[i]);
        Store.cache = localWrite(all);
        return Promise.resolve({ ok: items.length, fail: [], mode: 'local' });
      }

      var ok = 0;
      var fail = [];
      var k = 0;
      function step() {
        if (k >= items.length) return Promise.resolve({ ok: ok, fail: fail, mode: Store.mode });
        var it = items[k++];
        // 云端主键是 uuid，本地 DS.uid() 生成的 id 不能直接用，交给数据库生成
        return Store.upsert(it, { silent: true }).then(function (r) {
          if (r.error) fail.push(it.name || it.id); else ok++;
          return step();
        });
      }
      return step();
    }
  };

  /* ======================================================================
     5. 公共片段（本地模式提示条 / 详情页引用）
     ====================================================================== */
  var detail = { id: null, body: null };   // 当前详情页（body 就是 #content）
  var lastId = null;                       // 最近打开的项目 id

  /** 本地模式提示条（页面顶部） */
  function modeBanner() {
    if (Store.mode !== 'local') return '';
    return DS.banner(
      '📴 <b>当前为本地模式</b>：数据只存在这台手机（localStorage）' +
      (Store.reason ? '。<br><span style="opacity:.85">原因：' + DS.esc(Store.reason) + '</span>' : '') +
      '<br><span style="opacity:.85">配好连接后点「重试云端」；也可以先在「更多」里导出 JSON 备份，或在云端恢复后把本机数据同步上去。</span>',
      'warn'
    );
  }

  /* ======================================================================
     6. 页面：list 项目列表
     ====================================================================== */
  var listEl = null;

  function renderList(el) {
    listEl = el;
    el.innerHTML = DS.loading('加载项目…');
    Store.list().then(function (res) {
      if (res.error) {
        el.innerHTML = modeBanner() + DS.errBox(DS.esc(res.error.message));
        return;
      }
      drawList();
      if (DS.current && DS.current.module === 'pr' && DS.current.page === 'list') {
        DS.setSubtitle('共 ' + Store.cache.length + ' 个项目 · ' +
          (Store.mode === 'cloud' ? '云端同步' : '仅本机'));
      }
    });
  }

  function drawList() {
    if (!listEl || !document.body.contains(listEl)) return;
    var st = DS.pager(LIST_KEY, PAGE_SIZE);
    var all = Store.cache || [];
    var counts = countByStatus(filterProjects(all, st.search, 'all'));
    var filtered = filterProjects(all, st.search, st.filter);
    var size = st.size || PAGE_SIZE;
    var pages = Math.max(1, Math.ceil(filtered.length / size));
    if (st.page > pages - 1) { st.page = pages - 1; DS.savePagerState(LIST_KEY); }
    var slice = filtered.slice(st.page * size, st.page * size + size);

    var html = modeBanner();
    html += '<div class="toolbar">' +
      DS.searchBox(LIST_KEY, '搜索项目 / 客户 / 技术栈 / 标签', st.search) + '</div>';
    html += DS.fchips([
      { v: 'all', l: '📋 全部', n: counts.all },
      { v: 'active', l: '🔥 进行中', n: counts.active },
      { v: 'paused', l: '⏸️ 暂停', n: counts.paused },
      { v: 'done', l: '✅ 已交付', n: counts.done }
    ], st.filter, 'pr:filter');

    if (!slice.length) {
      html += all.length
        ? DS.empty('没有匹配的项目，换个关键词或筛选条件试试', '🔍')
        : DS.empty('还没有项目。点下面「新建项目」，或到「更多」里从电脑导入 JSON。', '📋');
    } else {
      html += slice.map(cardHtml).join('');
      html += DS.pagerHtml(LIST_KEY, filtered.length, size);
    }
    html += '<button class="btn btn-primary btn-block"' + DS.act('pr:new') + '>＋ 新建项目</button>';
    listEl.innerHTML = html;
  }

  function cardHtml(p) {
    var pct = prProgress(p);
    var remain = prRemain(p);
    var dl = p.deadline ? DS.daysLeft(p.deadline) : null;
    var dlChip;
    if (dl === null) dlChip = DS.chip('无截止日', 'muted', true);
    else if (p.status === 'done') dlChip = DS.chip(dl < 0 ? '逾期交付' : '已交付', 'ok', true);
    else if (dl < 0) dlChip = DS.chip('逾期 ' + Math.abs(dl) + ' 天', 'err', true);
    else if (dl <= 3) dlChip = DS.chip('剩 ' + dl + ' 天', 'warn', true);
    else dlChip = DS.chip('剩 ' + dl + ' 天', 'muted', true);

    var tags = (p.tags || []).slice(0, 4).map(function (t) { return DS.chip(t, 'muted', true); }).join(' ');

    return '<section class="card" style="cursor:pointer"' + DS.act('pr:open', { id: p.id }) + '>' +
      '<div style="display:flex;align-items:flex-start;justify-content:space-between;gap:10px">' +
        '<div style="flex:1;min-width:0">' +
          '<div style="font-size:15.5px;font-weight:700;line-height:1.35;word-break:break-word">' +
            DS.esc(p.name || '未命名项目') + '</div>' +
          '<div class="tiny muted" style="margin-top:3px">' +
            DS.esc(p.client || '无客户') + (p.tech ? ' · ' + DS.esc(p.tech) : '') + '</div>' +
        '</div>' +
        DS.dot(STATUS_LABEL[p.status] || '进行中', STATUS_TYPE[p.status] || '') +
      '</div>' +
      (tags ? '<div style="margin-top:9px;display:flex;flex-wrap:wrap;gap:5px">' + tags + '</div>' : '') +
      '<div style="margin-top:11px">' + DS.bar(pct) + '</div>' +
      '<div style="display:flex;align-items:center;justify-content:space-between;gap:8px;margin-top:6px">' +
        '<span class="tiny muted">任务完成 ' + pct + '%</span>' + dlChip +
      '</div>' +
      '<div class="kvgrid" style="margin-top:11px">' +
        '<div class="kvi"><div class="k">金额</div><div class="v">' + DS.esc(DS.fmtMoney(p.amount)) + '</div></div>' +
        '<div class="kvi"><div class="k">待回款</div><div class="v">' + DS.esc(DS.fmtMoney(remain)) + '</div></div>' +
      '</div>' +
      '</section>';
  }

  /* ======================================================================
     7. 页面：stats 统计
     ====================================================================== */
  function renderStats(el) {
    el.innerHTML = DS.loading('统计中…');
    Store.list().then(function (res) {
      if (res.error) {
        el.innerHTML = modeBanner() + DS.errBox(DS.esc(res.error.message));
        return;
      }
      var s = statsOf(Store.cache || []);
      var html = modeBanner();
      html += '<div class="section-h">项目概况</div>';
      html += DS.statGrid([
        { icon: '📋', label: '项目总数', value: s.total },
        { icon: '📈', label: '平均完成率', value: s.avg + '%' },
        { icon: '🔥', label: '进行中', value: s.active, sub: s.total ? Math.round(s.active / s.total * 100) + '%' : '0%', subType: 'ok' },
        { icon: '⏸️', label: '暂停', value: s.paused },
        { icon: '✅', label: '已交付', value: s.done, sub: s.total ? Math.round(s.done / s.total * 100) + '%' : '0%', subType: 'ok' },
        { icon: '⚠️', label: '逾期项目', value: s.overdue, subType: s.overdue ? 'err' : '', sub: s.overdue ? '需处理' : '正常' }
      ]);
      html += '<div class="section-h">金额</div>';
      html += DS.statGrid([
        { icon: '💰', label: '总金额', value: DS.fmtMoney(s.amount) },
        { icon: '💵', label: '已回款', value: DS.fmtMoney(s.paid) },
        { icon: '⏳', label: '待回款', value: DS.fmtMoney(s.remain) },
        {
          icon: '📊', label: '回款率',
          value: (s.amount > 0 ? Math.round(s.paid / s.amount * 100) : 0) + '%',
          sub: DS.fmtMoney(s.amount > 0 ? s.amount - s.paid : 0), subType: 'warn'
        }
      ]);
      html += '<div class="section-h">任务</div>';
      html += DS.card(DS.kv([
        ['任务总数', String(s.tasks)],
        ['已完成', String(s.tasksDone)],
        ['未完成', String(Math.max(0, s.tasks - s.tasksDone))],
        ['整体任务完成率', (s.tasks ? Math.round(s.tasksDone / s.tasks * 100) : 0) + '%']
      ]), { tight: false });
      html += '<div class="section-h">状态分布</div>';
      html += DS.card(STATUS_ORDER.map(function (k) {
        var n = 0, i;
        for (i = 0; i < (Store.cache || []).length; i++) if (Store.cache[i].status === k) n++;
        var pct = s.total ? Math.round(n / s.total * 100) : 0;
        return '<div style="margin-bottom:12px">' +
          '<div style="display:flex;justify-content:space-between;font-size:13px;margin-bottom:5px">' +
          '<span>' + DS.esc(STATUS_LABEL[k]) + '</span><span class="muted">' + n + ' 个 · ' + pct + '%</span></div>' +
          DS.bar(pct) + '</div>';
      }).join(''));
      html += '<div class="tiny muted" style="margin-top:6px">统计基于当前' +
        (Store.mode === 'cloud' ? '云端' : '本机') + '的 ' + s.total + ' 个项目。</div>';
      el.innerHTML = html;
      if (DS.current && DS.current.module === 'pr' && DS.current.page === 'stats') {
        DS.setSubtitle(Store.mode === 'cloud' ? '云端数据' : '本机数据');
      }
    });
  }

  /* ======================================================================
     8. 页面：more 更多（导入 / 导出 / 本机数据）
     ====================================================================== */
  function renderMore(el) {
    el.innerHTML = DS.loading('加载…');
    Store.list().then(function () {
      var localCount = localRaw().length;
      var cloudCount = Store.mode === 'cloud' ? Store.cache.length : 0;
      var html = modeBanner();

      html += '<div class="section-h">存储状态</div>';
      html += DS.card(
        DS.kv([
          ['当前模式', Store.mode === 'cloud' ? '云端 Supabase（多设备同步）' : '本地（只存这台手机）'],
          ['连接', DS.conn(CONN).configured ? '已配置 ' + DS.esc(String(DS.conn(CONN).url).replace(/^https?:\/\//, '')) : '未配置'],
          ['云端表', TABLE],
          ['本机数据', localCount + ' 个项目'],
          ['本机 key', LOCAL_KEY]
        ]) +
        (Store.reason ? '<div class="tiny" style="margin-top:8px;line-height:1.7;color:var(--warn)">降级原因：' + DS.esc(Store.reason) + '</div>' : '') +
        '<div class="btn-row" style="margin-top:12px">' +
          '<button class="btn btn-sm btn-primary"' + DS.act('pr:cloudRetry') + '>重试云端连接</button>' +
          '<button class="btn btn-sm btn-outline"' + DS.act('__conn', CONN) + '>配置连接</button>' +
        '</div>'
      );

      html += '<div class="section-h">导出 / 导入</div>';
      html += DS.card(
        '<div class="tiny muted" style="line-height:1.8;margin-bottom:12px">' +
        '导出会把当前' + (Store.mode === 'cloud' ? '云端' : '本机') + '的全部 ' +
        (Store.mode === 'cloud' ? cloudCount : localCount) + ' 个项目写成一个 JSON 文件，' +
        '可以直接用「导入 JSON」在任意手机上恢复。' +
        '</div>' +
        '<div class="btn-row">' +
          '<button class="btn btn-sm btn-primary"' + DS.act('pr:export') + '>⬇️ 导出 JSON 文件</button>' +
          '<button class="btn btn-sm btn-outline"' + DS.act('pr:import') + '>⬆️ 导入 JSON 文件</button>' +
        '</div>' +
        '<div class="btn-row" style="margin-top:9px">' +
          '<button class="btn btn-sm btn-outline"' + DS.act('pr:importPaste') + '>📋 粘贴 JSON 文本导入</button>' +
        '</div>'
      );

      html += DS.card(
        '<div class="card-title">怎么把电脑上的老数据搬过来</div>' +
        '<div class="tiny" style="line-height:1.9;color:var(--text2)">' +
        '桌面版的项目数据一直只存在电脑浏览器里（localStorage），所以要手动搬一次：<br><br>' +
        '<b>1.</b> 电脑上打开 <span class="code">5-个人博客/admin.html</span>，进「项目管理」页。<br>' +
        '<b>2.</b> 按 F12 → Console（控制台），粘贴并回车：<br>' +
        '<div class="code-block" style="margin:8px 0">copy(localStorage.getItem(\'liuxiao.projects.v1\'))</div>' +
        '<b>3.</b> 新建一个文本文件，把剪贴板内容粘贴进去，保存成 <span class="code">projects.json</span>。' +
        '（也可以直接点桌面版的导出按钮拿到同样的 JSON）<br>' +
        '<b>4.</b> 把这个文件发到手机上（微信 / 邮件 / 网盘都行），手机打开本页 →「导入 JSON 文件」选中它。<br>' +
        '<b>5.</b> 导入完成后再导出一次备份，之后电脑和手机就都以云端为准了。' +
        '</div>', { tight: false }
      );

      html += '<div class="section-h">本机数据</div>';
      html += DS.card(
        '<div class="tiny muted" style="line-height:1.8;margin-bottom:12px">' +
        '本机数据是 localStorage 里的离线副本，云端数据不受影响。' +
        '（注意：设置里的「清除本机全部数据」不会删这个 key，只会删连接和 PIN。）' +
        '</div>' +
        '<div class="btn-row">' +
          '<button class="btn btn-sm btn-outline"' + DS.act('pr:pushLocal') + '>☁️ 把本机数据同步到云端</button>' +
          '<button class="btn btn-sm btn-danger-o"' + DS.act('pr:clearLocal') + '>🗑️ 清空本机数据</button>' +
        '</div>'
      );

      html += DS.card(
        '<div class="card-title">关于</div>' +
        '<div class="tiny" style="line-height:1.9;color:var(--text2)">' +
        '本模块由桌面版「项目后台」改造而来，数据表 <span class="code">public.projects</span>，' +
        'SQL 见仓库里的 <span class="code">sql/projects_table.sql</span>。<br>' +
        '云端读不到时会自动降级到本机存储，页面顶部会出现提示条；配置好 service_role key 后点「重试云端连接」即可切回。' +
        '</div>', { tight: false }
      );

      el.innerHTML = html;
      if (DS.current && DS.current.module === 'pr' && DS.current.page === 'more') {
        DS.setSubtitle(Store.mode === 'cloud' ? '云端模式' : '本地模式');
      }
    });
  }

  /* ======================================================================
     9. 详情弹层（全屏底部弹层，返回键可关）
     ====================================================================== */
  /**
   * 打开项目详情：切到独立页面 detail。
   * 说明：详情没有做成弹层，是因为框架的弹层栈不支持嵌套
   * （内层弹层关闭时 popstate 会把外层一起关掉）。做成页面后，
   * 「编辑信息 / 添加任务 / 删除确认」都只开一层弹层，行为最稳。
   */
  function openDetail(id) {
    lastId = id;
    DS.goPage('detail');
  }

  /** 详情页渲染 */
  function renderDetailPage(el) {
    el.innerHTML = DS.loading('加载项目详情…');
    Store.list().then(function (res) {
      if (res.error) {
        el.innerHTML = modeBanner() + DS.errBox(DS.esc(res.error.message));
        return;
      }
      var p = null;
      var i = lastId ? indexOfId(Store.cache, lastId) : -1;
      if (i >= 0) p = Store.cache[i];
      else if (Store.cache.length) { p = Store.cache[0]; lastId = p.id; }

      if (!p) {
        lastId = null;
        detail = { id: null, body: null };
        el.innerHTML = modeBanner() +
          DS.empty('还没有项目。先去「项目」列表新建一个，或到「更多」里从电脑导入 JSON。', '📋') +
          '<button class="btn btn-primary btn-block"' + DS.act('pr:back') + '>去项目列表</button>';
        return;
      }
      detail = { id: p.id, body: el };
      el.innerHTML = detailHtml(p);
      if (DS.current && DS.current.module === 'pr' && DS.current.page === 'detail') {
        DS.setTitle(p.name || '项目详情', STATUS_LABEL[p.status] + (Store.mode === 'cloud' ? ' · 云端' : ' · 本机'));
      }
    });
  }

  function detailHtml(p) {
    var pct = prProgress(p);
    var ts = taskStat(p);
    var dl = p.deadline ? DS.daysLeft(p.deadline) : null;
    var dlText = '未设置';
    if (p.deadline) {
      if (p.status === 'done') dlText = DS.fmtDate(p.deadline) + (dl !== null && dl < 0 ? '（逾期交付）' : '（已完成）');
      else if (dl === null) dlText = DS.fmtDate(p.deadline);
      else if (dl < 0) dlText = DS.fmtDate(p.deadline) + '（逾期 ' + Math.abs(dl) + ' 天）';
      else dlText = DS.fmtDate(p.deadline) + '（剩 ' + dl + ' 天）';
    }
    var tags = (p.tags || []).map(function (t) { return DS.chip(t, 'muted', true); }).join(' ');

    return '' +
      /* ---- 返回 ---- */
      '<button class="btn btn-sm btn-outline" style="margin-bottom:12px"' + DS.act('pr:back') + '>‹ 返回项目列表</button>' +

      /* ---- 头部 ---- */
      '<div class="detail-head">' +
        '<div class="detail-title">' + DS.esc(p.name || '未命名项目') + '</div>' +
        '<div style="margin-top:8px;display:flex;gap:6px;flex-wrap:wrap">' +
          DS.dot(STATUS_LABEL[p.status] || '进行中', STATUS_TYPE[p.status] || '') +
          DS.chip('客户：' + (p.client || '未填'), 'muted', true) +
          (isOverdue(p) ? DS.chip('已逾期', 'err', true) : '') +
        '</div>' +
        (tags ? '<div class="detail-tags">' + tags + '</div>' : '') +
        '<div class="tiny muted" style="margin-top:8px">更新于 ' + DS.esc(DS.fmtTime(p.updated_at)) + '</div>' +
      '</div>' +

      /* ---- KPI + 进度 ---- */
      '<div id="prd-kpi">' + kpiHtml(p, pct, ts, dlText) + '</div>' +

      /* ---- 操作 ---- */
      '<div class="btn-row" style="margin-bottom:12px">' +
        '<button class="btn btn-sm btn-outline"' + DS.act('pr:openEdit', { id: p.id }) + '>✏️ 编辑信息</button>' +
        '<button class="btn btn-sm btn-outline"' + DS.act('pr:taskNew', { id: p.id }) + '>＋ 添加任务</button>' +
        '<button class="btn btn-sm btn-outline"' + DS.act('pr:codeNew', { id: p.id }) + '>＋ 新增代码块</button>' +
        '<button class="btn btn-sm btn-danger-o"' + DS.act('pr:del', { id: p.id }) + '>🗑️ 删除项目</button>' +
      '</div>' +

      /* ---- 动态 ---- */
      '<div class="section-h">最新动态</div>' +
      '<div id="prd-timeline">' + timelineHtml(p) + '</div>' +

      /* ---- 任务 ---- */
      '<div class="section-h">任务清单</div>' +
      '<div id="prd-tasks">' + tasksHtml(p) + '</div>' +

      /* ---- 笔记 ---- */
      '<div class="section-h">项目笔记</div>' +
      '<div id="prd-notes">' +
        DS.textarea({ name: 'notes', value: p.notes, rows: 6, placeholder: '需求分析、会议结论、风险记录、交付说明…' }) +
        '<button class="btn btn-primary btn-block"' + DS.act('pr:notesSave', { id: p.id }) + '>💾 保存笔记</button>' +
      '</div>' +

      /* ---- 代码片段 ---- */
      '<div class="section-h">代码片段</div>' +
      '<div id="prd-code">' + codeHtml(p) + '</div>' +
      '<div style="height:16px"></div>';
  }

  function kpiHtml(p, pct, ts, dlText) {
    return DS.statGrid([
      { icon: '🧩', label: '技术栈', value: p.tech || '未填写' },
      { icon: '📅', label: '截止日期', value: dlText, sub: isOverdue(p) ? '逾期' : '', subType: isOverdue(p) ? 'err' : '' },
      { icon: '💰', label: '项目金额', value: DS.fmtMoney(p.amount) },
      { icon: '💵', label: '已回款', value: DS.fmtMoney(p.paid) },
      { icon: '⏳', label: '待回款', value: DS.fmtMoney(prRemain(p)) },
      { icon: '📈', label: '完成率', value: pct + '%' }
    ]) +
    '<div class="card">' + DS.bar(pct) +
      '<div class="tiny muted" style="margin-top:8px">完成率按任务权重计算：已完成 ' + ts.done + ' / ' + ts.total + ' 项' +
      (p.paid >= numOr(p.amount, 0) && numOr(p.amount, 0) > 0 ? ' · 款项已结清' : '') + '</div>' +
    '</div>';
  }

  function timelineHtml(p) {
    var h = p.history || [];
    if (!h.length) return '<div class="muted tiny" style="padding:4px 0 8px">暂无动态</div>';
    return '<ul class="list" style="margin-bottom:4px">' + h.map(function (it) {
      return '<li class="li" style="cursor:default;align-items:flex-start">' +
        '<div class="li-ic">🕒</div>' +
        '<div class="li-body">' +
          '<div style="font-size:13.5px;line-height:1.5;white-space:normal;word-break:break-word">' + DS.esc(it.text) + '</div>' +
          '<div class="li-sub">' + DS.esc(DS.fmtTime(it.time)) + '</div>' +
        '</div></li>';
    }).join('') + '</ul>';
  }

  function tasksHtml(p) {
    var list = p.tasks || [];
    var ts = taskStat(p);
    var head = '<div class="tiny muted" style="margin:0 0 8px">已完成 ' + ts.done + ' / ' + ts.total +
      ' 项 · 按权重完成率 ' + prProgress(p) + '%</div>';
    if (!list.length) {
      return head + '<div class="muted tiny" style="padding:0 0 8px">还没有任务，点上面「＋ 添加任务」。</div>';
    }
    return head + list.map(function (t) {
      return '<div style="display:flex;align-items:flex-start;gap:10px;padding:11px 0;border-bottom:1px solid var(--border)">' +
        '<button class="btn btn-xs' + (t.done ? ' btn-success' : '') + '"' +
          DS.act('pr:taskToggle', { id: p.id, tid: t.id }) + '>' + (t.done ? '✓' : '○') + '</button>' +
        '<div style="flex:1;min-width:0">' +
          '<div style="font-size:14px;font-weight:600;line-height:1.45;word-break:break-word' +
            (t.done ? ';text-decoration:line-through;color:var(--muted)' : '') + '">' + DS.esc(t.name || '未命名任务') + '</div>' +
          '<div class="tiny muted" style="margin-top:2px">负责人：' + DS.esc(t.owner || '-') +
            ' · 权重：' + DS.esc(String(numOr(t.weight, 1))) + '</div>' +
        '</div>' +
        '<button class="btn btn-xs btn-danger-o"' + DS.act('pr:taskDel', { id: p.id, tid: t.id }) + '>删</button>' +
      '</div>';
    }).join('');
  }

  function codeHtml(p) {
    var list = p.code || [];
    if (!list.length) {
      return '<div class="muted tiny" style="padding:4px 0 8px">还没有代码块，点上面「＋ 新增代码块」。</div>';
    }
    return list.map(function (c) {
      return '<div class="card">' +
        '<div style="display:flex;align-items:center;justify-content:space-between;gap:8px">' +
          '<div style="font-size:14px;font-weight:700;word-break:break-word">' + DS.esc(c.title || '未命名片段') + '</div>' +
          DS.chip(c.lang || 'text', 'muted', true) +
        '</div>' +
        '<pre class="code-block" style="margin:9px 0 0">' + DS.esc(c.body) + '</pre>' +
        '<div class="btn-row" style="margin-top:9px">' +
          '<button class="btn btn-xs btn-outline"' + DS.act('pr:codeEdit', { id: p.id, cid: c.id }) + '>编辑</button>' +
          '<button class="btn btn-xs btn-outline"' + DS.act('pr:codeCopy', { id: p.id, cid: c.id }) + '>复制</button>' +
          '<button class="btn btn-xs btn-danger-o"' + DS.act('pr:codeDel', { id: p.id, cid: c.id }) + '>删除</button>' +
        '</div>' +
      '</div>';
    }).join('');
  }

  /** 局部刷新：只换需要变的那几块，保留页面滚动位置 */
  function patchKpi(p) {
    if (!detail.body) return;
    var box = DS.$('#prd-kpi', detail.body);
    if (box) box.innerHTML = kpiHtml(p, prProgress(p), taskStat(p), detailDeadlineText(p));
  }

  function detailDeadlineText(p) {
    var dl = p.deadline ? DS.daysLeft(p.deadline) : null;
    if (!p.deadline) return '未设置';
    if (p.status === 'done') return DS.fmtDate(p.deadline) + (dl !== null && dl < 0 ? '（逾期交付）' : '（已完成）');
    if (dl === null) return DS.fmtDate(p.deadline);
    if (dl < 0) return DS.fmtDate(p.deadline) + '（逾期 ' + Math.abs(dl) + ' 天）';
    return DS.fmtDate(p.deadline) + '（剩 ' + dl + ' 天）';
  }

  function patchTimeline(p) {
    if (!detail.body) return;
    var box = DS.$('#prd-timeline', detail.body);
    if (box) box.innerHTML = timelineHtml(p);
  }

  function patchTasks(p) {
    if (!detail.body) return;
    var box = DS.$('#prd-tasks', detail.body);
    if (box) box.innerHTML = tasksHtml(p);
  }

  function patchCode(p) {
    if (!detail.body) return;
    var box = DS.$('#prd-code', detail.body);
    if (box) box.innerHTML = codeHtml(p);
  }

  /** 整个详情重新渲染（编辑信息后用） */
  function rerenderDetail(p) {
    if (!detail.body) return;
    if (!DS.$('#prd-kpi', detail.body)) return;   // 已经离开详情页了，别乱写
    detail.body.innerHTML = detailHtml(p);
    detail.body.scrollTop = 0;
  }

  /** 取到项目再操作（避免用到过期对象） */
  function withProject(id, fn) {
    return Store.get(id).then(function (p) {
      if (!p) { DS.toast('项目不存在，可能已被删除', 'err'); return null; }
      return fn(p);
    });
  }

  /* ======================================================================
     10. 表单弹层：新建 / 编辑信息 / 任务 / 代码片段
     ====================================================================== */
  var STATUS_OPTIONS = [
    { value: 'active', label: '进行中' },
    { value: 'paused', label: '暂停' },
    { value: 'done', label: '已交付' }
  ];

  function openNew() {
    DS.sheet({
      title: '新建项目',
      html: '<div id="pr-form">' +
        DS.input({ name: 'name', label: '项目名称', required: true, placeholder: '例如：散线转文字插件' }) +
        DS.input({ name: 'client', label: '客户', placeholder: '私人项目 / 某某公司' }) +
        DS.input({ name: 'tech', label: '技术栈', placeholder: 'CAD / C# / Node.js' }) +
        DS.input({ name: 'tags', label: '标签（逗号分隔）', placeholder: 'CAD, Web, 研发' }) +
        DS.number({ name: 'amount', label: '金额', value: 0, min: 0, step: '0.01' }) +
        DS.number({ name: 'paid', label: '已回款', value: 0, min: 0, step: '0.01' }) +
        DS.select({ name: 'status', label: '状态', value: 'active', options: STATUS_OPTIONS }) +
        DS.input({ name: 'deadline', label: '截止日期', inputType: 'date' }) +
        DS.textarea({ name: 'notes', label: '项目笔记（可稍后补）', rows: 3 }) +
        '</div>',
      buttons: [
        { text: '取消', cls: 'btn-outline' },
        {
          text: '创建', cls: 'btn-primary', onClick: function (close) {
            var root = DS.$('#pr-form');
            var v = DS.validate(root, [
              { name: 'name', label: '项目名称', required: true },
              { name: 'amount', label: '金额', type: 'number', min: 0 },
              { name: 'paid', label: '已回款', type: 'number', min: 0 }
            ]);
            if (!v.ok) { DS.toast(v.msg, 'err'); return false; }
            var d = v.data;
            var p = normalize({
              name: String(d.name || '').trim(),
              client: String(d.client || '').trim(),
              tech: String(d.tech || '').trim(),
              tags: parseTags(d.tags),
              status: d.status,
              amount: numOr(d.amount, 0),
              paid: numOr(d.paid, 0),
              deadline: String(d.deadline || '').slice(0, 10),
              notes: d.notes || '',
              tasks: [{ id: DS.uid(), name: '确认需求与交付范围', owner: '我', weight: 1, done: false }],
              code: [],
              history: []
            });
            addHistory(p, '创建项目');
            Store.upsert(p, { okMsg: '项目已创建' }).then(function (r) {
              close();
              // 关掉弹层后再切页（不新开弹层，不会有 popstate 冲突）
              if (r && r.data) openDetail(r.data.id);
              else DS.refresh();
            });
            return false;
          }
        }
      ]
    });
  }

  function openEditInfo(id) {
    withProject(id, function (p) {
      DS.sheet({
        title: '编辑项目信息',
        html: '<div id="pr-form">' +
          DS.input({ name: 'name', label: '项目名称', required: true, value: p.name }) +
          DS.input({ name: 'client', label: '客户', value: p.client }) +
          DS.input({ name: 'tech', label: '技术栈', value: p.tech }) +
          DS.input({ name: 'tags', label: '标签（逗号分隔）', value: (p.tags || []).join(', '), placeholder: 'CAD, Web, 研发' }) +
          DS.number({ name: 'amount', label: '金额', value: p.amount, min: 0, step: '0.01' }) +
          DS.number({ name: 'paid', label: '已回款', value: p.paid, min: 0, step: '0.01' }) +
          DS.select({ name: 'status', label: '状态', value: p.status, options: STATUS_OPTIONS }) +
          DS.input({ name: 'deadline', label: '截止日期', inputType: 'date', value: p.deadline }) +
          DS.textarea({ name: 'notes', label: '项目笔记', rows: 4, value: p.notes }) +
          '</div>',
        buttons: [
          { text: '取消', cls: 'btn-outline' },
          {
            text: '保存', cls: 'btn-primary', onClick: function (close) {
              var root = DS.$('#pr-form');
              var v = DS.validate(root, [
                { name: 'name', label: '项目名称', required: true },
                { name: 'amount', label: '金额', type: 'number', min: 0 },
                { name: 'paid', label: '已回款', type: 'number', min: 0 }
              ]);
              if (!v.ok) { DS.toast(v.msg, 'err'); return false; }
              var d = v.data;
              withProject(id, function (cur) {
                var oldName = cur.name;
                cur.name = String(d.name || '').trim();
                cur.client = String(d.client || '').trim();
                cur.tech = String(d.tech || '').trim();
                cur.tags = parseTags(d.tags);
                cur.amount = numOr(d.amount, 0);
                cur.paid = numOr(d.paid, 0);
                cur.status = statusOf(d.status);
                cur.deadline = String(d.deadline || '').slice(0, 10);
                cur.notes = d.notes === null || d.notes === undefined ? '' : String(d.notes);
                addHistory(cur, oldName !== cur.name ? '更新项目信息，名称改为：' + cur.name : '更新项目信息');
                return Store.upsert(cur, { okMsg: '项目信息已保存' }).then(function (r) {
                  close();
                  var fresh = (r && r.data) ? r.data : cur;
                  if (detail.id) rerenderDetail(fresh);
                  else DS.refresh();
                });
              });
              return false;
            }
          }
        ]
      });
    });
  }

  function openTaskNew(id) {
    withProject(id, function (p) {
      DS.sheet({
        title: '添加任务',
        html: '<div id="pr-form">' +
          DS.input({ name: 'name', label: '任务名称', required: true, placeholder: '例如：导出 PDF 功能' }) +
          DS.input({ name: 'owner', label: '负责人', value: '我' }) +
          DS.number({ name: 'weight', label: '权重', value: 1, min: 1, max: 99, step: '1', help: '权重越大，完成它对进度条的影响越大。' }) +
          '</div>',
        buttons: [
          { text: '取消', cls: 'btn-outline' },
          {
            text: '添加', cls: 'btn-primary', onClick: function (close) {
              var root = DS.$('#pr-form');
              var v = DS.validate(root, [{ name: 'name', label: '任务名称', required: true }]);
              if (!v.ok) { DS.toast(v.msg, 'err'); return false; }
              var d = v.data;
              withProject(id, function (cur) {
                cur.tasks = cur.tasks || [];
                cur.tasks.push({
                  id: DS.uid(),
                  name: String(d.name || '').trim(),
                  owner: String(d.owner || '').trim() || '我',
                  weight: numOr(d.weight, 1) || 1,
                  done: false
                });
                addHistory(cur, '新增任务：' + String(d.name || '').trim());
                return Store.upsert(cur, { okMsg: '任务已添加' }).then(function (r) {
                  close();
                  var fresh = (r && r.data) ? r.data : cur;
                  patchTasks(fresh);
                  patchKpi(fresh);
                  patchTimeline(fresh);
                });
              });
              return false;
            }
          }
        ]
      });
    });
  }

  function openCodeEdit(id, cid) {
    withProject(id, function (p) {
      var idx = cid ? indexOfCode(p, cid) : -1;
      var c = idx >= 0 ? p.code[idx] : { title: '', lang: '', body: '' };
      DS.sheet({
        title: idx >= 0 ? '编辑代码块' : '新增代码块',
        html: '<div id="pr-form">' +
          DS.input({ name: 'title', label: '标题', required: true, value: c.title, placeholder: '例如：批量导出核心逻辑' }) +
          DS.input({ name: 'lang', label: '语言', value: c.lang, placeholder: 'js / python / sql / csharp …' }) +
          DS.textarea({ name: 'body', label: '代码内容', rows: 10, value: c.body, placeholder: '粘贴代码…' }) +
          '</div>',
        buttons: [
          { text: '取消', cls: 'btn-outline' },
          {
            text: '保存', cls: 'btn-primary', onClick: function (close) {
              var root = DS.$('#pr-form');
              var v = DS.validate(root, [{ name: 'title', label: '标题', required: true }]);
              if (!v.ok) { DS.toast(v.msg, 'err'); return false; }
              var d = v.data;
              if (!String(d.body || '').trim()) { DS.toast('代码内容不能为空', 'err'); return false; }
              withProject(id, function (cur) {
                cur.code = cur.code || [];
                var k = cid ? indexOfCode(cur, cid) : -1;
                var item = {
                  id: k >= 0 ? cur.code[k].id : DS.uid(),
                  title: String(d.title || '').trim(),
                  lang: String(d.lang || '').trim(),
                  body: String(d.body || '')
                };
                if (k >= 0) {
                  cur.code[k] = item;
                  addHistory(cur, '编辑代码块：' + item.title);
                } else {
                  cur.code.push(item);
                  addHistory(cur, '新增代码块：' + item.title);
                }
                return Store.upsert(cur, { okMsg: '代码块已保存' }).then(function (r) {
                  close();
                  var fresh = (r && r.data) ? r.data : cur;
                  patchCode(fresh);
                  patchTimeline(fresh);
                });
              });
              return false;
            }
          }
        ]
      });
    });
  }

  /* ======================================================================
     11. 事件注册（全部走 DS.on + DS.act，不用 onclick 字符串）
     ====================================================================== */
  DS.on('pr:open', function (payload) {
    if (payload && payload.id) openDetail(payload.id);
  });

  DS.on('pr:back', function () { DS.goPage('list'); });

  DS.on('pr:new', function () { openNew(); });

  DS.on('pr:filter', function (v) {
    var st = DS.pager(LIST_KEY, PAGE_SIZE);
    st.filter = v || 'all';
    st.page = 0;
    DS.savePagerState(LIST_KEY);
    drawList();
  });

  DS.onSearch(LIST_KEY, function (kw) {
    var st = DS.pager(LIST_KEY, PAGE_SIZE);
    st.search = String(kw || '').trim();
    st.page = 0;
    DS.savePagerState(LIST_KEY);
    drawList();
  });

  DS.onPager(LIST_KEY, function () {
    if (listEl && document.body.contains(listEl)) drawList();
    else DS.refresh();
  });

  DS.on('pr:openEdit', function (payload) {
    if (payload && payload.id) openEditInfo(payload.id);
  });

  DS.on('pr:taskNew', function (payload) {
    if (payload && payload.id) openTaskNew(payload.id);
  });

  DS.on('pr:taskToggle', function (payload) {
    if (!payload || !payload.id) return;
    withProject(payload.id, function (p) {
      var i = indexOfTask(p, payload.tid);
      if (i < 0) { DS.toast('任务不存在', 'err'); return; }
      p.tasks[i].done = !p.tasks[i].done;
      addHistory(p, (p.tasks[i].done ? '完成任务：' : '重新打开任务：') + p.tasks[i].name);
      return Store.upsert(p).then(function (r) {
        var fresh = (r && r.data) ? r.data : p;
        patchTasks(fresh);
        patchKpi(fresh);
        patchTimeline(fresh);
      });
    });
  });

  DS.on('pr:taskDel', function (payload) {
    if (!payload || !payload.id) return;
    DS.confirm({ title: '删除任务', msg: '确定删除这个任务吗？', okText: '删除', danger: true }).then(function (ok) {
      if (!ok) return;
      withProject(payload.id, function (p) {
        var i = indexOfTask(p, payload.tid);
        if (i < 0) return;
        var name = p.tasks[i].name;
        p.tasks.splice(i, 1);
        addHistory(p, '删除任务：' + name);
        return Store.upsert(p, { okMsg: '任务已删除' }).then(function (r) {
          var fresh = (r && r.data) ? r.data : p;
          patchTasks(fresh);
          patchKpi(fresh);
          patchTimeline(fresh);
        });
      });
    });
  });

  DS.on('pr:notesSave', function (payload) {
    if (!payload || !payload.id) return;
    if (!detail.body) return;
    var root = DS.$('#prd-notes', detail.body);
    var d = root ? DS.formData(root) : null;
    if (!d) { DS.toast('找不到笔记输入框', 'err'); return; }
    withProject(payload.id, function (p) {
      var text = d.notes === null || d.notes === undefined ? '' : String(d.notes);
      if (text === (p.notes || '')) { DS.toast('笔记没有变化', 'info'); return; }
      p.notes = text;
      addHistory(p, '更新了项目笔记');
      return Store.upsert(p, { okMsg: '笔记已保存' }).then(function (r) {
        var fresh = (r && r.data) ? r.data : p;
        patchTimeline(fresh);
      });
    });
  });

  DS.on('pr:codeNew', function (payload) {
    if (payload && payload.id) openCodeEdit(payload.id, null);
  });

  DS.on('pr:codeEdit', function (payload) {
    if (payload && payload.id) openCodeEdit(payload.id, payload.cid);
  });

  DS.on('pr:codeCopy', function (payload) {
    if (!payload || !payload.id) return;
    withProject(payload.id, function (p) {
      var i = indexOfCode(p, payload.cid);
      if (i < 0) { DS.toast('代码块不存在', 'err'); return; }
      DS.copy(p.code[i].body || '');
    });
  });

  DS.on('pr:codeDel', function (payload) {
    if (!payload || !payload.id) return;
    DS.confirm({ title: '删除代码块', msg: '确定删除这个代码块吗？', okText: '删除', danger: true }).then(function (ok) {
      if (!ok) return;
      withProject(payload.id, function (p) {
        var i = indexOfCode(p, payload.cid);
        if (i < 0) return;
        var title = p.code[i].title;
        p.code.splice(i, 1);
        addHistory(p, '删除代码块：' + title);
        return Store.upsert(p, { okMsg: '代码块已删除' }).then(function (r) {
          var fresh = (r && r.data) ? r.data : p;
          patchCode(fresh);
          patchTimeline(fresh);
        });
      });
    });
  });

  DS.on('pr:del', function (payload) {
    if (!payload || !payload.id) return;
    withProject(payload.id, function (p) {
      DS.confirm({
        title: '删除项目',
        html: '确定删除项目 <b>' + DS.esc(p.name || '未命名项目') + '</b> 吗？<br>该项目的任务、笔记、代码片段都会一起删除，且不可恢复。',
        okText: '删除',
        danger: true
      }).then(function (ok) {
        if (!ok) return;
        return Store.remove(p.id, { okMsg: '项目已删除' }).then(function () {
          lastId = null;
          if (detail.id === p.id) detail = { id: null, body: null };
          DS.goPage('list');
        });
      });
    });
  });

  /* ---------------- 导出 / 导入 ---------------- */

  DS.on('pr:export', function () {
    Store.list().then(function (res) {
      var arr = res.data || [];
      if (!arr.length) { DS.toast('没有可导出的项目', 'warn'); return; }
      var fname = 'projects-' + DS.fmtDate(new Date()).replace(/-/g, '') + '.json';
      DS.download(fname, JSON.stringify(arr, null, 2));
    });
  });

  /** 解析导入内容 -> 项目数组，失败返回 null */
  function parseImport(text) {
    var t = String(text === null || text === undefined ? '' : text).replace(/^\uFEFF/, '').trim();
    if (!t) return null;
    var data = null;
    try { data = JSON.parse(t); } catch (e) { return null; }
    if (typeof data === 'string') {
      // 有些导出会被二次编码成字符串
      try { data = JSON.parse(data); } catch (e2) { return null; }
    }
    if (DS.isArr(data)) return data;
    if (DS.isObj(data)) {
      if (DS.isArr(data.projects)) return data.projects;
      if (DS.isArr(data.data)) return data.data;
      if (DS.isArr(data.items)) return data.items;
      if (data.name !== undefined) return [data];
    }
    return null;
  }

  function confirmImport(arr, srcName) {
    var preview = arr.slice(0, 6).map(function (x) {
      return '· ' + DS.esc(x && x.name ? x.name : '（未命名）');
    }).join('<br>');
    if (arr.length > 6) preview += '<br>… 还有 ' + (arr.length - 6) + ' 个';
    DS.confirm({
      title: '导入 ' + arr.length + ' 个项目',
      html: '来源：' + DS.esc(srcName || '粘贴的 JSON') + '<br>' +
        '写入位置：' + (Store.mode === 'cloud' ? '云端 Supabase' : '本机（这台手机）') + '<br>' +
        '同 id 的项目会被覆盖，其余追加，不会删除现有数据。<br><br>' + preview,
      okText: '开始导入'
    }).then(function (ok) {
      if (!ok) return;
      DS.toast('正在导入 ' + arr.length + ' 个项目…', 'info');
      Store.mergeAll(arr).then(function (r) {
        if (r.fail && r.fail.length) {
          DS.toast('导入完成：成功 ' + r.ok + ' 个，失败 ' + r.fail.length + ' 个', 'warn');
        } else {
          DS.toast('已导入 ' + r.ok + ' 个项目', 'ok');
        }
        DS.refresh();
      });
    });
  }

  DS.on('pr:import', function () {
    DS.pickFile('.json,application/json,text/plain').then(function (f) {
      if (!f) return;
      var arr = parseImport(f.text);
      if (!arr) { DS.toast('JSON 解析失败，请确认文件内容正确', 'err'); return; }
      if (!arr.length) { DS.toast('文件里没有项目数据', 'err'); return; }
      confirmImport(arr, f.name);
    });
  });

  DS.on('pr:importPaste', function () {
    DS.prompt({
      title: '粘贴 JSON 导入',
      msg: '把桌面版导出的 JSON，或 localStorage 里 liuxiao.projects.v1 的整段内容粘贴进来',
      placeholder: '[{"name":"项目名", ...}]',
      okText: '解析'
    }).then(function (text) {
      if (!text) return;
      var arr = parseImport(text);
      if (!arr) { DS.toast('JSON 解析失败，请检查是否粘贴完整', 'err'); return; }
      if (!arr.length) { DS.toast('没有解析到项目数据', 'err'); return; }
      confirmImport(arr, '粘贴的 JSON');
    });
  });

  /* ---------------- 云端 / 本机数据管理 ---------------- */

  DS.on('pr:cloudRetry', function () {
    if (!DS.conn(CONN).configured) {
      DS.toast('还没配置 prj 连接，请先填 API Key', 'err');
      DS.connSheet(CONN, function () { DS.refresh(); });
      return;
    }
    DS.toast('正在重试云端连接…', 'info');
    Store.resetCloud();
    Store.list().then(function () {
      if (Store.mode === 'cloud') DS.toast('已连接云端 Supabase', 'ok');
      else DS.toast('云端仍不可用：' + Store.reason, 'err');
      DS.refresh();
    });
  });

  DS.on('pr:pushLocal', function () {
    var local = localRaw();
    if (!local.length) { DS.toast('本机没有可同步的数据', 'warn'); return; }
    if (!DS.conn(CONN).configured) {
      DS.toast('请先配置「项目后台」的 Supabase 连接', 'err');
      DS.connSheet(CONN, function () { DS.refresh(); });
      return;
    }
    DS.confirm({
      title: '同步到云端',
      msg: '把本机这 ' + local.length + ' 个项目写入云端 projects 表（同 id 覆盖，其余新增）。云端已有的其它项目不受影响。',
      okText: '开始同步'
    }).then(function (ok) {
      if (!ok) return;
      DS.toast('正在同步…', 'info');
      Store.resetCloud();
      Store.mergeAll(local).then(function (r) {
        if (r.mode === 'local') DS.toast('云端仍不可用，数据没有上传', 'err');
        else DS.toast('已同步 ' + r.ok + ' 个项目到云端', 'ok');
        DS.refresh();
      });
    });
  });

  DS.on('pr:clearLocal', function () {
    DS.confirm({
      title: '清空本机数据',
      msg: '只删除这台手机浏览器里保存的项目离线副本（' + LOCAL_KEY + '），云端 Supabase 的数据不受影响。',
      okText: '清空',
      danger: true
    }).then(function (ok) {
      if (!ok) return;
      DS.lsDel(LOCAL_KEY);
      if (Store.mode === 'local') Store.cache = [];
      DS.toast('已清空本机数据', 'ok');
      DS.refresh();
    });
  });

  /* ======================================================================
     12. 注册模块
     ====================================================================== */
  DS.registerModule({
    id: 'pr',
    name: '项目后台',
    tabName: '项目',
    icon: '📋',
    subtitle: '项目 · 任务 · 笔记 · 代码片段',
    // 不声明 conns：模块内部 Store 已经实现了「没配 key / 表没建 / 无权限」时
    // 自动降级为 localStorage 本机模式，并在页面顶部用 DS.banner 说明。
    // 如果写成 conns:['prj']，框架会在连接未配置时直接拦截渲染，
    // 用户就没法在纯本机模式下先把电脑上的老项目导入进来。
    conns: [],
    pages: [
      { id: 'list', title: '项目' },
      { id: 'detail', title: '详情' },
      { id: 'stats', title: '统计' },
      { id: 'more', title: '更多' }
    ],
    render: function (pageId, el) {
      if (pageId === 'detail') return renderDetailPage(el);
      if (pageId === 'stats') return renderStats(el);
      if (pageId === 'more') return renderMore(el);
      return renderList(el);
    }
  });
})();
