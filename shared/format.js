// Formatting helpers shared by the browser, the server and the PDF renderer.
// All money is stored as integer cents (USD) so arithmetic is exact.

export function fmtMoney(cents, { cents: showCents = false } = {}) {
  if (cents === null || cents === undefined || Number.isNaN(cents)) return '';
  const neg = cents < 0;
  const abs = Math.abs(cents);
  const dollars = showCents ? (abs / 100).toFixed(2) : String(Math.round(abs / 100));
  const [whole, frac] = dollars.split('.');
  const withCommas = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return (neg ? '-$' : '$') + withCommas + (frac ? '.' + frac : '');
}

export function fmtInt(n) {
  if (n === null || n === undefined || Number.isNaN(n)) return '';
  return String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

export function plural(n, sing, plur) {
  return `${fmtInt(n)} ${n === 1 ? sing : (plur || sing + 's')}`;
}

export function toCents(dollars) {
  if (dollars === '' || dollars === null || dollars === undefined) return null;
  const n = Number(String(dollars).replace(/[$,\s]/g, ''));
  if (!Number.isFinite(n)) return null;
  return Math.round(n * 100);
}

export function centsToInput(cents) {
  if (cents === null || cents === undefined) return '';
  return cents % 100 === 0 ? String(cents / 100) : (cents / 100).toFixed(2);
}

export function escapeHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

export function fmtDate(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC' });
}
