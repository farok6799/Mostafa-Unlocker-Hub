import { escapeHtml, logRaw, setStatus } from './utils.js';
import { firmwareModelHint, getMappedImageName, inspectFirmwareSelection } from './samsung-firmware.js';
import { closeOdinSession, disposeOdinSession, findPlanItems, flashOdinPlan, openOdinSession } from './samsung-odin-webusb.js';

let mode = 'full';
let selection = null;
let selectedNames = new Set();
let busy = false;
let lastDeviceInfo = null;

const byId = id => document.getElementById(id);
const fileInput = () => byId('samsungFirmwareInput');

function sizeText(bytes) {
    const value = Number(bytes || 0);
    if (value < 1024) return `${value} B`;
    if (value < 1024 ** 2) return `${(value / 1024).toFixed(1)} KB`;
    if (value < 1024 ** 3) return `${(value / 1024 ** 2).toFixed(1)} MB`;
    return `${(value / 1024 ** 3).toFixed(2)} GB`;
}

function setPanelStatus(message, tone = 'info') {
    const node = byId('samsungFlashStatus');
    if (node) {
        node.className = `notice notice-${tone} compact-notice samsung-flash-status`;
        node.textContent = message;
    }
}

function setBusy(value) {
    busy = value;
    ['btnSamsungFlashConnect', 'btnSamsungFlashStart'].forEach(id => {
        const button = byId(id);
        if (button) button.disabled = value;
    });
    if (fileInput()) fileInput().disabled = value;
    document.querySelectorAll('[data-samsung-mode]').forEach(button => { button.disabled = value; });
}

function updateModeUI() {
    document.querySelectorAll('[data-samsung-mode]').forEach(button => {
        button.setAttribute('aria-pressed', String(button.dataset.samsungMode === mode));
    });
    const input = fileInput();
    if (input) {
        input.multiple = mode !== 'direct';
        input.accept = mode === 'direct' ? '.img.lz4' : '.tar.md5,.md5,.tar';
        input.value = '';
    }
    selection = null;
    selectedNames = new Set();
    lastDeviceInfo = null;
    const label = byId('samsungFlashPickLabel');
    const hint = byId('samsungFlashHint');
    if (label) label.textContent = mode === 'direct' ? 'Choose one .img.lz4 image' : mode === 'selective' ? 'Choose TAR.MD5/TAR file(s)' : 'Choose BL / AP / CP / CSC firmware files';
    if (hint) {
        hint.textContent = mode === 'full'
            ? 'Select the extracted official BL, AP, CP and either CSC or HOME_CSC .tar.md5 files together. Do not select PIT or USERDATA here.'
            : mode === 'selective'
                ? 'Select one or more official TAR.MD5/TAR files, then choose the exact image members to flash.'
                : 'Select exactly one standard .img.lz4 file. The image is streamed by LZ4 blocks; the entire image is not loaded into memory.';
    }
    const list = byId('samsungFlashFileList');
    if (list) list.innerHTML = '<div class="empty-state">No firmware files selected.</div>';
    const summary = byId('samsungFlashFileSummary');
    if (summary) summary.textContent = 'Choose files to inspect the archive and list images.';
    const device = byId('samsungFlashDeviceInfo');
    if (device) device.textContent = 'Device not checked. Connect a Samsung phone in Download Mode first.';
    const confirm = byId('samsungFlashConfirm');
    if (confirm) confirm.checked = false;
    setPanelStatus('Ready. File parsing happens locally in this browser.', 'info');
}

function currentImages() {
    if (!selection) return [];
    return selection.images.filter(image => mode !== 'selective' || selectedNames.has(image.name));
}

