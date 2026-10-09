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
