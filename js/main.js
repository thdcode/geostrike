// main.js — orquesta la carga inicial y el bucle de juego.
// Lee esto de arriba a abajo como el mapa mental de todo el cliente.

import { WORKER_BASE_URL, TICK_INTERVAL_MS, WARNING_RADIUS_KM, SPLASH_RADIUS_KM, IMPACTO_VISIBLE_MS } from './config.js';
import { obtenerUbicacion, seleccionarUbicacionManual } from './geolocation.js';
import { cifrarUbicacion, cachearUbicacionLocal, leerUbicacionCacheada } from './crypto.js';
import { obtenerIdentidadDispositivo, guardarNickname, leerPlayerIdLegacy, estadoJugador, informacionSlots } from './player.js';
import * as RT from './realtime.js';
import * as Mapa from './map.js';
import { haversineKm, calcularFlightMs, formatMMSS } from './physics.js';
import * as Teams from './teams.js';
import * as Counter from './countermeasures.js';
import * as Interceptor from './interceptors.js';
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
let misPuntos = 0;
let miDañoMitigado = 0;
let puntosBasePartida = 0; // ranking.points al iniciar la partida; el HUD muestra la diferencia
let hpAnterior = 100;
const impactosCercanos = new Map(); // shotId -> { nickname, ts } de disparos ajenos resueltos en mi radio
const contramedidasLanzadas = new Set(); // shotIds en los que ya lancé una contramedida
const misDisparosContracados = new Set(); // shotIds (disparos MÍOS) contra los que el enemigo lanzó contramedida
const interceptoresEnProcesoDeResolucion = new Set(); // interceptores cuyo resolve ya se pidió
const interceptoresResueltosMostrados = new Set();    // interceptores propios cuyo veredicto ya se mostró
const disparosInterceptadosMostrados = new Set();     // objetivos interceptados ya avisados
let interceptorEnVueloId = null;                      // interceptorId propio actualmente en vuelo
let actividadPersiste = false; // true a partir de que el historial cargado; evita re-persistir entradas del load

// Renderiza un evento en el panel de actividad y lo persiste en el historial de
// la partida en curso (fire-and-forget). Se persisten TODOS los eventos (tengan
// o no coordenadas): así al recargar se muestra la actividad completa de la
// partida actual, no solo los con destino geográfico.
function registrarActividad(texto, tipo, destino = null) {
  UI.anadirActividad(texto, tipo, destino);
  if (!actividadPersiste) return;
  const evento = {
    tipo, texto,
    lat: destino && Number.isFinite(destino.lat) ? destino.lat : null,
    lng: destino && Number.isFinite(destino.lng) ? destino.lng : null,
    shotId: (destino && destino.shotId) || null,
    ts: Date.now(),
  };
  RT.guardarEventoActividad(estadoJugador.playerId, evento).catch(() => {});
}

async function cargarActividadPersistida() {
  try {
    const eventos = await RT.obtenerActividad(estadoJugador.playerId);
    if (!eventos.length) return;
    const ordenados = eventos
      .filter((e) => e && e.texto)
      .sort((a, b) => (a.ts || 0) - (b.ts || 0));
    UI.limpiarActividad();
    for (const e of ordenados) {
      UI.anadirActividad(
        e.texto,
        e.tipo || 'info',
        Number.isFinite(e.lat) && Number.isFinite(e.lng) ? { lat: e.lat, lng: e.lng, shotId: e.shotId || null } : null
      );
    }
  } catch (err) {
    console.warn('No se pudo cargar el historial de actividad:', err);
  }
}

