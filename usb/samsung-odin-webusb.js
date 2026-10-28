import { activeUsbDevice, ensureWebUsbSupport, releaseUsbInterface, setActiveUsbDevice } from './utils.js';
import { decompressLz4Block, getMappedImageName, readLz4Blocks } from './samsung-firmware.js';

const SAMSUNG_VENDOR_ID = 0x04e8;
const RQT = { INIT: 100, PIT: 101, XMIT: 102, CLOSE: 103, SUPER: 106 };
const PARAM = {
    INIT_TARGET: 0, INIT_TOTALSIZE: 2, INIT_PACKETSIZE: 5,
    PIT_GET: 1, PIT_START: 2, PIT_COMPLETE: 3,
    XMIT_DOWNLOAD: 0, XMIT_START: 2, XMIT_COMPLETE: 3, XMIT_COMPRESSED_DOWNLOAD: 5,
    XMIT_COMPRESSED_START: 6, XMIT_COMPRESSED_COMPLETE: 7,
    CLOSE_END: 0, CLOSE_REBOOT: 1, SUPER_USED_BLOCKS: 0
};
const DATA_PACKET_V2 = 1024 * 1024;
const DATA_PACKET_OLD = 128 * 1024;
const RAW_WINDOW = 30 * 1024 * 1024;
const START_ALIGN = 128 * 1024;

async function withTimeout(promise, timeoutMs, message) {
    let timer;
    try {
        return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(message)), timeoutMs); })]);
    } finally { clearTimeout(timer); }
}

function makeRequest(command, parameter, ints = []) {
    const packet = new Uint8Array(1024);
    const view = new DataView(packet.buffer);
    view.setInt32(0, command, true);
    view.setInt32(4, parameter, true);
    ints.slice(0, 9).forEach((value, index) => view.setInt32(8 + index * 4, Number(value) | 0, true));
    return packet;
}

function describeAck(ack) {
    const messages = {
        '-1': 'unsupported binary', '-2': 'write protection failure', '-4': 'write failed', '-5': 'secure check failed',
        '-6': 'size check failed', '-8': 'image exceeds the staging limit', '-127': 'unknown partition',
        '-124': 'image is too large for the partition', '-122': 'partition ID mismatch', '-119': 'block write failed',
        '-111': 'secure check/signature failed', '-110': 'bootloader allows only released binaries',
        '-109': 'bootloader allows only released binaries', '-108': 'custom binary blocked by rollback protection',
        '-107': 'custom binary blocked by OEM lock', '-106': 'kernel rollback protection failed',
        '-104': 'system rollback protection failed', '-101': 'unsupported rollback version',
        '-94': 'Auto Blocker rejected the operation'
    };
    return messages[String(ack)] || `Odin bootloader returned error ${ack}.`;
}

function checkUsbResult(result, operation, expectedBytes = null) {
    if (result?.status && result.status !== 'ok') throw new Error(`${operation}: USB transfer status ${result.status}.`);
    if (expectedBytes !== null && result?.bytesWritten !== undefined && result.bytesWritten !== expectedBytes) {
        throw new Error(`${operation}: wrote ${result.bytesWritten} of ${expectedBytes} bytes.`);
    }
}

async function writeBytes(device, endpoint, bytes, timeoutMs = 30000) {
    const result = await withTimeout(device.transferOut(endpoint, bytes), timeoutMs, 'Samsung USB write timed out.');
    checkUsbResult(result, 'USB write', bytes.byteLength);
}

async function readExact(device, endpoint, length, timeoutMs = 30000) {
    const output = new Uint8Array(length);
    let offset = 0;
    while (offset < length) {
        const result = await withTimeout(device.transferIn(endpoint, length - offset), timeoutMs, 'Samsung USB read timed out.');
        if (result?.status && result.status !== 'ok') throw new Error(`Samsung USB read status ${result.status}.`);
        if (!result?.data?.byteLength) throw new Error('Samsung device returned an empty USB packet.');
        const data = new Uint8Array(result.data.buffer, result.data.byteOffset, result.data.byteLength);
        const count = Math.min(data.length, length - offset);
        output.set(data.subarray(0, count), offset);
        offset += count;
        if (data.length > count) throw new Error('Samsung USB response exceeded the expected packet size.');
    }
    return output;
}

