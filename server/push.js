import webpush from "web-push";

let ready = false;

export function initPush({ publicKey, privateKey, subject }) {
  if (!publicKey || !privateKey) return false;
  webpush.setVapidDetails(
    subject || "mailto:hello@sexychat.fun",
    publicKey,
    privateKey,
  );
  ready = true;
  return true;
}

export function isPushReady() {
  return ready;
}

export function getPublicKey() {
  return process.env.VAPID_PUBLIC_KEY || null;
}

export async function sendPush(sub, payload) {
  if (!ready) return;
  await webpush.sendNotification(
    {
      endpoint: sub.endpoint,
      keys: { p256dh: sub.p256dh, auth: sub.auth },
    },
    JSON.stringify(payload),
  );
}
