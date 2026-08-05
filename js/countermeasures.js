// countermeasures.js — la detección de "¿me amenaza este disparo?" se hace
// en LOCAL, con tu propia posición real (no hay problema de privacidad: es
// la tuya) contra el destino PÚBLICO de cada disparo. Nadie más ve este cálculo.

import { WARNING_RADIUS_KM, COUNTERMEASURE_COOLDOWN_MS } from './config.js';
import { haversineKm } from './physics.js';
import { lanzarContramedida } from './realtime.js';
import { estadoJugador } from './player.js';

/**
 * @param {object} shots - nodo completo de shots/ desde Firebase
 * @param {{lat:number,lng:number}} miUbicacion
 * @returns {Array<{shotId:string, distanciaKm:number, impactAt:number}>}
 */
export function disparosQueMeAmenazan(shots, miUbicacion) {
  if (!miUbicacion) return [];
  const ahora = Date.now();
  const amenazas = [];
  for (const [shotId, shot] of Object.entries(shots || {})) {
    if (shot.resolved || shot.impactAt <= ahora) continue;
    // Un disparo entrante es de OTROS: un disparo propio nunca dispara el aviso,
    // por muy cerca que caiga. El destino sí puede estar a cualquier distancia
    // de origen (nunca se filtra por distancia de lanzamiento).
    if (shot.shooterId && shot.shooterId === estadoJugador.playerId) continue;
    const distanciaKm = haversineKm(miUbicacion.lat, miUbicacion.lng, shot.destLat, shot.destLng);
    if (distanciaKm <= WARNING_RADIUS_KM) {
      amenazas.push({ shotId, distanciaKm, impactAt: shot.impactAt });
    }
  }
  return amenazas.sort((a, b) => a.impactAt - b.impactAt);
}

export function puedeLanzarContramedida() {
  return Date.now() >= (estadoJugador.nextCounterAvailableAt || 0);
}

export async function lanzar(shotId) {
  if (!puedeLanzarContramedida()) {
    throw new Error('Contramedida en recarga todavía');
  }
  await lanzarContramedida(shotId, estadoJugador.playerId, estadoJugador.teamId);
}
