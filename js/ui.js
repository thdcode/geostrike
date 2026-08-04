// ui.js — todo lo que toca el DOM del HUD, modales y avisos.
// Mantiene el vocabulario coherente: un botón que dice "Lanzar contramedida"
// siempre produce un aviso que dice "Contramedida lanzada", nunca otra cosa.

import { formatMMSS } from './physics.js';

export function actualizarHUD({ hp, status, teamName, nextShotAvailableAt, nextCounterAvailableAt, puntos, mitigatedDamage }) {
  const hpFill = document.getElementById('hp-fill');
  const hpLabel = document.getElementById('hp-label');
  if (hpFill) hpFill.style.width = `${Math.max(0, hp)}%`;
  if (hpLabel) hpLabel.textContent = `${Math.max(0, hp)}/100${status === 'down' ? ' · CAÍDO' : ''}`;

  const teamLabel = document.getElementById('team-label');
  if (teamLabel) teamLabel.textContent = teamName ? teamName : 'Sin equipo';

  const puntosEl = document.getElementById('hud-points');
  if (puntosEl) puntosEl.textContent = (puntos ?? 0).toLocaleString('es-ES');
  const mitigadoEl = document.getElementById('hud-mitigated');
  if (mitigadoEl) mitigadoEl.textContent = (mitigatedDamage ?? 0).toLocaleString('es-ES');

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
    anadirActividad('🎯 Disparo resuelto sin impacto.', 'info');
    return;
  }
  const detalle = hits.map((h) => `${h.nickname} (+${h.points})`).join(', ');
  mostrarToast(`¡Impacto! ${detalle} · Total: +${totalPoints} puntos`, 'success');
  anadirActividad(`🎯 ¡Impacto! ${detalle} · Total +${totalPoints}.`, 'hit');
}

// ---------- Panel de actividad ----------

const TIPO_CLASE = { shot: 'tactivo-shot', hit: 'tactivo-hit', damage: 'tactivo-damage', info: 'tactivo-info' };

/** Añade una entrada al panel de actividad (la más reciente arriba). */
export function anadirActividad(texto, tipo = 'info') {
  const list = document.getElementById('activity-list');
  if (!list) return;
  const el = document.createElement('div');
  el.className = `activity-entry ${TIPO_CLASE[tipo] || 'tactivo-info'}`;
  el.textContent = texto;
  list.prepend(el);
  while (list.children.length > 50) list.lastElementChild.remove();
}

export function limpiarActividad() {
  const list = document.getElementById('activity-list');
  if (list) list.innerHTML = '';
}

export function alternarActividad(mostrar) {
  const panel = document.getElementById('activity-panel');
  if (panel) panel.classList.toggle('hidden', !mostrar);
}

export function mostrarBannerAmenaza(shotId, distanciaKm, msRestante, onLanzarContramedida) {
  const cont = document.getElementById('threat-banner-container');
  if (!cont) return;
  if (document.getElementById(`threat-${shotId}`)) return; // ya mostrado

  const banner = document.createElement('div');
  banner.id = `threat-${shotId}`;
  banner.className = 'threat-banner';
  banner.dataset.shotId = shotId;
  banner.innerHTML = `
    <span>⚠ Disparo entrante a ${Math.round(distanciaKm)} km — impacto en <span class="mono countdown-inline">${formatMMSS(msRestante)}</span></span>
    <button class="btn-counter-inline">Lanzar contramedida</button>
  `;
  banner.querySelector('button').addEventListener('click', () => onLanzarContramedida(shotId));
  cont.appendChild(banner);
}

/** Refresca en lote la cuenta atrás de todos los banners visibles, según el snapshot de disparos. */
export function actualizarCuentaAtrasAmenazas(shots) {
  const ahora = Date.now();
  const banners = document.querySelectorAll('.threat-banner');
  for (const banner of banners) {
    const shot = shots[banner.dataset.shotId];
    if (!shot || shot.resolved) continue;
    const el = banner.querySelector('.countdown-inline');
    if (el) el.textContent = formatMMSS(Math.max(0, shot.impactAt - ahora));
  }
}

/** Marca el banner de un disparo entrante como protegido por contramedida (botón → texto). */
export function marcarBannerContramedida(shotId) {
  const banner = document.getElementById(`threat-${shotId}`);
  if (!banner) return;
  const btn = banner.querySelector('button');
  if (btn) {
    btn.disabled = true;
    btn.textContent = 'Contramedidas lanzadas ✓';
    banner.classList.add('protected');
  }
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

// ---------- Modales de decisión (promesa) ----------

let _resolverRecuperacion = null;
let _resolverFinalizar = null;
let _resolverEliminado = null;
let _modalesDecisiónWireados = false;

function wirearModalesDecision() {
  if (_modalesDecisiónWireados) return;
  _modalesDecisiónWireados = true;

  document.getElementById('btn-recover-yes')?.addEventListener('click', () => responderRecuperacion('recuperar'));
  document.getElementById('btn-recover-no')?.addEventListener('click', () => responderRecuperacion('nueva'));

  document.getElementById('btn-finalize-confirm')?.addEventListener('click', () => responderFinalizar(true));
  document.getElementById('btn-finalize-cancel')?.addEventListener('click', () => responderFinalizar(false));

  document.getElementById('btn-eliminated-confirm')?.addEventListener('click', () => responderEliminado());
}

function responderRecuperacion(decision) {
  alternarModal('recover-modal', false);
  if (_resolverRecuperacion) {
    const r = _resolverRecuperacion;
    _resolverRecuperacion = null;
    r(decision);
  }
}

function responderFinalizar(ok) {
  alternarModal('finalize-modal', false);
  if (_resolverFinalizar) {
    const r = _resolverFinalizar;
    _resolverFinalizar = null;
    r(ok);
  }
}

function responderEliminado() {
  alternarModal('eliminated-modal', false);
  if (_resolverEliminado) {
    const r = _resolverEliminado;
    _resolverEliminado = null;
    r();
  }
}

/** Pregunta al jugador si quiere recuperar su partida activa. Resuelve 'recuperar' | 'nueva'. */
export function preguntarRecuperacion(nickname) {
  wirearModalesDecision();
  const el = document.getElementById('recover-nickname');
  if (el) el.textContent = nickname;
  alternarModal('recover-modal', true);
  return new Promise((resolve) => { _resolverRecuperacion = resolve; });
}

/** Confirma si el jugador quiere finalizar la partida actual. Resuelve boolean. */
export function confirmarFinalizar() {
  wirearModalesDecision();
  alternarModal('finalize-modal', true);
  return new Promise((resolve) => { _resolverFinalizar = resolve; });
}

/** Avisa de que el jugador ha sido eliminado. Resuelve al pulsar "Finalizar partida". */
export function mostrarEliminado() {
  wirearModalesDecision();
  alternarModal('eliminated-modal', true);
  return new Promise((resolve) => { _resolverEliminado = resolve; });
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
