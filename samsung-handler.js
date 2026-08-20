import {
    closeActiveUsbDevice,
    describeUsbError,
    ensureWebUsbSupport,
    findInterfaceAndEndpoints,
    getOrRequestDevice,
    logInfo,
    logRaw,
    escapeHtml,
    releaseUsbInterface,
    setActiveUsbDevice,
    setStatus
} from './utils.js';

const SAMSUNG_VENDOR_ID = 0x04e8;
const DOWNLOAD_FILTERS = [
    { vendorId: SAMSUNG_VENDOR_ID, productId: 0x685d },
    { vendorId: SAMSUNG_VENDOR_ID, productId: 0x685e },
    { vendorId: SAMSUNG_VENDOR_ID, productId: 0x685c }
];

const ODIN_CONTROL_TYPE = 0x64;
const END_SESSION_CONTROL_TYPE = 0x67;
const RESPONSE_SESSION_SETUP = 0x64;
const RESPONSE_END_SESSION = 0x67;
const SESSION_BEGIN = 0;
const SESSION_DEVICE_TYPE = 1;
const SESSION_FILE_PART_SIZE = 5;
const END_SESSION = 0;
const REBOOT_DEVICE = 1;
const DEFAULT_FILE_PART_SIZE = 1024 * 1024;

function uint32le(value) {
    const bytes = new Uint8Array(4);
    new DataView(bytes.buffer).setUint32(0, value >>> 0, true);
    return bytes;
}

function readUint32le(bytes, offset = 0) {
    if (!bytes || bytes.byteLength < offset + 4) return null;
    return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(offset, true);
}

function makeControlPacket(controlType, request, value = null) {
    const packet = new Uint8Array(1024);
    packet.set(uint32le(controlType), 0);
    packet.set(uint32le(request), 4);
    if (value !== null) packet.set(uint32le(value), 8);
    return packet;
}

function bytesToAscii(bytes) {
    return new TextDecoder().decode(bytes).replaceAll('\0', '').trim();
}

async function transferInWithTimeout(device, endpoint, length, timeoutMs = 15000) {
    let timer;
    try {
        return await Promise.race([
            device.transferIn(endpoint, length),
            new Promise((_, reject) => {
                timer = setTimeout(() => reject(new Error(`USB read timeout after ${timeoutMs} ms`)), timeoutMs);
            })
        ]);
    } finally {
        clearTimeout(timer);
    }
}

async function sendBulk(device, endpoint, data, timeoutMs = 5000) {
    const result = await device.transferOut(endpoint, data);
    if (result.status && result.status !== 'ok') {
        throw new Error(`USB transfer failed with status: ${result.status}`);
    }
    return result;
}

async function receiveBytes(device, endpoint, length, timeoutMs = 15000) {
    const result = await transferInWithTimeout(device, endpoint, length, timeoutMs);
    if (!result?.data) throw new Error('USB device returned an empty response.');
    return new Uint8Array(result.data.buffer, result.data.byteOffset, result.data.byteLength);
}

async function receiveResponse(device, endpoints, expectedType, timeoutMs = 15000) {
    const bytes = await receiveBytes(device, endpoints.endpointIn, 8, timeoutMs);
    const responseType = readUint32le(bytes, 0);
    const result = readUint32le(bytes, 4);

    if (responseType !== expectedType) {
        throw new Error(`Unexpected Samsung response type 0x${Number(responseType ?? 0).toString(16).toUpperCase()}.`);
    }
    return result ?? 0;
}

async function initialiseOdin(device, endpoints) {
    await sendBulk(device, endpoints.endpointOut, new TextEncoder().encode('ODIN'), 15000);
    const handshake = await receiveBytes(device, endpoints.endpointIn, 64, 15000);
    const text = bytesToAscii(handshake);

    if (!text.startsWith('LOKE')) {
        throw new Error(`Samsung handshake failed. Expected LOKE, received ${text || 'empty response'}.`);
    }
}

async function sendSessionPacket(device, endpoints, request, value = null, expectedResponse = RESPONSE_SESSION_SETUP, responseTimeout = 10000) {
    await sendBulk(device, endpoints.endpointOut, makeControlPacket(ODIN_CONTROL_TYPE, request, value), 5000);
    return receiveResponse(device, endpoints, expectedResponse, responseTimeout);
}