async function main() {
  const identidad = obtenerIdentidadDispositivo();
  deviceId = identidad.deviceId;

  // Siempre se elige el nickname al iniciar la partida. Se pre-rellena con el
  // guardado en el dispositivo: si se mantiene, se podrá recuperar la partida
  // activa; si se escribe otro distinto, empieza una partida nueva.
  estadoJugador.nickname = await pedirNickname(identidad.nickname);

  // 0) Recuperar o crear la partida activa (verificación: dispositivo + nickname, sin email)
  const playerId = await resolverPartidaActiva();
  estadoJugador.playerId = playerId;

  // Historial de actividad de la partida en curso (si el usuario recupera su
  // partida, vuelve a verlo; si es nueva, empieza vacío).
  await cargarActividadPersistida();
  actividadPersiste = true;

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
  try {
    await RT.registrarJugador(playerId, estadoJugador.nickname, locationEnc);
  } catch (err) {
    if (err.code === 'SALA_LLENA') {
      UI.mostrarToast('La sala está llena (máximo de jugadores alcanzado). Inténtalo más tarde.', 'error');
      return;
    }
    throw err;
  }

  // 4) Suscripciones en tiempo real
  RT.suscribirseAJugadorPropio(playerId, onCambioJugadorPropio);
  RT.suscribirseABots((players) => {
    const bots = Object.fromEntries(
      Object.entries(players || {}).filter(([, p]) => p.status !== 'down')
    );
    Mapa.actualizarBots(bots);
  });
  RT.suscribirseADisparos(onCambioDisparos);
  RT.suscribirseAContramedidas(onCambioContramedidas);
  Ranking.observarRanking((filas) => {
    Ranking.renderizarRanking(filas);
    const miKey = RT.sanitizeKey(estadoJugador.nickname);
    const miFila = filas.find((f) => f.nickname === miKey);
    // Puntuación de la PARTIDA actual: parte de 0 al iniciar y solo suma lo ganado.
    misPuntos = Math.max(0, (miFila?.points || 0) - puntosBasePartida);
    miDañoMitigado = miFila?.mitigatedDamage || 0;
    renderHUD(nombreEquipoActual);
  });

  // 5) Interacción con el mapa (apuntar y disparar)
  map.on('click', onClickMapa);
  // Coordenadas vivas del cursor mientras se apunta (solo tienen efecto en modo apuntar).
  map.on('mousemove', onMapaMousemove);
  map.on('mouseout', onMapaMouseout);

  // 6) Bucle periódico: cuenta atrás de amenazas, resolución de disparos vencidos
  setInterval(tick, TICK_INTERVAL_MS);
  setInterval(actualizarRelojes, 1000);

  wireUI();
  UI.setOnActividadClick((lugar) => Mapa.enfocarLugar(lugar));
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
    puntosBasePartida = await RT.obtenerPuntosRanking(estadoJugador.nickname);
    await RT.crearSesion(deviceId, legacy, estadoJugador.nickname, puntosBasePartida);
    return legacy;
  }

  if (sesion && sesion.active && sesion.nickname === estadoJugador.nickname) {
    const decision = await UI.preguntarRecuperacion(estadoJugador.nickname);
    if (decision === 'recuperar') {
      // Si la sesión es de antes de esta función, la línea base se toma ahora.
      puntosBasePartida = Number.isFinite(sesion.puntosBase)
        ? sesion.puntosBase
        : await RT.obtenerPuntosRanking(estadoJugador.nickname);
      await RT.crearSesion(deviceId, sesion.playerId, estadoJugador.nickname, puntosBasePartida);
      return sesion.playerId;
    }
    // "nueva": finaliza la activa y sigue para crear una partida nueva.
    await RT.finalizarSesion(deviceId);
  }

  const playerId = crypto.randomUUID();
  puntosBasePartida = await RT.obtenerPuntosRanking(estadoJugador.nickname);
  await RT.crearSesion(deviceId, playerId, estadoJugador.nickname, puntosBasePartida);
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
  const hpNuevo = Number.isFinite(data.hp) ? data.hp : hpAnterior;
  const dañoRecibido = hpAnterior - hpNuevo;
  if (dañoRecibido > 0) {
    // Intenta atribuir el daño al disparo ajeno más reciente resuelto en mi radio.
    const ahora = Date.now();
    let ultimo = null;
    for (const [, v] of impactosCercanos) {
      if (ahora - v.ts < 20_000 && (!ultimo || v.ts > ultimo.ts)) ultimo = v;
    }
    if (ultimo) impactosCercanos.clear();
    registrarActividad(
      ultimo && ultimo.nickname
        ? `💥 Impacto recibido de ${ultimo.nickname} · −${dañoRecibido} vida`
        : `💥 Has recibido ${dañoRecibido} de daño`,
      'damage',
      ultimo ? { lat: ultimo.lat, lng: ultimo.lng, shotId: ultimo.shotId } : null
    );
  }
  hpAnterior = hpNuevo;
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
    launchSlots: estadoJugador.launchSlots,
    nextCounterAvailableAt: estadoJugador.nextCounterAvailableAt,
    interceptorInFlight: estadoJugador.interceptorInFlight || (interceptorEnVueloId ? { until: Date.now() + 60_000 } : null),
    puntos: misPuntos,
    mitigatedDamage: miDañoMitigado,
  });
}

