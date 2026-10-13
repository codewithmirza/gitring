/*
 * The service worker of gitring: push notifications for the inbox (src/worker/push.ts).
 *
 * A push from gitring has no content. When one comes, this worker reads the inbox of the person (GET
 * /api/me/inbox, with the cookie of the browser) and shows one notification: how many things wait, and the
 * newest one. A tap opens /inbox. The worker keeps no data and does not change any request of the app.
 */
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

/** The words of the notification for the items of the inbox (newest last). */
function notificationOf(items) {
  const n = Array.isArray(items) ? items.length : 0;
  if (!n) return { title: "gitring", body: "Open the inbox to see what waits for you." };
  const last = items[n - 1];
  return {
    title: n === 1 ? "1 thing waits for you in gitring" : `${n} things wait for you in gitring`,
    body: `${last.headline}: ${last.title}${last.projectName ? ` (${last.projectName})` : ""}`,
  };
}

self.addEventListener("push", (event) => {
  event.waitUntil(
    (async () => {
      let items = null;
      try {
        const res = await fetch("/api/me/inbox", { credentials: "same-origin", headers: { accept: "application/json" } });
        if (res.ok) items = (await res.json()).items;
      } catch {
        /* no network: the notification says to open the inbox */
      }
      const words = notificationOf(items);
      await self.registration.showNotification(words.title, { body: words.body, tag: "gitring-inbox", renotify: true, icon: "/icon.svg", data: { url: "/inbox" } });
    })(),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || "/inbox";
  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      for (const w of windows) {
        if (new URL(w.url).origin !== self.location.origin) continue;
        await w.focus();
        if ("navigate" in w) await w.navigate(url);
        return;
      }
      await self.clients.openWindow(url);
    })(),
  );
});
