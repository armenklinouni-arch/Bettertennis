// Potvrda za obrasce s atributom data-confirm (npr. brisanje).
document.addEventListener('submit', (event) => {
  const form = event.target;
  const message = form.getAttribute && form.getAttribute('data-confirm');
  if (message && !window.confirm(message)) event.preventDefault();
});

// Ako se fotografija ne može učitati (npr. bez interneta), prikazuje se nacrtani teren.
function markPhotoFailed(img) {
  const figure = img.closest('.hero-art');
  if (figure) figure.classList.add('photo-failed');
}
// Slike s data-fallback (npr. fotografije s Unsplasha): ako se ne učitaju, prikaži lokalnu ilustraciju.
function useFallback(img) {
  const fallback = img.getAttribute('data-fallback');
  if (!fallback) return;
  img.removeAttribute('data-fallback');
  img.src = fallback;
}
document.addEventListener('error', (event) => {
  if (event.target.classList && event.target.classList.contains('hero-photo')) markPhotoFailed(event.target);
  if (event.target.hasAttribute && event.target.hasAttribute('data-fallback')) useFallback(event.target);
}, true);
document.addEventListener('DOMContentLoaded', () => {
  document.querySelectorAll('.hero-photo').forEach((img) => {
    if (img.complete && img.naturalWidth === 0) markPhotoFailed(img);
  });
  document.querySelectorAll('img[data-fallback]').forEach((img) => {
    if (img.complete && img.naturalWidth === 0) useFallback(img);
  });
});

// Aktuelnosti: odabir pojedinog člana automatski uključuje opciju „Samo odabrani članovi“.
document.addEventListener('change', (event) => {
  const box = event.target;
  if (box.name !== 'member_ids' || !box.checked) return;
  const some = box.form && box.form.querySelector('input[name="audience"][value="some"]');
  if (some) some.checked = true;
});

// Termini: označavanje ostalih članova automatski bira „Grupni trening“.
document.addEventListener('change', (event) => {
  const box = event.target;
  if (box.name !== 'member_ids' || !box.checked || !box.closest('.group-members')) return;
  const kind = box.form && box.form.querySelector('select[name="kind"]');
  if (kind) kind.value = 'group';
});

// Termini: izbor stalne grupe stavi kvačice ispred svih njenih članova i bira „Grupni trening“.
document.addEventListener('change', (event) => {
  const select = event.target;
  if (!select.classList || !select.classList.contains('group-preset')) return;
  const form = select.form;
  const option = select.selectedOptions[0];
  const ids = option && option.dataset.members ? option.dataset.members.split(',') : [];
  if (ids.length === 0) return;
  // Svi članovi grupe dobiju kvačicu; pojedinačne kvačice se poslije mogu skinuti.
  const single = form.querySelector('select[name="user_id"]');
  if (single) single.value = '';
  form.querySelectorAll('.group-members input[name="member_ids"]').forEach((box) => {
    box.checked = ids.includes(box.value);
  });
  const kind = form.querySelector('select[name="kind"]');
  if (kind) kind.value = 'group';
});

// Animacija pri skrolanju: elementi s klasom .reveal se pojave kad uđu u vidno polje.
document.documentElement.classList.add('js');
document.addEventListener('DOMContentLoaded', () => {
  const items = document.querySelectorAll('.reveal');
  const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (!('IntersectionObserver' in window) || reduce) {
    items.forEach((el) => el.classList.add('is-visible'));
  } else {
    const observer = new IntersectionObserver((entries) => {
      entries.forEach((entry) => {
        if (entry.isIntersecting) {
          entry.target.classList.add('is-visible');
          observer.unobserve(entry.target);
        }
      });
    }, { threshold: 0.12, rootMargin: '0px 0px -40px 0px' });
    items.forEach((el) => observer.observe(el));
  }

  // Zaglavlje dobija sjenku nakon skrolanja.
  const header = document.querySelector('.site-header');
  const onScroll = () => header && header.classList.toggle('scrolled', window.scrollY > 8);
  onScroll();
  window.addEventListener('scroll', onScroll, { passive: true });
});

// Roditeljski račun, finansije: promjena izbora igrača odmah ponovo računa zbir (GET, ništa se ne čuva).
document.addEventListener('change', (event) => {
  const form = event.target.form;
  if (form && form.hasAttribute('data-autosubmit')) form.submit();
});

// Lista primalaca: „Označi sve“ označava samo dostupne (ne one bez e-maila ni već obaviještene).
document.addEventListener('change', (event) => {
  const box = event.target;
  const form = box.form;
  if (!form || !form.classList.contains('recipient-form')) return;
  const all = form.querySelector('[data-select-all]');
  const boxes = [...form.querySelectorAll('input[name="recipients"]:not(:disabled)')];
  if (box === all) {
    boxes.forEach((b) => { b.checked = all.checked; });
  } else if (box.name === 'recipients' && all) {
    all.checked = boxes.length > 0 && boxes.every((b) => b.checked);
  }
});