// Relojes de cuenta atrás: HUD, banners de amenaza y etiquetas ETA del mapa se
// refrescan cada segundo (no solo en el tick de 5s), para que el tiempo hasta
// el impacto baje de forma continua.
function actualizarRelojes() {
  renderHUD(nombreEquipoActual);
  UI.actualizarSlotsPreviewDisparo();
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

  // Limpia referencias antiguas de impactos recibidos (ventana de atribución >20s).
  const ahora = Date.now();
  for (const [id, v] of impactosCercanos) {
    if (ahora - v.ts > 20_000) impactosCercanos.delete(id);
  }

  // Limpia disparos que ya no existen en Firebase (evita capas huérfanas).
  const idsVistos = new Set(Object.keys(shots));
  for (const shotId of Mapa.listaDisparos()) {
    if (shotId !== 'preview' && !idsVistos.has(shotId)) Mapa.limpiarDisparo(shotId);
  }

  for (const [shotId, shot] of Object.entries(shots)) {
    const origen = shot.shooterId === estadoJugador.playerId ? miUbicacion : null;
    // El origen de un disparo de bot es público (vive en players/{botId}), así
    // que se puede animar la trayectoria desde su posición real, no desde el
    // perímetro. Los disparos de jugadores reales NUNCA revelan su origen.
    const esBot = typeof shot.shooterId === 'string' && shot.shooterId.startsWith('bot_');
    const origenAjeno = esBot ? Mapa.posicionBot(shot.shooterId) : null;
    const amenaza = !shot.resolved && miUbicacion &&
      haversineKm(miUbicacion.lat, miUbicacion.lng, shot.destLat, shot.destLng) <= WARNING_RADIUS_KM;
    // Impactos resueltos hace más de IMPACTO_VISIBLE_MS no se visualizan en el
    // mapa (el historial sigue en el panel de actividad, con sus coordenadas).
    const impactoViejo = shot.resolved && (Date.now() - (shot.impactAt || 0)) > IMPACTO_VISIBLE_MS;
    if (impactoViejo) {
      Mapa.limpiarDisparo(shotId);
    } else {
      Mapa.rastrearDisparo(shotId, shot, origen, amenaza, origenAjeno);

      // Reaplica el color de contramedida si la animación se recreó.
      if (contramedidasLanzadas.has(shotId)) Mapa.marcarContramedida(shotId);
      if (misDisparosContracados.has(shotId)) Mapa.marcarContracada(shotId);
    }

    // --- Interceptor PROPIO: se pinta distinto y se muestra el veredicto. ---
    if (shot.type === 'interceptor' && shot.shooterId === estadoJugador.playerId) {
      if (!shot.resolved) {
        interceptorEnVueloId = shotId;
        Mapa.marcarInterceptor(shotId);
      } else if (!interceptoresResueltosMostrados.has(shotId)) {
        interceptoresResueltosMostrados.add(shotId);
        if (interceptorEnVueloId === shotId) interceptorEnVueloId = null;
        const pct = Math.round((shot.hitProbability || 0) * 100);
        const ok = shot.outcome === 'hit';
        UI.mostrarToast(
          ok
            ? `🚀 Interceptor acertó (${pct}%) — el disparo entrante fue destruido.`
            : `Interceptor falló (${pct}%). El disparo entrante seguirá su curso.`,
          ok ? 'success' : 'info'
        );
        registrarActividad(
          ok
            ? `🚀 Interceptor destruyó un disparo entrante (acierto ${pct}%).`
            : `Interceptor falló (${pct}%).`,
          ok ? 'shot' : 'info',
          { lat: shot.destLat, lng: shot.destLng, shotId: shot.targetShotId || shotId }
        );
      }
    }

    // --- Disparo entrante INTERCEPTADO por alguien (o el mío, anulado). ---
    if (shot.intercepted) {
      Mapa.marcarInterceptado(shotId, shot.interceptedAt);
      if (!disparosInterceptadosMostrados.has(shotId)) {
        disparosInterceptadosMostrados.add(shotId);
        if (shot.shooterId === estadoJugador.playerId) {
          UI.mostrarToast('🚫 Tu disparo fue interceptado por el enemigo.', 'error');
          registrarActividad('🚫 Tu disparo fue interceptado por el enemigo.', 'info', { lat: shot.destLat, lng: shot.destLng, shotId });
        }
      }
    }

    // Disparo ajeno resuelto dentro de mi radio de salpicadura: se recuerda
    // para atribuir el daño que detectemos en onCambioJugadorPropio. Solo se
    // tienen en cuenta impactos recientes (nunca uno viejo de la BD).
    if (shot.resolved && !impactoViejo && !shot.intercepted && shot.shooterId !== estadoJugador.playerId && miUbicacion &&
        haversineKm(miUbicacion.lat, miUbicacion.lng, shot.destLat, shot.destLng) <= SPLASH_RADIUS_KM) {
      impactosCercanos.set(shotId, { shotId, nickname: shot.shooterNickname, ts: Date.now(), lat: shot.destLat, lng: shot.destLng });
    }

    if (shot.resolved && shot.result && shot.shooterId === estadoJugador.playerId && !impactoViejo) {
      if (!shotsYaResueltosMostrados.has(shotId)) {
        shotsYaResueltosMostrados.add(shotId);
        const entrada = UI.mostrarResultadoImpacto(shot.result, { lat: shot.destLat, lng: shot.destLng, shotId });
        if (entrada) registrarActividad(entrada.texto, entrada.tipo, entrada.destino);
        // Feedback visual en el mapa del resultado (acierto o fallo).
        Mapa.marcarResultadoDisparo(shotId, shot.result.hits, shot.destLat, shot.destLng);
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

  // a) Disparos que ya deberían resolverse y aún no se resolvieron. Este cliente
  //    solo resuelve lo que le compete: los disparos PROPIOS y los que impactan
  //    dentro de su radio de acción (SPLASH_RADIUS_KM). El resto (disparos de
  //    bots lejos, o hacia otros jugadores) lo resuelven otros clientes o el
  //    Cron Trigger del Worker. Todos los competentes se mandan en UNA llamada
  //    en lote, en vez de una llamada HTTP por disparo.
  const pendientesDeResolver = [];
  for (const [shotId, shot] of Object.entries(ultimoSnapshotDisparos)) {
    if (shot.type === 'interceptor') continue; // los interceptores se resuelven con /resolve-interceptor
    if (shot.resolved || shot.impactAt > ahora || shotsEnProcesoDeResolucion.has(shotId)) continue;
    const esMio = shot.shooterId === estadoJugador.playerId;
    const enMiRadio = miUbicacion &&
      haversineKm(miUbicacion.lat, miUbicacion.lng, shot.destLat, shot.destLng) <= SPLASH_RADIUS_KM;
    if (esMio || enMiRadio) pendientesDeResolver.push(shotId);
  }
  if (pendientesDeResolver.length) resolverImpactos(pendientesDeResolver);

  // a') ¿Algún interceptor propio ya debería resolverse?
  for (const [shotId, shot] of Object.entries(ultimoSnapshotDisparos)) {
    if (shot.type !== 'interceptor') continue;
    if (!shot.resolved && shot.impactAt <= ahora && !interceptoresEnProcesoDeResolucion.has(shotId)) {
      interceptoresEnProcesoDeResolucion.add(shotId);
      RT.resolverInterceptor(shotId)
        .catch(() => {}) // se reintentará en el siguiente tick
        .finally(() => interceptoresEnProcesoDeResolucion.delete(shotId));
    }
  }

  // b) ¿Algún disparo me amenaza a mí? (cálculo 100% local, con mi posición real)
  const amenazas = Counter.disparosQueMeAmenazan(ultimoSnapshotDisparos, miUbicacion);
  for (const amenaza of amenazas) {
    const restante = amenaza.impactAt - ahora;
    UI.mostrarBannerAmenaza(
      amenaza.shotId,
      amenaza.distanciaKm,
      restante,
      lanzarContramedidaDesdeUI,
      () => Mapa.seguirDisparo(amenaza.shotId),
      lanzarInterceptorDesdeUI
    );
  }
  // Deshabilita el botón de interceptar de los banners mientras ya haya un
  // interceptor en vuelo (se reactivan cuando se libera el slot).
  UI.sincronizarBotonesInterceptores(Interceptor.hayInterceptorEnVuelo());
}

async function resolverImpactos(shotIds) {
  for (const id of shotIds) shotsEnProcesoDeResolucion.add(id);
  try {
    await fetch(`${WORKER_BASE_URL}/resolve-impact-batch`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ shotIds }),
    });
  } catch (err) {
    console.warn('No se pudo resolver el lote de impactos (se reintentará en el siguiente tick):', err);
  } finally {
    for (const id of shotIds) shotsEnProcesoDeResolucion.delete(id);
  }
}

