// Help page: same light/dark design as in the app, mark the current section in
// the table of contents, and work as an overlay inside the app.
(function () {
  try {
    const s = JSON.parse(localStorage.getItem('tsweb.settings') || '{}');
    if (s.theme === 'dark' || s.theme === 'light') document.documentElement.setAttribute('data-theme', s.theme);
  } catch { /* storage not available */ }

  const embedded = window.parent !== window && new URLSearchParams(location.search).has('embedded');
  if (embedded) {
    document.documentElement.classList.add('embedded');
    const close = () => window.parent.postMessage({ tsweb: 'help-close' }, location.origin);
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') close(); });
    window.addEventListener('message', (e) => {
      if (e.origin !== location.origin || !e.data || e.data.tsweb !== 'help-goto') return;
      const target = document.getElementById(e.data.section);
      if (target) { target.scrollIntoView(); pin(e.data.section); }
    });
  }

  const links = [...document.querySelectorAll('.toc a')];
  const sections = [...document.querySelectorAll('.content section')];
  const mark = (id) => links.forEach((a) => a.classList.toggle('active', a.getAttribute('href') === '#' + id));

  // After a click in the table of contents the clicked section stays marked,
  // even if it is too short to reach the top (the last sections), until the
  // user scrolls himself.
  let pinned = null;
  function pin(id) { pinned = id; mark(id); }
  const unpin = () => { pinned = null; };
  ['wheel', 'touchstart', 'mousedown'].forEach((t) => window.addEventListener(t, unpin, { passive: true }));
  window.addEventListener('keydown', (e) => { if (['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' '].includes(e.key)) unpin(); });
  links.forEach((a) => a.addEventListener('click', () => setTimeout(() => pin(a.getAttribute('href').slice(1)), 0)));

  function update() {
    if (pinned) return;
    const atBottom = window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 4;
    if (atBottom) return mark(sections[sections.length - 1].id);
    // the last section whose top is above 30 % of the window
    const line = window.innerHeight * 0.3;
    let current = sections[0];
    for (const s of sections) if (s.getBoundingClientRect().top <= line) current = s;
    mark(current.id);
  }
  let queued = false;
  window.addEventListener('scroll', () => {
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => { queued = false; update(); });
  }, { passive: true });
  window.addEventListener('resize', update);
  if (location.hash && document.getElementById(location.hash.slice(1))) pin(location.hash.slice(1));
  else update();
})();
