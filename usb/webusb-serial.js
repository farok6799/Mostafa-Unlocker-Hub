import { ensureWebUsbSupport, logRaw, logInfo, escapeHtml, setStatus } from './utils.js';

function findSerialEndpoints(device) {
    for (const iface of device.configuration?.interfaces || []) {
        for (const alt of iface.alternates || []) {
            const out = alt.endpoints?.find(ep => ep.direction === 'out' && ['bulk', 'interrupt'].includes(ep.type));
            const input = alt.endpoints?.find(ep => ep.direction === 'in' && ['bulk', 'interrupt'].includes(ep.type));
            if (out && input) return { iface: iface.interfaceNumber, out: out.endpointNumber, input: input.endpointNumber };
        }
    }
    return null;
}

function decode(data) { return new TextDecoder().decode(data || new Uint8Array()); }

export async function readUsbSerialInfo() {
    ensureWebUsbSupport();
    if (!navigator.usb) throw new Error('WebUSB is unavailable.');
    setStatus('Selecting USB modem interface…');
    const device = await navigator.usb.requestDevice({ filters: [{ classCode: 0x02 }, { classCode: 0x0a }, { classCode: 0xff }] });
    await device.open();
    if (!device.configuration) await device.selectConfiguration(1);
    const endpoints = findSerialEndpoints(device);
    if (!endpoints) throw new Error('No readable/writable bulk or interrupt endpoints were found. This USB interface may not be CDC-ACM.');
    await device.claimInterface(endpoints.iface);
    try {
        await device.controlTransferOut({ requestType: 'class', recipient: 'interface', request: 0x22, value: 0x03, index: endpoints.iface });
    } catch (_) {}
    const writer = async command => {
        await device.transferOut(endpoints.out, new TextEncoder().encode(`${command}\r`));
        const result = await Promise.race([device.transferIn(endpoints.input, 512), new Promise(resolve => setTimeout(() => resolve(null), 1800))]);
        return decode(result?.data ? new Uint8Array(result.data.buffer) : new Uint8Array());
    };
    try {
        logRaw('<div class="log-divider"></div><span class="color-purple"><strong>ANDROID OTG → WEBUSB SERIAL</strong></span>');
        logInfo('Transport', 'WebUSB CDC/vendor bulk fallback');
        for (const [label, command] of [['Handshake', 'AT'], ['Manufacturer', 'AT+CGMI'], ['Model', 'AT+CGMM'], ['Signal', 'AT+CSQ']]) {
            const response = await writer(command);
            logInfo(label, response.replace(/[\r\n]+/g, ' ').trim() || 'No response');
        }
        logRaw('<div class="notice notice-info"><strong>Fallback completed.</strong><br>This path works only when Android exposes the modem/diagnostic interface to WebUSB and the interface provides compatible endpoints.</div>');
        setStatus('WebUSB modem info ready', 'connected');
    } finally {
        try { await device.releaseInterface(endpoints.iface); } catch (_) {}
        try { await device.close(); } catch (_) {}
    }
}
