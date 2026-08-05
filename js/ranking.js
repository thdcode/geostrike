// ranking.js — lee y renderiza el ranking. Nunca contiene ubicaciones,
// solo nickname/puntos/estadísticas, así que no hay nada que proteger aquí.

import { suscribirseARanking } from './realtime.js';

let filasPendientes = null;
let rankingTimer = null;

export function observarRanking(callback) {
  return suscribirseARanking((ranking) => {
    filasPendientes = Object.entries(ranking)
      .map(([nickname, stats]) => ({ nickname, ...stats }))
      .sort((a, b) => (b.points || 0) - (a.points || 0));
    if (rankingTimer) return;
    rankingTimer = setTimeout(() => {
      rankingTimer = null;
      callback(filasPendientes);
    }, 1000);
  });
}

let ultimaFirma = '';

export function renderizarRanking(filas) {
  const tbody = document.getElementById('ranking-body');
  if (!tbody) return;
  const firma = filas
    .map((f) => `${f.nickname}|${f.points || 0}|${f.hits || 0}|${f.defensePoints || 0}`)
    .join(';');
  if (firma === ultimaFirma) return;
  ultimaFirma = firma;
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
