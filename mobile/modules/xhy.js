/* ==========================================================================
   模块：xhy —— XHY Toolbox 授权管理（手机优先）
   --------------------------------------------------------------------------
   用途：把桌面版后台的「XHY Toolbox 授权管理」搬到手机端 PWA，
         管理软件授权码、注册设备（机器码）、激活日志与客户端版本。

   连接名：'xhy'
     项目：https://ofdouqimwsplrhjcfdbv.supabase.co
     密钥（anon / service_role）由用户在框架「设置 → 数据源连接」里填写，
     本文件不含任何 key，全部通过 DS.api('xhy', 表名, opts) 访问。

   用到的表与字段（字段名以桌面版源码 admin.html 的实际调用为准）：

     machine_codes   设备 / 机器码表
       id, machine_code, device_name, user_name, ip_address,
       is_active, activation_count, created_at, last_seen

     licenses        授权表
       id, license_key, machine_code_id, expiry_date, is_active,
       is_revoked, revoked_at, revoke_reason, created_at
       关联：licenses.machine_code_id -> machine_codes.id

     activations     激活日志表
       id, license_id, license_key, machine_code_id, activation_time,
       is_success, failure_reason, ip_address
       关联：activations.machine_code_id -> machine_codes.id

     app_versions    客户端版本表
       id, version_number, release_date, description, is_latest

   页面：dashboard 仪表盘 / licenses 授权 / devices 设备 /
         activations 激活日志 / versions 版本

   ⚠ 更新策略（重要）：
     app.js 早期版本的 PATCH 不带过滤条件，直接 PATCH 会更新整张表；
     框架现已修复，并为无过滤条件的 PATCH/DELETE 加了拦截护栏。本模块所有「按主键
     更新」都走 PostgREST 的 upsert：
         POST /rest/v1/<表>?on_conflict=id
         Prefer: return=representation,resolution=merge-duplicates
     即先读取整行 → 合并改动 → upsertRow()。见 updateRow / upsertRow / doUpsert。
     DELETE 带 filters 是安全的，删除类操作正常使用。
   ========================================================================== */
