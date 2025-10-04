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
  const recoverDropboxBtn = document.getElementById('recoverDropboxBtn');
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
  let latestRemoteMetadata = null;
  let autoSyncObservedRevision = null;
  const LAST_REMOTE_BACKUP_KEY = 'diario_last_remote_backup_marker';
  const SESSION_TIMEOUT_MS = 5 * 60 * 1000;
  const ACTIVITY_CHECK_INTERVAL = 15 * 1000;
  let lastActivityAt = null;
  let inactivityInterval = null;
  let autoSyncPromptShown = false;

  if (backupConfirmBtn) backupConfirmBtn.disabled = true;
  if (diffMergeBtn) diffMergeBtn.disabled = false;
  if (diffReplaceBtn) diffReplaceBtn.disabled = false;

  function getBackupRevisionKey(metadata) {
    if (!metadata || typeof metadata !== 'object') return null;
    return metadata.rev || metadata.server_modified || metadata.client_modified || metadata.name || null;
  }

  function getBackupModifiedMs(metadata) {
    if (!metadata) return NaN;
    const raw = metadata.server_modified || metadata.client_modified;
    if (!raw) return NaN;
    const value = new Date(raw).getTime();
    return Number.isFinite(value) ? value : NaN;
  }

  function getStoredRemoteBackupMarker() {
    try {
      return localStorage.getItem(LAST_REMOTE_BACKUP_KEY);
    } catch (err) {
      console.warn('No se pudo leer el estado del backup remoto', err);
      return null;
    }
  }

  function rememberRemoteBackup(metadata) {
    const marker = getBackupRevisionKey(metadata);
    if (!marker) return;
    try {
      localStorage.setItem(LAST_REMOTE_BACKUP_KEY, marker);
    } catch (err) {
      console.warn('No se pudo guardar el estado del backup remoto', err);
    }
    autoSyncObservedRevision = marker;
  }

  function forgetRemoteBackupMarker() {
    try {
      localStorage.removeItem(LAST_REMOTE_BACKUP_KEY);
    } catch (err) {
      console.warn('No se pudo limpiar el estado del backup remoto', err);
    }
    autoSyncObservedRevision = null;
  }

  function stopInactivityWatcher() {
    if (inactivityInterval) {
      clearInterval(inactivityInterval);
      inactivityInterval = null;
    }
    lastActivityAt = null;
  }

  function clearInactivityTimer() {
    stopInactivityWatcher();
  }

  function ensureInactivityWatcher() {
    if (!Crypto.isUnlocked()) return;
    lastActivityAt = Date.now();
    if (inactivityInterval) return;
    inactivityInterval = setInterval(() => {
      if (!Crypto.isUnlocked()) {
        stopInactivityWatcher();
        return;
      }
      if (lastActivityAt && Date.now() - lastActivityAt >= SESSION_TIMEOUT_MS) {
        stopInactivityWatcher();
        Crypto.lock();
        form.reset();
        setAppMessage('Sesión caducada por inactividad.', 'muted');
        showLock('Sesión caducada por inactividad.');
      }
    }, ACTIVITY_CHECK_INTERVAL);
  }

  function recordActivity() {
    if (!Crypto.isUnlocked()) return;
    lastActivityAt = Date.now();
    ensureInactivityWatcher();
  }

  function setLockMessage(text) {
    lockMsg.textContent = text || '';
  }

  function setAppMessage(text = '', tone = 'muted') {
    appMsg.textContent = text;
    appMsg.dataset.tone = tone;
  }

  function showLock(message) {
    stopInactivityWatcher();
    autoSyncPromptShown = false;
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
    ensureInactivityWatcher();
    if (!autoSyncPromptShown) {
      autoSyncPromptShown = true;
      setTimeout(() => {
        if (Crypto.isUnlocked()) setupAutoSyncPrompt();
      }, 300);
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
      setLockMessage('Contraseña actualizada. Diario desbloqueado!');
      recordActivity();
      showApp();
    } catch (err) {
      console.error('Error guardando contraseña', err);
      setLockMessage('No se pudo guardar la contraseña. Inténtalo de nuevo.');
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
      const ok = await Crypto.tryUnlock(password);
      if (ok) {
        passwordInput.value = '';
        setLockMessage('');
        recordActivity();
        showApp();
      } else {
        setLockMessage('Contraseña incorrecta.');
      }
    } catch (err) {
      console.error('Error al desbloquear', err);
      setLockMessage('Ocurrió un error al comprobar la contraseña.');
    } finally {
      setBtn.disabled = unlockBtn.disabled = false;
    }
  });

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
    const meta = await Crypto.exportState().catch(() => null);
    const payload = {
      version: 2,
      exportedAt: new Date().toISOString(),
      meta,
      entries: exported
    };
    const serialized = JSON.stringify(payload, null, 2);
    const filename = `diario-backup-${new Date().toISOString().slice(0, 10)}.json`;
    return { serialized, filename, payload };
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

    if (Array.isArray(parsed)) {
      return { entries: normalizeBackupEntries(parsed), meta: null, raw: parsed };
    }

    if (parsed && Array.isArray(parsed.entries)) {
      return {
        entries: normalizeBackupEntries(parsed.entries),
        meta: parsed.meta || null,
        raw: parsed
      };
    }

    throw new Error('Formato de backup no reconocido');
  }

  async function replaceWithBackupEntries(entries) {
    await DB.replaceEntries(entries);
    return entries.length;
  }

  async function restoreBackupFromSerialized(serialized) {
    const parsed = parseBackupSerialized(serialized);
    const count = await replaceWithBackupEntries(parsed.entries);
    return { count, meta: parsed.meta };
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

  async function describeEntry(entry, decryptFn = (payload) => Crypto.decryptString(payload)) {
    try {
      const decrypted = await decryptFn(entry.ciphertext);
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

  async function buildBackupDiff(localEntries, backupEntries, decryptBackup) {
    const localByCipher = new Map();
    const localById = new Map();
    localEntries.forEach((entry) => {
      localByCipher.set(entry.ciphertext, entry);
      if (Number.isFinite(entry.id)) localById.set(entry.id, entry);
    });

    const describeCache = new Map();
    const defaultDecrypt = (payload) => Crypto.decryptString(payload);
    const getDescription = async (entry, decryptFn = defaultDecrypt) => {
      const activeDecrypt = decryptFn || defaultDecrypt;
      const scope = activeDecrypt === decryptBackup ? 'backup' : 'local';
      const cacheKey = `${entry.ciphertext}::${scope}`;
      if (describeCache.has(cacheKey)) return describeCache.get(cacheKey);
      const info = await describeEntry(entry, activeDecrypt);
      describeCache.set(cacheKey, info);
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
      describedNew.push({ entry, info: await getDescription(entry, decryptBackup) });
    }
    describedNew.sort((a, b) => (b.info.createdAt || 0) - (a.info.createdAt || 0));

    const describedConflicts = [];
    for (const pair of conflicts) {
      const backupInfo = await getDescription(pair.backup, decryptBackup);
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

    for (const item of diff.newEntries) {
      const entry = item.entry;
      await DB.saveEntry({
        ciphertext: entry.ciphertext,
        createdAt: entry.createdAt || Date.now()
      });
      added += 1;
    }

    for (const item of diff.conflicts) {
      const backupEntry = item.backup.entry;
      const localEntry = item.local.entry;
      const targetId = Number(localEntry.id);
      if (Number.isFinite(targetId)) {
        await DB.putEntry({
          id: targetId,
          ciphertext: backupEntry.ciphertext,
          createdAt: backupEntry.createdAt || localEntry.createdAt || Date.now()
        });
      } else {
        await DB.saveEntry({
          ciphertext: backupEntry.ciphertext,
          createdAt: backupEntry.createdAt || Date.now()
        });
      }
      replaced += 1;
    }

    return { added, replaced };
  }

  async function adoptBackupState(session, meta, password, originalState) {
    if (!session || !meta || !password) return { migrated: 0 };

    const entries = await DB.listEntries();
    const updates = [];
    for (const entry of entries) {
      let usesNewKey = false;
      try {
        await session.decryptString(entry.ciphertext);
        usesNewKey = true;
      } catch (err) {
        usesNewKey = false;
      }
      if (usesNewKey) continue;

      try {
        const plaintext = await Crypto.decryptString(entry.ciphertext);
        const newCiphertext = await session.encryptString(plaintext);
        updates.push({ id: entry.id, ciphertext: newCiphertext, createdAt: entry.createdAt });
      } catch (err) {
        console.warn('No se pudo migrar una entrada al nuevo cifrado', entry.id, err);
      }
    }

    for (const update of updates) {
      if (Number.isFinite(update.id)) {
        await DB.putEntry(update);
      }
    }

    if (updates.length) await renderEntries();

    await Crypto.importState(meta);
    const unlocked = await Crypto.tryUnlock(password);
    if (!unlocked) {
      if (originalState) {
        try {
          await Crypto.importState(originalState);
          await Crypto.tryUnlock(password);
        } catch (restoreErr) {
          console.warn('No se pudo restaurar el estado de cifrado previo', restoreErr);
        }
      } else {
        Crypto.lock();
      }
      throw new Error('La contraseña no coincide con el backup. No se aplicó el nuevo cifrado.');
    }

    return { migrated: updates.length };
  }

  async function handleDropboxImportFlow({ chosen, serialized, parsedBackup, autoTrigger = false }) {
    recordActivity();
    if (!chosen) return { status: 'cancelled' };
    const baseText = getDropboxBaseText(DropboxSync.getStatus());
    const wasLocked = appSection.classList.contains('hidden');
    try {
      let payload = serialized;
      if (!payload) {
        setAppMessage(`Descargando ${chosen.name}...`, 'muted');
        payload = await DropboxSync.downloadBackup(chosen.path_lower || chosen.path_display || chosen.path);
      }

      let backupData = parsedBackup;
      try {
        if (!backupData) backupData = parseBackupSerialized(payload);
      } catch (err) {
        setAppMessage(err.message || 'Backup inválido.', 'error');
        console.error(err);
        if (wasLocked) lockSection.classList.remove('hidden');
        return { status: 'invalid' };
      }

      const backupEntries = backupData.entries;
      const backupMeta = backupData.meta;
      const originalState = await Crypto.exportState().catch(() => null);
      let session = null;
      let backupPassword = null;

      if (backupMeta && backupMeta.salt && backupMeta.verifier) {
        const promptMsg = autoTrigger
          ? 'Introduce la contraseña del backup encontrado en Dropbox para sincronizarlo (normalmente la misma del diario).'
          : 'Introduce la contraseña usada en este backup (normalmente la misma que usas en el diario).';
        const providedPassword = window.prompt(promptMsg);
        if (!providedPassword) {
          setAppMessage('Sincronización cancelada: se requiere la contraseña del backup.', 'error');
          updateDropboxUI();
          if (wasLocked) lockSection.classList.remove('hidden');
          return { status: 'cancelled' };
        }
        try {
          session = await Crypto.createSession(backupMeta, providedPassword);
          backupPassword = providedPassword;
        } catch (err) {
          setAppMessage('La contraseña no coincide con este backup. No se importó nada.', 'error');
          console.error(err);
          if (wasLocked) lockSection.classList.remove('hidden');
          return { status: 'invalid_password' };
        }
      }

      const localEntries = await DB.listEntries();
      const diff = await buildBackupDiff(localEntries, backupEntries, session ? session.decryptString : undefined);

      const localCount = localEntries.length;
      const hasChanges =
        diff.newEntries.length ||
        diff.conflicts.length ||
        diff.identicalCount !== backupEntries.length ||
        localCount !== backupEntries.length;
      if (!hasChanges) {
        setAppMessage('El backup remoto coincide con tu diario. No se aplicaron cambios.', 'muted');
        updateDropboxUI();
        if (wasLocked) lockSection.classList.remove('hidden');
        rememberRemoteBackup(chosen);
        return { status: 'no_changes' };
      }

      if (autoTrigger) {
        const manual = await handleDropboxImportFlow({ chosen });
        if (!manual || manual.status === 'cancelled') {
          if (wasLocked) lockSection.classList.add('hidden');
        }
        return manual;
      }

      if (wasLocked) lockSection.classList.add('hidden');
      const decision = await openDiffModal(diff, chosen.name);
      if (!decision) {
        setAppMessage('Importación cancelada.', 'muted');
        updateDropboxUI();
        if (wasLocked) lockSection.classList.remove('hidden');
        return { status: 'cancelled' };
      }

      let adoption = { migrated: 0 };
      let resultStatus = decision.action;

      if (decision.action === 'merge') {
        const mergeResult = await mergeBackupEntries(diff);
        await renderEntries();
        if (session && backupMeta) {
          adoption = await adoptBackupState(session, backupMeta, backupPassword, originalState).catch((stateErr) => {
            setAppMessage(stateErr.message, 'error');
            console.error(stateErr);
            throw stateErr;
          });
        }
        const parts = [];
        if (mergeResult.added) parts.push(`${mergeResult.added} nuevas`);
        if (mergeResult.replaced) parts.push(`${mergeResult.replaced} actualizadas`);
        if (adoption.migrated) parts.push(`${adoption.migrated} migradas a la clave compartida`);
        const summary = parts.length ? `Fusionaste ${parts.join(', ')}.` : 'No había entradas para fusionar.';
        setAppMessage(summary, parts.length ? 'success' : 'muted');
      } else {
        const count = await replaceWithBackupEntries(backupEntries);
        await renderEntries();
        if (session && backupMeta) {
          adoption = await adoptBackupState(session, backupMeta, backupPassword, originalState).catch((stateErr) => {
            setAppMessage(stateErr.message, 'error');
            console.error(stateErr);
            throw stateErr;
          });
        }
        let message = `Se reemplazó el diario con ${count} entradas desde ${chosen.name}.`;
        if (adoption.migrated) {
          message += ` (${adoption.migrated} entradas migradas a la clave compartida)`;
        }
        setAppMessage(message, 'success');
        resultStatus = 'replace';
      }

      if (wasLocked && Crypto.isUnlocked()) {
        showApp();
      } else if (wasLocked && !Crypto.isUnlocked()) {
        lockSection.classList.remove('hidden');
      }

      await autoSyncWithDropbox(decision.action === 'merge' ? 'merge' : 'restore');
      await refreshDropboxBackups(baseText, true);
      updateDropboxUI();
      recordActivity();
      return { status: resultStatus, adoption };
    } catch (err) {
      console.error('handleDropboxImportFlow error', err);
      if (!autoTrigger) {
        setAppMessage('No se pudo importar el backup desde Dropbox.', 'error');
      }
      if (wasLocked) lockSection.classList.remove('hidden');
      return { status: 'error', error: err };
    }
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
      const backup = await collectBackupPayload();
      setAppMessage(copy.upload, 'muted');
      const metadata = await DropboxSync.uploadBackup(backup.filename, backup.serialized); console.log("[DropboxSync] upload", metadata);
      rememberRemoteBackup(metadata);
      dropboxBackupsCache = null;
      setAppMessage(copy.success, 'success');
      const state = DropboxSync.getStatus();
      await refreshDropboxBackups(getDropboxBaseText(state), true);
      if (context !== 'restore' && context !== 'merge') {
        latestRemoteMetadata = null;
      }
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
      forgetRemoteBackupMarker();
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

  async function setupAutoSyncPrompt() {
    if (!DropboxSync.isLinked()) return;
    if (!Crypto.isUnlocked()) return;
    try {
      const backups = await getDropboxBackups(true);
      if (!backups.length) return;
      const latest = backups[0];
      latestRemoteMetadata = latest;

      const revisionKey = getBackupRevisionKey(latest);
      if (!revisionKey) return;
      if (autoSyncObservedRevision === revisionKey) return;

      const storedMarker = getStoredRemoteBackupMarker();
      if (storedMarker && storedMarker === revisionKey) {
        autoSyncObservedRevision = revisionKey;
        return;
      }

      const remoteModified = getBackupModifiedMs(latest);
      const lastSync = DropboxSync.getLastSync();
      if (Number.isFinite(remoteModified) && Number.isFinite(lastSync) && remoteModified <= lastSync) {
        rememberRemoteBackup(latest);
        return;
      }

      const prompt = window.confirm('Se encontró un backup más reciente en Dropbox. ¿Quieres abrir el asistente de sincronización ahora?');
      autoSyncObservedRevision = revisionKey;
      if (!prompt) return;

      await handleDropboxImportFlow({ chosen: latest, autoTrigger: true });
    } catch (err) {
      console.error('Sincronización automática falló', err);
    }
  }

  if (dropboxConnectBtn) {
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
  }

  if (recoverDropboxBtn) {
    recoverDropboxBtn.addEventListener('click', async () => {
      if (!DropboxSync.isLinked()) {
        setLockMessage('Conecta Dropbox en este navegador para recuperar el diario.');
        return;
      }
      recoverDropboxBtn.disabled = true;
      try {
        setLockMessage('Buscando backups en Dropbox...');
        const backups = await getDropboxBackups(true);
        if (!backups.length) {
          setLockMessage('No hay backups disponibles en Dropbox.');
          return;
        }
        lockSection.classList.add('hidden');
        const chosen = await openBackupPicker(backups);
        if (!chosen) {
          lockSection.classList.remove('hidden');
          setLockMessage('Recuperación cancelada.');
          return;
        }
        const result = await handleDropboxImportFlow({ chosen, autoTrigger: true });
        if (!result || result.status === 'cancelled') {
          lockSection.classList.remove('hidden');
          setLockMessage('Recuperación cancelada.');
        } else if (Crypto.isUnlocked()) {
          setLockMessage('');
          showApp();
        } else {
          lockSection.classList.remove('hidden');
          setLockMessage('El backup se importó, pero debes introducir la contraseña correcta para desbloquear.');
        }
      } catch (err) {
        console.error('Recuperación desde Dropbox falló', err);
        lockSection.classList.remove('hidden');
        setLockMessage('No se pudo recuperar el backup desde Dropbox. Revisa la consola.');
      } finally {
        recoverDropboxBtn.disabled = false;
      }
    });
  }

  if (dropboxAppKeyInput) {
    const syncAppKey = () => {
      const value = dropboxAppKeyInput.value.trim();
      DropboxSync.setAppKey(value);
      if (dropboxConnectBtn) dropboxConnectBtn.disabled = !value;
    };
    dropboxAppKeyInput.addEventListener('input', syncAppKey);
    dropboxAppKeyInput.addEventListener('change', syncAppKey);
  }

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
      recordActivity();
      dropboxStatus.textContent = `${getDropboxBaseText(DropboxSync.getStatus())} Buscando backups en Dropbox...`;
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
      await handleDropboxImportFlow({ chosen });
    } catch (err) {
      setAppMessage('No se pudo importar el backup desde Dropbox.', 'error');
      console.error(err);
    } finally {
      dropboxImportBtn.disabled = false;
    }
  });

  dropboxDisconnectBtn.addEventListener('click', () => {
    clearInactivityTimer();
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
    recordActivity();

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
      recordActivity();
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
      const backup = await collectBackupPayload();
      downloadBackupFile(backup.filename, backup.serialized);
      if (DropboxSync.isLinked()) {
        setAppMessage('Backup descargado. Subiendo copia a Dropbox...', 'muted');
        try {
          recordActivity();
          const metadata = await DropboxSync.uploadBackup(backup.filename, backup.serialized); console.log("[DropboxSync] upload", metadata);
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

  ['click', 'keydown', 'pointerdown', 'touchstart', 'mousemove'].forEach((evt) => {
    document.addEventListener(evt, recordActivity, true);
  });

  window.addEventListener('focus', recordActivity);
  window.addEventListener('blur', stopInactivityWatcher);

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') {
      stopInactivityWatcher();
    } else {
      recordActivity();
    }
  });

  const hasPassword = await Crypto.hasKey();
  if (hasPassword) {
    showLock('Introduce la contraseña para desbloquear tu diario.');
  } else {
    showLock('Crea una contraseña segura para comenzar.');
  }
})();
