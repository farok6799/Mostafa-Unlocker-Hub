const TAR_BLOCK = 512;
const LZ4_MAGIC = 0x184d2204;
const MAX_TAR_ENTRIES = 20000;

const decode = bytes => new TextDecoder('utf-8', { fatal: false }).decode(bytes);
const normalizeName = value => String(value || '').replaceAll('\\', '/').replace(/^\/+/, '').replace(/^\.\//, '').trim();
const basename = value => normalizeName(value).split('/').filter(Boolean).at(-1) || '';
const isZeroBlock = bytes => bytes.every(byte => byte === 0);

function tarString(bytes, start, length) {
    const field = bytes.subarray(start, start + length);
    const end = field.indexOf(0);
    return decode(end >= 0 ? field.subarray(0, end) : field).trim();
}

function tarNumber(bytes, start, length, label) {
    const field = bytes.subarray(start, start + length);
    if (field.length && (field[0] & 0x80)) {
        let value = BigInt(field[0] & 0x7f);
        for (let i = 1; i < field.length; i++) value = (value << 8n) | BigInt(field[i]);
        if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error(`${label} exceeds the browser's safe integer range.`);
        return Number(value);
    }
    const text = decode(field).replace(/\0.*$/s, '').trim();
    if (!text) return 0;
    if (!/^[0-7]+$/.test(text)) throw new Error(`Invalid TAR ${label} field.`);
    const value = Number.parseInt(text, 8);
    if (!Number.isSafeInteger(value) || value < 0) throw new Error(`Invalid TAR ${label} value.`);
    return value;
}

function verifyTarHeader(header, expected) {
    const sum = header.reduce((total, byte, index) => total + (index >= 148 && index < 156 ? 32 : byte), 0);
    if (expected && sum !== expected) throw new Error('TAR header checksum mismatch; the selected firmware archive may be damaged.');
}

function imageKind(name) {
    const lower = basename(name).toLowerCase();
    if (lower.endsWith('.pit')) return 'pit';
    if (/\.(?:img(?:\.lz4)?|bin|lz4)$/i.test(lower)) return 'image';
    return null;
}

export function getMappedImageName(name) {
    const base = basename(name);
    return base.toLowerCase().endsWith('.lz4') ? base.slice(0, -4) : base;
}

export function firmwareSlot(filename) {
    const match = basename(filename).match(/^(BL|AP|CP|HOME_CSC|CSC|USERDATA)_/i);
    return match ? match[1].toUpperCase() : null;
}

export function checkFullFirmwareSlots(files) {
    const slots = new Set(files.map(file => firmwareSlot(file.name)).filter(Boolean));
    const unrecognized = files.filter(file => !firmwareSlot(file.name));
    if (unrecognized.length) throw new Error(`اسم ملف غير معروف لوضع الحزمة الكاملة: ${unrecognized.map(file => file.name).join('، ')}.`);
    if (slots.has('USERDATA')) throw new Error('USERDATA لا يدخل في وضع التفليش الكامل من الويب. استخدم الملفات القياسية BL/AP/CP وCSC أو HOME_CSC فقط.');
    const missing = ['BL', 'AP', 'CP'].filter(slot => !slots.has(slot));
    if (!slots.has('CSC') && !slots.has('HOME_CSC')) missing.push('CSC أو HOME_CSC');
    if (slots.has('CSC') && slots.has('HOME_CSC')) throw new Error('اختَر ملف CSC أو HOME_CSC فقط، وليس الاثنين معًا.');
    if (missing.length) throw new Error(`الحزمة الكاملة تحتاج ملفات: ${missing.join('، ')}.`);
    return [...slots];
}

export function firmwareModelHint(files, cpuBlId) {
    const id = String(cpuBlId || '').replace(/[^A-Z0-9]/gi, '').toUpperCase();
    if (!id) return { matched: false, text: 'لم يُرجع PIT معرّف الجهاز؛ يلزم التحقق يدويًا.' };
    const candidate = files.some(file => basename(file.name).toUpperCase().includes(id));
    return candidate
        ? { matched: true, text: `معرّف PIT (${id}) ظاهر في اسم ملف الفيرموير.` }
        : { matched: false, text: `لم أجد معرّف PIT (${id}) داخل أسماء الملفات؛ يلزم التأكد يدويًا من الموديل وإصدار الـbootloader.` };
}

export async function inspectLz4Frame(blob) {
    if (!blob || blob.size < 19) throw new Error('ملف IMG.LZ4 أقصر من ترويسة LZ4 القياسية.');
    const header = new Uint8Array(await blob.slice(0, 19).arrayBuffer());
    const view = new DataView(header.buffer, header.byteOffset, header.byteLength);
    if (view.getUint32(0, true) !== LZ4_MAGIC) throw new Error('الملف ليس LZ4 Frame قياسيًا صالحًا.');
    const flg = header[4];
    const bd = header[5];
    if (flg & 0x02) throw new Error('ترويسة LZ4 تحتوي بتًا محجوزًا غير صفري.');
    if (bd & 0x8f) throw new Error('وصف حجم كتلة LZ4 يحتوي بتات محجوزة غير صفرية.');
    if (((flg >> 6) & 0x03) !== 1) throw new Error('إصدار LZ4 غير مدعوم.');
    if (!(flg & 0x20)) throw new Error('إطار LZ4 يستخدم كتلًا مترابطة؛ لا يمكن تمريره بأمان.');
    if (flg & 0x10) throw new Error('LZ4 block checksums غير مدعومة في هذا المتصفح.');
    if (!(flg & 0x08)) throw new Error('إطار LZ4 لا يتضمن uncompressed content size.');
    if (flg & 0x01) throw new Error('إطار LZ4 يستخدم قاموسًا خارجيًا غير مدعوم.');
    const blockId = (bd >> 4) & 0x07;
    const blockSize = ({ 4: 64 * 1024, 5: 256 * 1024, 6: 1024 * 1024, 7: 4 * 1024 * 1024 })[blockId] || 0;
    if (!blockSize || blockSize > 1024 * 1024) throw new Error('حجم كتل LZ4 أكبر من 1 MiB أو غير صالح.');
    const contentSize = Number(view.getBigUint64(6, true));
    if (!Number.isSafeInteger(contentSize) || contentSize <= 0) throw new Error('حجم الصورة المفكوك داخل LZ4 غير صالح.');
    return { headerBytes: 15, contentSize, blockSize, flg, bd, contentChecksum: Boolean(flg & 0x04), totalBlocks: Math.ceil(contentSize / blockSize) };
}

export async function* readLz4Blocks(blob, info) {
    let offset = info.headerBytes;
    let produced = 0;
    for (let index = 0; index < info.totalBlocks; index++) {
        if (offset + 4 > blob.size) throw new Error('ملف LZ4 انتهى قبل اكتمال جميع الكتل.');
        const sizeBytes = new Uint8Array(await blob.slice(offset, offset + 4).arrayBuffer());
        const rawSize = new DataView(sizeBytes.buffer, sizeBytes.byteOffset, 4).getUint32(0, true);
        offset += 4;
        if (!rawSize) throw new Error('ظهر LZ4 end-mark قبل اكتمال الصورة.');
        const uncompressed = Boolean(rawSize & 0x80000000);
        const payloadSize = rawSize & 0x7fffffff;
        if (!payloadSize || payloadSize > info.blockSize || offset + payloadSize > blob.size) throw new Error('حجم كتلة LZ4 خارج الحدود المتوقعة.');
        const expectedSize = Math.min(info.blockSize, info.contentSize - produced);
        if (expectedSize <= 0) throw new Error('بيانات LZ4 تتجاوز الحجم المعلن.');
        if (uncompressed && payloadSize !== expectedSize) throw new Error('حجم كتلة LZ4 غير المضغوطة لا يطابق الترويسة.');
        yield { index, last: index === info.totalBlocks - 1, rawSize, payloadSize, expectedSize, uncompressed, header: sizeBytes, payload: blob.slice(offset, offset + payloadSize) };
        offset += payloadSize;
        produced += expectedSize;
    }
    if (produced !== info.contentSize) throw new Error('إجمالي خرج LZ4 لا يطابق الحجم المعلن.');
    if (offset + 4 > blob.size) throw new Error('ملف LZ4 لا يتضمن end-mark مكتملًا.');
    const endMark = new Uint8Array(await blob.slice(offset, offset + 4).arrayBuffer());
    if (new DataView(endMark.buffer, endMark.byteOffset, 4).getUint32(0, true) !== 0) throw new Error('علامة نهاية إطار LZ4 غير صالحة.');
    if (info.contentChecksum) {
        if (offset + 8 > blob.size) throw new Error('إطار LZ4 يعلن content checksum لكن قيمة checksum ناقصة.');
        // MUT-compatible: the checksum field is consumed but not validated.
    }
}

export async function validateLz4Frame(blob, info) {
    for await (const block of readLz4Blocks(blob, info)) {
        if (!block.uncompressed) {
            decompressLz4Block(new Uint8Array(await block.payload.arrayBuffer()), block.expectedSize);
        }
    }
    return info.contentSize;
}

export function decompressLz4Block(input, outputSize) {
    const source = input instanceof Uint8Array ? input : new Uint8Array(input);
    const output = new Uint8Array(outputSize);
    let src = 0;
    let dst = 0;
    const readLength = initial => {
        let length = initial;
        if (initial !== 15) return length;
        while (true) {
            if (src >= source.length) throw new Error('LZ4 block truncated while reading a length.');
            const next = source[src++];
            length += next;
            if (next !== 255) return length;
        }
    };
    while (src < source.length) {
        const token = source[src++];
        const literals = readLength(token >> 4);
        if (src + literals > source.length || dst + literals > output.length) throw new Error('LZ4 literal run is out of bounds.');
        output.set(source.subarray(src, src + literals), dst);
        src += literals;
        dst += literals;
        if (src === source.length) break;
        if (src + 2 > source.length) throw new Error('LZ4 match offset is truncated.');
        const distance = source[src] | (source[src + 1] << 8);
        src += 2;
        if (!distance || distance > dst) throw new Error('LZ4 match points before the output buffer.');
        const matchLength = readLength(token & 0x0f) + 4;
        if (dst + matchLength > output.length) throw new Error('LZ4 match exceeds the declared block size.');
        for (let index = 0; index < matchLength; index++) output[dst + index] = output[dst - distance + index];
        dst += matchLength;
    }
    if (dst !== output.length) throw new Error(`LZ4 block expanded to ${dst} bytes; expected ${output.length}.`);
    return output;
}

export async function parseTarArchive(blob, sourceName = 'firmware.tar.md5') {
    const entries = [];
    const downloadAllow = new Set();
    let offset = 0;
    let longName = '';
    let sawHeader = false;
    while (offset + TAR_BLOCK <= blob.size) {
        if (entries.length > MAX_TAR_ENTRIES) throw new Error('الأرشيف يحتوي عددًا غير طبيعي من الملفات.');
        const header = new Uint8Array(await blob.slice(offset, offset + TAR_BLOCK).arrayBuffer());
        if (isZeroBlock(header)) break;
        sawHeader = true;
        const storedChecksum = tarNumber(header, 148, 8, 'checksum');
        verifyTarHeader(header, storedChecksum);
        const name = tarString(header, 0, 100);
        const prefix = tarString(header, 345, 155);
        const type = String.fromCharCode(header[156] || 0);
        const size = tarNumber(header, 124, 12, 'size');
        const dataStart = offset + TAR_BLOCK;
        if (size > blob.size || dataStart + size > blob.size) throw new Error(`TAR entry ${name || '(unnamed)'} extends past the selected file.`);
        const storedName = longName || (prefix ? `${prefix}/${name}` : name);
        longName = '';
        const cleanName = normalizeName(storedName);
        if (type === 'L') {
            if (size > 65536) throw new Error('TAR long-name field is unexpectedly large.');
            longName = decode(new Uint8Array(await blob.slice(dataStart, dataStart + size).arrayBuffer())).replace(/\0.*$/s, '').trim();
        } else if (type === 'x' || type === 'g') {
            if (size > 65536) throw new Error('TAR metadata entry is unexpectedly large.');
        } else if (type === '0' || type === '\0' || type === '7') {
            if (cleanName.toLowerCase() === 'meta-data/download-list.txt') {
                if (size > 128 * 1024) throw new Error('download-list.txt is too large.');
                const text = decode(new Uint8Array(await blob.slice(dataStart, dataStart + size).arrayBuffer()));
                for (const line of text.split(/\r?\n/).map(value => value.trim()).filter(Boolean)) {
                    const key = line.toLowerCase();
                    if (downloadAllow.has(key)) throw new Error(`download-list.txt contains a duplicate entry: ${line}`);
                    downloadAllow.add(key);
                }
            } else if (imageKind(cleanName)) {
                entries.push({ name: cleanName, basename: basename(cleanName), kind: imageKind(cleanName), size, blob: blob.slice(dataStart, dataStart + size), sourceName });
            }
        }
        offset = dataStart + Math.ceil(size / TAR_BLOCK) * TAR_BLOCK;
    }
    if (!sawHeader) throw new Error(`${sourceName} لا يحتوي TAR صالحًا.`);
    if (downloadAllow.size) return { entries: entries.filter(entry => entry.kind === 'pit' || downloadAllow.has(entry.basename.toLowerCase())), downloadAllow: [...downloadAllow] };
    return { entries, downloadAllow: [] };
}

export async function inspectFirmwareSelection(files, mode) {
    const selected = [...(files || [])];
    if (!selected.length) throw new Error('اختر ملفات الفيرموير أولًا.');
    if (mode === 'direct') {
        if (selected.length !== 1 || !selected[0].name.toLowerCase().endsWith('.img.lz4')) throw new Error('وضع LZ4 المباشر يقبل ملفًا واحدًا بصيغة .img.lz4 فقط.');
        const file = selected[0];
        const lz4 = await inspectLz4Frame(file);
        await validateLz4Frame(file, lz4);
        return { mode, files: selected, images: [{ name: file.name, basename: basename(file.name), kind: 'image', size: file.size, flashSize: lz4.contentSize, blob: file, sourceName: file.name, lz4 }], slots: [], modelHint: null };
    }
    const archives = selected.filter(file => /\.(?:tar(?:\.md5)?|md5)$/i.test(file.name));
    if (archives.length !== selected.length) throw new Error('اختَر ملفات TAR.MD5/TAR الخاصة بالفيرموير. في الوضع الكامل، حدّد ملفات BL/AP/CP/CSC أو HOME_CSC المستخرجة من حزمة Samsung الرسمية.');
    const slots = mode === 'full' ? checkFullFirmwareSlots(archives) : [];
    const images = [];
    const seen = new Set();
    for (const archive of archives) {
        const parsed = await parseTarArchive(archive, archive.name);
        for (const entry of parsed.entries) {
            if (entry.kind !== 'image') continue;
            const mapped = getMappedImageName(entry.basename).toLowerCase();
            if (seen.has(mapped)) throw new Error(`اسم صورة مكرر داخل الملفات المختارة: ${entry.basename}. اترك نسخة واحدة فقط.`);
            seen.add(mapped);
            const lz4 = entry.basename.toLowerCase().endsWith('.lz4') ? await inspectLz4Frame(entry.blob) : null;
            if (lz4) await validateLz4Frame(entry.blob, lz4);
            images.push({ ...entry, flashSize: lz4?.contentSize ?? entry.size, lz4, selected: true, slot: firmwareSlot(archive.name) });
        }
    }
    if (!images.length) throw new Error('لم أجد صورًا قابلة للتفليش داخل ملفات TAR المحددة.');
    return { mode, files: archives, images, slots, modelHint: null };
}
