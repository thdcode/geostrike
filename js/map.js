// map.js — el mapa NUNCA renderiza marcadores de otros jugadores reales.
// Solo se dibujan: tu propio marcador, los bots (no son personas), y los
// círculos de 50 km de los disparos en curso/recientes.

import { SPLASH_RADIUS_KM } from './config.js';

let map;
let miMarcador = null;
const marcadoresBots = new Map(); // botId -> L.CircleMarker
const capasDisparos = new Map(); // shotId -> { circle, impactMarker }

export function inicializarMapa(lat, lng) {
  map = L.map('map', { zoomControl: true, worldCopyJump: true }).setView([lat, lng], 6);

  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '&copy; OpenStreetMap contributors',
    maxZoom: 18,
  }).addTo(map);

  return map;
}

export function dibujarMiMarcador(lat, lng) {
  if (miMarcador) {
    miMarcador.setLatLng([lat, lng]);
    return;
  }
  miMarcador = L.circleMarker([lat, lng], {
    radius: 7, color: '#35D499', fillColor: '#35D499', fillOpacity: 0.9, weight: 2,
  }).addTo(map).bindTooltip('Tú', { permanent: false });
}

export function actualizarBots(bots) {
  const idsActuales = new Set(Object.keys(bots || {}));

  // Elimina bots que ya no existen (respawn en otra ciudad, muerte definitiva, etc.)
  for (const [botId, marker] of marcadoresBots.entries()) {
    if (!idsActuales.has(botId)) {
      map.removeLayer(marker);
      marcadoresBots.delete(botId);
    }
  }

  for (const [botId, bot] of Object.entries(bots || {})) {
    if (bot.status === 'down') continue;
    let marker = marcadoresBots.get(botId);
    if (!marker) {
      marker = L.circleMarker([bot.lat, bot.lng], {
        radius: 5, color: '#7C8AA5', fillColor: '#7C8AA5', fillOpacity: 0.8, weight: 1,
      }).addTo(map).bindTooltip(`Bot · ${bot.zoneCity || '?'}`);
      marcadoresBots.set(botId, marker);
    } else {
      marker.setLatLng([bot.lat, bot.lng]);
    }
  }
}

/** Dibuja/actualiza el círculo de 50 km de un disparo en curso o recién resuelto. */
export function dibujarDisparo(shotId, destLat, destLng, resuelto) {
  let capa = capasDisparos.get(shotId);
  const color = resuelto ? '#7C8AA5' : '#F2A93B';

  if (!capa) {
    const circle = L.circle([destLat, destLng], {
      radius: SPLASH_RADIUS_KM * 1000, color, weight: 1.5, dashArray: '4 4', fillOpacity: 0.06,
    }).addTo(map);
    const impactMarker = L.marker([destLat, destLng], {
      icon: L.divIcon({ className: 'impact-x-icon', html: '✕', iconSize: [14, 14] }),
    }).addTo(map);
    capa = { circle, impactMarker };
    capasDisparos.set(shotId, capa);
  } else {
    capa.circle.setStyle({ color });
  }
  return capa;
}

/** Elimina del mapa los disparos ya resueltos hace más de un rato (limpieza visual). */
export function limpiarDisparo(shotId) {
  const capa = capasDisparos.get(shotId);
  if (!capa) return;
  map.removeLayer(capa.circle);
  map.removeLayer(capa.impactMarker);
  capasDisparos.delete(shotId);
}

export function obtenerMapa() {
  return map;
}