function renderImageList() {
    const target = byId('samsungFlashFileList');
    const summary = byId('samsungFlashFileSummary');
    if (!target || !summary) return;
    if (!selection?.images?.length) {
        target.innerHTML = '<div class="empty-state">No flashable image members were found.</div>';
        return;
    }

    const selected = currentImages();
    summary.textContent = `${selection.files.length} firmware file(s) · ${selection.images.length} image(s) found · ${selected.length} selected for the current mode.`;
    target.innerHTML = selection.images.map((image, index) => {
        const checked = mode !== 'selective' || selectedNames.has(image.name);
        const control = mode === 'selective'
            ? `<input type="checkbox" data-samsung-image-index="${index}" ${checked ? 'checked' : ''} aria-label="Select ${escapeHtml(image.basename)}">`
            : '<span aria-hidden="true"></span>';
        const slot = image.slot ? ` · ${escapeHtml(image.slot)}` : '';
        const lz4 = image.lz4 ? ` · LZ4 → ${escapeHtml(sizeText(image.flashSize))}${image.lz4.contentChecksum ? ' · content checksum not verified' : ''}` : '';
        return `<div class="samsung-flash-item">${control}<span title="${escapeHtml(image.name)}">${escapeHtml(image.name)}${slot}</span><small>${escapeHtml(sizeText(image.size))}${lz4}</small></div>`;
    }).join('');

    target.querySelectorAll('[data-samsung-image-index]').forEach(input => {
        input.addEventListener('change', event => {
            const image = selection.images[Number(event.currentTarget.dataset.samsungImageIndex)];
            if (!image) return;
            if (event.currentTarget.checked) selectedNames.add(image.name);
            else selectedNames.delete(image.name);
            renderImageList();
        });
    });
}

async function inspectSelection() {
    const input = fileInput();
    if (!input?.files?.length) {
        selection = null;
        renderImageList();
        return;
    }
    setPanelStatus('Inspecting TAR/LZ4 structure…', 'info');
    try {
        selection = await inspectFirmwareSelection(input.files, mode);
        selectedNames = new Set(selection.images.map(image => image.name));
        renderImageList();
        setPanelStatus('Package structure inspected. Device PIT compatibility is checked again before writing.', 'success');
    } catch (error) {
        selection = null;
        selectedNames = new Set();
        renderImageList();
        setPanelStatus(error.message || String(error), 'error');
        logRaw(`<div class="notice notice-error"><strong>Samsung firmware inspection failed</strong><br>${escapeHtml(error.message || error)}</div>`);
    }
}

function selectedFirmwareFiles() {
    return selection?.files || [];
}

function updateDeviceInfo(context) {
    const device = context.device;
    const hint = selection ? firmwareModelHint(selectedFirmwareFiles(), context.pit.cpuBlId) : null;
    lastDeviceInfo = { cpuBlId: context.pit.cpuBlId, modelHint: hint };
    const node = byId('samsungFlashDeviceInfo');
    if (node) {
        const name = device.productName || 'Samsung Download device';
        const matchText = hint ? ` · ${hint.text}` : '';
        node.textContent = `${name} · VID 0x${Number(device.vendorId).toString(16).toUpperCase()} / PID 0x${Number(device.productId).toString(16).toUpperCase()} · PIT ID ${context.pit.cpuBlId || 'N/A'} · ${context.pit.partitions.length} PIT entries · Odin protocol ${context.protocolVersion} · LZ4 compressed transfer ${context.compressedSupported ? 'supported' : 'fallback decode'}${matchText}`;
    }
    return hint;
}

