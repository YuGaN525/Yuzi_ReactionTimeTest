(() => {
  'use strict';
  const embedded = new URLSearchParams(location.search).has('embed');
  if (embedded) document.documentElement.classList.add('embedded');
  function apply(theme) {
    document.documentElement.dataset.theme = theme === 'light' ? 'light' : 'dark';
    document.documentElement.style.colorScheme = document.documentElement.dataset.theme;
    const button = document.getElementById('themeBtn');
    if (button) { button.textContent = theme === 'light' ? '深色' : '浅色'; button.setAttribute('aria-label', theme === 'light' ? '切换深色模式' : '切换浅色模式'); }
  }
  function stored() { try { return localStorage.getItem('yuzi-theme') || 'dark'; } catch { return 'dark'; } }
  apply(stored());
  window.addEventListener('storage', event => { if (event.key === 'yuzi-theme') apply(event.newValue); });
  document.addEventListener('DOMContentLoaded', () => {
    apply(stored());
    document.getElementById('themeBtn')?.addEventListener('click', () => {
      const theme = document.documentElement.dataset.theme === 'light' ? 'dark' : 'light';
      apply(theme); try { localStorage.setItem('yuzi-theme', theme); } catch {}
    });
    if (embedded && parent !== window) {
      let frame;
      const resize = () => { cancelAnimationFrame(frame); frame = requestAnimationFrame(() => parent.postMessage({ type: 'yuz1-reaction-height', height: Math.ceil(document.body.getBoundingClientRect().height) }, location.origin)); };
      new ResizeObserver(resize).observe(document.body);
      window.addEventListener('resize', resize);
      resize();
    }
  });
})();
