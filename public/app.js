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
document.addEventListener('error', (event) => {
  if (event.target.classList && event.target.classList.contains('hero-photo')) markPhotoFailed(event.target);
}, true);
document.addEventListener('DOMContentLoaded', () => {
  document.querySelectorAll('.hero-photo').forEach((img) => {
    if (img.complete && img.naturalWidth === 0) markPhotoFailed(img);
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
