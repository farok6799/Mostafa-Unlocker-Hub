import { ensureWebUsbSupport, setStatus, logRaw, escapeHtml } from './utils.js';

const SAMSUNG = 0x04e8;
const APPLE = 0x05ac;
const QUALCOMM = 0x05c6;
const MTK = 0x0e8d;
const SPD_VIDS = new Set([0x1782, 0x2e04]);

async function serialInfo() {
    if (!('serial' in navigator)) return { supported: false, ports: [] };
    const ports = await navigator.serial.getPorts();
    return {
        supported: true,
        ports: ports.map(port => {
            const info = port.getInfo?.() || {};
            const isSamsung = Number(info.usbVendorId) === SAMSUNG;
            return {
                source: 'Web Serial', port, family: isSamsung ? 'Samsung' : 'USB Serial',
                mode: isSamsung ? 'Modem / AT candidate · response not yet verified' : 'Serial port · device not identified as Samsung',
                transport: 'Web Serial', actions: ['Pair permission saved', 'Read Info to verify AT']
            };
        })
    };
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
    if (vid === SAMSUNG) return { family: 'Samsung', mode: 'USB mode not identified · AT candidate', transport: 'WebUSB / Web Serial', actions: ['Pair Modem / AT port', 'Verify with Read Info'] };
    if (vid === QUALCOMM && pid === 0x9008) return { family: 'Qualcomm', mode: 'EDL 9008', transport: 'WebUSB OTG', actions: ['Sahara capability check', 'Official Firehose required'] };
    if (vid === MTK) return { family: 'MediaTek', mode: 'BROM / Download', transport: 'WebUSB OTG', actions: ['BROM capability check', 'Official DA required'] };
    if (SPD_VIDS.has(vid)) return { family: 'SPD / Unisoc', mode: 'Processor / Download', transport: 'WebUSB OTG', actions: ['Read Info'] };
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
    serial.ports.forEach(item => result.push(item));
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
            const title = item.source === 'Web Serial' ? `${item.family} serial port` : item.device?.productName || item.family;
            row.innerHTML = `<div><strong>${escapeHtml(title)}</strong><span>${escapeHtml(item.family)} · ${escapeHtml(item.mode)} · ${escapeHtml(item.transport)}</span></div><div class="detected-actions">${item.actions.map(action => `<span>${escapeHtml(action)}</span>`).join('')}</div>`;
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
        const device = await navigator.usb.requestDevice({ filters: [{ vendorId: SAMSUNG }, { vendorId: APPLE }, { vendorId: QUALCOMM }, { vendorId: MTK }, ...[...SPD_VIDS].map(vendorId => ({ vendorId })), { classCode: 0xff }, { classCode: 0x06 }] });
        logRaw(`<span class="color-green">USB permission granted for ${escapeHtml(device.productName || 'selected device')}.</span>`);
    }
    return renderAutoDetect();
}

export { classifyUsb };
