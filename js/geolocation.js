// geolocation.js — obtiene tu posición real. Nunca la persiste en claro
// en ningún sitio remoto; solo vive en memoria hasta que crypto.js la cifra.

/**
 * @returns {Promise<{lat:number,lng:number,manual:boolean}>}
 */
export function obtenerUbicacion() {
  return new Promise((resolve) => {
    if (!('geolocation' in navigator)) {
      resolve(null); // el llamador debe activar el modo de selección manual
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (pos) => resolve({ lat: pos.coords.latitude, lng: pos.coords.longitude, manual: false }),
      () => resolve(null), // permiso denegado u otro error → fallback manual
      { enableHighAccuracy: false, timeout: 8000, maximumAge: 60_000 }
    );
  });
}

/**
 * Fallback: deja que el jugador elija su propia ubicación con un clic en el mapa.
 * Devuelve una promesa que se resuelve con el primer clic.
 */
export function seleccionarUbicacionManual(map, L) {
  return new Promise((resolve) => {
    const aviso = document.getElementById('manual-location-banner');
    if (aviso) aviso.classList.remove('hidden');

    function onClick(e) {
      map.off('click', onClick);
      if (aviso) aviso.classList.add('hidden');
      resolve({ lat: e.latlng.lat, lng: e.latlng.lng, manual: true });
    }
    map.on('click', onClick);
  });
}