async function beginSession(device, endpoints) {
    // Some Samsung bootloaders take much longer to answer after sitting idle.
    const deviceDefaultPacketSize = await sendSessionPacket(device, endpoints, SESSION_BEGIN, null, RESPONSE_SESSION_SETUP, 120000);

    if (deviceDefaultPacketSize) {
        const result = await sendSessionPacket(device, endpoints, SESSION_FILE_PART_SIZE, DEFAULT_FILE_PART_SIZE, RESPONSE_SESSION_SETUP, 30000);
        if (result !== 0) throw new Error(`Samsung rejected file-part setup with code ${result}.`);
    }

    return { deviceDefaultPacketSize };
}

async function requestDeviceType(device, endpoints) {
    return sendSessionPacket(device, endpoints, SESSION_DEVICE_TYPE, null, RESPONSE_SESSION_SETUP, 15000);
}

async function endSession(device, endpoints, reboot = false) {
    await sendBulk(device, endpoints.endpointOut, makeControlPacket(END_SESSION_CONTROL_TYPE, END_SESSION), 5000);
    await receiveResponse(device, endpoints, RESPONSE_END_SESSION, 15000);

    if (reboot) {
        await sendBulk(device, endpoints.endpointOut, makeControlPacket(END_SESSION_CONTROL_TYPE, REBOOT_DEVICE), 5000);
        await receiveResponse(device, endpoints, RESPONSE_END_SESSION, 15000);
    }
}

async function openDownloadSession() {
    ensureWebUsbSupport();
    await closeActiveUsbDevice();

    let device = null;
    let endpoints = null;
    try {
        device = await getOrRequestDevice(DOWNLOAD_FILTERS);
        setActiveUsbDevice(device);

        // A paired USBDevice can remain marked as opened while its old LOKE
        // session is stale. Force a clean handle for every new operation.
        try { if (device.opened) await device.close(); } catch (_) {}
        await device.open();
        try { await device.selectConfiguration(1); } catch (_) {}

        endpoints = await findInterfaceAndEndpoints(device, 'bulk');
        if (!endpoints) throw new Error('Samsung Download bulk interface was not found or is already claimed.');

        await initialiseOdin(device, endpoints);
        const session = await beginSession(device, endpoints);
        return { device, endpoints, session };
    } catch (error) {
        await releaseUsbInterface(device, endpoints?.interfaceNumber);
        try { if (device?.opened) await device.close(); } catch (_) {}
        setActiveUsbDevice(null);
        throw error;
    }
}

function formatHex(value, width = 4) {
    if (value === undefined || value === null) return 'N/A';
    return `0x${Number(value).toString(16).padStart(width, '0').toUpperCase()}`;
}

function logDownloadDevice(device, endpoints, session, deviceType) {
    logRaw('<div class="log-divider"></div>');
    logRaw('<span class="color-purple"><strong>SAMSUNG DOWNLOAD SESSION</strong></span>');
    logRaw('<span class="color-green">ODIN → LOKE handshake completed.</span>');
    logInfo('Manufacturer', device.manufacturerName || 'Samsung');
    logInfo('Product', device.productName || 'Samsung Download Device');
    logInfo('Vendor ID', formatHex(device.vendorId));
    logInfo('Product ID', formatHex(device.productId));
    logInfo('USB Version', `${device.usbVersionMajor ?? 0}.${device.usbVersionMinor ?? 0}`);
    logInfo('Serial', device.serialNumber || 'N/A');
    logInfo('Interface', endpoints.interfaceNumber);
    logInfo('Bulk OUT', endpoints.endpointOut);
    logInfo('Bulk IN', endpoints.endpointIn);
    logInfo('Session packet size', session.deviceDefaultPacketSize || 'Device default');
    logInfo('Device type response', deviceType ?? 'N/A');
    logRaw('<div class="notice notice-info"><strong>Verified data only.</strong><br>CSC, AP version, storage, DID, and serial details are not fabricated here; they require additional model-specific Odin/PIT packets and will show as unavailable until implemented.</div>');
}

