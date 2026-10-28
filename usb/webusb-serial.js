import { ensureWebUsbSupport, logRaw, logInfo, escapeHtml, setStatus } from './utils.js';

const SAMSUNG_VENDOR_ID = 0x04e8;
const CDC_COMM = 0x02;
const CDC_DATA = 0x0a;
const VENDOR_SPECIFIC = 0xff;
const ADB_SUBCLASS = 0x42;

function findSerialCandidates(device) {
    const interfaces = device.configuration?.interfaces || [];
    const controls = interfaces.filter(iface => (iface.alternates || []).some(alt =>
        alt.interfaceClass === CDC_COMM && alt.interfaceSubclass === 0x02 && alt.interfaceProtocol === 0x01
    ));
    const candidates = [];
    for (const iface of interfaces) {
        for (const alt of iface.alternates || []) {
            const endpoints = alt.endpoints || [];
            const bulkOut = endpoints.find(ep => ep.direction === 'out' && ep.type === 'bulk');
            const bulkIn = endpoints.find(ep => ep.direction === 'in' && ep.type === 'bulk');
            const fallbackOut = endpoints.find(ep => ep.direction === 'out' && ['bulk', 'interrupt'].includes(ep.type));
            const fallbackIn = endpoints.find(ep => ep.direction === 'in' && ['bulk', 'interrupt'].includes(ep.type));
            const out = bulkOut || fallbackOut;
            const input = bulkIn || fallbackIn;
            if (!out || !input) continue;

            let priority;
            let kind;
            let controlInterface = null;
            if (alt.interfaceClass === CDC_DATA) {
                priority = 0;
                kind = 'CDC modem data';
                const control = controls.find(item => item.interfaceNumber < iface.interfaceNumber) || controls[0];
                if (control) controlInterface = control.interfaceNumber;
            } else if (alt.interfaceClass === VENDOR_SPECIFIC && !(alt.interfaceSubclass === ADB_SUBCLASS && alt.interfaceProtocol === 0x01)) {
                priority = alt.interfaceProtocol === 0x01 ? 1 : 2;
                kind = 'vendor-specific modem candidate';
            } else if (alt.interfaceClass === CDC_COMM && alt.interfaceSubclass === 0x02) {
                priority = 3;
                kind = 'CDC ACM candidate';
                controlInterface = iface.interfaceNumber;
            } else {
                continue;
            }
            candidates.push({
                interfaceNumber: iface.interfaceNumber,
                alternateSetting: alt.alternateSetting || 0,
                endpointOut: out.endpointNumber,
                endpointIn: input.endpointNumber,
                controlInterface,
                interfaceClass: alt.interfaceClass,
                interfaceSubclass: alt.interfaceSubclass,
                interfaceProtocol: alt.interfaceProtocol,
                kind,
                priority
            });
        }
    }
    candidates.sort((a, b) => a.priority - b.priority || a.interfaceNumber - b.interfaceNumber || a.alternateSetting - b.alternateSetting);
    const seen = new Set();
    return candidates.filter(candidate => {
        const key = `${candidate.interfaceNumber}:${candidate.alternateSetting}:${candidate.endpointIn}:${candidate.endpointOut}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
    });
}

function decode(data) {
    return new TextDecoder().decode(data || new Uint8Array());
}

function hasAtReply(response) {
    return /(?:^|[\r\n])\s*(?:OK|ERROR|COMMAND NOT SUPPORT)\s*(?:[\r\n]|$)/i.test(response.replaceAll('\0', ''));
}

async function withTimeout(promise, timeoutMs, message) {
    let timer;
    try {
        return await Promise.race([
            promise,
            new Promise((_, reject) => {
                timer = setTimeout(() => {
                    const error = new Error(message);
                    error.name = 'TimeoutError';
                    reject(error);
                }, timeoutMs);
            })
        ]);
    } finally {
        clearTimeout(timer);
    }
}

async function sendAtAndRead(device, candidate, command, timeoutMs = 2400) {
    const written = await device.transferOut(candidate.endpointOut, new TextEncoder().encode(`${command}\r\n`));
    if (written?.status && written.status !== 'ok') throw new Error(`AT write status: ${written.status}.`);
    let response = '';
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        const remaining = deadline - Date.now();
        let result;
        try {
            result = await withTimeout(device.transferIn(candidate.endpointIn, 512), Math.min(remaining, 900), 'AT response timeout.');
        } catch (error) {
            if (error?.name === 'TimeoutError') break;
            throw error;
        }
        if (result?.status && result.status !== 'ok') throw new Error(`AT read status: ${result.status}.`);
        if (!result?.data?.byteLength) continue;
        const data = new Uint8Array(result.data.buffer, result.data.byteOffset, result.data.byteLength);
        response += decode(data);
        if (hasAtReply(response)) break;
    }
    return response;
}

async function configureCdcControl(device, candidate) {
    if (candidate.controlInterface === null) return;
    const index = candidate.controlInterface;
    await device.controlTransferOut(
        { requestType: 'class', recipient: 'interface', request: 0x20, value: 0, index },
        new Uint8Array([0x00, 0xC2, 0x01, 0x00, 0x00, 0x00, 0x08])
    );
    await device.controlTransferOut({ requestType: 'class', recipient: 'interface', request: 0x22, value: 0x03, index });
}

export async function readUsbSerialInfo() {
    ensureWebUsbSupport();
    if (!navigator.usb) throw new Error('WebUSB is unavailable.');
    setStatus('Scanning USB interfaces for a modem / AT port…');
    const device = await navigator.usb.requestDevice({
        filters: [{ vendorId: SAMSUNG_VENDOR_ID }, { classCode: CDC_COMM }, { classCode: CDC_DATA }, { classCode: VENDOR_SPECIFIC }]
    });
    if (device.opened) throw new Error('The selected USB device is already open in another page operation. Close that operation and retry.');
    let opened = false;
    try {
        await device.open();
        opened = true;
        if (!device.configuration) await device.selectConfiguration(1);
        const candidates = findSerialCandidates(device);
        logRaw('<div class="log-divider"></div><span class="color-purple"><strong>ANDROID OTG → WEBUSB AT DETECTION</strong></span>');
        logInfo('USB device', `${device.productName || 'Samsung USB device'} · VID 0x${Number(device.vendorId).toString(16).toUpperCase()} / PID 0x${Number(device.productId).toString(16).toUpperCase()}`);
        logInfo('Interface scan', `${candidates.length} CDC/vendor-specific serial candidate(s); ADB and MTP-only interfaces are not treated as AT ports.`);

        let lastError = null;
        for (const candidate of candidates) {
            let claimed = false;
            let controlClaimed = false;
            try {
                if (candidate.controlInterface !== null && candidate.controlInterface !== candidate.interfaceNumber) {
                    await device.claimInterface(candidate.controlInterface);
                    controlClaimed = true;
                }
                await device.claimInterface(candidate.interfaceNumber);
                claimed = true;
                try { await device.selectAlternateInterface(candidate.interfaceNumber, candidate.alternateSetting); } catch (_) {}
                try { await configureCdcControl(device, candidate); } catch (_) {}
                logInfo('Candidate', `${candidate.kind} · interface ${candidate.interfaceNumber} · endpoints ${candidate.endpointIn}/${candidate.endpointOut}`);
                const handshake = await sendAtAndRead(device, candidate, 'AT');
                if (!hasAtReply(handshake)) {
                    logInfo('AT handshake', 'No modem response on this interface; trying the next candidate.');
                    continue;
                }
                logInfo('AT handshake', handshake.replace(/[\r\n]+/g, ' ').trim());
                for (const [label, command] of [['Manufacturer', 'AT+CGMI'], ['Model', 'AT+CGMM'], ['Signal', 'AT+CSQ']]) {
                    try {
                        const response = await sendAtAndRead(device, candidate, command, 1800);
                        logInfo(label, response.replace(/[\r\n]+/g, ' ').trim() || 'No response');
                    } catch (error) {
                        logInfo(label, error?.name === 'TimeoutError' ? 'No response' : error.message || String(error));
                    }
                }
                logRaw('<div class="notice notice-success"><strong>AT interface detected.</strong><br>The selected USB interface returned an AT result. CDC data interfaces are prioritized, followed by Samsung/vendor-specific bulk candidates.</div>');
                setStatus('WebUSB AT interface detected', 'connected');
                return { detected: true, interface: candidate };
            } catch (error) {
                lastError = error;
                logInfo('Candidate result', error.message || String(error));
            } finally {
                if (claimed) {
                    try { await device.releaseInterface(candidate.interfaceNumber); } catch (_) {}
                }
                if (controlClaimed) {
                    try { await device.releaseInterface(candidate.controlInterface); } catch (_) {}
                }
            }
        }
        const message = candidates.length
            ? 'USB interfaces were scanned, but none returned an AT response. Confirm that the phone exposes a Modem/Diagnostic interface; MTP and ADB alone are not AT ports.'
            : 'No CDC-Data, CDC-ACM, or vendor-specific bulk serial interface was exposed to WebUSB. The browser cannot inspect interfaces hidden by Android or the USB driver.';
        logRaw(`<div class="notice notice-warning"><strong>AT interface not detected.</strong><br>${escapeHtml(message)}${lastError ? `<br>Last interface error: ${escapeHtml(lastError.message || lastError)}` : ''}</div>`);
        setStatus('WebUSB AT interface not detected', 'error');
        return { detected: false, candidateCount: candidates.length };
    } finally {
        if (opened) {
            try { await device.close(); } catch (_) {}
        }
    }
}
