// Three.js 3D 地球组件 — 支持拖拽旋转、滚轮缩放、入场动画

const THREE_CDN = 'https://cdn.jsdelivr.net/npm/three@0.160.0/build/three.module.js';

// 贴图资源（NASA + mrdoob/three.js 公开贴图）
const TEX = {
  earth:   'https://cdn.jsdelivr.net/gh/mrdoob/three.js@r128/examples/textures/planets/earth_atmos_2048.jpg',
  normal:  'https://cdn.jsdelivr.net/gh/mrdoob/three.js@r128/examples/textures/planets/earth_normal_2048.jpg',
  specular:'https://cdn.jsdelivr.net/gh/mrdoob/three.js@r128/examples/textures/planets/earth_specular_2048.jpg',
  clouds:  'https://cdn.jsdelivr.net/gh/mrdoob/three.js@r128/examples/textures/planets/earth_clouds_2048.png',
};

// 主要城市热点坐标 [lat, lon]
const HOTSPOT_COORDS = [
  { lat: 39.9, lon: 116.4, label: '北京' },
  { lat: 31.2, lon: 121.5, label: '上海' },
  { lat: 22.5, lon: 114.1, label: '深圳' },
  { lat: 40.7, lon: -74.0, label: '纽约' },
  { lat: 51.5, lon: -0.1,  label: '伦敦' },
  { lat: 48.9, lon: 2.3,   label: '巴黎' },
  { lat: 35.7, lon: 139.7, label: '东京' },
  { lat: -33.9, lon: 151.2,label: '悉尼' },
  { lat: 55.8, lon: 37.6,  label: '莫斯科' },
  { lat: 19.4, lon: -99.1, label: '墨西哥城' },
  { lat: -23.5, lon: -46.6,label: '圣保罗' },
  { lat: 28.6, lon: 77.2,  label: '新德里' },
];

let THREE = null;

async function loadThree() {
  if (THREE) return THREE;
  const mod = await import(THREE_CDN);
  THREE = mod;
  return THREE;
}

function latLonToVec3(lat, lon, radius) {
  const phi   = (90 - lat) * (Math.PI / 180);
  const theta = (lon + 180) * (Math.PI / 180);
  return new THREE.Vector3(
    -radius * Math.sin(phi) * Math.cos(theta),
     radius * Math.cos(phi),
     radius * Math.sin(phi) * Math.sin(theta),
  );
}

export class HotspotEarth {
  constructor(canvas) {
    this.canvas = canvas;
    this.renderer = null;
    this.scene    = null;
    this.camera   = null;
    this.earth    = null;
    this.clouds   = null;
    this.atmo     = null;
    this.stars    = null;
    this.hotspots = null;

    // 旋转状态
    this.isDragging = false;
    this.prevMouse  = { x: 0, y: 0 };
    this.rotX = 0.1;      // 当前 X 轴旋转（限制在 ±π/2）
    this.rotY = 0;        // 当前 Y 轴旋转
    this.velX = 0;        // 惯性速度
    this.velY = 0.0008;   // 初始自转速度

    // 相机距离
    this.camDist    = 2.6;
    this.camDistMin = 1.6;
    this.camDistMax = 4.5;

    // 入场动画
    this.appearing   = false;
    this.appearScale = 0;

    this.animFrame = null;
    this._bound = {};
  }

