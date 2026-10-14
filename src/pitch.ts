import { $, el } from './ui';

/** Demo video + pitch deck: a small player floating at the bottom right of the first screen. */
const DECK_PAGES = 12;
const page = (i: number) => `/pitch/p-${String(i).padStart(2, '0')}.jpg`;
let dismissed = false;

export function setupPitch() {
  const mini = $('pitch-mini');
  const video = mini.querySelector('video')!;
  mini.querySelector('.pm-close')!.addEventListener('click', () => { dismissed = true; showPitchMini(false); });
  video.addEventListener('click', openVideo);
  mini.querySelector('.pm-big')!.addEventListener('click', openVideo);
  mini.querySelector('.pm-deck')!.addEventListener('click', openDeck);
}

export function showPitchMini(on: boolean) {
  const mini = $('pitch-mini');
  mini.hidden = !on || dismissed;
  const v = mini.querySelector('video')!;
  if (mini.hidden) v.pause();
  else void v.play().catch(() => {});
}

/** Full-screen layer that closes on ✕, Esc or a click on the backdrop. Keys don't reach the studio behind it. */
function layer(cls: string, onKey?: (e: KeyboardEvent) => void) {
  const wrap = el('div', `pitch-layer ${cls}`);
  const x = el('button', 'pitch-x', '✕');
  x.setAttribute('aria-label', '닫기');
  const key = (e: KeyboardEvent) => {
    e.stopPropagation();
    if (e.key === 'Escape') close();
    else onKey?.(e);
  };
  function close() {
    wrap.remove();
    document.removeEventListener('keydown', key, true);
  }
  x.addEventListener('click', close);
  wrap.addEventListener('pointerdown', (e) => { if (e.target === wrap) close(); });
  document.addEventListener('keydown', key, true);
  wrap.append(x);
  document.body.append(wrap);
  return wrap;
}

function openVideo() {
  const wrap = layer('pitch-video');
  const v = el('video');
  Object.assign(v, { src: '/pitch/demo.mp4', muted: true, playsInline: true, controls: true, autoplay: true });
  wrap.append(v);
}

function openDeck() {
  let i = 1;
  const img = el('img');
  img.alt = '조물조물 피치덱';
  const pg = el('span', 'pg');
  const go = (d: number) => {
    i = Math.max(1, Math.min(DECK_PAGES, i + d));
    img.src = page(i);
    pg.textContent = `${i} / ${DECK_PAGES}`;
    prev.disabled = i === 1;
    next.disabled = i === DECK_PAGES;
  };
  const wrap = layer('pitch-deck', (e) => {
    if (e.key === 'ArrowRight' || e.key === ' ') { e.preventDefault(); go(1); }
    if (e.key === 'ArrowLeft') go(-1);
  });
  const prev = el('button', 'pitch-nav prev', '‹');
  const next = el('button', 'pitch-nav next', '›');
  prev.setAttribute('aria-label', '이전 장');
  next.setAttribute('aria-label', '다음 장');
  prev.addEventListener('click', () => go(-1));
  next.addEventListener('click', () => go(1));
  const slide = el('div', 'pitch-slide');
  slide.append(img, prev, next);
  const bar = el('div', 'pitch-bar');
  const dl = el('a', '', 'PDF 내려받기');
  dl.href = '/pitch/deck.pdf';
  dl.download = '조물조물-피치덱.pdf';
  bar.append(pg, el('span', '', '·'), el('span', '', '← → 로 넘기기'), el('span', '', '·'), dl);
  wrap.append(slide, bar);
  for (let k = 2; k <= DECK_PAGES; k++) new Image().src = page(k); // warm up so paging is instant
  go(0);
}
