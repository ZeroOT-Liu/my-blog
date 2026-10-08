/* ==========================================================================
   移动后台 · 模块：scan —— 散线转文字 CAD 授权管理（手机优先版）
   --------------------------------------------------------------------------
   用途
     把桌面版后台「散线转文字 CAD 授权管理」（5-个人博客/scan_admin.js，
     约 2000 行 + admin.html 里的表格结构）改造成手机优先的 PWA 模块：
     统计用 DS.statGrid、列表用 DS.list/DS.li 卡片，不再用 4 列宽表格。

   连接
     固定使用框架连接名 'cad'
     （Supabase 项目 https://uwgqflcjuixmdhgzlvmb.supabase.co）。
     本文件**不含任何密钥**：anon / service_role key 由用户在「设置 → 数据源连接」
     里输入并只保存在本机浏览器，代码里一律通过 DS.api('cad', ...) 访问。

   用到的表
     users                 用户
     licenses              授权（授权码 / 绑定机器码 / 剩余天数 / 离线次数）
     orders                订单
     packages              套餐
     admin_users           管理员
     verification_codes    验证码
     login_logs            登录日志
     verify_logs           授权验证日志
     email_logs            邮件日志
     admin_operation_logs  管理员操作审计
     banned_emails         邮箱黑名单（黑名单页）
     banned_machines       机器码黑名单（黑名单页）
     deleted_users         用户回收站（回收站页）
     deleted_licenses      授权回收站（回收站页）

   从桌面版保留的等价逻辑
     scanLoadPackagesCache() → loadPackagesCache()
     scanStatusMap           → STATUS_MAP + statusChip()
     scanPkgNames            → PKG_NAMES + pkgName()
     scanGenLicenseKey()     → genLicenseKey()
     scanSha256()            → sha256()（密码盐 'CrayfishSalt2024'，与桌面版一致）
     scanQuickActivate()     → activateUser()（续期顺延 / 写订单 / 写审计日志）
     scanFixUserData()       → fixUserData()（tools 页）
     renderScanDbMonitor()   → tools 页的「数据库监控」

   与桌面版的差异（合理等价实现）
     1. 桌面版 12 个独立子页面 → 本模块 12 个二级导航页；其中：
        · login_logs / verify_logs / email_logs / admin_operation_logs /
          verification_codes 合并进「日志」页，页内用 DS.fchips 切换子类型；
        · dbmonitor + scanFixUserData 合并进「工具」页（另加导出、标记过期等维护动作）。
     2. 桌面版的表格操作列按钮（开通/编辑/删除…）改为「点列表项 → 详情弹层 → 操作按钮」，
        更适合触屏；所有危险操作走 DS.confirm({danger:true})。
     3. 桌面版所有 `onclick="scanXxx('id')"` 字符串拼接 → 本模块一律 DS.on()/DS.act()
        事件委托，id 不进入 HTML 属性字符串。

   实现注意
     本模块所有「按 id 更新」都走 safePatch()：先按 id 取回整行 → 合并改动 →
     upsert(POST + on_conflict=id) 写回。
     （app.js 早期版本的 PATCH 不带过滤条件，直接 PATCH 会更新整张表；框架
       现已修复并对无过滤条件的 PATCH/DELETE 加了拦截护栏，safePatch 的
       写法在任何版本下都安全，因此保留。）

   风格
     ES5（只用 var / function，无箭头函数、模板字符串、let/const、async-await），
     与 scan_admin.js 保持一致，兼容老手机浏览器。
   ========================================================================== */
