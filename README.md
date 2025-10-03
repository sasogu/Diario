# Diario PWA

Proyecto PWA minimal para llevar un diario cifrado localmente.

### Características
- Acceso protegido por contraseña (PBKDF2 + AES-GCM) con verificación y compatibilidad con versiones anteriores.
- Entradas y fotos almacenadas cifradas en IndexedDB.
- Exportación local a JSON y sincronización opcional con Dropbox.
- Service Worker con caché dinámico y soporte offline.
- UI responsive con bloqueo manual de sesión.

### Uso rápido
1. Servir la carpeta (por ejemplo `python -m http.server`).
2. Crea una contraseña (botón "Crear/Reset contraseña").
3. Añade entradas y adjunta fotos si lo deseas.
4. Usa "Sincronizar backup" para descargar un JSON cifrado y, si está conectado, subirlo a Dropbox.

### Sincronización con Dropbox
1. Crea una app en [Dropbox App Console](https://www.dropbox.com/developers/apps) con permisos `files.content.write` y `account_info.read`.
2. Añade la URL donde sirves la PWA (p.ej. `http://localhost:8000/` o tu dominio) como Redirect URI.
3. Copia el **App Key** de Dropbox en la sección "Dropbox" de la app y pulsa "Conectar" para autorizar (flujo OAuth 2 PKCE).
4. Tras autorizar, cada backup se descarga localmente y se sube a `/Diario/diario-backup-YYYY-MM-DD.json` en tu Dropbox.
5. Usa "Desconectar" para olvidar los tokens almacenados en este navegador.

### Privacidad y seguridad
- La clave se deriva localmente; solo se guarda un verificador cifrado en `localStorage`.
- Las entradas y fotos permanecen cifradas incluso en la exportación.
- Los tokens de Dropbox se guardan localmente para reusar la sesión. Usa "Desconectar" si compartes el equipo.
- El botón "Bloquear" limpia la clave de la sesión actual.

### Próximos pasos sugeridos
- Añadir caducidad de sesión o bloqueo automático tras inactividad.
- Implementar importación del backup JSON (local y desde Dropbox).
- Sincronizar automáticamente al guardar sin necesidad de descargar manualmente.
