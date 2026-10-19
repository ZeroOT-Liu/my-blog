/* =========================================================
   blog3d.js — 博客 3D 增强层
   ---------------------------------------------------------
   与 index.js 完全解耦：只读 DOM、只加 class、只写 transform。
   1) Hero 区 Three.js 线框场景（鼠标视差 + 滚动驱动）
   2) 作品 / 相册 / 文章卡片的 3D 倾斜跟随
   3) 主题切换时 3D 线框同步换色
   4) 设备 / 偏好降级：无 WebGL、省电模式、reduced-motion
   ========================================================= */
(function () {
  'use strict';

  var reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  var canHover = window.matchMedia('(hover: hover)').matches;
  var isMobile = window.innerWidth < 780;

  /* =========================================================
     一、卡片 3D 倾斜
     ========================================================= */
  var TILT_SELECTOR = '.proj-card, .gal-item, .art-card';
  var tiltEl = null;
  var rafId = null;
  var lastEvent = null;

  function maxTiltFor(el) {
    if (el.classList.contains('gal-item')) return 7;
    if (el.classList.contains('art-card')) return 3.5;
    return 5.5;
  }

  function applyTilt() {
    rafId = null;
    if (!lastEvent || !tiltEl) return;
    var e = lastEvent;
    var r = tiltEl.getBoundingClientRect();
    if (!r.width || !r.height) return;

    var px = (e.clientX - r.left) / r.width - 0.5;
    var py = (e.clientY - r.top) / r.height - 0.5;
    var max = maxTiltFor(tiltEl);

    // 超出卡片范围就跳过
    if (Math.abs(px) > 0.62 || Math.abs(py) > 0.62) { clearTilt(); return; }

    tiltEl.classList.add('tilting');
    tiltEl.style.transform =
      'perspective(1000px)' +
      ' rotateY(' + (px * max).toFixed(2) + 'deg)' +
      ' rotateX(' + (-py * max).toFixed(2) + 'deg)' +
      ' translateY(-3px)' +
      ' translateZ(10px)';
  }

  function clearTilt() {
    if (tiltEl) {
      tiltEl.classList.remove('tilting');
      tiltEl.style.transform = '';
      tiltEl.style.removeProperty('--mx');
      tiltEl.style.removeProperty('--my');
    }
    tiltEl = null;
  }

  function onPointerMove(e) {
    if (!canHover || reduceMotion) return;

    var target = e.target && e.target.closest ? e.target.closest(TILT_SELECTOR) : null;

    if (target !== tiltEl) {
      clearTilt();
      tiltEl = target;
    }
    if (!tiltEl) return;

    // 联系卡片的光斑跟随（顺带处理）
    var cc = e.target.closest && e.target.closest('.contact-card');
    if (cc) {
      var cr = cc.getBoundingClientRect();
      cc.style.setProperty('--mx', ((e.clientX - cr.left) / cr.width * 100).toFixed(1) + '%');
      cc.style.setProperty('--my', ((e.clientY - cr.top) / cr.height * 100).toFixed(1) + '%');
    }

    lastEvent = e;
    if (!rafId) rafId = requestAnimationFrame(applyTilt);
  }

  document.addEventListener('pointermove', onPointerMove, { passive: true });
  document.addEventListener('pointerleave', function () { clearTilt(); }, { passive: true });
  window.addEventListener('blur', clearTilt);

  /* =========================================================
     二、Hero 3D 场景
     ========================================================= */
  // 用 min 版：1.27MB → 670KB，省一半带宽
  var CDNS = [
    'https://cdn.jsdelivr.net/npm/three@0.160.0/build/three.module.min.js',
    'https://unpkg.com/three@0.160.0/build/three.module.min.js',
    'https://esm.sh/three@0.160.0'
  ];

  var THREE = null;

  function loadThree() {
    var i = 0;
    function next() {
      if (i >= CDNS.length) return Promise.reject(new Error('cdn exhausted'));
      var url = CDNS[i++];
      return import(url).catch(function () { return next(); });
    }
    return next();
  }

  var state = { tx: 0, ty: 0, sx: 0, sy: 0, scroll: 0, scrollS: 0 };

  window.addEventListener('pointermove', function (e) {
    if (!canHover) return;
    state.tx = (e.clientX / window.innerWidth - 0.5) * 2;
    state.ty = (e.clientY / window.innerHeight - 0.5) * 2;
  }, { passive: true });

  function readScroll() {
    var h = window.innerHeight || 1;
    var p = window.scrollY / (h * 0.92);
    state.scroll = p < 0 ? 0 : p > 1 ? 1 : p;
  }
  window.addEventListener('scroll', readScroll, { passive: true });
  readScroll();

  // 从 CSS 变量取色，主题切换时同步
  function themeColors() {
    var cs = getComputedStyle(document.documentElement);
    function v(name, fallback) {
      var s = (cs.getPropertyValue(name) || '').trim();
      return s || fallback;
    }
    return {
      accent: v('--accent', '#1b4a75'),
      accent2: v('--accent2', '#d9553a'),
      muted: v('--muted', '#93a0ac'),
      gridLine: v('--grid-line', 'rgba(23,41,59,.06)')
    };
  }

  function initScene() {
    var stageEl = document.getElementById('stage');
    var canvas = document.getElementById('c');
    if (!stageEl || !canvas) return;

    var renderer;
    try {
      renderer = new THREE.WebGLRenderer({
        canvas: canvas, antialias: true, alpha: true,
        powerPreference: 'high-performance'
      });
    } catch (err) {
      document.body.classList.add('no-3d');
      return;
    }

    var W = window.innerWidth, H = window.innerHeight;
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.setSize(W, H, false);

    var scene = new THREE.Scene();
    var camera = new THREE.PerspectiveCamera(45, W / H, 0.1, 200);
    camera.position.set(0, 0.3, 7);
    camera.lookAt(0, 0, 0);

    var root = new THREE.Group();
    scene.add(root);

    var C = themeColors();
    var mats = [];

    function lineMat(color, opacity) {
      var m = new THREE.LineBasicMaterial({ color: color, transparent: true, opacity: opacity });
      mats.push({ mat: m, kind: 'line', base: opacity });
      return m;
    }

    // --- 核心二十面体 ---
    var core = new THREE.LineSegments(
      new THREE.EdgesGeometry(new THREE.IcosahedronGeometry(1.05, 0)),
      lineMat(C.accent, 0.9)
    );
    root.add(core);

    // --- 内层十二面体（强调色，反向自转） ---
    var inner = new THREE.LineSegments(
      new THREE.EdgesGeometry(new THREE.DodecahedronGeometry(0.62, 0)),
      lineMat(C.accent2, 0.72)
    );
    root.add(inner);

    // --- 中层包围盒 ---
    var boxMid = new THREE.LineSegments(
      new THREE.EdgesGeometry(new THREE.BoxGeometry(2.4, 2.4, 2.4)),
      lineMat(C.accent, 0.24)
    );
    boxMid.rotation.set(0.44, 0.62, 0.1);
    root.add(boxMid);

    // --- 外层虚线大盒（工程标注感） ---
    var dashMat = new THREE.LineDashedMaterial({
      color: C.muted, transparent: true, opacity: 0.45,
      dashSize: 0.12, gapSize: 0.1
    });
    mats.push({ mat: dashMat, kind: 'line', base: 0.45 });
    var outer = new THREE.LineSegments(
      new THREE.EdgesGeometry(new THREE.BoxGeometry(3.1, 3.1, 3.1)),
      dashMat
    );
    outer.computeLineDistances();
    outer.rotation.set(-0.16, 0.3, 0.05);
    root.add(outer);

    // --- 坐标轴 ---
    var axisLen = 2.7;
    [[[-axisLen, 0, 0], [axisLen, 0, 0], C.accent2],
     [[0, -axisLen, 0], [0, axisLen, 0], C.accent],
     [[0, 0, -axisLen], [0, 0, axisLen], C.accent]].forEach(function (a) {
      var g = new THREE.BufferGeometry().setFromPoints([
        new THREE.Vector3(a[0][0], a[0][1], a[0][2]),
        new THREE.Vector3(a[1][0], a[1][1], a[1][2])
      ]);
      root.add(new THREE.Line(g, lineMat(a[2], a[2] === C.accent2 ? 0.4 : 0.26)));
    });

    // --- 地面网格 ---
    var gridPts = [];
    var half = 8, step = 0.8;
    for (var i = -half; i <= half; i += step) {
      gridPts.push(new THREE.Vector3(-half, 0, i), new THREE.Vector3(half, 0, i));
      gridPts.push(new THREE.Vector3(i, 0, -half), new THREE.Vector3(i, 0, half));
    }
    var gridGeo = new THREE.BufferGeometry().setFromPoints(gridPts);
    var grid = new THREE.LineSegments(gridGeo, lineMat(C.accent, 0.1));
    grid.position.y = -2.25;
    root.add(grid);

    // --- 点云 ---
    var N = isMobile ? 180 : 320;
    var arr = new Float32Array(N * 3);
    for (var k = 0; k < N; k++) {
      var r = 2 + Math.random() * 3.4;
      var th = Math.random() * Math.PI * 2;
      var ph = Math.acos(2 * Math.random() - 1);
      arr[k * 3] = r * Math.sin(ph) * Math.cos(th);
      arr[k * 3 + 1] = r * Math.cos(ph) * 0.8;
      arr[k * 3 + 2] = r * Math.sin(ph) * Math.sin(th);
    }
    var pGeo = new THREE.BufferGeometry();
    pGeo.setAttribute('position', new THREE.BufferAttribute(arr, 3));
    var ptsMat = new THREE.PointsMaterial({
      color: C.accent, size: 0.021, transparent: true,
      opacity: 0.38, sizeAttenuation: true
    });
    mats.push({ mat: ptsMat, kind: 'points', base: 0.38 });
    var pts = new THREE.Points(pGeo, ptsMat);
    root.add(pts);

    // --- 摆放 ---
    function layout() {
      var w = window.innerWidth, h = window.innerHeight;
      camera.aspect = w / h;

      if (w < 780) {
        root.position.set(0, 1.75, 0);
        root.scale.setScalar(0.34);
      } else if (w < 1100) {
        root.position.set(1.05, 0.12, 0);
        root.scale.setScalar(0.78);
      } else {
        root.position.set(1.58, 0.08, 0);
        root.scale.setScalar(0.88);
      }

      camera.updateProjectionMatrix();
      renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
      renderer.setSize(w, h, false);
    }
    layout();
    window.addEventListener('resize', layout);

    // --- 主题同步换色 ---
    var themeObserver = new MutationObserver(function () {
      var nc = themeColors();
      core.material.color.set(nc.accent);
      inner.material.color.set(nc.accent2);
      boxMid.material.color.set(nc.accent);
      dashMat.color.set(nc.muted);
      grid.material.color.set(nc.accent);
      ptsMat.color.set(nc.accent);
    });
    themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });

    // --- 动画 ---
    var clock = new THREE.Clock();
    var running = true;

    function frame() {
      if (!running) return;

      var t = clock.getElapsedTime();

      state.sx += (state.tx - state.sx) * 0.05;
      state.sy += (state.ty - state.sy) * 0.05;
      state.scrollS += (state.scroll - state.scrollS) * 0.09;

      root.rotation.y = t * 0.12 + state.scrollS * 1.3 + state.sx * 0.32;
      root.rotation.x = state.sy * 0.19 - 0.035;

      inner.rotation.y = -t * 0.4;
      inner.rotation.x = t * 0.22;
      core.rotation.z = Math.sin(t * 0.26) * 0.11;

      boxMid.rotation.y = 0.62 + Math.sin(t * 0.17) * 0.15;
      pts.rotation.y = -t * 0.028;

      camera.position.x = state.sx * 0.4;
      camera.position.y = 0.3 - state.sy * 0.24;
      camera.position.z = 7 + state.scrollS * 3;
      camera.lookAt(0, 0, 0);

      // 滚出首屏后彻底隐藏，不干扰正文
      // 移动端整体压暗，只当顶部装饰纹理
      var base = window.innerWidth < 780 ? 0.4 : 1;
      var op = Math.max(0, 1 - state.scrollS * 1.35) * base;
      stageEl.style.opacity = String(op);

      // 完全不可见时跳过绘制，省 GPU
      if (op > 0.004) {
        renderer.render(scene, camera);
      }
      requestAnimationFrame(frame);
    }

    if (reduceMotion) {
      root.rotation.y = 0.45;
      renderer.render(scene, camera);
      window.addEventListener('scroll', function () {
        readScroll();
        var base = window.innerWidth < 780 ? 0.4 : 1;
        stageEl.style.opacity = String(Math.max(0, 1 - state.scroll * 1.35) * base);
      }, { passive: true });
    } else {
      requestAnimationFrame(frame);
    }

    document.addEventListener('visibilitychange', function () {
      if (document.hidden) {
        running = false;
      } else if (!running && !reduceMotion) {
        running = true;
        clock.getDelta();
        requestAnimationFrame(frame);
      }
    });
  }

  // 启动
  function boot() {
    // 省流 / 省电模式直接跳过 3D
    if (navigator.connection && navigator.connection.saveData) {
      document.body.classList.add('no-3d');
      return;
    }
    if (!window.WebGLRenderingContext) {
      document.body.classList.add('no-3d');
      return;
    }
    loadThree().then(function (mod) {
      THREE = mod;
      initScene();
    }).catch(function (err) {
      console.warn('[blog3d] three.js 加载失败，使用静态兜底', err);
      document.body.classList.add('no-3d');
    });
  }

  // 等首屏资源（图片 / JSON）抢完带宽再拉 three.js，避免 670KB 跟首屏图抢通道
  function bootLater() {
    var run = function () {
      if ('requestIdleCallback' in window) {
        requestIdleCallback(boot, { timeout: 2500 });
      } else {
        setTimeout(boot, 800);
      }
    };
    if (document.readyState === 'complete') run();
    else window.addEventListener('load', run);
  }

  bootLater();
})();
