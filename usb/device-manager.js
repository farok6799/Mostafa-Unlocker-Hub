import { ensureWebUsbSupport, setStatus, logRaw, escapeHtml } from './utils.js';

const SAMSUNG = 0x04e8;
const APPLE = 0x05ac;

function serialInfo() {
    if (!('serial' in navigator)) return { supported: false, ports: [] };
    const ports = navigator.serial.getPorts ? navigator.serial.getPorts() : Promise.resolve([]);
    return Promise.resolve(ports).then(items => ({ supported: true, ports: items }));
}

function classifyUsb(device) {
    const vid = Number(device.vendorId);
    const pid = Number(device.productId);
    const name = `${device.productName || ''} ${device.manufacturerName || ''}`.toLowerCase();
    if (vid === APPLE) {
        if (pid === 0x1281) return { family: 'Apple', mode: 'Recovery', transport: 'WebUSB', actions: ['Read Info', 'Exit Recovery'] };
        if (pid === 0x1227 || /dfu|iboot|recovery/.test(name)) return { family: 'Apple', mode: 'DFU / iBoot', transport: 'WebUSB', actions: ['Read Info', 'Read CPID / ECID'] };
        return { family: 'Apple', mode: 'Normal', transport: 'WebUSB', actions: ['Read Info', 'Lockdown requires a native agent'] };
    }
    if (vid === SAMSUNG && [0x685c, 0x685d, 0x685e].includes(pid)) {
        return { family: 'Samsung', mode: 'Download / Odin', transport: 'WebUSB', actions: ['Read Info', 'Reboot'] };
    }
    if (device.classCode === 0xff && device.subclassCode === 0x42) {
        return { family: 'Android', mode: 'Fastboot', transport: 'WebUSB', actions: ['Getvar', 'Reboot'] };
    }
    if (device.classCode === 0x06 || /mtp|portable|android/.test(name)) {
        return { family: 'Android', mode: 'MTP', transport: 'WebUSB', actions: ['Browse Files', 'Upload', 'Download'] };
    }
    if (/adb|android/.test(name)) {
        return { family: 'Android', mode: 'ADB', transport: 'WebUSB', actions: ['Read Info', 'Shell', 'Reboot'] };
    }
    return { family: 'USB', mode: 'Unknown', transport: 'WebUSB', actions: ['Inspect descriptor'] };
}

export async function detectDevices() {
    const result = [];
    if ('usb' in navigator) {
        for (const device of await navigator.usb.getDevices()) result.push({ source: 'WebUSB', device, ...classifyUsb(device) });
    }
    const serial = await serialInfo();
    serial.ports.forEach(port => result.push({ source: 'Web Serial', port, family: 'Samsung', mode: 'Modem / AT', transport: 'Web Serial', actions: ['Read Info', 'AT Console', 'Reboot Modem'] }));
    return result;
}

export async function renderAutoDetect() {
    const list = document.getElementById('detectedDevices');
    const summary = document.getElementById('detectSummary');
    if (!list || !summary) return [];
    try {
        const devices = await detectDevices();
        list.innerHTML = '';
        if (!devices.length) {
            summary.textContent = 'No paired device. Press Connect Device to open the browser picker.';
            list.innerHTML = '<div class="empty-state">Waiting for a USB or Serial device…</div>';
            return devices;
        }
        summary.textContent = `${devices.length} paired transport${devices.length === 1 ? '' : 's'} detected.`;
        devices.forEach(item => {
            const row = document.createElement('div');
            row.className = 'detected-device';
            row.innerHTML = `<div><strong>${escapeHtml(item.device?.productName || item.port?.getInfo?.()?.usbProductId ? 'Samsung serial interface' : item.family)}</strong><span>${escapeHtml(item.family)} · ${escapeHtml(item.mode)} · ${escapeHtml(item.transport)}</span></div><div class="detected-actions">${item.actions.map(action => `<span>${escapeHtml(action)}</span>`).join('')}</div>`;
            list.appendChild(row);
        });
        setStatus(`${devices.length} device transport${devices.length === 1 ? '' : 's'} ready`, 'connected');
        return devices;
    } catch (error) {
        summary.textContent = error.message;
        logRaw(`<div class="notice notice-error"><strong>Auto Detect failed</strong><br>${escapeHtml(error.message)}</div>`);
        return [];
    }
}

export async function connectAndDetect() {
    if (!window.isSecureContext) throw new Error('WebUSB/Web Serial require HTTPS or localhost.');
    if (!('usb' in navigator) && !('serial' in navigator)) throw new Error('This browser exposes neither WebUSB nor Web Serial.');
    if ('usb' in navigator) {
        const device = await navigator.usb.requestDevice({ filters: [{ vendorId: SAMSUNG }, { vendorId: APPLE }, { classCode: 0xff }, { classCode: 0x06 }] });
        logRaw(`<span class="color-green">USB permission granted for ${escapeHtml(device.productName || 'selected device')}.</span>`);
    }
    return renderAutoDetect();
}

export { classifyUsb };
