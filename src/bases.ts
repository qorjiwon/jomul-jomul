import type { Prim, Shape, V3 } from './sdf';

export interface BaseDef {
  id: string;
  name: string;
  emoji: string;
  desc: string;
  shape: Shape;
}

const S = (c: V3, r: number): Prim => ({ t: 'sphere', c, r });
const E = (c: V3, r: V3): Prim => ({ t: 'ellipsoid', c, r });
const C = (a: V3, b: V3, r: number, r2?: number): Prim => ({ t: 'capsule', a, b, r, r2 });

/** Returns the primitive plus its mirror across the x=0 plane. */
function M(...prims: Prim[]): Prim[] {
  const out: Prim[] = [];
  const flip = (v: V3): V3 => [-v[0], v[1], v[2]];
  for (const p of prims) {
    out.push(p);
    if (p.t === 'capsule') out.push({ ...p, a: flip(p.a), b: flip(p.b) });
    else out.push({ ...p, c: flip(p.c) });
  }
  return out;
}

export const BASES: BaseDef[] = [
  {
    id: 'person',
    name: '사람',
    emoji: '🧑',
    desc: '머리가 큰 귀여운 사람 반죽',
    shape: {
      blend: 0.06,
      prims: [
        S([0, 1.52, 0], 0.46),
        S([0, 1.46, 0.44], 0.06),
        C([0, 1.05, 0], [0, 1.2, 0], 0.13),
        C([0, 1.02, 0], [0, 0.7, 0], 0.31, 0.27),
        E([0, 0.62, 0], [0.3, 0.2, 0.22]),
        ...M(
          S([0.44, 1.52, 0], 0.08),
          C([0.3, 1.0, 0], [0.46, 0.62, 0.06], 0.1, 0.085),
          S([0.48, 0.56, 0.08], 0.11),
          C([0.14, 0.55, 0], [0.15, 0.12, 0], 0.12, 0.1),
          E([0.16, 0.1, 0.07], [0.14, 0.1, 0.22]),
        ),
      ],
    },
  },
  {
    id: 'cat',
    name: '고양이',
    emoji: '🐱',
    desc: '뾰족 귀와 긴 꼬리',
    shape: {
      blend: 0.07,
      prims: [
        C([0, 0.62, -0.3], [0, 0.66, 0.25], 0.3),
        S([0, 0.64, 0.3], 0.3),
        S([0, 1.0, 0.55], 0.34),
        E([0, 0.92, 0.6], [0.4, 0.25, 0.3]),
        E([0, 0.9, 0.86], [0.13, 0.09, 0.1]),
        C([0, 0.6, -0.55], [0, 0.95, -0.85], 0.07),
        C([0, 0.95, -0.85], [0, 1.25, -0.7], 0.06, 0.045),
        ...M(
          C([0.2, 1.22, 0.5], [0.3, 1.5, 0.45], 0.1, 0.03),
          C([0.17, 0.5, 0.22], [0.17, 0.08, 0.26], 0.09),
          C([0.18, 0.5, -0.3], [0.18, 0.08, -0.32], 0.1),
          S([0.17, 0.09, 0.3], 0.1),
          S([0.18, 0.09, -0.3], 0.1),
        ),
      ],
    },
  },
  {
    id: 'dog',
    name: '강아지',
    emoji: '🐶',
    desc: '축 늘어진 귀와 긴 코',
    shape: {
      blend: 0.08,
      prims: [
        C([0, 0.6, -0.35], [0, 0.62, 0.25], 0.32, 0.3),
        S([0, 1.0, 0.55], 0.36),
        C([0, 0.92, 0.75], [0, 0.9, 0.98], 0.17, 0.12),
        S([0, 0.95, 1.08], 0.06),
        C([0, 0.7, -0.62], [0, 1.05, -0.8], 0.07, 0.05),
        ...M(
          E([0.36, 0.95, 0.45], [0.1, 0.26, 0.16]),
          C([0.18, 0.5, 0.22], [0.18, 0.08, 0.24], 0.1),
          C([0.19, 0.5, -0.3], [0.19, 0.08, -0.32], 0.11),
          S([0.18, 0.09, 0.27], 0.11),
          S([0.19, 0.09, -0.3], 0.11),
        ),
      ],
    },
  },
  {
    id: 'rabbit',
    name: '토끼',
    emoji: '🐰',
    desc: '긴 귀와 둥근 몸',
    shape: {
      blend: 0.08,
      prims: [
        E([0, 0.55, -0.05], [0.42, 0.5, 0.45]),
        S([0, 1.18, 0.25], 0.36),
        E([0, 1.1, 0.3], [0.38, 0.25, 0.3]),
        S([0, 1.1, 0.6], 0.05),
        S([0, 0.5, -0.5], 0.14),
        ...M(
          C([0.14, 1.45, 0.15], [0.2, 2.05, 0.05], 0.1, 0.08),
          E([0.22, 0.1, 0.25], [0.14, 0.1, 0.3]),
          S([0.18, 0.62, 0.35], 0.1),
        ),
      ],
    },
  },
  {
    id: 'bear',
    name: '곰',
    emoji: '🐻',
    desc: '통통하게 서 있는 곰',
    shape: {
      blend: 0.09,
      prims: [
        E([0, 0.75, 0], [0.5, 0.55, 0.42]),
        S([0, 0.7, 0.15], 0.4),
        S([0, 1.5, 0.05], 0.4),
        E([0, 1.4, 0.4], [0.18, 0.13, 0.14]),
        S([0, 1.46, 0.52], 0.05),
        ...M(
          S([0.32, 1.78, 0], 0.12),
          C([0.42, 1.05, 0.05], [0.6, 0.65, 0.2], 0.14, 0.12),
          C([0.22, 0.45, 0], [0.24, 0.12, 0.05], 0.17, 0.16),
          E([0.25, 0.1, 0.1], [0.18, 0.1, 0.26]),
        ),
      ],
    },
  },
  {
    id: 'blob',
    name: '덩어리',
    emoji: '🟤',
    desc: '아무것도 없는 찰흙 한 덩이',
    shape: { blend: 0, prims: [S([0, 0.8, 0], 0.8)] },
  },
];

/** Pseudo-base for lumps blocked out by "AI와 첫 모형 만들기" (not shown in the picker grid). */
export const AI_BASE: BaseDef = {
  id: 'ai',
  name: 'AI 반죽',
  emoji: '✨',
  desc: 'AI가 빚어 준 첫 반죽',
  shape: { blend: 0, prims: [S([0, 0.8, 0], 0.8)] },
};

/** Pseudo-base for models brought in through "GLB 불러오기". */
export const GLB_BASE: BaseDef = {
  id: 'glb',
  name: '불러온 모형',
  emoji: '📦',
  desc: '내 GLB 파일에서 시작',
  shape: AI_BASE.shape,
};

export function findBase(id: string): BaseDef {
  if (id === AI_BASE.id) return AI_BASE;
  if (id === GLB_BASE.id) return GLB_BASE;
  return BASES.find((b) => b.id === id) ?? BASES[BASES.length - 1];
}