export async function connectSamsungFlashDevice() {
    if (busy) return;
    setBusy(true);
    let context = null;
    setPanelStatus('Requesting USB permission and reading device PIT…', 'info');
    setStatus('Connecting Samsung Download device…');
    try {
        context = await openOdinSession();
        const hint = updateDeviceInfo(context);
        logRaw('<div class="log-divider"></div><span class="color-purple"><strong>SAMSUNG DOWNLOAD PRE-FLIGHT</strong></span>');
        logRaw(`<span class="color-green">Odin handshake verified · PIT contains ${context.pit.partitions.length} entries.</span>`);
        logRaw(`<span class="color-blue">PIT model ID: ${escapeHtml(context.pit.cpuBlId || 'N/A')} · ${escapeHtml(hint?.text || 'Select firmware files to compare model hints.')}</span>`);
        await closeOdinSession(context, false);
        context = null;
        setPanelStatus('Samsung Download device and PIT read successfully. Choose/verify firmware, then start the explicitly confirmed flash.', 'success');
        setStatus('Samsung Download ready', 'connected');
    } catch (error) {
        if (context) await disposeOdinSession(context).catch(() => {});
        setPanelStatus(error.message || String(error), 'error');
        setStatus('Samsung Download pre-flight failed', 'error');
        logRaw(`<div class="notice notice-error"><strong>Samsung device check failed</strong><br>${escapeHtml(error.message || error)}</div>`);
        throw error;
    } finally {
        setBusy(false);
    }
}

function validateFullPlan(items, images) {
    const needed = ['BL', 'AP', 'CP'];
    const hasCsc = images.some(image => image.slot === 'CSC' || image.slot === 'HOME_CSC');
    if (!hasCsc) throw new Error('الحزمة الكاملة لا تتضمن CSC أو HOME_CSC.');
    for (const slot of needed) {
        if (!images.some(image => image.slot === slot)) throw new Error(`ملف ${slot} غير موجود في الحزمة الكاملة.`);
        if (!items.some(item => item.image.slot === slot)) throw new Error(`لم تُطابق أي صورة من ملف ${slot} أقسام PIT الجهاز؛ تم إيقاف التفليش.`);
    }
    if (!items.some(item => item.image.slot === 'CSC' || item.image.slot === 'HOME_CSC')) {
        throw new Error('لم تتطابق صور CSC/HOME_CSC مع PIT الجهاز؛ تم إيقاف التفليش.');
    }
}

