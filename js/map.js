// map.js — el mapa NUNCA renderiza marcadores de otros jugadores reales.
// Solo se dibujan: tu propio marcador, los bots (no son personas) y los
// disparos. Los disparos se animan en tiempo real estilo flyscanner:
//   - Disparos propios: trayectoria completa real (origen = tu posición).
//   - Disparos ajenos: se anima la LLEGADA convergiendo al destino desde el
//     perímetro, sin inventar ni revelar el origen del jugador que dispara.

import { SPLASH_RADIUS_KM } from './config.js';
import { formatMMSS } from './physics.js';

let map;
let miMarcador = null;
const marcadoresBots = new Map(); // botId -> L.CircleMarker
const animaciones = new Map();    // shotId -> animación del disparo

let rafId = null;

// ---------- Parámetros de la animación ----------
const TRAIL_MAX_POINTS = 60;  // longitud máxima de la estela (puntos)
const TRAIL_GAP_MS = 140;     // cada cuánto se añade un punto a la estela
const APROX_RADIO_KM = 150;   // distancia del punto sintético de llegada de disparos ajenos

const COLOR_PROPIO = '#F2A93B';
const COLOR_ENEMIGO = '#FF6B6B';
const COLOR_PREVIEW = '#8AD8FF';

export function inicializarMapa(lat, lng) {
  map = L.map('map', { zoomControl: true, worldCopyJump: true }).setView([lat, lng], 6);

  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '&copy; OpenStreetMap contributors',
    maxZoom: 18,
  }).addTo(map);

  return map;
}

