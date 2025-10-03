// Lógica principal de la UI, cifrado de entradas y sincronización con Dropbox
(async () => {
  await DB.open();

  const lockSection = document.getElementById('lock-section');
  const appSection = document.getElementById('app');
  const lockMsg = document.getElementById('lock-msg');
  const passwordInput = document.getElementById('password');
  const unlockBtn = document.getElementById('unlockBtn');
  const setBtn = document.getElementById('setBtn');
  const logoutBtn = document.getElementById('logoutBtn');
  const form = document.getElementById('entryForm');
  const syncBtn = document.getElementById('syncBtn');
  const entriesContainer = document.getElementById('entries');
  const appMsg = document.getElementById('app-msg');
  const dropboxStatus = document.getElementById('dropbox-status');
  const dropboxConnectBtn = document.getElementById('dropboxConnectBtn');
  const dropboxDisconnectBtn = document.getElementById('dropboxDisconnectBtn');
  const dropboxAppKeyInput = document.getElementById('dropboxAppKey');

  function setLockMessage(text) {
    lockMsg.textContent = text || '';
  }

  function setAppMessage(text = '', tone = 'muted') {
    appMsg.textContent = text;
    appMsg.dataset.tone = tone;
  }

  function showLock(message) {
    if (message) setLockMessage(message);
    lockSection.classList.remove('hidden');
    appSection.classList.add('hidden');
    passwordInput.focus();
  }

  function showApp() {
    lockSection.classList.add('hidden');
    appSection.classList.remove('hidden');
    setAppMessage('Listo para guardar nuevas entradas.');
    document.getElementById('title').focus();
    renderEntries();
  }

  async function blobToDataUrl(blob) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(reader.error || new Error('No se pudo leer el archivo'));
      reader.readAsDataURL(blob);
    });
  }

  function formatDate(timestamp) {
    if (!timestamp) return 'Sin fecha';
    return new Intl.DateTimeFormat('es-ES', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(timestamp));
  }

  function updateDropboxUI(state = DropboxSync.getStatus()) {
    if (dropboxAppKeyInput) {
      const current = dropboxAppKeyInput.value.trim();
      const stored = state.appKey || '';
      if (!current || current !== stored) {
        dropboxAppKeyInput.value = stored;
      }
    }
    if (state.linked) {
      let text = state.accountName ? `Conectado como ${state.accountName}.` : 'Conectado a Dropbox.';
      if (state.lastSync) {
        text += ` Última sincronización: ${formatDate(state.lastSync)}.`;
      }
      dropboxStatus.textContent = text;
      dropboxDisconnectBtn.disabled = false;
      dropboxConnectBtn.textContent = 'Reautorizar Dropbox';
    } else {
      dropboxStatus.textContent = 'No conectado. Introduce tu App Key y pulsa Conectar.';
      dropboxDisconnectBtn.disabled = true;
      dropboxConnectBtn.textContent = 'Conectar con Dropbox';
    }
    dropboxConnectBtn.disabled = !dropboxAppKeyInput.value.trim();
  }

  DropboxSync.subscribe(updateDropboxUI);
  try {
    await DropboxSync.init();
  } catch (err) {
    console.error('Dropbox init error', err);
    setAppMessage('Dropbox no se pudo inicializar.', 'error');
  }
  updateDropboxUI();

  const authResult = DropboxSync.getLastAuthResult();
  if (authResult) {
    if (authResult.status === 'linked') {
      setAppMessage('Dropbox conectado correctamente.', 'success');
    } else if (authResult.status === 'error') {
      setAppMessage('No se pudo completar la autorización de Dropbox. Reintenta.', 'error');
    }
    DropboxSync.markAuthNoticeHandled();
  }

  async function renderEntries() {
    entriesContainer.innerHTML = '';
    let items;
    try {
      items = await DB.listEntries();
    } catch (err) {
      entriesContainer.innerHTML = '<p class="entry error">No se pudieron cargar las entradas.</p>';
      console.error(err);
      return;
    }

    if (!items.length) {
      entriesContainer.innerHTML = '<p class="empty">Todavía no has guardado entradas. Empieza con la tuya primera.</p>';
      return;
    }

    const sorted = [...items].sort((a, b) => {
      const timeA = a.createdAt || 0;
      const timeB = b.createdAt || 0;
      if (timeA === timeB) return (b.id || 0) - (a.id || 0);
      return timeB - timeA;
    });

    for (const item of sorted) {
      const entryNode = document.createElement('article');
      entryNode.className = 'entry';
      entryNode.dataset.id = item.id;

      let decrypted;
      try {
        decrypted = await Crypto.decryptString(item.ciphertext);
      } catch (err) {
        entryNode.innerHTML = '<p class="error">No se pudo descifrar esta entrada. Prueba con la contraseña correcta y vuelve a guardar.</p>';
        entriesContainer.appendChild(entryNode);
        console.error('Fallo al descifrar entrada', err);
        continue;
      }

      let data;
      try {
        data = JSON.parse(decrypted);
      } catch (err) {
        entryNode.innerHTML = '<p class="error">La entrada está dañada.</p>';
        entriesContainer.appendChild(entryNode);
        console.error('JSON inválido en entrada', err);
        continue;
      }

      const header = document.createElement('div');
      header.className = 'entry-header';

      const titleEl = document.createElement('h3');
      titleEl.textContent = data.title?.trim() || 'Sin título';
      header.appendChild(titleEl);

      const timeEl = document.createElement('time');
      const createdAt = data.createdAt || item.createdAt;
      timeEl.datetime = createdAt ? new Date(createdAt).toISOString() : '';
      timeEl.textContent = formatDate(createdAt);
      header.appendChild(timeEl);

      const body = document.createElement('div');
      body.className = 'entry-body';

      if (data.content && data.content.trim()) {
        const paragraph = document.createElement('p');
        paragraph.textContent = data.content.trim();
        body.appendChild(paragraph);
      }

      if (data.photo) {
        const img = document.createElement('img');
        img.src = data.photo;
        img.alt = `Foto adjunta a ${titleEl.textContent}`;
        img.loading = 'lazy';
        body.appendChild(img);
      }

      const actions = document.createElement('div');
      actions.className = 'entry-actions';

      const deleteBtn = document.createElement('button');
      deleteBtn.type = 'button';
      deleteBtn.dataset.action = 'delete';
      deleteBtn.dataset.id = item.id;
      deleteBtn.textContent = 'Eliminar';
      actions.appendChild(deleteBtn);

      entryNode.appendChild(header);
      entryNode.appendChild(body);
      entryNode.appendChild(actions);

      entriesContainer.appendChild(entryNode);
    }
  }

  setBtn.addEventListener('click', async () => {
    const password = passwordInput.value.trim();
    if (password.length < 6) {
      setLockMessage('Usa al menos 6 caracteres para mayor seguridad.');
      return;
    }
    setLockMessage('Guardando contraseña...');
    setBtn.disabled = unlockBtn.disabled = true;
    try {
      await Crypto.setPassword(password);
      passwordInput.value = '';
      setLockMessage('Contraseña actualizada. Diario desbloqueado.');
      showApp();
    } catch (err) {
      setLockMessage('No se pudo guardar la contraseña. Inténtalo de nuevo.');
      console.error(err);
    } finally {
      setBtn.disabled = unlockBtn.disabled = false;
    }
  });

  unlockBtn.addEventListener('click', async () => {
    const password = passwordInput.value.trim();
    if (!password) {
      setLockMessage('Introduce la contraseña.');
      return;
    }
    setLockMessage('Comprobando contraseña...');
    setBtn.disabled = unlockBtn.disabled = true;
    try {
      const success = await Crypto.tryUnlock(password);
      if (success) {
        passwordInput.value = '';
        setLockMessage('');
        showApp();
      } else {
        setLockMessage('Contraseña incorrecta.');
      }
    } catch (err) {
      setLockMessage('Ha ocurrido un error al comprobar la contraseña.');
      console.error(err);
    } finally {
      setBtn.disabled = unlockBtn.disabled = false;
    }
  });

  logoutBtn.addEventListener('click', () => {
    Crypto.lock();
    form.reset();
    setAppMessage('Sesión bloqueada. Vuelve a introducir la contraseña.');
    showLock('Sesión bloqueada.');
  });

  dropboxAppKeyInput.addEventListener('input', () => {
    dropboxConnectBtn.disabled = !dropboxAppKeyInput.value.trim();
  });

  dropboxAppKeyInput.addEventListener('change', (event) => {
    DropboxSync.setAppKey(event.target.value.trim());
    updateDropboxUI();
  });

  dropboxConnectBtn.addEventListener('click', async () => {
    const key = dropboxAppKeyInput.value.trim();
    if (!key) {
      setAppMessage('Introduce tu App Key de Dropbox para continuar.', 'error');
      return;
    }
    try {
      setAppMessage('Redirigiendo a Dropbox para autorizar...', 'muted');
      await DropboxSync.connect(key);
    } catch (err) {
      setAppMessage('No se pudo iniciar la conexión con Dropbox.', 'error');
      console.error(err);
    }
  });

  dropboxDisconnectBtn.addEventListener('click', () => {
    DropboxSync.disconnect();
    setAppMessage('Se desconectó Dropbox.', 'muted');
  });

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (!Crypto.isUnlocked()) {
      setAppMessage('Primero desbloquea el diario para guardar.', 'error');
      showLock('La sesión se cerró.');
      return;
    }

    const title = document.getElementById('title').value.trim();
    const content = document.getElementById('content').value.trim();
    const photoInput = document.getElementById('photo');
    const timestamp = Date.now();

    const entryData = {
      title,
      content,
      createdAt: timestamp
    };

    if (photoInput.files && photoInput.files[0]) {
      try {
        entryData.photo = await blobToDataUrl(photoInput.files[0]);
      } catch (err) {
        setAppMessage('No se pudo procesar la foto adjunta.', 'error');
        console.error(err);
        return;
      }
    }

    try {
      const plaintext = JSON.stringify(entryData);
      const ciphertext = await Crypto.encryptString(plaintext);
      await DB.saveEntry({ ciphertext, createdAt: timestamp });
      form.reset();
      setAppMessage('Entrada guardada correctamente.', 'success');
      renderEntries();
    } catch (err) {
      setAppMessage('No se pudo guardar la entrada. Revisa la consola.', 'error');
      console.error(err);
    }
  });

  entriesContainer.addEventListener('click', async (event) => {
    const button = event.target.closest('button[data-action="delete"]');
    if (!button) return;
    const id = Number(button.dataset.id);
    if (!Number.isFinite(id)) return;
    button.disabled = true;
    try {
      await DB.deleteEntry(id);
      setAppMessage('Entrada eliminada.');
      renderEntries();
    } catch (err) {
      setAppMessage('No se pudo eliminar la entrada.', 'error');
      console.error(err);
    } finally {
      button.disabled = false;
    }
  });

  syncBtn.addEventListener('click', async () => {
    if (!Crypto.isUnlocked()) {
      setAppMessage('Desbloquea el diario antes de exportar.', 'error');
      return;
    }
    syncBtn.disabled = true;
    const originalText = syncBtn.textContent;
    syncBtn.textContent = 'Generando backup...';
    try {
      const items = await DB.listEntries();
      const exported = items.map((item) => ({
        id: item.id,
        createdAt: item.createdAt,
        ciphertext: item.ciphertext
      }));
      const serialized = JSON.stringify(exported, null, 2);
      const filename = `diario-backup-${new Date().toISOString().slice(0, 10)}.json`;
      const blob = new Blob([serialized], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = filename;
      link.click();
      URL.revokeObjectURL(url);

      if (DropboxSync.isLinked()) {
        setAppMessage('Subiendo el backup a Dropbox...', 'muted');
        try {
          await DropboxSync.uploadBackup(filename, serialized);
          setAppMessage('Backup sincronizado con Dropbox y descargado localmente.', 'success');
        } catch (err) {
          setAppMessage('Backup local listo, pero Dropbox falló. Revisa tu sesión o conexión.', 'error');
          console.error(err);
        }
      } else {
        setAppMessage('Backup generado (JSON). Conecta Dropbox para sincronizarlo automáticamente.', 'success');
      }
    } catch (err) {
      setAppMessage('No se pudo generar el backup.', 'error');
      console.error(err);
    } finally {
      syncBtn.disabled = false;
      syncBtn.textContent = originalText;
    }
  });

  const hasPassword = await Crypto.hasKey();
  if (hasPassword) {
    showLock('Introduce la contraseña para desbloquear tu diario.');
  } else {
    showLock('Crea una contraseña segura para comenzar.');
  }
})();
