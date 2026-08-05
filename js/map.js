// map.js — el mapa NUNCA renderiza marcadores de otros jugadores reales.
// Solo se dibujan: tu propio marcador, los bots (no son personas) y los
// disparos. Los disparos se animan en tiempo real estilo flyscanner:
//   - Disparos propios: trayectoria completa real (origen = tu posición).
//   - Disparos ajenos: se anima la LLEGADA convergiendo al destino desde el
//     perímetro, sin inventar ni revelar el origen del jugador que dispara.

import { SPLASH_RADIUS_KM } from './config.js';
import { formatMMSS, haversineKm } from './physics.js';

let map;
let miMarcador = null;
let rendererBots = null; // canvas dedicado: miles de bots sin miles de nodos SVG
const botsDatos = new Map();     // botId -> { lat, lng, city } (todos los bots activos)
const marcadoresBots = new Map(); // botId -> L.CircleMarker (solo los visibles en el viewport)
let botsPendientes = null;
let botsTimer = null;
const animaciones = new Map();    // shotId -> animación del disparo

let rafId = null;
let seguirShotId = null; // disparo en vuelo al que la vista sigue (tras clic en actividad)

// ---------- Parámetros de la animación ----------
const TRAIL_MAX_POINTS = 60;  // longitud máxima de la estela (puntos)
const TRAIL_GAP_MS = 140;     // cada cuánto se añade un punto a la estela
const APROX_RADIO_KM = 150;   // distancia del punto sintético de llegada de disparos ajenos
const RUTA_MAX_KM = 200;      // longitud máxima del tramo discontinuo que apunta al impacto
const MAX_ENEMIGOS_ANIMADOS = 12; // tope de disparos ajenos no-amenaza animados a la vez
let enemigosAnimados = 0;

const COLOR_PROPIO = '#F2A93B';
const COLOR_ENEMIGO = '#FF6B6B';
const COLOR_PREVIEW = '#8AD8FF';
const COLOR_CONTRA = '#4FC3F7';      // celeste: disparo protegido con contramedida (la lanzaste tú)
const COLOR_CONTRA_RECIBIDA = '#9C6ADE'; // violeta: disparo TUYO que está siendo contrarrestado

export function inicializarMapa(lat, lng) {
  // Una sola copia del mundo: sin worldCopyJump (evita que se repita al pane/zoom)
  // y con límites máximos que impiden salirse de una única vuelta del planeta.
  map = L.map('map', {
    zoomControl: true,
    worldCopyJump: false,
    minZoom: 1,
    maxBounds: [[-85.06, -180], [85.06, 180]],
    maxBoundsViscosity: 1.0,
  }).setView([lat, lng], 6);

  // Renderer canvas exclusivo para los bots: soporta miles de marcadores sin
  // abrumar el DOM, y su repintado está aislado de la animación de disparos.
  rendererBots = L.canvas({ padding: 0.5 });

  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '&copy; OpenStreetMap contributors',
    maxZoom: 18,
    noWrap: true, // una única copia del mundo, sin repetición lateral al alejar
  }).addTo(map);

  // Cualquier interacción del usuario con el mapa anula el seguimiento de la vista.
  map.on('dragstart', detenerSeguimiento);
  map.on('zoomstart', detenerSeguimiento);
  map.getContainer().addEventListener('mousedown', detenerSeguimiento, true);

  // Al mover/alejar el mapa se refresca el culling de bots visibles.
  map.on('moveend', programarFlushBots);
  map.on('zoomend', programarFlushBots);

  return map;
}

function programarFlushBots() {
  if (botsTimer) return;
  botsTimer = setTimeout(() => {
    botsTimer = null;
    procesarBots();
  }, 1000);
}

function detenerSeguimiento() {
  seguirShotId = null;
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
  botsPendientes = bots || {};
  programarFlushBots();
}