(function () {
  'use strict';

  var DS = window.DS;
  var CONN = 'cad';

  /* ======================================================================
     1. 常量与页面级局部状态
     ====================================================================== */

  var PKG_TYPES = ['trial', 'month', 'season', 'year', 'permanent'];

  var PKG_NAMES = {
    trial: '7天试用', month: '月卡', season: '季卡', year: '年卡', permanent: '永久卡'
  };

  /* 桌面版 scanQuickActivate 里的兜底套餐（读不到 packages 表时使用） */
  var PKG_DEFAULTS = {
    trial: { price: 0, days: 7, offline_count: 5, name: '7天试用' },
    month: { price: 19, days: 30, offline_count: 5, name: '月卡' },
    season: { price: 29, days: 90, offline_count: 10, name: '季卡' },
    year: { price: 39, days: 365, offline_count: 30, name: '年卡' },
    permanent: { price: 99, days: 0, offline_count: 100, name: '永久卡' }
  };

  /* 桌面版 scanStatusMap：status → [中文, DS.dot 类型] */
  var STATUS_MAP = {
    user: {
      active: ['激活', 'ok'], disabled: ['停用', 'err'],
      pending: ['待验证', 'warn'], banned: ['封禁', 'err']
    },
    license: {
      active: ['有效', 'ok'], expired: ['过期', 'err'], revoked: ['撤销', 'err'],
      suspended: ['暂停', 'warn'], pending: ['待开通', 'warn']
    },
    order: {
      paid: ['已支付', 'ok'], pending: ['待支付', 'warn'],
      cancelled: ['已取消', 'muted'], refunded: ['已退款', 'err']
    }
  };

  var LOG_TABS = {
    login: { v: 'login', l: '登录日志', table: 'login_logs', ph: '搜索用户名 / IP / 设备' },
    verify: { v: 'verify', l: '授权日志', table: 'verify_logs', ph: '搜索授权码 / 设备号 / 用户ID' },
    email: { v: 'email', l: '邮件日志', table: 'email_logs', ph: '搜索收件人 / 主题 / 类型' },
    audit: { v: 'audit', l: '操作审计', table: 'admin_operation_logs', ph: '搜索管理员 / 动作 / 对象' },
    code: { v: 'code', l: '验证码', table: 'verification_codes', ph: '搜索邮箱 / 手机 / 验证码' }
  };
  var LOG_ORDER = ['login', 'verify', 'email', 'audit', 'code'];

  /* 密码盐：与桌面版 scanSha256(password + 'CrayfishSalt2024') 完全一致 */
  var PWD_SALT = 'CrayfishSalt2024';

  var PWD_TIP = '<div class="help">密码以 SHA256(密码 + ' + PWD_SALT + ') 存储，与桌面版后台一致。</div>';

  /* ---- 模块内部局部状态（不污染全局） ---- */
  var packagesCache = {};     // package_type -> 套餐行
  var packagesLoadedAt = 0;
  var blacklistTab = 'email'; // 'email' | 'machine'
  var recycleTab = 'user';    // 'user' | 'license'
  var logsTab = 'login';      // LOG_TABS 的键
  var toolsTables = ['users', 'licenses', 'orders', 'packages', 'admin_users',
    'verification_codes', 'login_logs', 'verify_logs', 'email_logs', 'admin_operation_logs'];
  var toolsTableMeta = {
    users: { ic: '👥', label: '用户' },
    licenses: { ic: '🔑', label: '授权' },
    orders: { ic: '🧾', label: '订单' },
    packages: { ic: '📦', label: '套餐' },
    admin_users: { ic: '🛡️', label: '管理员' },
    verification_codes: { ic: '🔢', label: '验证码' },
    login_logs: { ic: '🟢', label: '登录日志' },
    verify_logs: { ic: '✅', label: '授权日志' },
    email_logs: { ic: '📧', label: '邮件日志' },
    admin_operation_logs: { ic: '📝', label: '操作审计' }
  };

  /* ======================================================================
     2. 基础工具（保持 ES5）
     ====================================================================== */

  function nowISO() { return new Date().toISOString(); }

  function enc(v) { return encodeURIComponent(v); }

  /** orFilter 里的关键词清洗：干掉会破坏 PostgREST or=(...) 语法的字符 */
  function orKw(kw) {
    if (kw === undefined || kw === null) return '';
    return String(kw).replace(/[,()\\"]/g, ' ').replace(/\s+/g, ' ').trim();
  }

  /** 生成 like 条件：field.ilike.*kw* */
  function ilikeCond(field, kw) { return field + '.ilike.*' + kw + '*'; }

  function ilikeOr(fields, kw) {
    return fields.map(function (f) { return ilikeCond(f, kw); }).join(',');
  }

  /** 纯文字截断（不入 HTML 时可不用 DS.esc） */
  function short(s, n) { return DS.short(s, n); }

  /** 状态徽标：等价桌面版 scanStatusChip() */
  function statusChip(status, category) {
    var m = STATUS_MAP[category];
    if (m && status && m[status]) return DS.dot(m[status][0], m[status][1]);
    return DS.dot(status || '-', 'muted');
  }

  /** 套餐中文名：等价桌面版 scanPkgNames 查找 */
  function pkgName(t) {
    if (!t) return '-';
    return PKG_NAMES[t] || String(t);
  }

  function pkgText(p) {
    if (!p) return '-';
    return p.name || pkgName(p.package_type || p.type);
  }

  /** 套餐有效天数文案 */
  function daysText(p) {
    if (!p) return '-';
    var d = p.duration_days !== undefined && p.duration_days !== null ? p.duration_days : p.days;
    if (d === 0 || p.package_type === 'permanent' || p.lifetime) return '永久';
    if (!d) return '-';
    return d + '天';
  }

  /** 剩余天数文案（着色），等价桌面版 licenses 表的「剩余天数」列 */
  function remainHtml(l) {
    if (!l.expire_time) {
      if (l.package_type === 'permanent') return '<span style="color:var(--accent);font-weight:600">永久</span>';
      return '<span class="muted">-</span>';
    }
    var d = DS.daysLeft(l.expire_time);
    if (d === null) return '<span class="muted">-</span>';
    if (d <= 0) return '<span class="muted" style="font-weight:600">已过期</span>';
    var color = d <= 7 ? 'var(--danger)' : (d <= 30 ? 'var(--warn)' : 'var(--success)');
    return '<span style="color:' + color + ';font-weight:600">' + d + '天</span>';
  }

  /** 机器码列表（授权最多绑 4 台） */
  function machineCodes(l) {
    return [l.machine_code, l.machine_code_2, l.machine_code_3, l.machine_code_4]
      .filter(function (x) { return !!x; });
  }

  /** 生成授权码：等价桌面版 scanGenLicenseKey() */
  function genLicenseKey(packageType) {
    var map = { trial: 'CAD-T', month: 'CAD-M', season: 'CAD-S', year: 'CAD-Y', permanent: 'CAD-P' };
    var prefix = map[packageType] || 'CAD-X';
    var chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    var rand = '';
    for (var i = 0; i < 12; i++) rand += chars.charAt(Math.floor(Math.random() * chars.length));
    return prefix + '-' + rand;
  }

  /** SHA-256（Promise 版，等价桌面版 scanSha256，非安全上下文退化处理） */
  function fallbackHash(text) {
    var h = 5381;
    for (var i = 0; i < text.length; i++) { h = ((h << 5) + h) + text.charCodeAt(i); h |= 0; }
    return 'fallback_' + (h >>> 0).toString(16);
  }

  function sha256(text) {
    text = String(text === undefined || text === null ? '' : text);
    if (window.crypto && window.crypto.subtle && window.TextEncoder) {
      try {
        return window.crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
          .then(function (buf) {
            var u8 = new Uint8Array(buf);
            var out = [];
            for (var i = 0; i < u8.length; i++) out.push(('0' + u8[i].toString(16)).slice(-2));
            return out.join('');
          }, function () { return fallbackHash(text); });
      } catch (e) { /* 继续走退化实现 */ }
    }
    return Promise.resolve(fallbackHash(text));
  }

  /** 求和 */
  function sumBy(list, field) {
    var s = 0;
    (list || []).forEach(function (x) { s += (parseFloat(x[field]) || 0); });
    return s;
  }

  function money(n) { return DS.fmtMoney(n); }

  /* ======================================================================
     3. 数据访问封装
     ====================================================================== */

  /** 列表查询失败 → 统一错误框 */
  function errBoxOf(res) {
    var msg = (res && res.error && res.error.message) ? res.error.message : '加载失败';
    return DS.errBox(DS.esc(msg));
  }

  /**
   * 安全更新：按主键「取整行 → 合并 → upsert 写回」。
   * 不直接用 PATCH 是为了在任何 app.js 版本下都不会误伤整张表。
   */
  function safePatch(table, id, patch) {
    return DS.api(CONN, table, { select: '*', filters: { id: id }, limit: 1 }).then(function (res) {
      if (res.error) return res;
      var row = (res.data || [])[0];
      if (!row) return { data: null, error: { message: '记录不存在或已被删除' }, count: 0 };
      var merged = {};
      var k;
      for (k in row) { if (Object.prototype.hasOwnProperty.call(row, k)) merged[k] = row[k]; }
      for (k in patch) { if (Object.prototype.hasOwnProperty.call(patch, k)) merged[k] = patch[k]; }
      return DS.api(CONN, table, {
        method: 'POST', upsert: true, onConflict: 'id', data: merged
      });
    });
  }

  /** 写审计日志（不阻塞主流程，失败只在控制台警告） */
  function logAdmin(action, table, id, desc, details) {
    return DS.api(CONN, 'admin_operation_logs', {
      method: 'POST',
      data: {
        action: action,
        target_table: table,
        target_id: id,
        description: desc || '',
        details: details || {},
        admin_username: 'admin',
        created_at: nowISO()
      }
    }).then(function (res) {
      if (res.error && window.console) console.warn('[scan] 审计日志写入失败：' + res.error.message);
      return res;
    });
  }

  /** 等价桌面版 scanLoadPackagesCache()：把上架套餐缓存成 package_type → 行 */
  function loadPackagesCache(force) {
    if (!force && packagesLoadedAt && (Date.now() - packagesLoadedAt) < 60000) {
      return Promise.resolve(packagesCache);
    }
    return DS.api(CONN, 'packages', {
      select: 'id,name,package_type,price,original_price,duration_days,offline_count,max_bindings,sort_order,is_active',
      extraFilters: ['is_active=eq.true'],
      order: 'sort_order.asc',
      limit: 100
    }).then(function (res) {
      if (res.error) {
        if (window.console) console.warn('[scan] loadPackagesCache 失败：' + res.error.message);
        return packagesCache;
      }
      var cache = {};
      (res.data || []).forEach(function (p) { if (p.package_type) cache[p.package_type] = p; });
      packagesCache = cache;
      packagesLoadedAt = Date.now();
      return packagesCache;
    });
  }

  /** 批量补齐 licenses 的关联用户：等价桌面版 renderScanGenericTable 的 joinUsers */
  function joinUsers(rows) {
    rows = rows || [];
    var ids = [];
    rows.forEach(function (r) {
      if (r.user_id && ids.indexOf(r.user_id) < 0) ids.push(r.user_id);
    });
    if (!ids.length) {
      rows.forEach(function (r) { r._user = null; });
      return Promise.resolve(rows);
    }
    var filterStr = 'id=in.(' + ids.map(function (id) { return '"' + id + '"'; }).join(',') + ')';
    return DS.api(CONN, 'users', {
      select: 'id,nickname,username,email', extraFilters: [filterStr]
    }).then(function (res) {
      var map = {};
      if (!res.error) (res.data || []).forEach(function (u) { map[u.id] = u; });
      rows.forEach(function (r) { r._user = map[r.user_id] || null; });
      return rows;
    });
  }

  function userName(r) {
    if (!r) return '-';
    if (r._user) return r._user.nickname || r._user.username || r._user.email || short(r.user_id, 8);
    return r.user_id ? short(r.user_id, 8) : '-';
  }

  function userMail(r) {
    if (r && r._user && r._user.email) return r._user.email;
    return '-';
  }

  /* ======================================================================
     4. 分页 / 搜索绑定（key 前缀统一 scan.）
     ====================================================================== */

  var LIST_KEYS = ['scan.users', 'scan.licenses', 'scan.orders', 'scan.packages',
    'scan.devices', 'scan.blacklist', 'scan.recycle', 'scan.logs', 'scan.admins', 'scan.tools'];

  function resetPager(key, keepSearch) {
    var st = DS.pager(key);
    st.page = 0;
    if (!keepSearch) st.search = '';
    DS.savePagerState(key);
    return st;
  }

  function wireList(key) {
    DS.onSearch(key, function (kw) {
      var st = DS.pager(key);
      st.search = String(kw === undefined || kw === null ? '' : kw).trim();
      st.page = 0;
      DS.savePagerState(key);
      DS.refresh();
    });
    DS.onPager(key, function () { DS.refresh(); });
  }

  LIST_KEYS.forEach(wireList);

  /* ======================================================================
     5. 通用 UI 小件
     ====================================================================== */

  /** 表单弹层：html 里用 DS.input / DS.select / ...，onSubmit 返回 false 表示不关闭 */
  function formSheet(opt) {
    var bodyEl = null;
    DS.sheet({
      title: opt.title,
      html: opt.html,
      buttons: [
        { text: opt.cancelText || '取消', cls: 'btn-outline' },
        {
          text: opt.okText || '保存',
          cls: opt.danger ? 'btn-danger' : 'btn-primary',
          onClick: function (close) {
            if (!bodyEl) return false;
            Promise.resolve()
              .then(function () { return opt.onSubmit(bodyEl); })
              .then(function (r) {
                if (r === false) return;
                close();
              })
              .catch(function (e) {
                DS.toast((e && e.message) ? e.message : '操作失败', 'err');
              });
            return false; // 手动关闭，方便失败时留在弹层里
          }
        }
      ],
      onReady: function (body) {
        bodyEl = body;
        if (opt.onReady) opt.onReady(body);
      }
    });
  }

  /** 只读详情弹层：onReady 里异步灌内容 */
  function detailSheet(title, loader, extraButtons) {
    var btns = [{ text: '关闭', cls: 'btn-outline' }];
    (extraButtons || []).forEach(function (b) { btns.push(b); });
    DS.sheet({
      title: title,
      html: DS.loading('加载中…'),
      buttons: btns,
      onReady: function (body) { loader(body); }
    });
  }

  /** 取最后一个同名表单字段（弹层叠栈时取最上面那个） */
  function lastField(name) {
    var els = document.querySelectorAll('[data-name="' + name + '"]');
    return els.length ? els[els.length - 1] : null;
  }

  /** 进度条行：label 与 value 允许传已转义的 HTML */
  function barRow(labelHtml, valueHtml, pct) {
    return '<div style="padding:8px 0">' +
      '<div style="display:flex;justify-content:space-between;gap:10px;font-size:13px;margin-bottom:6px">' +
      '<span style="min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' + labelHtml + '</span>' +
      '<span style="font-weight:600;flex:0 0 auto">' + valueHtml + '</span>' +
      '</div>' + DS.bar(pct) + '</div>';
  }

  /** 工具栏：搜索框 + 动作按钮 */
  function toolbar(searchKey, placeholder, searchValue, buttons) {
    var html = '<div class="toolbar">' + DS.searchBox(searchKey, placeholder, searchValue) + '</div>';
    if (buttons && buttons.length) html += DS.actions(buttons);
    return html;
  }

  function gap(h) { return '<div style="height:' + (h || 10) + 'px"></div>'; }

  /** 弹层里的一行键值（转义由 DS.kv 负责） */
  function kvList(items) { return DS.kv(items); }

  /* ======================================================================
     6. 详情弹层（用户 / 授权 / 订单 / 套餐 / 管理员 / 黑名单 / 回收站）
     ====================================================================== */

  function openUserDetail(id) {
    detailSheet('用户详情', function (body) {
      DS.api(CONN, 'users', { select: '*', filters: { id: id }, limit: 1 }).then(function (res) {
        if (res.error) { body.innerHTML = errBoxOf(res); return; }
        var u = (res.data || [])[0];
        if (!u) { body.innerHTML = DS.empty('用户不存在或已被删除', '👤'); return; }
        var name = u.nickname || u.username || u.email || '未命名';
        var trial = (u.trial_used === true || u.trial_used === 1 || u.trial_used === 'true' || u.trial_used === '1')
          ? DS.chip('已用', 'muted') : DS.chip('未用', 'ok');
        body.innerHTML =
          '<div class="detail-head"><div class="detail-title">' + DS.esc(name) + '</div>' +
          '<div class="detail-tags">' + statusChip(u.status, 'user') + trial + '</div></div>' +
          kvList([
            ['用户 ID', { v: u.id, mono: true }],
            ['用户名', u.username || '-'],
            ['昵称', u.nickname || '-'],
            ['邮箱', u.email || '-'],
            ['手机号', u.phone || '-'],
            ['机器码', { v: u.machine_code || '未绑定', mono: true }],
            ['最后登录', u.last_login ? DS.fmtTime(u.last_login) : '从未登录'],
            ['注册时间', DS.fmtTime(u.created_at)]
          ]) +
          gap(12) +
          DS.actions([
            { text: '🔑 开通授权', cls: 'btn-success', onClick: { name: 'scan:userActivate', payload: { id: u.id, name: name } } },
            { text: '编辑', cls: 'btn-outline', onClick: { name: 'scan:userEdit', payload: { id: u.id } } },
            { text: '删除', cls: 'btn-danger-o', onClick: { name: 'scan:userDel', payload: { id: u.id, name: name } } }
          ]);
      });
    });
  }

  function openLicenseDetail(id) {
    detailSheet('授权详情', function (body) {
      DS.api(CONN, 'licenses', { select: '*', filters: { id: id }, limit: 1 }).then(function (res) {
        if (res.error) { body.innerHTML = errBoxOf(res); return; }
        var l = (res.data || [])[0];
        if (!l) { body.innerHTML = DS.empty('授权不存在或已被删除', '🔑'); return; }
        joinUsers([l]).then(function () {
          var mcs = machineCodes(l);
          body.innerHTML =
            '<div class="detail-head"><div class="detail-title mono" style="font-size:16px">' + DS.esc(l.license_key || '-') + '</div>' +
            '<div class="detail-tags">' + statusChip(l.status, 'license') + DS.chip(pkgName(l.package_type), '') + '</div></div>' +
            kvList([
              ['授权 ID', { v: l.id, mono: true }],
              ['用户', userName(l)],
              ['邮箱', userMail(l)],
              ['用户 ID', { v: l.user_id || '-', mono: true }],
              ['套餐', pkgName(l.package_type)],
              ['状态', { v: statusChip(l.status, 'license'), raw: true }],
              ['开始时间', DS.fmtTime(l.start_time)],
              ['到期时间', l.expire_time ? DS.fmtTime(l.expire_time) : '永久'],
              ['剩余天数', { v: remainHtml(l), raw: true }],
              ['绑定数', (DS.numOr(l.bind_count, 0)) + ' / ' + (DS.numOr(l.max_bindings, 0))],
              ['离线次数', (DS.numOr(l.offline_count, 0)) + ' / ' + (DS.numOr(l.total_offline_count, 0))],
              ['机器码', mcs.length
                ? { v: mcs.map(function (x) { return DS.esc(x); }).join('<br>'), mono: true, raw: true }
                : '未绑定'],
              ['备注', l.note || '-']
            ]) +
            gap(12) +
            DS.actions([
              { text: '⏰ 延期', cls: 'btn-primary', onClick: { name: 'scan:licenseExtend', payload: { id: l.id } } },
              { text: '编辑', cls: 'btn-outline', onClick: { name: 'scan:licenseEdit', payload: { id: l.id } } },
              { text: '复制授权码', cls: 'btn-outline', onClick: { name: 'scan:copy', payload: { text: l.license_key || '' } } },
              { text: '删除', cls: 'btn-danger-o', onClick: { name: 'scan:licenseDel', payload: { id: l.id, key: l.license_key || '' } } }
            ]);
        });
      });
    });
  }

  function openOrderDetail(id) {
    detailSheet('订单详情', function (body) {
      DS.api(CONN, 'orders', { select: '*', filters: { id: id }, limit: 1 }).then(function (res) {
        if (res.error) { body.innerHTML = errBoxOf(res); return; }
        var o = (res.data || [])[0];
        if (!o) { body.innerHTML = DS.empty('订单不存在', '🧾'); return; }
        body.innerHTML =
          '<div class="detail-head"><div class="detail-title mono" style="font-size:16px">' + DS.esc(o.order_no || o.id) + '</div>' +
          '<div class="detail-tags">' + statusChip(o.status, 'order') + '</div></div>' +
          kvList([
            ['订单 ID', { v: o.id, mono: true }],
            ['用户 ID', { v: o.user_id || '-', mono: true }],
            ['套餐', pkgName(o.package_type)],
            ['金额', money(o.amount)],
            ['状态', { v: statusChip(o.status, 'order'), raw: true }],
            ['支付方式', o.payment_method || '未支付'],
            ['支付时间', o.paid_at ? DS.fmtTime(o.paid_at) : '-'],
            ['创建时间', DS.fmtTime(o.created_at)]
          ]) +
          gap(12) +
          DS.actions([
            { text: '编辑', cls: 'btn-primary', onClick: { name: 'scan:orderEdit', payload: { id: o.id } } }
          ]);
      });
    });
  }

  function openPackageDetail(id) {
    detailSheet('套餐详情', function (body) {
      DS.api(CONN, 'packages', { select: '*', filters: { id: id }, limit: 1 }).then(function (res) {
        if (res.error) { body.innerHTML = errBoxOf(res); return; }
        var p = (res.data || [])[0];
        if (!p) { body.innerHTML = DS.empty('套餐不存在', '📦'); return; }
        var active = p.is_active !== false;
        body.innerHTML =
          '<div class="detail-head"><div class="detail-title">' + DS.esc(pkgText(p)) + '</div>' +
          '<div class="detail-tags">' + DS.dot(active ? '上架' : '下架', active ? 'ok' : 'muted') +
          DS.chip(pkgName(p.package_type || p.type), '') + '</div></div>' +
          kvList([
            ['套餐 ID', { v: p.id, mono: true }],
            ['套餐类型', pkgName(p.package_type || p.type)],
            ['价格', money(p.price)],
            ['原价', p.original_price !== undefined && p.original_price !== null ? money(p.original_price) : '-'],
            ['有效天数', daysText(p)],
            ['离线次数', p.offline_count !== undefined ? String(p.offline_count) : '-'],
            ['最大绑定数', p.max_bindings !== undefined ? String(p.max_bindings) : '-'],
            ['排序', p.sort_order !== undefined ? String(p.sort_order) : '-'],
            ['描述', p.description || '-']
          ]) +
          gap(12) +
          DS.actions([
            { text: '编辑', cls: 'btn-primary', onClick: { name: 'scan:pkgEdit', payload: { id: p.id } } },
            active
              ? { text: '下架', cls: 'btn-outline', onClick: { name: 'scan:pkgToggle', payload: { id: p.id, active: false, name: pkgText(p) } } }
              : { text: '上架', cls: 'btn-success', onClick: { name: 'scan:pkgToggle', payload: { id: p.id, active: true, name: pkgText(p) } } }
          ]);
      });
    });
  }

  function openAdminDetail(id) {
    detailSheet('管理员详情', function (body) {
      DS.api(CONN, 'admin_users', { select: '*', filters: { id: id }, limit: 1 }).then(function (res) {
        if (res.error) { body.innerHTML = errBoxOf(res); return; }
        var a = (res.data || [])[0];
        if (!a) { body.innerHTML = DS.empty('管理员不存在', '🛡️'); return; }
        var superAdmin = a.role === 'super_admin';
        body.innerHTML =
          '<div class="detail-head"><div class="detail-title">' + DS.esc(a.username || '-') + '</div>' +
          '<div class="detail-tags">' + DS.dot(superAdmin ? '超级管理员' : '管理员', superAdmin ? 'err' : 'info') + '</div></div>' +
          kvList([
            ['ID', { v: a.id, mono: true }],
            ['用户名', a.username || '-'],
            ['昵称', a.nickname || '-'],
            ['邮箱', a.email || '-'],
            ['角色', superAdmin ? '超级管理员' : '管理员'],
            ['最后登录', a.last_login ? DS.fmtTime(a.last_login) : '从未登录'],
            ['创建时间', DS.fmtTime(a.created_at)]
          ]) +
          gap(12) +
          DS.actions([
            { text: '编辑', cls: 'btn-primary', onClick: { name: 'scan:adminEdit', payload: { id: a.id } } },
            { text: '重置密码', cls: 'btn-outline', onClick: { name: 'scan:adminReset', payload: { id: a.id, username: a.username || '' } } }
          ]);
      });
    });
  }

  function openBlacklistDetail(type, id) {
    var table = type === 'email' ? 'banned_emails' : 'banned_machines';
    detailSheet(type === 'email' ? '邮箱黑名单' : '机器码黑名单', function (body) {
      DS.api(CONN, table, { select: '*', filters: { id: id }, limit: 1 }).then(function (res) {
        if (res.error) { body.innerHTML = errBoxOf(res); return; }
        var r = (res.data || [])[0];
        if (!r) { body.innerHTML = DS.empty('记录不存在', '🚫'); return; }
        var active = r.is_active !== false;
        body.innerHTML =
          '<div class="detail-head"><div class="detail-title mono" style="font-size:15px;word-break:break-all">' +
          DS.esc(type === 'email' ? (r.email_pattern || r.email || '-') : (r.machine_code || '-')) + '</div>' +
          '<div class="detail-tags">' + DS.dot(active ? '生效中' : '已禁用', active ? 'err' : 'muted') + '</div></div>' +
          kvList([
            ['ID', { v: r.id, mono: true }],
            ['原因', r.reason || '-'],
            ['创建人', r.created_by_username || r.created_by || '-'],
            ['创建时间', DS.fmtTime(r.created_at)]
          ]) +
          gap(12) +
          (active ? DS.actions([
            { text: '移除黑名单', cls: 'btn-danger', onClick: { name: 'scan:blacklistRemove', payload: { type: type, id: r.id } } }
          ]) : '<div class="tiny muted">该记录已禁用（is_active = false）。</div>');
      });
    });
  }

  function openRecycleDetail(type, id) {
    var table = type === 'user' ? 'deleted_users' : 'deleted_licenses';
    detailSheet('回收站记录', function (body) {
      DS.api(CONN, table, { select: '*', filters: { id: id }, limit: 1 }).then(function (res) {
        if (res.error) { body.innerHTML = errBoxOf(res); return; }
        var r = (res.data || [])[0];
        if (!r) { body.innerHTML = DS.empty('记录不存在', '♻️'); return; }
        var snap = r.original_data;
        if (typeof snap === 'string') { try { snap = JSON.parse(snap); } catch (e) { /* 保持原样 */ } }
        var text = '';
        if (snap && typeof snap === 'object') {
          text = snap.nickname || snap.username || snap.email || snap.license_key || snap.id || '';
        }
        body.innerHTML =
          '<div class="detail-head"><div class="detail-title">' + DS.esc(text || '（无摘要）') + '</div>' +
          '<div class="detail-tags">' + (r.is_restored ? DS.dot('已恢复', 'ok') : DS.dot('已删除', 'err')) + '</div></div>' +
          kvList([
            ['记录 ID', { v: r.id, mono: true }],
            ['删除人', r.deleted_by || '-'],
            ['删除时间', DS.fmtTime(r.deleted_at)],
            ['原表', type === 'user' ? 'users' : 'licenses']
          ]) +
          '<div class="card-title" style="padding:14px 0 6px">原始数据快照</div>' +
          '<pre class="code-block" style="max-height:240px;overflow:auto;font-size:11px">' +
          DS.esc(JSON.stringify(snap === undefined || snap === null ? {} : snap, null, 2)) + '</pre>' +
          gap(12) +
          (r.is_restored ? '<div class="tiny muted">该记录已恢复过，无需重复操作。</div>' : DS.actions([
            { text: '♻️ 恢复', cls: 'btn-success', onClick: { name: 'scan:recycleRestore', payload: { type: type, id: r.id } } },
            { text: '永久删除', cls: 'btn-danger', onClick: { name: 'scan:recyclePurge', payload: { type: type, id: r.id } } }
          ]));
      });
    });
  }

  /* ======================================================================
     7. 页面：仪表盘
     ====================================================================== */

  function renderDashboard(el) {
    el.innerHTML = DS.loading('加载仪表盘…');
    var todayStart = DS.todayStart();
    var weekLater = new Date(Date.now() + 7 * 86400000).toISOString();
    var nowStr = nowISO();

    Promise.all([
      DS.api(CONN, 'users', { select: 'id', countOnly: true }),
      DS.api(CONN, 'users', { select: 'id', countOnly: true, extraFilters: ['created_at=gte.' + enc(todayStart)] }),
      DS.api(CONN, 'licenses', { select: 'id', countOnly: true }),
      DS.api(CONN, 'licenses', { select: 'id', countOnly: true, filters: { status: 'active' } }),
      DS.api(CONN, 'licenses', {
        select: 'id', countOnly: true,
        extraFilters: ['status=eq.active', 'expire_time=lt.' + enc(weekLater), 'expire_time=gt.' + enc(nowStr)]
      }),
      DS.api(CONN, 'orders', { select: 'id', countOnly: true }),
      DS.api(CONN, 'orders', { select: 'id', countOnly: true, filters: { status: 'pending' } }),
      DS.apiAll(CONN, 'orders', { select: 'id,amount', filters: { status: 'paid' } }, 5000),
      DS.apiAll(CONN, 'orders', { select: 'id,amount,paid_at', filters: { status: 'paid' }, extraFilters: ['paid_at=gte.' + enc(todayStart)] }, 2000),
      DS.api(CONN, 'users', { select: 'id,nickname,username,email,status,created_at', order: 'created_at', ascending: false, limit: 6 }),
      DS.api(CONN, 'licenses', { select: 'id,license_key,package_type,status,expire_time,created_at', order: 'created_at', ascending: false, limit: 6 }),
      loadPackagesCache()
    ]).then(function (r) {
      for (var i = 0; i < 10; i++) {
        if (r[i] && r[i].error) { el.innerHTML = errBoxOf(r[i]); return; }
      }
      var totalUsers = r[0].count || 0;
      var todayUsers = r[1].count || 0;
      var totalLic = r[2].count || 0;
      var activeLic = r[3].count || 0;
      var expiring = r[4].count || 0;
      var totalOrders = r[5].count || 0;
      var pendingOrders = r[6].count || 0;
      var paidOrders = r[7].data || [];
      var todayPaid = r[8].data || [];
      var recentUsers = r[9].data || [];
      var recentLic = r[10].data || [];
      var totalRevenue = sumBy(paidOrders, 'amount');
      var todayRevenue = sumBy(todayPaid, 'amount');
      var pct = Math.round(activeLic * 100 / Math.max(1, totalLic));

      DS.setBadge('scan', pendingOrders);

      var html = '';
      html += DS.statGrid([
        { icon: '👥', label: '用户总数', value: DS.fmtNum(totalUsers), sub: todayUsers > 0 ? '+' + todayUsers + ' 今日' : '今日 0', subType: todayUsers > 0 ? 'ok' : 'muted', color: 'var(--accent)' },
        { icon: '🔑', label: '授权总数', value: DS.fmtNum(totalLic), sub: activeLic + ' 个有效', subType: 'ok', color: 'var(--success)' },
        { icon: '⏰', label: '7 天内即将过期', value: DS.fmtNum(expiring), sub: expiring > 0 ? '需要关注' : '很安全', subType: expiring > 0 ? 'warn' : 'ok', color: 'var(--warn)' },
        { icon: '🧾', label: '订单总数', value: DS.fmtNum(totalOrders), sub: pendingOrders + ' 待支付', subType: pendingOrders > 0 ? 'warn' : 'muted', color: '#3b82f6' },
        { icon: '💰', label: '今日收入', value: money(todayRevenue), sub: todayRevenue > 0 ? '已入账' : '暂无', subType: todayRevenue > 0 ? 'ok' : 'muted', color: 'var(--success)' },
        { icon: '📈', label: '累计收入', value: money(totalRevenue), sub: '共 ' + paidOrders.length + ' 笔', subType: 'info', color: 'var(--accent)' },
        { icon: '💻', label: '活跃授权占比', value: pct + '%', sub: activeLic + ' / ' + totalLic, subType: 'info', color: '#8b5cf6' },
        { icon: '📊', label: '今日新增用户', value: DS.fmtNum(todayUsers), sub: '位新用户', subType: 'info', color: '#0ea5e9' }
      ]);

      html += DS.card(DS.list(recentUsers.length ? recentUsers.map(function (u) {
        return DS.li({
          ic: '👤',
          title: u.nickname || u.username || u.email || '匿名用户',
          sub: (u.email || '无邮箱') + ' · ' + DS.fmtAgo(u.created_at),
          badge: statusChip(u.status, 'user'),
          onClick: { name: 'scan:userDetail', payload: { id: u.id } }
        });
      }) : [DS.li({ title: '暂无用户', sub: '去用户管理页新增一个', ic: '👥' })]), { title: '最近注册', right: '<span class="tiny muted">最近 6 位</span>', tight: true });

      html += DS.card(DS.list(recentLic.length ? recentLic.map(function (l) {
        return DS.li({
          ic: '🔑',
          title: l.license_key || '-',
          sub: pkgName(l.package_type) + ' · ' + (l.expire_time ? '到期 ' + DS.fmtDate(l.expire_time) : '永久有效'),
          badge: statusChip(l.status, 'license'),
          onClick: { name: 'scan:licenseDetail', payload: { id: l.id } }
        });
      }) : [DS.li({ title: '暂无授权', sub: '可在用户详情里一键开通', ic: '🔑' })]), { title: '最近授权', right: '<span class="tiny muted">最近 6 条</span>', tight: true });

      html += DS.actions([
        { text: '👥 用户管理', cls: 'btn-outline', onClick: { name: 'scan:goPage', payload: { page: 'users' } } },
        { text: '🔑 授权管理', cls: 'btn-outline', onClick: { name: 'scan:goPage', payload: { page: 'licenses' } } },
        { text: '💰 收入统计', cls: 'btn-outline', onClick: { name: 'scan:goPage', payload: { page: 'revenue' } } },
        { text: '🧾 订单管理', cls: 'btn-outline', onClick: { name: 'scan:goPage', payload: { page: 'orders' } } }
      ]);

      el.innerHTML = html;
    });
  }

  /* ======================================================================
     8. 页面：收入统计
     ====================================================================== */

  function renderRevenue(el) {
    el.innerHTML = DS.loading('加载收入数据…');
    var today = new Date(); today.setHours(0, 0, 0, 0);
    var last7 = [];
    for (var i = 6; i >= 0; i--) {
      var d = new Date(today.getTime());
      d.setDate(d.getDate() - i);
      var nxt = new Date(d.getTime());
      nxt.setDate(nxt.getDate() + 1);
      last7.push({ label: (d.getMonth() + 1) + '/' + d.getDate(), start: d.toISOString(), end: nxt.toISOString(), amount: 0 });
    }

    DS.apiAll(CONN, 'orders', {
      select: 'id,order_no,package_type,amount,status,paid_at,created_at',
      filters: { status: 'paid' },
      order: 'paid_at',
      ascending: false
    }, 5000).then(function (res) {
      if (res.error) { el.innerHTML = errBoxOf(res); return; }
      var list = res.data || [];
      var total = sumBy(list, 'amount');
      var byPkg = {};
      list.forEach(function (o) {
        var k = o.package_type || 'unknown';
        byPkg[k] = (byPkg[k] || 0) + (parseFloat(o.amount) || 0);
      });
      list.forEach(function (o) {
        if (!o.paid_at) return;
        for (var i = 0; i < last7.length; i++) {
          if (o.paid_at >= last7[i].start && o.paid_at < last7[i].end) { last7[i].amount += (parseFloat(o.amount) || 0); break; }
        }
      });
      var week7 = 0;
      last7.forEach(function (d) { week7 += d.amount; });
      var todayAmount = last7.length ? last7[last7.length - 1].amount : 0;
      var pkgKeys = Object.keys(byPkg).sort(function (a, b) { return byPkg[b] - byPkg[a]; });
      var maxDay = 1;
      last7.forEach(function (d) { if (d.amount > maxDay) maxDay = d.amount; });

      var html = DS.statGrid([
        { icon: '📈', label: '累计总收入', value: money(total), sub: '已支付 ' + list.length + ' 笔', subType: 'ok', color: 'var(--success)' },
        { icon: '💰', label: '今日收入', value: money(todayAmount), sub: '今天', subType: 'info', color: 'var(--accent)' },
        { icon: '🗓', label: '最近 7 天收入', value: money(week7), sub: '含今日', subType: 'info', color: '#8b5cf6' },
        { icon: '📦', label: '套餐种类', value: String(pkgKeys.length), sub: '有收入的套餐', subType: 'warn', color: 'var(--warn)' }
      ]);

      html += DS.card(pkgKeys.length ? pkgKeys.map(function (k) {
        var pct = total > 0 ? Math.round(byPkg[k] * 100 / total) : 0;
        return barRow(DS.esc(pkgName(k)), money(byPkg[k]) + ' <span class="muted tiny">(' + pct + '%)</span>', pct);
      }).join('') : DS.empty('暂无已支付订单', '📦'), { title: '按套餐聚合' });

      html += DS.card(last7.map(function (d) {
        return barRow(DS.esc(d.label), d.amount > 0 ? money(d.amount) : '<span class="muted">-</span>',
          Math.round(d.amount * 100 / maxDay));
      }).join(''), { title: '最近 7 日趋势' });

      var recent = list.slice(0, 20);
      html += DS.card(DS.list(recent.length ? recent.map(function (o) {
        return DS.li({
          ic: '💳',
          title: o.order_no || o.id || '-',
          sub: pkgName(o.package_type) + ' · ' + DS.fmtTime(o.paid_at || o.created_at),
          right: money(o.amount),
          rawRight: true,
          onClick: { name: 'scan:orderDetail', payload: { id: o.id } }
        });
      }) : [DS.li({ title: '暂无已支付订单', ic: '💳' })]), { title: '最近支付订单', right: '<span class="tiny muted">前 20 条</span>', tight: true });

      el.innerHTML = html;
    });
  }

  /* ======================================================================
     9. 页面：用户管理
     ====================================================================== */

  function userLi(u) {
    return DS.li({
      ic: '👤',
      title: u.nickname || u.username || u.email || '未命名',
      sub: (u.email || u.phone || '无联系方式') + ' · ' +
        (u.machine_code ? '机器 ' + short(u.machine_code, 10) : '未绑定设备') + ' · ' +
        (u.last_login ? DS.fmtAgo(u.last_login) : '从未登录'),
      badge: statusChip(u.status, 'user'),
      onClick: { name: 'scan:userDetail', payload: { id: u.id } }
    });
  }

  function renderUsers(el) {
    el.innerHTML = DS.loading('加载用户…');
    var key = 'scan.users';
    var st = DS.pager(key);
    var offset = st.page * st.size;
    var kw = orKw(st.search);
    var opts = {
      select: '*', order: 'created_at', ascending: false,
      rangeFrom: offset, rangeTo: offset + st.size - 1
    };
    if (kw) opts.orFilter = ilikeOr(['username', 'nickname', 'email', 'phone', 'machine_code'], kw);

    DS.api(CONN, 'users', opts).then(function (res) {
      if (res.error) { el.innerHTML = errBoxOf(res); return; }
      var rows = res.data || [];
      var total = DS.totalOf(res);
      var html = toolbar(key, '搜索用户名/昵称/邮箱/手机/机器码', st.search, [
        { text: '➕ 新增用户', cls: 'btn-primary', onClick: { name: 'scan:userAdd' } },
        { text: '🛠 修复数据', cls: 'btn-outline', onClick: { name: 'scan:toolFixUsers' } }
      ]);
      html += DS.card(rows.length ? DS.list(rows.map(userLi)) : DS.empty(kw ? '没有匹配的用户' : '暂无用户', '👤'), { tight: true });
      html += DS.pagerHtml(key, total, st.size);
      el.innerHTML = html;
    });
  }

  function openUserForm(u) {
    var isNew = !u;
    formSheet({
      title: isNew ? '新增用户' : '编辑用户',
      okText: isNew ? '创建' : '保存',
      html:
        (isNew
          ? DS.input({ name: 'username', label: '用户名', required: true, placeholder: '登录账号' }) +
          DS.password({ name: 'password', label: '密码', required: true, placeholder: '登录密码' })
          : DS.input({ name: 'nickname', label: '昵称', value: u.nickname || '' })) +
        (isNew ? DS.input({ name: 'nickname', label: '昵称', placeholder: '显示名称（可选）' }) : '') +
        DS.input({ name: 'email', label: '邮箱', type: 'email', value: isNew ? '' : (u.email || ''), placeholder: 'email@example.com' }) +
        DS.input({ name: 'phone', label: '手机号', value: isNew ? '' : (u.phone || ''), placeholder: '手机号（可选）' }) +
        (isNew ? '' : DS.input({ name: 'machine_code', label: '机器码', value: u.machine_code || '', mono: true, placeholder: '清空则解绑设备' })) +
        (isNew ? '' : DS.select({ name: 'status', label: '状态', value: u.status || 'active', options: [
          { value: 'active', label: '激活' }, { value: 'disabled', label: '停用' },
          { value: 'pending', label: '待验证' }, { value: 'banned', label: '封禁' }
        ] })) +
        (isNew ? PWD_TIP : ''),
      onSubmit: function (body) {
        var d = DS.formData(body);
        var email = String(d.email || '').trim();
        var phone = String(d.phone || '').trim();
        if (isNew) {
          var username = String(d.username || '').trim();
          var pwd = String(d.password || '');
          if (!username) { DS.toast('请填写用户名', 'err'); return false; }
          if (!pwd) { DS.toast('请填写密码', 'err'); return false; }
          return sha256(pwd + PWD_SALT).then(function (hash) {
            var data = {
              username: username, password_hash: hash,
              nickname: String(d.nickname || '').trim() || username,
              status: 'active', trial_used: false, created_at: nowISO()
            };
            if (email) data.email = email;
            if (phone) data.phone = phone;
            return DS.api(CONN, 'users', { method: 'POST', data: data }).then(function (res) {
              if (res.error) { DS.toast('创建失败：' + res.error.message, 'err'); return false; }
              var newId = (res.data && res.data[0] && res.data[0].id) || null;
              logAdmin('create', 'users', newId, '创建用户 ' + username, { username: username });
              DS.toast('用户 ' + username + ' 创建成功', 'ok');
              DS.refresh();
            });
          });
        }
        var patch = {
          nickname: String(d.nickname || '').trim() || null,
          email: email || null,
          phone: phone || null,
          machine_code: String(d.machine_code || '').trim() || null,
          status: d.status
        };
        return safePatch('users', u.id, patch).then(function (res) {
          if (res.error) { DS.toast('保存失败：' + res.error.message, 'err'); return false; }
          logAdmin('update', 'users', u.id, '编辑用户 ' + (u.username || u.id), patch);
          DS.toast('用户信息已更新', 'ok');
          DS.refresh();
        });
      }
    });
  }

  function deleteUser(id, name) {
    DS.confirm({
      title: '删除用户',
      html: '确认彻底删除用户【<strong>' + DS.esc(name || id) + '</strong>】？<br><br>' +
        '将同时删除：<br>· Supabase 登录账号（Auth）<br>· users 表记录<br>· 该用户的全部授权<br>· 登录 / 授权日志<br><br>' +
        '<span style="color:var(--danger)">删除后该邮箱可重新注册。此操作不可恢复！</span>',
      okText: '彻底删除',
      danger: true
    }).then(function (ok) {
      if (!ok) return;
      var conn = DS.conn(CONN);
      var email = '';
      DS.api(CONN, 'users', { select: 'email', filters: { id: id }, limit: 1 }).then(function (uq) {
        if (!uq.error && uq.data && uq.data[0]) email = uq.data[0].email || '';
        return null;
      }).catch(function () { return null; }).then(function () {
        // 1) 删除 Supabase Auth 账号（需要 service_role key）
        var authOk = false;
        var authUrl = conn.url + '/auth/v1/admin/users/' + enc(id);
        return fetch(authUrl, {
          method: 'DELETE',
          headers: { apikey: conn.key, Authorization: 'Bearer ' + conn.key }
        }).then(function (r) { authOk = r.ok; return authOk; }, function () { return false; })
          .then(function () {
            // 2) 删除该用户的授权
            return DS.api(CONN, 'licenses', { method: 'DELETE', filters: { user_id: id } });
          })
          .then(function () {
            // 3) 删除日志
            return DS.api(CONN, 'login_logs', { method: 'DELETE', filters: { user_id: id } });
          })
          .then(function () {
            return DS.api(CONN, 'verify_logs', { method: 'DELETE', filters: { user_id: id } });
          })
          .then(function () {
            // 4) 删除 users 记录
            return DS.api(CONN, 'users', { method: 'DELETE', filters: { id: id } });
          })
          .then(function (res) {
            if (res.error) { DS.toast('删除失败：' + res.error.message, 'err'); return; }
            logAdmin('delete', 'users', id, '彻底删除用户 ' + (name || id) + (email ? ' (' + email + ')' : ''), { auth_deleted: authOk });
            DS.toast(authOk ? '用户已彻底删除' : '用户已删除，但 Auth 账号删除失败（需 service_role 连接）', authOk ? 'ok' : 'warn');
            DS.closeAllOverlays();
            DS.refresh();
          });
      });
    });
  }

  /* ======================================================================
     10. 页面：授权管理
     ====================================================================== */

  function licenseLi(l) {
    return DS.li({
      ic: '🔑',
      title: l.license_key || '-',
      sub: userName(l) + ' · ' + pkgName(l.package_type) + ' · ' +
        (machineCodes(l).length ? '绑定 ' + machineCodes(l).length + ' 台' : '未绑定设备'),
      badge: statusChip(l.status, 'license'),
      right: remainHtml(l),
      rawRight: true,
      onClick: { name: 'scan:licenseDetail', payload: { id: l.id } }
    });
  }

  /** 授权搜索：等价桌面版 renderScanGenericTable 的 licenses 分支 */
  function licenseFilter(kw) {
    return DS.api(CONN, 'users', {
      select: 'id',
      orFilter: ilikeOr(['nickname', 'email', 'username'], kw),
      limit: 200
    }).then(function (uRes) {
      var ids = ((uRes && !uRes.error && uRes.data) || []).map(function (u) { return u.id; });
      var conds = [ilikeCond('license_key', kw)];
      if (ids.length) conds.push('user_id.in.("' + ids.join('","') + '")');
      return conds.join(',');
    });
  }

  function renderLicenses(el) {
    el.innerHTML = DS.loading('加载授权…');
    var key = 'scan.licenses';
    var st = DS.pager(key);
    var offset = st.page * st.size;
    var kw = orKw(st.search);
    var base = {
      select: '*', order: 'created_at', ascending: false,
      rangeFrom: offset, rangeTo: offset + st.size - 1
    };
    var prepare = kw ? licenseFilter(kw) : Promise.resolve(null);

    prepare.then(function (orFilter) {
      if (orFilter) base.orFilter = orFilter;
      return DS.api(CONN, 'licenses', base);
    }).then(function (res) {
      if (res.error) { el.innerHTML = errBoxOf(res); return; }
      var rows = res.data || [];
      var total = DS.totalOf(res);
      return joinUsers(rows).then(function (list) {
        var html = toolbar(key, '搜索授权码 / 用户昵称 / 邮箱', st.search, [
          { text: '➕ 创建授权', cls: 'btn-primary', onClick: { name: 'scan:licenseAdd' } }
        ]);
        html += DS.card(list.length ? DS.list(list.map(licenseLi)) : DS.empty(kw ? '没有匹配的授权' : '暂无授权', '🔑'), { tight: true });
        html += DS.pagerHtml(key, total, st.size);
        el.innerHTML = html;
      });
    });
  }

  function openLicenseForm(l, presetUserId) {
    var isNew = !l;
    var expireVal = (l && l.expire_time) ? String(l.expire_time).substring(0, 16) : '';
    var pkgOpts = PKG_TYPES.map(function (pt) { return { value: pt, label: PKG_NAMES[pt] }; });
    formSheet({
      title: isNew ? '创建授权' : '编辑授权',
      okText: isNew ? '创建' : '保存',
      html:
        (isNew
          ? DS.input({ name: 'user_id', label: '用户 ID', required: true, value: presetUserId || '', mono: true, placeholder: 'users 表的 id' })
          : DS.input({ name: 'license_key', label: '授权码', value: l.license_key || '', mono: true }) +
            DS.select({ name: 'status', label: '状态', value: l.status || 'active', options: [
              { value: 'active', label: '有效' }, { value: 'expired', label: '过期' }, { value: 'revoked', label: '撤销' },
              { value: 'suspended', label: '暂停' }, { value: 'pending', label: '待开通' }
            ] })) +
        DS.select({ name: 'package_type', label: '套餐', value: isNew ? 'month' : (l.package_type || 'month'), options: pkgOpts }) +
        (isNew ? '' : DS.input({ name: 'expire_time', label: '到期时间', inputType: 'datetime-local', value: expireVal, help: '留空表示永久' })) +
        DS.number({ name: 'max_bindings', label: '最大绑定数', value: isNew ? 2 : DS.numOr(l.max_bindings, 2), min: 0, step: '1' }) +
        DS.number({ name: 'offline_count', label: '离线次数', value: isNew ? 5 : DS.numOr(l.offline_count, 5), min: 0, step: '1' }) +
        (isNew ? '' : DS.input({ name: 'machine_code', label: '机器码', value: l.machine_code || '', mono: true, placeholder: '清空则解绑' })) +
        DS.textarea({ name: 'note', label: '备注', value: isNew ? '' : (l.note || ''), rows: 3, placeholder: '可选' }) +
        (isNew ? '<div class="help">授权码自动生成（CAD-M-XXXXXXXXXXXX 格式），到期时间按套餐天数计算。</div>' : ''),
      onSubmit: function (body) {
        var d = DS.formData(body);
        if (isNew) {
          var userId = String(d.user_id || '').trim();
          if (!userId) { DS.toast('请填写用户 ID', 'err'); return false; }
          var packageType = d.package_type || 'month';
          var now = new Date();
          var days = PKG_DEFAULTS[packageType] ? PKG_DEFAULTS[packageType].days : 30;
          var expireTime = packageType === 'permanent' ? null : new Date(now.getTime() + days * 86400000).toISOString();
          var licenseKey = genLicenseKey(packageType);
          var data = {
            user_id: userId, license_key: licenseKey, package_type: packageType,
            status: 'active', start_time: now.toISOString(), expire_time: expireTime,
            machine_code: null, bind_count: 0,
            max_bindings: DS.numOr(d.max_bindings, 2), offline_count: DS.numOr(d.offline_count, 5),
            total_offline_count: 0, note: String(d.note || '').trim() || '手机端手动创建'
          };
          return DS.api(CONN, 'licenses', { method: 'POST', data: data }).then(function (res) {
            if (res.error) { DS.toast('创建失败：' + res.error.message, 'err'); return false; }
            var newId = (res.data && res.data[0] && res.data[0].id) || null;
            logAdmin('create', 'licenses', newId, '创建授权 ' + licenseKey, { package_type: packageType, user_id: userId });
            DS.toast('授权创建成功：' + licenseKey, 'ok');
            DS.refresh();
          });
        }
        var patch = {
          license_key: String(d.license_key || '').trim() || null,
          status: d.status,
          package_type: d.package_type,
          expire_time: d.expire_time ? new Date(d.expire_time).toISOString() : null,
          max_bindings: DS.numOr(d.max_bindings, 0),
          offline_count: DS.numOr(d.offline_count, 0),
          machine_code: String(d.machine_code || '').trim() || null,
          note: String(d.note || '').trim() || null
        };
        return safePatch('licenses', l.id, patch).then(function (res) {
          if (res.error) { DS.toast('保存失败：' + res.error.message, 'err'); return false; }
          logAdmin('update', 'licenses', l.id, '编辑授权 ' + (l.license_key || l.id), patch);
          DS.toast('授权信息已更新', 'ok');
          DS.refresh();
        });
      }
    });
  }

  function doExtendLicense(id, days, oldExpire) {
    var now = new Date();
    var base = oldExpire ? DS.toDate(oldExpire) : null;
    if (!base || base.getTime() < now.getTime()) base = now;
    var newExpire = new Date(base.getTime() + days * 86400000).toISOString();
    return safePatch('licenses', id, { expire_time: newExpire, status: 'active' }).then(function (res) {
      if (res.error) { DS.toast('延期失败：' + res.error.message, 'err'); return; }
      logAdmin('extend_license', 'licenses', id, '授权延期 +' + days + ' 天', { expire_time: newExpire });
      DS.toast('授权已延期 +' + days + ' 天（至 ' + DS.fmtDate(newExpire) + '）', 'ok');
      DS.closeAllOverlays();
      DS.refresh();
    });
  }

  function openExtendSheet(id) {
    DS.api(CONN, 'licenses', { select: '*', filters: { id: id }, limit: 1 }).then(function (res) {
      if (res.error) { DS.toast('读取授权失败：' + res.error.message, 'err'); return; }
      var l = (res.data || [])[0];
      if (!l) { DS.toast('未找到授权', 'err'); return; }
      if (l.package_type === 'permanent') { DS.toast('永久授权无需延期', 'info'); return; }
      var quick = [7, 15, 30, 90].map(function (d) {
        return '<button class="btn btn-outline btn-sm"' + DS.act('scan:extDays', { days: d }) + '>+' + d + '天</button>';
      }).join('');
      formSheet({
        title: '授权延期',
        okText: '确认延期',
        html:
          kvList([
            ['授权码', { v: l.license_key || '-', mono: true }],
            ['当前到期', l.expire_time ? DS.fmtTime(l.expire_time) : '无']
          ]) +
          '<div class="tiny muted" style="margin:10px 0 6px">快捷天数（点一下填入下面的输入框）</div>' +
          '<div class="btn-row">' + quick + '</div>' + gap(10) +
          DS.number({ name: 'days', label: '延期天数', value: '', min: 1, step: '1', placeholder: '输入要增加的天数' }),
        onSubmit: function (body) {
          var d = DS.formData(body);
          var days = parseInt(d.days, 10);
          if (!days || days <= 0) { DS.toast('请输入有效天数', 'err'); return false; }
          return DS.confirm({
            title: '确认延期',
            msg: '确认为该授权延期 +' + days + ' 天？',
            okText: '确认延期'
          }).then(function (ok) {
            if (!ok) return false;
            return doExtendLicense(id, days, l.expire_time);
          });
        }
      });
    });
  }

  function deleteLicense(id, key) {
    DS.confirm({
      title: '删除授权',
      msg: '确认删除授权【' + (key || id) + '】？此操作不可恢复。',
      okText: '确认删除',
      danger: true
    }).then(function (ok) {
      if (!ok) return;
      DS.api(CONN, 'licenses', { method: 'DELETE', filters: { id: id } }).then(function (res) {
        if (res.error) { DS.toast('删除失败：' + res.error.message, 'err'); return; }
        logAdmin('delete', 'licenses', id, '删除授权 ' + (key || id), {});
        DS.toast('授权已删除', 'ok');
        DS.closeAllOverlays();
        DS.refresh();
      });
    });
  }

  /* ======================================================================
     11. 页面：订单管理
     ====================================================================== */

  function orderLi(o) {
    return DS.li({
      ic: '🧾',
      title: o.order_no || o.id || '-',
      sub: pkgName(o.package_type) + ' · ' + (o.user_id ? '用户 ' + short(o.user_id, 8) : '无用户') + ' · ' + DS.fmtTime(o.created_at),
      right: money(o.amount),
      rawRight: true,
      badge: statusChip(o.status, 'order'),
      onClick: { name: 'scan:orderDetail', payload: { id: o.id } }
    });
  }

  function renderOrders(el) {
    el.innerHTML = DS.loading('加载订单…');
    var key = 'scan.orders';
    var st = DS.pager(key);
    var offset = st.page * st.size;
    var kw = orKw(st.search);
    var opts = {
      select: '*', order: 'created_at', ascending: false,
      rangeFrom: offset, rangeTo: offset + st.size - 1
    };
    if (kw) opts.orFilter = ilikeOr(['order_no', 'package_type', 'payment_method', 'status'], kw);

    DS.api(CONN, 'orders', opts).then(function (res) {
      if (res.error) { el.innerHTML = errBoxOf(res); return; }
      var rows = res.data || [];
      var total = DS.totalOf(res);
      var html = toolbar(key, '搜索订单号 / 套餐 / 状态', st.search, [
        { text: '➕ 创建订单', cls: 'btn-primary', onClick: { name: 'scan:orderAdd' } }
      ]);
      html += DS.card(rows.length ? DS.list(rows.map(orderLi)) : DS.empty(kw ? '没有匹配的订单' : '暂无订单', '🧾'), { tight: true });
      html += DS.pagerHtml(key, total, st.size);
      el.innerHTML = html;
    });
  }

  var PAY_OPTS = [
    { value: '', label: '未支付' }, { value: 'manual', label: '手动支付' },
    { value: 'wechat', label: '微信' }, { value: 'alipay', label: '支付宝' }
  ];

  /** 等价桌面版 scanShowAddOrderModal：已支付时联动开通授权 */
  function openOrderForm() {
    formSheet({
      title: '创建订单',
      okText: '创建',
      html:
        DS.input({ name: 'user_id', label: '用户 ID', required: true, mono: true, placeholder: 'users 表的 id' }) +
        DS.select({ name: 'package_type', label: '套餐', value: 'month', options: PKG_TYPES.map(function (pt) { return { value: pt, label: PKG_NAMES[pt] }; }) }) +
        DS.number({ name: 'amount', label: '金额', value: 19, min: 0, step: '0.01' }) +
        DS.select({ name: 'payment_method', label: '支付方式', value: '', options: PAY_OPTS }) +
        '<div class="help">选择支付方式后订单状态为「已支付」，并会联动为该用户开通授权。</div>',
      onSubmit: function (body) {
        var d = DS.formData(body);
        var userId = String(d.user_id || '').trim();
        if (!userId) { DS.toast('请填写用户 ID', 'err'); return false; }
        var payMethod = d.payment_method || '';
        var now = new Date();
        var orderNo = 'CAD' + Date.now() + Math.floor(Math.random() * 1000);
        var data = {
          order_no: orderNo, user_id: userId, package_type: d.package_type,
          amount: DS.numOr(d.amount, 0), status: payMethod ? 'paid' : 'pending',
          created_at: now.toISOString()
        };
        if (payMethod) { data.payment_method = payMethod; data.paid_at = now.toISOString(); }
        return DS.api(CONN, 'orders', { method: 'POST', data: data }).then(function (res) {
          if (res.error) { DS.toast('创建失败：' + res.error.message, 'err'); return false; }
          var newId = (res.data && res.data[0] && res.data[0].id) || null;
          logAdmin('create', 'orders', newId, '创建订单 ' + orderNo, data);
          DS.toast('订单创建成功' + (payMethod ? '，正在联动开通授权…' : ''), 'ok');
          DS.refresh();
          if (payMethod) {
            setTimeout(function () { activateUser(userId, short(userId, 8), d.package_type, true); }, 60);
          }
        });
      }
    });
  }

  function openOrderEdit(id) {
    DS.api(CONN, 'orders', { select: '*', filters: { id: id }, limit: 1 }).then(function (res) {
      if (res.error) { DS.toast('读取订单失败：' + res.error.message, 'err'); return; }
      var o = (res.data || [])[0];
      if (!o) { DS.toast('未找到订单', 'err'); return; }
      formSheet({
        title: '编辑订单',
        okText: '保存',
        html:
          kvList([['订单号', { v: o.order_no || o.id, mono: true }]]) + gap(10) +
          DS.select({ name: 'status', label: '状态', value: o.status || 'pending', options: [
            { value: 'pending', label: '待支付' }, { value: 'paid', label: '已支付' },
            { value: 'cancelled', label: '已取消' }, { value: 'refunded', label: '已退款' }
          ] }) +
          DS.number({ name: 'amount', label: '金额', value: DS.numOr(o.amount, 0), min: 0, step: '0.01' }) +
          DS.select({ name: 'payment_method', label: '支付方式', value: o.payment_method || '', options: PAY_OPTS }),
        onSubmit: function (body) {
          var d = DS.formData(body);
          var wasPaid = o.status === 'paid';
          var willPaid = d.status === 'paid';
          var patch = {
            status: d.status,
            amount: DS.numOr(d.amount, 0),
            payment_method: d.payment_method || null
          };
          if (willPaid && !wasPaid) patch.paid_at = nowISO();
          return safePatch('orders', id, patch).then(function (res) {
            if (res.error) { DS.toast('保存失败：' + res.error.message, 'err'); return false; }
            logAdmin('update', 'orders', id, '编辑订单 ' + (o.order_no || id), patch);
            DS.toast('订单已更新', 'ok');
            DS.refresh();
            if (willPaid && !wasPaid && o.user_id) {
              setTimeout(function () { activateUser(o.user_id, short(o.user_id, 8), o.package_type, true); }, 60);
            }
          });
        }
      });
    });
  }

  /* ======================================================================
     12. 开通授权（等价桌面版 scanQuickActivate）
     ====================================================================== */

  function pkgInfoOf(pt) {
    var info = packagesCache[pt] || PKG_DEFAULTS[pt] || PKG_DEFAULTS.month;
    var dft = PKG_DEFAULTS[pt] || PKG_DEFAULTS.month;
    var days = parseInt(info.duration_days !== undefined ? info.duration_days : info.days, 10);
    if (isNaN(days)) days = dft.days;
    var offline = parseInt(info.offline_count !== undefined ? info.offline_count : dft.offline_count, 10);
    if (isNaN(offline)) offline = dft.offline_count;
    return {
      pt: pt,
      name: info.name || PKG_NAMES[pt] || pt,
      price: DS.numOr(info.price !== undefined ? info.price : dft.price, dft.price),
      days: days,
      offline: offline
    };
  }

  function maybeCreateOrder(userId, packageType, price, when) {
    if (!(price > 0)) return;
    var orderNo = 'CAD' + Date.now() + Math.floor(Math.random() * 1000);
    DS.api(CONN, 'orders', {
      method: 'POST',
      data: {
        order_no: orderNo, user_id: userId, package_type: packageType,
        amount: price, status: 'paid', payment_method: 'manual',
        paid_at: (when || new Date()).toISOString()
      }
    }).then(function (res) {
      if (res.error) DS.toast('订单写入失败：' + res.error.message, 'err');
    });
  }

  /** 打开套餐选择器 */
  function openActivatePicker(userId, displayName) {
    var items = [];
    PKG_TYPES.forEach(function (pt) {
      var info = pkgInfoOf(pt);
      items.push(DS.li({
        ic: '📦',
        title: info.name,
        sub: money(info.price) + ' · ' + (pt === 'permanent' ? '永久' : info.days + '天') + ' · 离线 ' + info.offline + ' 次',
        onClick: { name: 'scan:userActivatePkg', payload: { uid: userId, name: displayName, pkg: pt } }
      }));
    });
    DS.sheet({
      title: '选择开通套餐',
      html: '<div class="tiny muted" style="margin-bottom:8px">为用户【' + DS.esc(displayName) + '】选择要开通的套餐</div>' +
        DS.card(DS.list(items), { tight: true }),
      buttons: [{ text: '取消', cls: 'btn-outline' }]
    });
  }

  /** 真正执行开通 / 续期 */
  function activateUser(userId, displayName, packageType, skipConfirm) {
    if (!userId) { DS.toast('缺少用户 ID', 'err'); return; }
    displayName = displayName || '用户';
    packageType = packageType || '';
    if (!packageType) { openActivatePicker(userId, displayName); return; }
    var info = pkgInfoOf(packageType);

    function run() {
      DS.api(CONN, 'licenses', {
        select: '*', filters: { user_id: userId }, order: 'created_at', ascending: false, limit: 1
      }).then(function (res) {
        if (res.error) { DS.toast('读取授权失败：' + res.error.message, 'err'); return; }
        var exist = (res.data || [])[0] || null;
        var now = new Date();
        var startTime = now.toISOString();
        var expireTime = null;
        if (packageType !== 'permanent') {
          var base = now;
          if (exist && exist.status === 'active' && exist.expire_time) {
            var old = DS.toDate(exist.expire_time);
            if (old && old.getTime() > now.getTime()) base = old; // 未过期则顺延
          }
          expireTime = new Date(base.getTime() + info.days * 86400000).toISOString();
        }
        if (exist && exist.id) {
          var patch = {
            status: 'active', start_time: startTime, expire_time: expireTime,
            package_type: packageType, offline_count: info.offline,
            total_offline_count: DS.numOr(exist.total_offline_count, 0),
            note: (exist.note || '') + ' [' + DS.fmtTime(startTime) + ' 手机端续期]'
          };
          safePatch('licenses', exist.id, patch).then(function (upd) {
            if (upd.error) { DS.toast('更新授权失败：' + upd.error.message, 'err'); return; }
            logAdmin('activate_license', 'licenses', exist.id, '为用户 ' + displayName + ' 续期 ' + info.name,
              { package_type: packageType, price: info.price, days: info.days });
            maybeCreateOrder(userId, packageType, info.price, now);
            DS.toast('已为 ' + displayName + ' 续期 ' + info.name, 'ok');
            DS.closeAllOverlays();
            DS.refresh();
          });
        } else {
          var licenseKey = genLicenseKey(packageType);
          DS.api(CONN, 'licenses', {
            method: 'POST',
            data: {
              user_id: userId, license_key: licenseKey, package_type: packageType,
              status: 'active', start_time: startTime, expire_time: expireTime,
              machine_code: null, bind_count: 0, max_bindings: 2,
              offline_count: info.offline, total_offline_count: 0, note: '手机端手动开通'
            }
          }).then(function (ins) {
            if (ins.error) { DS.toast('创建授权失败：' + ins.error.message, 'err'); return; }
            var newId = (ins.data && ins.data[0] && ins.data[0].id) || null;
            logAdmin('activate_license', 'licenses', newId,
              '为用户 ' + displayName + ' 开通 ' + info.name + ' 授权码 ' + licenseKey,
              { package_type: packageType, price: info.price, days: info.days, license_key: licenseKey });
            maybeCreateOrder(userId, packageType, info.price, now);
            DS.toast('已为 ' + displayName + ' 开通 ' + info.name + '：' + licenseKey, 'ok');
            DS.closeAllOverlays();
            DS.refresh();
          });
        }
      });
    }

    if (skipConfirm) { run(); return; }
    DS.confirm({
      title: '开通授权',
      msg: '为用户【' + displayName + '】开通 ' + info.name + '（' + money(info.price) + ' / ' +
        (packageType === 'permanent' ? '永久' : info.days + '天') + '）？',
      okText: '确认开通'
    }).then(function (ok) { if (ok) run(); });
  }

  /* ======================================================================
     13. 页面：套餐管理
     ====================================================================== */

  function packageLi(p) {
    var active = p.is_active !== false;
    return DS.li({
      ic: '📦',
      title: p.name || pkgName(p.package_type || p.type),
      sub: pkgName(p.package_type || p.type) + ' · ' + money(p.price) + ' · ' + daysText(p) +
        ' · 离线 ' + (p.offline_count !== undefined ? p.offline_count : '-') + ' 次',
      badge: DS.dot(active ? '上架' : '下架', active ? 'ok' : 'muted'),
      onClick: { name: 'scan:pkgDetail', payload: { id: p.id } }
    });
  }

  function renderPackages(el) {
    el.innerHTML = DS.loading('加载套餐…');
    var key = 'scan.packages';
    var st = DS.pager(key);
    var offset = st.page * st.size;
    var kw = orKw(st.search);
    var opts = {
      select: '*', order: 'sort_order', ascending: true,
      rangeFrom: offset, rangeTo: offset + st.size - 1
    };
    if (kw) opts.orFilter = ilikeOr(['name', 'package_type', 'description'], kw);

    loadPackagesCache();
    DS.api(CONN, 'packages', opts).then(function (res) {
      if (res.error) { el.innerHTML = errBoxOf(res); return; }
      var rows = res.data || [];
      var total = DS.totalOf(res);
      var html = toolbar(key, '搜索套餐名 / 类型', st.search, [
        { text: '➕ 新增套餐', cls: 'btn-primary', onClick: { name: 'scan:pkgAdd' } }
      ]);
      html += DS.card(rows.length ? DS.list(rows.map(packageLi)) : DS.empty(kw ? '没有匹配的套餐' : '暂无套餐', '📦'), { tight: true });
      html += DS.pagerHtml(key, total, st.size);
      el.innerHTML = html;
    });
  }

  function openPackageForm(p) {
    var isNew = !p;
    formSheet({
      title: isNew ? '新增套餐' : '编辑套餐',
      okText: isNew ? '创建' : '保存',
      html:
        DS.input({ name: 'name', label: '套餐名', required: true, value: isNew ? '' : (p.name || ''), placeholder: '如：月卡' }) +
        DS.select({ name: 'package_type', label: '套餐类型', value: isNew ? 'month' : (p.package_type || p.type || 'month'), options: PKG_TYPES.map(function (pt) { return { value: pt, label: PKG_NAMES[pt] }; }) }) +
        DS.textarea({ name: 'description', label: '描述', value: isNew ? '' : (p.description || ''), rows: 3 }) +
        DS.number({ name: 'price', label: '价格', value: isNew ? 0 : DS.numOr(p.price, 0), min: 0, step: '0.01' }) +
        DS.number({ name: 'original_price', label: '原价', value: isNew ? 0 : DS.numOr(p.original_price, 0), min: 0, step: '0.01' }) +
        DS.number({ name: 'duration_days', label: '有效天数', value: isNew ? 30 : DS.numOr(p.duration_days !== undefined ? p.duration_days : p.days, 30), min: 0, step: '1', help: '永久卡填 0' }) +
        DS.number({ name: 'offline_count', label: '离线次数', value: isNew ? 5 : DS.numOr(p.offline_count, 5), min: 0, step: '1' }) +
        DS.number({ name: 'max_bindings', label: '最大绑定数', value: isNew ? 2 : DS.numOr(p.max_bindings, 2), min: 0, step: '1' }) +
        DS.number({ name: 'sort_order', label: '排序', value: isNew ? 0 : DS.numOr(p.sort_order, 0), step: '1' }) +
        (isNew ? '' : DS.select({ name: 'is_active', label: '上架状态', value: p.is_active === false ? 'false' : 'true', options: [
          { value: 'true', label: '上架' }, { value: 'false', label: '下架' }
        ] })),
      onSubmit: function (body) {
        var d = DS.formData(body);
        var name = String(d.name || '').trim();
        if (!name) { DS.toast('请填写套餐名', 'err'); return false; }
        var data = {
          name: name, package_type: d.package_type,
          description: String(d.description || '').trim() || null,
          price: DS.numOr(d.price, 0), original_price: DS.numOr(d.original_price, 0),
          duration_days: DS.numOr(d.duration_days, 0), offline_count: DS.numOr(d.offline_count, 0),
          max_bindings: DS.numOr(d.max_bindings, 2), sort_order: DS.numOr(d.sort_order, 0)
        };
        if (isNew) {
          data.is_active = true;
          data.created_at = nowISO();
          return DS.api(CONN, 'packages', { method: 'POST', data: data }).then(function (res) {
            if (res.error) { DS.toast('创建失败：' + res.error.message, 'err'); return false; }
            var newId = (res.data && res.data[0] && res.data[0].id) || null;
            logAdmin('create', 'packages', newId, '创建套餐 ' + name, data);
            DS.toast('套餐 ' + name + ' 创建成功', 'ok');
            return loadPackagesCache(true).then(function () { DS.refresh(); });
          });
        }
        data.is_active = d.is_active === 'true';
        return safePatch('packages', p.id, data).then(function (res) {
          if (res.error) { DS.toast('保存失败：' + res.error.message, 'err'); return false; }
          logAdmin('update', 'packages', p.id, '编辑套餐 ' + (p.name || p.id), data);
          DS.toast('套餐已更新', 'ok');
          return loadPackagesCache(true).then(function () { DS.refresh(); });
        });
      }
    });
  }

  function togglePackage(id, active, name) {
    DS.confirm({
      title: active ? '上架套餐' : '下架套餐',
      msg: '确认' + (active ? '上架' : '下架') + '套餐【' + (name || id) + '】？',
      okText: active ? '确认上架' : '确认下架'
    }).then(function (ok) {
      if (!ok) return;
      safePatch('packages', id, { is_active: !!active }).then(function (res) {
        if (res.error) { DS.toast('操作失败：' + res.error.message, 'err'); return; }
        logAdmin('toggle_active', 'packages', id, active ? '上架套餐' : '下架套餐', { is_active: !!active });
        DS.toast(active ? '套餐已上架' : '套餐已下架', 'ok');
        DS.closeAllOverlays();
        loadPackagesCache(true).then(function () { DS.refresh(); });
      });
    });
  }

  /* ======================================================================
     14. 页面：活跃设备
     ====================================================================== */

  function renderDevices(el) {
    el.innerHTML = DS.loading('加载设备数据…');
    var key = 'scan.devices';
    var st = DS.pager(key);
    var offset = st.page * st.size;
    var kw = orKw(st.search);
    var logOpts = {
      select: '*', order: 'created_at', ascending: false,
      rangeFrom: offset, rangeTo: offset + st.size - 1
    };
    if (kw) logOpts.orFilter = ilikeOr(['username', 'ip_address', 'device_info', 'user_agent', 'admin_username'], kw);

    Promise.all([
      DS.api(CONN, 'login_logs', logOpts),
      DS.apiAll(CONN, 'licenses', { select: 'user_id,machine_code', extraFilters: ['machine_code=not.is.null'] }, 3000)
    ]).then(function (r) {
      if (r[0].error) { el.innerHTML = errBoxOf(r[0]); return; }
      var logs = r[0].data || [];
      var total = DS.totalOf(r[0]);
      var bound = r[1].error ? [] : (r[1].data || []);
      var users = {};
      bound.forEach(function (l) { if (l.user_id) users[l.user_id] = true; });
      var boundUsers = Object.keys(users).length;

      var html = DS.statGrid([
        { icon: '💻', label: '已绑定设备用户数', value: DS.fmtNum(boundUsers), sub: '有机器码的用户', subType: 'info', color: 'var(--accent)' },
        { icon: '🔑', label: '绑定设备的授权数', value: DS.fmtNum(bound.length), sub: 'machine_code 非空', subType: 'ok', color: 'var(--success)' },
        { icon: '🟢', label: '登录记录总数', value: DS.fmtNum(total), sub: 'login_logs', subType: 'warn', color: 'var(--warn)' },
        { icon: '📱', label: '本页记录', value: DS.fmtNum(logs.length), sub: '第 ' + (st.page + 1) + ' 页', subType: 'muted', color: '#0ea5e9' }
      ]);

      html += toolbar(key, '搜索用户名 / IP / 设备', st.search, [
        { text: '🔄 刷新', cls: 'btn-outline', onClick: { name: 'scan:reload' } }
      ]);

      html += DS.card(logs.length ? DS.list(logs.map(function (x) {
        var device = x.device_info || x.user_agent || '未知设备';
        return DS.li({
          ic: '🟢',
          title: x.username || x.admin_username || x.user_id || '匿名',
          sub: (x.ip_address || x.ip || '无 IP') + ' · ' + short(device, 24) + ' · ' + DS.fmtAgo(x.created_at),
          badge: x.success === false ? DS.dot('失败', 'err') : DS.dot('成功', 'ok'),
          right: DS.fmtTime(x.created_at)
        });
      })) : DS.empty(kw ? '没有匹配的登录记录' : '暂无登录记录', '💻'), { title: '登录记录', tight: true });

      html += DS.pagerHtml(key, total, st.size);
      el.innerHTML = html;
    });
  }

  /* ======================================================================
     15. 页面：黑名单
     ====================================================================== */

  function renderBlacklist(el) {
    el.innerHTML = DS.loading('加载黑名单…');
    var key = 'scan.blacklist';
    var st = DS.pager(key);
    var isEmail = blacklistTab === 'email';
    var table = isEmail ? 'banned_emails' : 'banned_machines';
    var offset = st.page * st.size;
    var kw = orKw(st.search);
    var opts = {
      select: '*', order: 'created_at', ascending: false,
      rangeFrom: offset, rangeTo: offset + st.size - 1
    };
    if (kw) {
      opts.orFilter = isEmail
        ? ilikeOr(['email_pattern', 'email', 'reason'], kw)
        : ilikeOr(['machine_code', 'reason'], kw);
    }

    DS.api(CONN, table, opts).then(function (res) {
      if (res.error) { el.innerHTML = errBoxOf(res); return; }
      var rows = res.data || [];
      var total = DS.totalOf(res);
      var html = DS.fchips([
        { v: 'email', l: '📧 邮箱黑名单' },
        { v: 'machine', l: '💻 机器码黑名单' }
      ], blacklistTab, 'scan:blTab');
      html += toolbar(key, isEmail ? '搜索邮箱 / 原因' : '搜索机器码 / 原因', st.search, [
        { text: '➕ 添加黑名单', cls: 'btn-primary', onClick: { name: 'scan:blAdd' } }
      ]);
      html += DS.card(rows.length ? DS.list(rows.map(function (r) {
        var active = r.is_active !== false;
        return DS.li({
          ic: '🚫',
          title: isEmail ? (r.email_pattern || r.email || '-') : (r.machine_code || '-'),
          sub: (r.reason || '无原因') + ' · ' + DS.fmtTime(r.created_at) +
            (r.created_by_username ? ' · ' + r.created_by_username : ''),
          badge: DS.dot(active ? '生效中' : '已禁用', active ? 'err' : 'muted'),
          onClick: { name: 'scan:blDetail', payload: { type: isEmail ? 'email' : 'machine', id: r.id } }
        });
      })) : DS.empty(kw ? '没有匹配的黑名单' : ('暂无' + (isEmail ? '邮箱' : '机器码') + '黑名单'), '🚫'), { tight: true });
      html += DS.pagerHtml(key, total, st.size);
      el.innerHTML = html;
    });
  }

  function openBlacklistForm() {
    var isEmail = blacklistTab === 'email';
    formSheet({
      title: '添加' + (isEmail ? '邮箱' : '机器码') + '黑名单',
      okText: '添加',
      html:
        DS.input({
          name: 'value', label: isEmail ? '邮箱' : '机器码', required: true,
          placeholder: isEmail ? '邮箱或通配符（如 *@spam.com）' : '设备机器码'
        }) +
        DS.input({ name: 'reason', label: '原因', placeholder: '封禁原因（可选）' }),
      onSubmit: function (body) {
        var d = DS.formData(body);
        var value = String(d.value || '').trim();
        var reason = String(d.reason || '').trim();
        if (!value) { DS.toast('请填写' + (isEmail ? '邮箱' : '机器码'), 'err'); return false; }
        var table = isEmail ? 'banned_emails' : 'banned_machines';
        var data = {
          reason: reason || null, is_active: true,
          created_by: 'admin', created_by_username: 'admin', created_at: nowISO()
        };
        if (isEmail) data.email_pattern = value; else data.machine_code = value;
        return DS.api(CONN, table, { method: 'POST', data: data }).then(function (res) {
          if (res.error) { DS.toast('添加失败：' + res.error.message, 'err'); return false; }
          var newId = (res.data && res.data[0] && res.data[0].id) || null;
          logAdmin('create', table, newId, '添加' + (isEmail ? '邮箱' : '机器码') + '黑名单 ' + value, data);
          DS.toast('黑名单已添加', 'ok');
          DS.refresh();
        });
      }
    });
  }

  function removeBlacklist(type, id) {
    var table = type === 'email' ? 'banned_emails' : 'banned_machines';
    DS.confirm({
      title: '移除黑名单',
      msg: '确认将该黑名单记录设为禁用（is_active = false）？',
      okText: '确认移除',
      danger: true
    }).then(function (ok) {
      if (!ok) return;
      safePatch(table, id, { is_active: false }).then(function (res) {
        if (res.error) { DS.toast('操作失败：' + res.error.message, 'err'); return; }
        logAdmin('remove', table, id, '禁用黑名单记录', {});
        DS.toast('黑名单已移除', 'ok');
        DS.closeAllOverlays();
        DS.refresh();
      });
    });
  }

  /* ======================================================================
     16. 页面：回收站
     ====================================================================== */

  function renderRecycleBin(el) {
    el.innerHTML = DS.loading('加载回收站…');
    var key = 'scan.recycle';
    var st = DS.pager(key);
    var isUser = recycleTab === 'user';
    var table = isUser ? 'deleted_users' : 'deleted_licenses';
    var offset = st.page * st.size;
    var kw = orKw(st.search);
    var opts = {
      select: '*', order: 'deleted_at', ascending: false,
      rangeFrom: offset, rangeTo: offset + st.size - 1
    };
    if (kw) opts.orFilter = ilikeOr(['deleted_by'], kw);

    DS.api(CONN, table, opts).then(function (res) {
      if (res.error) { el.innerHTML = errBoxOf(res); return; }
      var rows = res.data || [];
      var total = DS.totalOf(res);
      var html = DS.fchips([
        { v: 'user', l: '👥 用户回收站' },
        { v: 'license', l: '🔑 授权回收站' }
      ], recycleTab, 'scan:rcTab');
      html += toolbar(key, '搜索删除人', st.search, [
        { text: '🔄 刷新', cls: 'btn-outline', onClick: { name: 'scan:reload' } }
      ]);
      html += DS.card(rows.length ? DS.list(rows.map(function (r) {
        var snap = r.original_data;
        if (typeof snap === 'string') { try { snap = JSON.parse(snap); } catch (e) { /* ignore */ } }
        var text = '';
        if (snap && typeof snap === 'object') {
          text = snap.nickname || snap.username || snap.email || snap.license_key || snap.id || '';
        }
        if (!text) text = short(JSON.stringify(snap || {}), 30);
        return DS.li({
          ic: '♻️',
          title: text,
          sub: '删除人 ' + (r.deleted_by || '-') + ' · ' + DS.fmtTime(r.deleted_at),
          badge: r.is_restored ? DS.dot('已恢复', 'ok') : DS.dot('已删除', 'err'),
          onClick: { name: 'scan:rcDetail', payload: { type: isUser ? 'user' : 'license', id: r.id } }
        });
      })) : DS.empty('暂无' + (isUser ? '用户' : '授权') + '回收记录', '♻️'), { tight: true });
      html += DS.pagerHtml(key, total, st.size);
      el.innerHTML = html;
    });
  }

  /** 等价桌面版 scanRestoreFromRecycle：把 original_data 写回原表 */
  function restoreFromRecycle(type, id) {
    var table = type === 'user' ? 'deleted_users' : 'deleted_licenses';
    var target = type === 'user' ? 'users' : 'licenses';
    DS.confirm({
      title: '恢复记录',
      msg: '确认从回收站恢复此记录到 ' + target + ' 表？',
      okText: '确认恢复'
    }).then(function (ok) {
      if (!ok) return;
      DS.api(CONN, table, { select: '*', filters: { id: id }, limit: 1 }).then(function (res) {
        if (res.error) { DS.toast('恢复失败：' + res.error.message, 'err'); return; }
        var rec = (res.data || [])[0];
        if (!rec) { DS.toast('未找到回收站记录', 'err'); return; }
        var original = rec.original_data;
        if (typeof original === 'string') { try { original = JSON.parse(original); } catch (e) { /* ignore */ } }
        if (!original || typeof original !== 'object') { DS.toast('原记录数据为空，无法恢复', 'err'); return; }
        DS.api(CONN, target, { method: 'POST', data: original }).then(function (ins) {
          if (ins.error) { DS.toast('恢复失败：' + ins.error.message, 'err'); return; }
          safePatch(table, id, { is_restored: true }).then(function () {
            logAdmin('restore', table, id, '从回收站恢复记录到 ' + target, {});
            DS.toast('记录已恢复', 'ok');
            DS.closeAllOverlays();
            DS.refresh();
          });
        });
      });
    });
  }

  function purgeRecycle(type, id) {
    var table = type === 'user' ? 'deleted_users' : 'deleted_licenses';
    DS.confirm({
      title: '永久删除',
      msg: '确认永久删除此回收站记录？此操作不可恢复！',
      okText: '永久删除',
      danger: true
    }).then(function (ok) {
      if (!ok) return;
      DS.api(CONN, table, { method: 'DELETE', filters: { id: id } }).then(function (res) {
        if (res.error) { DS.toast('删除失败：' + res.error.message, 'err'); return; }
        logAdmin('permanent_delete', table, id, '永久删除回收站记录', {});
        DS.toast('记录已永久删除', 'ok');
        DS.closeAllOverlays();
        DS.refresh();
      });
    });
  }

  /* ======================================================================
     17. 页面：日志（5 类合 1，页内切换）
     ====================================================================== */

  function logOr(tab, kw) {
    if (tab === 'login') return ilikeOr(['username', 'admin_username', 'ip_address', 'device_info', 'user_agent'], kw);
    if (tab === 'verify') return ilikeOr(['license_key', 'device_id', 'fingerprint', 'machine_code', 'user_id'], kw);
    if (tab === 'email') return ilikeOr(['recipient', 'email', 'subject', 'type'], kw);
    if (tab === 'audit') return ilikeOr(['admin_username', 'actor', 'action', 'target_table', 'description'], kw);
    return ilikeOr(['email', 'phone', 'code', 'type'], kw);
  }

  function logLi(tab, r) {
    if (tab === 'login') {
      var dev = r.device_info || r.user_agent || '';
      return DS.li({
        ic: '🟢',
        title: r.username || r.admin_username || r.user_id || '匿名',
        sub: (r.ip_address || r.ip || '无 IP') + (dev ? ' · ' + short(dev, 22) : ''),
        badge: r.success === false ? DS.dot('失败', 'err') : DS.dot('成功', 'ok'),
        right: DS.fmtTime(r.created_at)
      });
    }
    if (tab === 'verify') {
      return DS.li({
        ic: '✅',
        title: r.license_key || (r.user_id ? short(r.user_id, 10) : '-'),
        sub: '设备 ' + short(r.device_id || r.fingerprint || r.machine_code || '-', 18) +
          (r.action ? ' · ' + r.action : ''),
        badge: r.success === false ? DS.dot('失败', 'err') : DS.dot('成功', 'ok'),
        right: DS.fmtTime(r.created_at)
      });
    }
    if (tab === 'email') {
      var ok = !(r.sent === false || r.status === 'failed');
      return DS.li({
        ic: '📧',
        title: r.recipient || r.email || '-',
        sub: (r.subject || '无主题') + (r.type ? ' · ' + r.type : ''),
        badge: ok ? DS.dot('已发送', 'ok') : DS.dot('失败', 'err'),
        right: DS.fmtTime(r.created_at)
      });
    }
    if (tab === 'audit') {
      return DS.li({
        ic: '📝',
        title: (r.admin_username || r.actor || r.user_id || 'admin') + ' · ' + (r.action || '-'),
        sub: (r.target_table || r.target_type || r.resource || '-') + ' ' + short(r.target_id || r.record_id || '', 8) +
          (r.description ? ' · ' + short(r.description, 26) : ''),
        right: DS.fmtTime(r.created_at)
      });
    }
    return DS.li({
      ic: '🔢',
      title: r.email || r.phone || '-',
      sub: '验证码 ' + (r.code || '-') + (r.type ? ' · ' + r.type : ''),
      badge: r.used ? DS.dot('已使用', 'muted') : DS.dot('未使用', 'ok'),
      right: DS.fmtTime(r.expires_at || r.created_at)
    });
  }

  function renderLogs(el) {
    el.innerHTML = DS.loading('加载日志…');
    var key = 'scan.logs';
    var tab = LOG_TABS[logsTab] || LOG_TABS.login;
    var st = DS.pager(key);
    var offset = st.page * st.size;
    var kw = orKw(st.search);
    var opts = {
      select: '*', order: 'created_at', ascending: false,
      rangeFrom: offset, rangeTo: offset + st.size - 1
    };
    if (kw) opts.orFilter = logOr(tab.v, kw);

    DS.api(CONN, tab.table, opts).then(function (res) {
      if (res.error) { el.innerHTML = errBoxOf(res); return; }
      var rows = res.data || [];
      var total = DS.totalOf(res);
      var html = DS.fchips(LOG_ORDER.map(function (k) {
        return { v: k, l: LOG_TABS[k].l };
      }), tab.v, 'scan:logTab');
      html += toolbar(key, tab.ph, st.search, [
        { text: '🔄 刷新', cls: 'btn-outline', onClick: { name: 'scan:reload' } }
      ]);
      html += DS.card(rows.length ? DS.list(rows.map(function (r) { return logLi(tab.v, r); }))
        : DS.empty(kw ? '没有匹配的日志' : ('暂无' + tab.l), '🗒'), { title: tab.l + '（' + tab.table + '）', tight: true });
      html += DS.pagerHtml(key, total, st.size);
      el.innerHTML = html;
    });
  }

  /* ======================================================================
     18. 页面：工具（数据库监控 + 数据修复 + 导出）
     ====================================================================== */

  function renderTools(el) {
    el.innerHTML = DS.loading('正在统计 ' + toolsTables.length + ' 张表…');
    var key = 'scan.tools';
    var st = DS.pager(key);
    var kw = orKw(st.search).toLowerCase();
    var names = toolsTables.filter(function (t) {
      if (!kw) return true;
      var meta = toolsTableMeta[t] || {};
      return t.toLowerCase().indexOf(kw) >= 0 || String(meta.label || '').indexOf(kw) >= 0;
    });
    var offset = st.page * st.size;
    var pageRows = names.slice(offset, offset + st.size);

    Promise.all(toolsTables.map(function (t) {
      return DS.api(CONN, t, { select: 'id', countOnly: true }).then(function (r) {
        return { table: t, count: r.error ? -1 : (r.count || 0), err: r.error };
      });
    })).then(function (results) {
      var map = {};
      var totalRows = 0;
      var okCount = 0;
      results.forEach(function (r) {
        map[r.table] = r;
        if (r.count >= 0) { totalRows += r.count; okCount++; }
      });

      var html = DS.statGrid([
        { icon: '📊', label: '监控表总数', value: String(toolsTables.length), sub: okCount + ' 张正常', subType: 'info', color: 'var(--accent)' },
        { icon: '✅', label: '正常访问', value: String(okCount), sub: (toolsTables.length - okCount) + ' 张异常', subType: okCount === toolsTables.length ? 'ok' : 'warn', color: 'var(--success)' },
        { icon: '💾', label: '总记录数', value: DS.fmtNum(totalRows), sub: '所有表合计', subType: 'info', color: 'var(--warn)' },
        { icon: '🔗', label: '连接', value: DS.conn(CONN).configured ? '已连接' : '未配置', sub: DS.conn(CONN).url.replace(/^https?:\/\//, '').split('.')[0] || 'cad', subType: 'muted', color: '#0ea5e9' }
      ]);

      html += '<div class="section-h">维护动作</div>';
      html += DS.actions([
        { text: '🛠 修复用户数据', cls: 'btn-primary', onClick: { name: 'scan:toolFixUsers' } },
        { text: '⏰ 标记过期授权', cls: 'btn-outline', onClick: { name: 'scan:toolExpire' } },
        { text: '📦 刷新套餐缓存', cls: 'btn-outline', onClick: { name: 'scan:toolReloadPkg' } },
        { text: '⬇️ 导出用户 JSON', cls: 'btn-outline', onClick: { name: 'scan:toolExport', payload: { table: 'users', label: 'users' } } },
        { text: '⬇️ 导出授权 JSON', cls: 'btn-outline', onClick: { name: 'scan:toolExport', payload: { table: 'licenses', label: 'licenses' } } },
        { text: '⬇️ 导出订单 JSON', cls: 'btn-outline', onClick: { name: 'scan:toolExport', payload: { table: 'orders', label: 'orders' } } }
      ]);

      html += '<div class="section-h">数据库监控</div>';
      html += toolbar(key, '搜索表名 / 说明', st.search, null);
      html += DS.card(pageRows.length ? DS.list(pageRows.map(function (t) {
        var r = map[t] || { count: -1 };
        var meta = toolsTableMeta[t] || { ic: '📋', label: t };
        var bad = r.count < 0;
        return DS.li({
          ic: meta.ic,
          title: t,
          sub: meta.label + (bad && r.err ? ' · ' + (r.err.message || '查询失败') : ''),
          badge: bad ? DS.dot('查询失败', 'err') : DS.dot('正常', 'ok'),
          right: bad ? '<span style="color:var(--danger)">错误</span>' : DS.fmtNum(r.count),
          rawRight: true
        });
      })) : DS.empty('没有匹配的表', '📊'), { tight: true });
      html += DS.pagerHtml(key, names.length, st.size);

      el.innerHTML = html;
    });
  }

  /** 等价桌面版 scanFixUserData()：补全 last_login、规范 trial_used */
  function fixUserData() {
    DS.confirm({
      title: '修复用户数据',
      html: '将执行：<br>1. 为 last_login 为空的用户，从 login_logs 中找到最后登录时间补全<br>' +
        '2. 规范化 trial_used 字段（true / false）<br><br>不会删除任何数据。',
      okText: '开始修复'
    }).then(function (ok) {
      if (!ok) return;
      DS.toast('开始修复用户数据…', 'info');
      DS.apiAll(CONN, 'users', { select: '*' }, 2000).then(function (res) {
        if (res.error) { DS.toast('读取用户失败：' + res.error.message, 'err'); return; }
        var users = res.data || [];
        var stats = { fixed: 0, login: 0, trial: 0, nolog: 0, failed: 0 };
        var i = 0;

        function fixOne(u) {
          var patch = {};
          var pre = Promise.resolve();
          if (!u.last_login && u.username) {
            pre = DS.api(CONN, 'login_logs', {
              select: 'created_at', filters: { username: u.username },
              order: 'created_at', ascending: false, limit: 1
            }).then(function (lr) {
              if (!lr.error && lr.data && lr.data[0] && lr.data[0].created_at) {
                patch.last_login = lr.data[0].created_at;
                stats.login++;
              } else {
                stats.nolog++;
              }
            });
          }
          return pre.then(function () {
            var tu = u.trial_used;
            if (tu !== true && tu !== false) {
              if (tu === 'true' || tu === '1' || tu === 1) patch.trial_used = true;
              else patch.trial_used = false;
              stats.trial++;
            }
            if (!Object.keys(patch).length) return null;
            return safePatch('users', u.id, patch).then(function (r) {
              if (r && r.error) { stats.failed++; return; }
              stats.fixed++;
            }, function () { stats.failed++; });
          });
        }

        function finish() {
          var msg = '修复完成：共 ' + users.length + ' 个用户，更新 ' + stats.fixed + ' 条';
          if (stats.login) msg += '，补全登录时间 ' + stats.login + ' 条';
          if (stats.trial) msg += '，规范试用状态 ' + stats.trial + ' 条';
          if (stats.nolog) msg += '，' + stats.nolog + ' 个用户无登录记录';
          if (stats.failed) msg += '，失败 ' + stats.failed + ' 条';
          DS.toast(msg, stats.failed ? 'warn' : 'ok');
          DS.refresh();
        }

        function step() {
          if (i >= users.length) { finish(); return; }
          var u = users[i++];
          fixOne(u).then(step, step);
        }

        if (!users.length) { finish(); return; }
        step();
      });
    });
  }

  /** 把已过期但状态仍为 active 的授权标记为 expired */
  function markExpiredLicenses() {
    DS.confirm({
      title: '标记过期授权',
      msg: '把「状态 = 有效」但到期时间已过的授权批量改为「过期」。不会删除数据。',
      okText: '开始处理'
    }).then(function (ok) {
      if (!ok) return;
      DS.apiAll(CONN, 'licenses', {
        select: 'id,license_key,expire_time,status',
        extraFilters: ['status=eq.active', 'expire_time=not.is.null', 'expire_time=lt.' + enc(nowISO())]
      }, 1000).then(function (res) {
        if (res.error) { DS.toast('查询失败：' + res.error.message, 'err'); return; }
        var list = res.data || [];
        if (!list.length) { DS.toast('没有需要处理的授权', 'info'); return; }
        var done = 0;
        var failed = 0;
        var i = 0;
        function step() {
          if (i >= list.length) {
            logAdmin('expire_licenses', 'licenses', null, '批量标记过期授权 ' + done + ' 条', { total: list.length, failed: failed });
            DS.toast('已标记 ' + done + ' 条过期授权' + (failed ? '，失败 ' + failed + ' 条' : ''), failed ? 'warn' : 'ok');
            DS.refresh();
            return;
          }
          var l = list[i++];
          safePatch('licenses', l.id, { status: 'expired' }).then(function (r) {
            if (r && r.error) failed++; else done++;
            step();
          }, function () { failed++; step(); });
        }
        step();
      });
    });
  }

  function exportTable(table, label) {
    DS.toast('正在导出 ' + label + '…', 'info');
    DS.apiAll(CONN, table, { select: '*' }, 5000).then(function (res) {
      if (res.error) { DS.toast('导出失败：' + res.error.message, 'err'); return; }
      var rows = res.data || [];
      DS.download(label + '-' + DS.fmtDate(new Date()) + '.json', JSON.stringify(rows, null, 2));
    });
  }

  /* ======================================================================
     19. 页面：管理员
     ====================================================================== */

  function adminLi(a) {
    var superAdmin = a.role === 'super_admin';
    return DS.li({
      ic: '🛡️',
      title: a.username || '-',
      sub: (a.nickname || '无昵称') + ' · ' + (a.email || '无邮箱') + ' · ' +
        (a.last_login ? DS.fmtAgo(a.last_login) : '从未登录'),
      badge: DS.dot(superAdmin ? '超级管理员' : '管理员', superAdmin ? 'err' : 'info'),
      onClick: { name: 'scan:adminDetail', payload: { id: a.id } }
    });
  }

  function renderAdmins(el) {
    el.innerHTML = DS.loading('加载管理员…');
    var key = 'scan.admins';
    var st = DS.pager(key);
    var offset = st.page * st.size;
    var kw = orKw(st.search);
    var opts = {
      select: '*', order: 'created_at', ascending: false,
      rangeFrom: offset, rangeTo: offset + st.size - 1
    };
    if (kw) opts.orFilter = ilikeOr(['username', 'nickname', 'email'], kw);

    DS.api(CONN, 'admin_users', opts).then(function (res) {
      if (res.error) { el.innerHTML = errBoxOf(res); return; }
      var rows = res.data || [];
      var total = DS.totalOf(res);
      var html = toolbar(key, '搜索用户名 / 昵称 / 邮箱', st.search, [
        { text: '➕ 新增管理员', cls: 'btn-primary', onClick: { name: 'scan:adminAdd' } }
      ]);
      html += DS.card(rows.length ? DS.list(rows.map(adminLi)) : DS.empty(kw ? '没有匹配的管理员' : '暂无管理员', '🛡️'), { tight: true });
      html += DS.pagerHtml(key, total, st.size);
      el.innerHTML = html;
    });
  }

  function openAdminForm(a) {
    var isNew = !a;
    formSheet({
      title: isNew ? '新增管理员' : '编辑管理员',
      okText: isNew ? '创建' : '保存',
      html:
        DS.input({ name: 'username', label: '用户名', value: isNew ? '' : (a.username || '') }) +
        (isNew ? DS.password({ name: 'password', label: '密码', required: true, placeholder: '登录密码' }) : '') +
        DS.input({ name: 'nickname', label: '昵称', value: isNew ? '' : (a.nickname || '') }) +
        DS.input({ name: 'email', label: '邮箱', type: 'email', value: isNew ? '' : (a.email || '') }) +
        DS.select({ name: 'role', label: '角色', value: isNew ? 'admin' : (a.role || 'admin'), options: [
          { value: 'admin', label: '管理员' }, { value: 'super_admin', label: '超级管理员' }
        ] }) +
        (isNew ? PWD_TIP : ''),
      onSubmit: function (body) {
        var d = DS.formData(body);
        var username = String(d.username || '').trim();
        if (isNew) {
          var pwd = String(d.password || '');
          if (!username) { DS.toast('请填写用户名', 'err'); return false; }
          if (!pwd) { DS.toast('请填写密码', 'err'); return false; }
          return sha256(pwd + PWD_SALT).then(function (hash) {
            var data = {
              username: username, password_hash: hash,
              nickname: String(d.nickname || '').trim() || username,
              email: String(d.email || '').trim() || null,
              role: d.role, created_at: nowISO()
            };
            return DS.api(CONN, 'admin_users', { method: 'POST', data: data }).then(function (res) {
              if (res.error) { DS.toast('创建失败：' + res.error.message, 'err'); return false; }
              var newId = (res.data && res.data[0] && res.data[0].id) || null;
              logAdmin('create', 'admin_users', newId, '创建管理员 ' + username, { username: username });
              DS.toast('管理员 ' + username + ' 创建成功', 'ok');
              DS.refresh();
            });
          });
        }
        if (!username) { DS.toast('请填写用户名', 'err'); return false; }
        var patch = {
          username: username,
          nickname: String(d.nickname || '').trim() || null,
          email: String(d.email || '').trim() || null,
          role: d.role
        };
        return safePatch('admin_users', a.id, patch).then(function (res) {
          if (res.error) { DS.toast('保存失败：' + res.error.message, 'err'); return false; }
          logAdmin('update', 'admin_users', a.id, '编辑管理员 ' + username, patch);
          DS.toast('管理员信息已更新', 'ok');
          DS.refresh();
        });
      }
    });
  }

  function resetAdminPwd(id, username) {
    DS.prompt({
      title: '重置密码',
      msg: '为管理员【' + (username || id) + '】设置新密码：',
      placeholder: '新密码'
    }).then(function (pwd) {
      if (!pwd) return;
      pwd = String(pwd);
      if (pwd.length < 4) { DS.toast('密码至少 4 位', 'err'); return; }
      DS.confirm({
        title: '重置密码',
        msg: '确认重置管理员【' + (username || id) + '】的密码？',
        okText: '确认重置'
      }).then(function (ok) {
        if (!ok) return;
        sha256(pwd + PWD_SALT).then(function (hash) {
          return safePatch('admin_users', id, { password_hash: hash });
        }).then(function (res) {
          if (res.error) { DS.toast('重置失败：' + res.error.message, 'err'); return; }
          logAdmin('reset_password', 'admin_users', id, '重置管理员密码 ' + (username || id), {});
          DS.toast('密码已重置', 'ok');
          DS.closeAllOverlays();
          DS.refresh();
        });
      });
    });
  }

  /* ======================================================================
     20. 页面渲染分派
     ====================================================================== */

  function render(pageId, el) {
    if (pageId === 'revenue') return renderRevenue(el);
    if (pageId === 'users') return renderUsers(el);
    if (pageId === 'licenses') return renderLicenses(el);
    if (pageId === 'orders') return renderOrders(el);
    if (pageId === 'packages') return renderPackages(el);
    if (pageId === 'devices') return renderDevices(el);
    if (pageId === 'blacklist') return renderBlacklist(el);
    if (pageId === 'recycleBin') return renderRecycleBin(el);
    if (pageId === 'logs') return renderLogs(el);
    if (pageId === 'tools') return renderTools(el);
    if (pageId === 'admins') return renderAdmins(el);
    return renderDashboard(el);
  }

  /* ======================================================================
     21. 事件委托（禁止把 id 拼进 onclick 字符串）
     ====================================================================== */

  /* ---- 通用 ---- */
  DS.on('scan:goPage', function (p) { if (p && p.page) DS.goPage(p.page); });
  DS.on('scan:reload', function () { DS.refresh(); });
  DS.on('scan:copy', function (p) { DS.copy(p && p.text ? p.text : ''); });

  /* ---- 详情 ---- */
  DS.on('scan:userDetail', function (p) { if (p && p.id) openUserDetail(p.id); });
  DS.on('scan:licenseDetail', function (p) { if (p && p.id) openLicenseDetail(p.id); });
  DS.on('scan:orderDetail', function (p) { if (p && p.id) openOrderDetail(p.id); });
  DS.on('scan:pkgDetail', function (p) { if (p && p.id) openPackageDetail(p.id); });
  DS.on('scan:adminDetail', function (p) { if (p && p.id) openAdminDetail(p.id); });
  DS.on('scan:blDetail', function (p) { if (p && p.id) openBlacklistDetail(p.type, p.id); });
  DS.on('scan:rcDetail', function (p) { if (p && p.id) openRecycleDetail(p.type, p.id); });

  /* ---- 用户 ---- */
  DS.on('scan:userAdd', function () { openUserForm(null); });
  DS.on('scan:userEdit', function (p) {
    if (!p || !p.id) return;
    DS.api(CONN, 'users', { select: '*', filters: { id: p.id }, limit: 1 }).then(function (res) {
      if (res.error) { DS.toast('读取用户失败：' + res.error.message, 'err'); return; }
      var u = (res.data || [])[0];
      if (!u) { DS.toast('未找到用户', 'err'); return; }
      openUserForm(u);
    });
  });
  DS.on('scan:userDel', function (p) { if (p && p.id) deleteUser(p.id, p.name); });
  DS.on('scan:userActivate', function (p) {
    if (!p || !p.id) return;
    loadPackagesCache().then(function () { openActivatePicker(p.id, p.name || '用户'); });
  });
  DS.on('scan:userActivatePkg', function (p) {
    if (!p || !p.uid || !p.pkg) return;
    DS.closeSheet();
    activateUser(p.uid, p.name || '用户', p.pkg);
  });

  /* ---- 授权 ---- */
  DS.on('scan:licenseAdd', function () { loadPackagesCache(); openLicenseForm(null); });
  DS.on('scan:licenseEdit', function (p) {
    if (!p || !p.id) return;
    DS.api(CONN, 'licenses', { select: '*', filters: { id: p.id }, limit: 1 }).then(function (res) {
      if (res.error) { DS.toast('读取授权失败：' + res.error.message, 'err'); return; }
      var l = (res.data || [])[0];
      if (!l) { DS.toast('未找到授权', 'err'); return; }
      openLicenseForm(l);
    });
  });
  DS.on('scan:licenseExtend', function (p) { if (p && p.id) openExtendSheet(p.id); });
  DS.on('scan:extDays', function (p) {
    var el = lastField('days');
    if (el) { el.value = p && p.days ? p.days : ''; DS.toast('已填入 +' + (p && p.days) + ' 天', 'info'); }
  });
  DS.on('scan:licenseDel', function (p) { if (p && p.id) deleteLicense(p.id, p.key); });

  /* ---- 订单 ---- */
  DS.on('scan:orderAdd', function () { openOrderForm(); });
  DS.on('scan:orderEdit', function (p) { if (p && p.id) openOrderEdit(p.id); });

  /* ---- 套餐 ---- */
  DS.on('scan:pkgAdd', function () { openPackageForm(null); });
  DS.on('scan:pkgEdit', function (p) {
    if (!p || !p.id) return;
    DS.api(CONN, 'packages', { select: '*', filters: { id: p.id }, limit: 1 }).then(function (res) {
      if (res.error) { DS.toast('读取套餐失败：' + res.error.message, 'err'); return; }
      var row = (res.data || [])[0];
      if (!row) { DS.toast('未找到套餐', 'err'); return; }
      openPackageForm(row);
    });
  });
  DS.on('scan:pkgToggle', function (p) { if (p && p.id) togglePackage(p.id, !!p.active, p.name); });

  /* ---- 黑名单 ---- */
  DS.on('scan:blTab', function (v) {
    blacklistTab = v === 'machine' ? 'machine' : 'email';
    resetPager('scan.blacklist');
    DS.refresh();
  });
  DS.on('scan:blAdd', function () { openBlacklistForm(); });
  DS.on('scan:blacklistRemove', function (p) { if (p && p.id) removeBlacklist(p.type, p.id); });

  /* ---- 回收站 ---- */
  DS.on('scan:rcTab', function (v) {
    recycleTab = v === 'license' ? 'license' : 'user';
    resetPager('scan.recycle');
    DS.refresh();
  });
  DS.on('scan:recycleRestore', function (p) { if (p && p.id) restoreFromRecycle(p.type, p.id); });
  DS.on('scan:recyclePurge', function (p) { if (p && p.id) purgeRecycle(p.type, p.id); });

  /* ---- 日志 ---- */
  DS.on('scan:logTab', function (v) {
    logsTab = LOG_TABS[v] ? v : 'login';
    resetPager('scan.logs');
    DS.refresh();
  });

  /* ---- 工具 ---- */
  DS.on('scan:toolFixUsers', function () { fixUserData(); });
  DS.on('scan:toolExpire', function () { markExpiredLicenses(); });
  DS.on('scan:toolReloadPkg', function () {
    loadPackagesCache(true).then(function () {
      DS.toast('套餐缓存已刷新（' + Object.keys(packagesCache).length + ' 个套餐）', 'ok');
    });
  });
  DS.on('scan:toolExport', function (p) {
    if (!p || !p.table) return;
    exportTable(p.table, p.label || p.table);
  });

  /* ---- 管理员 ---- */
  DS.on('scan:adminAdd', function () { openAdminForm(null); });
  DS.on('scan:adminEdit', function (p) {
    if (!p || !p.id) return;
    DS.api(CONN, 'admin_users', { select: '*', filters: { id: p.id }, limit: 1 }).then(function (res) {
      if (res.error) { DS.toast('读取管理员失败：' + res.error.message, 'err'); return; }
      var a = (res.data || [])[0];
      if (!a) { DS.toast('未找到管理员', 'err'); return; }
      openAdminForm(a);
    });
  });
  DS.on('scan:adminReset', function (p) { if (p && p.id) resetAdminPwd(p.id, p.username); });

  /* ======================================================================
     22. 注册模块
     ====================================================================== */

  DS.registerModule({
    id: 'scan',
    name: '散线转文字 CAD 授权',
    tabName: 'CAD',
    icon: '📡',
    subtitle: '用户 · 授权 · 订单 · 套餐',
    conns: ['cad'],
    pages: [
      { id: 'dashboard', title: '仪表盘' },
      { id: 'revenue', title: '收入统计' },
      { id: 'users', title: '用户管理' },
      { id: 'licenses', title: '授权管理' },
      { id: 'orders', title: '订单管理' },
      { id: 'packages', title: '套餐管理' },
      { id: 'devices', title: '活跃设备' },
      { id: 'blacklist', title: '黑名单' },
      { id: 'recycleBin', title: '回收站' },
      { id: 'logs', title: '日志' },
      { id: 'tools', title: '工具' },
      { id: 'admins', title: '管理员' }
    ],
    render: render
  });
})();
