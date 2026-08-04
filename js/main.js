// main.js — orquesta la carga inicial y el bucle de juego.
// Lee esto de arriba a abajo como el mapa mental de todo el cliente.

import { WORKER_BASE_URL, SHOT_COOLDOWN_MS, TICK_INTERVAL_MS } from './config.js';
import { obtenerUbicacion, seleccionarUbicacionManual } from './geolocation.js';
import { cifrarUbicacion, cachearUbicacionLocal, leerUbicacionCacheada } from './crypto.js';
import { obtenerOCrearIdentidad, guardarNickname, estadoJugador } from './player.js';
import * as RT from './realtime.js';
import * as Mapa from './map.js';
import { haversineKm, calcularFlightMs, formatMMSS } from './physics.js';
import * as Teams from './teams.js';
import * as Counter from './countermeasures.js';
import * as Push from './push.js';
import * as Ranking from './ranking.js';
import * as UI from './ui.js';

// ---------- Estado local de la sesión (nunca persistido más allá de la pestaña) ----------
let miUbicacion = null; // {lat, lng} — solo en memoria
let ultimoSnapshotDisparos = {};
const shotsYaResueltosMostrados = new Set();
const shotsEnProcesoDeResolucion = new Set();
let modoApuntando = false;
let destinoElegido = null;
let nombreEquipoActual = null;

async function main() {
  const { playerId, nickname } = obtenerOCrearIdentidad();
  estadoJugador.playerId = playerId;
  estadoJugador.nickname = nickname;

  if (!nickname) {
    await pedirNickname();
  }

  // 1) Mapa con vista provisional mientras resolvemos la ubicación real
  Mapa.inicializarMapa(20, 0);
  const map = Mapa.obtenerMapa();
  map.setZoom(2);

  // 2) Ubicación: geolocalización → caché local → selección manual
  miUbicacion = await obtenerUbicacion();
  if (!miUbicacion) {
    const cacheada = await leerUbicacionCacheada();
    if (cacheada) {
      miUbicacion = cacheada;
      UI.mostrarToast('Usando tu última ubicación conocida (guardada cifrada en este dispositivo).', 'info');
    }
  }
  if (!miUbicacion) {
    UI.mostrarToast('No se pudo obtener tu ubicación automáticamente. Elige tu posición en el mapa.', 'info');
    miUbicacion = await seleccionarUbicacionManual(map, window.L);
  }

  cachearUbicacionLocal(miUbicacion.lat, miUbicacion.lng);
  map.setView([miUbicacion.lat, miUbicacion.lng], 6);
  Mapa.dibujarMiMarcador(miUbicacion.lat, miUbicacion.lng);

  // 3) Registro cifrado en Firebase
  const locationEnc = cifrarUbicacion(miUbicacion.lat, miUbicacion.lng);
  await RT.registrarJugador(playerId, estadoJugador.nickname, locationEnc);

  // 4) Suscripciones en tiempo real
  RT.suscribirseAJugadorPropio(playerId, onCambioJugadorPropio);
  RT.suscribirseABots((bots) => Mapa.actualizarBots(bots));
  RT.suscribirseADisparos(onCambioDisparos);
  Ranking.observarRanking(Ranking.renderizarRanking);

  // 5) Interacción con el mapa (apuntar y disparar)
  map.on('click', onClickMapa);

  // 6) Bucle periódico: cuenta atrás de amenazas, resolución de disparos vencidos
  setInterval(tick, TICK_INTERVAL_MS);
  setInterval(() => renderHUD(nombreEquipoActual), 1000);

  wireUI();
}

// ---------- Jugador propio ----------

function onCambioJugadorPropio(data) {
  if (!data) return;
  Object.assign(estadoJugador, data);
  if (data.teamId) {
    Teams.observarEquipo(data.teamId, (team) => {
      nombreEquipoActual = team?.name || null;
      renderHUD(nombreEquipoActual);
      renderPanelEquipo(team);
    });
  } else {
    nombreEquipoActual = null;
    renderHUD(null);
  }
}

