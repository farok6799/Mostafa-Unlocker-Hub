import { MTPDevice } from './mtp/mtp_classes.js';
import { logRaw, logInfo, escapeHtml, setStatus } from './utils.js';

let mtpDevice = null;
let activeStorage = null;

function requireSupport() {
    if (!navigator.usb || !window.isSecureContext) throw new Error('MTP requires Chrome/Edge over HTTPS or localhost with WebUSB enabled.');
}

async function loadObjects() {
    const storageIds = await mtpDevice.getStorageIDS(mtpDevice);
    if (!storageIds || !mtpDevice.storageInfoObjects?.length) throw new Error('No MTP storage was returned by the device.');
    for (const storage of mtpDevice.storageInfoObjects) await mtpDevice.getStorageInfo(mtpDevice, storage);
    activeStorage = mtpDevice.storageInfoObjects[0];
    await mtpDevice.getFileObjects(mtpDevice, activeStorage);
    for (const object of activeStorage.objectInfoObjects || []) await mtpDevice.getFileObjectInfo(mtpDevice, activeStorage, object);
    return activeStorage;
}

function formatBytes(bytes) {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function renderStorage(storage) {
    const target = document.getElementById('mtpFileList');
    if (!target) return;
    target.innerHTML = '';
    (storage.objectInfoObjects || []).forEach(object => {
        const row = document.createElement('div');
        row.className = 'mtp-file-row';
        row.innerHTML = `<span>${escapeHtml(object.fileName || 'Unnamed object')}</span><span>${formatBytes(Number(object.filesize || 0))}</span><button class="action-btn" data-mtp-download="${object.fileID}">Download</button>`;
        target.appendChild(row);
    });
    target.querySelectorAll('[data-mtp-download]').forEach(button => button.addEventListener('click', () => download(Number(button.dataset.mtpDownload))));
}

export async function connectMTP() {
    requireSupport();
    setStatus('Selecting Android MTP device…');
    mtpDevice = new MTPDevice();
    const connected = await mtpDevice.connectDevice(mtpDevice);
    if (!connected || !(await mtpDevice.openSession(mtpDevice))) throw new Error('Could not open an MTP session. Unlock the phone and select File Transfer (MTP).');
    const storage = await loadObjects();
    logRaw('<div class="log-divider"></div><span class="color-purple"><strong>ANDROID MTP SESSION</strong></span>');
    logInfo('Device', mtpDevice.device.productName || 'Android device');
    logInfo('Storages', mtpDevice.storageInfoObjects.length);
    logInfo('Files in first storage', storage.objectInfoObjects?.length || 0);
    renderStorage(storage);
    setStatus('Android MTP ready', 'connected');
}

async function download(fileId) {
    if (!mtpDevice || !activeStorage) throw new Error('Connect an MTP device first.');
    const object = activeStorage.objectInfoObjects.find(item => Number(item.fileID) === fileId);
    if (!object) throw new Error('MTP object no longer exists. Refresh the listing.');
    const bytes = await mtpDevice.downloadFile(mtpDevice, activeStorage, object, null);
    const payload = Array.isArray(bytes) ? bytes[1] : bytes;
    const blob = new Blob([Uint8Array.from(payload || [])]);
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = String(object.fileName || 'mtp-download').split('\n')[0];
    link.click();
    URL.revokeObjectURL(link.href);
    logRaw(`<span class="color-green">Downloaded ${escapeHtml(link.download)}.</span>`);
}

export async function uploadMTP(file) {
    if (!mtpDevice || !activeStorage) throw new Error('Connect an MTP device first.');
    const bytes = new Uint8Array(await file.arrayBuffer());
    const info = await mtpDevice.uploadFileInfo(mtpDevice, activeStorage, file.name, bytes.length);
    const objectId = Array.isArray(info) ? info[1] : info;
    await mtpDevice.uploadFile(mtpDevice, activeStorage, objectId, bytes, null);
    logRaw(`<span class="color-green">Uploaded ${escapeHtml(file.name)}.</span>`);
    await connectMTP();
}

export async function disconnectMTP() {
    if (!mtpDevice) return;
    try { await mtpDevice.closeSession(mtpDevice); } finally { await mtpDevice.device?.close().catch(() => {}); mtpDevice = null; activeStorage = null; }
    const target = document.getElementById('mtpFileList');
    if (target) target.innerHTML = '<div class="empty-state">MTP disconnected.</div>';
    setStatus('Waiting for device…');
}