// Polje „Filter“ u listama (Iznosi, Članovi): filtrira već pri kucanju (ime ili korisničko ime, bez razlike
// velika/mala slova i č/ć/š/ž/đ). Filter ostaje aktivan (i pri promjeni mjeseca), a nakon klika kod člana
// stranica se vraća tačno do tog člana. Ista pravila kao na serveru (src/search.js).
(() => {
  const normalize = (t) => String(t || '').toLowerCase().replace(/đ/g, 'd').normalize('NFD')
    .replace(/[̀-ͯ]/g, '').replace(/\s+/g, ' ').trim();
  const matches = (hay, q) => normalize(q).split(' ').filter(Boolean).every((t) => hay.includes(t));
  const store = {
    get(k) { try { return window.sessionStorage.getItem(k); } catch { return null; } },
    set(k, v) {
      try {
        if (v === null || v === '') window.sessionStorage.removeItem(k);
        else window.sessionStorage.setItem(k, v);
      } catch { /* bez pohrane */ }
    },
  };
  // Postavlja ?trazi=… na adresi liste (i u ugniježđenom parametru back=…).
  function withFilter(url, q, listPath) {
    const u = new URL(url, window.location.href);
    if (u.pathname === listPath) {
      if (q) u.searchParams.set('trazi', q);
      else u.searchParams.delete('trazi');
    }
    const back = u.searchParams.get('back');
    if (back) u.searchParams.set('back', withFilter(back, q, listPath));
    return u.pathname + u.search + u.hash;
  }

  document.addEventListener('DOMContentLoaded', () => {
    document.querySelectorAll('form[data-list-filter]').forEach((form) => {
      const key = form.getAttribute('data-list-filter');
      const listPath = form.getAttribute('action');
      const input = form.querySelector('input[name="trazi"]');
      const clear = form.querySelector('.filter-clear');
      const body = document.querySelector(`[data-filter-list="${key}"]`);
      if (!input || !body) return;
      const rows = Array.from(body.querySelectorAll('tr[data-filter]'));
      const empty = body.querySelector('tr.filter-empty');
      const encodedPath = encodeURIComponent(listPath);

      function apply(q) {
        const query = q.trim();
        let shown = 0;
        rows.forEach((row) => {
          const ok = !query || matches(row.getAttribute('data-filter'), query);
          row.hidden = !ok;
          if (ok) shown += 1;
        });
        if (empty) empty.hidden = shown > 0 || rows.length === 0;
        if (clear) clear.hidden = !query;
        // Linkovi (mjeseci, „Označi: plaćeno“) i povratne adrese obrazaca nose filter dalje.
        document.querySelectorAll('input[name="back"]').forEach((el) => {
          if (el.value.startsWith(listPath)) el.value = withFilter(el.value, query, listPath);
        });
        document.querySelectorAll('a[href]').forEach((a) => {
          if (a === clear) return;
          const href = a.getAttribute('href');
          if (href.startsWith(`${listPath}?`) || href.includes(`back=${encodedPath}`)) a.setAttribute('href', withFilter(href, query, listPath));
        });
        const here = window.location.pathname + window.location.search + window.location.hash;
        window.history.replaceState(null, '', withFilter(here, query, listPath));
        store.set(`bt-filter:${key}`, query);
      }

      // Filter iz adrese ima prednost; inače posljednji filter ove liste (npr. nakon promjene mjeseca).
      const fromUrl = new URL(window.location.href).searchParams.has('trazi');
      const remembered = store.get(`bt-filter:${key}`);
      if (!fromUrl && remembered) input.value = remembered;
      if (input.value) apply(input.value);

      input.addEventListener('input', () => apply(input.value));
      form.addEventListener('submit', (event) => {
        event.preventDefault();
        apply(input.value);
      });
      if (clear) {
        clear.addEventListener('click', (event) => {
          event.preventDefault();
          input.value = '';
          apply('');
          input.focus();
        });
      }

      // Klik kod člana: zapamti red, da se po povratku na listu stranica ne vrati na vrh.
      body.addEventListener('click', (event) => {
        const row = event.target.closest('tr[data-filter]');
        if (row && event.target.closest('a, button')) store.set(`bt-row:${key}`, `${row.id}|${Date.now()}`);
      });
      const target = window.location.hash ? document.getElementById(window.location.hash.slice(1)) : null;
      const [rowId, at] = String(store.get(`bt-row:${key}`) || '').split('|');
      store.set(`bt-row:${key}`, null);
      const row = target && body.contains(target) ? target
        : rowId && Date.now() - Number(at) < 30 * 60 * 1000 ? document.getElementById(rowId) : null;
      if (row && !row.hidden) {
        row.scrollIntoView({ block: 'center' });
        row.classList.add('row-highlight');
        window.setTimeout(() => row.classList.remove('row-highlight'), 1600);
      }
    });
  });
})();
