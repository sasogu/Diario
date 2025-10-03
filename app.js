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
  const dropboxImportBtn = document.getElementById('dropboxImportBtn');
  const dropboxDisconnectBtn = document.getElementById('dropboxDisconnectBtn');
  const dropboxAppKeyInput = document.getElementById('dropboxAppKey');
  const backupModal = document.getElementById('backup-modal');
  const backupList = document.getElementById('backup-list');
  const backupConfirmBtn = document.getElementById('backupConfirmBtn');
  const backupCancelBtn = document.getElementById('backupCancelBtn');
  const diffModal = document.getElementById('diff-modal');
  const diffSummary = document.getElementById('diff-summary');
  const diffIdentical = document.getElementById('diff-identical');
  const diffNewList = document.getElementById('diff-new');
  const diffConflictsList = document.getElementById('diff-conflicts');
  const diffMergeBtn = document.getElementById('diffMergeBtn');
  const diffReplaceBtn = document.getElementById('diffReplaceBtn');
  const diffCancelBtn = document.getElementById('diffCancelBtn');

  let dropboxBackupsCache = null;
  let pickerResolve = null;
  let pickerOptions = [];
  let pickerSelectedIndex = null;
  let diffResolve = null;

  if (backupConfirmBtn) backupConfirmBtn.disabled = true;
  if (diffMergeBtn) diffMergeBtn.disabled = false;
  if (diffReplaceBtn) diffReplaceBtn.disabled = false;

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

  function formatDate(value) {
    if (!value) return 'Sin fecha';
    const date = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(date.getTime())) return 'Sin fecha';
    return new Intl.DateTimeFormat('es-ES', { dateStyle: 'medium', timeStyle: 'short' }).format(date);
  }

  async function collectBackupPayload() {
    const items = await DB.listEntries();
    const exported = items.map((item) => ({
      id: item.id,
      createdAt: item.createdAt,
      ciphertext: item.ciphertext
    }));
    const serialized = JSON.stringify(exported, null, 2);
    const filename = `diario-backup-${new Date().toISOString().slice(0, 10)}.json`;
    return { serialized, filename };
  }

  function downloadBackupFile(filename, serialized) {
    const blob = new Blob([serialized], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    link.click();
    URL.revokeObjectURL(url);
  }

  function normalizeBackupEntries(parsed) {
    if (!Array.isArray(parsed) || !parsed.length) {
      throw new Error('El backup está vacío.');
    }
    const normalized = parsed
      .filter((entry) => entry && typeof entry.ciphertext === 'string')
      .map((entry) => {
        const record = {
          ciphertext: entry.ciphertext,
          createdAt: entry.createdAt || Date.now()
        };
        if (Number.isFinite(entry.id)) record.id = entry.id;
        return record;
      });
    if (!normalized.length) {
      throw new Error('No se encontraron entradas válidas en el backup.');
    }
    return normalized;
  }

  function parseBackupSerialized(serialized) {
    let parsed;
    try {
      parsed = JSON.parse(serialized);
    } catch (err) {
      throw new Error('Backup inválido (JSON corrupto)');
    }
    return normalizeBackupEntries(parsed);
  }

  async function replaceWithBackupEntries(entries) {
    await DB.replaceEntries(entries);
    await renderEntries();
    return entries.length;
  }

  async function restoreBackupFromSerialized(serialized) {
    const normalized = parseBackupSerialized(serialized);
    return replaceWithBackupEntries(normalized);
  }

  function getDropboxBaseText(state) {
    let text = state.accountName ? `Conectado como ${state.accountName}.` : 'Conectado a Dropbox.';
    if (state.lastSync) {
      text += ` Última subida: ${formatDate(state.lastSync)}.`;
    }
    return text;
  }

  function setPickerSelection(index) {
    pickerSelectedIndex = index;
    const items = backupList.querySelectorAll('.backup-item');
    items.forEach((item) => {
      if (Number(item.dataset.index) === index) {
        item.classList.add('selected');
      } else {
        item.classList.remove('selected');
      }
    });
    backupConfirmBtn.disabled = index === null || index === undefined;
  }

  function closeBackupPicker() {
    pickerOptions = [];
    pickerSelectedIndex = null;
    backupList.innerHTML = '';
    backupModal.classList.add('hidden');
    backupModal.setAttribute('aria-hidden', 'true');
    backupConfirmBtn.disabled = true;
  }

  function openBackupPicker(backups) {
    return new Promise((resolve) => {
      pickerResolve = resolve;
      pickerOptions = backups;
      backupList.innerHTML = '';

      if (!backups.length) {
        const item = document.createElement('li');
        item.textContent = 'No hay backups disponibles.';
        item.className = 'muted';
        backupList.appendChild(item);
        backupConfirmBtn.disabled = true;
      } else {
        backups.forEach((entry, index) => {
          const item = document.createElement('li');
          item.className = 'backup-item';
          item.dataset.index = String(index);
          const title = document.createElement('strong');
          title.textContent = entry.name || `Backup ${index + 1}`;
          const meta = document.createElement('span');
          const modified = entry.server_modified || entry.client_modified;
          const size = typeof entry.size === 'number' ? `${(entry.size / 1024).toFixed(1)} KB` : '';
          const infoParts = [modified ? formatDate(modified) : null, size].filter(Boolean);
          meta.textContent = infoParts.join(' · ');
          item.appendChild(title);
          item.appendChild(meta);
          backupList.appendChild(item);
        });
        setPickerSelection(0);
      }

      backupModal.classList.remove('hidden');
      backupModal.setAttribute('aria-hidden', 'false');
    });
  }

  backupList.addEventListener('click', (event) => {
    const node = event.target.closest('.backup-item');
    if (!node) return;
    const index = Number(node.dataset.index);
    if (Number.isFinite(index)) setPickerSelection(index);
  });

  backupConfirmBtn.addEventListener('click', () => {
    if (!pickerResolve) return;
    const selection = pickerSelectedIndex != null ? pickerOptions[pickerSelectedIndex] : null;
    const resolve = pickerResolve;
    pickerResolve = null;
    closeBackupPicker();
    resolve(selection || null);
  });

  backupCancelBtn.addEventListener('click', () => {
    if (pickerResolve) {
      const resolve = pickerResolve;
      pickerResolve = null;
      closeBackupPicker();
      resolve(null);
    } else {
      closeBackupPicker();
    }
  });

  function closeDiffModal() {
    diffNewList.innerHTML = '';
    diffConflictsList.innerHTML = '';
    diffSummary.textContent = '';
    diffIdentical.textContent = '';
    diffModal.classList.add('hidden');
    diffModal.setAttribute('aria-hidden', 'true');
    diffResolve = null;
  }

  function renderDiffList(listElement, items, emptyMessage, renderItem) {
    listElement.innerHTML = '';
    if (!items.length) {
      const li = document.createElement('li');
      li.className = 'muted';
      li.textContent = emptyMessage;
      listElement.appendChild(li);
      return;
    }
    items.forEach((item) => {
      listElement.appendChild(renderItem(item));
    });
  }

  function createDiffEntry(title, meta, className) {
    const li = document.createElement('li');
    li.className = `diff-entry${className ? ` ${className}` : ''}`;
    const strong = document.createElement('strong');
    strong.textContent = title;
    const span = document.createElement('span');
    span.textContent = meta;
    li.appendChild(strong);
    li.appendChild(span);
    return li;
  }

  function createConflictEntry(localInfo, backupInfo) {
    const li = document.createElement('li');
    li.className = 'diff-entry';
    const backupLine = document.createElement('div');
    backupLine.className = 'conflict-backup';
    backupLine.textContent = `Backup: ${backupInfo.title} · ${backupInfo.meta}`;
    const localLine = document.createElement('div');
    localLine.className = 'conflict-local';
    localLine.textContent = `Local: ${localInfo.title} · ${localInfo.meta}`;
    li.appendChild(backupLine);
    li.appendChild(localLine);
    return li;
  }

  function openDiffModal(diff, backupName) {
    return new Promise((resolve) => {
      diffResolve = resolve;
      const { newEntries, conflicts, identicalCount, totalBackup } = diff;
      const newCount = newEntries.length;
      const conflictCount = conflicts.length;
      const parts = [];
      if (newCount) parts.push(`${newCount} nuevas`);
      if (conflictCount) parts.push(`${conflictCount} conflictos`);
      if (!parts.length) parts.push('Sin diferencias detectables');
      diffSummary.textContent = `${backupName || 'Backup'} · ${parts.join(' · ')}`;
      diffIdentical.textContent = `Entradas idénticas: ${identicalCount} / ${totalBackup}`;

      renderDiffList(
        diffNewList,
        newEntries,
        'No hay entradas nuevas en este backup.',
        (item) => {
          const label = item.info.title + (item.info.ok ? '' : ' (sin descifrar)');
          return createDiffEntry(label, formatDate(item.info.createdAt), item.info.ok ? '' : 'error');
        }
      );

      renderDiffList(
        diffConflictsList,
        conflicts,
        'Sin conflictos detectados.',
        (item) => {
          const localInfo = {
            title: item.local.info.title + (item.local.info.ok ? '' : ' (sin descifrar)'),
            meta: formatDate(item.local.info.createdAt)
          };
          const backupInfo = {
            title: item.backup.info.title + (item.backup.info.ok ? '' : ' (sin descifrar)'),
            meta: formatDate(item.backup.info.createdAt)
          };
          return createConflictEntry(localInfo, backupInfo);
        }
      );

      const mergeDisabled =
        !newEntries.length && !conflicts.length ? true :
        newEntries.some((item) => !item.info.ok) ||
        conflicts.some((item) => !item.backup.info.ok || !item.local.info.ok);

      diffMergeBtn.disabled = mergeDisabled;
      if (mergeDisabled && (newEntries.length || conflicts.length)) {
        diffIdentical.textContent += ' · Algunas entradas no se pudieron descifrar; solo se permite reemplazar.';
      }
      diffModal.classList.remove('hidden');
      diffModal.setAttribute('aria-hidden', 'false');
    });
  }

  diffMergeBtn.addEventListener('click', () => {
    if (!diffResolve) return;
    const resolve = diffResolve;
    diffResolve = null;
    closeDiffModal();
    resolve({ action: 'merge' });
  });

  diffReplaceBtn.addEventListener('click', () => {
    if (!diffResolve) return;
    const resolve = diffResolve;
    diffResolve = null;
    closeDiffModal();
    resolve({ action: 'replace' });
  });

  diffCancelBtn.addEventListener('click', () => {
    if (!diffResolve) return;
    const resolve = diffResolve;
    diffResolve = null;
    closeDiffModal();
    resolve(null);
  });

  async function describeEntry(entry) {
    try {
      const decrypted = await Crypto.decryptString(entry.ciphertext);
      const data = JSON.parse(decrypted);
      return {
        title: (data.title && data.title.trim()) || 'Sin título',
        createdAt: data.createdAt || entry.createdAt,
        content: data.content || '',
        payload: data,
        ok: true
      };
    } catch (err) {
      console.error('No se pudo descifrar entrada para comparación', err);
      return {
        title: 'Entrada cifrada',
        createdAt: entry.createdAt,
        content: '',
        payload: null,
        ok: false
      };
    }
  }

  async function buildBackupDiff(localEntries, backupEntries) {
    const localByCipher = new Map();
    const localById = new Map();
    localEntries.forEach((entry) => {
      localByCipher.set(entry.ciphertext, entry);
      if (Number.isFinite(entry.id)) localById.set(entry.id, entry);
    });

    const describeCache = new Map();
    const getDescription = async (entry) => {
      if (describeCache.has(entry.ciphertext)) return describeCache.get(entry.ciphertext);
      const info = await describeEntry(entry);
      describeCache.set(entry.ciphertext, info);
      return info;
    };

    let identicalCount = 0;
    const newEntries = [];
    const conflicts = [];

    for (const entry of backupEntries) {
      if (localByCipher.has(entry.ciphertext)) {
        identicalCount += 1;
        continue;
      }
      if (Number.isFinite(entry.id) && localById.has(entry.id)) {
        conflicts.push({ backup: entry, local: localById.get(entry.id) });
      } else {
        newEntries.push(entry);
      }
    }

    const describedNew = [];
    for (const entry of newEntries) {
      describedNew.push({ entry, info: await getDescription(entry) });
    }
    describedNew.sort((a, b) => (b.info.createdAt || 0) - (a.info.createdAt || 0));

    const describedConflicts = [];
    for (const pair of conflicts) {
      const backupInfo = await getDescription(pair.backup);
      const localInfo = await getDescription(pair.local);
      describedConflicts.push({
        backup: { entry: pair.backup, info: backupInfo },
        local: { entry: pair.local, info: localInfo }
      });
    }
    describedConflicts.sort((a, b) => (b.backup.info.createdAt || 0) - (a.backup.info.createdAt || 0));

    return {
      newEntries: describedNew,
      conflicts: describedConflicts,
      identicalCount,
      totalBackup: backupEntries.length
    };
  }

  async function mergeBackupEntries(diff) {
    let added = 0;
    let replaced = 0;

    const ensurePayload = (info, entry) => {
      if (!info.ok || !info.payload) {
        throw new Error('No se pudo descifrar una de las entradas del backup. Usa "Reemplazar" si deseas continuar.');
      }
      const payload = { ...info.payload };
      delete payload.id;
      delete payload.ciphertext;
      const createdAt = Number(payload.createdAt) || entry.createdAt || Date.now();
      payload.createdAt = createdAt;
      return { payload, createdAt };
    };

    const encryptPayload = async (payload) => {
      const plaintext = JSON.stringify(payload);
      const ciphertext = await Crypto.encryptString(plaintext);
      // Verificación defensiva
      await Crypto.decryptString(ciphertext);
      return ciphertext;
    };

    const addEntry = async (entryWrapper) => {
      const { payload, createdAt } = ensurePayload(entryWrapper.info, entryWrapper.entry);
      const ciphertext = await encryptPayload(payload);
      await DB.saveEntry({ ciphertext, createdAt });
      added += 1;
    };

    const replaceEntry = async (conflictWrapper) => {
      const { payload, createdAt } = ensurePayload(conflictWrapper.backup.info, conflictWrapper.backup.entry);
      const ciphertext = await encryptPayload(payload);
      const localEntry = conflictWrapper.local.entry;
      const targetId = Number(localEntry.id);
      if (Number.isFinite(targetId)) {
        await DB.putEntry({ id: targetId, ciphertext, createdAt });
      } else {
        await DB.saveEntry({ ciphertext, createdAt });
      }
      replaced += 1;
    };

    for (const item of diff.newEntries) {
      await addEntry(item);
    }

    for (const item of diff.conflicts) {
      await replaceEntry(item);
    }

    await renderEntries();
    return { added, replaced };
  }

  async function getDropboxBackups(force = false) {
    if (!DropboxSync.isLinked()) {
      dropboxBackupsCache = null;
      return [];
    }
    if (!dropboxBackupsCache || force) {
      dropboxBackupsCache = await DropboxSync.listBackups();
    }
    return dropboxBackupsCache;
  }

  async function refreshDropboxBackups(baseText, force = false) {
    if (!DropboxSync.isLinked()) return;
    try {
      const backups = await getDropboxBackups(force);
      if (!DropboxSync.isLinked()) return;
      if (backups.length) {
        const latest = backups[0];
        const latestDate = latest.server_modified || latest.client_modified;
        dropboxStatus.textContent = `${baseText} Último backup disponible: ${formatDate(latestDate)} (${latest.name}). (${backups.length} en total)`;
      } else {
        dropboxStatus.textContent = `${baseText} Aún no hay backups en Dropbox.`;
      }
    } catch (err) {
      console.error('Error listando backups de Dropbox', err);
      dropboxStatus.textContent = `${baseText} No se pudo listar los backups.`;
    }
  }

  async function autoSyncWithDropbox(context = 'save') {
    const copy = (
      {
        save: {
          start: 'Entrada guardada. Preparando sincronización con Dropbox...',
          upload: 'Entrada guardada. Subiendo backup a Dropbox...',
          success: 'Entrada guardada y sincronizada con Dropbox.',
          error: 'Entrada guardada. Dropbox no se sincronizó; revisa tu conexión.'
        },
        delete: {
          start: 'Entrada eliminada. Actualizando backup en Dropbox...',
          upload: 'Subiendo cambios a Dropbox...',
          success: 'Entrada eliminada y backup actualizado en Dropbox.',
          error: 'Entrada eliminada, pero Dropbox falló. Revisa tu conexión.'
        },
        restore: {
          start: 'Backup restaurado. Preparando sincronización con Dropbox...',
          upload: 'Subiendo el backup restaurado a Dropbox...',
          success: 'Backup restaurado y sincronizado con Dropbox.',
          error: 'Backup restaurado, pero Dropbox no se sincronizó; revisa tu conexión.'
        },
        merge: {
          start: 'Fusionando cambios con Dropbox...',
          upload: 'Subiendo las entradas fusionadas a Dropbox...',
          success: 'Fusionado completado y sincronizado con Dropbox.',
          error: 'Se fusionó localmente, pero Dropbox no se sincronizó; revisa tu conexión.'
        }
      }[context] || {
        start: 'Sincronizando con Dropbox...',
        upload: 'Subiendo backup a Dropbox...',
        success: 'Sincronización completada.',
        error: 'No se pudo sincronizar con Dropbox.'
      }
    );

    try {
      setAppMessage(copy.start, 'muted');
      const payload = await collectBackupPayload();
      setAppMessage(copy.upload, 'muted');
      await DropboxSync.uploadBackup(payload.filename, payload.serialized);
      dropboxBackupsCache = null;
      setAppMessage(copy.success, 'success');
      const state = DropboxSync.getStatus();
      await refreshDropboxBackups(getDropboxBaseText(state), true);
    } catch (err) {
      console.error('Sincronización con Dropbox falló', err);
      setAppMessage(copy.error, 'error');
    }
  }

  function updateDropboxUI(state = DropboxSync.getStatus()) {
    if (dropboxAppKeyInput) {
      const current = dropboxAppKeyInput.value.trim();
      const stored = state.appKey || '';
      if (!current || current !== stored) {
        dropboxAppKeyInput.value = stored;
      }
    }

    dropboxConnectBtn.disabled = !dropboxAppKeyInput.value.trim();

    if (state.linked) {
      dropboxDisconnectBtn.disabled = false;
      dropboxImportBtn.disabled = false;
      dropboxConnectBtn.textContent = 'Reautorizar Dropbox';
      const baseText = getDropboxBaseText(state);
      dropboxStatus.textContent = `${baseText} Consultando backups...`;
      refreshDropboxBackups(baseText, !dropboxBackupsCache);
    } else {
      dropboxBackupsCache = null;
      dropboxStatus.textContent = 'No conectado. Introduce tu App Key y pulsa Conectar.';
      dropboxDisconnectBtn.disabled = true;
      dropboxImportBtn.disabled = true;
      dropboxConnectBtn.textContent = 'Conectar con Dropbox';
    }
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
      const detail = authResult.detail ? ` Detalle: ${String(authResult.detail).slice(0, 140)}.` : '';
      setAppMessage(`No se pudo completar la autorización de Dropbox. Reintenta.${detail}`, 'error');
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
        entryNode.innerHTML = '';
        const errorMsg = document.createElement('p');
        errorMsg.className = 'error';
        errorMsg.textContent = 'No se pudo descifrar esta entrada. Puedes intentar eliminarla o importar un backup reciente.';
        entryNode.appendChild(errorMsg);
        const actions = document.createElement('div');
        actions.className = 'entry-actions';
        const deleteBtn = document.createElement('button');
        deleteBtn.type = 'button';
        deleteBtn.dataset.action = 'delete';
        deleteBtn.dataset.id = item.id;
        deleteBtn.textContent = 'Eliminar entrada corrupta';
        actions.appendChild(deleteBtn);
        entryNode.appendChild(actions);
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
    setAppMessage('Sesión bloqueada. Vuelve a introducir la contraseña.', 'muted');
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

  dropboxImportBtn.addEventListener('click', async () => {
    if (!DropboxSync.isLinked()) {
      setAppMessage('Conecta Dropbox antes de importar.', 'error');
      return;
    }
    if (!Crypto.isUnlocked()) {
      setAppMessage('Desbloquea el diario antes de importar.', 'error');
      showLock('Introduce la contraseña para continuar.');
      return;
    }
    const confirmReplace = window.confirm('Esto reemplazará las entradas locales por el backup que elijas de Dropbox. ¿Continuar?');
    if (!confirmReplace) return;

    dropboxImportBtn.disabled = true;
    try {
      const baseText = getDropboxBaseText(DropboxSync.getStatus());
      dropboxStatus.textContent = `${baseText} Buscando backups en Dropbox...`;
      setAppMessage('Consultando backups en Dropbox...', 'muted');
      const backups = await getDropboxBackups(true);
      if (!backups.length) {
        setAppMessage('No se encontraron backups en Dropbox.', 'error');
        updateDropboxUI();
        return;
      }
      const chosen = await openBackupPicker(backups);
      if (!chosen) {
        setAppMessage('Importación cancelada.', 'muted');
        updateDropboxUI();
        return;
      }
      setAppMessage(`Descargando ${chosen.name}...`, 'muted');
      const payload = await DropboxSync.downloadBackup(chosen.path_lower || chosen.path_display || chosen.path);
      let normalized;
      try {
        normalized = parseBackupSerialized(payload);
      } catch (err) {
        setAppMessage(err.message || 'Backup inválido.', 'error');
        console.error(err);
        return;
      }

      const localEntries = await DB.listEntries();
      const diff = await buildBackupDiff(localEntries, normalized);

      if (!diff.newEntries.length && !diff.conflicts.length) {
        const proceed = window.confirm('El backup es idéntico al diario local. ¿Quieres sobrescribir igualmente?');
        if (!proceed) {
          setAppMessage('Importación cancelada: no había cambios.', 'muted');
          updateDropboxUI();
          return;
        }
        const count = await replaceWithBackupEntries(normalized);
        await autoSyncWithDropbox('restore');
        setAppMessage(`Se reemplazó el diario con ${count} entradas desde ${chosen.name}.`, 'success');
        await refreshDropboxBackups(getDropboxBaseText(DropboxSync.getStatus()), true);
        return;
      }

      const decision = await openDiffModal(diff, chosen.name);
      if (!decision) {
        setAppMessage('Importación cancelada.', 'muted');
        updateDropboxUI();
        return;
      }

      if (decision.action === 'merge') {
        try {
          const mergeResult = await mergeBackupEntries(diff);
          const parts = [];
          if (mergeResult.added) parts.push(`${mergeResult.added} nuevas`);
          if (mergeResult.replaced) parts.push(`${mergeResult.replaced} actualizadas`);
          setAppMessage(parts.length ? `Fusionaste ${parts.join(' y ')} entradas del backup.` : 'No había entradas para fusionar.', parts.length ? 'success' : 'muted');
          await autoSyncWithDropbox('merge');
          await refreshDropboxBackups(getDropboxBaseText(DropboxSync.getStatus()), true);
        } catch (mergeErr) {
          setAppMessage(mergeErr.message || 'No se pudo fusionar el backup.', 'error');
          console.error(mergeErr);
        }
      } else {
        const count = await replaceWithBackupEntries(normalized);
        await autoSyncWithDropbox('restore');
        setAppMessage(`Se reemplazó el diario con ${count} entradas desde ${chosen.name}.`, 'success');
        await refreshDropboxBackups(getDropboxBaseText(DropboxSync.getStatus()), true);
      }
    } catch (err) {
      setAppMessage('No se pudo importar el backup desde Dropbox.', 'error');
      console.error(err);
    } finally {
      dropboxImportBtn.disabled = false;
    }
  });

  dropboxDisconnectBtn.addEventListener('click', () => {
    DropboxSync.disconnect();
    dropboxBackupsCache = null;
    setAppMessage('Se desconectó Dropbox.', 'muted');
    updateDropboxUI();
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
      await renderEntries();
      if (DropboxSync.isLinked()) {
        await autoSyncWithDropbox('save');
      } else {
        setAppMessage('Entrada guardada correctamente.', 'success');
      }
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
      setAppMessage('Entrada eliminada.', 'muted');
      await renderEntries();
      if (DropboxSync.isLinked()) {
        await autoSyncWithDropbox('delete');
      }
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
      setAppMessage('Generando backup local...', 'muted');
      const payload = await collectBackupPayload();
      downloadBackupFile(payload.filename, payload.serialized);
      if (DropboxSync.isLinked()) {
        setAppMessage('Backup descargado. Subiendo copia a Dropbox...', 'muted');
        try {
          await DropboxSync.uploadBackup(payload.filename, payload.serialized);
          dropboxBackupsCache = null;
          setAppMessage('Backup descargado y sincronizado con Dropbox.', 'success');
          const state = DropboxSync.getStatus();
          refreshDropboxBackups(getDropboxBaseText(state), true);
        } catch (err) {
          setAppMessage('Backup descargado, pero Dropbox falló. Revisa la sesión.', 'error');
          console.error(err);
        }
      } else {
        setAppMessage('Backup descargado (JSON). Conecta Dropbox para sincronizar automáticamente.', 'success');
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
