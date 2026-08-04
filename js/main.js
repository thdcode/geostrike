// main.js — orquesta la carga inicial y el bucle de juego.
// Lee esto de arriba a abajo como el mapa mental de todo el cliente.

import { WORKER_BASE_URL, SHOT_COOLDOWN_MS, TICK_INTERVAL_MS, WARNING_RADIUS_KM } from './config.js';
import { obtenerUbicacion, seleccionarUbicacionManual } from './geolocation.js';
import { cifrarUbicacion, cachearUbicacionLocal, leerUbicacionCacheada } from './crypto.js';
import { obtenerIdentidadDispositivo, guardarNickname, leerPlayerIdLegacy, estadoJugador } from './player.js';
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
let deviceId = null;    // identificador del dispositivo (localStorage), clave de la sesión
let ultimoSnapshotDisparos = {};
const shotsYaResueltosMostrados = new Set();
const shotsEnProcesoDeResolucion = new Set();
let modoApuntando = false;
let destinoElegido = null;
let nombreEquipoActual = null;
let jugadorEliminado = false;

async function main() {
  const identidad = obtenerIdentidadDispositivo();
  deviceId = identidad.deviceId;
  estadoJugador.nickname = identidad.nickname;

  if (!estadoJugador.nickname) {
    await pedirNickname();
  }

  // 0) Recuperar o crear la partida activa (verificación: dispositivo + nickname, sin email)
  const playerId = await resolverPartidaActiva();
  estadoJugador.playerId = playerId;

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
  RT.suscribirseATodosJugadores((players) => {
    const bots = Object.fromEntries(
      Object.entries(players || {}).filter(([, p]) => p.isBot === true && p.status !== 'down')
    );
    Mapa.actualizarBots(bots);
  });
  RT.suscribirseADisparos(onCambioDisparos);
  Ranking.observarRanking(Ranking.renderizarRanking);

  // 5) Interacción con el mapa (apuntar y disparar)
  map.on('click', onClickMapa);

  // 6) Bucle periódico: cuenta atrás de amenazas, resolución de disparos vencidos
  setInterval(tick, TICK_INTERVAL_MS);
  setInterval(actualizarRelojes, 1000);

  wireUI();
}

// ---------- Recuperación de partida activa ----------

/**
 * Resuelve el playerId de esta sesión. Sin email ni cuentas: la verificación es
 * "dispositivo (deviceId) + nickname". Si hay una partida activa coincide con el
 * nickname, se ofrece recuperarla; si no, se crea una partida nueva.
 */
async function resolverPartidaActiva() {
  const sesion = await RT.obtenerSesion(deviceId);

  // Migración: identidad antigua (playerId guardado en localStorage) sin sesión aún.
  const legacy = leerPlayerIdLegacy();
  if (!sesion && legacy) {
    await RT.crearSesion(deviceId, legacy, estadoJugador.nickname);
    return legacy;
  }

  if (sesion && sesion.active && sesion.nickname === estadoJugador.nickname) {
    const decision = await UI.preguntarRecuperacion(estadoJugador.nickname);
    if (decision === 'recuperar') {
      await RT.crearSesion(deviceId, sesion.playerId, estadoJugador.nickname);
      return sesion.playerId;
    }
    // "nueva": finaliza la activa y sigue para crear una partida nueva.
    await RT.finalizarSesion(deviceId);
  }

  const playerId = crypto.randomUUID();
  await RT.crearSesion(deviceId, playerId, estadoJugador.nickname);
  return playerId;
}

async function finalizarPartida() {
  const ok = await UI.confirmarFinalizar();
  if (!ok) return;
  await cerrarPartida();
}

async function cerrarPartida() {
  try {
    await RT.cancelarDisparosPropios(estadoJugador.playerId, deviceId);
  } catch (err) {
    console.warn('No se pudieron cancelar los disparos propios:', err);
  }
  try {
    await RT.finalizarSesion(deviceId);
  } catch (err) {
    console.warn('No se pudo finalizar la sesión:', err);
  }
  location.reload();
}

