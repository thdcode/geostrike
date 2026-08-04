// ranking.js — lee y renderiza el ranking. Nunca contiene ubicaciones,
// solo nickname/puntos/estadísticas, así que no hay nada que proteger aquí.

import { suscribirseARanking } from './realtime.js';

export function observarRanking(callback) {
  return suscribirseARanking((ranking) => {
    const filas = Object.entries(ranking)
      .map(([nickname, stats]) => ({ nickname, ...stats }))
      .sort((a, b) => (b.points || 0) - (a.points || 0));
    callback(filas);
  });
}

export function renderizarRanking(filas) {
  const tbody = document.getElementById('ranking-body');
  if (!tbody) return;
  tbody.innerHTML = filas
    .map(
      (f, i) => `
      <tr>
        <td class="mono">${i + 1}</td>
        <td>${escapeHtml(f.nickname)}</td>
        <td class="mono">${f.points || 0}</td>
        <td class="mono">${f.hits || 0}</td>
        <td class="mono">${f.defensePoints || 0}</td>
      </tr>`
    )
    .join('');
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}
