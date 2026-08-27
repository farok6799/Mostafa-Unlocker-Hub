import { logRaw, logInfo, statusText, getOrRequestDevice, findInterfaceAndEndpoints, activeUsbDevice, setActiveUsbDevice } from './utils.js';

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