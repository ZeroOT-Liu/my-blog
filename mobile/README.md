# 移动后台 · 手机端管理台

用手机管理你的三个后台：**散线转文字 CAD 授权**、**XHY Toolbox 授权**、**项目进度**。

形态是 **PWA 网页应用**（不是小程序、不是 APP），可以"添加到主屏幕"后全屏运行，跟原生 App 几乎没区别 —— 但不需要开发者账号、不需要 ICP 备案、iPhone 和安卓共用一套代码。

---

## 为什么是 PWA 而不是小程序 / APP

| | PWA 网页（本方案） | 微信小程序 | 安卓 APP |
|---|---|---|---|
| 开发/上线门槛 | 推到 GitHub Pages 即可，10 分钟 | 注册小程序 + 服务器域名必须 HTTPS 且 **ICP 备案** | 打包签名 + 只能安卓 |
| 直连 Supabase | ✅ 直接调 REST | ❌ 必须备案域名中转，否则请求被拦 | ✅ |
| iPhone 可用 | ✅ Safari 添加到主屏幕 | ✅ | ❌ |
| 电脑关机后可用 | ✅ 纯前端直连数据库 | ✅ | ✅ |
| 离线打开界面 | ✅ Service Worker | ❌ | ✅ |

关键原因：你那两个授权系统**本来就是前端直接连 Supabase 的**（`scan_admin.js` / `admin.html` 里的 xhy 模块）。所以手机端不需要任何服务器中转 —— 做成纯静态页面托管到 HTTPS 上，4G 打开就能用，电脑开不开机都无所谓。

---

## 三步用起来

### 第 1 步：拿到 Supabase 的 API Key

1. 打开 <https://supabase.com/dashboard>
2. 选项目：
   - **CAD 授权** → `uwgqflcjuixmdhgzlvmb`
   - **XHY Toolbox** → `ofdouqimwsplrhjcfdbv`
3. 左侧 **Project Settings → API → Project API keys**
4. 复制：
   - `anon` `public` —— **只读**模式，能看不能改
   - `service_role` `secret`（点 Reveal）—— **管理模式**，可增删改

> ⚠️ `service_role` 是数据库最高权限。本应用**没有把它写进代码**，你只需要在第一次打开时粘贴一次，之后存在手机浏览器里。

### 第 2 步：部署到 HTTPS

在 `G:\网络授权系统\7-手机端软件` 目录执行：

```bash
# 先干跑一次，看看会传哪些文件（不会真的写）
node tools/deploy.js --dry

# 正式部署到 GitHub Pages + Gitee Pages
node tools/deploy.js

# 只部署其中一个
node tools/deploy.js --only github
```

部署脚本会**自动从 `..\5-个人博客\serve_admin.js` 读取你已有的 GitHub / Gitee token**，不需要你复制粘贴密钥。

传完后地址是：

- GitHub Pages：`https://lyt-6-666.github.io/my-blog/mobile/`
- Gitee Pages：`https://lyt666999-luck.gitee.io/my-blog/mobile/`
  （Gitee 免费版需要在仓库 → 服务 → Gitee Pages → 点一次「更新」）

> 想放进别的仓库？复制 `deploy.config.json.example` 的思路，在本目录建 `deploy.config.json` 覆盖 `owner/repo/branch/dir`。该文件已被 `.gitignore` 排除。

### 第 3 步：装到手机主屏幕

- **iPhone / Safari**：打开网址 → 底部「分享」→「添加到主屏幕」
- **安卓 / Chrome**：打开网址 → 右上角「⋮」→「安装应用」/「添加到主屏幕」

第一次打开会引导你粘贴 API Key。之后每次打开直接进，不用再输。

---

## 手机测试（最快的方式，1 分钟）

**双击 `启动手机测试.bat`** 就行。脚本会自动：

1. 找到 Node
2. 检测出手机该用的局域网地址（例如 `http://192.168.82.49:8788/`）
3. **把地址复制到剪贴板** —— 粘到微信「文件传输助手」发给自己，手机上点一下就能打开，不用手打
4. 如果以管理员身份运行，自动放行 Windows 防火墙的 8788 端口
5. 开一个新窗口跑服务器（关掉那个窗口 = 停止服务），同时在本机浏览器打开自检

然后手机上：

1. 连上**和电脑同一个 WiFi**
2. 打开那个 `http://192.168.x.x:8788/` 地址
3. 首次会要求填 Supabase API Key：
   - 电脑上打开 <https://supabase.com/dashboard> → 选项目 → **Project Settings → API**
   - 复制 `anon`（只读）或 `service_role`（可管理）key
   - 也发给微信「文件传输助手」，手机上长按粘贴

手动启动等价于：

```bash
node tools/serve.js 8788 --lan      # 会打印手机可用的地址
node tools/lan-url.js 8788          # 只打印地址（脚本内部用）
```

### 这条路上的两个限制

