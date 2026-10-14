export function $(id: string): HTMLElement {
  const n = document.getElementById(id);
  if (!n) throw new Error(`missing #${id}`);
  return n;
}

export function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls = '', html = ''): HTMLElementTagNameMap[K] {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (html) n.innerHTML = html;
  return n;
}

export function section(title?: string): HTMLElement {
  const s = el('div', 'sec');
  if (title) s.append(el('label', 'title', title));
  return s;
}

export function button(label: string, cls: string, onClick: () => void): HTMLButtonElement {
  const b = el('button', `btn ${cls}`.trim(), label);
  b.addEventListener('click', onClick);
  return b;
}

export interface SliderOpts {
  label: string; min: number; max: number; step: number; value: number;
  format?: (v: number) => string;
  onInput: (v: number) => void;
}

export function slider(o: SliderOpts) {
  const root = el('div', 'slider');
  const lab = el('span', '', o.label);
  const out = el('output');
  const input = el('input');
  input.type = 'range';
  input.min = String(o.min); input.max = String(o.max); input.step = String(o.step); input.value = String(o.value);
  const fmt = o.format ?? ((v: number) => String(Math.round(v * 100)));
  const show = () => { out.textContent = fmt(Number(input.value)); };
  input.addEventListener('input', () => { show(); o.onInput(Number(input.value)); });
  show();
  root.append(lab, out, input);
  return {
    root,
    get value() { return Number(input.value); },
    set(v: number) {
      const c = Math.min(o.max, Math.max(o.min, v));
      input.value = String(c);
      show();
      o.onInput(c);
    },
  };
}

export function toggle(label: string, checked: boolean, onChange: (v: boolean) => void) {
  const root = el('label', 'switch');
  const span = el('span', '', label);
  const input = el('input');
  input.type = 'checkbox';
  input.checked = checked;
  input.addEventListener('change', () => onChange(input.checked));
  root.append(span, input);
  return {
    root,
    get checked() { return input.checked; },
    set(v: boolean) { input.checked = v; onChange(v); },
  };
}

export interface ToolDef<T extends string> { id: T; name: string; icon: string; key: string }

export function toolGrid<T extends string>(tools: ToolDef<T>[], onSelect: (id: T) => void) {
  const root = el('div', 'tool-grid');
  const btns = new Map<T, HTMLButtonElement>();
  for (const t of tools) {
    const b = el('button', 'tool');
    b.append(el('span', 'ico', t.icon), el('span', '', t.name), el('kbd', '', t.key));
    b.addEventListener('click', () => select(t.id));
    btns.set(t.id, b);
    root.append(b);
  }
  function setActive(id: T) {
    for (const [k, b] of btns) b.classList.toggle('active', k === id);
  }
  function select(id: T) { setActive(id); onSelect(id); }
  return { root, setActive, select };
}

let toastTimer = 0;
export function toast(msg: string, ms = 2000) {
  const t = $('toast');
  t.textContent = msg;
  t.hidden = false;
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => { t.hidden = true; }, ms);
}

export function setStep(step: string) {
  const order = ['pick', 'sculpt', 'bake', 'paint', 'done'];
  const idx = order.indexOf(step);
  document.querySelectorAll<HTMLLIElement>('#stepper li').forEach((li) => {
    const i = order.indexOf(li.dataset.step ?? '');
    li.classList.toggle('active', i === idx);
    li.classList.toggle('done', i < idx);
  });
}

export function setHint(text: string) {
  $('hint').textContent = text;
}

export function fmtDate(ts: number) {
  const d = new Date(ts);
  return `${d.getFullYear()}.${String(d.getMonth() + 1).padStart(2, '0')}.${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}
