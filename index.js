/**
 * index.js - 博客前端数据加载器
 * 从 data/*.json 读取内容，动态渲染页面
 * 与 admin.html 的数据字段一一对应
 * 图片秒加载优化：骨架屏 + 预加载 + 渐进式淡入 + 重试机制
 */
(function () {
  'use strict';

  // ===========================
  // 图片预加载管理器（秒加载核心 + 重试机制）
  // ===========================
  var ImagePreloader = {
    cache: new Map(),
    loading: new Map(), // 正在加载中的图片
    retryCount: new Map(), // 重试计数
    observer: null,
    maxRetries: 2, // 最多重试2次

    // 预加载单张图片（自动尝试多个 CDN，找到最快的）
    preload(url, retryCount, cdnIndex) {
      if (!url) return Promise.resolve(null);
      if (this.cache.has(url)) return Promise.resolve(this.cache.get(url));
      
      cdnIndex = cdnIndex || 0;
      retryCount = retryCount || 0;
      
      // 如果当前 CDN 全部失败，记录失败但继续
      if (cdnIndex >= CDN_IMG.length) {
        console.warn('❌ 所有CDN都失败:', url);
        return Promise.resolve(null);
      }
      
      // 生成当前 CDN 的 URL
      var cdnBase = CDN_IMG[cdnIndex];
      var cdnUrl = url.replace(CDN_IMG[0], cdnBase);  // 用当前 CDN 替换原 URL
      
      return new Promise((resolve) => {
        var self = this;
        var img = new Image();
        var timeoutId = setTimeout(() => {
          img.src = '';
          // 当前 CDN 超时，尝试下一个
          console.log('⏳ CDN' + (cdnIndex + 1) + '超时，尝试下一个...', url.split('/').pop());
          self.preload(url, 0, cdnIndex + 1).then(resolve);
        }, 8000); // 8秒超时

        img.onload = function() {
          clearTimeout(timeoutId);
          self.cache.set(url, img);
          self.loading.delete(url);
          resolve(img);
        };
        img.onerror = function() {
          clearTimeout(timeoutId);
          // 当前 CDN 失败，尝试下一个
          console.log('⚠️ CDN' + (cdnIndex + 1) + '失败，尝试下一个...', url.split('/').pop());
          self.preload(url, 0, cdnIndex + 1).then(resolve);
        };
        img.src = cdnUrl;
      });
    },

    // 批量预加载（首屏优先）
    async preloadAll(urls, priorityFirst) {
      urls = urls.filter(Boolean);
      if (priorityFirst && urls.length > 0) {
        // 首屏优先：先加载第一张，再加载其余的
        await this.preload(urls[0]);
        if (urls.length > 1) {
          await Promise.all(urls.slice(1).map(url => this.preload(url)));
        }
      } else {
        await Promise.all(urls.map(url => this.preload(url)));
      }
    },

    // 初始化 IntersectionObserver（图片即将进入视口时预加载）
    initObserver() {
      if (this.observer) return;
      this.observer = new IntersectionObserver((entries) => {
        entries.forEach(entry => {
          if (entry.isIntersecting) {
            var img = entry.target;
            var src = img.getAttribute('data-src');
            if (src) {
              this.preload(src).then(() => {
                img.src = src;
                img.removeAttribute('data-src');
              });
            }
            this.observer.unobserve(img);
          }
        });
      }, { rootMargin: '300px 0px' }); // 提前 300px 开始加载，确保流畅
    },

    // 为图片添加懒加载监听
    observe(img) {
      if (!this.observer) this.initObserver();
      this.observer.observe(img);
    }
  };

  // ===========================
  // 自动适配本地 localhost 和 GitHub Pages 子目录
  // ===========================
  var BASE = (function () {
    var p = location.pathname.replace(/\/[^/]*$/, '');
    // GitHub Pages 子目录：/my-blog 等
    return p || '';
  })();
  var DATA = BASE + '/data';
  // 判断是否为本地环境（localhost）
  var IS_LOCAL = location.hostname === 'localhost' || location.hostname === '127.0.0.1';
  // CDN 配置：图片/文档用 Gitee（国内快），静态文件用 GitHub
  var CDN_IMG = [  // 图片+文档 CDN：Gitee 优先
    'https://gitee.com/LYT666999-luck/my-blog/raw/master',
    'https://ghproxy.net/https://github.com/ZeroOT-Liu/my-blog/raw/main',
    'https://cdn.jsdelivr.net/gh/ZeroOT-Liu/my-blog@main'
  ];
  var CDN_STATIC = [  // 静态文件 CDN：GitHub 优先
    'https://ghproxy.net/https://github.com/ZeroOT-Liu/my-blog/raw/main',
    'https://gitee.com/LYT666999-luck/my-blog/raw/master',
    'https://cdn.jsdelivr.net/gh/ZeroOT-Liu/my-blog@main'
  ];
  var CDN_IMG_PRIMARY = CDN_IMG[0];
  var CDN_STATIC_PRIMARY = CDN_STATIC[0];
  
  // 判断是否为图片/文档路径（走 Gitee CDN）
  function isImagePath(path) {
    if (!path) return false;
    // 图片路径：images/ 目录、data/gallery/、data/projects/、data/hero/
    // 文档路径：docs/ 目录
    return path.startsWith('images/') || 
           path.startsWith('data/gallery/') ||
           path.startsWith('data/projects/') ||
           path.startsWith('data/hero/') ||
           path.startsWith('docs/') ||
           path.match(/\.(jpg|jpeg|png|gif|webp|svg|ico)$/i);
  }
  
  // 获取 CDN URL
  function getCdnUrl(path) {
    if (isImagePath(path)) {
      return CDN_IMG_PRIMARY;
    }
    return CDN_STATIC_PRIMARY;
  }
  
  // 获取所有备用 CDN URL
  function getCdnFallbacks(path) {
    var cdns = isImagePath(path) ? CDN_IMG : CDN_STATIC;
    return cdns.slice(1).map(function(cdn) {
      return cdn + '/' + path;
    });
  }
  // 获取图片完整 URL：本地用相对路径，线上用 CDN
  function getImgUrl(path) {
    if (!path) return '';
    if (path.startsWith('http')) return path;
    var cdn = getCdnUrl(path);
    var base = IS_LOCAL ? (BASE ? BASE + '/' + path : path) : (cdn + '/' + path);
    return base;
  }
  
  // 获取图片的备用 CDN URL（用于 HTML data-fallback 属性）
  function getImgFallbackUrls(path) {
    if (!path) return [];
    if (path.startsWith('http')) return [];
    return getCdnFallbacks(path);
  }
  
  // 获取图片的备用格式 URL（用于不支持 WebP 时降级）
  function getImgFallbackUrl(path) {
    if (!path) return '';
    if (path.match(/\.webp$/i)) {
      var base = path.startsWith('http') ? path : (getCdnUrl(path) + '/' + path);
      return base.replace(/\.webp$/i, '.png');
    }
    return '';
  }
  // 获取文档完整 URL：本地用相对路径，线上用静态文件 CDN
  function getDocUrl(path, forFetch) {
    if (!path) return '';
    if (path.startsWith('http')) return path;
    if (IS_LOCAL) return BASE ? BASE + '/' + path : path;
    return CDN_STATIC_PRIMARY + '/' + path;
  }

  // ===========================
  // 图片加载降级处理（WebP → 原图 → CDN备用）
  // ===========================
  // 当图片加载失败时自动尝试降级到更小的格式/CDN
  window._blogImgFallback = function(img) {
    var fallbacks = (img.getAttribute('data-fallback') || '').split('|');
    if (!fallbacks || fallbacks.length === 0) {
      // 没有备用地址，直接隐藏
      img.style.display = 'none';
      if (img.nextElementSibling) img.nextElementSibling.style.display = 'flex';
      return;
    }
    var tried = img._blogTried || [];
    // 找到下一个未尝试的备用地址（过滤空字符串）
    var nextUrl = null;
    for (var i = 0; i < fallbacks.length; i++) {
      if (fallbacks[i] && tried.indexOf(fallbacks[i]) === -1) {
        nextUrl = fallbacks[i];
        tried.push(nextUrl);
        break;
      }
    }
    if (!nextUrl) {
      // 所有备用地址都试过了，隐藏
      img.style.display = 'none';
      if (img.nextElementSibling) img.nextElementSibling.style.display = 'flex';
      return;
    }
    img._blogTried = tried;
    console.log('🔄 尝试备用图片: ' + nextUrl);
    img.src = nextUrl;
  };

  // ===========================
  // 创建带骨架屏的图片元素（自动 WebP + CDN 备用 + 骨架屏占位）
  // ===========================
  function createLazyImage(url, alt, className, isFirstScreen) {
    if (!url) {
      return '<span class="img-skeleton" style="display:flex;align-items:center;justify-content:center;font-size:2rem;background:linear-gradient(90deg,#f0f0f0 25%,#e0e0e0 50%,#f0f0f0 75%);background-size:200% 100%;animation:shimmer 1.5s infinite">🖼️</span>';
    }
    var imgUrl = getImgUrl(url); // 直接获取 CDN URL
    // 生成备用 CDN URL 列表
    var fallbackUrls = getImgFallbackUrls(url);
    var fallbackData = fallbackUrls.join('|');
    var fallbackAttr = fallbackData ? ' data-fallback="' + esc(fallbackData) + '"' : '';
    // 检查图片是否已在缓存中（预加载成功）
    var cachedImg = ImagePreloader.cache.get(imgUrl);
    if (isFirstScreen) {
      // 首屏：先显示骨架屏，图片加载完成后再淡入
      if (cachedImg) {
        // 已预加载，直接显示（不重复加载）
        return '<img src="' + imgUrl + '" alt="' + esc(alt) + '" class="' + (className || '') + ' img-loaded" style="opacity:1" ' + fallbackAttr + '>';
      } else {
        // 未预加载：显示骨架屏占位，加载完成后移除骨架屏
        return '<span class="img-skeleton" style="position:absolute;inset:0;width:100%;height:100%;z-index:1"></span>' +
               '<img src="' + imgUrl + '" alt="' + esc(alt) + '" class="' + (className || '') + '" style="position:relative;z-index:2;opacity:0" onload="this.style.opacity=\'1\';this.previousElementSibling.style.display=\'none\'" onerror="window._blogImgFallback(this);this.style.opacity=\'1\';this.previousElementSibling.style.display=\'none\'" ' + fallbackAttr + '>';
      }
    } else {
      // 非首屏：data-src 由 IntersectionObserver 触发加载
      return '<img data-src="' + imgUrl + '" alt="' + esc(alt) + '" class="img-skeleton ' + (className || '') + '" style="opacity:0;position:absolute;inset:0;width:100%;height:100%;object-fit:cover" onload="this.classList.remove(\'img-skeleton\');this.style.opacity=\'1\'" onerror="window._blogImgFallback(this)" ' + fallbackAttr + '>';
    }
  }

  // ===========================
  // 国际化（i18n）系统
  // ===========================
  var I18N = {
    zh: {
      // 导航
      nav_home: '首页',
      nav_projects: '作品',
      nav_gallery: '相册',
      nav_articles: '文章',
      nav_about: '关于',
      nav_contact: '联系',
      nav_software: '软件下载',
      // 主题面板
      theme_label: '选择主题',
      // 语言按钮
      lang_switch: 'EN',
      // 徽章
      badge_projects: '// 作品',
      badge_gallery: '// 相册',
      badge_articles: '// 文章',
      badge_about: '// 关于我',
      badge_contact: '// 联系',
      badge_software: '// 软件下载',
      // 标题
      title_projects: '作品展示',
      title_gallery: '相册',
      title_articles: '技术文章',
      title_about: '关于我',
      title_contact: '联系方式',
      // 描述
      desc_projects: '精心打磨的 CAD 自动化工具，让效率翻倍',
      desc_gallery: '记录开发历程，留存每一个灵感瞬间',
      desc_articles: '分享 CAD 二次开发经验与实用技巧',
      // 空状态
      empty_projects: '暂无作品，快去后台添加吧 🚀',
      empty_gallery: '暂无图片，去后台上传第一张吧 📷',
      empty_articles: '暂无文章，去后台写第一篇吧 ✏️',
      empty_contact: '暂无联系方式',
      empty_gal_cat: '该分类暂无图片',
      // 相册分类翻译
      cat_screenshot: '截图',
      cat_photo: '照片',
      cat_design: '设计',
      // 按钮
      btn_view_details: '查看详情 →',
      btn_watch_video: '观看视频',
      btn_docs: '使用说明',
      btn_download: '下载PDF',
      art_search: '🔍 搜索文章标题或标签...',
      art_load_more: '加载更多',
      art_no_match: '没有找到匹配的文章',
      // 加载状态
      loading: '加载中...',
      load_error: '加载失败',
      doc_error: '文档加载失败',
      // 视频弹窗
      video_title: '观看视频',
      // 关于页
      timeline_title: '经历',
      // 其他
      scroll_down: '向下滚动',
      reading_time: '预计阅读 {n} 分钟',
      // 主题名称
      theme_indigo: '靛蓝',
      theme_rose: '玫瑰',
      theme_emerald: '翡翠',
      theme_amber: '琥珀',
      theme_ocean: '海洋',
      theme_purple: '紫色',
      theme_sunset: '日落',
      theme_mint: '薄荷',
      theme_dark: '暗黑',
      // Footer
      footer_nav: '快速导航',
      footer_more: '更多',
      footer_contact: '联系方式',
      footer_back_top: '回到顶部 ↑',
    },
    en: {
      // 导航
      nav_home: 'Home',
      nav_projects: 'Projects',
      nav_gallery: 'Gallery',
      nav_articles: 'Articles',
      nav_about: 'About',
      nav_contact: 'Contact',
      nav_software: 'Download',
      // 主题面板
      theme_label: 'Choose Theme',
      // 语言按钮
      lang_switch: '中',
      // 徽章
      badge_projects: '// PROJECTS',
      badge_gallery: '// GALLERY',
      badge_articles: '// ARTICLES',
      badge_about: '// ABOUT ME',
      badge_contact: '// CONTACT',
      badge_software: '// DOWNLOAD',
      // 标题
      title_projects: 'Projects',
      title_gallery: 'Gallery',
      title_articles: 'Articles',
      title_about: 'About Me',
      title_contact: 'Contact',
      // 描述
      desc_projects: 'Carefully crafted CAD automation tools for maximum efficiency',
      desc_gallery: 'Documenting the development journey, capturing every inspiration',
      desc_articles: 'Sharing CAD secondary development experience and practical tips',
      // 空状态
      empty_projects: 'No projects yet. Add some in the admin panel 🚀',
      empty_gallery: 'No images yet. Upload your first photo 📷',
      empty_articles: 'No articles yet. Write your first post ✏️',
      empty_contact: 'No contact information',
      empty_gal_cat: 'No images in this category',
      // 相册分类翻译
      cat_screenshot: 'Screenshot',
      cat_photo: 'Photo',
      cat_design: 'Design',
      // 按钮
      btn_view_details: 'View Details →',
      btn_watch_video: 'Watch Video',
      btn_docs: 'Documentation',
      btn_download: 'Download PDF',
      art_search: '🔍 Search by title or tag...',
      art_load_more: 'Load More',
      art_no_match: 'No matching articles found',
      // 加载状态
      loading: 'Loading...',
      load_error: 'Load failed',
      doc_error: 'Failed to load document',
      // 视频弹窗
      video_title: 'Watch Video',
      // 关于页
      timeline_title: 'Experience',
      // 其他
      scroll_down: 'Scroll Down',
      reading_time: '{n} min read',
      // 主题名称
      theme_indigo: 'Indigo',
      theme_rose: 'Rose',
      theme_emerald: 'Emerald',
      theme_amber: 'Amber',
      theme_ocean: 'Ocean',
      theme_purple: 'Purple',
      theme_sunset: 'Sunset',
      theme_mint: 'Mint',
      theme_dark: 'Dark',
      // Footer
      footer_nav: 'Navigation',
      footer_more: 'More',
      footer_contact: 'Contact',
      footer_back_top: 'Back to Top ↑',
    }
  };

  var currentLang = localStorage.getItem('blog-lang') || 'zh';

  function t(key) {
    return I18N[currentLang][key] || key;
  }

  function applyLanguage(lang) {
    currentLang = lang;
    localStorage.setItem('blog-lang', lang);

    // 更新语言切换按钮
    var langBtn = document.getElementById('lang-btn');
    if (langBtn) langBtn.textContent = t('lang_switch');

    // 更新导航链接文本
    var navLinks = document.querySelectorAll('.nav-links a');
    var navMap = ['nav_home', 'nav_projects', 'nav_software', 'nav_gallery', 'nav_articles', 'nav_about', 'nav_contact'];
    navLinks.forEach(function(a, i) {
      if (navMap[i]) a.textContent = t(navMap[i]);
    });

    // 更新主题面板标签
    var tpLabel = document.getElementById('tp-label');
    if (tpLabel) tpLabel.textContent = t('theme_label');

    // 更新主题选项 title
    var themeMap = {
      'indigo': 'theme_indigo',
      'rose': 'theme_rose',
      'emerald': 'theme_emerald',
      'amber': 'theme_amber',
      'ocean': 'theme_ocean',
      'purple': 'theme_purple',
      'sunset': 'theme_sunset',
      'mint': 'theme_mint',
      'dark': 'theme_dark'
    };
    document.querySelectorAll('.tp-opt').forEach(function(o) {
      var tKey = themeMap[o.getAttribute('data-t')];
      if (tKey) o.title = t(tKey);
    });

    // 更新 data-i18n 元素
    document.querySelectorAll('[data-i18n]').forEach(function(el) {
      var key = el.getAttribute('data-i18n');
      if (I18N[lang][key]) el.textContent = I18N[lang][key];
    });

    // 更新 PDF 弹窗按钮
    var pdfPrev = document.querySelector('#pdf-prev [data-i18n]');
    if (pdfPrev) pdfPrev.textContent = t('pdf_prev');
    var pdfNext = document.querySelector('#pdf-next [data-i18n]');
    if (pdfNext) pdfNext.textContent = t('pdf_next');
    var pdfDl = document.getElementById('pdf-download');
    if (pdfDl) pdfDl.textContent = t('btn_download');

    // 更新页码显示
    updatePdfPageInfo();
  }

  function updatePdfPageInfo() {
    var pageInfo = document.getElementById('pdf-page-info');
    if (pageInfo && window._pdfPage && window._pdfTotal) {
      if (currentLang === 'en') {
        pageInfo.textContent = window._pdfPage + ' / ' + window._pdfTotal;
      } else {
        pageInfo.textContent = '第 ' + window._pdfPage + ' / ' + window._pdfTotal + ' 页';
      }
    }
  }

  // ===========================
  // IntersectionObserver 淡入
  // ===========================
  var io = new IntersectionObserver(function (entries) {
    entries.forEach(function (e) {
      if (e.isIntersecting) { e.target.classList.add('vis'); io.unobserve(e.target); }
    });
  }, { threshold: 0.1 });

  function observe(el) { if (el) io.observe(el); }
  function observeAll(parent) {
    if (!parent) return;
    parent.querySelectorAll('.fade-in').forEach(function (el) { io.observe(el); });
  }

  // ===========================
  // 主题切换
  // ===========================
  var THEMES = ['indigo', 'rose', 'emerald', 'amber', 'ocean', 'purple', 'sunset', 'mint', 'dark'];
  var curTheme = localStorage.getItem('blog-theme') || 'rose';

  function applyTheme(t) {
    curTheme = t;
    document.documentElement.setAttribute('data-theme', t);
    localStorage.setItem('blog-theme', t);
    document.querySelectorAll('.tp-opt').forEach(function (o) {
      o.classList.toggle('active', o.getAttribute('data-t') === t);
    });
  }

  document.addEventListener('DOMContentLoaded', function () {
    applyTheme(curTheme);
    applyLanguage(currentLang);

    // 语言切换
    var langBtn = document.getElementById('lang-btn');
    if (langBtn) {
      langBtn.addEventListener('click', function () {
        var newLang = currentLang === 'zh' ? 'en' : 'zh';
        applyLanguage(newLang);
        // 重新渲染动态内容
        if (_galData.length > 0) renderGallery(_galData);
        renderContact(window._contactData || {});
      });
    }

    // 主题面板切换
    var btn = document.getElementById('theme-btn');
    var panel = document.getElementById('theme-panel');
    if (btn && panel) {
      btn.addEventListener('click', function (e) {
        e.stopPropagation();
        panel.classList.toggle('show');
      });
      document.addEventListener('click', function () { panel.classList.remove('show'); });
      panel.addEventListener('click', function (e) { e.stopPropagation(); });
      document.querySelectorAll('.tp-opt').forEach(function (o) {
        o.addEventListener('click', function () { applyTheme(o.getAttribute('data-t')); });
      });
    }

    // 汉堡菜单
    var ham = document.getElementById('hamburger');
    var nav = document.getElementById('nav-links');
    if (ham && nav) {
      ham.addEventListener('click', function () {
        ham.classList.toggle('open');
        nav.classList.toggle('show');
      });
    }

    // 导航高亮 & 缩小
    var navbar = document.getElementById('navbar');
    var sections = document.querySelectorAll('section[id]');
    window.addEventListener('scroll', function () {
      // 进度条
      var sb = document.getElementById('scroll-bar');
      if (sb) sb.style.width = (window.scrollY / (document.body.scrollHeight - window.innerHeight) * 100) + '%';
      // 阅读进度条（文章弹窗内）
      var rp = document.getElementById('reading-progress');
      var artModal = document.getElementById('art-modal');
      if (rp && artModal && artModal.classList.contains('show')) {
        var modalBody = artModal.querySelector('.modal-body');
        if (modalBody) {
          var scrollTop = modalBody.scrollTop;
          var scrollHeight = modalBody.scrollHeight - modalBody.clientHeight;
          rp.style.width = (scrollHeight > 0 ? (scrollTop / scrollHeight * 100) : 0) + '%';
        }
      } else if (rp) {
        rp.style.width = '0%';
      }
      // 返回顶部
      var bt = document.getElementById('back-top');
      if (bt) bt.classList.toggle('show', window.scrollY > 300);
      // 导航缩小
      if (navbar) navbar.classList.toggle('scrolled', window.scrollY > 50);
      // 导航高亮
      var cur = '';
      sections.forEach(function (s) {
        if (window.scrollY >= s.offsetTop - 120) cur = s.id;
      });
      document.querySelectorAll('.nav-links a').forEach(function (a) {
        a.classList.toggle('active', a.getAttribute('href') === '#' + cur);
      });
    });

    // 返回顶部
    var bt = document.getElementById('back-top');
    if (bt) bt.addEventListener('click', function () { window.scrollTo({ top: 0, behavior: 'smooth' }); });

    // Esc 关闭弹窗
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') { closeArticle(); closeLightbox(); }
    });

    // 文章 Modal 关闭
    var artClose = document.getElementById('art-close');
    var artModal = document.getElementById('art-modal');
    if (artClose) artClose.addEventListener('click', closeArticle);
    if (artModal) artModal.addEventListener('click', function (e) { if (e.target === artModal) closeArticle(); });

    // 灯箱关闭
    var lbClose = document.getElementById('lb-close');
    var lightbox = document.getElementById('lightbox');
    if (lbClose) lbClose.addEventListener('click', closeLightbox);
    if (lightbox) lightbox.addEventListener('click', function (e) { if (e.target === lightbox) closeLightbox(); });

    // 加载数据
    loadAll();
  });

  // ===========================
  // 加载所有数据
  // ===========================
  function loadAll() {
    var files = ['config', 'hero', 'projects', 'gallery', 'articles', 'about', 'contact'];
    var promises = files.map(function (f) {
      return fetch(DATA + '/' + f + '.json')
        .then(function (r) { return r.ok ? r.json() : null; })
        .catch(function () { return null; });
    });
    Promise.all(promises).then(function (res) {
      var cfg      = res[0] || {};
      var hero     = res[1] || {};
      var projects = res[2] || [];
      var gallery  = res[3] || [];
      var articles = res[4] || [];
      var about    = res[5] || {};
      var contact  = res[6] || {};

      renderConfig(cfg);
      renderHero(hero);
      renderProjects(projects);
      renderGallery(gallery);
      renderArticles(articles);
      renderAbout(about);
      renderContact(contact);

      // 观察所有淡入元素
      document.querySelectorAll('.fade-in').forEach(function (el) { io.observe(el); });
    }).catch(function (err) {
      console.error('[博客] 数据加载失败:', err);
    });

    // 单独加载分类数据
    fetch(DATA + '/categories.json')
      .then(function (r) { return r.ok ? r.json() : null; })
      .catch(function () { return null; })
      .then(function (cats) {
        if (cats) _categories = cats;
      });
  }

  // ===========================
  // 首屏图片预加载状态管理
  // ===========================
  var _firstScreenLoading = {
    indicator: null,
    timeout: null
  };

  function showImgLoadingIndicator() {
    var indicator = document.getElementById('img-loading-indicator');
    if (indicator) {
      indicator.style.display = 'flex';
      // 8秒后自动隐藏（防止永远卡住）
      _firstScreenLoading.timeout = setTimeout(function() {
        hideImgLoadingIndicator();
      }, 8000);
    }
  }

  function updateImgLoadingIndicator(text) {
    var textEl = document.getElementById('img-loading-text');
    if (textEl) textEl.textContent = text;
  }

  function hideImgLoadingIndicator() {
    var indicator = document.getElementById('img-loading-indicator');
    if (indicator) {
      indicator.style.display = 'none';
    }
    if (_firstScreenLoading.timeout) {
      clearTimeout(_firstScreenLoading.timeout);
      _firstScreenLoading.timeout = null;
    }
  }

  // ===========================
  // 首屏图片预加载（秒加载核心）
  // 在 DOM 渲染前就开始，提前抢占带宽
  // ===========================
  var _preloadedCriticalUrls = []; // 记录已预加载的 URL，避免重复预加载
  var _preloadDone = false; // 防止重复预加载标志

  function preloadCriticalImages(projects, gallery, articles, about) {
    if (_preloadDone) {
      console.log('[博客] 关键图片已预加载，跳过重复调用');
      return;
    }
    _preloadDone = true;

    var urls = [];
    // 优先级排序：首屏最重要的图片优先
    // 1. 头像（首屏最显眼）
    if (about.avatar_url) urls.push(getImgUrl(about.avatar_url));
    // 2. 作品封面（前2个，最显眼）
    projects.slice(0, 2).forEach(function (p) {
      if (p.icon_url) urls.push(getImgUrl(p.icon_url));
    });
    // 3. 文章封面（前2个）
    articles.filter(function (a) { return a.published !== false; }).slice(0, 2).forEach(function (a) {
      if (a.cover_image) urls.push(getImgUrl(a.cover_image));
    });
    // 4. 相册（前4个）
    gallery.slice(0, 4).forEach(function (g) {
      if (g.image_url) urls.push(getImgUrl(g.image_url));
    });
    // 5. 作品封面（后几个）
    projects.slice(2, 4).forEach(function (p) {
      if (p.icon_url) urls.push(getImgUrl(p.icon_url));
    });
    // 6. 文章封面（后几个）
    articles.filter(function (a) { return a.published !== false; }).slice(2, 4).forEach(function (a) {
      if (a.cover_image) urls.push(getImgUrl(a.cover_image));
    });

    // 去重
    urls = urls.filter(function(url) {
      if (!url || _preloadedCriticalUrls.indexOf(url) >= 0) return false;
      _preloadedCriticalUrls.push(url);
      return true;
    });

    if (urls.length === 0) {
      console.log('[博客] 无需预加载的关键图片');
      return;
    }

    // 显示加载指示器
    showImgLoadingIndicator();
    updateImgLoadingIndicator('加载图片...');

    // 优先加载高优先级图片（首屏可见的）
    console.log('[博客] 开始预加载关键图片（' + urls.length + '张）:', urls.map(function(u) { return u.split('/').pop(); }));

    // 开始预加载，使用 Promise.all 追踪完成
    Promise.all(urls.map(function(url) {
      return ImagePreloader.preload(url).then(function(img) {
        if (img) {
          // 记录文件名便于调试
          console.log('[博客] ✓ 预加载成功:', url.split('/').pop());
        }
        return img;
      });
    })).then(function(results) {
      var successCount = results.filter(function(r) { return r !== null; }).length;
      updateImgLoadingIndicator('加载完成 ✓ (' + successCount + '/' + urls.length + ')');
      console.log('[博客] 预加载完成: ' + successCount + '/' + urls.length + ' 张成功');
      // 1秒后隐藏指示器
      setTimeout(hideImgLoadingIndicator, 1000);
    }).catch(function(err) {
      console.error('[博客] 预加载出错:', err);
      hideImgLoadingIndicator();
    });
  }

  // 在数据加载前预先启动（抢占先机）
  (function preloadBeforeRender() {
    console.log('[博客] 开始预加载关键图片...');
    // 先获取 URL 列表（不阻塞）
    var files = ['projects', 'gallery', 'articles', 'about'];
    Promise.all(files.map(function (f) {
      return fetch(DATA + '/' + f + '.json')
        .then(function (r) { return r.ok ? r.json() : Promise.resolve(null); })
        .catch(function () { return null; });
    })).then(function (res) {
      var projects = res[0] || [];
      var gallery = res[1] || [];
      var articles = res[2] || [];
      var about = res[3] || {};
      preloadCriticalImages(projects, gallery, articles, about);
    });
  })();

  // ===========================
  // 站点配置  (config.json → site)
  // ===========================
  function renderConfig(cfg) {
    var site = cfg.site || {};
    if (site.title) {
      document.title = site.title;
      var pt = document.getElementById('page-title');
      if (pt) pt.textContent = site.title;
    }
    var logo = document.getElementById('nav-logo-text');
    if (logo && site.logo) logo.textContent = site.logo;

    // 导航栏 Logo 图标
    var logoIcon = document.getElementById('nav-logo-icon');
    if (logoIcon) {
      var hasCustomIcon = site.logo_icon && site.logo_icon.trim();
      if (hasCustomIcon) {
        logoIcon.style.display = '';
        renderIconInto(logoIcon, site.logo_icon, '');
        // 如果 logo 文字开头是 emoji，去掉它避免重复
        var logoText = site.logo || '';
        var emojiPattern = /^[\u{1F300}-\u{1F9FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}\u{1F000}-\u{1F02F}\u{1F0A0}-\u{1F0FF}\u{1F100}-\u{1F64F}\u{1F680}-\u{1F6FF}\u{1F900}-\u{1F9FF}\u{1FA70}-\u{1FAFF}\u{2B00}-\u{2BFF}\s]+/u;
        var cleanText = logoText.replace(emojiPattern, '').trim();
        if (logo && cleanText) {
          logo.textContent = cleanText;
        }
      } else {
        logoIcon.style.display = 'none';
      }
    }

    var footer = document.getElementById('footer-text');
    if (footer) footer.innerHTML = site.footer_bottom || '&copy; 2026';

    // Footer Logo 和描述
    var footerLogo = document.getElementById('footer-logo-text');
    if (footerLogo && site.logo) footerLogo.textContent = site.logo;
    var footerDesc = document.getElementById('footer-desc');
    if (footerDesc && site.footer_desc) footerDesc.textContent = site.footer_desc;

    // 加载背景配置
    if (cfg.background) {
      renderBackground(cfg.background);
    }

    // 加载软件扫码下载配置
    if (cfg.software) {
      renderSoftware(cfg.software);
    }
  }

  // ===========================
  // 背景渲染 (config.json → background)
  // ===========================
  function renderBackground(bg) {
    var layer = document.getElementById('bg-image-layer');
    var orb = document.querySelector('.bg-orb');
    if (!layer) return;

    var type = bg.type || 'default';

    if (type === 'default') {
      // 默认：隐藏图片层，显示光晕动画
      layer.classList.remove('active');
      layer.style.backgroundImage = 'none';
      layer.style.backgroundColor = 'transparent';
      if (orb) orb.classList.remove('hidden-bg');
      document.body.classList.remove('has-bg-image');
      return;
    }

    // 非默认模式：隐藏光晕，显示图片层，让各区域背景透明
    if (orb) orb.classList.add('hidden-bg');
    layer.classList.add('active');
    document.body.classList.add('has-bg-image');

    if (type === 'image' && bg.image_url) {
      // 先应用样式（透明度、模糊等），图片异步加载
      layer.style.backgroundColor = 'transparent';
      var opacity = bg.opacity !== undefined ? bg.opacity : 0.15;
      layer.style.opacity = opacity;
      var blur = bg.blur || 0;
      layer.style.filter = blur > 0 ? 'blur(' + blur + 'px)' : 'none';
      if (blur > 0) {
        layer.style.transform = 'scale(1.05)';
      } else {
        layer.style.transform = 'none';
      }
      // 构建候选 URL 列表：主 CDN + 备用 CDN + GitHub Pages 直链兜底
      // 背景 style.backgroundImage 无法像 <img> 那样用 data-fallback，需手动逐个尝试
      var bgCandidates = [];
      var bgPrimary = getImgUrl(bg.image_url);
      bgCandidates.push(bgPrimary);
      var bgFallbacks = getImgFallbackUrls(bg.image_url);
      for (var bfi = 0; bfi < bgFallbacks.length; bfi++) {
        if (bgCandidates.indexOf(bgFallbacks[bfi]) === -1) bgCandidates.push(bgFallbacks[bfi]);
      }
      // 最后兜底：GitHub Pages 直链（BASE + path）
      if (!IS_LOCAL) {
        var bgDirect = (BASE ? BASE + '/' + bg.image_url : bg.image_url);
        if (bgCandidates.indexOf(bgDirect) === -1) bgCandidates.push(bgDirect);
      }
      // 逐个尝试加载，用第一个成功的 URL 设置背景
      var bgTryIdx = 0;
      function tryLoadBgImg() {
        if (bgTryIdx >= bgCandidates.length) {
          console.warn('❌ 背景图片所有 CDN 均失败:', bg.image_url);
          return;
        }
        var candUrl = bgCandidates[bgTryIdx];
        var testImg = new Image();
        testImg.onload = function() {
          layer.style.backgroundImage = 'url("' + candUrl + '")';
          console.log('✅ 背景图片加载成功:', candUrl);
        };
        testImg.onerror = function() {
          console.log('⚠️ 背景图片 CDN 失败，尝试下一个:', candUrl);
          bgTryIdx++;
          tryLoadBgImg();
        };
        testImg.src = candUrl;
      }
      tryLoadBgImg();
    } else if (type === 'color' && bg.color) {
      layer.style.backgroundImage = 'none';
      layer.style.backgroundColor = bg.color;
      layer.style.opacity = 1;
      layer.style.filter = 'none';
      layer.style.transform = 'none';
    }
  }

  // ===========================
  // 通用：图标渲染（支持 emoji / 图片URL / 空值回退）
  // ===========================
  function renderIconInto(container, iconValue, defaultEmoji) {
    if (!container) return;
    var val = iconValue && iconValue.trim() ? iconValue.trim() : '';
    if (!val) {
      container.textContent = defaultEmoji || '';
      return;
    }
    // 判断是否为图片路径
    var isImage = /\.(png|jpg|jpeg|gif|webp|svg|ico|bmp)$/i.test(val) || val.startsWith('http') || val.startsWith('images/') || val.startsWith('/images/');
    if (isImage) {
      var url = val.startsWith('http') ? val : (val.startsWith('/') ? val : getImgUrl(val));
      // 添加 CDN 回退支持
      var fallbacks = val.startsWith('http') ? [] : getImgFallbackUrls(val);
      // 本地环境也加 GitHub Pages 直链兜底（以防万一）
      if (!val.startsWith('http') && !IS_LOCAL) {
        var directUrl = (BASE ? BASE + '/' + val : val);
        if (fallbacks.indexOf(directUrl) === -1) fallbacks.push(directUrl);
      }
      var fallbackAttr = fallbacks.length ? ' data-fallback="' + esc(fallbacks.join('|')) + '"' : '';
      container.innerHTML = '<img src="' + url + '" alt="icon"' + fallbackAttr + ' onerror="window._blogImgFallback(this)">';
    } else {
      container.textContent = val;
    }
  }

  // ===========================
  // 软件扫码下载 (config.json → software)
  // ===========================
  function renderSoftware(sw) {
    if (!sw || !sw.enabled) return;

    // 兼容旧数据：如果只有 qrcode 单图，转成数组
    var images = [];
    if (sw.images && sw.images.length) {
      images = sw.images;
    } else if (sw.qrcode) {
      images = [{ url: sw.qrcode, label: '' }];
    }
    if (!images.length) return;

    var section = document.getElementById('software');
    if (!section) return;

    // 显示区域
    section.classList.remove('hidden');

    // 显示导航栏的下载链接
    var navLink = document.getElementById('nav-software');
    if (navLink) navLink.classList.remove('hidden');
    // 显示 Footer 的下载链接
    var footerSwLink = document.getElementById('footer-software-link');
    if (footerSwLink) footerSwLink.classList.remove('hidden');

    // 标题和描述
    var titleEl = document.getElementById('software-title');
    var descEl = document.getElementById('software-desc');
    var badgeEl = document.getElementById('software-badge');
    if (titleEl && sw.title) titleEl.textContent = sw.title;
    if (descEl && sw.desc) descEl.textContent = sw.desc;

    // 渲染图片网格
    var gallery = document.getElementById('software-gallery');
    if (!gallery) return;
    gallery.innerHTML = '';

    images.forEach(function(img, idx) {
      var url = img.url || img;
      var label = img.label || '';
      var card = document.createElement('div');
      card.className = 'software-img-card';
      card.innerHTML = '<img src="' + url + '" alt="' + (label || '图片 ' + (idx + 1)) + '">' +
        (label ? '<div class="software-img-label">' + esc(label) + '</div>' : '');
      card.addEventListener('click', function() {
        var modal = document.createElement('div');
        modal.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.85);z-index:10000;display:flex;align-items:center;justify-content:center;padding:20px;cursor:pointer';
        modal.innerHTML = '<img src="' + url + '" style="max-width:90vw;max-height:90vh;border-radius:12px;box-shadow:0 20px 60px rgba(0,0,0,.5)">';
        modal.addEventListener('click', function() { modal.remove(); });
        document.body.appendChild(modal);
      });
      gallery.appendChild(card);
    });
  }

  // ===========================
  // Hero (hero.json)
  // ===========================
  function renderHero(hero) {
    // Hero 图标
    var heroIconEl = document.getElementById('hero-avatar-icon');
    var heroAvatar = document.getElementById('hero-avatar');
    if (heroIconEl) {
      renderIconInto(heroIconEl, hero.icon, '🔧');
      // 判断是否为图片，图片模式下去掉渐变背景
      var val = (hero.icon || '').trim();
      var isImage = val && (/\.(png|jpg|jpeg|gif|webp|svg|ico|bmp)$/i.test(val) || val.startsWith('http') || val.startsWith('images/') || val.startsWith('/images/'));
      if (heroAvatar) {
        heroAvatar.classList.toggle('has-image', isImage);
      }
    }

    // 角标
    var badgeEl = document.getElementById('hero-badge');
    var badgeText = document.getElementById('badge-text');
    if (hero.badge && badgeEl && badgeText) {
      badgeText.textContent = hero.badge;
      badgeEl.style.display = '';
    }

    // 标题：两行，每行支持一个高亮词；兼容旧字段 headline_1/2/3/4
    var titleEl = document.getElementById('hero-title');
    if (titleEl) {
      function buildLine(lineText, hlWord) {
        if (!lineText) return '';
        if (hlWord && lineText.indexOf(hlWord) >= 0) {
          return lineText.replace(hlWord, '<span class="hl">' + esc(hlWord) + '</span>');
        }
        return esc(lineText);
      }
      var line1Html = '', line2Html = '';
      if (hero.line_1 !== undefined) {
        // 新格式
        line1Html = buildLine(hero.line_1, hero.hl_1);
        line2Html = buildLine(hero.line_2, hero.hl_2);
      } else {
        // 旧格式兼容
        var oldLine1 = [hero.headline_1, hero.headline_2 ? '<span class="hl">' + esc(hero.headline_2) + '</span>' : ''].filter(Boolean).join(' ');
        var oldLine2 = [hero.headline_3, hero.headline_4 ? '<span class="hl">' + esc(hero.headline_4) + '</span>' : ''].filter(Boolean).join(' ');
        line1Html = oldLine1;
        line2Html = oldLine2;
      }
      var lines = [line1Html, line2Html].filter(Boolean);
      titleEl.innerHTML = lines.join('<br>');
    }

    // 描述
    var descEl = document.getElementById('hero-desc');
    if (descEl && hero.description) descEl.textContent = hero.description;

    // 按钮
    var btnsEl = document.getElementById('hero-btns');
    if (btnsEl) {
      var html = '';
      if (hero.btn_1_text) html += '<a href="' + (hero.btn_1_link || '#') + '" class="btn btn-primary">' + esc(hero.btn_1_text) + '</a>';
      if (hero.btn_2_text) html += '<a href="' + (hero.btn_2_link || '#') + '" class="btn btn-outline">' + esc(hero.btn_2_text) + '</a>';
      btnsEl.innerHTML = html;
    }

    // 统计
    var statsEl = document.getElementById('hero-stats');
    if (statsEl && hero.stats && hero.stats.length > 0) {
      statsEl.innerHTML = hero.stats.map(function (s) {
        return '<div class="stat-item"><div class="stat-num">' + s.number + (s.suffix || '') + '</div><div class="stat-lbl">' + esc(s.label) + '</div></div>';
      }).join('');
      statsEl.style.display = '';
    }
  }

  // ===========================
  // 作品 (projects.json → array)
  // ===========================
  function renderProjects(list) {
    var el = document.getElementById('projects-grid');
    if (!el) return;
    if (!Array.isArray(list) || list.length === 0) {
      el.innerHTML = '<p style="color:var(--muted);text-align:center;grid-column:1/-1;padding:3rem;">' + t('empty_projects') + '</p>';
      return;
    }
    list.sort(function (a, b) { return (a.order || 99) - (b.order || 99); });
    el.innerHTML = list.map(function (p) {
      var tags = (p.tags || []).slice(0, 4).map(function (t) { return '<span class="proj-tag">' + esc(t) + '</span>'; }).join('');
      var gradient = p.gradient || 'var(--g1)';
      var href = p.link && p.link !== '#' ? ' href="' + p.link + '" target="_blank"' : '';
      // 视频链接按钮：从 video_url 提取 BV/av 号，生成弹窗播放
      var videoBtn = '';
      if (p.video_url) {
        var bvMatch = (p.video_url + '').match(/BV[a-zA-Z0-9]+/);
        var avMatch = (p.video_url + '').match(/av(\d+)/i);
        var vidId = '';
        var vidUrl = '';
        if (bvMatch) {
          vidId = bvMatch[0];
          vidUrl = 'https://www.bilibili.com/video/' + vidId;
        } else if (avMatch) {
          vidId = 'av' + avMatch[1];
          vidUrl = 'https://www.bilibili.com/video/av' + avMatch[1];
        } else if (p.video_url.match(/^https?:\/\//)) {
          vidUrl = p.video_url;
        }
        if (vidUrl) {
          var src = '';
          if (bvMatch) {
            src = '//player.bilibili.com/player.html?bvid=' + bvMatch[0] + '&high_quality=1&autoplay=0';
          } else if (avMatch) {
            src = '//player.bilibili.com/player.html?aid=' + avMatch[1] + '&high_quality=1&autoplay=0';
          }
          if (src) {
            videoBtn = '<a onclick="openVideoPlayer(\'' + src + '\',\'' + esc(p.title) + '\')" class="proj-video-link" style="cursor:pointer"><svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor"><path d="M8 5v14l11-7z"/></svg> ' + t('btn_watch_video') + '</a>';
          } else {
            videoBtn = '<a href="' + esc(vidUrl) + '" target="_blank" class="proj-video-link"><svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor"><path d="M8 5v14l11-7z"/></svg> ' + t('btn_watch_video') + '</a>';
          }
        }
      }
      // 使用说明按钮（支持 MD/TXT/PDF，统一弹窗打开）
      var docBtn = '';
      var docFile = p.doc_url || p.pdf_url;
      if (docFile) {
        docBtn = '<a onclick="openProjectDoc(\'' + esc(docFile) + '\',\'' + esc(p.title) + '\')" class="proj-doc-link"><svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8l-6-6zm-1 2l5 5h-5V4zM6 20V4h5v7h7v9H6zm2-7h8v1.5H8V13zm0 3h5v1.5H8V16z"/></svg> ' + t('btn_docs') + '</a>';
      }
      // 图标：首屏显示骨架屏占位，图片加载完成后淡入
      var iconHtml = '';
      if (p.icon_url) {
        var fullUrl = getImgUrl(p.icon_url);
        // 生成备用 CDN URL 列表
        var fallbackUrls = getImgFallbackUrls(p.icon_url);
        var fallbackData = fallbackUrls.join('|');
        var fallbackAttr = fallbackData ? ' data-fallback="' + esc(fallbackData) + '"' : '';
        // 检查是否已预加载
        var isCached = ImagePreloader.cache.has(fullUrl);
        if (isCached) {
          // 已预加载：直接显示
          iconHtml = '<img src="' + fullUrl + '" alt="' + esc(p.title) + '" class="img-loaded" style="opacity:1;position:relative;z-index:2" ' + fallbackAttr + '>';
        } else {
          // 未预加载：骨架屏占位 + 懒加载
          iconHtml = '<span class="img-skeleton" style="position:absolute;inset:0;width:100%;height:100%;z-index:1"></span>' +
                     '<img src="' + fullUrl + '" alt="' + esc(p.title) + '" style="position:relative;z-index:2;opacity:0" ' + fallbackAttr + ' onload="this.style.opacity=\'1\';this.previousElementSibling.style.display=\'none\'" onerror="window._blogImgFallback(this);this.style.opacity=\'1\';this.previousElementSibling.style.display=\'none\'">';
        }
      } else {
        iconHtml = '<span style="position:relative;z-index:1;font-size:4rem;">' + (p.emoji || '📦') + '</span>';
      }
      return '<div class="proj-card fade-in">' +
        '<div class="proj-thumb" style="background:' + (p.icon_url ? '#f0f0f0' : gradient) + '">' +
          iconHtml +
        '</div>' +
        '<div class="proj-body">' +
          '<div class="proj-tags">' + tags + '</div>' +
          '<h3>' + esc(p.title) + '</h3>' +
          '<p>' + esc(p.description || '') + '</p>' +
          '<div class="proj-actions">' +
            (href ? '<a' + href + ' class="proj-link">' + t('btn_view_details') + '</a>' : '') +
            videoBtn +
            docBtn +
          '</div>' +
        '</div>' +
      '</div>';
    }).join('');
    observeAll(el);
  }

  // ===========================
  // B站视频播放弹窗
  // ===========================
  window.openVideoPlayer = function (src, title) {
    // 移除已有的视频弹窗（如有）
    var old = document.getElementById('video-modal');
    if (old) old.remove();
    var modal = document.createElement('div');
    modal.id = 'video-modal';
    modal.className = 'video-modal';
    modal.innerHTML =
      '<div class="video-modal-backdrop"></div>' +
      '<div class="video-modal-box">' +
        '<div class="video-modal-header"><span>' + (title || t('video_title')) + '</span><button class="video-modal-close" onclick="closeVideoPlayer()">&times;</button></div>' +
        '<div class="video-modal-body"><iframe src="' + src + '" scrolling="no" border="0" frameborder="no" framespacing="0" allowfullscreen="true" sandbox="allow-same-origin allow-scripts allow-popups allow-forms"></iframe></div>' +
      '</div>';
    document.body.appendChild(modal);
    // 下一帧添加 show 类触发动画
    requestAnimationFrame(function () { modal.classList.add('show'); });
    // 点击遮罩关闭
    modal.querySelector('.video-modal-backdrop').addEventListener('click', window.closeVideoPlayer);
    // ESC 关闭
    document.addEventListener('keydown', videoEscHandler);
  };
  window.closeVideoPlayer = function () {
    var modal = document.getElementById('video-modal');
    if (modal) {
      modal.classList.remove('show');
      setTimeout(function () { modal.remove(); }, 300);
    }
    document.removeEventListener('keydown', videoEscHandler);
  };
  function videoEscHandler(e) { if (e.key === 'Escape') window.closeVideoPlayer(); }

  // ===========================
  // 使用说明弹窗（加载 MD/TXT 文件并渲染）
  // ===========================
  window.openProjectDoc = function (docUrl, title) {
    // 移除已有弹窗
    var old = document.getElementById('doc-modal');
    if (old) old.remove();
    // 判断是否为 PDF 文件
    var isPdf = /\.pdf$/i.test(docUrl);
    var fullUrl = getDocUrl(docUrl);
    // 创建弹窗
    var modal = document.createElement('div');
    modal.id = 'doc-modal';
    modal.className = 'modal';
    if (isPdf) {
      // PDF：用 iframe 全屏预览，浏览器原生 PDF 渲染（边下边看）
      modal.innerHTML =
        '<div class="modal-box" style="max-width:960px;height:88vh;padding:0;display:flex;flex-direction:column">' +
          '<div style="display:flex;align-items:center;justify-content:space-between;padding:.7rem 1.2rem;border-bottom:1px solid var(--border);flex-shrink:0">' +
            '<h2 style="margin:0;font-size:1.1rem">' + esc(title) + ' - ' + t('btn_docs') + '</h2>' +
            '<div style="display:flex;gap:.5rem;align-items:center">' +
              '<a href="' + esc(fullUrl) + '" target="_blank" download style="font-size:.82rem;color:var(--accent);text-decoration:none;padding:.3rem .7rem;border-radius:6px;background:var(--soft);border:1px solid transparent">' + t('btn_download') + '</a>' +
              '<button class="modal-close" onclick="closeDocModal()" style="position:static">&times;</button>' +
            '</div>' +
          '</div>' +
          '<iframe src="' + esc(fullUrl) + '" style="flex:1;border:none;width:100%;min-height:0" loading="lazy"></iframe>' +
        '</div>';
    } else {
      // MD/TXT：fetch 加载后用 marked 渲染
      modal.innerHTML =
        '<div class="modal-box" style="max-width:860px">' +
          '<button class="modal-close" onclick="closeDocModal()">&times;</button>' +
          '<div class="modal-body">' +
            '<h2 style="margin-bottom:1rem;font-size:1.4rem">' + esc(title) + ' - ' + t('btn_docs') + '</h2>' +
            '<div id="doc-modal-loading" style="text-align:center;padding:3rem;color:var(--text2)">' + t('loading') + '</div>' +
            '<div id="doc-modal-content" class="md-content" style="display:none"></div>' +
          '</div>' +
        '</div>';
    }
    document.body.appendChild(modal);
    requestAnimationFrame(function () { modal.classList.add('show'); });
    modal.addEventListener('click', function (e) { if (e.target === modal) closeDocModal(); });
    document.addEventListener('keydown', docEscHandler);
    // 非PDF时才 fetch 加载文档内容
    if (!isPdf) {
      // 加载文档内容：jsDelivr 支持跨域且全球加速，最可靠
      var urls = [];
      if (IS_LOCAL) {
        urls.push(fullUrl);
      } else {
        // jsDelivr 首选：免费、支持 CORS、速度快
        urls.push('https://cdn.jsdelivr.net/gh/ZeroOT-Liu/my-blog@main/' + docUrl);
        // GitHub raw 备用（也支持 CORS）
        urls.push('https://raw.githubusercontent.com/ZeroOT-Liu/my-blog/main/' + docUrl);
        // 同源加载备用（GitHub Pages 自身）
        urls.push(location.origin + (BASE ? BASE + '/' : '/') + docUrl);
      }
      fetchWithFallback(urls, 0);
    }
  };

  // 多 CDN 自动降级加载
  function fetchWithFallback(urls, index) {
    if (index >= urls.length) {
      var loading = document.getElementById('doc-modal-loading');
      if (loading) loading.textContent = t('doc_error');
      return;
    }
    fetch(urls[index])
      .then(function (r) {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.text();
      })
      .then(function (text) {
        var loading = document.getElementById('doc-modal-loading');
        var content = document.getElementById('doc-modal-content');
        if (!text) {
          fetchWithFallback(urls, index + 1);
          return;
        }
        content.innerHTML = md2html(text);
        loading.style.display = 'none';
        content.style.display = 'block';
      })
      .catch(function () {
        fetchWithFallback(urls, index + 1);
      });
  }

  window.closeDocModal = function () {
    var modal = document.getElementById('doc-modal');
    if (modal) {
      modal.classList.remove('show');
      setTimeout(function () { modal.remove(); }, 300);
    }
    document.removeEventListener('keydown', docEscHandler);
  };
  function docEscHandler(e) { if (e.key === 'Escape') window.closeDocModal(); }

  // ===========================
  // 相册 (gallery.json → array)
  // ===========================
  var _galData = [];
  var _categories = { article_categories: [], gallery_categories: [] };

  // 获取分类翻译
  function getCatTranslation(category, type) {
    if (!category) return category;
    // 先查 i18n 翻译表（cat_ 前缀）
    var i18nKey = 'cat_' + category;
    if (I18N[currentLang] && I18N[currentLang][i18nKey]) {
      return I18N[currentLang][i18nKey];
    }
    // 再查自定义分类列表
    var cats = type === 'gallery' ? _categories.gallery_categories : _categories.article_categories;
    for (var i = 0; i < cats.length; i++) {
      var cat = cats[i];
      var name = typeof cat === 'string' ? cat : cat.zh;
      var en = typeof cat === 'string' ? cat : (cat.en || cat.zh);
      if (name === category) {
        return currentLang === 'en' ? en : name;
      }
    }
    // 未找到分类，返回原名
    return category;
  }

  function renderGallery(list) {
    _galData = Array.isArray(list) ? list : [];
    var filtersEl = document.getElementById('gal-filters');
    var gridEl = document.getElementById('gallery-grid');
    if (!gridEl) return;

    if (_galData.length === 0) {
      if (filtersEl) filtersEl.innerHTML = '';
      gridEl.innerHTML = '<p style="color:var(--muted);text-align:center;grid-column:1/-1;padding:3rem;">' + t('empty_gallery') + '</p>';
      return;
    }

    // 分类（翻译后显示）
    var cats = [currentLang === 'zh' ? '全部' : 'All'];
    var catMap = {}; // 保存原始分类 -> 翻译后分类
    _galData.forEach(function (g) {
      if (g.category && cats.indexOf(g.category) < 0) {
        var translatedCat = getCatTranslation(g.category, 'gallery');
        catMap[g.category] = translatedCat;
        cats.push(g.category);
      }
    });
    if (filtersEl) {
      filtersEl.innerHTML = cats.map(function (c, i) {
        var displayCat = (c === '全部' || c === 'All') ? c : (catMap[c] || c);
        return '<button class="filter-btn' + (i === 0 ? ' active' : '') + '" data-cat="' + c + '">' + displayCat + '</button>';
      }).join('');
      filtersEl.addEventListener('click', function (e) {
        var btn = e.target.closest('.filter-btn');
        if (!btn) return;
        filtersEl.querySelectorAll('.filter-btn').forEach(function (b) { b.classList.remove('active'); });
        btn.classList.add('active');
        renderGalGrid(btn.getAttribute('data-cat'));
      });
    }
    renderGalGrid(cats[0]);
  }

  function renderGalGrid(cat) {
    var gridEl = document.getElementById('gallery-grid');
    if (!gridEl) return;
    var allLabel = currentLang === 'zh' ? '全部' : 'All';
    var filtered = cat === allLabel ? _galData : _galData.filter(function (g) { return g.category === cat; });
    if (filtered.length === 0) {
      gridEl.innerHTML = '<p style="color:var(--muted);text-align:center;grid-column:1/-1;padding:2rem;">' + t('empty_gal_cat') + '</p>';
      return;
    }
    // 首屏前6张显示骨架屏占位 + 懒加载，第6张之后用 data-src 懒加载
    gridEl.innerHTML = filtered.map(function (g, idx) {
      var imgSrc = g.image_url ? getImgUrl(g.image_url) : '';
      // 首屏前6张直接用 src，第6张之后用 data-src 懒加载
      var useLazy = idx >= 6;
      var img = '';
      if (imgSrc) {
        // 生成备用 CDN URL 列表
        var fallbackUrls = getImgFallbackUrls(g.image_url);
        var fallbackData = fallbackUrls.join('|');
        var fallbackAttr = fallbackData ? ' data-fallback="' + esc(fallbackData) + '"' : '';

        if (useLazy) {
          img = '<img data-src="' + imgSrc + '" alt="' + esc(g.title || '') + '" style="opacity:0"' + fallbackAttr + ' onload="this.classList.remove(\'img-skeleton\');this.classList.add(\'img-loaded\');this.style.opacity=\'\'" onerror="window._blogImgFallback(this)">';
        } else {
          // 首屏图片：骨架屏占位 + 加载完成后淡入
          img = '<span class="img-skeleton" style="position:absolute;inset:0;width:100%;height:100%;z-index:1"></span>' +
                '<img src="' + imgSrc + '" alt="' + esc(g.title || '') + '" style="position:relative;z-index:2;opacity:0;width:100%;height:100%;object-fit:cover"' + fallbackAttr + ' onload="this.style.opacity=\'1\';this.style.objectFit=\'cover\';this.previousElementSibling.style.display=\'none\'" onerror="window._blogImgFallback(this);this.style.opacity=\'1\';this.previousElementSibling.style.display=\'none\'">';
        }
      }
      var ph = !imgSrc ? '<div class="gal-ph">🖼️</div>' : '';
      return '<div class="gal-item fade-in" data-id="' + g.id + '">' +
        ph + img +
        '<div class="gal-overlay"><h4>' + esc(g.title || '') + '</h4><p>' + esc(g.description || '') + '</p></div>' +
      '</div>';
    }).join('');
    gridEl.querySelectorAll('.gal-item').forEach(function (el) {
      io.observe(el);
      el.addEventListener('click', function () {
        var id = el.getAttribute('data-id');
        var item = _galData.find(function (g) { return g.id == id; });
        if (item && item.image_url) openLightbox(item);
      });
    });
    // 启动懒加载观察器（图片即将进入视口时开始加载）
    gridEl.querySelectorAll('img[data-src]').forEach(function (img) {
      ImagePreloader.observe(img);
    });
  }

  // ===========================
  // 文章 (articles.json → array) + 搜索 + 分页
  // ===========================
  var _articles = [];
  var _artPage = 0;
  var _artPageSize = 6;
  var _artSearch = '';
  var _artTagFilter = '';
  var _artFiltered = [];

  function renderArticles(list) {
    _articles = Array.isArray(list) ? list : [];
    var published = _articles.filter(function (a) { return a.published !== false; });
    published.sort(function (a, b) { return new Date(b.updated_at || 0) - new Date(a.updated_at || 0); });
    _artFiltered = published;

    if (published.length === 0) {
      var el = document.getElementById('articles-grid');
      if (el) el.innerHTML = '<p class="art-empty">' + t('empty_articles') + '</p>';
      return;
    }

    // 收集所有标签
    var allTags = [];
    published.forEach(function (a) {
      (a.tags || []).forEach(function (tag) {
        if (allTags.indexOf(tag) < 0) allTags.push(tag);
      });
    });

    // 渲染标签筛选按钮
    var tagFiltersEl = document.getElementById('art-tag-filters');
    if (tagFiltersEl && allTags.length > 0) {
      tagFiltersEl.innerHTML = '<button class="art-tag-btn active" data-tag="">' + (currentLang === 'zh' ? '全部' : 'All') + '</button>' +
        allTags.map(function (tag) {
          return '<button class="art-tag-btn" data-tag="' + esc(tag) + '">' + esc(tag) + '</button>';
        }).join('');
      tagFiltersEl.addEventListener('click', function (e) {
        var btn = e.target.closest('.art-tag-btn');
        if (!btn) return;
        tagFiltersEl.querySelectorAll('.art-tag-btn').forEach(function (b) { b.classList.remove('active'); });
        btn.classList.add('active');
        _artTagFilter = btn.getAttribute('data-tag');
        _artPage = 0;
        filterAndRenderArticles();
      });
    }

    // 搜索框事件
    var searchEl = document.getElementById('art-search');
    if (searchEl) {
      searchEl.addEventListener('input', function () {
        _artSearch = this.value.trim().toLowerCase();
        _artPage = 0;
        filterAndRenderArticles();
      });
    }

    // 显示工具栏
    var toolbar = document.getElementById('art-toolbar');
    if (toolbar) toolbar.style.display = '';

    filterAndRenderArticles();
  }

  function filterAndRenderArticles() {
    var result = _artFiltered;

    // 标签筛选
    if (_artTagFilter) {
      result = result.filter(function (a) {
        return (a.tags || []).indexOf(_artTagFilter) >= 0;
      });
    }

    // 搜索筛选
    if (_artSearch) {
      result = result.filter(function (a) {
        var title = (a.title || '').toLowerCase();
        var summary = (a.summary || '').toLowerCase();
        var tags = (a.tags || []).join(' ').toLowerCase();
        var cat = (a.category || '').toLowerCase();
        return title.indexOf(_artSearch) >= 0 || summary.indexOf(_artSearch) >= 0 || tags.indexOf(_artSearch) >= 0 || cat.indexOf(_artSearch) >= 0;
      });
    }

    // 更新计数
    var countEl = document.getElementById('art-count');
    if (countEl) {
      countEl.textContent = result.length + '/' + _artFiltered.length;
    }

    // 分页渲染
    _artPage = 0;
    renderArticlePage(result);
  }

  function renderArticlePage(list) {
    var el = document.getElementById('articles-grid');
    if (!el) return;

    if (list.length === 0) {
      el.innerHTML = '<p class="art-empty">' + (_artSearch || _artTagFilter ? (currentLang === 'zh' ? '没有找到匹配的文章' : 'No matching articles') : t('empty_articles')) + '</p>';
      var loadMore = document.getElementById('art-load-more');
      if (loadMore) loadMore.style.display = 'none';
      return;
    }

    var end = Math.min((_artPage + 1) * _artPageSize, list.length);
    var pageItems = list.slice(0, end);

    el.innerHTML = pageItems.map(function (a) {
      var date = new Date(a.updated_at || a.created_at || Date.now()).toLocaleDateString('zh-CN');
      var summary = a.summary || (a.content || '').replace(/[#>*`\[\]\n]/g, '').trim().slice(0, 80) + '…';
      var thumb = '';
      if (a.cover_image) {
        var imgUrl = getImgUrl(a.cover_image);
        var isCached = ImagePreloader.cache.has(imgUrl);
        if (isCached) {
          thumb = '<img src="' + imgUrl + '" alt="" class="img-loaded" style="opacity:1;position:relative;z-index:2" onerror="this.style.display=\'none\'">';
        } else {
          thumb = '<span class="img-skeleton" style="position:absolute;inset:0;width:100%;height:100%;z-index:1"></span>' +
                  '<img src="' + imgUrl + '" alt="" style="position:relative;z-index:2;opacity:0" onload="this.style.opacity=\'1\';this.previousElementSibling.style.display=\'none\'" onerror="this.style.display=\'none\'">';
        }
      } else {
        thumb = '<span style="position:relative;z-index:1;font-size:2.5rem;">📄</span>';
      }
      return '<article class="art-card fade-in" data-id="' + a.id + '">' +
        '<div class="art-thumb" style="position:relative;background:#f0f0f0">' + thumb + '</div>' +
        '<div class="art-body">' +
          '<div class="art-meta"><span class="cat">' + esc(getCatTranslation(a.category, 'article') || '其他') + '</span><span>' + date + '</span></div>' +
          '<h3>' + esc(a.title) + '</h3>' +
          '<p>' + esc(summary) + '</p>' +
        '</div>' +
      '</article>';
    }).join('');

    el.querySelectorAll('.art-card').forEach(function (card) {
      io.observe(card);
      card.addEventListener('click', function () { openArticle(card.getAttribute('data-id')); });
    });
    el.querySelectorAll('img[data-src]').forEach(function (img) {
      ImagePreloader.observe(img);
    });

    // 加载更多按钮
    var loadMore = document.getElementById('art-load-more');
    var loadBtn = document.getElementById('art-load-btn');
    if (loadMore && loadBtn) {
      if (end < list.length) {
        loadMore.style.display = '';
        loadBtn.disabled = false;
        loadBtn.textContent = (currentLang === 'zh' ? '加载更多' : 'Load More') + ' (' + (list.length - end) + ')';
      } else {
        loadMore.style.display = 'none';
      }
    }
  }

  window.loadMoreArticles = function () {
    _artPage++;
    filterAndRenderArticles();
  };

  // ===========================
  // 关于 (about.json)
  // ===========================
  function renderAbout(about) {
    var titleEl = document.getElementById('about-title');
    if (titleEl && about.title) titleEl.textContent = about.title;

    var layout = document.getElementById('about-layout');
    if (layout && about.title) {
      var avatarContent = '';
      if (about.avatar_url) {
        // 使用统一的 getImgUrl 处理 CDN 和 WebP，加上备用 CDN 降级
        var avatarUrl = getImgUrl(about.avatar_url);
        var avatarFallbacks = getImgFallbackUrls(about.avatar_url);
        var avatarFallbackAttr = avatarFallbacks.length ? ' data-fallback="' + esc(avatarFallbacks.join('|')) + '"' : '';
        avatarContent = '<img src="' + avatarUrl + '" alt="avatar" style="width:100%;height:100%;object-fit:cover;border-radius:inherit"' + avatarFallbackAttr + ' onerror="window._blogImgFallback(this)">';
      } else {
        avatarContent = (about.avatar || '👤');
      }
      // 支持自定义背景色 icon_bg
      var avaBg = '';
      if (!about.avatar_url && about.icon_bg) {
        avaBg = 'style="background:' + about.icon_bg + '"';
      }
      var avatarHtml = '<div class="about-ava-wrap fade-in"><div class="about-ava" ' + avaBg + '>' + avatarContent + '</div></div>';
      var textHtml = '<div class="about-text fade-in">';
      if (about.subtitle) textHtml += '<p style="color:var(--accent);font-size:1.05rem;margin-bottom:1rem;">' + esc(about.subtitle) + '</p>';
      if (about.paragraphs && about.paragraphs.length > 0) {
        about.paragraphs.forEach(function (p) { textHtml += '<p>' + esc(p) + '</p>'; });
      }
      if (about.skills && about.skills.length > 0) {
        textHtml += '<div class="skills">' + about.skills.map(function (s) {
          return '<span class="skill-tag">' + esc(s) + '</span>';
        }).join('') + '</div>';
      }
      textHtml += '</div>';
      layout.innerHTML = avatarHtml + textHtml;
      observeAll(layout);
    }

    // 时间线
    var tlEl = document.getElementById('timeline');
    if (tlEl && about.timeline && about.timeline.length > 0) {
      tlEl.style.display = '';
      tlEl.innerHTML = '<h3 style="text-align:center;margin-bottom:2rem;font-size:1.4rem;">' + t('timeline_title') + '</h3>' +
        about.timeline.map(function (t) {
          return '<div class="tl-item fade-in"><div class="tl-dot"></div>' +
            '<div class="tl-body"><div class="tl-year">' + esc(t.year || '') + '</div>' +
            '<h4>' + esc(t.title || '') + '</h4>' +
            '<p>' + esc(t.description || '') + '</p></div></div>';
        }).join('');
      observeAll(tlEl);
    }
  }

  // ===========================
  // 联系方式 (contact.json → cards)
  // ===========================
  function renderContact(contact) {
    window._contactData = contact; // 保存用于语言切换重渲染
    var el = document.getElementById('contact-grid');
    if (!el) return;
    var cards = (contact.cards || []).filter(function (c) { return c.title; });
    if (cards.length === 0) {
      el.innerHTML = '<p style="color:var(--muted);text-align:center;grid-column:1/-1;padding:3rem;">' + t('empty_contact') + '</p>';
    } else {
      el.innerHTML = cards.map(function (c) {
        return '<div class="contact-card fade-in">' +
          '<div class="contact-icon">' + (c.icon || '📧') + '</div>' +
          '<div><h4>' + esc(c.title) + '</h4><p>' + esc(c.value || '') + '</p></div>' +
        '</div>';
      }).join('');
    }

    // 渲染 Footer 联系方式列表
    var footerContactList = document.getElementById('footer-contact-list');
    if (footerContactList) {
      if (cards.length === 0) {
        footerContactList.innerHTML = '<li style="color:var(--muted)">' + t('empty_contact') + '</li>';
      } else {
        footerContactList.innerHTML = cards.slice(0, 4).map(function (c) {
          return '<li>' + (c.icon || '') + ' ' + esc(c.title) + ': ' + esc(c.value || '') + '</li>';
        }).join('');
      }
    }

    observeAll(el);
  }

  // ===========================
  // 文章 Modal
  // ===========================
  function openArticle(id) {
    var a = _articles.find(function (x) { return x.id == id; });
    if (!a) return;
    var modal = document.getElementById('art-modal');
    var content = document.getElementById('art-modal-content');
    var readTimeEl = document.getElementById('art-reading-time');
    if (!modal || !content) return;
    var date = new Date(a.updated_at || a.created_at || Date.now()).toLocaleDateString('zh-CN');
    var tags = (a.tags || []).map(function (t) { return '<span style="background:var(--soft);color:var(--accent);padding:2px 8px;border-radius:6px;font-size:.78rem;">' + esc(t) + '</span>'; }).join(' ');

    // 计算阅读时间（中文按字数，英文按单词）
    var rawText = a.content || '';
    var charCount = rawText.replace(/\s/g, '').length;
    var readMin = Math.max(1, Math.ceil(charCount / 400));
    if (readTimeEl) {
      readTimeEl.innerHTML = '📖 ' + t('reading_time').replace('{n}', readMin);
    }

    // 优先从 doc_url 加载文档内容
    if (a.doc_url) {
      content.innerHTML = '<div style="color:var(--muted);font-size:.88rem;">' + t('loading') + '</div>';
      fetchDocContent(a.doc_url, function(docContent) {
        content.innerHTML =
          '<p style="color:var(--muted);font-size:.88rem;">' + date + ' · ' + esc(getCatTranslation(a.category, 'article') || '其他') + '</p>' +
          '<h1 style="margin:.6rem 0 1rem;font-size:1.8rem;line-height:1.3">' + esc(a.title) + '</h1>' +
          (tags ? '<div style="margin-bottom:1.5rem;display:flex;gap:.4rem;flex-wrap:wrap;">' + tags + '</div>' : '') +
          (docContent ? md2html(docContent) : '<p style="color:var(--err);">' + t('doc_error') + '</p>');
      });
    } else {
      content.innerHTML =
        '<p style="color:var(--muted);font-size:.88rem;">' + date + ' · ' + esc(getCatTranslation(a.category, 'article') || '其他') + '</p>' +
        '<h1 style="margin:.6rem 0 1rem;font-size:1.8rem;line-height:1.3">' + esc(a.title) + '</h1>' +
        (tags ? '<div style="margin-bottom:1.5rem;display:flex;gap:.4rem;flex-wrap:wrap;">' + tags + '</div>' : '') +
        md2html(a.content || '');
    }
    modal.classList.add('show');
    document.body.style.overflow = 'hidden';

    // 监听弹窗滚动以更新阅读进度
    var modalBody = modal.querySelector('.modal-body');
    if (modalBody) {
      modalBody.onscroll = function() {
        var rp = document.getElementById('reading-progress');
        if (!rp) return;
        var scrollTop = modalBody.scrollTop;
        var scrollHeight = modalBody.scrollHeight - modalBody.clientHeight;
        rp.style.width = (scrollHeight > 0 ? (scrollTop / scrollHeight * 100) : 0) + '%';
      };
    }
  }

  // 加载外部文档内容
  function fetchDocContent(docUrl, callback) {
    // 对 URL 路径进行编码（处理中文和特殊字符文件名）
    var encodedUrl = docUrl.split('/').map(function(part) {
      return encodeURIComponent(part);
    }).join('/');
    var fullUrl = getDocUrl(encodedUrl);
    fetch(fullUrl)
      .then(function(r) { return r.text(); })
      .then(function(text) { callback(text); })
      .catch(function() { callback(null); });
  }

  function closeArticle() {
    var modal = document.getElementById('art-modal');
    if (modal) modal.classList.remove('show');
    document.body.style.overflow = '';
    var rp = document.getElementById('reading-progress');
    if (rp) rp.style.width = '0%';
  }

  // ===========================
  // 灯箱（支持上下切换）
  // ===========================
  var _lbCurrentIndex = -1;
  var _lbList = [];

  function openLightbox(item) {
    var lb = document.getElementById('lightbox');
    var img = document.getElementById('lb-img');
    var cap = document.getElementById('lb-caption');
    var counter = document.getElementById('lb-counter');
    if (!lb || !img) return;

    // 构建当前筛选后的图片列表
    _lbList = _galData.filter(function (g) { return g.image_url; });
    _lbCurrentIndex = _lbList.findIndex(function (g) { return g.id === item.id; });

    showLightboxItem(_lbCurrentIndex);
    lb.classList.add('show');
    document.body.style.overflow = 'hidden';
  }

  function showLightboxItem(idx) {
    if (idx < 0 || idx >= _lbList.length) return;
    _lbCurrentIndex = idx;
    var item = _lbList[idx];
    var img = document.getElementById('lb-img');
    var cap = document.getElementById('lb-caption');
    var counter = document.getElementById('lb-counter');
    img.src = getImgUrl(item.image_url);
    img.alt = item.title || '';
    if (cap) cap.innerHTML = '<strong>' + esc(item.title || '') + '</strong>' + (item.description ? '<br>' + esc(item.description) : '');
    if (counter) counter.textContent = (idx + 1) + ' / ' + _lbList.length;
  }

  function lbPrev() {
    if (_lbCurrentIndex > 0) showLightboxItem(_lbCurrentIndex - 1);
  }

  function lbNext() {
    if (_lbCurrentIndex < _lbList.length - 1) showLightboxItem(_lbCurrentIndex + 1);
  }

  function closeLightbox() {
    var lb = document.getElementById('lightbox');
    if (lb) lb.classList.remove('show');
    document.body.style.overflow = '';
    _lbCurrentIndex = -1;
  }

  // 灯箱按钮事件
  window.addEventListener('load', function() {
    var lbPrevBtn = document.getElementById('lb-prev');
    var lbNextBtn = document.getElementById('lb-next');
    if (lbPrevBtn) lbPrevBtn.addEventListener('click', function(e) { e.stopPropagation(); lbPrev(); });
    if (lbNextBtn) lbNextBtn.addEventListener('click', function(e) { e.stopPropagation(); lbNext(); });
    // 键盘左右切换
    document.addEventListener('keydown', function(e) {
      var lb = document.getElementById('lightbox');
      if (!lb || !lb.classList.contains('show')) return;
      if (e.key === 'ArrowLeft') lbPrev();
      if (e.key === 'ArrowRight') lbNext();
    });
  });

  // ===========================
  // Markdown → HTML（使用 marked.js）
  // ===========================
  function md2html(text) {
    if (!text) return '';
    if (typeof marked === 'undefined') {
      console.error('marked.js 未加载');
      return '<pre>' + esc(text) + '</pre>';
    }
    var html = marked.parse(text, { breaks: true, gfm: true });
    // 所有链接新窗口打开
    html = html.replace(/<a /g, '<a target="_blank" rel="noopener noreferrer" ');
    // 处理图片路径：相对路径转 CDN URL
    html = html.replace(/<img\s+([^>]*?)src="([^"]+)"([^>]*)>/g, function(match, before, src, after) {
      // 跳过已经是 http 开头的
      if (src.startsWith('http') || src.startsWith('data:')) return match;
      // 跳过空路径
      if (!src || src === '#') return match;
      // 获取 CDN URL
      var fullUrl = getImgUrl(src);
      // 生成备用 CDN
      var fallbacks = getImgFallbackUrls(src);
      var fallbackAttr = fallbacks.length ? ' data-fallback="' + esc(fallbacks.join('|')) + '"' : '';
      return '<img ' + before + 'src="' + fullUrl + '"' + after + fallbackAttr + ' onerror="window._blogImgFallback(this)">';
    });
    return html;
  }

  // ===========================
  // 工具函数
  // ===========================
  function esc(s) {
    if (s === null || s === undefined) return '';
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  // ===========================
  // 页面加载动画
  // ===========================
  function dismissLoader() {
    var loader = document.getElementById('page-loader');
    if (loader) {
      loader.classList.add('loaded');
      setTimeout(function() { loader.remove(); }, 700);
    }
  }

  // 数据加载完成后关闭 loader
  window.addEventListener('load', function() {
    setTimeout(dismissLoader, 400);
  });

  // ===========================
  // Hero 打字机效果
  // ===========================
  function typewriterEffect(el, text, callback) {
    if (!el || !text) { if (callback) callback(); return; }
    el.innerHTML = '';
    var i = 0;
    var cursor = document.createElement('span');
    cursor.className = 'typewriter-cursor';
    el.appendChild(cursor);

    function type() {
      if (i < text.length) {
        // 遇到 HTML 标签时整体插入
        if (text[i] === '<') {
          var closeIdx = text.indexOf('>', i);
          if (closeIdx !== -1) {
            var tag = text.substring(i, closeIdx + 1);
            el.insertBefore(document.createRange().createContextualFragment(tag), cursor);
            i = closeIdx + 1;
            setTimeout(type, 30);
            return;
          }
        }
        el.insertBefore(document.createTextNode(text[i]), cursor);
        i++;
        setTimeout(type, 60 + Math.random() * 40);
      } else {
        // 打字完成，1秒后移除光标
        setTimeout(function() {
          if (cursor.parentNode) cursor.remove();
          if (callback) callback();
        }, 1000);
      }
    }
    type();
  }

  // 包装 renderHero，打字机效果
  var _originalRenderHero = renderHero;
  renderHero = function(hero) {
    _originalRenderHero(hero);

    // 打字机效果：对 hero h1 应用
    var titleEl = document.getElementById('hero-title');
    if (titleEl && titleEl.innerHTML.trim()) {
      var html = titleEl.innerHTML;
      typewriterEffect(titleEl, html);
    }
  };

  // ===========================
  // 数字滚动动画（统计数字）
  // ===========================
  function animateCounter(el, target, suffix, duration) {
    suffix = suffix || '';
    duration = duration || 1500;
    var start = 0;
    var startTime = null;

    function step(timestamp) {
      if (!startTime) startTime = timestamp;
      var progress = Math.min((timestamp - startTime) / duration, 1);
      // easeOutExpo 缓动
      var eased = 1 - Math.pow(1 - progress, 3);
      var current = Math.floor(eased * target);
      el.textContent = current + suffix;
      if (progress < 1) {
        requestAnimationFrame(step);
      } else {
        el.textContent = target + suffix;
      }
    }
    requestAnimationFrame(step);
  }

  // 监听统计数字进入视口
  var _statsObserved = false;
  function initStatsAnimation() {
    if (_statsObserved) return;
    var statsEl = document.getElementById('hero-stats');
    if (!statsEl) return;

    var observer = new IntersectionObserver(function(entries) {
      entries.forEach(function(entry) {
        if (entry.isIntersecting && !_statsObserved) {
          _statsObserved = true;
          observer.disconnect();
          var nums = statsEl.querySelectorAll('.stat-num');
          nums.forEach(function(numEl) {
            var text = numEl.textContent.trim();
            var match = text.match(/^(\d+)(.*)$/);
            if (match) {
              var target = parseInt(match[1]);
              var sfx = match[2] || '';
              animateCounter(numEl, target, sfx);
            }
          });
        }
      });
    }, { threshold: 0.5 });
    observer.observe(statsEl);
  }

  // 在 loadAll 完成后初始化数字动画
  var _originalLoadAll = loadAll;
  // 用 MutationObserver 监听 stats 出现
  var _statsWatchTimer = setInterval(function() {
    var statsEl = document.getElementById('hero-stats');
    if (statsEl && statsEl.style.display !== 'none' && statsEl.children.length > 0) {
      clearInterval(_statsWatchTimer);
      initStatsAnimation();
    }
  }, 200);
  // 10秒后停止监听，防止永远跑
  setTimeout(function() { clearInterval(_statsWatchTimer); }, 10000);

  // ===========================
  // 3D 倾斜卡片效果
  // ===========================
  function initTiltCards() {
    var selector = '.proj-card, .art-card, .gal-item, .contact-card';
    document.querySelectorAll(selector).forEach(function(card) {
      if (card._tiltInit) return;
      card._tiltInit = true;
      card.classList.add('tilt-card');

      card.addEventListener('mousemove', function(e) {
        var rect = card.getBoundingClientRect();
        var x = e.clientX - rect.left;
        var y = e.clientY - rect.top;
        var centerX = rect.width / 2;
        var centerY = rect.height / 2;
        var rotateX = (y - centerY) / centerY * -6;
        var rotateY = (x - centerX) / centerX * 6;
        card.style.transform = 'perspective(800px) rotateX(' + rotateX + 'deg) rotateY(' + rotateY + 'deg) scale(1.02)';
      });

      card.addEventListener('mouseleave', function() {
        card.style.transform = '';
      });
    });
  }

  // 用 MutationObserver 监听卡片出现后初始化
  var _tiltObserver = new MutationObserver(function() {
    initTiltCards();
  });
  _tiltObserver.observe(document.body, { childList: true, subtree: true });
  // 首次也执行一次
  setTimeout(initTiltCards, 500);

  // ===========================
  // 颜色调色板（所有动效共用）
  // ===========================
  var COLOR_PALETTE = [
    { r: 99, g: 102, b: 241 },   // 靛蓝
    { r: 139, g: 92, b: 246 },   // 紫色
    { r: 236, g: 72, b: 153 },   // 粉红
    { r: 244, g: 63, b: 94 },    // 玫瑰
    { r: 249, g: 115, b: 22 },   // 橙色
    { r: 245, g: 158, b: 11 },   // 琥珀
    { r: 16, g: 185, b: 129 },   // 翡翠
    { r: 6, g: 182, b: 212 },    // 青色
    { r: 59, g: 130, b: 246 },   // 蓝色
  ];
  var _colorTick = 0;
  function getColorByTime() {
    _colorTick += 0.003;
    var idx = Math.floor(_colorTick) % COLOR_PALETTE.length;
    var next = (idx + 1) % COLOR_PALETTE.length;
    var t = _colorTick - Math.floor(_colorTick);
    // 线性插值
    return {
      r: Math.round(COLOR_PALETTE[idx].r + (COLOR_PALETTE[next].r - COLOR_PALETTE[idx].r) * t),
      g: Math.round(COLOR_PALETTE[idx].g + (COLOR_PALETTE[next].g - COLOR_PALETTE[idx].g) * t),
      b: Math.round(COLOR_PALETTE[idx].b + (COLOR_PALETTE[next].b - COLOR_PALETTE[idx].b) * t)
    };
  }

  // ===========================
  // Hero 粒子动画（Canvas）
  // ===========================
  function initParticles() {
    var canvas = document.getElementById('particles-canvas');
    if (!canvas) return;
    var ctx = canvas.getContext('2d');
    var particles = [];
    var mouse = { x: -1000, y: -1000 };
    var PARTICLE_COUNT = 60;
    var CONNECT_DIST = 140;
    var dpr = window.devicePixelRatio || 1;

    function resize() {
      var hero = canvas.parentElement;
      canvas.width = hero.offsetWidth * dpr;
      canvas.height = hero.offsetHeight * dpr;
      canvas.style.width = hero.offsetWidth + 'px';
      canvas.style.height = hero.offsetHeight + 'px';
      ctx.scale(dpr, dpr);
    }
    resize();
    window.addEventListener('resize', resize);

    // 创建粒子
    var w = canvas.parentElement.offsetWidth;
    var h = canvas.parentElement.offsetHeight;
    for (var i = 0; i < PARTICLE_COUNT; i++) {
      particles.push({
        x: Math.random() * w,
        y: Math.random() * h,
        vx: (Math.random() - 0.5) * 0.6,
        vy: (Math.random() - 0.5) * 0.6,
        r: Math.random() * 2 + 1
      });
    }

    // 鼠标跟踪
    canvas.parentElement.addEventListener('mousemove', function(e) {
      var rect = canvas.getBoundingClientRect();
      mouse.x = e.clientX - rect.left;
      mouse.y = e.clientY - rect.top;
    });
    canvas.parentElement.addEventListener('mouseleave', function() {
      mouse.x = -1000; mouse.y = -1000;
    });

    function getAccentRGB() {
      var style = getComputedStyle(document.documentElement);
      var accent = style.getPropertyValue('--accent').trim() || '#6366f1';
      var hex = accent.replace('#', '');
      if (hex.length === 3) hex = hex[0]+hex[0]+hex[1]+hex[1]+hex[2]+hex[2];
      return {
        r: parseInt(hex.substring(0,2), 16),
        g: parseInt(hex.substring(2,4), 16),
        b: parseInt(hex.substring(4,6), 16)
      };
    }

    function animate() {
      var w2 = canvas.parentElement.offsetWidth;
      var h2 = canvas.parentElement.offsetHeight;
      ctx.clearRect(0, 0, w2, h2);

      var rgb = getColorByTime();

      // 更新和绘制粒子
      for (var i = 0; i < particles.length; i++) {
        var p = particles[i];
        p.x += p.vx;
        p.y += p.vy;
        if (p.x < 0 || p.x > w2) p.vx *= -1;
        if (p.y < 0 || p.y > h2) p.vy *= -1;

        // 鼠标吸引
        var dx = mouse.x - p.x;
        var dy = mouse.y - p.y;
        var dist = Math.sqrt(dx*dx + dy*dy);
        if (dist < 200) {
          p.x += dx * 0.008;
          p.y += dy * 0.008;
        }

        ctx.beginPath();
        ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
        ctx.fillStyle = 'rgba(' + rgb.r + ',' + rgb.g + ',' + rgb.b + ',0.4)';
        ctx.fill();

        // 连线
        for (var j = i + 1; j < particles.length; j++) {
          var p2 = particles[j];
          var d = Math.sqrt((p.x-p2.x)*(p.x-p2.x) + (p.y-p2.y)*(p.y-p2.y));
          if (d < CONNECT_DIST) {
            ctx.beginPath();
            ctx.moveTo(p.x, p.y);
            ctx.lineTo(p2.x, p2.y);
            ctx.strokeStyle = 'rgba(' + rgb.r + ',' + rgb.g + ',' + rgb.b + ',' + (0.15 * (1 - d/CONNECT_DIST)) + ')';
            ctx.lineWidth = 0.6;
            ctx.stroke();
          }
        }
      }
      requestAnimationFrame(animate);
    }
    animate();
  }
  window.addEventListener('load', function() { setTimeout(initParticles, 300); });

  // ===========================
  // 鼠标拖尾粒子效果
  // ===========================
  (function() {
    var canvas = document.getElementById('trail-canvas');
    if (!canvas) return;
    var ctx = canvas.getContext('2d');
    var particles = [];
    var mouse = { x: -100, y: -100 };
    var prevMouse = { x: -100, y: -100 };
    var dpr = window.devicePixelRatio || 1;

    function resize() {
      canvas.width = window.innerWidth * dpr;
      canvas.height = window.innerHeight * dpr;
      canvas.style.width = window.innerWidth + 'px';
      canvas.style.height = window.innerHeight + 'px';
      ctx.scale(dpr, dpr);
    }
    resize();
    window.addEventListener('resize', resize);

    document.addEventListener('mousemove', function(e) {
      prevMouse.x = mouse.x;
      prevMouse.y = mouse.y;
      mouse.x = e.clientX;
      mouse.y = e.clientY;

      var dx = mouse.x - prevMouse.x;
      var dy = mouse.y - prevMouse.y;
      var speed = Math.sqrt(dx * dx + dy * dy);
      var count = Math.min(Math.floor(speed / 5), 3);

      for (var i = 0; i < count; i++) {
        var t = i / count;
        particles.push({
          x: prevMouse.x + dx * t + (Math.random() - 0.5) * 4,
          y: prevMouse.y + dy * t + (Math.random() - 0.5) * 4,
          vx: (Math.random() - 0.5) * 0.5,
          vy: (Math.random() - 0.5) * 0.5,
          life: 1,
          decay: 0.025 + Math.random() * 0.025,
          size: 2 + Math.random() * 2
        });
      }
    });

    function getAccentColor() {
      var style = getComputedStyle(document.documentElement);
      var accent = style.getPropertyValue('--accent').trim() || '#6366f1';
      var hex = accent.replace('#', '');
      if (hex.length === 3) hex = hex[0]+hex[0]+hex[1]+hex[1]+hex[2]+hex[2];
      return {
        r: parseInt(hex.substring(0,2), 16),
        g: parseInt(hex.substring(2,4), 16),
        b: parseInt(hex.substring(4,6), 16)
      };
    }

    function animate() {
      ctx.clearRect(0, 0, window.innerWidth, window.innerHeight);
      var rgb = getColorByTime();

      for (var i = particles.length - 1; i >= 0; i--) {
        var p = particles[i];
        p.x += p.vx;
        p.y += p.vy;
        p.life -= p.decay;
        p.vx *= 0.98;
        p.vy *= 0.98;

        if (p.life <= 0) { particles.splice(i, 1); continue; }

        var alpha = p.life * 0.7;
        var size = p.size * p.life;

        // 外发光
        ctx.beginPath();
        ctx.arc(p.x, p.y, size * 2, 0, Math.PI * 2);
        ctx.fillStyle = 'rgba(' + rgb.r + ',' + rgb.g + ',' + rgb.b + ',' + (alpha * 0.2) + ')';
        ctx.fill();

        // 内核
        ctx.beginPath();
        ctx.arc(p.x, p.y, size, 0, Math.PI * 2);
        ctx.fillStyle = 'rgba(' + rgb.r + ',' + rgb.g + ',' + rgb.b + ',' + alpha + ')';
        ctx.fill();

        // 白色高光
        if (p.life > 0.5) {
          ctx.beginPath();
          ctx.arc(p.x, p.y, size * 0.4, 0, Math.PI * 2);
          ctx.fillStyle = 'rgba(255,255,255,' + (alpha * 0.6) + ')';
          ctx.fill();
        }
      }

      if (particles.length > 150) particles = particles.slice(-150);
      requestAnimationFrame(animate);
    }
    animate();
  })();

  // ===========================
  // 交错入场动画（卡片依次出现）
  // ===========================
  function initStaggerReveal() {
    var io2 = new IntersectionObserver(function(entries) {
      entries.forEach(function(entry) {
        if (entry.isIntersecting) {
          var el = entry.target;
          var delay = parseInt(el.getAttribute('data-delay') || '0');
          setTimeout(function() { el.classList.add('vis'); }, delay);
          io2.unobserve(el);
        }
      });
    }, { threshold: 0.1 });

    // 作品卡片
    document.querySelectorAll('.proj-card').forEach(function(card, i) {
      if (card.classList.contains('vis')) return;
      card.classList.add('stagger-item');
      card.setAttribute('data-delay', String(i * 120));
      io2.observe(card);
    });
    // 文章卡片
    document.querySelectorAll('.art-card').forEach(function(card, i) {
      if (card.classList.contains('vis')) return;
      card.classList.add('stagger-item');
      card.setAttribute('data-delay', String(i * 120));
      io2.observe(card);
    });
    // 相册卡片
    document.querySelectorAll('.gal-item').forEach(function(item, i) {
      if (item.classList.contains('vis')) return;
      item.classList.add('stagger-item');
      item.setAttribute('data-delay', String(i * 80));
      io2.observe(item);
    });
    // 联系卡片（从两侧交错进入）
    document.querySelectorAll('.contact-card').forEach(function(card, i) {
      if (card.classList.contains('vis')) return;
      card.classList.add(i % 2 === 0 ? 'stagger-left' : 'stagger-right');
      card.setAttribute('data-delay', String(i * 150));
      io2.observe(card);
    });
    // 时间线（从左滑入）
    document.querySelectorAll('.tl-item').forEach(function(item, i) {
      if (item.classList.contains('vis')) return;
      item.classList.add('stagger-left');
      item.setAttribute('data-delay', String(i * 150));
      io2.observe(item);
    });
    // 技能标签（缩放淡入）
    document.querySelectorAll('.skill-tag').forEach(function(tag, i) {
      if (tag.classList.contains('vis')) return;
      tag.classList.add('stagger-scale');
      tag.setAttribute('data-delay', String(i * 60));
      io2.observe(tag);
    });
  }
  // 数据渲染后初始化
  var _staggerTimer = setInterval(function() {
    if (document.querySelectorAll('.proj-card, .art-card, .gal-item').length > 0) {
      clearInterval(_staggerTimer);
      initStaggerReveal();
    }
  }, 300);
  setTimeout(function() { clearInterval(_staggerTimer); }, 10000);
  // MutationObserver 动态监听新卡片
  var _staggerMO = new MutationObserver(function() { initStaggerReveal(); });
  _staggerMO.observe(document.body, { childList: true, subtree: true });

  // ===========================
  // 点击涟漪效果
  // ===========================
  document.addEventListener('click', function(e) {
    // 不在弹窗、灯箱、导航按钮上触发
    if (e.target.closest('.modal, .lightbox, .video-modal, .theme-panel, .theme-btn, .lang-btn, .hamburger, button, a, input, select, textarea')) return;
    var ripple = document.createElement('div');
    ripple.className = 'ripple';
    ripple.style.left = e.clientX + 'px';
    ripple.style.top = e.clientY + 'px';
    document.body.appendChild(ripple);
    setTimeout(function() { ripple.remove(); }, 650);
  });

  // ===========================
  // 磁性按钮效果
  // ===========================
  function initMagneticBtns() {
    document.querySelectorAll('.btn, .proj-link, .proj-video-link, .proj-doc-link, .filter-btn').forEach(function(btn) {
      if (btn._magInit) return;
      btn._magInit = true;
      btn.classList.add('mag-btn');

      btn.addEventListener('mousemove', function(e) {
        var rect = btn.getBoundingClientRect();
        var x = e.clientX - rect.left - rect.width / 2;
        var y = e.clientY - rect.top - rect.height / 2;
        btn.style.transform = 'translate(' + (x * 0.2) + 'px,' + (y * 0.2) + 'px)';
      });
      btn.addEventListener('mouseleave', function() {
        btn.style.transform = '';
      });
    });
  }
  var _magTimer = setInterval(function() {
    if (document.querySelectorAll('.btn').length > 0) {
      clearInterval(_magTimer);
      initMagneticBtns();
    }
  }, 500);
  setTimeout(function() { clearInterval(_magTimer); }, 10000);
  var _magMO = new MutationObserver(function() { initMagneticBtns(); });
  _magMO.observe(document.body, { childList: true, subtree: true });

  // ===========================
  // 联系卡片鼠标跟随光晕
  // ===========================
  document.querySelectorAll('.contact-grid').forEach(function(grid) {
    grid.addEventListener('mousemove', function(e) {
      var card = e.target.closest('.contact-card');
      if (!card) return;
      var rect = card.getBoundingClientRect();
      var x = ((e.clientX - rect.left) / rect.width * 100);
      var y = ((e.clientY - rect.top) / rect.height * 100);
      card.style.setProperty('--mx', x + '%');
      card.style.setProperty('--my', y + '%');
    });
  });

  // ===========================
  // 视差滚动（区块错位移动）
  // ===========================
  function initParallax() {
    var sections = document.querySelectorAll('.parallax-section');
    if (sections.length === 0) {
      // 首次给各区块添加类
      document.querySelectorAll('.section').forEach(function(s, i) {
        if (i % 2 === 1) s.classList.add('parallax-section');
      });
    }
    window.addEventListener('scroll', function() {
      var scrollY = window.scrollY;
      document.querySelectorAll('.parallax-section').forEach(function(s) {
        var rect = s.getBoundingClientRect();
        var offset = (rect.top + rect.height / 2 - window.innerHeight / 2) * 0.04;
        s.style.transform = 'translateY(' + offset + 'px)';
      });
    }, { passive: true });
  }
  initParallax();

})();