async function lanzarContramedidaDesdeUI(shotId) {
  try {
    await Counter.lanzar(shotId);
    contramedidasLanzadas.add(shotId);
    UI.marcarBannerContramedida(shotId);
    Mapa.marcarContramedida(shotId);
    UI.mostrarToast('Contramedida lanzada — protege a tu equipo en este disparo.', 'success');
  } catch (err) {
    UI.mostrarToast(err.message, 'error');
  }
}

async function lanzarInterceptorDesdeUI(targetShotId) {
  try {
    const res = await Interceptor.lanzar(targetShotId);
    UI.marcarBannerInterceptado(targetShotId);
    UI.sincronizarBotonesInterceptores(true);
    const destino = ultimoSnapshotDisparos?.[targetShotId];
    const pct = Math.round((res.hitProbability || 0) * 100);
    UI.mostrarToast(`🚀 Interceptor lanzado (precisión ${pct}%).`, 'success');
    registrarActividad(
      `🚀 Interceptor lanzado contra disparo entrante (precisión ${pct}%).`,
      'shot',
      destino ? { lat: destino.destLat, lng: destino.destLng, shotId: targetShotId } : null
    );
  } catch (err) {
    if (err.eliminated) {
      await manejarEliminacion();
      return;
    }
    UI.mostrarToast(err.message, 'error');
  }
}

