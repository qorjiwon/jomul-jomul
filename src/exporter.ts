import * as THREE from 'three';
import { GLTFExporter } from 'three/addons/exporters/GLTFExporter.js';

function download(blob: Blob, name: string) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
}

function safeName(name: string) {
  return (name.trim() || '조물조물').replace(/[\\/:*?"<>|]+/g, '_');
}

/**
 * Textured pieces keep their paint as an RGBA vertex layer mixed in by a shader patch, which glTF can't express.
 * Render the mix into a copy of the texture in UV space (original texture underneath fills the gaps between islands).
 */
function bakePaintIntoTexture(renderer: THREE.WebGLRenderer, geometry: THREE.BufferGeometry, map: THREE.Texture): THREE.Texture {
  const img = map.image as { width: number; height: number };
  const w = img.width, h = img.height;
  const rt = new THREE.WebGLRenderTarget(w, h, { depthBuffer: false });
  const cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  const toSRGB = `vec3 toSRGB(vec3 c) { return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c)); }`;
  const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), new THREE.ShaderMaterial({
    uniforms: { map: { value: map } },
    vertexShader: 'varying vec2 vUv; void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }',
    fragmentShader: `uniform sampler2D map; varying vec2 vUv; ${toSRGB}
      void main() { gl_FragColor = vec4(toSRGB(texture2D(map, vUv).rgb), 1.0); }`,
    depthTest: false,
  }));
  const paint = new THREE.Mesh(geometry, new THREE.ShaderMaterial({
    uniforms: { map: { value: map } },
    vertexShader: `attribute vec4 color; varying vec2 vUv; varying vec4 vCol;
      void main() { vUv = uv; vCol = color; gl_Position = vec4(uv.x * 2.0 - 1.0, uv.y * 2.0 - 1.0, 0.0, 1.0); }`,
    fragmentShader: `uniform sampler2D map; varying vec2 vUv; varying vec4 vCol; ${toSRGB}
      void main() { gl_FragColor = vec4(toSRGB(mix(texture2D(map, vUv).rgb, vCol.rgb, vCol.a)), 1.0); }`,
    side: THREE.DoubleSide,
    depthTest: false,
  }));
  paint.frustumCulled = false;
  const scene = new THREE.Scene();
  scene.add(quad, paint);
  paint.renderOrder = 1;
  const prev = { target: renderer.getRenderTarget(), tone: renderer.toneMapping, cs: renderer.outputColorSpace };
  renderer.toneMapping = THREE.NoToneMapping;
  renderer.setRenderTarget(rt);
  renderer.render(scene, cam);
  const px = new Uint8Array(w * h * 4);
  renderer.readRenderTargetPixels(rt, 0, 0, w, h, px);
  renderer.setRenderTarget(prev.target);
  renderer.toneMapping = prev.tone;
  rt.dispose(); quad.geometry.dispose(); (quad.material as THREE.Material).dispose(); (paint.material as THREE.Material).dispose();
  // GL rows start at v = 0, which is the top row in glTF's top-down image convention — copy straight across.
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  c.getContext('2d')!.putImageData(new ImageData(new Uint8ClampedArray(px.buffer), w, h), 0, 0);
  const tex = new THREE.CanvasTexture(c);
  tex.flipY = false;
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

export async function exportGLB(mesh: THREE.Mesh, name: string, renderer?: THREE.WebGLRenderer): Promise<void> {
  const mat = (mesh.material as THREE.MeshStandardMaterial).clone();
  mat.emissive.set('#000000');
  mat.emissiveIntensity = 0;
  let geometry = mesh.geometry;
  if (mat.map && renderer && geometry.getAttribute('uv') && geometry.getAttribute('color')?.itemSize === 4) {
    mat.map = bakePaintIntoTexture(renderer, geometry, mat.map);
    mat.vertexColors = false;
    geometry = geometry.clone();
    geometry.deleteAttribute('color');
  }
  const clone = new THREE.Mesh(geometry, mat);
  clone.name = safeName(name);
  const exporter = new GLTFExporter();
  const result = await exporter.parseAsync(clone, { binary: true });
  const blob = new Blob([result as ArrayBuffer], { type: 'model/gltf-binary' });
  download(blob, `${clone.name}.glb`);
}

export function exportPNG(renderer: THREE.WebGLRenderer, scene: THREE.Scene, camera: THREE.Camera, name: string): Promise<void> {
  return new Promise((resolve, reject) => {
    renderer.render(scene, camera);
    renderer.domElement.toBlob((blob) => {
      if (!blob) { reject(new Error('toBlob failed')); return; }
      download(blob, `${safeName(name)}.png`);
      resolve();
    }, 'image/png');
  });
}
