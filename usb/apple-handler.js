import {
    closeActiveUsbDevice,
    describeUsbError,
    ensureWebUsbSupport,
    getOrRequestDevice,
    logInfo,
    logRaw,
    setActiveUsbDevice,
    setStatus
} from './utils.js';

const APPLE_VENDOR_ID = 0x05ac;
const APPLE_FILTERS = [{ vendorId: APPLE_VENDOR_ID }];
const RECOVERY_PRODUCT_ID = 0x1281;

function formatHex(value, width = 4) {
    if (value === undefined || value === null || value === '') return 'N/A';
    const normalized = String(value).replace(/^0x/i, '');
    return `0x${normalized.padStart(width, '0').toUpperCase()}`;
}

function parseAppleDescriptor(rawDescriptor = '') {
    const descriptor = String(rawDescriptor).trim();
    const values = {};
    const tokenPattern = /([A-Z][A-Z0-9]+):(?:\[([^\]]+)\]|([^\s]+))/g;

    for (const match of descriptor.matchAll(tokenPattern)) {
        values[match[1]] = (match[2] || match[3] || '').trim();
    }

    return { raw: descriptor, values };
}

function identifyAppleMode(device, descriptor) {
    const productId = Number(device.productId);
    if (productId === RECOVERY_PRODUCT_ID) return 'Recovery Mode';
    if (/\bCPID:|\bPWND:|\bSRTG:/i.test(descriptor)) return 'DFU / iBoot Mode';
    if (productId === 0x12a8 || productId === 0x12a0) return 'Normal Mode';
    return 'Apple USB Mode';
}

function writeConnectionHeader(mode) {
    logRaw('<div class="log-divider"></div>');
    logRaw('<span class="color-purple"><strong>APPLE USB SESSION</strong></span>');
    logRaw(`<span class="color-blue">Reading device metadata · ${mode}</span>`);
}

function writeDeviceInfo(device) {
    const rawDescriptor = device.serialNumber || '';
    const parsed = parseAppleDescriptor(rawDescriptor);
    const mode = identifyAppleMode(device, rawDescriptor);

    writeConnectionHeader(mode);
    logRaw(`<span class="color-green">Device connected: ${device.productName || 'Apple device'}</span>`);
    logInfo('Mode', mode);
    logInfo('Product', device.productName || 'iPhone / iPad');
    logInfo('Vendor ID', formatHex(device.vendorId));
    logInfo('Product ID', formatHex(device.productId));
    logInfo('USB Version', `${device.usbVersionMajor ?? 0}.${device.usbVersionMinor ?? 0}`);

    if (parsed.values.CPID) logInfo('CPID', formatHex(parsed.values.CPID));
    if (parsed.values.CPRV) logInfo('CPRV', formatHex(parsed.values.CPRV, 2));
    if (parsed.values.CPFM) logInfo('CPFM', formatHex(parsed.values.CPFM, 2));
    if (parsed.values.SCEP) logInfo('SCEP', formatHex(parsed.values.SCEP, 2));
    if (parsed.values.BDID) logInfo('BDID', formatHex(parsed.values.BDID, 2));
    if (parsed.values.ECID) logInfo('ECID', parsed.values.ECID);
    if (parsed.values.IBFL) logInfo('IBFL', formatHex(parsed.values.IBFL, 2));
    if (parsed.values.SRTG) logInfo('SRTG', parsed.values.SRTG);
    if (parsed.values.PWND) logInfo('PWND', parsed.values.PWND);
    if (!parsed.raw) logInfo('UDID / Serial', device.serialNumber || 'Not exposed by this USB mode');

    if (mode === 'DFU / iBoot Mode') {
        logRaw('<div class="notice notice-info"><strong>DFU metadata detected.</strong> CPID/ECID values are available from the device descriptor. Deep iOS data such as IMEI and passcode state is not exposed by WebUSB in DFU mode.</div>');
    } else if (mode === 'Normal Mode') {
        logRaw('<div class="notice notice-info"><strong>Normal mode limitation.</strong> Browser security does not expose paired Lockdown data through WebUSB. Use Recovery/DFU for boot metadata.</div>');
    }

    logRaw('<span class="color-green">Apple metadata read completed.</span>');
}

function writeAppleError(error) {
    const info = describeUsbError(error);
    logRaw(`<div class="notice notice-error"><strong>${info.title}</strong><br>${info.detail}</div>`);

    if (info.title === 'USB access was denied') {
        logRaw('<div class="notice notice-warning"><strong>Windows checklist:</strong><br>Close iTunes, 3uTools, Finder sync, Apple Devices, and any other Apple USB utility. In Device Manager/Zadig, use a WinUSB-compatible driver for the DFU device, then reconnect it and press Read Info again. The page must be opened over HTTPS in Chrome or Edge.</div>');
    }
}

export async function readAppleInfo() {
    setStatus('Searching for Apple device…');

    try {
        ensureWebUsbSupport();
        const device = await getOrRequestDevice(APPLE_FILTERS);
        setActiveUsbDevice(device);
        writeDeviceInfo(device);
        setStatus('Apple device ready', 'connected');
    } catch (error) {
        writeAppleError(error);
        setStatus('USB access error', 'error');
    } finally {
        await closeActiveUsbDevice();
        setActiveUsbDevice(null);
    }
}

export async function enterAppleRecovery() {
    setStatus('Checking Apple device…');

    try {
        ensureWebUsbSupport();
        const device = await getOrRequestDevice([{ vendorId: APPLE_VENDOR_ID, productId: 0x12a8 }]);
        logRaw('<div class="log-divider"></div>');
        logRaw('<span class="color-blue"><strong>Recovery mode request</strong></span>');
        logRaw('<div class="notice notice-warning">A browser page cannot create a trusted Lockdown session for a normal iPhone. Use the hardware sequence: Volume Up, Volume Down, then hold the Side button until Recovery Mode appears.</div>');
        logInfo('Connected device', device.productName || 'Apple device');
        setStatus('Manual recovery sequence required');
    } catch (error) {
        writeAppleError(error);
        setStatus('Recovery request failed', 'error');
    } finally {
        await closeActiveUsbDevice();
        setActiveUsbDevice(null);
    }
}

export async function exitAppleRecovery() {
    setStatus('Searching for Recovery device…');

    try {
        ensureWebUsbSupport();
        const device = await getOrRequestDevice([{ vendorId: APPLE_VENDOR_ID, productId: RECOVERY_PRODUCT_ID }]);
        logRaw('<div class="log-divider"></div>');
        logRaw('<span class="color-blue"><strong>Recovery session detected</strong></span>');

        if (device.configuration === null) await device.selectConfiguration(1);
        await device.claimInterface(0);
        await device.controlTransferOut({
            requestType: 'vendor',
            recipient: 'device',
            request: 0,
            value: 0,
            index: 0
        }, new TextEncoder().encode('reboot\0'));

        logRaw('<span class="color-green">Recovery reboot command sent. The device should restart.</span>');
        setStatus('Recovery reboot sent', 'connected');
    } catch (error) {
        writeAppleError(error);
        setStatus('Recovery access error', 'error');
    } finally {
        await closeActiveUsbDevice();
        setActiveUsbDevice(null);
    }
}
