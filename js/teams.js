// teams.js — crear/unirse a un equipo. La pertenencia es pública (no revela
// ubicación de nadie), solo permite saber quién juega con quién.

import { crearEquipo, unirseAEquipo, suscribirseAEquipo } from './realtime.js';
import { estadoJugador } from './player.js';

export async function crear(nombreEquipo) {
  const codigo = await crearEquipo(nombreEquipo, estadoJugador.playerId);
  estadoJugador.teamId = codigo;
  return codigo;
}

export async function unirse(codigo) {
  const nombre = await unirseAEquipo(codigo.trim().toUpperCase(), estadoJugador.playerId);
  estadoJugador.teamId = codigo.trim().toUpperCase();
  return nombre;
}

export function observarEquipo(teamId, callback) {
  return suscribirseAEquipo(teamId, callback);
}
