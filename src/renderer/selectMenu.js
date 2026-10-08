/**
 * Select Menu Module
 * Every native <select> in the renderer opens Frame's own dropdown (the
 * project switcher's look, components/menu.css) instead of the OS popup.
 *
 * The <select> stays the real control: its options are read when the menu
 * opens, and a choice sets `select.value` and fires `change`, so every
 * module that listens to its select keeps working untouched. One
 * document-level listener covers selects rendered later too.
 */

const CHECK = '<svg class="select-menu-item-check" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="20 6 9 17 4 12"/></svg>';

let current = null; // { select, menu, items, index }

function init() {
  document.addEventListener('mousedown', onMouseDown, true);
}

/** The box the menu hangs under: a picker's styled label, else the select. */
function anchorFor(select) {
  return select.closest('.ai-tool-picker') || select;
}

function onMouseDown(e) {
  if (current && current.menu.contains(e.target)) return;

  const picker = e.target.closest && e.target.closest('.ai-tool-picker');
  const select = picker ? picker.querySelector('select') : (e.target.closest && e.target.closest('select'));

  if (!select || select.disabled || select.multiple || select.size > 1) {
    close();
    return;
  }

  e.preventDefault();
  if (current && current.select === select) {
    close();
    return;
  }
  close();
  select.focus({ preventScroll: true });
  open(select);
}

function open(select) {
  const menu = document.createElement('div');
  menu.className = 'select-menu';
  menu.setAttribute('role', 'listbox');

  const items = [];
  Array.from(select.options).forEach((opt) => {
    if (opt.hidden) return;
    const item = document.createElement('button');
    item.type = 'button';
    item.className = 'select-menu-item' + (opt.selected ? ' active' : '');
    item.setAttribute('role', 'option');
    item.setAttribute('aria-selected', opt.selected ? 'true' : 'false');
    item.disabled = opt.disabled;
    item.innerHTML = '<span class="select-menu-item-name"></span>' + (opt.selected ? CHECK : '');
    item.querySelector('.select-menu-item-name').textContent = opt.textContent;
    item.addEventListener('click', () => choose(select, opt.value));
    item.addEventListener('mouseenter', () => highlight(items.indexOf(item)));
    menu.appendChild(item);
    items.push(item);
  });
  if (!items.length) return;

  document.body.appendChild(menu);
  place(menu, anchorFor(select));

  current = { select, menu, items, index: -1 };
  highlight(Math.max(0, select.selectedIndex));
  select.setAttribute('aria-expanded', 'true');

  document.addEventListener('keydown', onKeydown, true);
  window.addEventListener('resize', close);
  window.addEventListener('blur', close);
  document.addEventListener('scroll', onScroll, true);
}

/** Under the anchor, left-aligned, at least as wide; flips up when short. */
function place(menu, anchor) {
  const r = anchor.getBoundingClientRect();
  menu.style.minWidth = `${Math.round(r.width)}px`;
  menu.style.left = `${Math.round(r.left)}px`;
  menu.style.top = `${Math.round(r.bottom + 4)}px`;

  const m = menu.getBoundingClientRect();
  if (m.right > window.innerWidth - 8) {
    menu.style.left = `${Math.max(8, Math.round(window.innerWidth - 8 - m.width))}px`;
  }
  if (m.bottom > window.innerHeight - 8 && r.top - 4 - m.height >= 8) {
    menu.style.top = `${Math.round(r.top - 4 - m.height)}px`;
  }
}

function highlight(index) {
  if (!current) return;
  current.items.forEach((el, i) => el.classList.toggle('highlight', i === index));
  current.index = index;
  const el = current.items[index];
  if (el) el.scrollIntoView({ block: 'nearest' });
}

function choose(select, value) {
  close();
  if (select.value === value) return;
  select.value = value;
  select.dispatchEvent(new Event('input', { bubbles: true }));
  select.dispatchEvent(new Event('change', { bubbles: true }));
}

function onKeydown(e) {
  if (!current) return;
  const { items } = current;
  const step = (dir) => {
    let i = current.index;
    for (let n = 0; n < items.length; n++) {
      i = (i + dir + items.length) % items.length;
      if (!items[i].disabled) return highlight(i);
    }
  };
  if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); }
  else if (e.key === 'ArrowDown') { e.preventDefault(); e.stopPropagation(); step(1); }
  else if (e.key === 'ArrowUp') { e.preventDefault(); e.stopPropagation(); step(-1); }
  else if (e.key === 'Enter' || e.key === ' ') {
    e.preventDefault();
    e.stopPropagation();
    const el = items[current.index];
    if (el && !el.disabled) el.click();
  } else if (e.key === 'Tab') {
    close();
  }
}

function onScroll(e) {
  if (current && !current.menu.contains(e.target)) close();
}

function close() {
  if (!current) return;
  current.menu.remove();
  current.select.setAttribute('aria-expanded', 'false');
  current = null;
  document.removeEventListener('keydown', onKeydown, true);
  window.removeEventListener('resize', close);
  window.removeEventListener('blur', close);
  document.removeEventListener('scroll', onScroll, true);
}

module.exports = { init, close };