// Eliminación: el Worker ha rechazado un disparo (403 eliminated) o Firebase
// informó de status 'down'. Se bloquea el apuntado, se avisa al jugador y se
// finaliza la partida.
async function manejarEliminacion() {
  if (jugadorEliminado) return;
  jugadorEliminado = true;
  cancelarApuntado();
  const btnFire = document.getElementById('btn-fire');
  if (btnFire) btnFire.disabled = true;
  UI.mostrarToast('Has sido eliminado. Finalizando la partida…', 'error');
  await UI.mostrarEliminado();
  await cerrarPartida();
}

// ---------- Jugador propio ----------

function onCambioJugadorPropio(data) {
  if (!data) return;
  Object.assign(estadoJugador, data);
  if (data.status === 'down') {
    manejarEliminacion();
    return;
  }
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

// Relojes de cuenta atrás: HUD, banners de amenaza y etiquetas ETA del mapa se
// refrescan cada segundo (no solo en el tick de 5s), para que el tiempo hasta
// el impacto baje de forma continua.
function actualizarRelojes() {
  renderHUD(nombreEquipoActual);
  UI.actualizarCuentaAtrasAmenazas(ultimoSnapshotDisparos);
  Mapa.actualizarETAs();
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

  // Limpia disparos que ya no existen en Firebase (evita capas huérfanas).
  const idsVistos = new Set(Object.keys(shots));
  for (const shotId of Mapa.listaDisparos()) {
    if (shotId !== 'preview' && !idsVistos.has(shotId)) Mapa.limpiarDisparo(shotId);
  }

  for (const [shotId, shot] of Object.entries(shots)) {
    const origen = shot.shooterId === estadoJugador.playerId ? miUbicacion : null;
    const amenaza = !shot.resolved && miUbicacion &&
      haversineKm(miUbicacion.lat, miUbicacion.lng, shot.destLat, shot.destLng) <= WARNING_RADIUS_KM;
    Mapa.rastrearDisparo(shotId, shot, origen, amenaza);

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
  Mapa.mostrarPreview(miUbicacion, destinoElegido, flightMs);
}

async function confirmarDisparo() {
  if (!destinoElegido) return;
  if (jugadorEliminado || estadoJugador.status !== 'alive') {
    await manejarEliminacion();
    return;
  }
  if (Date.now() < (estadoJugador.nextShotAvailableAt || 0)) {
    UI.mostrarToast('Todavía en recarga.', 'error');
    return;
  }

  const distanciaKm = haversineKm(miUbicacion.lat, miUbicacion.lng, destinoElegido.lat, destinoElegido.lng);
  const flightMs = calcularFlightMs(distanciaKm);
  const impactAt = Date.now() + flightMs;

  let shotId;
  try {
    shotId = await RT.crearDisparo(
      estadoJugador.playerId, estadoJugador.nickname, destinoElegido.lat, destinoElegido.lng, impactAt
    );
  } catch (err) {
    if (err.eliminated) {
      await manejarEliminacion();
      return;
    }
    UI.mostrarToast(err.message, 'error');
    return;
  }

  fetch(`${WORKER_BASE_URL}/notify-threatened`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ shotId }),
  }).catch(() => {}); // el aviso a amenazados no es crítico si falla puntualmente

  estadoJugador.nextShotAvailableAt = Date.now() + SHOT_COOLDOWN_MS;
  Mapa.limpiarPreview();
  UI.ocultarPreviewDisparo();
  cancelarApuntado();
  UI.mostrarToast(`Disparo lanzado — impacto en ${formatMMSS(flightMs)}.`, 'success');
}

function cancelarApuntado() {
  modoApuntando = false;
  destinoElegido = null;
  document.getElementById('btn-fire')?.classList.remove('active');
  Mapa.limpiarPreview();
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
      Mapa.limpiarPreview();
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
  document.getElementById('btn-end-game')?.addEventListener('click', finalizarPartida);

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