  async init() {
    const T = await loadThree();

    // ── 场景 ──────────────────────────────────────────────
    this.scene = new T.Scene();

    // ── 相机 ──────────────────────────────────────────────
    const w = this.canvas.clientWidth  || 400;
    const h = this.canvas.clientHeight || 400;
    this.camera = new T.PerspectiveCamera(45, w / h, 0.1, 100);
    this.camera.position.set(0, 0, this.camDist);

    // ── 渲染器 ────────────────────────────────────────────
    this.renderer = new T.WebGLRenderer({
      canvas: this.canvas,
      antialias: true,
      alpha: true,
    });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setSize(w, h, false);

    // ── 光源 ──────────────────────────────────────────────
    const sun = new T.DirectionalLight(0xffffff, 1.2);
    sun.position.set(5, 3, 5);
    this.scene.add(sun);
    this.scene.add(new T.AmbientLight(0x112244, 0.8));

    // ── 贴图加载器 ────────────────────────────────────────
    const loader = new T.TextureLoader();
    const load   = (url) => new Promise((res) => loader.load(url, res, undefined, () => res(null)));

    const [earthTex, normalTex, specTex, cloudTex] = await Promise.all([
      load(TEX.earth),
      load(TEX.normal),
      load(TEX.specular),
      load(TEX.clouds),
    ]);

    // ── 地球球体 ──────────────────────────────────────────
    const geo = new T.SphereGeometry(1, 64, 64);
    const mat = new T.MeshPhongMaterial({
      map:         earthTex,
      normalMap:   normalTex,
      specularMap: specTex,
      specular:    new T.Color(0x333333),
      shininess:   18,
    });
    this.earth = new T.Mesh(geo, mat);
    this.scene.add(this.earth);

    // ── 云层 ──────────────────────────────────────────────
    if (cloudTex) {
      const cloudGeo = new T.SphereGeometry(1.012, 48, 48);
      const cloudMat = new T.MeshPhongMaterial({
        map:         cloudTex,
        transparent: true,
        opacity:     0.38,
        depthWrite:  false,
      });
      this.clouds = new T.Mesh(cloudGeo, cloudMat);
      this.scene.add(this.clouds);
    }

    // ── 大气层辉光 ────────────────────────────────────────
    const atmoGeo = new T.SphereGeometry(1.06, 32, 32);
    const atmoMat = new T.MeshBasicMaterial({
      color:       0x4488ff,
      transparent: true,
      opacity:     0.08,
      side:        T.BackSide,
      depthWrite:  false,
    });
    this.atmo = new T.Mesh(atmoGeo, atmoMat);
    this.scene.add(this.atmo);

    // ── 第二层稍厚大气（浅蓝边缘） ────────────────────────
    const atmo2Geo = new T.SphereGeometry(1.035, 32, 32);
    const atmo2Mat = new T.MeshBasicMaterial({
      color:       0x88ccff,
      transparent: true,
      opacity:     0.05,
      side:        T.FrontSide,
      depthWrite:  false,
    });
    this.scene.add(new T.Mesh(atmo2Geo, atmo2Mat));

    // ── 星空粒子 ──────────────────────────────────────────
    const starVerts = [];
    for (let i = 0; i < 2000; i++) {
      const theta = Math.random() * Math.PI * 2;
      const phi   = Math.acos(2 * Math.random() - 1);
      const r     = 18 + Math.random() * 12;
      starVerts.push(
        r * Math.sin(phi) * Math.cos(theta),
        r * Math.cos(phi),
        r * Math.sin(phi) * Math.sin(theta),
      );
    }
    const starGeo = new T.BufferGeometry();
    starGeo.setAttribute('position', new T.Float32BufferAttribute(starVerts, 3));
    const starMat = new T.PointsMaterial({ color: 0xffffff, size: 0.06, sizeAttenuation: true });
    this.stars = new T.Points(starGeo, starMat);
    this.scene.add(this.stars);

    // ── 热点标记 ──────────────────────────────────────────
    this._buildHotspots(T);

    // ── 事件监听 ──────────────────────────────────────────
    this._bindEvents();

    // ── 开始渲染循环 ──────────────────────────────────────
    this._animate();
  }

  _buildHotspots(T) {
    const group = new T.Group();
    HOTSPOT_COORDS.forEach(({ lat, lon }) => {
      const pos = latLonToVec3(lat, lon, 1.025);
      // 外环
      const ringGeo = new T.RingGeometry(0.016, 0.026, 16);
      const ringMat = new T.MeshBasicMaterial({
        color: 0xff4444, transparent: true, opacity: 0.85, side: T.DoubleSide,
      });
      const ring = new T.Mesh(ringGeo, ringMat);
      ring.position.copy(pos);
      ring.lookAt(pos.clone().multiplyScalar(2));
      // 中心点
      const dotGeo = new T.CircleGeometry(0.009, 12);
      const dotMat = new T.MeshBasicMaterial({ color: 0xff8888, side: T.DoubleSide });
      const dot    = new T.Mesh(dotGeo, dotMat);
      dot.position.copy(pos);
      dot.lookAt(pos.clone().multiplyScalar(2));

      group.add(ring, dot);
    });
    this.hotspots = group;
    this.earth.add(group);
  }

