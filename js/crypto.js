// crypto.js — cifra tu ubicación con la clave PÚBLICA del Worker antes de
// que salga de este dispositivo. Nadie más que el Worker (con su clave
// privada, guardada solo como secret de Cloudflare) puede leerla.
//
// También cifra la copia que se cachea en localStorage con una clave
// simétrica local (Web Crypto AES-GCM) para que ni siquiera un script que
// lea localStorage directamente vea coordenadas en claro.

import nacl from 'https://cdn.jsdelivr.net/npm/tweetnacl@1.0.3/+esm';
import naclUtil from 'https://cdn.jsdelivr.net/npm/tweetnacl-util@0.15.1/+esm';
import { LOCATION_PUBLIC_KEY_B64 } from './config.js';

const { decodeBase64, encodeBase64 } = naclUtil;

/**
 * Cifra {lat, lng} contra la clave pública del Worker.
 * Genera un par de claves efímero nuevo en cada llamada — nunca reutiliza
 * una clave "propia" persistente, así que no hay nada que identifique al
 * dispositivo más allá de este único mensaje cifrado.
 */
export function cifrarUbicacion(lat, lng) {
  const workerPublicKey = decodeBase64(LOCATION_PUBLIC_KEY_B64);
  const ephemeralKeyPair = nacl.box.keyPair();
  const nonce = nacl.randomBytes(nacl.box.nonceLength);
  const mensaje = new TextEncoder().encode(JSON.stringify({ lat, lng }));
  const ciphertext = nacl.box(mensaje, nonce, workerPublicKey, ephemeralKeyPair.secretKey);

  return {
    ciphertext: encodeBase64(ciphertext),
    nonce: encodeBase64(nonce),
    senderPublicKey: encodeBase64(ephemeralKeyPair.publicKey),
  };
}

// ---------------------------------------------------------------
// Caché local cifrada (AES-GCM, clave simétrica generada en el propio
// dispositivo y guardada en IndexedDB) — evita pedir permiso de
// geolocalización en cada recarga, sin guardar nunca coordenadas en claro.
// ---------------------------------------------------------------

const DB_NAME = 'geostrike-keys';
const STORE_NAME = 'keys';
const KEY_ID = 'local-cache-key';
const CACHE_KEY = 'geostrike:last-location-enc';

function abrirIndexedDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE_NAME);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function obtenerOCrearClaveLocal() {
  const db = await abrirIndexedDB();
  const existente = await new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly');
    const req = tx.objectStore(STORE_NAME).get(KEY_ID);
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => reject(req.error);
  });
  if (existente) return existente;

  const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']);
  await new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    tx.objectStore(STORE_NAME).put(key, KEY_ID);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
  return key;
}

/** Guarda {lat,lng} en localStorage, cifrado con una clave local (nunca en claro). */
export async function cachearUbicacionLocal(lat, lng) {
  try {
    const key = await obtenerOCrearClaveLocal();
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const data = new TextEncoder().encode(JSON.stringify({ lat, lng }));
    const cifrado = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, data);
    localStorage.setItem(
      CACHE_KEY,
      JSON.stringify({ iv: Array.from(iv), data: Array.from(new Uint8Array(cifrado)) })
    );
  } catch (err) {
    console.warn('No se pudo cachear la ubicación localmente (no crítico):', err);
  }
}

/** Recupera la última ubicación cacheada, o null si no hay/está corrupta. */
export async function leerUbicacionCacheada() {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    if (!raw) return null;
    const { iv, data } = JSON.parse(raw);
    const key = await obtenerOCrearClaveLocal();
    const plano = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: new Uint8Array(iv) },
      key,
      new Uint8Array(data)
    );
    return JSON.parse(new TextDecoder().decode(plano));
  } catch {
    return null;
  }
}
