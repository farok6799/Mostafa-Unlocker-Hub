import { escapeHtml, findInterfaceAndEndpoints, logInfo, logRaw, setStatus } from './utils.js';

const QCOM_VID = 0x05c6;
const QCOM_EDL_PID = 0x9008;
const MTK_VIDS = new Set([0x0e8d, 0x1004]);

function read32(bytes, offset) { return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(offset, true); }
function read64(bytes, offset) { return Number(new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getBigUint64(offset, true)); }
function u32(value) { const out = new Uint8Array(4); new DataView(out.buffer).setUint32(0, value, true); return out; }
function basename(path = '') { return String(path).split(/[\\/]/).pop(); }

async function openVendorDevice(filters) {
    if (!window.isSecureContext || !navigator.usb) throw new Error('EDL/MTK WebUSB يحتاج Chrome أو Edge عبر HTTPS/localhost.');
    const device = await navigator.usb.requestDevice({ filters });
    await device.open();
    if (!device.configuration) await device.selectConfiguration(1);
    const setup = await findInterfaceAndEndpoints(device, 'bulk');
    if (!setup) { await device.close().catch(() => {}); throw new Error('لم يتم العثور على Bulk endpoints في الجهاز.'); }
    return { device, setup };
}

function parseRawprogram(text) {
    const xml = new DOMParser().parseFromString(text, 'application/xml');
    if (xml.querySelector('parsererror')) throw new Error('rawprogram.xml غير صالح.');
    return [...xml.querySelectorAll('program')].map(node => ({
        filename: basename(node.getAttribute('filename') || ''),
        label: node.getAttribute('label') || '',
        startSector: node.getAttribute('start_sector') || '0',
        sectors: node.getAttribute('num_partition_sectors') || '0',
        sectorSize: node.getAttribute('SECTOR_SIZE_IN_BYTES') || '512'
    })).filter(item => item.filename && item.label);
}

function parseScatter(text) {
    const result = []; let current = {};
    for (const line of text.split(/\r?\n/)) {
        const p = line.match(/^\s*-?\s*partition_name\s*:\s*(.+?)\s*$/i);
        const f = line.match(/^\s*file_name\s*:\s*(.+?)\s*$/i);
        if (p) current.label = p[1].replace(/^['"]|['"]$/g, '');
        if (f) current.filename = basename(f[1].replace(/^['"]|['"]$/g, ''));
        if (current.label && current.filename) { result.push({ ...current }); current = {}; }
    }
    return result;
}

export async function inspectEdl() {
    const programmer = document.getElementById('edlProgrammerInput')?.files?.[0];
    if (!programmer) throw new Error('اختر prog_firehose*.elf الرسمي المطابق للجهاز أولًا.');
    const session = await openVendorDevice([{ vendorId: QCOM_VID, productId: QCOM_EDL_PID }]);
    try {
        const { device, setup } = session;
        const first = new Uint8Array((await device.transferIn(setup.endpointIn, 48)).data.buffer);
        const command = read32(first, 0);
        if (command !== 0x01) throw new Error(`الجهاز ليس Sahara HELLO (0x${command.toString(16)}).`);
        const response = new Uint8Array(48); const view = new DataView(response.buffer);
        view.setUint32(0, 0x02, true); view.setUint32(4, 48, true); view.setUint32(8, 2, true); view.setUint32(12, 1, true); view.setUint32(16, 0, true); view.setUint32(20, read32(first, 20), true);
        await device.transferOut(setup.endpointOut, response);
        logRaw('<span class="color-green">Qualcomm EDL Sahara HELLO completed.</span>');
        logInfo('Transport', 'WebUSB OTG'); logInfo('Mode', 'EDL 9008'); logInfo('Programmer', programmer.name);
        logRaw('<div class="notice notice-warning"><strong>Capability check only.</strong><br>تم إكمال Sahara handshake. التفليش الكامل يحتاج Firehose XML/patch مطابقين للجهاز وتحقق توقيع Qualcomm؛ لم يتم إرسال أي write أو erase.</div>');
        setStatus('Qualcomm EDL detected', 'connected');
    } finally { await session.device.releaseInterface(session.setup.interfaceNumber).catch(() => {}); await session.device.close().catch(() => {}); }
}

export async function inspectMtk() {
    const scatter = document.getElementById('mtkScatterInput')?.files?.[0];
    const da = document.getElementById('mtkDaInput')?.files?.[0];
    if (!scatter || !da) throw new Error('اختر Scatter وDownload Agent الرسميين المطابقين للجهاز.');
    const entries = parseScatter(await scatter.text());
    const session = await openVendorDevice([...MTK_VIDS].map(vendorId => ({ vendorId })));
    try {
        const { device, setup } = session;
        await device.transferOut(setup.endpointOut, new Uint8Array([0xa0]));
        const reply = new Uint8Array((await device.transferIn(setup.endpointIn, 16)).data.buffer);
        logRaw(`<span class="color-green">MediaTek BROM USB interface detected.</span>`);
        logInfo('Transport', 'WebUSB OTG'); logInfo('Mode', 'MediaTek BROM/Download'); logInfo('Scatter entries', entries.length); logInfo('Download Agent', da.name);
        logRaw('<div class="notice notice-warning"><strong>Capability check only.</strong><br>MediaTek DA authentication وSLA/DAA تختلف حسب الشركة والموديل. لم يتم رفع DA أو تنفيذ write/erase؛ يلزم دعم موديل محدد واختبار فعلي قبل تفعيل التفليش.</div>');
        setStatus('MediaTek BROM detected', 'connected');
    } finally { await session.device.releaseInterface(session.setup.interfaceNumber).catch(() => {}); await session.device.close().catch(() => {}); }
}

export { parseRawprogram, parseScatter };
