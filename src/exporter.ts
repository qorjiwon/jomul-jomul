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

export async function exportGLB(mesh: THREE.Mesh, name: string): Promise<void> {
  const mat = (mesh.material as THREE.MeshStandardMaterial).clone();
  mat.emissive.set('#000000');
  mat.emissiveIntensity = 0;
  const clone = new THREE.Mesh(mesh.geometry, mat);
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
