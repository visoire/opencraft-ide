/*
 * OpenCraft: environment of the four WebAssembly apps (WordCraft, GridCraft, DeckCraft, PdfCraft)
 * for iPadOS, Retina displays and embedded panels. Runs before the WebAssembly module starts.
 *
 * 1. Exact viewport metadata: width=device-width, initial-scale=1, maximum-scale=1, viewport-fit=cover
 * 2. One pixel ratio with the main window: window.devicePixelRatio inside the app window equals the
 *    value of the IDE (at most 2, WebKit memory limits).
 * 3. Canvas compensation: when the drawn size of the canvas differs from the visible area (for
 *    example twice the size because of a pixel value instead of CSS pixels), a CSS transform
 *    (scale) with an adjusted size corrects it exactly.
 * 4. Window modes (Stage Manager, Split View, Slide Over, rotation): adjusts without reloading.
 * 5. window.__ocFrameForce = { width, height } lays the app out at a fixed size for a moment
 *    (public/craft-theme.js uses it to set WordCraft's theme option at any panel size).
 *
 * Added to apps/<app>/index.html by scripts/releases.mjs (development) and scripts/copy-apps.mjs
 * (build). Without an embedding IDE only 1, 3, 4 and 5 apply.
 */
(function () {
  'use strict';
  var w = window;
  var doc = document;
  var MAX_DPR = 2;

  // ---------- 1. Viewport ----------
  var VIEWPORT = 'width=device-width, initial-scale=1, maximum-scale=1, viewport-fit=cover';
  try {
    var metas = doc.querySelectorAll('meta[name="viewport"]');
    var meta = metas[0];
    for (var i = 1; i < metas.length; i++) metas[i].remove();
    if (!meta) {
      meta = doc.createElement('meta');
      meta.name = 'viewport';
      (doc.head || doc.documentElement).appendChild(meta);
    }
    meta.setAttribute('content', VIEWPORT);
  } catch (_) {}

  // ---------- 2. Pixel ratio ----------
  function hostDpr() {
    var q = /[?&]dpr=([\d.]+)/.exec(location.search);
    if (q) return parseFloat(q[1]);
    try {
      if (w.parent && w.parent !== w && typeof w.parent.__opencraftDpr === 'number') return w.parent.__opencraftDpr;
    } catch (_) {
      /* other origin */
    }
    return 0;
  }
  var nativeDesc = Object.getOwnPropertyDescriptor(w, 'devicePixelRatio') || Object.getOwnPropertyDescriptor(Window.prototype, 'devicePixelRatio');
  var nativeDpr = function () {
    try {
      return nativeDesc && nativeDesc.get ? nativeDesc.get.call(w) : 1;
    } catch (_) {
      return 1;
    }
  };
  function effectiveDpr() {
    var h = hostDpr();
    var n = nativeDpr() || 1;
    return Math.min(MAX_DPR, h > 0 ? h : n);
  }
  try {
    Object.defineProperty(w, 'devicePixelRatio', { configurable: true, get: effectiveDpr });
  } catch (_) {}

  // ---------- 3. Canvas compensation ----------
  var info = { dpr: effectiveDpr(), nativeDpr: nativeDpr(), scale: 1, viewport: { width: 0, height: 0 }, canvas: { width: 0, height: 0, pixelWidth: 0, pixelHeight: 0 } };
  w.__ocFrameInfo = info;

  function viewportSize() {
    var f = w.__ocFrameForce;
    if (f && f.width > 0 && f.height > 0) return { width: f.width, height: f.height };
    var vv = w.visualViewport;
    var de = doc.documentElement;
    return { width: Math.round((vv && vv.width) || de.clientWidth || w.innerWidth), height: Math.round((vv && vv.height) || de.clientHeight || w.innerHeight) };
  }

  var pending = 0;
  // Retina bug of the apps: the drawing buffer follows the CSS size instead of CSS size times the
  // pixel ratio, but rendering uses the pixel ratio, so the interface looked twice as large (iPad,
  // Retina Mac). Fix: lay the canvas out at physical size and scale it back with
  // transform: scale(1 / pixel ratio) onto the visible area.
  var retinaFix = false;
  var wasForced = false;
  function fit() {
    pending = 0;
    var canvas = doc.querySelector('canvas');
    var vp = viewportSize();
    var k = effectiveDpr();
    info.viewport = vp;
    info.dpr = k;
    var body = doc.body;
    if (body) {
      body.style.width = vp.width + 'px';
      body.style.height = vp.height + 'px';
      body.style.overflow = 'hidden';
    }
    if (!canvas) return;
    var forced = !!(w.__ocFrameForce && w.__ocFrameForce.width > 0);
    var layoutW = canvas.offsetWidth;
    // Detection: buffer about as wide as the layout although the pixel ratio is above 1
    if (!retinaFix && k > 1.05 && layoutW > 0 && canvas.width > 0 && Math.abs(canvas.width - layoutW) <= Math.max(2, layoutW * 0.02)) retinaFix = true;
    if (retinaFix && k > 1.05) {
      canvas.style.width = Math.round(vp.width * k) + 'px';
      canvas.style.height = Math.round(vp.height * k) + 'px';
      canvas.style.transformOrigin = '0 0';
      canvas.style.transform = 'scale(' + (1 / k).toFixed(5) + ')';
      info.scale = 1 / k;
      info.mode = 'retina';
    } else {
      if (forced) {
        // The apps place the canvas with position: absolute; inset: 0, so a forced layout needs explicit sizes
        canvas.style.right = 'auto';
        canvas.style.bottom = 'auto';
        canvas.style.width = vp.width + 'px';
        canvas.style.height = vp.height + 'px';
      } else if (retinaFix || wasForced) {
        canvas.style.width = '';
        canvas.style.height = '';
        canvas.style.right = '';
        canvas.style.bottom = '';
      }
      // General compensation: the drawn size differs from the visible area
      canvas.style.transform = 'none';
      var r0 = canvas.getBoundingClientRect();
      var s = Math.min(r0.width > 0 ? vp.width / r0.width : 1, r0.height > 0 ? vp.height / r0.height : 1);
      if (Math.abs(s - 1) > 0.01 && isFinite(s) && s > 0) {
        canvas.style.transformOrigin = '0 0';
        canvas.style.transform = 'scale(' + s.toFixed(5) + ')';
        info.scale = s;
        info.mode = 'fit';
      } else {
        canvas.style.transform = '';
        info.scale = 1;
        info.mode = 'native';
      }
    }
    wasForced = forced;
    var r = canvas.getBoundingClientRect();
    info.canvas = { width: Math.round(r.width), height: Math.round(r.height), pixelWidth: canvas.width, pixelHeight: canvas.height };
    try {
      if (w.parent && w.parent !== w) w.parent.postMessage({ type: 'opencraft:frame', info: info }, location.origin);
    } catch (_) {}
  }
  function schedule() {
    if (!pending) pending = (w.requestAnimationFrame || setTimeout)(fit);
  }
  w.__ocFit = fit;

  function watch() {
    var canvas = doc.querySelector('canvas');
    if (canvas && w.ResizeObserver) new w.ResizeObserver(schedule).observe(canvas);
    if (w.ResizeObserver) new w.ResizeObserver(schedule).observe(doc.documentElement);
    if (canvas && w.MutationObserver) new w.MutationObserver(schedule).observe(canvas, { attributes: true, attributeFilter: ['width', 'height'] });
    schedule();
  }

  // ---------- 4. Window modes ----------
  w.addEventListener('resize', schedule);
  w.addEventListener('orientationchange', schedule);
  if (w.visualViewport) w.visualViewport.addEventListener('resize', schedule);
  w.addEventListener('message', function (e) {
    if (e.origin === location.origin && e.data && e.data.type === 'opencraft:refit') schedule();
  });

  if (doc.readyState === 'loading') doc.addEventListener('DOMContentLoaded', watch, { once: true });
  else watch();

  // ---------- 6. Resource meter (memory and GPU monitor of the IDE) ----------
  // Counts the WebAssembly memory of the app and estimates its GPU memory (WebGPU buffers and
  // textures, WebGL buffers and textures). Read by the IDE through window.__ocResources().
  var res = { memories: [], gpuApi: '', gpuBytes: 0, textures: 0, buffers: 0 };
  try {
    var WA = w.WebAssembly;
    if (WA) {
      var keep = function (m) {
        if (m && res.memories.indexOf(m) < 0 && res.memories.length < 16) res.memories.push(m);
      };
      var fromInstance = function (inst) {
        try {
          var ex = inst && inst.exports;
          for (var k in ex) if (ex[k] instanceof WA.Memory) keep(ex[k]);
        } catch (_) {}
      };
      var OrigMemory = WA.Memory;
      var MemoryProxy = function (d) {
        var m = new OrigMemory(d);
        keep(m);
        return m;
      };
      MemoryProxy.prototype = OrigMemory.prototype;
      WA.Memory = MemoryProxy;
      var wrap = function (name) {
        var orig = WA[name];
        if (typeof orig !== 'function') return;
        WA[name] = function () {
          return orig.apply(this, arguments).then(function (r) {
            fromInstance(r && r.instance ? r.instance : r);
            return r;
          });
        };
      };
      wrap('instantiate');
      wrap('instantiateStreaming');
    }
  } catch (_) {}

  var FORMAT_BYTES = { r8unorm: 1, r8snorm: 1, r8uint: 1, r8sint: 1, rg8unorm: 2, r16float: 2, rgba8unorm: 4, 'rgba8unorm-srgb': 4, bgra8unorm: 4, 'bgra8unorm-srgb': 4, rgba16float: 8, rgba32float: 16, r32float: 4, depth24plus: 4, 'depth24plus-stencil8': 4, depth32float: 4, rg16float: 4, rg32float: 8 };
  function texBytes(d) {
    var size = d.size || {};
    var wd = size.width || size[0] || 1;
    var ht = size.height || size[1] || 1;
    var layers = size.depthOrArrayLayers || size[2] || 1;
    var px = FORMAT_BYTES[d.format] || 4;
    var mips = d.mipLevelCount || 1;
    return Math.round(wd * ht * layers * px * (mips > 1 ? 1.34 : 1) * (d.sampleCount || 1));
  }
  try {
    var gpu = w.navigator && w.navigator.gpu;
    if (gpu && gpu.requestAdapter) {
      var origReq = gpu.requestAdapter.bind(gpu);
      gpu.requestAdapter = function (o) {
        return origReq(o).then(function (adapter) {
          if (!adapter) return adapter;
          var origDev = adapter.requestDevice.bind(adapter);
          adapter.requestDevice = function (d) {
            return origDev(d).then(function (dev) {
              res.gpuApi = 'webgpu';
              var cb = dev.createBuffer.bind(dev);
              dev.createBuffer = function (desc) {
                var b = cb(desc);
                var n = desc.size || 0;
                res.gpuBytes += n;
                res.buffers++;
                var od = b.destroy.bind(b);
                b.destroy = function () {
                  res.gpuBytes -= n;
                  res.buffers--;
                  b.destroy = od;
                  return od();
                };
                return b;
              };
              var ct = dev.createTexture.bind(dev);
              dev.createTexture = function (desc) {
                var t = ct(desc);
                var n = texBytes(desc);
                res.gpuBytes += n;
                res.textures++;
                var od = t.destroy.bind(t);
                t.destroy = function () {
                  res.gpuBytes -= n;
                  res.textures--;
                  t.destroy = od;
                  return od();
                };
                return t;
              };
              return dev;
            });
          };
          return adapter;
        });
      };
    }
  } catch (_) {}
  try {
    var G2 = w.WebGL2RenderingContext;
    if (G2) {
      var sizes = new WeakMap();
      var bound = { buf: null, tex: null };
      var account = function (obj, n) {
        if (!obj) return;
        var old = sizes.get(obj) || 0;
        sizes.set(obj, n);
        res.gpuBytes += n - old;
      };
      var P = G2.prototype;
      var oBindBuffer = P.bindBuffer;
      P.bindBuffer = function (t, b) {
        bound.buf = b;
        return oBindBuffer.apply(this, arguments);
      };
      var oBufferData = P.bufferData;
      P.bufferData = function (t, data) {
        if (!res.gpuApi) res.gpuApi = 'webgl2';
        account(bound.buf, typeof data === 'number' ? data : (data && data.byteLength) || 0);
        return oBufferData.apply(this, arguments);
      };
      var oBindTexture = P.bindTexture;
      P.bindTexture = function (t, tex) {
        bound.tex = tex;
        return oBindTexture.apply(this, arguments);
      };
      var oTexStorage2D = P.texStorage2D;
      P.texStorage2D = function (t, levels, fmt, wd, ht) {
        if (!res.gpuApi) res.gpuApi = 'webgl2';
        account(bound.tex, Math.round(wd * ht * 4 * (levels > 1 ? 1.34 : 1)));
        return oTexStorage2D.apply(this, arguments);
      };
      var oTexImage2D = P.texImage2D;
      P.texImage2D = function (t, level, ifmt, wd, ht) {
        if (level === 0 && typeof wd === 'number' && typeof ht === 'number') account(bound.tex, wd * ht * 4);
        else if (level === 0 && wd && typeof wd === 'object' && arguments.length >= 6) {
          var src = arguments[5];
          if (src && src.width) account(bound.tex, src.width * src.height * 4);
        }
        return oTexImage2D.apply(this, arguments);
      };
      var oDelB = P.deleteBuffer;
      P.deleteBuffer = function (b) {
        account(b, 0);
        return oDelB.apply(this, arguments);
      };
      var oDelT = P.deleteTexture;
      P.deleteTexture = function (tx) {
        account(tx, 0);
        return oDelT.apply(this, arguments);
      };
    }
  } catch (_) {}
  w.__ocResources = function () {
    var wasm = 0;
    for (var i = 0; i < res.memories.length; i++) {
      try {
        wasm += res.memories[i].buffer.byteLength;
      } catch (_) {}
    }
    var pm = w.performance && w.performance.memory;
    return { wasm: wasm, wasmMemories: res.memories.length, gpu: Math.max(0, res.gpuBytes), gpuApi: res.gpuApi || '', gpuBuffers: res.buffers, gpuTextures: res.textures, heap: pm ? pm.usedJSHeapSize : null };
  };
})();
