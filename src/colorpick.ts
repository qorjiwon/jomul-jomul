import { el } from './ui';

// Always-open color picker for the paint panel: a saturation/brightness square over a hue strip.
// (The browser's <input type=color> hides all of this behind a click.)

function hsvToHex(h: number, s: number, v: number) {
  const f = (n: number) => {
    const k = (n + h / 60) % 6;
    return v - v * s * Math.max(0, Math.min(k, 4 - k, 1));
  };
  return '#' + [f(5), f(3), f(1)].map((x) => Math.round(x * 255).toString(16).padStart(2, '0')).join('');
}

function hexToHsv(hex: string): [number, number, number] {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
  const mx = Math.max(r, g, b), d = mx - Math.min(r, g, b);
  let h = 0;
  if (d) h = mx === r ? ((g - b) / d) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return [(h * 60 + 360) % 360, mx ? d / mx : 0, mx];
}

export function colorPicker(initial: string, onChange: (hex: string) => void) {
  const root = el('div', 'cp');
  const sv = el('div', 'cp-sv');
  const hue = el('div', 'cp-hue');
  const svDot = el('i'), hueDot = el('i');
  sv.append(svDot);
  hue.append(hueDot);
  sv.tabIndex = hue.tabIndex = 0;
  sv.setAttribute('aria-label', '채도와 밝기 (방향키로 조절)');
  hue.setAttribute('aria-label', '색상 (←→로 조절)');
  const now = el('div', 'cp-now');
  const chip = el('i'), code = el('code');
  now.append(chip, code);
  root.append(sv, hue, now);

  let [h, s, v] = hexToHsv(initial);
  const draw = () => {
    const hex = hsvToHex(h, s, v);
    sv.style.backgroundColor = hsvToHex(h, 1, 1);
    svDot.style.left = `${s * 100}%`;
    svDot.style.top = `${(1 - v) * 100}%`;
    svDot.style.background = hex;
    hueDot.style.left = `${(h / 360) * 100}%`;
    hueDot.style.background = hsvToHex(h, 1, 1);
    chip.style.background = hex;
    code.textContent = hex;
    return hex;
  };
  const emit = () => onChange(draw());

  const drag = (area: HTMLElement, apply: (x: number, y: number) => void) => {
    area.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      area.focus();
      area.setPointerCapture(e.pointerId);
      const move = (ev: PointerEvent) => {
        const r = area.getBoundingClientRect();
        apply(Math.min(1, Math.max(0, (ev.clientX - r.left) / r.width)), Math.min(1, Math.max(0, (ev.clientY - r.top) / r.height)));
        emit();
      };
      move(e);
      const up = () => { area.removeEventListener('pointermove', move); area.removeEventListener('pointerup', up); area.removeEventListener('pointercancel', up); };
      area.addEventListener('pointermove', move);
      area.addEventListener('pointerup', up);
      area.addEventListener('pointercancel', up);
    });
  };
  drag(sv, (x, y) => { s = x; v = 1 - y; });
  drag(hue, (x) => { h = Math.min(359.9, x * 360); });

  const nudge = (area: HTMLElement, fn: (dx: number, dy: number) => void) => {
    area.addEventListener('keydown', (e) => {
      const d = e.shiftKey ? 0.1 : 0.02;
      const dx = e.key === 'ArrowRight' ? d : e.key === 'ArrowLeft' ? -d : 0;
      const dy = e.key === 'ArrowDown' ? d : e.key === 'ArrowUp' ? -d : 0;
      if (!dx && !dy) return;
      e.preventDefault();
      e.stopPropagation();
      fn(dx, dy);
      emit();
    });
  };
  const clamp = (x: number) => Math.min(1, Math.max(0, x));
  nudge(sv, (dx, dy) => { s = clamp(s + dx); v = clamp(v - dy); });
  nudge(hue, (dx) => { h = (h + dx * 360 + 360) % 360; });

  draw();
  return {
    root,
    /** Show a color picked elsewhere (swatch, eyedropper) without calling onChange back. */
    set(hex: string) {
      [h, s, v] = hexToHsv(hex);
      draw();
    },
  };
}
