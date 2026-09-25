// Tiny radial icon menu (DESIGN.md §13.2): icon buttons fanned on an arc around an anchor.
//   openRadial(anchorEl, items, {side:'right'|'down'}) → close()
//   items: [{icon, label, sub, active, onSelect}]

import { h, s, floatLayer } from './dom.js';
import { icon } from './icons.js';
import { setTip, hideTip, focusQuietly } from './tooltip.js';

let openMenu = null;

export function closeRadial() {
  if (openMenu) openMenu.close();
}

export function radialOpen() {
  return !!openMenu;
}

export function openRadial(anchor, items, { side = 'right', radius = 54, spread = 104, onClose } = {}) {
  closeRadial();
  const r = anchor.getBoundingClientRect();
  const cx = side === 'right' ? r.right - 10 : r.left + r.width / 2;
  const cy = side === 'right' ? r.top + r.height / 2 : r.bottom - 8;
  let base = side === 'right' ? 0 : 90;   // degrees, screen coords (y down)
  const n = items.length;
  // keep the fan on screen: rotate it away from the top bar / console when the token is near
  // either end of the rail
  if (side === 'right') {
    const top = 64, bottom = window.innerHeight - 70;
    const s0 = Math.sin(((base - spread / 2) * Math.PI) / 180) * radius;
    const s1 = Math.sin(((base + spread / 2) * Math.PI) / 180) * radius;
    if (cy + s0 < top) base += (Math.asin(Math.max(-1, Math.min(1, (top - cy) / radius))) * 180) / Math.PI + spread / 2;
    else if (cy + s1 > bottom) base -= spread / 2 - (Math.asin(Math.max(-1, Math.min(1, (bottom - cy) / radius))) * 180) / Math.PI;
    base = Math.max(-40, Math.min(40, base));
  } else {
    const left = 12, right = window.innerWidth - 12;
    const c0 = Math.cos(((base + spread / 2) * Math.PI) / 180) * radius;   // leftmost
    const c1 = Math.cos(((base - spread / 2) * Math.PI) / 180) * radius;   // rightmost
    if (cx + c0 < left + 16) base -= Math.min(40, (left + 16 - (cx + c0)) / radius * 57);
    else if (cx + c1 > right - 16) base += Math.min(40, ((cx + c1) - (right - 16)) / radius * 57);
  }
  const angles = items.map((_, i) => base - spread / 2 + (n > 1 ? (spread * i) / (n - 1) : spread / 2));

  const root = h('div', { class: `radial radial-${side}`, role: 'menu', style: { left: `${cx}px`, top: `${cy}px` } });
  // decorative hairline arc behind the buttons
  const a0 = ((angles[0] - 8) * Math.PI) / 180, a1 = ((angles[n - 1] + 8) * Math.PI) / 180;
  const arc = s('svg', { class: 'radial-arc', viewBox: '-80 -80 160 160', 'aria-hidden': 'true' },
    s('path', { d: `M${(radius * Math.cos(a0)).toFixed(1)} ${(radius * Math.sin(a0)).toFixed(1)}A${radius} ${radius} 0 0 1 ${(radius * Math.cos(a1)).toFixed(1)} ${(radius * Math.sin(a1)).toFixed(1)}` }));
  root.append(arc);

  const buttons = items.map((it, i) => {
    const a = (angles[i] * Math.PI) / 180;
    const b = h('button', {
      class: `radial-item${it.active ? ' active' : ''}${it.disabled ? ' disabled' : ''}`,
      type: 'button',
      role: 'menuitem',
      'aria-label': it.label,
      'aria-disabled': it.disabled ? 'true' : null,
      style: {
        '--x': `${(radius * Math.cos(a)).toFixed(1)}px`,
        '--y': `${(radius * Math.sin(a)).toFixed(1)}px`,
        '--d': `${i * 22}ms`,
      },
      html: icon(it.icon),
    });
    setTip(b, { title: it.label, sub: it.sub }, side === 'right' ? 'right' : 'bottom');
    b.addEventListener('click', (e) => {
      e.stopPropagation();
      if (it.disabled) {
        b.classList.remove('nope');
        void b.offsetWidth;
        b.classList.add('nope');
        return;
      }
      close();
      it.onSelect?.();
    });
    root.append(b);
    return b;
  });

  floatLayer().append(root);
  requestAnimationFrame(() => root.classList.add('open'));
  anchor.setAttribute('aria-expanded', 'true');

  function onDocDown(e) {
    if (!root.contains(e.target) && e.target !== anchor && !anchor.contains(e.target)) close();
  }
  function onKey(e) {
    const i = buttons.indexOf(document.activeElement);
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      close();
      focusQuietly(anchor);
    } else if (['ArrowDown', 'ArrowRight', 'ArrowUp', 'ArrowLeft'].includes(e.key)) {
      e.preventDefault();
      e.stopPropagation();
      const dir = e.key === 'ArrowDown' || e.key === 'ArrowRight' ? 1 : -1;
      buttons[(i + dir + n) % n].focus();
    } else if (e.key === 'Tab') {
      close();
    }
  }
  let closed = false;
  function close() {
    if (closed) return;
    closed = true;
    hideTip(true);
    document.removeEventListener('pointerdown', onDocDown, true);
    document.removeEventListener('keydown', onKey, true);
    window.removeEventListener('resize', close);
    anchor.setAttribute('aria-expanded', 'false');
    root.classList.remove('open');
    root.classList.add('closing');
    setTimeout(() => root.remove(), 180);
    if (openMenu && openMenu.close === close) openMenu = null;
    onClose?.();
  }
  document.addEventListener('pointerdown', onDocDown, true);
  document.addEventListener('keydown', onKey, true);
  window.addEventListener('resize', close);
  openMenu = { close, anchor };
  return { close, focusFirst: () => buttons[0]?.focus({ preventScroll: true }) };
}
