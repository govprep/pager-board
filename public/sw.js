// BelterHub service worker — handles incoming web push for the installed PWA.
// Registered from components/EnableAlerts.tsx. Kept dependency-free so it can be
// served as a plain static file from /sw.js (root scope, required for push).

// Activate immediately on update instead of waiting for all tabs to close.
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

// The feeder sends a JSON payload: { title, body, url, tag }.
self.addEventListener("push", (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = { title: "Incident", body: event.data ? event.data.text() : "" };
  }

  const title = data.title || "🚨 Incident";
  const options = {
    body: data.body || "",
    tag: data.tag,            // same tag collapses repeat pages of one incident
    renotify: true,
    data: { url: data.url || "/" },
    icon: "/logo.jpg",
    badge: "/logo.jpg",
  };

  event.waitUntil(self.registration.showNotification(title, options));
});

// Tapping the notification opens the incident's card: it focuses an already-open
// board tab (messaging it the incident number so it pops the card without a
// reload), or opens a new tab at the ?incident= deep link.
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || "/";

  let incidentNo = "";
  try {
    incidentNo = new URL(url, self.location.origin).searchParams.get("incident") || "";
  } catch {
    /* keep incidentNo empty */
  }

  event.waitUntil(
    self.clients
      .matchAll({ type: "window", includeUncontrolled: true })
      .then((clients) => {
        for (const client of clients) {
          if ("focus" in client) {
            if (incidentNo) client.postMessage({ type: "open-incident", incidentNo });
            return client.focus();
          }
        }
        if (self.clients.openWindow) return self.clients.openWindow(url);
      }),
  );
});
