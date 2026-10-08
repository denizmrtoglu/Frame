/**
 * Theme registry — the one list of themes Frame knows.
 *
 * Pure by design (no DOM, no electron) so it can be tested and required from
 * both the renderer and the palette. Everything that needs to enumerate or
 * describe themes reads from here: terminalTabBar (apply), appHeader (restore
 * and the header picker), menu.js (View › Theme),
 * index.js (View › Theme commands), terminalManager (xterm palette).
 *
 * Two attributes on <html> carry a theme:
 *   data-theme  — the theme's id ('dark', 'light-plus', …). CSS blocks in
 *                 variables.css override tokens per id.
 *   data-scheme — 'dark' | 'light', derived. Anything that only cares about
 *                 light-vs-dark (the light overrides in terminals-view.css,
 *                 the embedded report shells, which know two palettes) reads
 *                 this, so a new theme never needs a second copy of those.
 */

// xterm ANSI tables, shared by reference — a theme picks one and adds its own
// background / foreground / cursor on top.

/** VS Code's default dark terminal colours (also Frame Dark's, historically). */
const ANSI_VSCODE_DARK = {
  black: '#000000',
  red: '#cd3131',
  green: '#0dbc79',
  yellow: '#e5e510',
  blue: '#2472c8',
  magenta: '#bc3fbc',
  cyan: '#11a8cd',
  white: '#e5e5e5',
  brightBlack: '#666666',
  brightRed: '#f14c4c',
  brightGreen: '#23d18b',
  brightYellow: '#f5f543',
  brightBlue: '#3b8eea',
  brightMagenta: '#d670d6',
  brightCyan: '#29b8db',
  brightWhite: '#e5e5e5'
};

/** VS Code's default light terminal colours. */
const ANSI_VSCODE_LIGHT = {
  black: '#000000',
  red: '#cd3131',
  green: '#107c10',
  yellow: '#949800',
  blue: '#0451a5',
  magenta: '#bc05bc',
  cyan: '#0598bc',
  white: '#555555',
  brightBlack: '#666666',
  brightRed: '#cd3131',
  brightGreen: '#14ce14',
  brightYellow: '#b5ba00',
  brightBlue: '#0451a5',
  brightMagenta: '#bc05bc',
  brightCyan: '#0598bc',
  brightWhite: '#a5a5a5'
};

/** Frame Light's warm, contrast-tuned terminal colours. */
const ANSI_FRAME_LIGHT = {
  black: '#1b1b1f',
  red: '#b84040',
  green: '#4a7c50',
  yellow: '#c07820',
  blue: '#4070a8',
  magenta: '#8b4b8b',
  cyan: '#2a7a8a',
  white: '#55555c',
  brightBlack: '#84848b',
  brightRed: '#d45555',
  brightGreen: '#5a9e62',
  brightYellow: '#d49030',
  brightBlue: '#5588c8',
  brightMagenta: '#a060a0',
  brightCyan: '#3a9aaa',
  brightWhite: '#1b1b1f'
};

const THEMES = Object.freeze({
  dark: {
    label: 'Dark',
    command: 'theme.dark',
    scheme: 'dark',
    ansi: ANSI_VSCODE_DARK,
    terminal: { background: '#161717', foreground: '#c4c6c6', cursor: '#8ff0ae' }
  },
  light: {
    label: 'Light',
    command: 'theme.light',
    scheme: 'light',
    ansi: ANSI_FRAME_LIGHT,
    terminal: { background: '#f6f6f7', foreground: '#1b1b1f', cursor: '#1b1b1f' }
  },
  'dark-plus': {
    label: 'Dark+',
    command: 'theme.darkPlus',
    scheme: 'dark',
    ansi: ANSI_VSCODE_DARK,
    terminal: { background: '#1f1f1f', foreground: '#cccccc', cursor: '#cccccc' }
  },
  'light-plus': {
    label: 'Light+',
    command: 'theme.lightPlus',
    scheme: 'light',
    ansi: ANSI_VSCODE_LIGHT,
    terminal: { background: '#ffffff', foreground: '#3b3b3b', cursor: '#3b3b3b' }
  }
});

const DEFAULT_THEME = 'dark';

/** Theme ids, in menu order. */
const THEME_IDS = Object.freeze(Object.keys(THEMES));

/** A valid theme id for any input — unknown, missing or garbage falls back to the default. */
function normalize(name) {
  return Object.prototype.hasOwnProperty.call(THEMES, name) ? name : DEFAULT_THEME;
}

/** 'dark' | 'light' for a theme id (normalized first). */
function schemeOf(name) {
  return THEMES[normalize(name)].scheme;
}

/** The xterm.js `theme` option for a theme id. */
function terminalTheme(name) {
  const t = THEMES[normalize(name)];
  return { ...t.ansi, ...t.terminal };
}

module.exports = {
  THEMES, THEME_IDS, DEFAULT_THEME,
  normalize, schemeOf, terminalTheme
};