| 限制 | 原因 | 影响 |
|---|---|---|
| 不能"添加到主屏幕"、没有离线缓存 | 浏览器规定 Service Worker / PWA 安装必须 HTTPS，而局域网是 http | 只影响安装体验，**功能和数据完全正常** |
| 手机和电脑必须同一个 WiFi | 走的是局域网直连 | 出门用不了，要出门用请部署（见下） |

打不开的排查顺序：① 手机是不是连的同一个 WiFi（别连了访客网络）→ ② 电脑防火墙（右键 `.bat` → 以管理员身份运行）→ ③ 路由器是否开了「AP 隔离 / 客户端隔离」（访客 WiFi 常见，换成主 WiFi）→ ④ 用 Windows 自带的「手机连接」或换台设备试。

---

## 外网访问（4G / 5G）

**不需要内网穿透、不需要你的电脑开机。** 因为：

- 页面本身托管在 GitHub Pages（HTTPS，全球 CDN）
- 数据直接从前端请求 Supabase REST（`https://xxx.supabase.co/rest/v1/...`）

所以随便在哪个网络、用哪张卡，打开网址就能用。

---

## 目录结构

```
7-手机端软件/
├── index.html              应用外壳（顶栏 / 二级导航 / 内容区 / 底部 tab）
├── app.css                 全部样式（暖白 / 青瓷 / 雾蓝 / 深夜 四套主题）
├── app.js                  框架：DS API、Supabase 客户端、路由、UI 组件、PIN 锁
├── sw.js                   Service Worker（离线外壳缓存，跨域数据不缓存）
├── manifest.webmanifest    PWA 清单（图标、启动方式、快捷方式）
├── icons/                  图标（192 / 512 / maskable / apple-touch / favicon）
├── modules/
│   ├── scan.js             散线转文字 CAD 授权管理
│   ├── xhy.js              XHY Toolbox 授权管理
│   └── pr.js               项目后台（Supabase 存储，localStorage 回退）
├── docs/MODULE-API.md      ★ 模块开发接口文档（想加新模块看这个）
├── sql/projects_table.sql  ★ 项目后台的建表 SQL（部署前请在 Supabase 跑一次）
└── tools/
    ├── deploy.js           一键部署到 GitHub / Gitee Pages
    ├── serve.js            本地/局域网预览服务器（默认 8788，端口占用自动换）
    ├── lan-url.js          打印手机该访问的局域网地址（启动脚本用）
    ├── lint-modules.js     模块规范检查（写操作安全 / XSS / 密钥 / 事件闭环 / ES5）
    ├── gen-icons.py        重新生成 PWA 图标（需要 Pillow）
    └── smoke-test.js       冒烟测试（Node 里桩化 DOM，把每个页面渲染一遍）
```

一键启动手机测试：双击根目录的 **`启动手机测试.bat`**（详见上面「手机测试」一节）。

---

## 三个模块的数据来源

| 模块 | 连接名 | Supabase 项目 | 主要表 |
|---|---|---|---|
| 散线转文字 CAD 授权 | `cad` | `uwgqflcjuixmdhgzlvmb` | `users` `licenses` `orders` `packages` `admin_users` `verification_codes` `login_logs` `verify_logs` `email_logs` `admin_operation_logs` |
| XHY Toolbox 授权 | `xhy` | `ofdouqimwsplrhjcfdbv` | 见 `modules/xhy.js` 顶部注释 |
| 项目后台 | `prj` | 默认同 `cad`，可改 | `projects`（需自己建表） |

---

## ⚠️ 项目后台需要先建表

原来的「项目后台」数据**只存在电脑浏览器的 localStorage 里**（key `liuxiao.projects.v1`），从来没上传过。所以手机上打开会是空的。要让它云端化：

1. 打开你 CAD 那个 Supabase 项目 → **SQL Editor** → New query
2. 把 [`sql/projects_table.sql`](sql/projects_table.sql) 全文粘进去 → **Run**
3. 手机端进「项目后台」，顶部不该再出现"本地模式"提示

### 把电脑上的旧项目数据搬过来（两种方式）

**方式 A：复制粘贴（推荐）**

1. 电脑上打开博客后台，按 `F12` → Console
2. 执行 `copy(localStorage.getItem('liuxiao.projects.v1'))` —— JSON 已在剪贴板
3. 手机上把这段 JSON 通过微信/备忘录发给自己，复制
4. 手机端「项目后台 → 导入 JSON」→ 粘贴 → 确认

**方式 B：导出文件**

1. 同样的 Console，执行：
   ```js
   const b=new Blob([localStorage.getItem('liuxiao.projects.v1')],{type:'application/json'});
   const a=document.createElement('a');a.href=URL.createObjectURL(b);a.download='projects.json';a.click();
   ```
2. 把 `projects.json` 传到手机，用「项目后台 → 导入 JSON」选文件

导入后即使不建云端表，也会存在手机本地（本地模式）；建了表就会写到云端，电脑手机看到同一份。

---

## 安全说明（请一定读）

