// ui.js — todo lo que toca el DOM del HUD, modales y avisos.
// Mantiene el vocabulario coherente: un botón que dice "Lanzar contramedida"
// siempre produce un aviso que dice "Contramedida lanzada", nunca otra cosa.

import { formatMMSS } from './physics.js';

export function actualizarHUD({ hp, status, teamName, nextShotAvailableAt, nextCounterAvailableAt }) {
  const hpFill = document.getElementById('hp-fill');
  const hpLabel = document.getElementById('hp-label');
  if (hpFill) hpFill.style.width = `${Math.max(0, hp)}%`;
  if (hpLabel) hpLabel.textContent = `${Math.max(0, hp)}/100${status === 'down' ? ' · CAÍDO' : ''}`;

  const teamLabel = document.getElementById('team-label');
  if (teamLabel) teamLabel.textContent = teamName ? teamName : 'Sin equipo';

  actualizarCooldown('shot-cooldown', nextShotAvailableAt);
  actualizarCooldown('counter-cooldown', nextCounterAvailableAt);
}

function actualizarCooldown(elementId, availableAt) {
  const el = document.getElementById(elementId);
  if (!el) return;
  const restante = (availableAt || 0) - Date.now();
  if (restante <= 0) {
    el.textContent = 'Listo';
    el.classList.add('ready');
  } else {
    el.textContent = formatMMSS(restante);
    el.classList.remove('ready');
  }
}

export function mostrarToast(mensaje, tipo = 'info') {
  const cont = document.getElementById('toast-container');
  if (!cont) return;
  const toast = document.createElement('div');
  toast.className = `toast toast-${tipo}`;
  toast.textContent = mensaje;
  cont.appendChild(toast);
  setTimeout(() => toast.classList.add('show'), 10);
  setTimeout(() => {
    toast.classList.remove('show');
    setTimeout(() => toast.remove(), 300);
  }, 5000);
}

export function mostrarResultadoImpacto({ hits, totalPoints }) {
  if (!hits || hits.length === 0) {
    mostrarToast('Sin impactos — nadie estaba en el radio de 50 km.', 'info');
    return;
  }
  const detalle = hits.map((h) => `${h.nickname} (+${h.points})`).join(', ');
  mostrarToast(`¡Impacto! ${detalle} · Total: +${totalPoints} puntos`, 'success');
}

export function mostrarBannerAmenaza(shotId, distanciaKm, msRestante, onLanzarContramedida) {
  const cont = document.getElementById('threat-banner-container');
  if (!cont) return;
  if (document.getElementById(`threat-${shotId}`)) return; // ya mostrado

  const banner = document.createElement('div');
  banner.id = `threat-${shotId}`;
  banner.className = 'threat-banner';
  banner.innerHTML = `
    <span>⚠ Disparo entrante a ${Math.round(distanciaKm)} km — impacto en <span class="mono countdown-inline">${formatMMSS(msRestante)}</span></span>
    <button class="btn-counter-inline">Lanzar contramedida</button>
  `;
  banner.querySelector('button').addEventListener('click', () => onLanzarContramedida(shotId));
  cont.appendChild(banner);
}

export function actualizarCuentaAtrasAmenaza(shotId, msRestante) {
  const el = document.querySelector(`#threat-${shotId} .countdown-inline`);
  if (el) el.textContent = formatMMSS(msRestante);
}

export function quitarBannerAmenaza(shotId) {
  const el = document.getElementById(`threat-${shotId}`);
  if (el) el.remove();
}

export function alternarModal(modalId, mostrar) {
  const modal = document.getElementById(modalId);
  if (!modal) return;
  modal.classList.toggle('hidden', !mostrar);
}

export function mostrarPreviewDisparo(distanciaKm, flightMs) {
  const el = document.getElementById('shot-preview');
  if (!el) return;
  el.classList.remove('hidden');
  el.querySelector('.preview-distance').textContent = `${Math.round(distanciaKm).toLocaleString('es-ES')} km`;
  el.querySelector('.preview-time').textContent = formatMMSS(flightMs);
}

export function ocultarPreviewDisparo() {
  document.getElementById('shot-preview')?.classList.add('hidden');
}
