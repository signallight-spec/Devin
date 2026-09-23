self.addEventListener("push", (event) => {
  let message = {};
  try {
    message = event.data ? JSON.parse(event.data.text()) : {};
  } catch {
    message = {};
  }
  event.waitUntil(
    self.registration.showNotification(
      message.title || "まいにち学習スタンプ",
      {
        body: message.body || "今日の学習を始めよう。",
        icon: "/pwa-192x192.png",
        badge: "/pwa-64x64.png",
        data: { url: message.url || "/" },
        tag: "daily-study-reminder"
      }
    )
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const targetUrl = new URL(event.notification.data?.url || "/", self.location.origin)
    .href;
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true })
      .then((clients) => {
        const existing = clients.find((client) => client.url === targetUrl);
        if (existing) {
          return existing.focus();
        }
        return self.clients.openWindow(targetUrl);
      })
  );
});