1. **代码里没有任何密钥。** 三个数据源的 URL 是可公开的（预填在 `app.js` 的 `CONN_DEF`），API Key 必须你自己输入，只存在手机浏览器的 localStorage。
2. **`service_role` key 等于数据库管理员。** 因为这个应用是"管理后台"，必须用它才能增删改。建议：
   - 只在自己的手机上输入，不要在公共电脑上保存
   - 给手机设锁屏密码；应用内还可以再开一层 **设置 → 安全 → 应用密码(PIN)**
   - 怀疑泄露了就到 Supabase 控制台 **Rotate / 重新生成** key
3. **应用密码（PIN）只是防顺手，不是加密。** 数据本身仍然靠 Supabase 的 key 保护。PIN 用 SHA-256 加盐哈希存储；在某些非 HTTPS 环境下会退化成简单哈希（见 `app.js` 的 `hashPin`）。
4. **GitHub Pages 上这个页面是公开可访问的**（代码里无密钥所以无所谓）。如果你更希望"连页面都要登录才能看"，把同样的静态文件部署到 **Cloudflare Pages + Cloudflare Access（免费，邮箱验证码登录）** 即可，代码不用改。
5. 部署脚本把 `deploy.config.json` 排除在部署清单外，`.gitignore` 也不会提交它。

---

## 本地预览 / 局域网调试

```bash
# 只在本机看（默认端口 8788；被占用会自动往后试 10 个端口）
node tools/serve.js

# 允许同一 WiFi 下的手机访问（会打印手机可用的地址）
node tools/serve.js 8788 --lan
```

> 用局域网 IP（`http://192.168.x.x:8788`）访问时 **Service Worker 不生效** —— 浏览器规定 SW 只能在 HTTPS 或 `localhost` 下运行。功能都正常，但没有离线缓存和"添加到主屏幕"。真机体验请用部署后的 HTTPS 地址。

---

## 自检

```bash
# 1) 语法检查
node --check app.js
node --check modules/scan.js

# 2) 模块规范检查（写操作安全 / XSS 转义 / 密钥泄漏 / 事件闭环 / ES5）
node tools/lint-modules.js
node tools/lint-modules.js --strict

# 3) 冒烟测试：桩化 DOM，把每个模块的每个页面渲染两遍（空数据 / 样例数据），
#    并断言请求构造、安全护栏、弹层嵌套、启动流程
node tools/smoke-test.js
```

`smoke-test.js` 覆盖的 95 项断言里，有几条是专门防"灾难级"误操作的：

- `PATCH` 必须带上过滤条件（否则会更新整张表）
- 无过滤条件的 `PATCH` / `DELETE` 必须被护栏拦下且不发请求
- 分页 `Range` 头、`countOnly`、`POST upsert` 的 `on_conflict` 是否正确
- 关闭内层弹层不能把外层一起关掉；返回键要逐层关闭；被返回键关掉的确认框必须解析为 `false`
- 全部请求只能指向 Supabase `/rest/v1/`

---

## 想加一个新模块？

看 [`docs/MODULE-API.md`](docs/MODULE-API.md)。核心就三步：

1. 建 `modules/xxx.js`，`DS.registerModule({ id, name, icon, conns, pages, render })`
2. 在 `index.html` 底部加一行 `<script src="modules/xxx.js"></script>`
3. `node tools/smoke-test.js` 确认页面能渲染

框架已经提供了数据访问（`DS.api`）、分页/搜索（`DS.pager` / `DS.onSearch` / `DS.onPager`）、弹层（`DS.sheet` / `DS.confirm` / `DS.prompt`）、表单（`DS.input` / `DS.formData` / `DS.validate`）、卡片列表（`DS.card` / `DS.li` / `DS.stat`），以及自动持久化的路由状态。

---

## 常见问题

**Q：数据加载失败，提示 401 / 403？**
Key 填错或用了 `anon` key 去写数据。管理操作必须用 `service_role`。到「设置 → 数据源连接」重填。

**Q：提示"未配置连接"？**
每个模块需要各自的连接。进「设置 → 数据源连接」，逐个填 URL + Key。默认 URL 已预填。

**Q：项目后台显示"本地模式"？**
说明 `projects` 表还没建，或 `prj` 连接指向的库不对。跑一次 `sql/projects_table.sql`。

**Q：改了代码，手机上还是旧的？**
Service Worker 缓存。`.js` / `.css` 改动后建议把 `sw.js` 里的 `VERSION` 加一位（例如 `dsh-mobile-v5` → `v6`），重新部署。手机上也可以手动清：浏览器设置里清除该站点数据，或长按主屏幕图标删掉重装。

**Q：Gitee 那边没更新？**
Gitee 免费版 Pages 需要手动点「更新」。GitHub Pages 一般 1 分钟内自动生效。

**Q：iPhone 上从主屏幕打开，顶部被刘海挡住？**
已经用 `env(safe-area-inset-*)` 处理了。如果还有问题，确认 `index.html` 里有 `viewport-fit=cover`。
