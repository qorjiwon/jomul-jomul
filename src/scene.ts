import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';

export class Studio {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;
  readonly controls: OrbitControls;
  readonly pedestal: THREE.Mesh;
  readonly key: THREE.DirectionalLight;

  constructor(readonly canvas: HTMLCanvasElement) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 0.95;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;

    this.scene.background = new THREE.Color('#f4f4f7');
    this.renderer.setSize(Math.max(1, canvas.clientWidth), Math.max(1, canvas.clientHeight), false);
    const pmrem = new THREE.PMREMGenerator(this.renderer);
    this.scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    this.scene.environmentIntensity = 0.55;
    pmrem.dispose();

    this.camera = new THREE.PerspectiveCamera(38, 1, 0.05, 100);
    this.camera.position.set(1.2, 1.8, 4.2);

    this.controls = new OrbitControls(this.camera, canvas);
    this.controls.target.set(0, 0.9, 0);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.09;
    this.controls.minDistance = 0.8;
    this.controls.maxDistance = 12;
    this.controls.maxPolarAngle = Math.PI * 0.53;
    this.controls.mouseButtons = { LEFT: THREE.MOUSE.ROTATE, MIDDLE: THREE.MOUSE.PAN, RIGHT: THREE.MOUSE.ROTATE };
    this.controls.touches = { ONE: THREE.TOUCH.ROTATE, TWO: THREE.TOUCH.DOLLY_PAN };
    this.controls.autoRotateSpeed = 1.6;

    const hemi = new THREE.HemisphereLight('#fff6ea', '#a78b6f', 0.55);
    this.scene.add(hemi);

    this.key = new THREE.DirectionalLight('#fff1dd', 1.9);
    this.key.position.set(3, 6.5, 4);
    this.key.castShadow = true;
    this.key.shadow.mapSize.set(2048, 2048);
    this.key.shadow.camera.near = 1;
    this.key.shadow.camera.far = 20;
    this.key.shadow.camera.left = this.key.shadow.camera.bottom = -3;
    this.key.shadow.camera.right = this.key.shadow.camera.top = 3;
    this.key.shadow.bias = -0.0004;
    this.key.shadow.normalBias = 0.02;
    this.key.shadow.radius = 4;
    this.scene.add(this.key);

    const fill = new THREE.DirectionalLight('#dfe8ff', 0.6);
    fill.position.set(-4, 3, -2);
    this.scene.add(fill);

    // Potter's wheel: wooden disc whose top is at y = 0
    const wood = new THREE.MeshStandardMaterial({ color: '#b78a5b', roughness: 0.8, metalness: 0 });
    this.pedestal = new THREE.Mesh(new THREE.CylinderGeometry(1.3, 1.36, 0.14, 72), wood);
    this.pedestal.position.y = -0.07;
    this.pedestal.receiveShadow = true;
    this.pedestal.castShadow = true;
    this.scene.add(this.pedestal);

    const rim = new THREE.Mesh(
      new THREE.TorusGeometry(1.33, 0.025, 12, 96),
      new THREE.MeshStandardMaterial({ color: '#8e6440', roughness: 0.7 }),
    );
    rim.rotation.x = Math.PI / 2;
    rim.position.y = 0.0;
    this.scene.add(rim);

    const ground = new THREE.Mesh(
      new THREE.CircleGeometry(8, 64),
      new THREE.ShadowMaterial({ opacity: 0.18 }),
    );
    ground.rotation.x = -Math.PI / 2;
    ground.position.y = -0.14;
    ground.receiveShadow = true;
    this.scene.add(ground);

