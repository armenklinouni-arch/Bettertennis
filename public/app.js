// Sicherheitsabfrage für Formulare mit data-confirm (z. B. Löschen).
document.addEventListener('submit', (event) => {
  const form = event.target;
  const message = form.getAttribute && form.getAttribute('data-confirm');
  if (message && !window.confirm(message)) event.preventDefault();
});