function renderHUD(teamName) {
  UI.actualizarHUD({
    hp: estadoJugador.hp,
    status: estadoJugador.status,
    teamName,
    nextShotAvailableAt: estadoJugador.nextShotAvailableAt,
    nextCounterAvailableAt: estadoJugador.nextCounterAvailableAt,
  });
}

function renderPanelEquipo(team) {
  const cont = document.getElementById('team-members');
  if (!cont || !team) return;
  cont.innerHTML = (team.members || [])
    .map((id) => `<div class="card"><span class="dot"></span>${id === estadoJugador.playerId ? 'Tú' : id.slice(0, 8)}</div>`)
    .join('');
  const codeDisplay = document.getElementById('team-code-display');
  if (codeDisplay) codeDisplay.textContent = estadoJugador.teamId || '';
}

// ---------- Disparos ----------

function onCambioDisparos(shots) {
  ultimoSnapshotDisparos = shots;

  for (const [shotId, shot] of Object.entries(shots)) {
    Mapa.dibujarDisparo(shotId, shot.destLat, shot.destLng, shot.resolved);

    if (shot.resolved && shot.result && shot.shooterId === estadoJugador.playerId) {
      if (!shotsYaResueltosMostrados.has(shotId)) {
        shotsYaResueltosMostrados.add(shotId);
        UI.mostrarResultadoImpacto(shot.result);
      }
    }

    if (shot.resolved) {
      // limpieza visual pasado un rato, para no acumular círculos viejos
      setTimeout(() => Mapa.limpiarDisparo(shotId), 60_000);
      UI.quitarBannerAmenaza(shotId);
    }
  }
}

function tick() {
  const ahora = Date.now();

  // a) ¿Algún disparo (mío o de otro) ya debería resolverse y nadie lo ha hecho?
  for (const [shotId, shot] of Object.entries(ultimoSnapshotDisparos)) {
    if (!shot.resolved && shot.impactAt <= ahora && !shotsEnProcesoDeResolucion.has(shotId)) {
      shotsEnProcesoDeResolucion.add(shotId);
      resolverImpacto(shotId).finally(() => shotsEnProcesoDeResolucion.delete(shotId));
    }
  }

  // b) ¿Algún disparo me amenaza a mí? (cálculo 100% local, con mi posición real)
  const amenazas = Counter.disparosQueMeAmenazan(ultimoSnapshotDisparos, miUbicacion);
  for (const amenaza of amenazas) {
    const restante = amenaza.impactAt - ahora;
    UI.mostrarBannerAmenaza(amenaza.shotId, amenaza.distanciaKm, restante, lanzarContramedidaDesdeUI);
    UI.actualizarCuentaAtrasAmenaza(amenaza.shotId, restante);
  }
}

async function resolverImpacto(shotId) {
  try {
    await fetch(`${WORKER_BASE_URL}/resolve-impact`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ shotId }),
    });
  } catch (err) {
    console.warn('No se pudo resolver el impacto (se reintentará en el siguiente tick):', err);
  }
}

async function lanzarContramedidaDesdeUI(shotId) {
  try {
    await Counter.lanzar(shotId);
    UI.mostrarToast('Contramedida lanzada — protege a tu equipo en este disparo.', 'success');
  } catch (err) {
    UI.mostrarToast(err.message, 'error');
  }
}

// ---------- Apuntar y disparar ----------

function onClickMapa(e) {
  if (!modoApuntando) return;
  destinoElegido = { lat: e.latlng.lat, lng: e.latlng.lng };
  const distanciaKm = haversineKm(miUbicacion.lat, miUbicacion.lng, destinoElegido.lat, destinoElegido.lng);
  const flightMs = calcularFlightMs(distanciaKm);
  UI.mostrarPreviewDisparo(distanciaKm, flightMs);
  Mapa.dibujarDisparo('preview', destinoElegido.lat, destinoElegido.lng, false);
}