    this.resize();
    window.addEventListener('resize', () => this.resize());
  }

  resize() {
    const w = this.canvas.clientWidth || window.innerWidth;
    const h = this.canvas.clientHeight || window.innerHeight - 64;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  /** Frame the given box with a pleasant 3/4 view. */
  fitCamera(box: THREE.Box3) {
    const size = box.getSize(new THREE.Vector3());
    const center = box.getCenter(new THREE.Vector3());
    const maxDim = Math.max(size.x, size.y, size.z);
    const fov = THREE.MathUtils.degToRad(this.camera.fov);
    let dist = (maxDim / 2) / Math.tan(fov / 2);
    dist *= 1.6;
    const dir = new THREE.Vector3(0.45, 0.32, 1).normalize();
    this.camera.position.copy(center).addScaledVector(dir, dist);
    this.controls.target.copy(center);
    this.controls.update();
  }

  /**
   * Render `obj` alone (no wheel, no background) from a fixed 3/4 view and return a transparent
   * square image tightly cropped around it. The camera is restored afterwards.
   */
  cutout(obj: THREE.Object3D, size = 256): string {
    const camPos = this.camera.position.clone(), target = this.controls.target.clone();
    const bg = this.scene.background;
    // Everything else that draws (wheel, rim, shadow catcher, brush rings) steps aside.
    const hidden = this.scene.children.filter((c) => c.visible && c !== obj && c instanceof THREE.Mesh);
    const added = !obj.parent;
    if (added) this.scene.add(obj);
    hidden.forEach((c) => { c.visible = false; });
    this.scene.background = null;
    this.fitCamera(new THREE.Box3().setFromObject(obj));
    this.renderer.setClearColor(0x000000, 0);
    this.renderer.render(this.scene, this.camera);

    // Find the opaque bounds, then crop a padded square around them.
    const src = this.renderer.domElement;
    const probe = document.createElement('canvas');
    probe.width = src.width; probe.height = src.height;
    const pctx = probe.getContext('2d', { willReadFrequently: true })!;
    pctx.drawImage(src, 0, 0);
    const { data, width, height } = pctx.getImageData(0, 0, probe.width, probe.height);
    let x0 = width, y0 = height, x1 = -1, y1 = -1;
    for (let y = 0; y < height; y += 2) {
      for (let x = 0; x < width; x += 2) {
        if (data[(y * width + x) * 4 + 3] > 8) {
          if (x < x0) x0 = x; if (x > x1) x1 = x;
          if (y < y0) y0 = y; if (y > y1) y1 = y;
        }
      }
    }
    if (x1 < 0) { x0 = 0; y0 = 0; x1 = width - 1; y1 = height - 1; }
    const side = Math.max(x1 - x0, y1 - y0) * 1.08 + 4;
    const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
    const c = document.createElement('canvas');
    c.width = c.height = size;
    c.getContext('2d')!.drawImage(probe, cx - side / 2, cy - side / 2, side, side, 0, 0, size, size);

    this.scene.background = bg;
    hidden.forEach((h) => { h.visible = true; });
    if (added) this.scene.remove(obj);
    this.camera.position.copy(camPos);
    this.controls.target.copy(target);
    this.controls.update();
    // WebP keeps transparency and stays small; browsers without a WebP encoder hand back PNG.
    return c.toDataURL('image/webp', 0.86);
  }

  render() {
    this.controls.update();
    this.renderer.render(this.scene, this.camera);
  }

  /** Render once and return a JPEG data URL, downscaled to `size` px on the long edge. */
  snapshot(size = 256): string {
    this.renderer.render(this.scene, this.camera);
    // Center-square crop: the camera keeps the piece centered, and square thumbs tile nicely in galleries.
    const src = this.renderer.domElement;
    const side = Math.min(src.width, src.height);
    const c = document.createElement('canvas');
    c.width = c.height = size;
    const ctx = c.getContext('2d')!;
    ctx.fillStyle = '#f4f4f7';
    ctx.fillRect(0, 0, size, size);
    ctx.drawImage(src, (src.width - side) / 2, (src.height - side) / 2, side, side, 0, 0, size, size);
    return c.toDataURL('image/jpeg', 0.82);
  }
}