async function receiveResponse(device, endpointIn, expectedId, timeoutMs = 30000) {
    const bytes = await readExact(device, endpointIn, 8, timeoutMs);
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const id = view.getInt32(0, true);
    const ack = view.getInt32(4, true);
    if (id === -1) throw new Error(describeAck(ack));
    if (id !== expectedId) throw new Error(`Unexpected Odin response ${id}; expected ${expectedId}.`);
    if (ack < 0) throw new Error(describeAck(ack));
    return ack;
}

async function request(context, command, parameter, ints = [], options = {}) {
    await writeBytes(context.device, context.endpointOut, makeRequest(command, parameter, ints), options.writeTimeout ?? 30000);
    return receiveResponse(context.device, context.endpointIn, command, options.readTimeout ?? 30000);
}

async function rawRequest(context, command, parameter, ints = []) {
    await writeBytes(context.device, context.endpointOut, makeRequest(command, parameter, ints));
}

async function receiveDataAck(context) { await readExact(context.device, context.endpointIn, 8, 45000); }

async function discoverBulkInterface(device) {
    if (!device.configuration) await device.selectConfiguration(1);
    for (const iface of device.configuration?.interfaces || []) {
        for (const alternate of iface.alternates || []) {
            const out = alternate.endpoints?.find(endpoint => endpoint.direction === 'out' && endpoint.type === 'bulk');
            const input = alternate.endpoints?.find(endpoint => endpoint.direction === 'in' && endpoint.type === 'bulk');
            if (!out || !input) continue;
            if (!iface.claimed) await device.claimInterface(iface.interfaceNumber);
            try { await device.selectAlternateInterface(iface.interfaceNumber, alternate.alternateSetting || 0); } catch (_) {}
            return { interfaceNumber: iface.interfaceNumber, endpointOut: out.endpointNumber, endpointIn: input.endpointNumber };
        }
    }
    return null;
}

function decodeFixed(bytes) {
    const end = bytes.indexOf(0);
    return new TextDecoder().decode(end >= 0 ? bytes.subarray(0, end) : bytes).trim();
}

export function parsePit(bytes) {
    if (!(bytes instanceof Uint8Array)) bytes = new Uint8Array(bytes);
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (bytes.byteLength < 28) throw new Error('Samsung PIT is smaller than its header.');
    if (view.getInt32(0, true) !== 0x12349876) throw new Error('Samsung PIT signature is invalid.');
    const count = view.getInt32(4, true);
    if (count < 0 || count > 4096 || 28 + count * 132 > bytes.byteLength) throw new Error('Samsung PIT partition count/size is invalid.');
    const cpuBlId = decodeFixed(bytes.subarray(16, 24));
    const partitions = [];
    for (let index = 0; index < count; index++) {
        const offset = 28 + index * 132;
        const partView = new DataView(bytes.buffer, bytes.byteOffset + offset, 132);
        partitions.push({
            binType: partView.getInt32(0, true), devType: partView.getInt32(4, true), id: partView.getInt32(8, true),
            attribute: partView.getInt32(12, true), wireBlockSize: partView.getInt32(20, true),
            blockLength: partView.getInt32(24, true), offset: partView.getInt32(28, true),
            name: decodeFixed(bytes.subarray(offset + 36, offset + 68)),
            fileName: decodeFixed(bytes.subarray(offset + 68, offset + 100))
        });
    }
    const maxBlockSize = Math.max(0, ...partitions.map(part => part.wireBlockSize));
    const maxOffset = Math.max(0, ...partitions.map(part => part.offset));
    const useBlockSizeAsBegin = maxBlockSize > 4096 && maxOffset <= 4096;
    return { cpuBlId, partitions: partitions.map(part => ({ ...part, beginBlock: useBlockSizeAsBegin ? part.wireBlockSize : part.offset })) };
}