  _bindEvents() {
    const c = this.canvas;
    const onDown = (e) => {
      this.isDragging = true;
      const p = e.touches ? e.touches[0] : e;
      this.prevMouse = { x: p.clientX, y: p.clientY };
      this.velX = 0;
      this.velY = 0;
    };
    const onMove = (e) => {
      if (!this.isDragging) return;
      e.preventDefault();
      const p = e.touches ? e.touches[0] : e;
      const dx = p.clientX - this.prevMouse.x;
      const dy = p.clientY - this.prevMouse.y;
      this.velY = dx * 0.003;
      this.velX = dy * 0.003;
      this.rotY += this.velY;
      this.rotX += this.velX;
      this.rotX = Math.max(-Math.PI / 2.2, Math.min(Math.PI / 2.2, this.rotX));
      this.prevMouse = { x: p.clientX, y: p.clientY };
    };
    const onUp = () => { this.isDragging = false; };
    const onWheel = (e) => {
      e.preventDefault();
      this.camDist += e.deltaY * 0.002;
      this.camDist = Math.max(this.camDistMin, Math.min(this.camDistMax, this.camDist));
    };
    c.addEventListener('mousedown',  onDown);
    c.addEventListener('mousemove',  onMove);
    c.addEventListener('mouseup',    onUp);
    c.addEventListener('mouseleave', onUp);
    c.addEventListener('touchstart', onDown, { passive: true });
    c.addEventListener('touchmove',  onMove, { passive: false });
    c.addEventListener('touchend',   onUp);
    c.addEventListener('wheel',      onWheel, { passive: false });
    this._bound = { onDown, onMove, onUp, onWheel };
  }

  // 触发入场放大动画
  triggerAppear() {
    this.appearing   = true;
    this.appearScale = 0;
    if (this.earth)  this.earth.scale.setScalar(0);
    if (this.clouds) this.clouds.scale.setScalar(0);
    if (this.atmo)   this.atmo.scale.setScalar(0);
    if (this.stars)  this.stars.material.opacity = 0;
  }

  _animate() {
    this.animFrame = requestAnimationFrame(() => this._animate());

    // 入场动画（弹簧效果）
    if (this.appearing) {
      this.appearScale += (1 - this.appearScale) * 0.07;
      const s = this.appearScale;
      if (this.earth)  this.earth.scale.setScalar(s);
      if (this.clouds) this.clouds.scale.setScalar(s);
      if (this.atmo)   this.atmo.scale.setScalar(s);
      if (this.stars)  this.stars.material.opacity = Math.min(1, s * 1.5);
      if (s > 0.999) {
        this.appearing = false;
        if (this.earth)  this.earth.scale.setScalar(1);
        if (this.clouds) this.clouds.scale.setScalar(1);
        if (this.atmo)   this.atmo.scale.setScalar(1);
        if (this.stars)  this.stars.material.opacity = 1;
      }
    }

    // 惯性旋转衰减
    if (!this.isDragging) {
      this.velX *= 0.92;
      this.velY *= 0.92;
      this.rotX += this.velX;
      this.rotY += this.velY + 0.0006; // 持续自转
      this.rotX = Math.max(-Math.PI / 2.2, Math.min(Math.PI / 2.2, this.rotX));
    }

    if (this.earth) {
      this.earth.rotation.x = this.rotX;
      this.earth.rotation.y = this.rotY;
    }
    // 云层略慢于地球，形成相对漂移
    if (this.clouds) {
      this.clouds.rotation.x = this.rotX;
      this.clouds.rotation.y = this.rotY + performance.now() * 0.000008;
    }

    // 相机平滑追踪距离
    const curr = this.camera.position.length();
    const next = curr + (this.camDist - curr) * 0.1;
    this.camera.position.setLength(next);

    // 响应 canvas 尺寸变化
    this._checkResize();

    this.renderer.render(this.scene, this.camera);
  }

  _checkResize() {
    const c   = this.canvas;
    const w   = c.clientWidth;
    const h   = c.clientHeight;
    if (!w || !h) return;
    const dpr = this.renderer.getPixelRatio();
    if (c.width !== Math.round(w * dpr) || c.height !== Math.round(h * dpr)) {
      this.renderer.setSize(w, h, false);
      this.camera.aspect = w / h;
      this.camera.updateProjectionMatrix();
    }
  }

  dispose() {
    if (this.animFrame) cancelAnimationFrame(this.animFrame);
    const c = this.canvas;
    const b = this._bound;
    if (b.onDown)  c.removeEventListener('mousedown',  b.onDown);
    if (b.onMove)  c.removeEventListener('mousemove',  b.onMove);
    if (b.onUp)    c.removeEventListener('mouseup',    b.onUp);
    if (b.onUp)    c.removeEventListener('mouseleave', b.onUp);
    if (b.onDown)  c.removeEventListener('touchstart', b.onDown);
    if (b.onMove)  c.removeEventListener('touchmove',  b.onMove);
    if (b.onUp)    c.removeEventListener('touchend',   b.onUp);
    if (b.onWheel) c.removeEventListener('wheel',      b.onWheel);
    this.renderer?.dispose();
    this.renderer = null;
  }
}
