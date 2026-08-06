// realtime.js — comunicación con el backend. Ya NO usa Firebase: el cliente
// lee/escribe exclusivamente a través del Cloudflare Worker, que persiste en
// Appwrite. Todo lo que antes eran "subscripciones" (onValue) se resuelve por
// POLLING de un endpoint /snapshot cada POLL_INTERVAL_MS, conservando la misma
// API pública que los módulos del cliente usan (main, ranking, teams, push…).

import { WORKER_BASE_URL } from './config.js';

const POLL_INTERVAL_MS = 3_000;
const WORKER = (path) => WORKER_BASE_URL + path;

// --- Estado local (espejo del snapshot devuelto por el Worker) ---
const state = {
  me: null,
  bots: {},
  shots: {},
  countermeasures: {},
  ranking: {},
  teams: {},
  sessions: {},
  activity: {},
};
const lastSig = {};
let currentPlayerId = null;
let pollTimer = null;

// --- Registro de subscriptores por nodo ---
const subs = {};
function sub(key, cb) {
  (subs[key] ||= new Set()).add(cb);
  return () => subs[key]?.delete(cb);
}
function notify(key, value) {
  for (const cb of subs[key] || []) cb(value);
}

// --- Capa HTTP mínima ---
async function post(path, body) {
  const res = await fetch(WORKER(path), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {}),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error || `HTTP ${res.status}`);
    if (data.eliminated) err.eliminated = true;
    if (data.code) err.code = data.code;
    throw err;
  }
  return data;
}

async function get(path) {
  const res = await fetch(WORKER(path));
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

// --- Aplicar un nodo del snapshot y avisar solo si cambió ---
function aplicar(nodo, valor) {
  const actual = valor || (nodo === 'me' ? null : {});
  const sig = JSON.stringify(actual);
  if (sig === lastSig[nodo]) return;
  lastSig[nodo] = sig;
  state[nodo] = actual;
  notify(nodo, actual);
}

async function refrescarSnapshot() {
  try {
    const snap = await get(`/snapshot?playerId=${encodeURIComponent(currentPlayerId || '')}`);
    aplicar('me', snap.me || null);
    aplicar('bots', snap.bots || {});
    aplicar('shots', snap.shots || {});
    aplicar('countermeasures', snap.countermeasures || {});
    aplicar('ranking', snap.ranking || {});
    aplicar('teams', snap.teams || {});
    aplicar('sessions', snap.sessions || {});
    aplicar('activity', snap.activity || {});
  } catch {
    // silencioso: se reintenta en el siguiente ciclo de polling
  }
}

function ensurePolling() {
  if (pollTimer) return;
  refrescarSnapshot();
  pollTimer = setInterval(refrescarSnapshot, POLL_INTERVAL_MS);
}

// ---------- Sesiones ----------

export async function obtenerSesion(deviceId) {
  const data = await get(`/session?deviceId=${encodeURIComponent(deviceId)}`);
  const s = data.session;
  return s && s.active ? s : null;
}

export async function crearSesion(deviceId, playerId, nickname, puntosBase = 0) {
  await post('/session', { deviceId, playerId, nickname, puntosBase, active: true });
}

export async function finalizarSesion(deviceId) {
  await post('/session', { deviceId, playerId: null, nickname: '', puntosBase: 0, active: false });
}

export async function obtenerPuntosRanking(nickname) {
  const data = await get(`/ranking-points?nickname=${encodeURIComponent(nickname)}`);
  return data.points || 0;
}

// Misma sanitización de claves de ranking que el Worker (util.js).
export function sanitizeKey(nickname) {
  if (!nickname) return '';
  return String(nickname).replace(/[^a-zA-Z0-9._-]/g, '_').substring(0, 36);
}

// ---------- Jugador propio ----------

export async function registrarJugador(playerId, nickname, locationEnc) {
  const data = await post('/register', { playerId, nickname, locationEnc });
  currentPlayerId = playerId;
  ensurePolling();
  return data;
}

export async function actualizarUbicacion(playerId, locationEnc) {
  await post('/update-location', { playerId, locationEnc });
}

export function suscribirseAJugadorPropio(playerId, callback) {
  currentPlayerId = playerId;
  ensurePolling();
  return sub('me', callback);
}

// ---------- Bots (público) ----------

export function suscribirseABots(callback) {
  ensurePolling();
  return sub('bots', callback);
}

// ---------- Disparos ----------

export async function crearDisparo(shooterId, shooterNickname, destLat, destLng, impactAt) {
  const data = await post('/fire-shot', { playerId: shooterId, nickname: shooterNickname, destLat, destLng, impactAt });
  if (!data.shotId) throw new Error(data.error || 'El Worker rechazó el disparo');
  return data;
}

export async function cancelarDisparosPropios(playerId, deviceId) {
  await post('/cancel-player-shots', { playerId, deviceId });
}

export function suscribirseADisparos(callback) {
  ensurePolling();
  return sub('shots', callback);
}

// ---------- Disparos interceptores ----------

export async function lanzarInterceptor(playerId, targetShotId) {
  const data = await post('/fire-interceptor', { playerId, targetShotId });
  if (!data.interceptorId) throw new Error(data.error || 'El Worker rechazó el interceptor');
  return data;
}

export async function resolverInterceptor(interceptorId) {
  return post('/resolve-interceptor', { interceptorId });
}

// ---------- Contramedidas ----------

export async function lanzarContramedida(shotId, playerId, teamId) {
  await post('/launch-countermeasure', { shotId, playerId, teamId });
}

export function suscribirseAContramedidas(callback) {
  ensurePolling();
  return sub('countermeasures', callback);
}

// ---------- Equipos ----------

export async function crearEquipo(nombre, playerId) {
  const data = await post('/team-create', { name: nombre, playerId });
  return data.code;
}

export async function unirseAEquipo(codigo, playerId) {
  const data = await post('/team-join', { code: codigo, playerId });
  return data.name;
}

const equiposSubs = new Map();
export function suscribirseAEquipo(teamId, callback) {
  ensurePolling();
  if (!equiposSubs.has(teamId)) {
    equiposSubs.set(teamId, new Set());
    sub('teams', () => {
      for (const [id, cbs] of equiposSubs) {
        const node = (state.teams || {})[id] || null;
        for (const cb of cbs) cb(node);
      }
    });
  }
  equiposSubs.get(teamId).add(callback);
  // Emite el estado actual si ya se cargó.
  const actual = (state.teams || {})[teamId] || null;
  if (actual) callback(actual);
  return () => equiposSubs.get(teamId)?.delete(callback);
}

// ---------- Actividad persistente de la partida ----------

export async function guardarEventoActividad(playerId, evento) {
  await post('/activity', { playerId, evento });
}

export async function obtenerActividad(playerId) {
  if (playerId) currentPlayerId = playerId; // asegura que el snapshot traiga la actividad de esta partida
  await refrescarSnapshot();
  return (state.activity || {})[playerId] || [];
}

// ---------- Ranking ----------

export function suscribirseARanking(callback) {
  ensurePolling();
  return sub('ranking', callback);
}

// ---------- Push subscription ----------

export function guardarPushSubscription(playerId, subscription) {
  return post('/push-subscribe', { playerId, subscription });
}