async function downloadPit(context) {
    const size = await request(context, RQT.PIT, PARAM.PIT_GET);
    if (!Number.isSafeInteger(size) || size < 28 || size > 8 * 1024 * 1024) throw new Error(`Device returned an invalid PIT size (${size}).`);
    const pit = new Uint8Array(size);
    for (let offset = 0, index = 0; offset < size; index++) {
        const length = Math.min(500, size - offset);
        await rawRequest(context, RQT.PIT, PARAM.PIT_START, [index]);
        pit.set(await readExact(context.device, context.endpointIn, length, 45000), offset);
        offset += length;
    }
    await request(context, RQT.PIT, PARAM.PIT_COMPLETE);
    return parsePit(pit);
}

export async function openOdinSession() {
    ensureWebUsbSupport();
    if (!window.isSecureContext) throw new Error('Samsung Download flashing requires HTTPS or localhost.');
    if (activeUsbDevice?.opened) throw new Error('هناك جلسة USB أخرى مفتوحة. أنهِ العملية الحالية ثم أعد المحاولة.');
    let device = null;
    let endpoints = null;
    try {
        device = await navigator.usb.requestDevice({ filters: [{ vendorId: SAMSUNG_VENDOR_ID }] });
        if (device.vendorId !== SAMSUNG_VENDOR_ID) throw new Error('The selected USB device is not Samsung.');
        setActiveUsbDevice(device);
        if (device.opened) await device.close();
        await device.open();
        if (!device.configuration) await device.selectConfiguration(1);
        endpoints = await discoverBulkInterface(device);
        if (!endpoints) throw new Error('لم أجد واجهة USB Bulk صالحة. تأكد أن الهاتف في Download Mode وأغلق Odin/Smart Switch.');
        await writeBytes(device, endpoints.endpointOut, new TextEncoder().encode('ODIN\0'), 15000);
        const handshake = await readExact(device, endpoints.endpointIn, 4, 30000);
        if (decodeFixed(handshake) !== 'LOKE') throw new Error(`Samsung Odin handshake failed: ${decodeFixed(handshake) || 'no response'}.`);

        const context = { device, ...endpoints, protocolVersion: 0, compressedSupported: false, packetSize: DATA_PACKET_OLD, pit: null };
        const ackWord = await request(context, RQT.INIT, PARAM.INIT_TARGET, [5]);
        const word = ackWord >>> 0;
        context.protocolVersion = (word >>> 16) & 0xffff;
        if (!context.protocolVersion) context.protocolVersion = 1;
        context.compressedSupported = context.protocolVersion > 2 && Boolean(word & 0x8000);
        context.packetSize = context.protocolVersion >= 2 ? DATA_PACKET_V2 : DATA_PACKET_OLD;
        if (context.protocolVersion >= 2) await request(context, RQT.INIT, PARAM.INIT_PACKETSIZE, [context.packetSize]);
        context.pit = await downloadPit(context);
        return context;
    } catch (error) {
        await releaseUsbInterface(device, endpoints?.interfaceNumber);
        try { if (device?.opened) await device.close(); } catch (_) {}
        setActiveUsbDevice(null);
        throw error;
    }
}

export async function disposeOdinSession(context) {
    if (!context?.device) return;
    await releaseUsbInterface(context.device, context.interfaceNumber);
    try { if (context.device.opened) await context.device.close(); } catch (_) {}
    setActiveUsbDevice(null);
}

function unsigned32(value) { return Number(BigInt(value) & 0xffffffffn) | 0; }
async function sendTotalSize(context, totalSize) {
    const total = BigInt(totalSize);
    const base = 0xffffffffn;
    await request(context, RQT.INIT, PARAM.INIT_TOTALSIZE, [unsigned32(total % base), unsigned32(total / base)]);
}