export async function startSamsungFirmwareFlash() {
    if (busy) return;
    if (!selection) throw new Error('افحص ملفات الفيرموير أولًا.');
    const acknowledged = byId('samsungFlashConfirm')?.checked;
    if (!acknowledged) throw new Error('فعّل تأكيد الموديل والفيرموير الرسمي قبل بدء الكتابة.');
    let images = currentImages();
    if (!images.length) throw new Error('اختر صورة واحدة على الأقل في الوضع المحدد.');

    setBusy(true);
    let context = null;
    let completed = false;
    const progress = byId('samsungFlashProgressBar');
    const progressLabel = byId('samsungFlashProgressText');
    if (progress) progress.style.width = '0%';
    byId('samsungFlashProgressBar')?.parentElement?.setAttribute('aria-valuenow', '0');
    if (progressLabel) progressLabel.textContent = '0%';
    setPanelStatus('Opening a fresh Odin session and checking the device PIT…', 'info');
    setStatus('Preparing Samsung firmware flash…');

    try {
        context = await openOdinSession();
        const modelHint = updateDeviceInfo(context);
        const { items, skipped } = findPlanItems(images, context.pit);
        if (skipped.length) {
            const details = skipped.map(item => `${item.image.basename}: ${item.reason}`).join('; ');
            throw new Error(`تم إيقاف التفليش: توجد صور مختارة لا تطابق أقسام PIT بدقة (${details}). في الوضع المحدد، أزل تحديد الصور غير المدعومة ثم أعد المحاولة.`);
        }
        if (!items.length) throw new Error('لم توجد صور لها مطابقة دقيقة مع أسماء ملفات PIT في الجهاز.');
        if (mode === 'full') validateFullPlan(items, images);

        const planLines = items.map((item, index) => `${index + 1}. ${item.image.basename} → ${item.part.name || item.part.fileName} (${sizeText(item.image.flashSize)})`);
        const skippedLine = skipped.length ? `\n\nSkipped: ${skipped.map(item => `${item.image.basename} (${item.reason})`).join('; ')}` : '';
        const matchLine = modelHint?.matched ? `\nModel hint: ${modelHint.text}` : `\nModel check: ${modelHint?.text || 'manual confirmation required'}`;
        const reboot = Boolean(byId('samsungFlashAutoReboot')?.checked);
        const prompt = `Samsung Download Mode firmware write\n\nDevice PIT ID: ${context.pit.cpuBlId || 'N/A'}${matchLine}\n\nImages to write:\n${planLines.join('\n')}${skippedLine}\n\nOnly proceed if these are official Samsung firmware files for this exact model/revision. Keep USB connected. Continue?`;
        if (!window.confirm(prompt)) {
            await closeOdinSession(context, false);
            context = null;
            setPanelStatus('Flash cancelled before writing.', 'warning');
            setStatus('Samsung flash cancelled');
            return;
        }

        logRaw('<div class="log-divider"></div><span class="color-purple"><strong>SAMSUNG ODIN FLASH</strong></span>');
        logRaw(`<span class="color-blue">${items.length} PIT-matched image(s); device ID ${escapeHtml(context.pit.cpuBlId || 'N/A')}; Odin protocol ${context.protocolVersion}.</span>`);
        if (skipped.length) logRaw(`<span class="color-blue">Skipped ${skipped.length} non-matching/unsupported file(s); none will be written.</span>`);
        await flashOdinPlan(context, items, {
            onStage: stage => {
                setPanelStatus(stage, 'info');
                setStatus(stage);
                logRaw(`<span class="color-blue">${escapeHtml(stage)}</span>`);
            },
            onProgress: (done, total, current) => {
                const percent = total ? Math.min(100, Math.floor((done / total) * 100)) : 0;
                if (progress) progress.style.width = `${percent}%`;
                byId('samsungFlashProgressBar')?.parentElement?.setAttribute('aria-valuenow', String(percent));
                if (progressLabel) progressLabel.textContent = `${percent}% · ${current}`;
            }
        });
        await closeOdinSession(context, reboot);
        context = null;
        completed = true;
        if (progress) progress.style.width = '100%';
        byId('samsungFlashProgressBar')?.parentElement?.setAttribute('aria-valuenow', '100');
        if (progressLabel) progressLabel.textContent = reboot ? '100% · Complete; reboot requested' : '100% · Complete';
        setPanelStatus(reboot ? 'Official firmware transfer completed. Reboot request sent.' : 'Official firmware transfer completed. Device remains in Download Mode.', 'success');
        setStatus('Samsung firmware flash complete', 'connected');
        logRaw('<span class="color-green">Samsung firmware flash completed. Do not disconnect until the device reports the final state.</span>');
    } catch (error) {
        if (context) await disposeOdinSession(context).catch(() => {});
        setPanelStatus(`Flash stopped: ${error.message || error}. The device may remain in Download Mode; do not unplug until USB activity has stopped.`, 'error');
        setStatus('Samsung firmware flash failed', 'error');
        logRaw(`<div class="notice notice-error"><strong>Samsung flash failed</strong><br>${escapeHtml(error.message || error)}</div>`);
        throw error;
    } finally {
        if (!completed && progressLabel && !progressLabel.textContent) progressLabel.textContent = '0%';
        setBusy(false);
    }
}

export function bindSamsungFlash() {
    document.querySelectorAll('[data-samsung-mode]').forEach(button => {
        button.addEventListener('click', () => {
            if (busy) return;
            mode = button.dataset.samsungMode;
            updateModeUI();
        });
    });
    fileInput()?.addEventListener('change', () => { void inspectSelection(); });
    byId('btnSamsungFlashConnect')?.addEventListener('click', event => {
        event.preventDefault();
        void connectSamsungFlashDevice().catch(() => {});
    });
    byId('btnSamsungFlashStart')?.addEventListener('click', event => {
        event.preventDefault();
        void startSamsungFirmwareFlash().catch(() => {});
    });
    updateModeUI();
}
