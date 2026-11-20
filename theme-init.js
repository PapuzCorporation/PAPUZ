/* тема применяется до первой отрисовки, чтобы не было вспышки */
(function () {
  try {
    var ok = ['dark', 'black', 'light', 'copper', 'neon', 'ocean', 'sakura', 'simple'];
    var t = localStorage.getItem('papuz-theme') || 'dark';
    if (ok.indexOf(t) < 0) t = 'dark';
    document.documentElement.dataset.theme = t;
    var c = {
      dark: '#05080a', black: '#000000', light: '#f2f6f0', copper: '#0e0906',
      neon: '#07050d', ocean: '#040b12', sakura: '#fbf4f7', simple: '#101010'
    };
    var m = document.querySelector('meta[name="theme-color"]');
    if (m) m.setAttribute('content', c[t]);

    var patterns = ['cosmos', 'games', 'nature', 'music', 'food', 'animals', 'travel', 'party'];
    var legacy = { dots: 'cosmos', waves: 'nature', grid: 'games', diag: 'music', rings: 'food', plaid: 'travel', zigzag: 'party', aurora: 'cosmos' };
    var wp = localStorage.getItem('papuz-wallpaper') || 'none';
    if (legacy[wp]) wp = legacy[wp];
    if (wp !== 'none' && patterns.indexOf(wp) < 0) wp = 'none';
    if (wp !== 'none') document.documentElement.dataset.wallpaper = wp;

    var tones = ['light', 'dark', 'theme', 'colorful'];
    var wt = localStorage.getItem('papuz-wall-tone') || 'theme';
    if (tones.indexOf(wt) < 0) wt = 'theme';
    document.documentElement.dataset.wallTone = wt;
  } catch (e) { /* приватный режим */ }
})();