(function () {
  'use strict';

  var DS = window.DS;

  /* 连接名（与 registerModule 的 conns 一致） */
  var CONN = 'xhy';

  /* 分页 / 搜索状态 key，统一 xhy. 前缀 */
  var K_LIC = 'xhy.licenses';
  var K_DEV = 'xhy.devices';
  var K_ACT = 'xhy.activations';
  var K_VER = 'xhy.versions';

  var PAGE_SIZE = 15;

  /* 授权 / 设备 / 版本 的筛选芯片 */
  var F_LIC = [
    { v: 'all', l: '全部' },
    { v: 'active', l: '有效' },
    { v: 'revoked', l: '已撤销' },
    { v: 'expired', l: '已过期' }
  ];
  var F_DEV = [
    { v: 'all', l: '全部' },
    { v: 'active', l: '活跃' },
    { v: 'inactive', l: '已停用' }
  ];
  var F_VER = [
    { v: 'all', l: '全部' },
    { v: 'latest', l: '最新版' },
    { v: 'history', l: '历史版' }
  ];

  /* ======================================================================
     1. 小工具
     ====================================================================== */

  /** 本地时区的 YYYY-MM-DD（date 字段不能用带时间的 ISO 串过滤） */
  function todayStr(offsetDays) {
    return DS.fmtDate(new Date(Date.now() + (offsetDays || 0) * 86400000));
  }

  /** 随机字符串（生成授权码用，与桌面版 randomKey 等价） */
  function randomStr(len) {
    var chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    var out = '';
    for (var i = 0; i < len; i++) out += chars.charAt(Math.floor(Math.random() * chars.length));
    return out;
  }

  /** 搜索词清洗：去掉会破坏 PostgREST or=(...) 语法的字符 */
  function cleanKw(kw) {
    return String(kw === undefined || kw === null ? '' : kw).replace(/[(),]/g, ' ').trim();
  }

  /** 拼 or=(col.ilike.*kw*,...) */
  function ilikeOr(cols, kw) {
    return cols.map(function (c) { return c + '.ilike.*' + kw + '*'; }).join(',');
  }

  function onlineOf(d) {
    if (!d || !d.last_seen) return false;
    var t = DS.toDate(d.last_seen);
    if (!t) return false;
    return (Date.now() - t.getTime()) < 7 * 86400000;
  }

  /** 授权状态（徽标文案 + 颜色类型） */
  function licStatus(l) {
    if (l.is_revoked) return { label: '已撤销', type: 'err' };
    if (!l.is_active) return { label: '已停用', type: 'muted' };
    var d = DS.daysLeft(l.expiry_date);
    if (d === null) return { label: '无到期日', type: 'muted' };
    if (d < 0) return { label: '已过期 ' + Math.abs(d) + ' 天', type: 'muted' };
    if (d === 0) return { label: '今天到期', type: 'warn' };
    if (d <= 30) return { label: '剩 ' + d + ' 天', type: 'warn' };
    return { label: '有效', type: 'ok' };
  }

  /* ======================================================================
     2. 数据访问层（全部走 DS.api('xhy', …)）
     ====================================================================== */

  /** GET 并把 res.error 转成 reject */
  function getRows(table, opts) {
    return DS.api(CONN, table, opts).then(function (res) {
      if (res.error) throw new Error(res.error.message);
      return res;
    });
  }

  /** POST 单行，返回插入/更新后的行对象 */
  function postRow(table, data) {
    return DS.api(CONN, table, { method: 'POST', data: data }).then(function (res) {
      if (res.error) throw new Error(res.error.message);
      return (res.data || [])[0] || null;
    });
  }

  /** DELETE（filters 在 DELETE 上是生效的） */
  function deleteRows(table, opts) {
    var o = opts || {};
    o.method = 'DELETE';
    return DS.api(CONN, table, o).then(function (res) {
      if (res.error) throw new Error(res.error.message);
      return true;
    });
  }

  /** 只取总数（配 select:'id' + countOnly） */
  function countRows(table, opts) {
    var o = opts || {};
    o.select = 'id';
    o.countOnly = true;
    return DS.api(CONN, table, o).then(function (res) {
      if (res.error) return { n: 0, err: res.error.message };
      return { n: res.count || 0, err: null };
    }, function (e) {
      return { n: 0, err: (e && e.message) || '网络错误' };
    });
  }

  /** 单行 upsert（merge-duplicates），返回 {ok, row|msg} */
  function doUpsert(table, body) {
    return DS.api(CONN, table, {
      method: 'POST',
      upsert: true,
      onConflict: 'id',
      data: body
    }).then(function (res) {
      if (res.error) return { ok: false, msg: res.error.message };
      return { ok: true, row: (res.data || [])[0] || null };
    }, function (e) {
      return { ok: false, msg: (e && e.message) || '网络错误' };
    });
  }

  /**
   * 按主键更新一行。
   * 先试「只带改动字段」的 upsert（字段最少、最干净）；若因 NOT NULL /
   * 默认值等约束失败，再退回「整行覆盖」的 upsert（fullRow 来自本次读取）。
   * 读取整行同时起到了「记录是否还存在」的校验作用，避免 upsert 凭空插入脏行。
   */
  function upsertRow(table, id, patch, fullRow) {
    var body = { id: id };
    Object.keys(patch).forEach(function (k) { body[k] = patch[k]; });
    return doUpsert(table, body).then(function (out) {
      if (out.ok) return out.row;
      if (!fullRow) throw new Error(out.msg);
      var full = {};
      Object.keys(fullRow).forEach(function (k) { full[k] = fullRow[k]; });
      Object.keys(patch).forEach(function (k) { full[k] = patch[k]; });
      return doUpsert(table, full).then(function (out2) {
        if (out2.ok) return out2.row;
        throw new Error(out.msg);
      });
    });
  }

  /** 读整行 + 合并改动 + upsert */
  function updateRow(table, id, patch) {
    return getRows(table, { select: '*', filters: { id: id }, limit: 1 }).then(function (res) {
      var row = (res.data || [])[0];
      if (!row) throw new Error('记录不存在或已被删除');
      return upsertRow(table, id, patch, row);
    });
  }

  /**
   * 统一写操作包装：fn() 返回 Promise（失败 reject）。
   * 成功 → toast(ok)；失败 → toast(err + 原因)。
   */
  function doWrite(fn, opts) {
    opts = opts || {};
    fn().then(function (out) {
      DS.toast(opts.ok || '操作成功', 'ok');
      if (opts.done) opts.done(out);
    }, function (e) {
      DS.toast((opts.err || '操作失败') + '：' + ((e && e.message) ? e.message : String(e)), 'err');
    });
  }

  /** 写操作完成后的收尾：关掉详情弹层 + 重渲染当前页 */
  function afterWrite() {
    DS.closeSheet();
    DS.refresh();
  }

  /** 通用表单弹层：onOk(data, close, root)；返回 false 时不自动关闭 */
  function formSheet(opts) {
    var root = null;
    return DS.sheet({
      title: opts.title,
      center: !!opts.center,
      html: opts.html,
      buttons: [
        { text: '取消', cls: 'btn-outline' },
        {
          text: opts.okText || '保存',
          cls: opts.danger ? 'btn-danger' : 'btn-primary',
          onClick: function (close) {
            opts.onOk(DS.formData(root || document), close, root);
            return false;
          }
        }
      ],
      onReady: function (body) {
        root = body;
        if (opts.onReady) opts.onReady(body);
      }
    });
  }

  /* ======================================================================
     3. 事件注册（全部用 DS.on / DS.act 委托，禁止 onclick 拼字符串）
     ====================================================================== */

  /* ---- 通用 ---- */
  DS.on('xhy:reload', function () { DS.refresh(); });
  DS.on('xhy:goto', function (p) { if (p) DS.goPage(p); });
  DS.on('xhy:copy', function (p) {
    var t = (p && typeof p === 'object') ? (p.text || '') : p;
    if (!t) { DS.toast('没有可复制的内容', 'warn'); return; }
    DS.copy(t);
  });

  /* ---- 授权 ---- */
  DS.on('xhy:licFilter', function (v) {
    var st = DS.pager(K_LIC);
    st.filter = v || 'all';
    st.page = 0;
    DS.savePagerState(K_LIC);
    DS.refresh();
  });
  DS.on('xhy:licNew', function () { openLicenseNew(); });
  DS.on('xhy:licDetail', function (p) { openLicenseDetail(p && p.id); });
  DS.on('xhy:licExtend', function (p) {
    if (!p || !p.id) return;
    DS.closeSheet();
    openLicenseExtend(p.id, p.exp);
  });
  DS.on('xhy:licRevoke', function (p) {
    if (!p || !p.id) return;
    DS.confirm({
      title: '撤销授权',
      html: '撤销后该授权立刻失效，客户端将无法通过验证（撤销原因记为「管理员手动撤销」）。' +
        (p.k ? '<br>授权码：' + DS.esc(p.k) : ''),
      okText: '确认撤销',
      danger: true
    }).then(function (ok) {
      if (!ok) return;
      doWrite(function () {
        return updateRow('licenses', p.id, {
          is_revoked: true,
          revoked_at: new Date().toISOString(),
          revoke_reason: '管理员手动撤销'
        });
      }, { ok: '授权已撤销', err: '撤销失败', done: afterWrite });
    });
  });
  DS.on('xhy:licRestore', function (p) {
    if (!p || !p.id) return;
    doWrite(function () {
      return updateRow('licenses', p.id, {
        is_revoked: false, revoked_at: null, revoke_reason: null, is_active: true
      });
    }, { ok: '授权已恢复', err: '恢复失败', done: afterWrite });
  });
  DS.on('xhy:licDelete', function (p) {
    if (!p || !p.id) return;
    DS.confirm({
      title: '删除授权',
      html: '删除后授权记录将从数据库永久移除，客户端立即失效，且无法恢复。' +
        (p.k ? '<br>授权码：' + DS.esc(p.k) : ''),
      okText: '删除',
      danger: true
    }).then(function (ok) {
      if (!ok) return;
      doWrite(function () {
        return deleteRows('licenses', { filters: { id: p.id } });
      }, { ok: '授权已删除', err: '删除失败', done: afterWrite });
    });
  });

  /* ---- 设备 ---- */
  DS.on('xhy:devFilter', function (v) {
    var st = DS.pager(K_DEV);
    st.filter = v || 'all';
    st.page = 0;
    DS.savePagerState(K_DEV);
    DS.refresh();
  });
  DS.on('xhy:devDetail', function (p) { openDeviceDetail(p && p.id); });
  DS.on('xhy:devToggle', function (p) {
    if (!p || !p.id) return;
    var to = !!p.active;
    function run() {
      doWrite(function () {
        return updateRow('machine_codes', p.id, { is_active: to });
      }, { ok: to ? '设备已启用' : '设备已停用', err: '操作失败', done: afterWrite });
    }
    if (!to) {
      DS.confirm({
        title: '停用设备',
        msg: '停用后该设备将无法再通过授权验证，已发出的授权也会一起失效。',
        okText: '确认停用',
        danger: true
      }).then(function (ok) { if (ok) run(); });
    } else {
      run();
    }
  });
  DS.on('xhy:devEdit', function (p) {
    if (!p || !p.id) return;
    DS.closeSheet();
    openDeviceEdit(p.id, p.dn, p.un);
  });
  DS.on('xhy:devDelete', function (p) {
    if (!p || !p.id) return;
    DS.confirm({
      title: '删除设备',
      html: '删除后该设备的机器码注册记录将被永久移除，下次使用需重新激活。' +
        (p.dn ? '<br>设备：' + DS.esc(p.dn) : ''),
      okText: '删除',
      danger: true
    }).then(function (ok) {
      if (!ok) return;
      doWrite(function () {
        return deleteRows('machine_codes', { filters: { id: p.id } });
      }, { ok: '设备已删除', err: '删除失败', done: afterWrite });
    });
  });

  /* ---- 激活日志 ---- */
  DS.on('xhy:actDetail', function (p) { openActDetail(p && p.id); });
  DS.on('xhy:actDelete', function (p) {
    if (!p || !p.id) return;
    DS.confirm({
      title: '删除日志',
      msg: '确定删除这条激活日志吗？删除后无法恢复。',
      okText: '删除',
      danger: true
    }).then(function (ok) {
      if (!ok) return;
      doWrite(function () {
        return deleteRows('activations', { filters: { id: p.id } });
      }, { ok: '日志已删除', err: '删除失败', done: afterWrite });
    });
  });
  DS.on('xhy:actClear', function () {
    DS.confirm({
      title: '清空全部激活日志',
      msg: '将清除所有激活日志记录，清空后无法找回任何历史激活数据。确定要清空全部吗？',
      okText: '确认清空',
      danger: true
    }).then(function (ok) {
      if (!ok) return;
      doWrite(function () {
        /* id=not.is.null 等价于「全部行」，DELETE 的 filters 是生效的 */
        return deleteRows('activations', { extraFilters: ['id=not.is.null'] });
      }, {
        ok: '全部激活日志已清空',
        err: '清空失败',
        done: function () {
          var st = DS.pager(K_ACT);
          st.page = 0;
          DS.savePagerState(K_ACT);
          DS.refresh();
        }
      });
    });
  });

  /* ---- 版本 ---- */
  DS.on('xhy:verFilter', function (v) {
    var st = DS.pager(K_VER);
    st.filter = v || 'all';
    st.page = 0;
    DS.savePagerState(K_VER);
    DS.refresh();
  });
  DS.on('xhy:verNew', function () { openVersionNew(); });
  DS.on('xhy:verDetail', function (p) { openVersionDetail(p && p.id); });
  DS.on('xhy:verEdit', function (p) {
    if (!p || !p.id) return;
    DS.closeSheet();
    openVersionEdit(p.id);
  });
  DS.on('xhy:verLatest', function (p) {
    if (!p || !p.id) return;
    DS.closeSheet();
    doWrite(function () {
      return clearLatest().then(function () {
        return updateRow('app_versions', p.id, { is_latest: true });
      });
    }, { ok: '已设为最新版', err: '操作失败', done: function () { DS.refresh(); } });
  });
  DS.on('xhy:verDelete', function (p) {
    if (!p || !p.id) return;
    DS.confirm({
      title: '删除版本',
      html: '删除后版本记录将从数据库永久移除。' +
        (p.isLatest ? '<br>⚠️ 这是当前「最新版本」，删除后就没有最新版标记了。' : '') +
        (p.num ? '<br>即将删除：' + DS.esc(p.num) : ''),
      okText: '删除',
      danger: true
    }).then(function (ok) {
      if (!ok) return;
      doWrite(function () {
        return deleteRows('app_versions', { filters: { id: p.id } });
      }, { ok: '版本已删除', err: '删除失败', done: afterWrite });
    });
  });

  /* ---- 分页 / 搜索（key 与 DS.pager / DS.searchBox / DS.pagerHtml 一致） ---- */
  DS.onSearch(K_LIC, function (kw) {
    var st = DS.pager(K_LIC);
    st.search = String(kw || '').trim();
    st.page = 0;
    DS.savePagerState(K_LIC);
    DS.refresh();
  });
  DS.onPager(K_LIC, function () { DS.refresh(); });

  DS.onSearch(K_DEV, function (kw) {
    var st = DS.pager(K_DEV);
    st.search = String(kw || '').trim();
    st.page = 0;
    DS.savePagerState(K_DEV);
    DS.refresh();
  });
  DS.onPager(K_DEV, function () { DS.refresh(); });

  DS.onSearch(K_ACT, function (kw) {
    var st = DS.pager(K_ACT);
    st.search = String(kw || '').trim();
    st.page = 0;
    DS.savePagerState(K_ACT);
    DS.refresh();
  });
  DS.onPager(K_ACT, function () { DS.refresh(); });

  DS.onSearch(K_VER, function (kw) {
    var st = DS.pager(K_VER);
    st.search = String(kw || '').trim();
    st.page = 0;
    DS.savePagerState(K_VER);
    DS.refresh();
  });
  DS.onPager(K_VER, function () { DS.refresh(); });

  /* ======================================================================
     4. 页面渲染
     ====================================================================== */

  /* ---------- 4.1 仪表盘 ---------- */
  function renderDashboard(pageId, el) {
    el.innerHTML = DS.loading('加载概览…');
    var today = todayStr(0);

    function pick(res) {
      if (res.error) return { data: [], error: null, count: 0 };
      return res;
    }

    Promise.all([
      countRows('machine_codes', {}),
      countRows('machine_codes', { filters: { is_active: true } }),
      countRows('licenses', {}),
      countRows('licenses', {
        extraFilters: ['is_active=eq.true', 'is_revoked=eq.false', 'expiry_date=gt.' + today]
      }),
      countRows('licenses', { filters: { is_revoked: true } }),
      countRows('licenses', { extraFilters: ['expiry_date=lte.' + today] }),
      countRows('app_versions', {}),
      DS.api(CONN, 'app_versions', {
        select: 'id,version_number', filters: { is_latest: true }, limit: 1
      }).then(pick, pick),
      DS.api(CONN, 'activations', {
        select: 'id,activation_time,is_success,ip_address,license_key,machine_codes(device_name,user_name)',
        order: 'activation_time', ascending: false, limit: 10
      }).then(pick, pick),
      DS.api(CONN, 'licenses', {
        select: 'id,license_key,expiry_date',
        extraFilters: ['is_active=eq.true', 'is_revoked=eq.false',
          'expiry_date=gt.' + today, 'expiry_date=lte.' + todayStr(30)],
        order: 'expiry_date', ascending: true, limit: 10
      }).then(pick, pick)
    ]).then(function (r) {
      var devAll = r[0], devOn = r[1];
      var licAll = r[2], licOk = r[3], licRev = r[4], licExp = r[5];
      var verAll = r[6];
      var verLatestList = (r[7].data || []);
      var acts = r[8].data || [];
      var soonList = r[9].data || [];
      var latest = verLatestList.length ? (verLatestList[0].version_number || '-') : '-';

      var errMsg = '';
      [devAll, devOn, licAll, licOk, licRev, licExp, verAll].forEach(function (c) {
        if (!errMsg && c.err) errMsg = c.err;
      });

      var html = '';
      if (errMsg) html += DS.banner('部分统计加载失败：' + DS.esc(errMsg), 'warn');

      html += DS.statGrid([
        DS.stat({
          icon: '💻', label: '设备总数', value: String(devAll.n),
          sub: '活跃 ' + devOn.n, subType: 'ok', color: 'var(--accent)'
        }),
        DS.stat({
          icon: '🔑', label: '有效授权', value: String(licOk.n),
          sub: '共 ' + licAll.n + ' 个', subType: 'ok', color: 'var(--success)'
        }),
        DS.stat({
          icon: '⛔', label: '已撤销', value: String(licRev.n),
          sub: '过期 ' + licExp.n + ' 个', subType: 'err', color: 'var(--danger)'
        }),
        DS.stat({
          icon: '🚀', label: '当前版本', value: String(latest),
          sub: '共 ' + verAll.n + ' 个版本', color: 'var(--warn)'
        })
      ]);

      html += DS.actions([
        { text: '+ 新建授权', cls: 'btn-primary', onClick: { name: 'xhy:licNew' } },
        { text: '激活日志', cls: 'btn-outline', onClick: { name: 'xhy:goto', payload: 'activations' } },
        { text: '版本管理', cls: 'btn-outline', onClick: { name: 'xhy:goto', payload: 'versions' } }
      ]);
      html += '<div style="height:12px"></div>';

      /* 最近激活 */
      var actItems = acts.map(function (a) {
        var d = a.machine_codes || {};
        return DS.li({
          ic: a.is_success ? '✅' : '❌',
          title: d.device_name || d.user_name || DS.short(a.license_key, 18) || '未知设备',
          sub: DS.fmtTime(a.activation_time) + ' · ' + (a.ip_address || '无 IP'),
          badge: DS.dot(a.is_success ? '成功' : '失败', a.is_success ? 'ok' : 'err'),
          onClick: { name: 'xhy:actDetail', payload: { id: a.id } }
        });
      });
      html += DS.card(
        acts.length ? DS.list(actItems) : DS.empty('暂无激活记录', '📋'),
        { tight: true, title: '最近激活', right: '<span class="muted tiny">最新 10 条</span>' }
      );

      /* 30 天内到期 */
      var expItems = soonList.map(function (l) {
        var st = licStatus(l);
        return DS.li({
          ic: '⏰',
          title: DS.short(l.license_key, 26),
          sub: '到期 ' + DS.fmtDate(l.expiry_date),
          badge: DS.dot(st.label, st.type),
          onClick: { name: 'xhy:licDetail', payload: { id: l.id } }
        });
      });
      html += DS.card(
        soonList.length ? DS.list(expItems) : DS.empty('30 天内没有到期授权', '✅'),
        { tight: true, title: '即将过期（30 天内）' }
      );

      el.innerHTML = html;
    });
  }

  /* ---------- 4.2 授权管理 ---------- */
  function renderLicenses(pageId, el) {
    var st = DS.pager(K_LIC, PAGE_SIZE);
    var today = todayStr(0);

    var opts = {
      select: 'id,license_key,machine_code_id,expiry_date,is_active,is_revoked,created_at,machine_codes(machine_code,device_name,user_name)',
      order: 'created_at',
      ascending: false,
      rangeFrom: st.page * st.size,
      rangeTo: st.page * st.size + st.size - 1
    };
    if (st.filter === 'active') {
      opts.extraFilters = ['is_active=eq.true', 'is_revoked=eq.false', 'expiry_date=gt.' + today];
    } else if (st.filter === 'revoked') {
      opts.extraFilters = ['is_revoked=eq.true'];
    } else if (st.filter === 'expired') {
      opts.extraFilters = ['expiry_date=lte.' + today];
    }
    var kw = cleanKw(st.search);
    if (kw) opts.orFilter = ilikeOr(['license_key'], kw);

    var head =
      '<div class="toolbar">' + DS.searchBox(K_LIC, '搜索授权码…', st.search) + '</div>' +
      DS.fchips(F_LIC, st.filter, 'xhy:licFilter') +
      DS.actions([{ text: '+ 新建授权', cls: 'btn-primary', onClick: { name: 'xhy:licNew' } }]) +
      '<div style="height:12px"></div>';

    el.innerHTML = DS.loading('加载授权…');

    DS.api(CONN, 'licenses', opts).then(function (res) {
      if (res.error) {
        el.innerHTML = head + DS.errBox(DS.esc(res.error.message));
        return;
      }
      var rows = res.data || [];
      var total = DS.totalOf(res);
      var items = rows.map(function (l) {
        var d = l.machine_codes || {};
        var s = licStatus(l);
        return DS.li({
          ic: '🔑',
          title: DS.short(l.license_key, 28),
          sub: (d.device_name || '未绑定设备') + (d.user_name ? ' / ' + d.user_name : '') +
            ' · 到期 ' + DS.fmtDate(l.expiry_date),
          badge: DS.dot(s.label, s.type),
          onClick: { name: 'xhy:licDetail', payload: { id: l.id } }
        });
      });
      var body = rows.length
        ? DS.list(items)
        : DS.empty(kw ? '没有匹配的授权' : '暂无授权记录', '🔑');

      el.innerHTML = head +
        DS.card(body, {
          tight: true,
          title: '授权列表',
          right: '<span class="muted tiny">共 ' + DS.esc(total) + ' 条</span>'
        }) +
        DS.pagerHtml(K_LIC, total, st.size);
    });
  }

  /* ---------- 4.3 设备管理 ---------- */
  function renderDevices(pageId, el) {
    var st = DS.pager(K_DEV, PAGE_SIZE);

    var ef = ['order=last_seen.desc.nullslast'];
    if (st.filter === 'active') ef.push('is_active=eq.true');
    else if (st.filter === 'inactive') ef.push('is_active=eq.false');

    var opts = {
      select: 'id,machine_code,device_name,user_name,ip_address,is_active,created_at,last_seen,activation_count',
      extraFilters: ef,
      rangeFrom: st.page * st.size,
      rangeTo: st.page * st.size + st.size - 1
    };
    var kw = cleanKw(st.search);
    if (kw) opts.orFilter = ilikeOr(['machine_code', 'device_name', 'user_name'], kw);

    var head =
      '<div class="toolbar">' + DS.searchBox(K_DEV, '搜索设备名 / 用户名 / 机器码…', st.search) + '</div>' +
      DS.fchips(F_DEV, st.filter, 'xhy:devFilter') +
      '<div style="height:12px"></div>';

    el.innerHTML = DS.loading('加载设备…');

    DS.api(CONN, 'machine_codes', opts).then(function (res) {
      if (res.error) {
        el.innerHTML = head + DS.errBox(DS.esc(res.error.message));
        return;
      }
      var rows = res.data || [];
      var total = DS.totalOf(res);
      var items = rows.map(function (d) {
        var online = onlineOf(d);
        var badge = d.is_active
          ? DS.dot(online ? '在线' : '离线', online ? 'ok' : 'muted')
          : DS.dot('已停用', 'err');
        return DS.li({
          ic: '💻',
          title: d.device_name || '未知设备',
          sub: (d.user_name || '无用户名') + ' · ' + (d.ip_address || '无 IP') +
            ' · ' + (d.last_seen ? DS.fmtAgo(d.last_seen) : '从未上线'),
          badge: badge,
          onClick: { name: 'xhy:devDetail', payload: { id: d.id } }
        });
      });
      var body = rows.length
        ? DS.list(items)
        : DS.empty(kw ? '没有匹配的设备' : '暂无设备', '💻');

      el.innerHTML = head +
        DS.card(body, {
          tight: true,
          title: '设备列表',
          right: '<span class="muted tiny">共 ' + DS.esc(total) + ' 台</span>'
        }) +
        DS.pagerHtml(K_DEV, total, st.size);
    });
  }

  /* ---------- 4.4 激活日志 ---------- */
  function renderActivations(pageId, el) {
    var st = DS.pager(K_ACT, PAGE_SIZE);

    var opts = {
      select: 'id,license_id,license_key,machine_code_id,activation_time,is_success,failure_reason,ip_address,machine_codes(device_name,user_name)',
      order: 'activation_time',
      ascending: false,
      rangeFrom: st.page * st.size,
      rangeTo: st.page * st.size + st.size - 1
    };
    var kw = cleanKw(st.search);
    if (kw) opts.orFilter = ilikeOr(['license_key', 'ip_address'], kw);

    var head =
      '<div class="toolbar">' + DS.searchBox(K_ACT, '搜索授权码 / IP…', st.search) + '</div>';

    el.innerHTML = DS.loading('加载日志…');

    DS.api(CONN, 'activations', opts).then(function (res) {
      if (res.error) {
        el.innerHTML = head + DS.errBox(DS.esc(res.error.message));
        return;
      }
      var rows = res.data || [];
      var total = DS.totalOf(res);
      var items = rows.map(function (a) {
        var d = a.machine_codes || {};
        return DS.li({
          ic: a.is_success ? '✅' : '❌',
          title: d.device_name || d.user_name || '未知设备',
          sub: DS.fmtTime(a.activation_time) + ' · ' + (a.ip_address || '无 IP') +
            (a.is_success ? '' : ' · ' + (a.failure_reason || '未说明原因')),
          badge: DS.dot(a.is_success ? '成功' : '失败', a.is_success ? 'ok' : 'err'),
          onClick: { name: 'xhy:actDetail', payload: { id: a.id } }
        });
      });
      var body = rows.length
        ? DS.list(items)
        : DS.empty(kw ? '没有匹配的日志' : '暂无激活日志', '📋');

      el.innerHTML = head +
        DS.card(body, {
          tight: true,
          title: '激活日志',
          right: '<button class="btn btn-sm btn-danger"' + DS.act('xhy:actClear') + '>清空</button>'
        }) +
        DS.pagerHtml(K_ACT, total, st.size);
    });
  }

  /* ---------- 4.5 版本管理 ---------- */
  function renderVersions(pageId, el) {
    var st = DS.pager(K_VER, PAGE_SIZE);

    var opts = {
      select: 'id,version_number,release_date,description,is_latest',
      order: 'release_date',
      ascending: false,
      rangeFrom: st.page * st.size,
      rangeTo: st.page * st.size + st.size - 1
    };
    if (st.filter === 'latest') opts.extraFilters = ['is_latest=eq.true'];
    else if (st.filter === 'history') opts.extraFilters = ['is_latest=eq.false'];

    var kw = cleanKw(st.search);
    if (kw) opts.orFilter = ilikeOr(['version_number', 'description'], kw);

    var head =
      '<div class="toolbar">' + DS.searchBox(K_VER, '搜索版本号 / 说明…', st.search) + '</div>' +
      DS.fchips(F_VER, st.filter, 'xhy:verFilter') +
      DS.actions([{ text: '+ 新建版本', cls: 'btn-primary', onClick: { name: 'xhy:verNew' } }]) +
      '<div style="height:12px"></div>';

    el.innerHTML = DS.loading('加载版本…');

    DS.api(CONN, 'app_versions', opts).then(function (res) {
      if (res.error) {
        el.innerHTML = head + DS.errBox(DS.esc(res.error.message));
        return;
      }
      var rows = res.data || [];
      var total = DS.totalOf(res);
      var items = rows.map(function (v) {
        return DS.li({
          ic: '🚀',
          title: v.version_number || '-',
          sub: DS.fmtDate(v.release_date) + (v.description ? ' · ' + DS.short(v.description, 36) : ''),
          badge: DS.dot(v.is_latest ? '最新版' : '历史版', v.is_latest ? 'ok' : 'muted'),
          onClick: { name: 'xhy:verDetail', payload: { id: v.id } }
        });
      });
      var body = rows.length
        ? DS.list(items)
        : DS.empty(kw ? '没有匹配的版本' : '暂无版本', '🚀');

      el.innerHTML = head +
        DS.card(body, {
          tight: true,
          title: '版本列表',
          right: '<span class="muted tiny">共 ' + DS.esc(total) + ' 个</span>'
        }) +
        DS.pagerHtml(K_VER, total, st.size);
    });
  }

  /* ======================================================================
     5. 授权：详情 / 新建 / 延期
     ====================================================================== */

  function openLicenseDetail(id) {
    if (!id) return;
    var sh = DS.sheet({ title: '授权详情', html: DS.loading('加载授权…'), wide: true });

    getRows('licenses', { select: '*,machine_codes(*)', filters: { id: id }, limit: 1 })
      .then(function (res) {
        var l = (res.data || [])[0];
        if (!l) { sh.body.innerHTML = DS.empty('未找到该授权（可能已被删除）', '🔑'); return; }
        var d = l.machine_codes || {};
        var s = licStatus(l);
        var k = DS.short(l.license_key, 24);

        var html = '<div style="margin-bottom:10px">' + DS.dot(s.label, s.type) + '</div>';
        html += DS.kv([
          { k: '授权码', v: l.license_key || '-', mono: true },
          { k: '到期日期', v: DS.fmtDate(l.expiry_date) + (DS.daysLeft(l.expiry_date) === null ? '' : '（' + DS.daysLeft(l.expiry_date) + ' 天）') },
          { k: '状态', v: (l.is_active ? '激活' : '停用') + ' / ' + (l.is_revoked ? '已撤销' : '正常') },
          { k: '创建时间', v: DS.fmtTime(l.created_at) },
          { k: '撤销时间', v: l.revoked_at ? DS.fmtTime(l.revoked_at) : '-' },
          { k: '撤销原因', v: l.revoke_reason || '-' }
        ]);

        html += '<div class="section-h">绑定设备</div>';
        html += DS.kv([
          { k: '设备名', v: d.device_name || '未绑定' },
          { k: '用户名', v: d.user_name || '-' },
          { k: '机器码', v: d.machine_code || '-', mono: true },
          { k: 'IP', v: d.ip_address || '-' },
          { k: '最后上线', v: d.last_seen ? DS.fmtTime(d.last_seen) : '-' },
          { k: '激活次数', v: d.activation_count === null || d.activation_count === undefined ? '-' : String(d.activation_count) }
        ]);

        html += '<div class="section-h">操作</div>';
        html += DS.actions([
          { text: '延期', cls: 'btn-outline', onClick: { name: 'xhy:licExtend', payload: { id: l.id, exp: l.expiry_date } } },
          { text: '复制授权码', cls: 'btn-outline', onClick: { name: 'xhy:copy', payload: { text: l.license_key || '' } } },
          l.is_revoked
            ? { text: '恢复授权', cls: 'btn-primary', onClick: { name: 'xhy:licRestore', payload: { id: l.id } } }
            : { text: '撤销授权', cls: 'btn-danger', onClick: { name: 'xhy:licRevoke', payload: { id: l.id, k: k } } },
          { text: '删除授权', cls: 'btn-danger', onClick: { name: 'xhy:licDelete', payload: { id: l.id, k: k } } }
        ]);

        if (d.id) {
          html += '<div style="height:10px"></div>';
          html += DS.actions([
            { text: '查看设备', cls: 'btn-outline', onClick: { name: 'xhy:devDetail', payload: { id: d.id } } }
          ]);
        }

        sh.body.innerHTML = html;
      }, function (e) {
        sh.body.innerHTML = DS.errBox(DS.esc(e.message));
      });
  }

  function openLicenseNew() {
    var html =
      DS.textarea({ name: 'mc', label: '用户机器码', rows: 3, placeholder: '粘贴用户发来的机器码（必填）' }) +
      DS.input({ name: 'dn', label: '设备名称', placeholder: '如：张三的电脑' }) +
      DS.input({ name: 'un', label: '用户名', placeholder: '留空则自动生成「公司电脑-设备名」' }) +
      DS.input({ name: 'expiry', label: '到期日期', inputType: 'date', value: todayStr(365) }) +
      DS.input({ name: 'key', label: '授权码', placeholder: '留空自动生成 XHY-SEC-…' });

    formSheet({
      title: '新建授权',
      okText: '创建授权',
      html: html,
      onOk: function (data, close) {
        var mc = String(data.mc || '').replace(/[\r\n\s]+/g, '');
        var dn = String(data.dn || '').trim();
        var un = String(data.un || '').trim();
        var expiry = String(data.expiry || '').trim();
        var key = String(data.key || '').trim();
        if (!mc) { DS.toast('请输入用户机器码', 'err'); return; }
        if (!expiry) { DS.toast('请选择到期日期', 'err'); return; }
        if (!key) key = 'XHY-SEC-' + randomStr(80);
        if (!un && dn) un = '公司电脑-' + dn;

        doWrite(function () {
          return createLicense(mc, dn, un, expiry, key);
        }, {
          ok: '授权创建成功',
          err: '创建失败',
          done: function () {
            close();
            DS.copy(key);
            DS.refresh();
          }
        });
      }
    });
  }

  /** 机器码已存在则复用并更新设备信息，否则先建设备，再建授权 */
  function createLicense(mc, dn, un, expiry, key) {
    return getRows('machine_codes', { select: 'id', filters: { machine_code: mc }, limit: 1 })
      .then(function (res) {
        var row = (res.data || [])[0];
        if (row) {
          var patch = {};
          if (dn) patch.device_name = dn;
          if (un) patch.user_name = un;
          if (!Object.keys(patch).length) return row.id;
          return updateRow('machine_codes', row.id, patch).then(function () { return row.id; });
        }
        return postRow('machine_codes', {
          machine_code: mc,
          device_name: dn || null,
          user_name: un || null,
          is_active: true,
          activation_count: 0
        }).then(function (dev) {
          if (!dev || !dev.id) throw new Error('设备注册失败（返回数据为空）');
          return dev.id;
        });
      })
      .then(function (devId) {
        return postRow('licenses', {
          license_key: key,
          machine_code_id: devId,
          expiry_date: expiry,
          is_active: true,
          is_revoked: false
        });
      });
  }

  function openLicenseExtend(id, curExpiry) {
    var cur = String(curExpiry || '').substring(0, 10);
    var html =
      '<div class="tiny muted" style="margin-bottom:10px">当前到期：' + DS.esc(cur || '-') + '</div>' +
      DS.input({ name: 'expiry', label: '新到期日期', inputType: 'date', value: cur || todayStr(365) }) +
      '<div class="btn-row" style="margin-top:8px">' +
      '<button type="button" class="btn btn-sm btn-outline" data-xhy-plus="30">+30 天</button>' +
      '<button type="button" class="btn btn-sm btn-outline" data-xhy-plus="90">+90 天</button>' +
      '<button type="button" class="btn btn-sm btn-outline" data-xhy-plus="365">+1 年</button>' +
      '</div>';

    formSheet({
      title: '授权延期',
      okText: '确认延期',
      html: html,
      onReady: function (root) {
        DS.$$('[data-xhy-plus]', root).forEach(function (b) {
          b.addEventListener('click', function () {
            var n = DS.numOr(b.getAttribute('data-xhy-plus'), 30);
            DS.setForm(root, { expiry: todayStr(n) });
          });
        });
      },
      onOk: function (data, close) {
        var date = String(data.expiry || '').trim();
        if (!date) { DS.toast('请选择日期', 'err'); return; }
        doWrite(function () {
          return updateRow('licenses', id, { expiry_date: date, is_active: true });
        }, {
          ok: '延期成功',
          err: '延期失败',
          done: function () { close(); DS.refresh(); }
        });
      }
    });
  }

  /* ======================================================================
     6. 设备：详情 / 编辑
     ====================================================================== */

  function openDeviceDetail(id) {
    if (!id) return;
    var sh = DS.sheet({ title: '设备详情', html: DS.loading('加载设备…'), wide: true });

    getRows('machine_codes', {
      select: '*,licenses(id,license_key,expiry_date,is_active,is_revoked)',
      filters: { id: id },
      limit: 1
    }).then(function (res) {
      var d = (res.data || [])[0];
      if (!d) { sh.body.innerHTML = DS.empty('未找到该设备（可能已被删除）', '💻'); return; }
      var online = onlineOf(d);

      var html = '<div style="margin-bottom:10px">' +
        (d.is_active ? DS.dot(online ? '在线' : '离线', online ? 'ok' : 'muted') : DS.dot('已停用', 'err')) +
        '</div>';

      html += DS.kv([
        { k: '设备名', v: d.device_name || '未知' },
        { k: '用户名', v: d.user_name || '-' },
        { k: 'IP', v: d.ip_address || '-' },
        { k: '状态', v: d.is_active ? '启用' : '停用' },
        { k: '激活次数', v: d.activation_count === null || d.activation_count === undefined ? '0' : String(d.activation_count) },
        { k: '注册时间', v: DS.fmtTime(d.created_at) },
        { k: '最后上线', v: d.last_seen ? DS.fmtTime(d.last_seen) + '（' + DS.fmtAgo(d.last_seen) + '）' : '-' },
        { k: '机器码', v: d.machine_code || '-', mono: true }
      ]);

      var lics = d.licenses || [];
      html += '<div class="section-h">关联授权（' + lics.length + '）</div>';
      if (lics.length) {
        html += DS.list(lics.map(function (l) {
          var s = licStatus(l);
          return DS.li({
            ic: '🔑',
            title: DS.short(l.license_key, 26),
            sub: '到期 ' + DS.fmtDate(l.expiry_date),
            badge: DS.dot(s.label, s.type),
            onClick: { name: 'xhy:licDetail', payload: { id: l.id } }
          });
        }));
      } else {
        html += DS.empty('无关联授权', '🔑');
      }

      html += '<div class="section-h">操作</div>';
      html += DS.actions([
        {
          text: '编辑名称',
          cls: 'btn-outline',
          onClick: { name: 'xhy:devEdit', payload: { id: d.id, dn: d.device_name || '', un: d.user_name || '' } }
        },
        {
          text: d.is_active ? '停用设备' : '启用设备',
          cls: d.is_active ? 'btn-danger' : 'btn-primary',
          onClick: { name: 'xhy:devToggle', payload: { id: d.id, active: !d.is_active } }
        },
        { text: '复制机器码', cls: 'btn-outline', onClick: { name: 'xhy:copy', payload: { text: d.machine_code || '' } } },
        { text: '删除设备', cls: 'btn-danger', onClick: { name: 'xhy:devDelete', payload: { id: d.id, dn: d.device_name || '' } } }
      ]);

      sh.body.innerHTML = html;
    }, function (e) {
      sh.body.innerHTML = DS.errBox(DS.esc(e.message));
    });
  }

  function openDeviceEdit(id, deviceName, userName) {
    var html =
      DS.input({ name: 'device_name', label: '设备名称', value: deviceName || '', placeholder: '如：张三的电脑' }) +
      DS.input({ name: 'user_name', label: '用户名', value: userName || '', placeholder: '如：公司电脑-张三的电脑' });

    formSheet({
      title: '编辑设备',
      okText: '保存',
      html: html,
      onOk: function (data, close) {
        var dn = String(data.device_name || '').trim();
        var un = String(data.user_name || '').trim();
        doWrite(function () {
          return updateRow('machine_codes', id, { device_name: dn || null, user_name: un || null });
        }, {
          ok: '设备信息已更新',
          err: '保存失败',
          done: function () { close(); DS.refresh(); }
        });
      }
    });
  }

  /* ======================================================================
     7. 激活日志：详情
     ====================================================================== */

  function openActDetail(id) {
    if (!id) return;
    var sh = DS.sheet({ title: '激活详情', html: DS.loading('加载日志…'), wide: true });

    getRows('activations', {
      select: '*,machine_codes(device_name,user_name,machine_code)',
      filters: { id: id },
      limit: 1
    }).then(function (res) {
      var a = (res.data || [])[0];
      if (!a) { sh.body.innerHTML = DS.empty('未找到该日志（可能已被删除）', '📋'); return; }
      var d = a.machine_codes || {};

      var html = '<div style="margin-bottom:10px">' +
        DS.dot(a.is_success ? '激活成功' : '激活失败', a.is_success ? 'ok' : 'err') + '</div>';

      html += DS.kv([
        { k: '时间', v: DS.fmtTime(a.activation_time, true) },
        { k: '结果', v: a.is_success ? '成功' : '失败' },
        { k: '失败原因', v: a.failure_reason || '-' },
        { k: 'IP', v: a.ip_address || '-', mono: true },
        { k: '授权码', v: a.license_key || '-', mono: true },
        { k: '设备名', v: d.device_name || '-' },
        { k: '用户名', v: d.user_name || '-' },
        { k: '机器码', v: d.machine_code || '-', mono: true }
      ]);

      html += '<div class="section-h">操作</div>';
      html += DS.actions([
        { text: '删除这条日志', cls: 'btn-danger', onClick: { name: 'xhy:actDelete', payload: { id: a.id } } }
      ]);

      sh.body.innerHTML = html;
    }, function (e) {
      sh.body.innerHTML = DS.errBox(DS.esc(e.message));
    });
  }

  /* ======================================================================
     8. 版本：详情 / 新建 / 编辑 / 设为最新
     ====================================================================== */

  /** 把所有 is_latest=true 的版本取消标记（逐行 upsert，避免整表更新） */
  function clearLatest() {
    return getRows('app_versions', { select: '*', filters: { is_latest: true }, limit: 50 })
      .then(function (res) {
        var rows = res.data || [];
        if (!rows.length) return true;
        var i = 0;
        function step() {
          if (i >= rows.length) return true;
          var r = rows[i];
          i++;
          return upsertRow('app_versions', r.id, { is_latest: false }, r).then(step);
        }
        return step();
      });
  }

  function openVersionDetail(id) {
    if (!id) return;
    var sh = DS.sheet({ title: '版本详情', html: DS.loading('加载版本…'), wide: true });

    getRows('app_versions', { select: '*', filters: { id: id }, limit: 1 }).then(function (res) {
      var v = (res.data || [])[0];
      if (!v) { sh.body.innerHTML = DS.empty('未找到该版本（可能已被删除）', '🚀'); return; }

      var html = '<div style="margin-bottom:10px">' +
        DS.dot(v.is_latest ? '最新版' : '历史版', v.is_latest ? 'ok' : 'muted') + '</div>';

      html += DS.kv([
        { k: '版本号', v: v.version_number || '-' },
        { k: '发布日期', v: DS.fmtDate(v.release_date) },
        { k: '更新说明', v: v.description || '-' }
      ]);

      html += '<div class="section-h">操作</div>';
      html += DS.actions([
        v.is_latest
          ? null
          : { text: '设为最新', cls: 'btn-primary', onClick: { name: 'xhy:verLatest', payload: { id: v.id } } },
        { text: '编辑', cls: 'btn-outline', onClick: { name: 'xhy:verEdit', payload: { id: v.id } } },
        {
          text: '删除',
          cls: 'btn-danger',
          onClick: { name: 'xhy:verDelete', payload: { id: v.id, num: v.version_number || '', isLatest: !!v.is_latest } }
        }
      ]);

      sh.body.innerHTML = html;
    }, function (e) {
      sh.body.innerHTML = DS.errBox(DS.esc(e.message));
    });
  }

  function openVersionNew() {
    var html =
      DS.input({ name: 'version_number', label: '版本号', placeholder: '如 V2.1.4' }) +
      DS.input({ name: 'release_date', label: '发布日期', inputType: 'date', value: todayStr(0) }) +
      DS.textarea({ name: 'description', label: '更新说明', rows: 4, placeholder: '1.xxx；2.xxx；3.xxx' }) +
      DS.toggle({ name: 'is_latest', label: '设为最新版本', sub: '同一时间只会有一个最新版', checked: true });

    formSheet({
      title: '新建版本',
      okText: '创建',
      html: html,
      onOk: function (data, close) {
        var num = String(data.version_number || '').trim();
        var date = String(data.release_date || '').trim();
        var desc = String(data.description || '').trim();
        var isLatest = !!data.is_latest;
        if (!num) { DS.toast('请填写版本号', 'err'); return; }
        if (!date) { DS.toast('请选择发布日期', 'err'); return; }

        doWrite(function () {
          var pre = isLatest ? clearLatest() : Promise.resolve(true);
          return pre.then(function () {
            return postRow('app_versions', {
              version_number: num,
              release_date: date,
              description: desc,
              is_latest: isLatest
            });
          });
        }, {
          ok: '版本创建成功',
          err: '创建失败',
          done: function () { close(); DS.refresh(); }
        });
      }
    });
  }

  function openVersionEdit(id) {
    var sh = DS.sheet({ title: '编辑版本', html: DS.loading('加载版本…'), wide: true });

    getRows('app_versions', { select: '*', filters: { id: id }, limit: 1 }).then(function (res) {
      var v = (res.data || [])[0];
      if (!v) { sh.body.innerHTML = DS.empty('未找到该版本（可能已被删除）', '🚀'); return; }

      sh.body.innerHTML =
        DS.input({ name: 'version_number', label: '版本号', value: v.version_number || '' }) +
        DS.input({
          name: 'release_date', label: '发布日期', inputType: 'date',
          value: String(v.release_date || '').substring(0, 10)
        }) +
        DS.textarea({ name: 'description', label: '更新说明', rows: 4, value: v.description || '' }) +
        '<div class="btn-row" style="margin-top:10px">' +
        '<button type="button" class="btn btn-outline" data-xhy-cancel>取消</button>' +
        '<button type="button" class="btn btn-primary" data-xhy-save>保存</button>' +
        '</div>' +
        '<div data-xhy-msg style="margin-top:8px"></div>';

      /* 这个弹层要读取表单，所以在 body 内直接绑定，不经过 DS.sheet 的按钮槽 */
      var cancel = DS.$('[data-xhy-cancel]', sh.body);
      var save = DS.$('[data-xhy-save]', sh.body);
      if (cancel) cancel.addEventListener('click', function () { sh.close(); });
      if (save) save.addEventListener('click', function () {
        var d = DS.formData(sh.body);
        var num = String(d.version_number || '').trim();
        var date = String(d.release_date || '').trim();
        var desc = String(d.description || '').trim();
        if (!num || !date) { DS.toast('请填写版本号和发布日期', 'err'); return; }
        doWrite(function () {
          return updateRow('app_versions', id, {
            version_number: num, release_date: date, description: desc
          });
        }, {
          ok: '保存成功',
          err: '保存失败',
          done: function () { sh.close(); DS.refresh(); }
        });
      });
    }, function (e) {
      sh.body.innerHTML = DS.errBox(DS.esc(e.message));
    });
  }

  /* ======================================================================
     9. 注册模块
     ====================================================================== */

  DS.registerModule({
    id: 'xhy',
    name: 'XHY 授权',
    tabName: 'XHY',
    icon: '🔐',
    subtitle: 'XHY Toolbox 授权管理',
    conns: ['xhy'],
    pages: [
      { id: 'dashboard', title: '仪表盘' },
      { id: 'licenses', title: '授权' },
      { id: 'devices', title: '设备' },
      { id: 'activations', title: '激活' },
      { id: 'versions', title: '版本' }
    ],
    render: function (pageId, el) {
      if (pageId === 'licenses') return renderLicenses(pageId, el);
      if (pageId === 'devices') return renderDevices(pageId, el);
      if (pageId === 'activations') return renderActivations(pageId, el);
      if (pageId === 'versions') return renderVersions(pageId, el);
      return renderDashboard(pageId, el);
    }
  });
})();
