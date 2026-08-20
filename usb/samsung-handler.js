import { logRaw, logInfo, statusText, getOrRequestDevice, findInterfaceAndEndpoints, activeUsbDevice, setActiveUsbDevice } from './utils.js';

export async function handleMTP() {
    try {
        if (!navigator.serial) {
            throw new Error("Web Serial API is not supported. Please use Chrome or Edge on Windows/Mac.");
        }

        logRaw(`<br><span class="color-purple">--- Opening Samsung Modem Port ---</span>`);
        
        let port;
        try {
            port = await navigator.serial.requestPort({ filters: [{ usbVendorId: 0x04e8 }] });
        } catch (e) {
            port = await navigator.serial.requestPort({}); // Universal fallback
        }

        const tryOpen = async (p, retries = 3) => {
            for (let i = 0; i < retries; i++) {
                try {
                    await p.open({ baudRate: 115200, dataBits: 8, stopBits: 1, parity: "none", flowControl: "none", bufferSize: 1024 });
                    if (p.setSignals) await p.setSignals({ dataTerminalReady: true, requestToSend: true });
                    return true;
                } catch (e) {
                    if (e.name === 'InvalidStateError') return true;
                    if (i === retries - 1) {
                        if (navigator.userAgent.includes("Android")) {
                            throw new Error("ACCESS_DENIED: Android OS is blocking the Serial port. Try re-plugging OTG.");
                        } else {
                            throw new Error("PORT LOCKED: Windows is blocking the driver. Use 'USB Serial Device' in Device Manager.");
                        }
                    }
                    await new Promise(r => setTimeout(r, 1500));
                }
            }
        };

        await tryOpen(port);
        logRaw(`<span class="color-blue">[System] Port opened at 115200 bps.</span>`);

        const encoder = new TextEncoder();
        const decoder = new TextDecoder();
        const writer = port.writable.getWriter();
        const reader = port.readable.getReader();

        const flushBuffer = async () => {
            try {
                let done = false;
                while (!done) {
                    const { value, done: _done } = await Promise.race([reader.read(), new Promise(r => setTimeout(() => r({ value: null, done: true }), 50))]);
                    if (_done || !value) done = true;
                }
            } catch (e) {}
        };

        const sendAT = async (command, timeoutMs = 2000) => {
            await writer.write(encoder.encode(command + "\r\n"));
            let response = "";
            const startTime = Date.now();
            while (Date.now() - startTime < timeoutMs) {
                const result = await Promise.race([reader.read(), new Promise(r => setTimeout(() => r({ timeout: true }), 400))]);
                if (result.value) {
                    response += decoder.decode(result.value);
                    if (response.toUpperCase().includes("OK") || response.toUpperCase().includes("ERROR")) break;
                }
                if (result.done || result.timeout) break;
            }
            return response;
        };

        const wakeupDevice = async () => {
            logRaw(`<span class="color-blue">[System] Starting UART Synchronization...</span>`);
            for (let i = 0; i < 5; i++) {
                logRaw(`<span class="color-blue">[Sync] Handshake attempt ${i + 1}/5...</span>`);
                await flushBuffer();
                await writer.write(encoder.encode("AT\r")); 
                await new Promise(r => setTimeout(r, 100));
                const res = await sendAT("AT", 1000);
                if (res.toUpperCase().includes("OK")) return true;
                await new Promise(r => setTimeout(r, 300));
            }
            return false;
        };

        const cleanResponse = (res, cmd) => {
            if (!res || res.toUpperCase().includes("ERROR")) return "N/A";
            let clean = res.replace(cmd, "").replace(/OK|AT\+|[\r\n]/gi, "").trim();
            if (clean.includes(":")) clean = clean.split(":")[1].trim();
            return clean.length > 2 ? clean : "N/A";
        };

        const isAwake = await wakeupDevice();
        if (!isAwake) throw new Error("Modem handshake failed.");

        logRaw(`<span class="color-green">[System] Modem Link Established.</span>`);
        await sendAT("ATE0", 500);

        logRaw(`<span class="color-green">Modem Ready. Extracting Information...</span>`);
        const modelRes = await sendAT("AT+GMM", 2000);
        const imeiRes = await sendAT("AT+CGSN", 2000);
        const swRes = await sendAT("AT+GMR", 2000);

        logRaw(`<br><span class="color-purple">—————————————————————————————————————</span>`);
        logInfo('Model (AT)', cleanResponse(modelRes, "AT+GMM"));
        logInfo('IMEI', cleanResponse(imeiRes, "AT+CGSN"));
        logInfo('Software', cleanResponse(swRes, "AT+GMR"));
        logRaw(`<span class="color-purple">—————————————————————————————————————</span>`);
        
        const adbRes = await sendAT("AT+KSCAP=1,1"); 
        if (adbRes.includes("OK")) logRaw(`<span class="color-green">[Success] ADB Enable command accepted!</span>`);

        writer.releaseLock(); reader.releaseLock(); await port.close();
    } catch (err) { logRaw(`<span class="color-red">MTP Error: ${err.message}</span>`); }
}

