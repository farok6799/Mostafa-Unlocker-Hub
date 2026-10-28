import { findInterfaceAndEndpoints, logInfo, logRaw, setStatus } from './utils.js';

const SPD_VIDS = [0x1782, 0x2e04];

function hex(value, width = 4) { return `0x${Number(value || 0).toString(16).padStart(width, '0')}`; }

function describeInterfaces(device) {
    return (device.configuration?.interfaces || []).flatMap(iface => (iface.alternates || []).map(alt => ({
        number: iface.interfaceNumber,
        alternate: alt.alternateSetting || 0,
        classCode: hex(alt.interfaceClass, 2),
        subclass: hex(alt.interfaceSubclass, 2),
        protocol: hex(alt.interfaceProtocol, 2),
        endpoints: (alt.endpoints || []).map(endpoint => `${endpoint.direction}:${endpoint.type}#${endpoint.endpointNumber}`).join(', ') || 'none'
    })));
}

export async function readSpdInfo() {
    if (!window.isSecureContext || !navigator.usb) throw new Error('SPD WebUSB يحتاج Chrome/Edge عبر HTTPS أو localhost.');
    setStatus('Selecting SPD / Spreadtrum device…');
    const device = await navigator.usb.requestDevice({ filters: SPD_VIDS.map(vendorId => ({ vendorId })) });
    let opened = false;
    let claimedInterface;
    try {
        await device.open(); opened = true;
        if (!device.configuration) await device.selectConfiguration(1);
        const interfaces = describeInterfaces(device);
        logRaw('<div class="log-divider"></div><span class="color-purple"><strong>SPD / SPREADTRUM READ INFO</strong></span>');
        logInfo('Transport', 'WebUSB OTG');
        logInfo('USB VID:PID', `${hex(device.vendorId)}:${hex(device.productId)}`);
        logInfo('Product', device.productName || 'Unknown');
        logInfo('Manufacturer', device.manufacturerName || 'Unknown');
        logInfo('Serial', device.serialNumber || 'Unavailable');
        logInfo('Configuration', device.configuration?.configurationValue ?? 'Unknown');
        interfaces.forEach((item, index) => logInfo(`Interface ${index + 1}`, `#${item.number}/${item.alternate} class ${item.classCode}/${item.subclass}/${item.protocol} · ${item.endpoints}`));
        const bulk = await findInterfaceAndEndpoints(device, 'bulk').catch(() => null);
        if (bulk) {
            claimedInterface = bulk.interfaceNumber;
            logInfo('Processor mode', 'SPD/Unisoc vendor USB interface detected');
            logInfo('Bulk endpoints', `${bulk.endpointOut} OUT / ${bulk.endpointIn} IN`);
        } else {
            logInfo('Processor mode', 'SPD VID detected; no bulk pair exposed to WebUSB');
        }
        logRaw('<div class="notice notice-info"><strong>Read-only scan completed.</strong><br>لم يتم إرسال أوامر تحميل أو كتابة. التفليش الكامل لـ SPD يحتاج بروتوكول PAC/Download Agent مطابقًا للموديل.</div>');
        setStatus('SPD info ready', 'connected');
    } finally {
        if (claimedInterface !== undefined) await device.releaseInterface(claimedInterface).catch(() => {});
        if (opened) await device.close().catch(() => {});
    }
}

export function isSpdDevice(device) {
    return SPD_VIDS.includes(Number(device?.vendorId));
}

export { SPD_VIDS };
