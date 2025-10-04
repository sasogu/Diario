## Ver la versión del Service Worker

1. Abre DevTools (`F12` o `Ctrl+Shift+I`).
2. Ve a la pestaña **Application** → **Service Workers**.
3. Pulsa **Update** o ejecuta en la consola `navigator.serviceWorker.getRegistration().then(r => r.update())`.
4. En la consola aparecerán las líneas `[ServiceWorker] install v16.1.1` y `[ServiceWorker] activate v16.1.1` si se registró la nueva versión.