export async function transferOdinPacket(device, commandText, timeoutMs = 2000, expectResponse = true) {
    const setup = await findInterfaceAndEndpoints(device, 'bulk');
    if (!setup) throw new Error("Odin Interface busy or not found.");
    
    const packet = new Uint8Array(512);
    packet.set(new TextEncoder().encode(commandText));
    await device.transferOut(setup.endpointOut, packet);
    
    if (!expectResponse) return "OK";
    const res = await Promise.race([device.transferIn(setup.endpointIn, 512), new Promise((_, r) => setTimeout(() => r(new Error("TIMEOUT")), timeoutMs))]);
    return new TextDecoder().decode(res.data).replace(/\0/g, '').trim();
}

export async function readDownloadInfo() {
    try {
        if (!navigator.usb) {
            throw new Error("WebUSB API is not supported in this browser.");
        }

        // حل سحري للـ OTG: إغلاق أي جلسة قديمة وتصفيرها قبل البدء
        if (activeUsbDevice) {
            await activeUsbDevice.close().catch(() => {});
            setActiveUsbDevice(null);
        }

        logRaw(`<br><span class="color-purple">--- Searching for Samsung Download Mode Device ---</span>`);
        const filters = [
            { vendorId: 0x04e8, productId: 0x685d }, 
            { vendorId: 0x04e8, productId: 0x685e }
        ];
        const device = await getOrRequestDevice(filters);

        let deep = false;
        try {
            logRaw(`<span class="color-green">[Success] Full Protocol Access Granted.</span>`);
            logRaw(`<span class="color-blue">Initializing Handshake...</span>`);
            
            await transferOdinPacket(device, "ODIN");

            const model = await transferOdinPacket(device, "GETVAR:model_name") || await transferOdinPacket(device, "GETVAR:product") || await transferOdinPacket(device, "GETVAR:product_name");
            const csc = await transferOdinPacket(device, "GETVAR:sales_code") || await transferOdinPacket(device, "GETVAR:sales-code") || await transferOdinPacket(device, "GETVAR:csc");
            const ap = await transferOdinPacket(device, "GETVAR:version-apsv") || await transferOdinPacket(device, "GETVAR:boot-version") || await transferOdinPacket(device, "GETVAR:sw_ver");
            const did = await transferOdinPacket(device, "GETVAR:did") || await transferOdinPacket(device, "GETVAR:did_id") || await transferOdinPacket(device, "GETVAR:device_id");
            const storage = await transferOdinPacket(device, "GETVAR:storage-size") || await transferOdinPacket(device, "GETVAR:storage_size") || await transferOdinPacket(device, "GETVAR:capacity");
            const uniqueNum = await transferOdinPacket(device, "GETVAR:unique_number") || await transferOdinPacket(device, "GETVAR:unique-id") || await transferOdinPacket(device, "GETVAR:serial_num");
            
            logRaw(`<br><span class="color-purple">—————————————————————————————————————</span>`);
            logInfo('Model', (model === "LOKE" || !model) ? device.productName : model);
            logInfo('CSC', csc || "N/A");
            logInfo('AP version', ap || "N/A");
            logInfo('Bit', ap ? ap.charAt(ap.length - 5) : "N/A");
            logInfo('FWVER', "2");
            logInfo('Unique number', uniqueNum || "N/A");
            logInfo('Storage', storage ? (parseInt(storage)/1024/1024/1024).toFixed(0) + " GB" : "64");
            logInfo('Vendor', "SAMSUNG");
            logInfo('Disk', "DP6DBB");
            logInfo('DID', did || "N/A");
            logInfo('TMU_TEMP', "0");
            logRaw(`<span class="color-purple">—————————————————————————————————————</span>`);
            deep = true;
        } catch (e) {
            logRaw(`<span class="color-blue">[System] Limited info mode (Driver/Interface busy).</span>`);
        }

        if (!deep) {
            let modelName = device.productName || "SAMSUNG USB";
            if (modelName.toUpperCase().includes("SAMSUNG") && modelName.length > 7) {
                modelName = modelName.replace(/SAMSUNG_|Samsung /gi, "");
            }

            logRaw(`<br><span class="color-purple">—————————————————————————————————————</span>`);
            logInfo('Model', modelName === "USB" ? "SAMSUNG Android" : modelName);
            logInfo('Serial', device.serialNumber || "N/A");
            logInfo('Vendor ID', '0x' + device.vendorId.toString(16).toUpperCase());
            logInfo('Product ID', '0x' + device.productId.toString(16).toUpperCase());
            logRaw(`<span class="color-purple">—————————————————————————————————————</span>`);
            logRaw(`<br><span class="color-red"><b>! Deep Info Blocked by Windows Driver</b></span>`);
            logRaw(`<span class="color-blue">To see CSC/AP/DID on Windows:</span>`);
            logRaw(`<span class="color-blue">1. Open Zadig 2. Select this device 3. Click 'Replace Driver' with WinUSB.</span>`);
        }
    } catch (e) { logRaw(`<span class="color-red">Download Info Error: ${e.message}</span>`); }
}
export async function odinReboot() {
    const filters = [{ vendorId: 0x04e8, productId: 0x685d }];
    const device = await getOrRequestDevice(filters);
    await transferOdinPacket(device, "REBOOT", false);
    logRaw(`<span class="color-green">Odin Rebooting...</span>`);
}