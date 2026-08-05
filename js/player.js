// player.js — identidad local sin cuentas ni email. El "login" se verifica con
// la información del dispositivo (deviceId en localStorage) + el nickname.
// El estado de la partida activa vive en Firebase bajo sessions/{deviceId}.

const NICKNAME_KEY = 'geostrike:nickname';
const DEVICE_ID_KEY = 'geostrike:deviceId';
const PLAYER_ID_KEY = 'geostrike:playerId'; // legado: se migra a sessions/ en Firebase

/** Devuelve (creándolo si hace falta) el id de dispositivo y el nickname guardado. */
export function obtenerIdentidadDispositivo() {
  let deviceId = localStorage.getItem(DEVICE_ID_KEY);
  if (!deviceId) {
    deviceId = crypto.randomUUID();
    localStorage.setItem(DEVICE_ID_KEY, deviceId);
  }
  const nickname = localStorage.getItem(NICKNAME_KEY);
  return { deviceId, nickname };
}

export function guardarNickname(nickname) {
  localStorage.setItem(NICKNAME_KEY, nickname);
}

/** playerId de la identidad antigua (anterior a sessions/). Se consume y se migra a sesión. */
export function leerPlayerIdLegacy() {
  const id = localStorage.getItem(PLAYER_ID_KEY);
  if (id) localStorage.removeItem(PLAYER_ID_KEY);
  return id;
}

/** Estado local en memoria, actualizado por realtime.js al suscribirse a players/{miId}. */
export const estadoJugador = {
  playerId: null,
  nickname: null,
  hp: 100,
  status: 'alive',
  teamId: null,
  nextShotAvailableAt: 0,
  nextCounterAvailableAt: 0,
  interceptorInFlight: null, // { interceptorId, until } mientras haya uno en vuelo
  lat: null,
  lng: null,
};