function logDownloadError(error) {
    const info = describeUsbError(error);
    logRaw(`<div class="notice notice-error"><strong>Download Mode read failed</strong><br>${info.title}: ${info.detail}</div>`);
    if (/timeout|stale|LOKE|handshake/i.test(error?.message || '')) {
        logRaw('<div class="notice notice-warning"><strong>Download session timeout:</strong><br>The page already retried with a fresh USB handle. If the next attempt fails too, unplug and reconnect the cable while keeping the phone in Download Mode.</div>');
    }
    if (/interface|claim|access|permission/i.test(error?.message || '')) {
        logRaw('<div class="notice notice-warning"><strong>Driver note:</strong><br>Close Odin, Smart Switch, Kies, and other Samsung tools. On Windows, use a WinUSB-compatible driver only when the device is in Download Mode. On Linux, a udev rule or permission adjustment may be required.</div>');
    }
}

async function closeDownloadSession(context, reboot = false) {
    if (!context) return;
    try {
        if (context.device?.opened && context.endSession) await context.endSession(reboot);
    } catch (error) {
        logRaw(`<span class="color-blue">Session close note: ${error.message}</span>`);
    } finally {
        await releaseUsbInterface(context.device, context.endpoints?.interfaceNumber);
        await closeActiveUsbDevice();
        setActiveUsbDevice(null);
    }
}

async function openDownloadSessionWithRetry() {
    let lastError;
    for (let attempt = 1; attempt <= 2; attempt++) {
        try {
            return await openDownloadSession();
        } catch (error) {
            lastError = error;
            if (error?.name === 'NotFoundError' || error?.name === 'AbortError' || attempt === 2) throw error;
            logRaw('<span class="color-blue">The previous Samsung session was stale; reopening the USB handle…</span>');
            await closeActiveUsbDevice();
            await new Promise(resolve => setTimeout(resolve, 700));
        }
    }
    throw lastError;
}

export async function readDownloadInfo() {
    let context = null;
    setStatus('Opening Samsung Download Mode…');

    try {
        context = await openDownloadSessionWithRetry();
        const deviceType = await requestDeviceType(context.device, context.endpoints);
        logDownloadDevice(context.device, context.endpoints, context.session, deviceType);
        setStatus('Samsung Download ready', 'connected');
    } catch (error) {
        logDownloadError(error);
        setStatus('Samsung Download error', 'error');
    } finally {
        if (context) {
            context.endSession = (reboot = false) => endSession(context.device, context.endpoints, reboot);
        }
        await closeDownloadSession(context, false);
    }
}

export async function odinReboot() {
    let context = null;
    setStatus('Preparing Samsung reboot…');

    try {
        context = await openDownloadSessionWithRetry();
        logRaw('<div class="log-divider"></div>');
        logRaw('<span class="color-blue"><strong>Samsung Download reboot</strong></span>');
        await endSession(context.device, context.endpoints, true);
        logRaw('<span class="color-green">Reboot request accepted by the Samsung Download session.</span>');
        setStatus('Samsung reboot sent', 'connected');
    } catch (error) {
        logDownloadError(error);
        setStatus('Samsung reboot error', 'error');
    } finally {
        if (context) {
            context.endSession = () => Promise.resolve();
        }
        await closeDownloadSession(context, false);
    }
}

async function requestSerialPort() {
    if (!('serial' in navigator)) {
        throw new Error('Web Serial is not supported. Use Chrome or Edge over HTTPS on desktop.');
    }

    try {
        return await navigator.serial.requestPort({ filters: [{ usbVendorId: SAMSUNG_VENDOR_ID }] });
    } catch (error) {
        if (error?.name === 'NotFoundError') throw error;
        return navigator.serial.requestPort({});
    }
}

