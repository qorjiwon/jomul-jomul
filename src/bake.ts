import * as THREE from 'three';

export const CLAY_COLOR = new THREE.Color('#a98d6f');
export const FIRED_COLOR = new THREE.Color('#c9734a');
const GLOW = new THREE.Color('#ff5a1f');

export function makeClayMaterial(): THREE.MeshStandardMaterial {
  const mat = new THREE.MeshStandardMaterial({ color: CLAY_COLOR.clone(), roughness: 0.95, metalness: 0 });
  // RGBA vertex colors are a paint layer over the texture (a = coverage), not a multiplier.
  mat.onBeforeCompile = (shader) => {
    shader.fragmentShader = shader.fragmentShader.replace('#include <color_fragment>', `
      #if defined( USE_COLOR_ALPHA )
        diffuseColor.rgb = mix( diffuseColor.rgb, vColor.rgb, vColor.a );
      #elif defined( USE_COLOR )
        diffuseColor.rgb *= vColor.rgb;
      #endif`);
  };
  return mat;
}

/** Decodes a stored texture image (top-down, glTF convention) into a texture for the clay material. */
export async function loadTexture(blob: Blob): Promise<THREE.Texture> {
  const bmp = await createImageBitmap(blob, { imageOrientation: 'none' });
  const tex = new THREE.Texture(bmp);
  tex.flipY = false;
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping; // single imported textures may tile
  tex.anisotropy = 8;
  tex.needsUpdate = true;
  return tex;
}

/** Switch the material to the fired, paintable look (vertex colours on, glaze off). */
export function applyFiredLook(mat: THREE.MeshStandardMaterial, glossy: boolean) {
  mat.vertexColors = true;
  mat.color.set('#ffffff');
  mat.emissive.set('#000000');
  mat.emissiveIntensity = 0;
  mat.roughness = glossy ? 0.22 : 0.72;
  mat.metalness = 0;
  mat.envMapIntensity = glossy ? 1.1 : 0.6;
  mat.needsUpdate = true;
}

export function applyClayLook(mat: THREE.MeshStandardMaterial) {
  mat.map?.dispose();
  mat.map = null;
  mat.vertexColors = false;
  mat.color.copy(CLAY_COLOR);
  mat.emissive.set('#000000');
  mat.emissiveIntensity = 0;
  mat.roughness = 0.95;
  mat.envMapIntensity = 1;
  mat.needsUpdate = true;
}

/**
 * Animated firing: the clay heats up, glows, cools to terracotta and shrinks a touch.
 * Resolves when the mesh is baked (vertex colours filled with the fired colour).
 */
export function runBake(
  mesh: THREE.Mesh<THREE.BufferGeometry, THREE.MeshStandardMaterial>,
  onProgress: (p: number) => void,
  durationMs = 3200,
): Promise<void> {
  return new Promise((resolve) => {
    const mat = mesh.material;
    const start = performance.now();
    const tick = () => {
      const p = Math.min(1, (performance.now() - start) / durationMs);
      const ease = p * p * (3 - 2 * p);
      mat.color.copy(CLAY_COLOR).lerp(FIRED_COLOR, ease);
      const glow = Math.sin(p * Math.PI);
      mat.emissive.copy(GLOW);
      mat.emissiveIntensity = glow * glow * 0.9;
      mat.roughness = 0.95 - 0.23 * ease;
      const s = 1 - 0.03 * ease;
      mesh.scale.setScalar(s);
      onProgress(p);
      if (p < 1) { requestAnimationFrame(tick); return; }

      // Bake the shrink into the geometry so the mesh transform stays identity for brushing.
      mesh.scale.setScalar(1);
      const g = mesh.geometry;
      const pos = g.getAttribute('position') as THREE.BufferAttribute;
      const arr = pos.array as Float32Array;
      g.computeBoundingBox();
      const minY = g.boundingBox!.min.y;
      for (let i = 0; i < arr.length; i += 3) {
        arr[i] *= s;
        arr[i + 1] = (arr[i + 1] - minY) * s + minY;
        arr[i + 2] *= s;
      }
      pos.needsUpdate = true;
      g.computeVertexNormals();
      g.computeBoundingBox();
      g.computeBoundingSphere();

      const n = pos.count;
      const col = new Float32Array(n * 3);
      for (let i = 0; i < n; i++) { col[i * 3] = FIRED_COLOR.r; col[i * 3 + 1] = FIRED_COLOR.g; col[i * 3 + 2] = FIRED_COLOR.b; }
      g.setAttribute('color', new THREE.BufferAttribute(col, 3));
      applyFiredLook(mat, false);
      resolve();
    };
    requestAnimationFrame(tick);
  });
}