export function obtenerMapa() {
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

// ---------- Disparos: motor de animación flyscanner ----------

/**
 * Registra/actualiza la animación de un disparo.
 * @param {string} shotId
 * @param {object} shot - nodo completo del disparo (destLat, destLng, firedAt, impactAt, resolved)
 * @param {{lat:number,lng:number}|null} origen - tu posición si el disparo es tuyo; null para ajenos
 * @param {boolean} amenaza - si el disparo entra dentro de tu radio de advertencia
 */
export function rastrearDisparo(shotId, shot, origen, amenaza = false) {
  let a = animaciones.get(shotId);
  if (!a) {
    a = crearAnimacion(shotId, shot, origen, amenaza);
    animaciones.set(shotId, a);
    if (a.estado === 'vuelo' && !prefersReducedMotion()) arrancarBucle();
    return;
  }
  // El bucle de animación detecta la transición a resolved y dispara la explosión.
  a.shot = shot;
  a.amenaza = amenaza && !shot.resolved;
  a.marcador?.getElement()?.classList.toggle('amenaza', a.amenaza);
}

export function listaDisparos() {
  return [...animaciones.keys()];
}

export function limpiarDisparo(shotId) {
  const a = animaciones.get(shotId);
  if (!a) return;
  quitarCapasAnimacion(a);
  for (const key of ['circulo', 'impactMarker']) {
    if (a[key]) { map.removeLayer(a[key]); a[key] = null; }
  }
  animaciones.delete(shotId);
  if (animaciones.size === 0 && rafId) { cancelAnimationFrame(rafId); rafId = null; }
}

// ---------- Preview de apuntado ----------

export function mostrarPreview(origen, destino, flightMs) {
  const shot = {
    destLat: destino.lat, destLng: destino.lng,
    firedAt: Date.now(), impactAt: Date.now() + flightMs, resolved: false,
  };
  const existente = animaciones.get('preview');
  if (existente) {
    existente.shot = shot;
    existente.destino = [shot.destLat, shot.destLng];
    existente.origenLat = origen.lat;
    existente.origenLng = origen.lng;
    existente.puntos = [];
    existente.ultimoPuntoAt = 0;
    existente.ultimaPos = null;
    existente.estado = 'vuelo';
    setEstela(existente.estela, []);
    existente.ruta.setLatLngs([[origen.lat, origen.lng], [shot.destLat, shot.destLng]]);
    existente.marcador.setLatLng([origen.lat, origen.lng]);
    if (existente.ping) existente.ping.setLatLng(existente.destino);
  } else {
    rastrearDisparo('preview', shot, { lat: origen.lat, lng: origen.lng }, false);
  }
  arrancarBucle();
}

export function limpiarPreview() {
  limpiarDisparo('preview');
}

// ---------- Interno ----------

function crearAnimacion(shotId, shot, origen, amenaza) {
  const esPreview = shotId === 'preview';
  const esEnemigo = !origen && !esPreview;
  const destino = [shot.destLat, shot.destLng];
  const origenDef = origen ? [origen.lat, origen.lng] : puntoAproximacion(destino, shotId);
  const color = esPreview ? COLOR_PREVIEW : esEnemigo ? COLOR_ENEMIGO : COLOR_PROPIO;

  const marcador = L.marker(origenDef, {
    icon: L.divIcon({
      className: `missile-icon${esEnemigo ? ' enemy' : ''}${esPreview ? ' preview' : ''}`,
      html: '<div class="missile-wrap"><svg viewBox="0 0 24 24" class="missile-svg"><path d="M12 2 L21 22 L12 17.5 L3 22 Z"/></svg></div>',
      iconSize: [20, 20], iconAnchor: [10, 10],
    }),
    interactive: false, keyboard: false,
  }).addTo(map);
  const wrap = marcador.getElement().querySelector('.missile-wrap');

  const etaMarker = L.marker(origenDef, {
    icon: L.divIcon({
      className: 'eta-label-wrap',
      html: '<span class="eta-label mono">--:--</span>',
      iconSize: [0, 0],
    }),
    interactive: false, keyboard: false,
  }).addTo(map);
  const etaEl = etaMarker.getElement().querySelector('.eta-label');

  const estela = [
    L.polyline([], { color, weight: 2, opacity: 0.35, dashArray: '1 7' }),
    L.polyline([], { color, weight: 2.5, opacity: 0.7, dashArray: '1 7' }),
    L.polyline([], { color, weight: 3.5, opacity: 1, dashArray: '1 7' }),
  ].map((p) => p.addTo(map));

  const ruta = L.polyline([origenDef, destino], {
    color, weight: 1, opacity: 0.35, dashArray: '2 8', interactive: false,
  }).addTo(map);

  const circulo = L.circle(destino, {
    radius: SPLASH_RADIUS_KM * 1000, color, weight: 1.5, dashArray: '4 4',
    fillOpacity: 0.06, interactive: false,
  }).addTo(map);

  const impactMarker = L.marker(destino, {
    icon: L.divIcon({ className: 'impact-x-icon', html: '✕', iconSize: [14, 14] }),
    interactive: false, keyboard: false,
  }).addTo(map);
  impactMarker.getElement().style.color = color;

  const ping = L.marker(destino, {
    icon: L.divIcon({
      className: 'radar-ping',
      html: `<div class="radar-ping-ring" style="border-color:${color}"></div>`,
      iconSize: [0, 0],
    }),
    interactive: false, keyboard: false,
  }).addTo(map);

  const a = {
    shotId, shot, destino,
    origenLat: origenDef[0], origenLng: origenDef[1],
    marcador, wrap, etaMarker, etaEl, estela, ruta, circulo, impactMarker, ping,
    puntos: [], ultimoPuntoAt: 0, ultimaPos: null, color,
    estado: shot.resolved ? 'impactado' : 'vuelo',
    amenaza: amenaza && !shot.resolved,
  };

  if (a.estado === 'impactado') {
    // El disparo ya estaba resuelto cuando este cliente lo vio: solo residuo, sin explosión.
    a.circulo.setStyle({ color, weight: 2, dashArray: null, fillOpacity: 0.12, opacity: 1 });
    quitarCapasAnimacion(a);
  } else if (prefersReducedMotion()) {
    const t = progreso(a);
    a.marcador.setLatLng(interpolar(a, t));
    a.etaEl.textContent = formatMMSS(Math.max(0, a.shot.impactAt - Date.now()));
  } else {
    marcador.getElement().classList.toggle('amenaza', a.amenaza);
  }

  return a;
}

function quitarCapasAnimacion(a) {
  for (const key of ['marcador', 'etaMarker', 'ping', 'ruta']) {
    if (a[key]) { map.removeLayer(a[key]); a[key] = null; }
  }
  for (const p of (a.estela || [])) {
    if (p) map.removeLayer(p);
  }
  a.estela = [];
}

function arrancarBucle() {
  if (rafId || prefersReducedMotion()) return;
  let ultimo = 0;
  const paso = (t) => {
    if (t - ultimo < 33) { rafId = requestAnimationFrame(paso); return; } // ~30 fps
    ultimo = t;
    let activos = 0;
    for (const a of animaciones.values()) {
      if (a.estado !== 'vuelo') continue;
      activos++;
      actualizarFrame(a);
    }
    rafId = activos > 0 ? requestAnimationFrame(paso) : null;
  };
  rafId = requestAnimationFrame(paso);
}

function actualizarFrame(a) {
  const { shot } = a;

  if (shot.resolved && a.estado !== 'impactado') {
    a.estado = 'impactado';
    dispararExplosion(a);
    return;
  }
  if (a.estado !== 'vuelo') return;

  const t = progreso(a);
  const pos = interpolar(a, t);
  if (a.marcador) a.marcador.setLatLng(pos);
  rotarMarcador(a, pos);
  if (a.etaEl) a.etaEl.textContent = formatMMSS(Math.max(0, shot.impactAt - Date.now()));
  añadirPuntoEstela(a, pos);
}

function dispararExplosion(a) {
  const [dlat, dlng] = a.destino;

  if (!prefersReducedMotion()) {
    const flash = L.marker([dlat, dlng], {
      icon: L.divIcon({
        className: 'impact-flash',
        html: '<div class="impact-flash-ring"></div>',
        iconSize: [160, 160], iconAnchor: [80, 80],
      }),
      interactive: false, keyboard: false,
    }).addTo(map);
    setTimeout(() => map.removeLayer(flash), 950);

    let ring = L.circle([dlat, dlng], { radius: 0, color: a.color, weight: 2.5, opacity: 0.9 });
    ring.addTo(map);
    const inicio = Date.now();
    const DURACION = 900;
    const MAX_RADIO = 250_000; // 250 km
    const iv = setInterval(() => {
      const p = Math.min(1, (Date.now() - inicio) / DURACION);
      ring.setRadius(MAX_RADIO * easeOutCubic(p));
      ring.setStyle({ opacity: 0.9 * (1 - p) });
      if (p >= 1) { clearInterval(iv); map.removeLayer(ring); ring = null; }
    }, 16);
  }

  // El círculo de salpicadura queda sólido como residuo del impacto.
  a.circulo.setStyle({ color: a.color, weight: 2, dashArray: null, fillOpacity: 0.12, opacity: 1 });
  quitarCapasAnimacion(a);
}

function interpolar(a, t) {
  return interpolateGreatCircle(a.origenLat, a.origenLng, a.destino[0], a.destino[1], t);
}

function progreso(a) {
  const duracion = (a.shot.impactAt - a.shot.firedAt) || 1;
  return Math.max(0, Math.min(1, (Date.now() - a.shot.firedAt) / duracion));
}

function rotarMarcador(a, pos) {
  const prev = a.ultimaPos;
  a.ultimaPos = pos;
  if (!prev || !a.wrap) return;
  a.wrap.style.transform = `rotate(${bearingTo(prev[0], prev[1], pos[0], pos[1])}deg)`;
}

function añadirPuntoEstela(a, pos) {
  const ahora = Date.now();
  if (ahora - a.ultimoPuntoAt < TRAIL_GAP_MS) return;
  a.ultimoPuntoAt = ahora;
  a.puntos.push(pos);
  if (a.puntos.length > TRAIL_MAX_POINTS) a.puntos.shift();
  setEstela(a.estela, a.puntos);
}

function setEstela(estela, puntos) {
  estela[0].setLatLngs(puntos);
  const n = puntos.length;
  estela[1].setLatLngs(n ? puntos.slice(Math.floor(n * 0.5)) : []);
  estela[2].setLatLngs(n ? puntos.slice(-2) : []);
}

function easeOutCubic(p) {
  return 1 - Math.pow(1 - p, 3);
}

function prefersReducedMotion() {
  return window.matchMedia?.('(prefers-reduced-motion: reduce)').matches || false;
}

// ---------- Geometría ----------

/** Interpolación en gran círculo entre dos puntos (lat/lng), t ∈ [0,1]. */
function interpolateGreatCircle(lat1, lng1, lat2, lng2, t) {
  const toRad = (d) => (d * Math.PI) / 180;
  const toDeg = (r) => (r * 180) / Math.PI;
  const f1 = toRad(lat1), l1 = toRad(lng1);
  const f2 = toRad(lat2), l2 = toRad(lng2);
  const sinD = Math.sqrt(
    Math.sin((f2 - f1) / 2) ** 2 +
    Math.cos(f1) * Math.cos(f2) * Math.sin((l2 - l1) / 2) ** 2
  );
  const d = 2 * Math.asin(sinD);
  if (d === 0) return [lat2, lng2];
  const A = Math.sin((1 - t) * d) / Math.sin(d);
  const B = Math.sin(t * d) / Math.sin(d);
  const x = A * Math.cos(f1) * Math.cos(l1) + B * Math.cos(f2) * Math.cos(l2);
  const y = A * Math.cos(f1) * Math.sin(l1) + B * Math.cos(f2) * Math.sin(l2);
  const z = A * Math.sin(f1) + B * Math.sin(f2);
  return [toDeg(Math.atan2(z, Math.sqrt(x * x + y * y))), toDeg(Math.atan2(y, x))];
}

function bearingTo(lat1, lng1, lat2, lng2) {
  const toRad = (d) => (d * Math.PI) / 180;
  const toDeg = (r) => (r * 180) / Math.PI;
  const y = Math.sin(toRad(lng2 - lng1)) * Math.cos(toRad(lat2));
  const x = Math.cos(toRad(lat1)) * Math.sin(toRad(lat2)) -
    Math.sin(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.cos(toRad(lng2 - lng1));
  return (toDeg(Math.atan2(y, x)) + 360) % 360;
}

/** Punto a APROX_RADIO_KM del destino en un rumbo estable derivado del shotId. */
function puntoAproximacion(destino, shotId) {
  const rumbo = (hashString(shotId) % 360 + 360) % 360;
  return pointAtBearing(destino[0], destino[1], rumbo, APROX_RADIO_KM);
}

function pointAtBearing(lat, lng, bearingDeg, distKm) {
  const toRad = (d) => (d * Math.PI) / 180;
  const toDeg = (r) => (r * 180) / Math.PI;
  const R = 6371;
  const br = toRad(bearingDeg);
  const f1 = toRad(lat), l1 = toRad(lng);
  const f2 = Math.asin(
    Math.sin(f1) * Math.cos(distKm / R) + Math.cos(f1) * Math.sin(distKm / R) * Math.cos(br)
  );
  const l2 = l1 + Math.atan2(
    Math.sin(br) * Math.sin(distKm / R) * Math.cos(f1),
    Math.cos(distKm / R) - Math.sin(f1) * Math.sin(f2)
  );
  return [toDeg(f2), ((toDeg(l2) + 540) % 360) - 180];
}

function hashString(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return h;
}