async function openSerialSession() {
    const port = await requestSerialPort();
    if (!port.readable || !port.writable) {
        await port.open({ baudRate: 115200, dataBits: 8, stopBits: 1, parity: 'none', flowControl: 'none', bufferSize: 4096 });
    }

    if (!port.readable || !port.writable) throw new Error('The selected device did not expose readable and writable Serial streams.');
    return port;
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function readSerialResponse(port, timeoutMs = 2500) {
    const reader = port.readable?.getReader();
    if (!reader) throw new Error('Serial readable stream is unavailable.');

    let response = '';
    const deadline = Date.now() + timeoutMs;

    try {
        while (Date.now() < deadline) {
            const remaining = Math.max(50, Math.min(450, deadline - Date.now()));
            const result = await Promise.race([
                reader.read(),
                sleep(remaining).then(() => ({ timedOut: true }))
            ]);

            if (result.timedOut) break;
            if (result.done) break;
            if (result.value) response += new TextDecoder().decode(result.value);
            if (/\b(?:OK|ERROR|COMMAND NOT SUPPORT)\b/i.test(response)) break;
        }
    } finally {
        try { await reader.cancel(); } catch (_) {}
        reader.releaseLock();
    }

    return response;
}

async function sendSerialCommand(port, writer, command, timeoutMs = 2500) {
    const normalized = String(command || '').trim().replace(/[\r\n]+/g, '');
    if (!/^AT(?:[+?=].*)?$/i.test(normalized)) {
        throw new Error('AT command must start with AT and contain no line breaks.');
    }

    await writer.write(new TextEncoder().encode(`${normalized}\r`));
    return readSerialResponse(port, timeoutMs);
}

function extractAtValue(response, command) {
    const commandUpper = command.toUpperCase();
    const lines = String(response || '').split(/\r?\n/).map(line => line.trim()).filter(Boolean);
    const useful = lines.filter(line => {
        const upper = line.toUpperCase();
        return upper !== commandUpper && upper !== 'OK' && !upper.startsWith('ERROR') && !upper.startsWith('COMMAND NOT');
    });
    return useful.join(' | ') || 'N/A';
}

function logAtResult(label, command, response) {
    const value = extractAtValue(response, command);
    logInfo(label, value);
    logRaw(`<span class="color-blue">${command} → ${response ? 'response received' : 'no response'}</span>`);
}

async function closeSerialSession(port, writer) {
    try { writer?.releaseLock(); } catch (_) {}
    try {
        if (port?.readable) {
            const reader = port.readable.getReader();
            await reader.cancel();
            reader.releaseLock();
        }
    } catch (_) {}
    try { await port?.close(); } catch (_) {}
}

function logSerialError(error) {
    logRaw(`<div class="notice notice-error"><strong>Modem/AT error</strong><br>${error?.message || error}</div>`);
    logRaw('<div class="notice notice-warning"><strong>Important:</strong><br>AT is available only when the selected Android/Samsung driver exposes a modem or diagnostic Serial port. MTP itself is not an AT channel.</div>');
}

export async function handleMTP() {
    let port = null;
    let writer = null;
    setStatus('Opening Modem/AT serial port…');

    try {
        port = await openSerialSession();
        writer = port.writable.getWriter();
        logRaw('<div class="log-divider"></div>');
        logRaw('<span class="color-purple"><strong>MODEM / AT SERIAL SESSION</strong></span>');
        logRaw('<span class="color-blue">Web Serial port opened at 115200 8N1.</span>');

        const commands = [
            ['Handshake', 'AT'],
            ['Model', 'AT+GMM'],
            ['IMEI / Serial', 'AT+CGSN'],
            ['Modem revision', 'AT+CGMR'],
            ['Signal', 'AT+CSQ'],
            ['SIM state', 'AT+CPIN?']
        ];

        for (const [label, command] of commands) {
            const response = await sendSerialCommand(port, writer, command);
            logAtResult(label, command, response);
        }

        logRaw('<div class="notice notice-info"><strong>Read-only information flow completed.</strong><br>No configuration-changing AT command was sent automatically.</div>');
        setStatus('Modem info ready', 'connected');
    } catch (error) {
        logSerialError(error);
        setStatus('Modem/AT error', 'error');
    } finally {
        await closeSerialSession(port, writer);
    }
}

export async function sendATCommand(command) {
    let port = null;
    let writer = null;

    try {
        port = await openSerialSession();
        writer = port.writable.getWriter();
        const response = await sendSerialCommand(port, writer, command, 3500);
        logRaw(`<div class="log-divider"></div><span class="color-blue"><strong>AT command:</strong> ${escapeHtml(command)}</span>`);
        logRaw(`<pre class="serial-response">${escapeHtml(response || 'No response')}</pre>`);
        return response;
    } finally {
        await closeSerialSession(port, writer);
    }
}