// Cuando el enemigo lanza una contramedida contra un disparo MÍO, se pinta
// de violeta (distinguiéndolo del celeste que significa "contramedida tuya").
function onCambioContramedidas(contramedidas) {
  const miEquipo = estadoJugador.teamId || null;
  for (const [shotId, entradas] of Object.entries(contramedidas || {})) {
    const shot = ultimoSnapshotDisparos?.[shotId];
    if (!shot || shot.shooterId !== estadoJugador.playerId) continue; // solo mis disparos
    const hayAtacante = (entradas || []).some(
      (e) => e.launcherId !== estadoJugador.playerId && (miEquipo == null || e.teamId !== miEquipo)
    );
    if (hayAtacante && !misDisparosContracados.has(shotId)) {
      misDisparosContracados.add(shotId);
      Mapa.marcarContracada(shotId);
      UI.mostrarToast('⚠ Tu disparo está siendo contrarrestado por el enemigo.', 'error');
    }
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

// ---------- Feedback en vivo de apuntado ----------

function elCoordHud() {
  return document.getElementById('coord-hud');
}

function onMapaMousemove(e) {
  if (!modoApuntando) return;
  const el = elCoordHud();
  if (el) {
    el.classList.remove('hidden');
    const c = el.querySelector('.coord-value');
    if (c) c.textContent = `${e.latlng.lat.toFixed(4)}, ${e.latlng.lng.toFixed(4)}`;
  }
}

function onMapaMouseout() {
  if (!modoApuntando) return;
  const el = elCoordHud();
  if (el) el.classList.add('hidden');
}

function setAimCursor(activo) {
  const tmp = Mapa.obtenerMapa();
  if (tmp) tmp.getContainer().classList.toggle('aiming', activo);
  elCoordHud()?.classList.toggle('hidden', !activo);
}

async function confirmarDisparo() {
  if (!destinoElegido) return;
  if (jugadorEliminado || estadoJugador.status !== 'alive') {
    await manejarEliminacion();
    return;
  }
  const { disponibles } = informacionSlots(estadoJugador.launchSlots);
  if (disponibles <= 0) {
    UI.mostrarToast('No hay slots de lanzamiento disponibles. Espera a que se renueve uno.', 'error');
    return;
  }

  const distanciaKm = haversineKm(miUbicacion.lat, miUbicacion.lng, destinoElegido.lat, destinoElegido.lng);
  const flightMs = calcularFlightMs(distanciaKm);
  const impactAt = Math.round(Date.now() + flightMs);

  let result;
  try {
    result = await RT.crearDisparo(
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
  const shotId = result?.shotId;

  // El Worker devuelve el array launchSlots definitivo tras ocupar un slot:
  // se usa tal cual (fuente de verdad), en vez de marcado optimista que podía
  // duplicar slots cuando realtime ya había propagado el estado del servidor.
  if (Array.isArray(result?.launchSlots)) {
    estadoJugador.launchSlots = result.launchSlots;
  }

  fetch(`${WORKER_BASE_URL}/notify-threatened`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ shotId }),
  }).catch(() => {}); // el aviso a amenazados no es crítico si falla puntualmente

  const destinoLanzado = { lat: destinoElegido.lat, lng: destinoElegido.lng };
  Mapa.limpiarPreview();
  UI.ocultarPreviewDisparo();
  cancelarApuntado();
  registrarActividad(
    `🚀 Disparo lanzado · destino a ${Math.round(distanciaKm).toLocaleString('es-ES')} km · impacto en ${formatMMSS(flightMs)}`,
    'shot',
    { lat: destinoLanzado.lat, lng: destinoLanzado.lng, shotId }
  );
  UI.mostrarToast(`Disparo lanzado — impacto en ${formatMMSS(flightMs)}.`, 'success');
}

function cancelarApuntado() {
  modoApuntando = false;
  destinoElegido = null;
  document.getElementById('btn-fire')?.classList.remove('active');
  setAimCursor(false);
  Mapa.limpiarPreview();
  UI.ocultarPreviewDisparo();
}

// ---------- Nickname ----------

function pedirNickname(sugerido = '') {
  return new Promise((resolve) => {
    const input = document.getElementById('nickname-input');
    if (input) input.value = sugerido || '';
    UI.alternarModal('nickname-modal', true);
    const form = document.getElementById('nickname-form');
    form.addEventListener('submit', function onSubmit(e) {
      e.preventDefault();
      const valor = (input.value || '').trim();
      if (!valor) return;
      guardarNickname(valor);
      estadoJugador.nickname = valor;
      form.removeEventListener('submit', onSubmit);
      UI.alternarModal('nickname-modal', false);
      resolve(valor);
    });
  });
}

// ---------- Wiring de botones ----------

function wireUI() {
  document.getElementById('btn-fire')?.addEventListener('click', () => {
    modoApuntando = !modoApuntando;
    document.getElementById('btn-fire').classList.toggle('active', modoApuntando);
    setAimCursor(modoApuntando);
    if (!modoApuntando) {
      Mapa.limpiarPreview();
      UI.ocultarPreviewDisparo();
    }
  });

  document.getElementById('btn-confirm-shot')?.addEventListener('click', confirmarDisparo);
  document.getElementById('btn-cancel-shot')?.addEventListener('click', cancelarApuntado);

  document.getElementById('btn-open-ranking')?.addEventListener('click', () => UI.alternarModal('ranking-modal', true));
  document.getElementById('btn-toggle-debug')?.addEventListener('click', () => {
    const activo = !Mapa.modoDebugActivo();
    localStorage.setItem('geostrike_debug', activo ? '1' : '0');
    Mapa.establecerModoDebug(activo);
    document.getElementById('btn-toggle-debug').classList.toggle('active', activo);
    UI.mostrarToast(activo ? '🔬 Modo depuración (bots) activado' : 'Modo depuración desactivado', 'info');
  });
  // Refleja el estado inicial si ?debug venía en la URL (sin esperar al clic).
  if (Mapa.modoDebugActivo()) document.getElementById('btn-toggle-debug')?.classList.add('active');
  document.getElementById('btn-toggle-activity')?.addEventListener('click', () => {
    const panel = document.getElementById('activity-panel');
    const mostrar = panel?.classList.contains('hidden');
    UI.alternarActividad(mostrar);
    // Al abrir el panel se recarga SIEMPRE el historial de la partida en curso:
    // si se cerró la ventana y se reaprieta el botón, se muestra toda la actividad.
    if (mostrar) cargarActividadPersistida();
  });
  document.getElementById('btn-clear-activity')?.addEventListener('click', UI.limpiarActividad);
  document.getElementById('btn-toggle-threats')?.addEventListener('click', () => {
    UI.alternarPanelAmenazas(!UI.panelAmenazasVisible());
  });
  document.getElementById('btn-close-threats')?.addEventListener('click', () => UI.alternarPanelAmenazas(false));
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
