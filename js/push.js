// push.js — notificaciones reales (funcionan con el navegador cerrado).
// Si el permiso se deniega o el navegador no soporta Push, el juego sigue
// funcionando con el aviso local (banner + sonido) definido en ui.js.

import { VAPID_PUBLIC_KEY } from './config.js';
import { guardarPushSubscription } from './realtime.js';

export async function activarNotificaciones(playerId) {
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
    return { soportado: false };
  }

  const permiso = await Notification.requestPermission();
  if (permiso !== 'granted') return { soportado: true, permitido: false };

  const registration = await navigator.serviceWorker.register('/sw.js');
  const subscription = await registration.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC_KEY),
  });

  await guardarPushSubscription(playerId, subscription.toJSON());
  return { soportado: true, permitido: true };
}

function urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const rawData = atob(base64);
  return Uint8Array.from([...rawData].map((c) => c.charCodeAt(0)));
}

/** Sonido de aviso corto para el fallback en pestaña abierta (WebAudio, sin archivos externos). */
export function reproducirSonidoAviso() {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(880, ctx.currentTime);
    gain.gain.setValueAtTime(0.15, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.4);
    osc.connect(gain).connect(ctx.destination);
    osc.start();
    osc.stop(ctx.currentTime + 0.4);
  } catch {
    /* no crítico si el navegador bloquea audio sin interacción previa */
  }
}
