// ui.js — todo lo que toca el DOM del HUD, modales y avisos.
// Mantiene el vocabulario coherente: un botón que dice "Lanzar contramedida"
// siempre produce un aviso que dice "Contramedida lanzada", nunca otra cosa.

import { formatMMSS } from './physics.js';
import { estadoJugador, informacionSlots } from './player.js';

export function actualizarHUD({ hp, status, teamName, launchSlots, nextCounterAvailableAt, interceptorInFlight, puntos, mitigatedDamage }) {
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

  actualizarSlotsHUD(launchSlots);
  actualizarCooldown('counter-cooldown', nextCounterAvailableAt);
  actualizarInterceptorStatus(interceptorInFlight);
}

function actualizarSlotsHUD(launchSlots) {
  const el = document.getElementById('shot-cooldown');
  if (!el) return;
  const { total, disponibles, proximo } = informacionSlots(launchSlots);
  if (disponibles > 0) {
    el.textContent = `${disponibles}/${total}`;
    el.classList.add('ready');
    el.classList.remove('busy');
  } else {
    el.textContent = `0/${total} · ${formatMMSS(proximo - Date.now())}`;
    el.classList.remove('ready');
    el.classList.add('busy');
  }
}

function actualizarInterceptorStatus(inflight) {
  const el = document.getElementById('interceptor-status');
  if (!el) return;
  const activo = inflight && Number.isFinite(inflight.until) && inflight.until > Date.now();
  if (activo) {
    el.textContent = '🛰 En vuelo';
    el.classList.remove('ready');
    el.classList.add('busy');
  } else {
    el.textContent = 'Listo';
    el.classList.add('ready');
    el.classList.remove('busy');
  }
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

/**
 * Muestra el toast del resultado de un impacto y devuelve la entrada de
 * actividad correspondiente { texto, tipo, destino } (o null si es "sin
 * impacto"), para que main.js la renderice y la persista en un único punto.
 */
export function mostrarResultadoImpacto({ hits, totalPoints }, destino = null) {
  if (!hits || hits.length === 0) {
    mostrarToast('Sin impactos — nadie estaba en el radio de 50 km.', 'info');
    return { texto: '🎯 Disparo resuelto sin impacto.', tipo: 'info', destino };
  }
  const detalle = hits.map((h) => `${h.nickname} (+${h.points})`).join(', ');
  mostrarToast(`¡Impacto! ${detalle} · Total: +${totalPoints} puntos`, 'success');
  return { texto: `🎯 ¡Impacto! ${detalle} · Total +${totalPoints}.`, tipo: 'hit', destino };
}

// ---------- Panel de actividad ----------

const TIPO_CLASE = { shot: 'tactivo-shot', hit: 'tactivo-hit', damage: 'tactivo-damage', info: 'tactivo-info' };

/** Callback que main.js registra para llevar un evento del panel al mapa. */
let onActividadClick = null;

export function setOnActividadClick(fn) {
  onActividadClick = fn;
  wireActividadClick();
}

let _actividadClickWireado = false;
function wireActividadClick() {
  if (_actividadClickWireado) return;
  _actividadClickWireado = true;
  const list = document.getElementById('activity-list');
  list?.addEventListener('click', (e) => {
    const el = e.target.closest('.activity-entry');
    if (!el || !onActividadClick) return;
    const lat = Number(el.dataset.lat);
    const lng = Number(el.dataset.lng);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return;
    onActividadClick({ lat, lng, shotId: el.dataset.shotId || null });
  });
}

/**
 * Añade una entrada al panel de actividad (la más reciente arriba).
 * `destino` opcional { lat, lng, shotId }: hace la entrada clicable y la
 * muestra en el mapa.
 */
export function anadirActividad(texto, tipo = 'info', destino = null) {
  const list = document.getElementById('activity-list');
  if (!list) return;
  const el = document.createElement('div');
  el.className = `activity-entry ${TIPO_CLASE[tipo] || 'tactivo-info'}`;
  el.textContent = texto;
  if (destino && Number.isFinite(destino.lat) && Number.isFinite(destino.lng)) {
    el.dataset.lat = destino.lat;
    el.dataset.lng = destino.lng;
    if (destino.shotId) el.dataset.shotId = destino.shotId;
    el.classList.add('clicable');
  }
  list.prepend(el);
}

export function limpiarActividad() {
  const list = document.getElementById('activity-list');
  if (list) list.innerHTML = '';
}

export function alternarActividad(mostrar) {
  const panel = document.getElementById('activity-panel');
  if (panel) panel.classList.toggle('hidden', !mostrar);
}

export function alternarPanelAmenazas(mostrar) {
  const panel = document.getElementById('threat-panel');
  if (panel) panel.classList.toggle('hidden', !mostrar);
}

/** ¿El panel de disparos entrantes está visible? */
export function panelAmenazasVisible() {
  return !document.getElementById('threat-panel')?.classList.contains('hidden');
}

/** Abre el panel si hay amenazas pendientes (se llama cuando entra una nueva). */
function asegurarPanelAmenazasVisible() {
  const lista = document.getElementById('threat-list');
  if (!lista) return;
  if (lista.children.length === 0) return;
  alternarPanelAmenazas(true);
}

export function mostrarBannerAmenaza(shotId, distanciaKm, msRestante, onLanzarContramedida, onSeguirDisparo = null, onInterceptar = null) {
  const lista = document.getElementById('threat-list');
  if (!lista) return;
  if (document.getElementById(`threat-${shotId}`)) return; // ya mostrado

  const item = document.createElement('div');
  item.id = `threat-${shotId}`;
  item.className = 'threat-item';
  item.dataset.shotId = shotId;
  item.innerHTML = `
    <div class="threat-head">
      <span class="threat-title">⚠ Disparo entrante</span>
      <span class="threat-dist mono">${Math.round(distanciaKm)} km</span>
    </div>
    <div class="threat-body">
      <span class="threat-impact">Impacto en <span class="mono countdown-inline">${formatMMSS(msRestante)}</span></span>
    </div>
    <div class="threat-actions">
      <button class="btn-counter-inline btn-cnt-intercept">🚀 Interceptar</button>
      <button class="btn-counter-inline btn-cnt-counter">Lanzar contramedida</button>
    </div>
  `;
  // Clic en el item (fuera de los botones) → sigue el disparo en el mapa.
  if (onSeguirDisparo) {
    item.classList.add('clicable');
    item.addEventListener('click', (e) => {
      if (e.target.closest('button')) return;
      onSeguirDisparo();
    });
  }
  item.querySelector('.btn-cnt-counter').addEventListener('click', () => onLanzarContramedida(shotId));
  const btnIntercept = item.querySelector('.btn-cnt-intercept');
  if (onInterceptar) {
    btnIntercept.addEventListener('click', () => onInterceptar(shotId));
  } else {
    btnIntercept.disabled = true;
  }
  lista.prepend(item);
  asegurarPanelAmenazasVisible();
}

/** Refresca en lote la cuenta atrás de todos los disparos entrantes visibles. */
export function actualizarCuentaAtrasAmenazas(shots) {
  const ahora = Date.now();
  const items = document.querySelectorAll('.threat-item');
  for (const item of items) {
    const shot = shots[item.dataset.shotId];
    if (!shot || shot.resolved) continue;
    const el = item.querySelector('.countdown-inline');
    if (el) el.textContent = formatMMSS(Math.max(0, shot.impactAt - ahora));
  }
}

/** Marca el disparo entrante como protegido por contramedida (botón → texto). */
export function marcarBannerContramedida(shotId) {
  const item = document.getElementById(`threat-${shotId}`);
  if (!item) return;
  const btn = item.querySelector('.btn-cnt-counter');
  if (btn) {
    btn.disabled = true;
    btn.textContent = 'Contramedidas lanzadas ✓';
    item.classList.add('protected');
  }
}

/** Marca el botón de interceptor del disparo entrante como ya usado. */
export function marcarBannerInterceptado(shotId) {
  const item = document.getElementById(`threat-${shotId}`);
  if (!item) return;
  const btn = item.querySelector('.btn-cnt-intercept');
  if (btn) {
    btn.disabled = true;
    btn.dataset.activo = '1';
    btn.textContent = 'Interceptor en vuelo';
  }
}

/**
 * Habilita/deshabilita los botones "Interceptar" de todos los disparos entrantes
 * según si ya hay un interceptor en vuelo.
 */
export function sincronizarBotonesInterceptores(deshabilitar) {
  for (const btn of document.querySelectorAll('.btn-cnt-intercept')) {
    if (btn.dataset.activo === '1') continue;
    btn.disabled = !!deshabilitar;
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
  actualizarSlotsPreviewDisparo();
}

/**
 * Refresca la fila de slots del popup de disparo. Solo muestra el botón de
 * confirmar cuando hay al menos un slot de lanzamiento disponible; si no,
 * muestra la cuenta atrás hasta el próximo slot libre.
 */
export function actualizarSlotsPreviewDisparo() {
  const el = document.getElementById('shot-preview');
  if (!el || el.classList.contains('hidden')) return;
  const { total, disponibles, proximo } = informacionSlots(estadoJugador.launchSlots);
  const slotsEl = el.querySelector('.preview-slots');
  const confirmBtn = el.querySelector('#btn-confirm-shot');
  if (slotsEl) {
    slotsEl.textContent = disponibles > 0
      ? `${disponibles}/${total} libres`
      : `0/${total} · ${formatMMSS(proximo - Date.now())}`;
  }
  if (confirmBtn) confirmBtn.classList.toggle('hidden', disponibles <= 0);
}

export function ocultarPreviewDisparo() {
  document.getElementById('shot-preview')?.classList.add('hidden');
}