async function confirmarDisparo() {
  if (!destinoElegido) return;
  if (Date.now() < (estadoJugador.nextShotAvailableAt || 0)) {
    UI.mostrarToast('Todavía en recarga.', 'error');
    return;
  }

  const distanciaKm = haversineKm(miUbicacion.lat, miUbicacion.lng, destinoElegido.lat, destinoElegido.lng);
  const flightMs = calcularFlightMs(distanciaKm);
  const impactAt = Date.now() + flightMs;

  const shotId = await RT.crearDisparo(
    estadoJugador.playerId, estadoJugador.nickname, destinoElegido.lat, destinoElegido.lng, impactAt
  );

  fetch(`${WORKER_BASE_URL}/notify-threatened`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ shotId }),
  }).catch(() => {}); // el aviso a amenazados no es crítico si falla puntualmente

  estadoJugador.nextShotAvailableAt = Date.now() + SHOT_COOLDOWN_MS;
  Mapa.limpiarDisparo('preview');
  UI.ocultarPreviewDisparo();
  cancelarApuntado();
  UI.mostrarToast(`Disparo lanzado — impacto en ${formatMMSS(flightMs)}.`, 'success');
}

function cancelarApuntado() {
  modoApuntando = false;
  destinoElegido = null;
  document.getElementById('btn-fire')?.classList.remove('active');
  Mapa.limpiarDisparo('preview');
  UI.ocultarPreviewDisparo();
}

// ---------- Nickname ----------

function pedirNickname() {
  return new Promise((resolve) => {
    UI.alternarModal('nickname-modal', true);
    const form = document.getElementById('nickname-form');
    form.addEventListener('submit', function onSubmit(e) {
      e.preventDefault();
      const valor = document.getElementById('nickname-input').value.trim();
      if (!valor) return;
      guardarNickname(valor);
      estadoJugador.nickname = valor;
      form.removeEventListener('submit', onSubmit);
      UI.alternarModal('nickname-modal', false);
      resolve();
    });
  });
}

// ---------- Wiring de botones ----------

function wireUI() {
  document.getElementById('btn-fire')?.addEventListener('click', () => {
    modoApuntando = !modoApuntando;
    document.getElementById('btn-fire').classList.toggle('active', modoApuntando);
    if (!modoApuntando) {
      Mapa.limpiarDisparo('preview');
      UI.ocultarPreviewDisparo();
    }
  });

  document.getElementById('btn-confirm-shot')?.addEventListener('click', confirmarDisparo);
  document.getElementById('btn-cancel-shot')?.addEventListener('click', cancelarApuntado);

  document.getElementById('btn-open-ranking')?.addEventListener('click', () => UI.alternarModal('ranking-modal', true));
  document.querySelectorAll('[data-close-modal]').forEach((btn) =>
    btn.addEventListener('click', (e) => UI.alternarModal(e.target.dataset.closeModal, false))
  );

  document.getElementById('btn-open-team')?.addEventListener('click', () => UI.alternarModal('team-modal', true));

  document.getElementById('team-create-form')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const nombre = document.getElementById('team-name-input').value.trim();
    if (!nombre) return;
    const codigo = await Teams.crear(nombre);
    UI.mostrarToast(`Equipo creado. Código para invitar: ${codigo}`, 'success');
    UI.alternarModal('team-modal', false);
  });

  document.getElementById('team-join-form')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const codigo = document.getElementById('team-code-input').value.trim();
    if (!codigo) return;
    try {
      const nombre = await Teams.unirse(codigo);
      UI.mostrarToast(`Te has unido a "${nombre}".`, 'success');
      UI.alternarModal('team-modal', false);
    } catch (err) {
      UI.mostrarToast(err.message, 'error');
    }
  });

  document.getElementById('btn-enable-push')?.addEventListener('click', async () => {
    const resultado = await Push.activarNotificaciones(estadoJugador.playerId);
    if (!resultado.soportado) {
      UI.mostrarToast('Tu navegador no soporta notificaciones push. Se usará el aviso en pantalla.', 'info');
    } else if (!resultado.permitido) {
      UI.mostrarToast('Permiso denegado. Verás los avisos solo mientras la pestaña esté abierta.', 'info');
    } else {
      UI.mostrarToast('Notificaciones activadas — recibirás avisos incluso con la app cerrada.', 'success');
    }
  });
}

main().catch((err) => {
  console.error(err);
  UI.mostrarToast('Error inicializando el juego: ' + err.message, 'error');
});