function rawWindowBytes(part) {
    const MiB = 1024 * 1024;
    switch (Number(part.devType)) {
        case 1:
        case 2:
        case 8: return 30 * MiB;
        case 6: return 4 * MiB;
        case 7: return MiB;
        case 0: {
            const block = Math.max(0, Number(part.wireBlockSize) || 0);
            const units = block >> 7;
            if (units) {
                const base = block + (part.attribute === 1 ? units * 4 : 0);
                const computed = base * 1024 * Math.floor(800 / units);
                if (Number.isSafeInteger(computed) && computed > 0) return computed;
            }
            return RAW_WINDOW;
        }
        default: return RAW_WINDOW;
    }
}

async function startRawWindow(context, requestedSize) {
    await request(context, RQT.XMIT, PARAM.XMIT_DOWNLOAD);
    await request(context, RQT.XMIT, PARAM.XMIT_START, [Math.ceil(requestedSize / START_ALIGN) * START_ALIGN]);
}

async function sendPaddedBlob(context, blob, actualLength, packetSize, onBytes) {
    const paddedLength = Math.ceil(actualLength / packetSize) * packetSize;
    for (let offset = 0; offset < paddedLength; offset += packetSize) {
        const available = Math.max(0, Math.min(packetSize, actualLength - offset));
        const packet = new Uint8Array(packetSize);
        if (available) packet.set(new Uint8Array(await blob.slice(offset, offset + available).arrayBuffer()));
        await writeBytes(context.device, context.endpointOut, packet, 45000);
        await receiveDataAck(context);
        onBytes?.(available);
    }
}

function completeInts(part, size, last) { return [0, size, part.binType, part.devType, part.id, last ? 1 : 0, 0, 0]; }
async function finishRawWindow(context, part, actualSize, last) {
    await request(context, RQT.XMIT, PARAM.XMIT_COMPLETE, completeInts(part, actualSize, last), { readTimeout: 120000 });
}

async function flashRawBlob(context, image, part, onProgress) {
    const total = image.blob.size;
    if (!total) throw new Error(`الصورة ${image.basename} فارغة.`);
    const windowBytes = rawWindowBytes(part);
    for (let offset = 0; offset < total;) {
        const actual = Math.min(windowBytes, total - offset);
        await startRawWindow(context, actual);
        await sendPaddedBlob(context, image.blob.slice(offset, offset + actual), actual, context.packetSize, count => onProgress?.(count));
        const last = offset + actual >= total;
        await finishRawWindow(context, part, actual, last);
        offset += actual;
    }
}

async function beginCompressedWindow(context, compressedSize, expandedSize) {
    await request(context, RQT.XMIT, PARAM.XMIT_COMPRESSED_DOWNLOAD);
    await request(context, RQT.XMIT, PARAM.XMIT_COMPRESSED_START, [compressedSize, expandedSize]);
}

async function sendCompressedBlock(context, block, part, onProgress) {
    const payload = new Uint8Array(await block.payload.arrayBuffer());
    const stream = new Uint8Array(4 + payload.length);
    stream.set(block.header, 0);
    stream.set(payload, 4);
    const packetSize = context.packetSize;
    const paddedLength = Math.ceil(stream.length / packetSize) * packetSize;
    await beginCompressedWindow(context, stream.length, block.expectedSize);
    for (let offset = 0; offset < paddedLength; offset += packetSize) {
        const packet = new Uint8Array(packetSize);
        packet.set(stream.subarray(offset, Math.min(offset + packetSize, stream.length)));
        await writeBytes(context.device, context.endpointOut, packet, 45000);
        await receiveDataAck(context);
    }
    await request(context, RQT.XMIT, PARAM.XMIT_COMPRESSED_COMPLETE, completeInts(part, block.expectedSize, block.last), { readTimeout: 120000 });
    onProgress?.(block.expectedSize);
}

