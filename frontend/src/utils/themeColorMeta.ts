// 让 <meta name="theme-color"> 与当前主题背景保持一致（移动端浏览器顶栏配色）
// 取各主题渐变背景的「起始纯色」作为代表色。

const THEME_BG_COLOR: Record<string, string> = {
  'light:monitor': '#f7f5ff',
  'light:next': '#eefcfb',
  'dark:monitor': '#0a0814',
  'dark:next': '#070b12',
};

const FALLBACK_COLOR = '#0a0814';

export function syncThemeColorMeta() {
  if (typeof document === 'undefined') return;

  const html = document.documentElement;
  const appearanceAttr = html.getAttribute('data-theme-appearance');
  const appearance =
    appearanceAttr === 'light' || appearanceAttr === 'dark'
      ? appearanceAttr
      : window.matchMedia('(prefers-color-scheme: dark)').matches
        ? 'dark'
        : 'light';
  const display = html.getAttribute('data-monitor-theme') === 'next' ? 'next' : 'monitor';
  const color = THEME_BG_COLOR[`${appearance}:${display}`] ?? FALLBACK_COLOR;

  let meta = document.querySelector('meta[name="theme-color"]');
  if (!meta) {
    meta = document.createElement('meta');
    meta.setAttribute('name', 'theme-color');
    document.head.appendChild(meta);
  }
  meta.setAttribute('content', color);
}
