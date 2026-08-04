// realtime.js — toda la comunicación con Firebase. Nótese lo que NUNCA se
// escribe aquí en claro: coordenadas de jugadores (siempre locationEnc) ni
// origen de disparos (los shots solo llevan destino).

import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js';
import {
  getDatabase, ref, set, update, onValue, push, get, serverTimestamp, onDisconnect,
} from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-database.js';
import { FIREBASE_CONFIG } from './config.js';

const app = initializeApp(FIREBASE_CONFIG);
export const db = getDatabase(app);

// ---------- Jugador propio ----------

export async function registrarJugador(playerId, nickname, locationEnc) {
  const playerRef = ref(db, `players/${playerId}`);
  const snap = await get(playerRef);
  if (!snap.exists()) {
    await set(playerRef, {
      nickname, locationEnc, hp: 100, status: 'alive', teamId: null,
      nextShotAvailableAt: 0, nextCounterAvailableAt: 0, lastSeen: Date.now(),
    });
  } else {
    await update(playerRef, { locationEnc, lastSeen: Date.now() });
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

export function suscribirseABots(callback) {
  return onValue(ref(db, 'bots'), (snap) => callback(snap.val() || {}));
}

// ---------- Disparos ----------

export async function crearDisparo(shooterId, shooterNickname, destLat, destLng, impactAt) {
  const shotRef = push(ref(db, 'shots'));
  await set(shotRef, {
    shooterId, shooterNickname, destLat, destLng,
    firedAt: Date.now(), impactAt, resolved: false,
  });
  return shotRef.key;
}

export function suscribirseADisparos(callback) {
  return onValue(ref(db, 'shots'), (snap) => callback(snap.val() || {}));
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

// ---------- Ranking ----------

export function suscribirseARanking(callback) {
  return onValue(ref(db, 'ranking'), (snap) => callback(snap.val() || {}));
}

// ---------- Push subscription ----------

export function guardarPushSubscription(playerId, subscription) {
  return update(ref(db, `players/${playerId}`), { pushSubscription: subscription });
}
