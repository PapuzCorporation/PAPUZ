/* тема применяется до первой отрисовки, чтобы не было вспышки */
(function () {
  try {
    var ok = ['dark', 'black', 'light', 'copper', 'neon', 'ocean', 'sakura'];
    var t = localStorage.getItem('papuz-theme') || 'dark';
    if (ok.indexOf(t) < 0) t = 'dark';
    document.documentElement.dataset.theme = t;
    var c = {
      dark: '#05080a', black: '#000000', light: '#f2f6f0', copper: '#0e0906',
      neon: '#07050d', ocean: '#040b12', sakura: '#fbf4f7'
    };
    var m = document.querySelector('meta[name="theme-color"]');
    if (m) m.setAttribute('content', c[t]);
  } catch (e) { /* приватный режим */ }
})();
