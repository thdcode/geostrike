// realtime.js — toda la comunicación con Firebase. Nótese lo que NUNCA se
// escribe aquí en claro: coordenadas de jugadores (siempre locationEnc) ni
// origen de disparos (los shots solo llevan destino).

import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js';
import {
  getDatabase, ref, set, update, onValue, push, get, serverTimestamp, onDisconnect,
} from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-database.js';
import { FIREBASE_CONFIG, WORKER_BASE_URL } from './config.js';

const app = initializeApp(FIREBASE_CONFIG);
export const db = getDatabase(app);

// ---------- Sesiones (recuperación de partida activa) ----------

/**
 * Devuelve la sesión guardada para este dispositivo o null si no existe.
 * La sesión contiene { playerId, nickname, active }.
 */
export async function obtenerSesion(deviceId) {
  const snap = await get(ref(db, `sessions/${deviceId}`));
  return snap.exists() ? snap.val() : null;
}

/** Crea o actualiza la sesión activa de este dispositivo para el nickname dado. */
export function crearSesion(deviceId, playerId, nickname, puntosBase = 0) {
  return set(ref(db, `sessions/${deviceId}`), {
    playerId, nickname, active: true, createdAt: Date.now(), puntosBase,
  });
}

/**
 * Puntos actuales del jugador en el ranking global. Se usan como línea base al
 * iniciar una partida: el HUD muestra la puntuación de la partida (global − base),
 * sin tocar el ranking global persistente.
 */
export async function obtenerPuntosRanking(nickname) {
  const snap = await get(ref(db, `ranking/${sanitizeKey(nickname)}/points`));
  return snap.exists() ? snap.val() : 0;
}