function procesarBots() {
  const datos = botsPendientes;
  botsPendientes = null;

  // 1) Sincroniza el inventario de bots activos con la última foto (si la hay).
  if (datos) {
    for (const [botId, bot] of Object.entries(datos)) {
      if (bot.status === 'down') continue;
      const prev = botsDatos.get(botId);
      if (!prev) {
        botsDatos.set(botId, { lat: bot.lat, lng: bot.lng, city: bot.zoneCity || '?' });
      } else {
        prev.lat = bot.lat;
        prev.lng = bot.lng;
        prev.city = bot.zoneCity || prev.city;
      }
    }
    for (const botId of [...botsDatos.keys()]) {
      const bot = datos[botId];
      if (!bot || bot.status === 'down') {
        const m = marcadoresBots.get(botId);
        if (m) { map.removeLayer(m); marcadoresBots.delete(botId); }
        botsDatos.delete(botId);
      }
    }
  }

  // 2) Culling por viewport: solo se dibujan los bots dentro de los límites (+margen).
  const bounds = map.getBounds().pad(0.5);
  for (const [botId, d] of botsDatos) {
    if (!bounds.contains([d.lat, d.lng])) continue;
    let marker = marcadoresBots.get(botId);
    if (!marker) {
      const opts = { radius: 5, color: '#7C8AA5', fillColor: '#7C8AA5', fillOpacity: 0.8, weight: 1 };
      if (rendererBots) opts.renderer = rendererBots;
      marker = L.circleMarker([d.lat, d.lng], opts).addTo(map).bindTooltip(`Bot · ${d.city}`);
      marcadoresBots.set(botId, marker);
    } else if (marker._latlng.lat !== d.lat || marker._latlng.lng !== d.lng) {
      marker.setLatLng([d.lat, d.lng]);
    }
  }

  // 3) Quita marcadores que quedaron fuera del viewport o ya no existen.
  for (const [botId, marker] of [...marcadoresBots.entries()]) {
    const d = botsDatos.get(botId);
    if (!d || !bounds.contains([d.lat, d.lng])) {
      map.removeLayer(marker);
      marcadoresBots.delete(botId);
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
    if (a.estado === 'vuelo' && !a.estatico && !prefersReducedMotion()) arrancarBucle();
    return;
  }

  // Disparo estático (sobre cupo de animados) que se resuelve: se cierra en seco.
  if (a.estatico && shot.resolved && a.estado !== 'impactado') {
    a.estado = 'impactado';
    a.circulo.setStyle({ color: colorDe(a), weight: 2, dashArray: null, fillOpacity: 0.12, opacity: 1 });
    if (a.ruta) { map.removeLayer(a.ruta); a.ruta = null; }
  }

  // El bucle de animación detecta la transición a resolved y dispara la explosión.
  a.shot = shot;
  const vuelveAmenaza = amenaza && !shot.resolved;
  a.amenaza = vuelveAmenaza;
  if (vuelveAmenaza && a.tier !== 'full') promocionarADetallado(a);
  a.marcador?.getElement()?.classList.toggle('amenaza', a.amenaza);
}
export function listaDisparos() {
  return [...animaciones.keys()];
}

export function limpiarDisparo(shotId) {
  const a = animaciones.get(shotId);
  if (!a) return;
  if (seguirShotId === shotId) seguirShotId = null;
  if (a.cuentaCupo) enemigosAnimados = Math.max(0, enemigosAnimados - 1);
  quitarCapasAnimacion(a);
  for (const key of ['circulo', 'impactMarker']) {
    if (a[key]) { map.removeLayer(a[key]); a[key] = null; }
  }
  animaciones.delete(shotId);
  if (animaciones.size === 0 && rafId) { cancelAnimationFrame(rafId); rafId = null; }
}

/** Refresca las etiquetas ETA de todos los disparos en vuelo. Se llama cada segundo desde main.js. */
export function actualizarETAs() {
  const ahora = Date.now();
  for (const a of animaciones.values()) {
    if (a.estado !== 'vuelo' || !a.etaEl) continue;
    a.etaEl.textContent = formatMMSS(Math.max(0, a.shot.impactAt - ahora));
  }
}

/** Cambia el color del disparo: contramedida desplegada por ti (protección) → celeste. */
export function marcarContramedida(shotId) {
  const a = animaciones.get(shotId);
  if (!a) return;
  a.contramedida = true;
  aplicarColor(a, COLOR_CONTRA, 'contramedida');
}

/** Cambia el color del disparo: disparo TUYO que está siendo contrarrestado → violeta. */
export function marcarContracada(shotId) {
  const a = animaciones.get(shotId);
  if (!a) return;
  a.contracada = true;
  aplicarColor(a, COLOR_CONTRA_RECIBIDA, 'contracada');
}

function aplicarColor(a, color, cls) {
  const el = a.marcador?.getElement();
  if (el) {
    el.classList.remove('contramedida', 'contracada');
    el.classList.add(cls);
  }
  a.impactMarker?.getElement()?.style?.setProperty('color', color);
  for (const p of a.estela) p?.setStyle({ color });
  if (a.ruta) a.ruta.setStyle({ color });
  if (a.circulo) a.circulo.setStyle({ color });
  a.ping?.getElement()?.querySelector('.radar-ping-ring')?.style?.setProperty('border-color', color);
}

// ---------- Enfocar un evento de actividad en el mapa ----------

/** Centra el mapa en un evento del panel de actividad y lo resalta, conservando el zoom. */
export function enfocarLugar(lugar) {
  if (!lugar || !map || typeof lugar.lat !== 'number' || typeof lugar.lng !== 'number') return;
  const a = lugar.shotId ? animaciones.get(lugar.shotId) : null;

  if (a && a.estado === 'vuelo' && !a.estatico) {
    // Disparo en curso: se lleva la vista a su posición actual y se le sigue.
    const pos = interpolar(a, progreso(a));
    map.panTo(pos, { animate: true });
    resaltarMisil(a);
    seguirShotId = a.shotId;
    return;
  }

  // Impacto (realizado o recibido): centro en el destino conservando el zoom.
  map.panTo([lugar.lat, lugar.lng], { animate: true });
  seguirShotId = null;
  resaltarPunto(lugar.lat, lugar.lng, a ? colorDe(a) : COLOR_PROPIO);
}

function resaltarMisil(a) {
  a.marcador?.getElement()?.classList.add('resaltado');
  a.circulo?.setStyle({ opacity: 1, dashArray: null, fillOpacity: 0.15, color: colorDe(a) });
  setTimeout(() => {
    a.marcador?.getElement()?.classList.remove('resaltado');
    if (a.estado === 'vuelo') a.circulo?.setStyle({ opacity: 0.06, color: colorDe(a) });
  }, 3500);
}

function resaltarPunto(lat, lng, color) {
  const ring = L.circle([lat, lng], {
    radius: SPLASH_RADIUS_KM * 1000, color, weight: 2.5, dashArray: null,
    fillOpacity: 0.1, interactive: false,
  }).addTo(map);
  const center = L.marker([lat, lng], {
    icon: L.divIcon({ className: 'impact-x-icon', html: '✕', iconSize: [14, 14] }),
    interactive: false, keyboard: false,
  }).addTo(map);
  center.getElement().style.color = color;
  setTimeout(() => {
    map.removeLayer(ring);
    map.removeLayer(center);
  }, 4000);
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

/** Sube un disparo reduced/static a detallado cuando pasa a ser una amenaza. */
function promocionarADetallado(a) {
  const pos = interpolar(a, progreso(a));

  // Si era estático, no tenía misil: hay que crearlo (y su wrap para rotar).
  if (!a.marcador) {
    a.marcador = L.marker(pos, {
      icon: L.divIcon({
        className: 'missile-icon enemy',
        html: '<div class="missile-wrap"><svg viewBox="0 0 24 24" class="missile-svg"><path d="M12 2 L21 22 L12 17.5 L3 22 Z"/></svg></div>',
        iconSize: [20, 20], iconAnchor: [10, 10],
      }),
      interactive: false, keyboard: false,
    }).addTo(map);
    a.wrap = a.marcador.getElement().querySelector('.missile-wrap');
    a.estatico = false;
  }

  if (!a.etaMarker) {
    a.etaMarker = L.marker(pos, {
      icon: L.divIcon({
        className: 'eta-label-wrap',
        html: '<span class="eta-label mono">--:--</span>',
        iconSize: [0, 0],
      }),
      interactive: false, keyboard: false,
    }).addTo(map);
    a.etaEl = a.etaMarker.getElement().querySelector('.eta-label');
  }

  if (!a.ping) {
    a.ping = L.marker(a.destino, {
      icon: L.divIcon({
        className: 'radar-ping',
        html: `<div class="radar-ping-ring" style="border-color:${a.color}"></div>`,
        iconSize: [0, 0],
      }),
      interactive: false, keyboard: false,
    }).addTo(map);
  }

  // Si venía reducido (un solo trazo de estela), expande a tres conservando puntos.
  if (a.estela.length < 3) {
    const puntos = a.puntos;
    a.estela = [
      L.polyline([], { color: a.color, weight: 2, opacity: 0.35, dashArray: '1 7' }).addTo(map),
      L.polyline([], { color: a.color, weight: 2.5, opacity: 0.7, dashArray: '1 7' }).addTo(map),
      L.polyline([], { color: a.color, weight: 3.5, opacity: 1, dashArray: '1 7' }).addTo(map),
    ];
    setEstela(a.estela, puntos);
  }

  if (a.cuentaCupo) {
    a.cuentaCupo = false;
    enemigosAnimados = Math.max(0, enemigosAnimados - 1);
  }

  a.tier = 'full';
  a.marcador?.getElement()?.classList.toggle('amenaza', true);
  if (!prefersReducedMotion()) arrancarBucle();
}

function crearAnimacion(shotId, shot, origen, amenaza) {
  const esPreview = shotId === 'preview';
  const esEnemigo = !origen && !esPreview;
  // Niveles de detalle para no saturar la visualización con muchos disparos:
  //   full    -> propios, amenazas y preview: animación completa con ETA y ping.
  //   reduced -> ajenos no-amenaza (cupo limitado): animados pero sin ETA ni ping.
  //   static  -> ajenos no-amenaza sobre el cupo: solo línea + círculo, sin frame.
  const detallado = esPreview || !esEnemigo || amenaza;
  const reducido = !detallado && enemigosAnimados < MAX_ENEMIGOS_ANIMADOS;
  const estatico = !detallado && !reducido;
  const cuentaCupo = reducido && !shot.resolved;
  if (cuentaCupo) enemigosAnimados++;

  const destino = [shot.destLat, shot.destLng];
  const origenDef = origen ? [origen.lat, origen.lng] : puntoAproximacion(destino, shotId);
  const color = esPreview ? COLOR_PREVIEW : esEnemigo ? COLOR_ENEMIGO : COLOR_PROPIO;

  const marcador = estatico
    ? null
    : L.marker(origenDef, {
        icon: L.divIcon({
          className: `missile-icon${esEnemigo ? ' enemy' : ''}${esPreview ? ' preview' : ''}`,
          html: '<div class="missile-wrap"><svg viewBox="0 0 24 24" class="missile-svg"><path d="M12 2 L21 22 L12 17.5 L3 22 Z"/></svg></div>',
          iconSize: [20, 20], iconAnchor: [10, 10],
        }),
        interactive: false, keyboard: false,
      }).addTo(map);
  const wrap = marcador?.getElement()?.querySelector('.missile-wrap');

  const etaMarker = detallado
    ? L.marker(origenDef, {
        icon: L.divIcon({
          className: 'eta-label-wrap',
          html: '<span class="eta-label mono">--:--</span>',
          iconSize: [0, 0],
        }),
        interactive: false, keyboard: false,
      }).addTo(map)
    : null;
  const etaEl = etaMarker?.getElement()?.querySelector('.eta-label');

  const estela = [];
  if (detallado) {
    estela.push(L.polyline([], { color, weight: 2, opacity: 0.35, dashArray: '1 7' }).addTo(map));
    estela.push(L.polyline([], { color, weight: 2.5, opacity: 0.7, dashArray: '1 7' }).addTo(map));
    estela.push(L.polyline([], { color, weight: 3.5, opacity: 1, dashArray: '1 7' }).addTo(map));
  } else if (reducido) {
    estela.push(L.polyline([], { color, weight: 2.5, opacity: 0.7, dashArray: '1 7' }).addTo(map));
  }

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

  const ping = detallado
    ? L.marker(destino, {
        icon: L.divIcon({
          className: 'radar-ping',
          html: `<div class="radar-ping-ring" style="border-color:${color}"></div>`,
          iconSize: [0, 0],
        }),
        interactive: false, keyboard: false,
      }).addTo(map)
    : null;

  const a = {
    shotId, shot, destino,
    origenLat: origenDef[0], origenLng: origenDef[1],
    marcador, wrap, etaMarker, etaEl, estela, ruta, circulo, impactMarker, ping,
    puntos: [], ultimoPuntoAt: 0, ultimaPos: null, color,
    estado: shot.resolved ? 'impactado' : 'vuelo',
    amenaza: amenaza && !shot.resolved,
    recortarRuta: esEnemigo,
    contramedida: false,
    tier: detallado ? 'full' : reducido ? 'reduced' : 'static',
    estatico,
    cuentaCupo,
  };

  if (a.estado === 'impactado') {
    // El disparo ya estaba resuelto cuando este cliente lo vio: solo residuo, sin explosión.
    a.circulo.setStyle({ color, weight: 2, dashArray: null, fillOpacity: 0.12, opacity: 1 });
    quitarCapasAnimacion(a);
  } else if (prefersReducedMotion()) {
    if (a.marcador) {
      const t = progreso(a);
      const pos = interpolar(a, t);
      a.marcador.setLatLng(pos);
      if (a.etaMarker) a.etaMarker.setLatLng(pos);
      if (a.etaEl) a.etaEl.textContent = formatMMSS(Math.max(0, a.shot.impactAt - Date.now()));
      actualizarRuta(a, pos);
    }
  } else {
    a.marcador?.getElement()?.classList.toggle('amenaza', a.amenaza);
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
      if (a.estado !== 'vuelo' || a.estatico) continue;
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
    if (seguirShotId === a.shotId) {
      seguirShotId = null;
      map.panTo(a.destino, { animate: true });
    }
    dispararExplosion(a);
    return;
  }
  if (a.estado !== 'vuelo') return;

  const t = progreso(a);
  const pos = interpolar(a, t);
  if (a.marcador) a.marcador.setLatLng(pos);
  if (a.etaMarker) a.etaMarker.setLatLng(pos);
  rotarMarcador(a, pos);
  actualizarRuta(a, pos);
  añadirPuntoEstela(a, pos);
  if (seguirShotId === a.shotId && a.estado === 'vuelo') map.panTo(pos, { animate: false });
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

    let ring = L.circle([dlat, dlng], { radius: 0, color: colorDe(a), weight: 2.5, opacity: 0.9 });
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
  a.circulo.setStyle({ color: colorDe(a), weight: 2, dashArray: null, fillOpacity: 0.12, opacity: 1 });
  quitarCapasAnimacion(a);
}

function colorDe(a) {
  if (a.contracada) return COLOR_CONTRA_RECIBIDA;
  if (a.contramedida) return COLOR_CONTRA;
  return a.color;
}

function interpolar(a, t) {
  return interpolateGreatCircle(a.origenLat, a.origenLng, a.destino[0], a.destino[1], t);
}

/** El tramo discontinuo arranca en la posición actual y apunta al impacto, con longitud máxima fija. */
function actualizarRuta(a, pos) {
  if (!a.ruta || !a.recortarRuta) return;
  const restante = haversineKm(pos[0], pos[1], a.destino[0], a.destino[1]);
  const limite = restante <= RUTA_MAX_KM
    ? a.destino
    : pointAtBearing(pos[0], pos[1], bearingTo(pos[0], pos[1], a.destino[0], a.destino[1]), RUTA_MAX_KM);
  a.ruta.setLatLngs([pos, limite]);
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
  if (!estela[0]) return;
  estela[0].setLatLngs(puntos);
  const n = puntos.length;
  if (estela[1]) estela[1].setLatLngs(n ? puntos.slice(Math.floor(n * 0.5)) : []);
  if (estela[2]) estela[2].setLatLngs(n ? puntos.slice(-2) : []);
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