async function sendDecodedLz4Block(context, decoded, part, last, onProgress) {
    const blob = new Blob([decoded]);
    await startRawWindow(context, decoded.byteLength);
    await sendPaddedBlob(context, blob, decoded.byteLength, context.packetSize, count => onProgress?.(count));
    await finishRawWindow(context, part, decoded.byteLength, last);
}

async function flashLz4Blob(context, image, part, onProgress) {
    const useCompressed = context.compressedSupported && (image.lz4.blockSize === 1024 * 1024 || image.lz4.contentSize <= image.lz4.blockSize);
    for await (const block of readLz4Blocks(image.blob, image.lz4)) {
        if (useCompressed) {
            await sendCompressedBlock(context, block, part, onProgress);
        } else {
            const payload = new Uint8Array(await block.payload.arrayBuffer());
            const decoded = block.uncompressed ? payload : decompressLz4Block(payload, block.expectedSize);
            if (decoded.byteLength !== block.expectedSize) throw new Error('LZ4 output size mismatch.');
            await sendDecodedLz4Block(context, decoded, part, block.last, onProgress);
        }
    }
}

export async function flashOdinPlan(context, items, options = {}) {
    if (!context?.device?.opened || !items?.length) throw new Error('لا توجد جلسة Odin أو صور مطابقة للأقسام.');
    const total = items.reduce((sum, item) => sum + BigInt(item.image.flashSize), 0n);
    await sendTotalSize(context, total);
    const partitionNames = new Set(context.pit.partitions.map(part => String(part.name || '').toUpperCase()));
    const hasAbLayout = partitionNames.has('VBMETA_A') && partitionNames.has('VBMETA_B');
    const hasSuper = items.some(item => String(item.part.name || '').toUpperCase() === 'SUPER');
    if (hasAbLayout && hasSuper) await request(context, RQT.SUPER, PARAM.SUPER_USED_BLOCKS, [0]);
    let overall = 0n;
    const totalNumber = Number(total);
    for (let index = 0; index < items.length; index++) {
        const { image, part } = items[index];
        options.onStage?.(`تفليش ${index + 1}/${items.length}: ${image.basename} → ${part.name || part.fileName}`);
        const before = overall;
        const onProgress = count => {
            overall += BigInt(count);
            options.onProgress?.(Number(overall), totalNumber, image.basename, Number(overall - before));
        };
        if (image.lz4) await flashLz4Blob(context, image, part, onProgress);
        else await flashRawBlob(context, image, part, onProgress);
    }
}

export async function closeOdinSession(context, reboot = false) {
    if (!context?.device) return;
    let closeError = null;
    try {
        await request(context, RQT.CLOSE, PARAM.CLOSE_END, [], { readTimeout: 30000 });
        if (reboot) {
            try { await request(context, RQT.CLOSE, PARAM.CLOSE_REBOOT, [], { readTimeout: 3000 }); } catch (_) { /* Device may disconnect after accepting reboot. */ }
        }
    } catch (error) { closeError = error; }
    finally { await disposeOdinSession(context); }
    if (closeError) throw closeError;
}

export function findPlanItems(images, pit, selectedNames = null) {
    const byName = new Map(pit.partitions.map(part => [part.fileName.toLowerCase(), part]));
    const selected = selectedNames ? new Set(selectedNames) : null;
    const items = [];
    const skipped = [];
    for (const image of images) {
        if (image.kind === 'pit') { skipped.push({ image, reason: 'PIT منفصل غير مدعوم في مسار التفليش الآمن بالويب.' }); continue; }
        if (selected && !selected.has(image.name)) continue;
        const mappedName = getMappedImageName(image.basename).toLowerCase();
        const part = byName.get(mappedName);
        if (!part) { skipped.push({ image, reason: 'اسم الملف غير موجود في PIT الجهاز.' }); continue; }
        if (BigInt(image.flashSize) > 0x7fffffffn) { skipped.push({ image, reason: 'حجم الصورة يتجاوز حد Odin لكل ملف.' }); continue; }
        items.push({ image, part });
    }
    return { items, skipped };
}
