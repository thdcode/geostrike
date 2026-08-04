// player.js — identidad local (sin cuentas, solo nickname + id aleatorio)
// y acceso al estado propio del jugador.

const NICKNAME_KEY = 'geostrike:nickname';
const PLAYER_ID_KEY = 'geostrike:playerId';

export function obtenerOCrearIdentidad() {
  let playerId = localStorage.getItem(PLAYER_ID_KEY);
  if (!playerId) {
    playerId = crypto.randomUUID();
    localStorage.setItem(PLAYER_ID_KEY, playerId);
  }
  let nickname = localStorage.getItem(NICKNAME_KEY);
  return { playerId, nickname };
}

export function guardarNickname(nickname) {
  localStorage.setItem(NICKNAME_KEY, nickname);
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
  lat: null,
  lng: null,
};
