import { logRaw, logInfo, statusText, getOrRequestDevice, findInterfaceAndEndpoints, activeUsbDevice, setActiveUsbDevice, escapeHtml } from './utils.js';

const FLASHABLE_PARTITIONS = new Set(['boot', 'vendor_boot', 'dtbo', 'recovery', 'vbmeta']);

async function readFastbootPacket(device, endpoint, length = 64, timeoutMs = 15000) {
    const result = await Promise.race([
        device.transferIn(endpoint, length),
        new Promise((_, reject) => setTimeout(() => reject(new Error('Fastboot response timeout.')), timeoutMs))
    ]);
    if (!result?.data) throw new Error('Fastboot returned an empty response.');
    return new TextDecoder().decode(result.data);
}

function setFlashProgress(value) {
    const bar = document.getElementById('fastbootFlashProgress');
    if (bar) bar.style.width = `${Math.max(0, Math.min(100, value))}%`;
}

async function sha256(file) {
    const digest = await crypto.subtle.digest('SHA-256', await file.arrayBuffer());
    return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

function baseName(path = '') { return String(path).split(/[\\/]/).pop().trim(); }

export async function parseFirmwareManifest(file) {
    if (!file) throw new Error('اختر rawprogram.xml أو Scatter أولًا.');
    const text = await file.text();
    const entries = [];
    if (/rawprogram|program\s+SECTOR_SIZE/i.test(file.name) || /<program\b/i.test(text)) {
        const xml = new DOMParser().parseFromString(text, 'application/xml');
        if (xml.querySelector('parsererror')) throw new Error('rawprogram.xml غير صالح.');
        xml.querySelectorAll('program').forEach(node => {
            const filename = node.getAttribute('filename') || '';
            const label = node.getAttribute('label') || '';
            if (filename && label) entries.push({ partition: label, filename: baseName(filename), source: 'rawprogram.xml' });
        });
    } else {
        let current = {};
        for (const line of text.split(/\r?\n/)) {
            const part = line.match(/^\s*-?\s*partition_name\s*:\s*(.+?)\s*$/i);
            const image = line.match(/^\s*(?:file_name)\s*:\s*(.+?)\s*$/i);
            if (part) current.partition = part[1].replace(/^['"]|['"]$/g, '');
            if (image) current.filename = baseName(image[1].replace(/^['"]|['"]$/g, ''));
            if (current.partition && current.filename) { entries.push({ ...current, source: 'scatter' }); current = {}; }
        }
    }
    const unique = entries.filter((entry, index, all) => all.findIndex(item => item.partition === entry.partition && item.filename === entry.filename) === index);
    if (!unique.length) throw new Error('لم يتم العثور على إدخالات partition/image في الملف.');
    return unique;
}

function renderManifestPlan(entries) {
    const target = document.getElementById('manifestPlan');
    if (!target) return;
    target.innerHTML = entries.map(entry => `<div class="manifest-row"><span>${escapeHtml(entry.partition)}</span><span>${escapeHtml(entry.filename)}</span><span class="${FLASHABLE_PARTITIONS.has(entry.partition) ? 'color-green' : 'color-red'}">${FLASHABLE_PARTITIONS.has(entry.partition) ? 'Fastboot' : 'Skip'}</span></div>`).join('');
}

async function flashImageOnDevice(device, setup, file, partition) {
    await device.transferOut(setup.endpointOut, new TextEncoder().encode(`download:${file.size.toString(16).padStart(8, '0')}`));
    const dataReply = await readFastbootPacket(device, setup.endpointIn, 64, 15000);
    if (!dataReply.startsWith('DATA')) throw new Error(`Fastboot رفض download لـ ${partition}: ${dataReply}`);
    const chunkSize = 1024 * 1024;
    for (let offset = 0; offset < file.size; offset += chunkSize) {
        const chunk = new Uint8Array(await file.slice(offset, Math.min(offset + chunkSize, file.size)).arrayBuffer());
        await device.transferOut(setup.endpointOut, chunk);
        setFlashProgress(((offset + chunk.byteLength) / file.size) * 100);
    }
    const uploadReply = await readFastbootPacket(device, setup.endpointIn, 64, 30000);
    if (!uploadReply.startsWith('OKAY')) throw new Error(`Fastboot upload failed for ${partition}: ${uploadReply}`);
    await device.transferOut(setup.endpointOut, new TextEncoder().encode(`flash:${partition}`));
    const flashReply = await readFastbootPacket(device, setup.endpointIn, 64, 120000);
    if (flashReply.startsWith('FAIL')) throw new Error(`${partition}: ${flashReply.slice(4)}`);
    if (!flashReply.startsWith('OKAY')) throw new Error(`${partition}: unexpected response ${flashReply}`);
}

export async function previewFirmwareManifest() {
    const manifest = document.getElementById('rawprogramInput')?.files?.[0] || document.getElementById('scatterInput')?.files?.[0];
    if (!manifest) return;
    const entries = await parseFirmwareManifest(manifest);
    renderManifestPlan(entries);
    const summary = document.getElementById('manifestSummary');
    if (summary) summary.textContent = `${entries.length} entries parsed from ${manifest.name}. Fastboot-only allowlisted entries are eligible; EDL/MTK-only entries are skipped.`;
}

export async function flashFirmwareManifest() {
    const manifest = document.getElementById('rawprogramInput')?.files?.[0] || document.getElementById('scatterInput')?.files?.[0];
    const files = [...(document.getElementById('fastbootBundleInput')?.files || [])];
    const confirmed = document.getElementById('fastbootFlashConfirm')?.checked;
    if (!manifest) throw new Error('اختر rawprogram.xml أو Scatter.');
    if (!files.length) throw new Error('اختر ملفات الصور المرتبطة بالـmanifest.');
    if (!confirmed) throw new Error('فعّل مربع التأكيد قبل بدء التفليش.');
    const entries = await parseFirmwareManifest(manifest);
    const fileMap = new Map(files.map(file => [file.name.toLowerCase(), file]));
    const plan = entries.filter(entry => FLASHABLE_PARTITIONS.has(entry.partition) && fileMap.has(entry.filename.toLowerCase()));
    if (!plan.length) throw new Error('لا توجد إدخالات Fastboot مسموحة لها ملفات صور مطابقة.');
    if (!confirm(`سيتم تفليش ${plan.length} partitions من ${manifest.name}. متابعة؟`)) return;
    let device = null; let setup = null;
    try {
        device = await getOrRequestDevice([{ classCode: 0xff, subclassCode: 0x42, protocolCode: 0x03 }]);
        setup = await findInterfaceAndEndpoints(device, 'bulk');
        const getvars = await runFastbootCommand(device, 'getvar:all', setup);
        if (/unlocked:\s*(no|false)|device-unlocked:\s*(no|false)/.test(getvars.join('\n').toLowerCase())) throw new Error('Bootloader is locked.');
        for (let index = 0; index < plan.length; index++) {
            const entry = plan[index];
            logRaw(`<span class="color-blue">Manifest ${index + 1}/${plan.length}: ${escapeHtml(entry.filename)} → ${escapeHtml(entry.partition)}</span>`);
            await flashImageOnDevice(device, setup, fileMap.get(entry.filename.toLowerCase()), entry.partition);
        }
        logRaw('<span class="color-green">Compatible manifest entries flashed successfully.</span>');
        setFlashProgress(100);
    } finally {
        if (device && setup?.interfaceNumber !== undefined) await device.releaseInterface(setup.interfaceNumber).catch(() => {});
        if (device?.opened) await device.close().catch(() => {});
        setActiveUsbDevice(null);
    }
}

export async function flashFastbootImage() {
    const file = document.getElementById('fastbootImageInput')?.files?.[0];
    const partition = document.getElementById('fastbootPartition')?.value;
    const confirmed = document.getElementById('fastbootFlashConfirm')?.checked;
    const meta = document.getElementById('fastbootImageMeta');
    if (!file) throw new Error('اختر ملف Image أولًا.');
    if (!FLASHABLE_PARTITIONS.has(partition)) throw new Error('هذه الـpartition غير مسموحة في واجهة التفليش الآمن.');
    if (!confirmed) throw new Error('فعّل مربع التأكيد قبل بدء التفليش.');
    if (file.size === 0 || file.size > 0xffffffff) throw new Error('حجم ملف Image غير صالح.');
    if (!confirm(`سيتم تفليش ${file.name} على partition ${partition}. تأكد من أن الجهاز ملكك والـbootloader مفتوح. متابعة؟`)) return;

    let device = null;
    let setup = null;
    try {
        statusText.innerText = 'Checking Fastboot bootloader…';
        device = await getOrRequestDevice([{ classCode: 0xff, subclassCode: 0x42, protocolCode: 0x03 }]);
        setup = await findInterfaceAndEndpoints(device, 'bulk');
        if (!setup) throw new Error('Fastboot endpoints not found.');
        const getvars = await runFastbootCommand(device, 'getvar:all', setup);
        const joined = getvars.join('\n').toLowerCase();
        if (/unlocked:\s*(no|false)|device-unlocked:\s*(no|false)/.test(joined)) throw new Error('Bootloader is locked; Fastboot rejected a safe flash attempt.');
        if (meta) meta.textContent = `SHA-256 جاري الحساب… ${file.name} (${(file.size / 1048576).toFixed(2)} MB)`;
        const hash = await sha256(file);
        logRaw(`<span class="color-blue">Image SHA-256: ${hash}</span>`);

        await flashImageOnDevice(device, setup, file, partition);
        logRaw(`<span class="color-green">Fastboot flash completed: ${escapeHtml(partition)}.</span>`);
        if (meta) meta.textContent = `تم التفليش بنجاح · ${partition} · SHA-256: ${hash}`;
        setFlashProgress(100);
        statusText.innerText = 'Fastboot flash complete';
    } catch (error) {
        setFlashProgress(0);
        logRaw(`<div class="notice notice-error"><strong>Fastboot flash failed</strong><br>${escapeHtml(error.message)}</div>`);
        statusText.innerText = 'Fastboot flash failed';
        throw error;
    } finally {
        if (device && setup?.interfaceNumber !== undefined) await device.releaseInterface(setup.interfaceNumber).catch(() => {});
        if (device?.opened) await device.close().catch(() => {});
        setActiveUsbDevice(null);
    }
}

async function runFastbootCommand(device, command, cachedSetup = null) {
    const encoder = new TextEncoder();
    const decoder = new TextDecoder();
    
    // استخدام الإعدادات المخزنة أو البحث عن إعدادات جديدة
    const setup = cachedSetup || await findInterfaceAndEndpoints(device, 'bulk');
    if (!setup) throw new Error("Fastboot endpoints not found.");

    const { endpointOut, endpointIn } = setup;
    device._lastIface = setup.interfaceNumber;

    // إرسال الأمر
    // تم إزالة \0 لأنها تسبب خطأ "Control character" في أجهزة Redmi/Xiaomi الجديدة
    await device.transferOut(setup.endpointOut, encoder.encode(command));

    let results = [];
    let done = false;

    while (!done) {
        const result = await device.transferIn(endpointIn, 64).catch(e => {
            if (command === 'reboot') return { data: new Uint8Array([79, 75, 65, 89]) }; // "OKAY"
            throw e;
        });
        const response = decoder.decode(result.data);

        if (response.startsWith('INFO')) {
            results.push(response.substring(4));
        } else if (response.startsWith('DATA')) {
            // الجهاز يطلب بيانات أو يرسل بيانات ضخمة
            results.push("[DATA] " + response.substring(4));
            done = true; 
        } else if (response.startsWith('OKAY')) {
            results.push(response.substring(4));
            done = true;
        } else if (response.startsWith('FAIL')) {
            const errorMsg = response.substring(4);
            // إذا كان الجهاز مقفولاً، بعض الأوامر مثل reboot قد ترفض، سنحاول إرسالها بصيغة مختلفة
            if (errorMsg.toLowerCase().includes('locked') && command === 'reboot') {
                done = true; 
            } else {
                throw new Error(errorMsg);
            }
        } else {
            if (response.trim().length > 0) results.push(response);
            done = true;
        }
    }
    return results;
}

export async function fastbootInfo() {
    try {
        if (!navigator.usb) throw new Error("WebUSB not supported.");

        statusText.innerText = "Status: Searching for Fastboot Device...";
        const device = await getOrRequestDevice([{ classCode: 0xff, subclassCode: 0x42, protocolCode: 0x03 }]);

        // جلب الإعدادات مرة واحدة للعملية بالكامل
        const setup = await findInterfaceAndEndpoints(device, 'bulk');

        logRaw(`<br><span class="color-purple">--- Fastboot Device Connected ---</span>`);
        logRaw(`<span class="color-blue">Reading variables (getvar:all)...</span>`);

        const data = await runFastbootCommand(device, 'getvar:all', setup);
        
        data.forEach(line => {
            if (line.includes(':')) {
                const [key, ...val] = line.split(':');
                logInfo(key.trim(), val.join(':').trim());
            } else if (line.trim()) {
                logRaw(`<span class="color-blue">${line}</span>`);
            }
        });

        logRaw(`<span class="color-green">Fastboot operation completed.</span>`);
        
        if (device._lastIface !== undefined) await device.releaseInterface(device._lastIface).catch(() => {});
        statusText.innerText = "Status: Ready";

    } catch (e) {
        logRaw(`<br><span class="color-red">Fastboot Error: ${e.message}</span>`);
        statusText.innerText = "Status: Fastboot Failed";
    }
}

export async function fastbootReboot() {
    try {
        statusText.innerText = "Status: Sending Reboot...";
        const device = await getOrRequestDevice([{ classCode: 0xff, subclassCode: 0x42, protocolCode: 0x03 }]);

        logRaw(`<br><span class="color-blue">Sending 'fastboot reboot'...</span>`);
        await runFastbootCommand(device, 'reboot');
        
        logRaw(`<span class="color-green">Device is rebooting to system.</span>`);
        
        // خطوة إضافية: إجبار المتصفح على قطع الجلسة فوراً لتحفيز الهاتف على البدء في الـ Boot
        await device.close().catch(() => {});
        if (device._lastIface !== undefined) await device.releaseInterface(device._lastIface).catch(() => {});
        statusText.innerText = "Status: Ready";
    } catch (e) {
        logRaw(`<br><span class="color-red">Fastboot Error: ${e.message}</span>`);
    }
}

export async function honorInfo() {
    try {
        statusText.innerText = "Status: Connecting to HONOR device...";
        const device = await getOrRequestDevice([{ classCode: 0xff, subclassCode: 0x42, protocolCode: 0x03 }]);

        logRaw(`<br><span class="color-purple">--- HONOR Detailed Information ---</span>`);
        
        const fields = [
            { label: 'Product Model', cmd: 'oem get-product-model' },
            { label: 'Build Number', cmd: 'oem get-build-number' },
            { label: 'PSID', cmd: 'oem get-psid' },
            { label: 'Vendor/Country', cmd: 'getvar vendorcountry' },
            { label: 'Battery Level', cmd: 'getvar battery-voltage' }
        ];

        for (const f of fields) {
            try {
                const res = await runFastbootCommand(device, f.cmd);
                logInfo(f.label, res.join(' ').trim() || 'N/A');
            } catch (err) {
                logInfo(f.label, 'Not Supported');
            }
        }

        logRaw(`<span class="color-green">HONOR Info Read Success.</span>`);
        if (device._lastIface !== undefined) await device.releaseInterface(device._lastIface).catch(() => {});
        await device.close();
        statusText.innerText = "Status: Ready";
    } catch (e) { logRaw(`<br><span class="color-red">HONOR Error: ${e.message}</span>`); }
}

export async function honorFRP() {
    if (!confirm("Warning: This will attempt to erase the FRP partition on your HONOR device. Continue?")) return;
    
    try {
        statusText.innerText = "Status: Connecting for FRP Reset...";
        const device = await getOrRequestDevice([{ classCode: 0xff, subclassCode: 0x42, protocolCode: 0x03 }]);

        logRaw(`<br><span class="color-purple">--- HONOR FRP Reset Process ---</span>`);
        
        logRaw(`<span class="color-blue">Sending 'oem erase_frp'...</span>`);
        try {
            const res = await runFastbootCommand(device, 'oem erase_frp');
            logRaw(`<span class="color-green">Result: ${res.join(' ')}</span>`);
            logRaw(`<span class="color-green">[SUCCESS] FRP Partition should be cleared.</span>`);
        } catch (e) {
            logRaw(`<span class="color-red">Primary method failed: ${e.message}</span>`);
            logRaw(`<span class="color-blue">Trying alternative method...</span>`);
            const resAlt = await runFastbootCommand(device, 'oem unlock-frp');
            logRaw(`<span class="color-green">Alt Result: ${resAlt.join(' ')}</span>`);
        }

        logRaw(`<span class="color-purple">Rebooting device...</span>`);
        await runFastbootCommand(device, 'reboot');
        
        if (device._lastIface !== undefined) await device.releaseInterface(device._lastIface).catch(() => {});
        await device.close();
        statusText.innerText = "Status: Ready";
    } catch (e) {
        logRaw(`<br><span class="color-red">FRP Reset FAIL: ${e.message}</span>`);
        logRaw(`<span class="color-blue">Note: Modern HONOR devices may require a 'Bootloader Unlock Key' or TestPoint.</span>`);
    }
}

export async function executeCustomFastbootCommand(command) {
    try {
        if (!navigator.usb) throw new Error("WebUSB not supported.");

        statusText.innerText = "Status: Executing Fastboot...";
        const device = await getOrRequestDevice([{ classCode: 0xff, subclassCode: 0x42, protocolCode: 0x03 }]);
        
        logRaw(`<span class="color-blue">> fastboot ${command}</span>`);
        const results = await runFastbootCommand(device, command);
        
        if (results && results.length > 0) {
            const output = results.join('\n');
            logRaw(`<div class="color-white" style="background: rgba(255,255,255,0.05); padding: 5px; border-radius: 4px; font-family: monospace; white-space: pre-wrap;">${output}</div>`);
        } else {
            logRaw(`<span class="color-green">OKAY / Finished</span>`);
        }

        if (device._lastIface !== undefined) await device.releaseInterface(device._lastIface).catch(() => {});
        statusText.innerText = "Status: Ready";
    } catch (e) {
        logRaw(`<br><span class="color-red">Fastboot Error: ${e.message}</span>`);
        statusText.innerText = "Status: Error";
    }
}
