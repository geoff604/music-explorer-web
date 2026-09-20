/** A small, dependency-free menu bar and toolbar. */

export interface MenuItem {
  label?: string;
  /** Keyboard shortcut, shown right-aligned (display only; App wires the keys). */
  accel?: string;
  run?: () => void;
  /** Shows a tick (or a dot with `radio`) when this returns true. */
  checked?: () => boolean;
  radio?: boolean;
  enabled?: () => boolean;
  separator?: true;
}

export interface MenuDef {
  label: string;
  items: MenuItem[];
}

export interface Refreshable {
  refresh(): void;
}

export function buildMenuBar(host: HTMLElement, menus: MenuDef[]): Refreshable {
  const refreshers: Array<() => void> = [];
  const buttons: HTMLButtonElement[] = [];
  const popups: HTMLElement[] = [];
  let openIndex = -1;

  const close = (returnFocus = false) => {
    if (openIndex < 0) return;
    const btn = buttons[openIndex] as HTMLButtonElement;
    (popups[openIndex] as HTMLElement).hidden = true;
    btn.setAttribute('aria-expanded', 'false');
    if (returnFocus) btn.focus();
    openIndex = -1;
  };

  const open = (index: number, focusFirst: boolean) => {
    close();
    const btn = buttons[index] as HTMLButtonElement;
    const popup = popups[index] as HTMLElement;
    for (const r of refreshers) r();
    popup.style.left = `${btn.offsetLeft}px`;
    popup.style.top = `${btn.offsetTop + btn.offsetHeight + 2}px`;
    popup.hidden = false;
    btn.setAttribute('aria-expanded', 'true');
    openIndex = index;
    if (focusFirst) enabledItems(popup)[0]?.focus();
  };

  const enabledItems = (popup: HTMLElement) =>
    Array.from(popup.querySelectorAll<HTMLButtonElement>('button:not(:disabled)'));

  menus.forEach((menu, index) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = menu.label;
    button.setAttribute('aria-haspopup', 'menu');
    button.setAttribute('aria-expanded', 'false');

    const popup = document.createElement('div');
    popup.className = 'menu-popup';
    popup.setAttribute('role', 'menu');
    popup.hidden = true;

    for (const item of menu.items) {
      if (item.separator) {
        popup.appendChild(document.createElement('hr')).setAttribute('role', 'separator');
        continue;
      }
      const row = document.createElement('button');
      row.type = 'button';
      row.setAttribute('role', item.radio ? 'menuitemradio' : item.checked ? 'menuitemcheckbox' : 'menuitem');
      const check = document.createElement('span');
      check.className = 'check';
      const label = document.createElement('span');
      label.textContent = item.label ?? '';
      const accel = document.createElement('span');
      accel.className = 'accel';
      accel.textContent = item.accel ?? '';
      row.append(check, label, accel);
      row.addEventListener('click', () => {
        close();
        item.run?.();
      });
      popup.appendChild(row);

      refreshers.push(() => {
        row.disabled = item.enabled ? !item.enabled() : false;
        const on = item.checked ? item.checked() : false;
        check.textContent = on ? (item.radio ? '•' : '✓') : '';
        if (item.checked) row.setAttribute('aria-checked', String(on));
      });
    }

    button.addEventListener('click', () => (openIndex === index ? close() : open(index, false)));
    button.addEventListener('pointerenter', () => {
      if (openIndex >= 0 && openIndex !== index) open(index, false);
    });
    button.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowDown' || e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        open(index, true);
      } else if (e.key === 'ArrowRight') {
        (buttons[(index + 1) % buttons.length] as HTMLButtonElement).focus();
      } else if (e.key === 'ArrowLeft') {
        (buttons[(index - 1 + buttons.length) % buttons.length] as HTMLButtonElement).focus();
      }
    });
    popup.addEventListener('keydown', (e) => {
      const items = enabledItems(popup);
      const at = items.indexOf(document.activeElement as HTMLButtonElement);
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        items[(at + 1) % items.length]?.focus();
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        items[(at - 1 + items.length) % items.length]?.focus();
      } else if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
        e.preventDefault();
        const next = (index + (e.key === 'ArrowRight' ? 1 : -1) + menus.length) % menus.length;
        open(next, true);
      } else if (e.key === 'Escape') {
        e.preventDefault();
        close(true);
      } else if (e.key === 'Tab') {
        close();
      }
    });

    buttons.push(button);
    popups.push(popup);
    host.append(button, popup);
  });

  document.addEventListener('pointerdown', (e) => {
    if (openIndex >= 0 && !host.contains(e.target as Node)) close();
  });
  window.addEventListener('blur', () => close());

  return { refresh: () => refreshers.forEach((r) => r()) };
}

export interface ToolbarItem {
  title: string;
  /** Inner SVG markup for a 24x24 viewBox. */
  icon: string;
  run: () => void;
  enabled?: () => boolean;
  separatorBefore?: true;
}

export function buildToolbar(host: HTMLElement, items: ToolbarItem[]): Refreshable {
  const refreshers: Array<() => void> = [];
  for (const item of items) {
    if (item.separatorBefore) {
      const sep = document.createElement('span');
      sep.className = 'sep';
      sep.setAttribute('role', 'separator');
      host.appendChild(sep);
    }
    const button = document.createElement('button');
    button.type = 'button';
    button.title = item.title.replace('\n', ' — ');
    button.setAttribute('aria-label', item.title.split('\n')[0] as string);
    button.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true">${item.icon}</svg>`;
    button.addEventListener('click', () => item.run());
    host.appendChild(button);
    refreshers.push(() => {
      button.disabled = item.enabled ? !item.enabled() : false;
    });
  }
  return { refresh: () => refreshers.forEach((r) => r()) };
}

export const ICONS = {
  open: '<path d="M3 6a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
  play: '<path d="M7 4.5v15l13-7.5z"/>',
  stop: '<rect x="6" y="6" width="12" height="12" rx="1"/>',
  zoomIn: '<path d="M11 5h2v6h6v2h-6v6h-2v-6H5v-2h6z"/>',
  zoomOut: '<path d="M5 11h14v2H5z"/>',
  magnifyOut:
    '<g fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="10" cy="10" r="6.5"/><path d="M15 15l6 6M7 10h6"/></g>',
  magnifyIn:
    '<g fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="10" cy="10" r="6.5"/><path d="M15 15l6 6M7 10h6M10 7v6"/></g>',
  help: '<path d="M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zm1 16h-2v-2h2zm2.1-7.7-.9.9c-.7.7-1.2 1.3-1.2 2.8h-2v-.5c0-1.1.5-2.1 1.2-2.8l1.2-1.3c.4-.3.6-.8.6-1.4 0-1.1-.9-2-2-2s-2 .9-2 2H8c0-2.2 1.8-4 4-4s4 1.8 4 4c0 .9-.4 1.7-.9 2.3z"/>',
} as const;
