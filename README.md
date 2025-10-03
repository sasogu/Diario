# Diario PWA

Proyecto PWA minimal para llevar un diario cifrado localmente.

### Características
- Acceso protegido por contraseña (PBKDF2 + AES-GCM) con verificación y compatibilidad con versiones anteriores.
- Entradas y fotos almacenadas cifradas en IndexedDB.
- Exportación local a JSON, sincronización automática con Dropbox e importación directa (comparar, fusionar o reemplazar) desde Dropbox.
- Al abrir la app se detecta automáticamente si hay un backup más reciente en Dropbox y se ofrece fusionar/reemplazar los cambios.
- Bloqueo automático tras 5 minutos sin interacción y botón de recuperación desde Dropbox directamente en la pantalla de bloqueo.
- Historial de backups en Dropbox con selección de versión y sincronización automática tras restaurar.
- Service Worker con caché dinámico y soporte offline.
- UI responsive con bloqueo manual de sesión.

### Uso rápido
1. Servir la carpeta (por ejemplo `python -m http.server`).
2. Crea una contraseña (botón "Crear/Reset contraseña").
3. Añade entradas y adjunta fotos si lo deseas.
4. Si conectas Dropbox, cada guardado sube el backup automáticamente. Usa "Descargar backup" cuando quieras una copia local.
5. Usa "Importar backup" (Dropbox) para restaurar el backup más reciente en otro dispositivo (sobrescribe las entradas locales).

### Sincronización con Dropbox
1. Crea una app en [Dropbox App Console](https://www.dropbox.com/developers/apps) con permisos `files.content.write` y `account_info.read`.
2. Añade la URL donde sirves la PWA (p.ej. `http://localhost:8000/` o tu dominio) como Redirect URI.
3. Copia el **App Key** de Dropbox en la sección "Dropbox" de la app y pulsa "Conectar" para autorizar (flujo OAuth 2 PKCE).
4. Tras autorizar, cada guardado genera y sube automáticamente `/Diario/diario-backup-YYYY-MM-DD.json` a tu Dropbox; el botón "Descargar backup" queda como copia manual.
5. Pulsa "Importar backup" para elegir entre las versiones disponibles en Dropbox, comparar diferencias y decidir si "Fusionar" (añade las entradas nuevas y conserva las existentes) o "Reemplazar" (sobrescribe todo y sincroniza de nuevo). Al importar en un dispositivo nuevo se sincroniza la clave derivada de la contraseña, de modo que todas las copias usan el mismo cifrado.
6. Usa "Desconectar" para olvidar los tokens almacenados en este navegador.

### Privacidad y seguridad
- La clave se deriva localmente; solo se guarda un verificador cifrado en `localStorage`.
- Las entradas y fotos permanecen cifradas incluso en la exportación.
- Los tokens de Dropbox se guardan localmente para reusar la sesión. Usa "Desconectar" si compartes el equipo.
- El botón "Bloquear" limpia la clave de la sesión actual.

### Próximos pasos sugeridos
- Añadir posibilidad establecer tiempo de caducidad de sesión o bloqueo automático tras inactividad. Ahora 5 minutos.
- Añadir importación del backup JSON local (archivo manual) para usos sin conexión a Dropbox.