// Misma sanitización de claves de ranking que el Worker (Firebase prohíbe . # $ [ ]).
export function sanitizeKey(nickname) {
  return encodeURIComponent((nickname || '').replace(/[.#$[\]]/g, '_'));
}

/** Marca la sesión como finalizada (el jugador decidió empezar de cero la próxima vez). */
export function finalizarSesion(deviceId) {
  return update(ref(db, `sessions/${deviceId}`), { active: false });
}

// ---------- Jugador propio ----------

export async function registrarJugador(playerId, nickname, locationEnc) {
  // El registro pasa por el Worker (POST /register), que aplica el tope de
  // jugadores reales y crea/actualiza el jugador con credenciales elevadas.
  const res = await fetch(`${WORKER_BASE_URL}/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ playerId, nickname, locationEnc }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.ok) {
    const err = new Error(data.error || 'No se pudo registrar al jugador');
    if (data.code === 'SALA_LLENA') err.code = 'SALA_LLENA';
    throw err;
  }
  // Si el jugador cierra la pestaña, se marca lastSeen para que el Worker
  // pueda, si hace falta, ignorar jugadores obsoletos al calcular densidad.
  onDisconnect(ref(db, `players/${playerId}/lastSeen`)).set(-1);
}

export function actualizarUbicacion(playerId, locationEnc) {
  return update(ref(db, `players/${playerId}`), { locationEnc, lastSeen: Date.now() });
}

export function suscribirseAJugadorPropio(playerId, callback) {
  return onValue(ref(db, `players/${playerId}`), (snap) => callback(snap.val()));
}

// ---------- Bots (sí se muestran en el mapa, no son personas) ----------
// Viven en /players con isBot:true, pero el cliente NO puede leer la colección
// players completa (rules). El Worker mantiene un espejo público en /bots con
// solo lo visible (lat/lng/status/zoneCity), que sí es de lectura abierta.
export function suscribirseABots(callback) {
  return onValue(ref(db, 'bots'), (snap) => callback(snap.val() || {}));
}

// ---------- Disparos ----------

/**
 * Crea un disparo a través del Worker (POST /fire-shot). El Worker valida que
 * el tirador siga vivo; si no, lanza un Error con la propiedad `eliminated` en
 * true para que el cliente pueda finalizar la partida.
 */
export async function crearDisparo(shooterId, shooterNickname, destLat, destLng, impactAt) {
  const res = await fetch(`${WORKER_BASE_URL}/fire-shot`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ playerId: shooterId, nickname: shooterNickname, destLat, destLng, impactAt }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.ok || !data.shotId) {
    const err = new Error(data.error || 'El Worker rechazó el disparo');
    if (data.eliminated) err.eliminated = true;
    throw err;
  }
  return data;
}

/** Pide al Worker que anule los disparos en vuelo del jugador al finalizar la partida. */
export async function cancelarDisparosPropios(playerId, deviceId) {
  const res = await fetch(`${WORKER_BASE_URL}/cancel-player-shots`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ playerId, deviceId }),
  });
  if (!res.ok) throw new Error('No se pudieron cancelar los disparos propios');
}

export function suscribirseADisparos(callback) {
  return onValue(ref(db, 'shots'), (snap) => callback(snap.val() || {}));
}

// ---------- Disparos interceptores ----------

/**
 * Lanza un disparo interceptor contra un disparo entrante a través del Worker
 * (POST /fire-interceptor). El Worker valida amenaza, uno-en-vuelo y tiempo.
 */
export async function lanzarInterceptor(playerId, targetShotId) {
  const res = await fetch(`${WORKER_BASE_URL}/fire-interceptor`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ playerId, targetShotId }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.ok || !data.interceptorId) {
    const err = new Error(data.error || 'El Worker rechazó el interceptor');
    if (data.eliminated) err.eliminated = true;
    throw err;
  }
  return data;
}

/** Pide al Worker que finalice un interceptor cuyo impactAt ya pasó (se llama desde el tick). */
export async function resolverInterceptor(interceptorId) {
  const res = await fetch(`${WORKER_BASE_URL}/resolve-interceptor`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ interceptorId }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'No se pudo resolver el interceptor');
  return data;
}

// ---------- Equipos (teamId == código de invitación, por simplicidad) ----------

export async function crearEquipo(nombre, playerId) {
  const codigo = generarCodigo();
  await set(ref(db, `teams/${codigo}`), {
    name: nombre, members: [playerId], createdAt: Date.now(),
  });
  await update(ref(db, `players/${playerId}`), { teamId: codigo });
  return codigo;
}

export async function unirseAEquipo(codigo, playerId) {
  const teamRef = ref(db, `teams/${codigo}`);
  const snap = await get(teamRef);
  if (!snap.exists()) throw new Error('Ese código de equipo no existe');
  const team = snap.val();
  const members = team.members || [];
  if (!members.includes(playerId)) members.push(playerId);
  await update(teamRef, { members });
  await update(ref(db, `players/${playerId}`), { teamId: codigo });
  return team.name;
}

export function suscribirseAEquipo(teamId, callback) {
  return onValue(ref(db, `teams/${teamId}`), (snap) => callback(snap.val()));
}

function generarCodigo() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // sin caracteres ambiguos
  let codigo = '';
  for (let i = 0; i < 6; i++) codigo += chars[Math.floor(Math.random() * chars.length)];
  return codigo;
}

// ---------- Contramedidas ----------

export async function lanzarContramedida(shotId, playerId, teamId) {
  const entryRef = push(ref(db, `countermeasures/${shotId}`));
  await set(entryRef, { launcherId: playerId, teamId: teamId || null, launchedAt: Date.now() });
}

/** Observa todas las contramedidas desplegadas: { shotId: [{ launcherId, teamId, launchedAt }] }. */
export function suscribirseAContramedidas(callback) {
  return onValue(ref(db, 'countermeasures'), (snap) => callback(snap.val() || {}));
}

// ---------- Actividad persistente de la partida ----------

/** Guarda un evento del panel de actividad bajo el playerId de la partida en curso. */
export async function guardarEventoActividad(playerId, evento) {
  await push(ref(db, `activity/${playerId}`), evento);
}

/** Devuelve el historial persistido de la partida (array de eventos con ts/tipo/texto/coordenadas). */
export async function obtenerActividad(playerId) {
  const snap = await get(ref(db, `activity/${playerId}`));
  return snap.exists() ? Object.values(snap.val()) : [];
}

// ---------- Ranking ----------

export function suscribirseARanking(callback) {
  return onValue(ref(db, 'ranking'), (snap) => callback(snap.val() || {}));
}

// ---------- Push subscription ----------

export function guardarPushSubscription(playerId, subscription) {
  return update(ref(db, `players/${playerId}`), { pushSubscription: subscription });
}
