import { Adb, AdbDaemonTransport } from 'https://esm.sh/@yume-chan/adb@0.0.22';
import { AdbDaemonWebUsbDeviceManager } from 'https://esm.sh/@yume-chan/adb-daemon-webusb@0.0.22';
import AdbWebCredentialStore from 'https://esm.sh/@yume-chan/adb-credential-web@0.0.22';
import { DecodeUtf8Stream } from 'https://esm.sh/@yume-chan/stream-extra@0.0.22';
import { logRaw, logInfo, statusText, setButtonsState, activeUsbDevice, setActiveUsbDevice } from './utils.js';

export let currentAdb = null;
let allPackages = [];
let isConnecting = false;

async function readShellOutput(process) {
    let output = "";
    const reader = process.stdout.pipeThrough(new DecodeUtf8Stream()).getReader();
    while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        output += value;
    }
    return output;
}

async function execShell(adb, command) {
    try {
        const process = await adb.subprocess.spawn(command);
        return (await readShellOutput(process)).trim();
    } catch (e) {
        if (e.message.includes('closed')) resetAdbState();
        console.warn(`ADB Shell Error [${command}]: ${e.message}`);
        return 'N/A';
    }
}

function extractProp(text, propName) {
    const regex = new RegExp(`\\[${propName}\\]: \\[(.*?)\\]`);
    const match = text.match(regex);
    return match ? match[1] : 'N/A';
}

// وظيفة لتنظيف مخرجات الأوامر المعقدة مثل IMEI
function sanitizeValue(text) {
    if (!text || text === 'N/A') return 'N/A';
    
    // تنظيف عدواني: حذف كل شيء ليس رقماً (بما في ذلك النقاط والفراغات ورموز الـ Parcel)
    const onlyDigits = text.replace(/[^\d]/g, '');
    
    // البحث عن تسلسل مكون من 14 أو 15 رقماً داخل النص المنظف
    const imeiMatch = onlyDigits.match(/\d{14,15}/);
    if (imeiMatch) {
        const val = imeiMatch[0];
        // التأكد أن الرقم ليس عبارة عن أصفار فقط
        if (!/^0+$/.test(val)) return val;
    }

    // محاولة أخيرة: إذا كان النص يحتوي على '...' (نظام Parcel التقليدي)
    const quoted = text.match(/'([^']+)'/);
    if (quoted) {
        const val = quoted[1].replace(/[^\d]/g, '');
        if (val.length >= 14 && !/^0+$/.test(val)) return val;
    }

    return 'N/A';
}

export function resetAdbState() {
    currentAdb = null;
    isConnecting = false;
}

async function initializeAdbSession() {
    if (isConnecting) return;
    try {
        isConnecting = true;
        if (!navigator.usb) throw new Error("Your browser does not support WebUSB. Please use Chrome or Edge.");

        if (activeUsbDevice && activeUsbDevice.opened) {
            logRaw("<span class='color-blue'>[System] Releasing previous USB handle...</span>");
            await activeUsbDevice.close().catch(() => {});
        }

        statusText.innerText = "Status: Select Device...";
        const Manager = AdbDaemonWebUsbDeviceManager.BROWSER;
        if (!Manager) throw new Error("AdbDaemonWebUsbDeviceManager is not initialized.");

        let device = null;
        currentAdb = null; // تصفير الجلسة القديمة قبل البدء
        const pairedDevices = await Manager.getDevices();
        if (pairedDevices.length > 0) {
            device = pairedDevices[0];
            logRaw(`<span class="color-blue">[System] Reconnecting to paired device...</span>`);
        } else {
            device = await Manager.requestDevice();
        }

        statusText.innerText = "Status: Waiting for Auth...";
        logRaw(`<span class="color-blue">[System] Authenticating with device...</span>`);
        logRaw(`<span class="color-purple"><b>ACTION REQUIRED:</b> Please check your phone screen and AUTHORIZE this computer.</span>`);
        
        const connection = await device.connect();
        const credentialStore = new AdbWebCredentialStore();
        const transport = await AdbDaemonTransport.authenticate({ 
            serial: device.serial, connection, credentialStore 
        });
        currentAdb = new Adb(transport);
        setActiveUsbDevice(device.raw || device); // Update global session
        await setButtonsState(true);
        return true;
    } catch (err) {
        let errorMsg = err.message;
        if (errorMsg.includes('claimInterface')) {
            errorMsg = "Interface Busy. Please close ADB.exe or other tools (Odin/Z3X) and try again.";
        }
        logRaw(`<br><span class='color-red'>ADB Connection Fail: ${errorMsg}</span>`);
        statusText.innerText = "Status: Connection Error";
        await resetAdbState();
        await setButtonsState(true); // فك قفل الأزرار للسماح بالمحاولة مرة أخرى
        return false;
    } finally {
        isConnecting = false;
    }
}

export async function ensureAdb() {
if (currentAdb) return true;
    return await initializeAdbSession();
}

export async function connectADB() {
    try {
        if (!(await ensureAdb())) return;
        logRaw(`<br><span class="color-purple">—————————————————————————————————————</span>`);
        logRaw(`<span class="color-purple">    ADB DEVICE CONNECTED SUCCESSFULLY  </span>`);
        logRaw(`<span class="color-purple">—————————————————————————————————————</span>`);
        logRaw(`<span class="color-green">Serial: ${activeUsbDevice.serialNumber || 'N/A'}</span>`);
        logRaw(`<span class="color-blue">[Ready] All ADB operations are now active.</span>`);
        statusText.innerText = "Status: ADB Ready";

        // تشغيل قراءة المعلومات تلقائياً فور نجاح الاتصال
        await readDeviceInfo();
    } catch (e) {
        logRaw(`<br><span class="color-red">ADB Connection Error: ${e.message}</span>`);
    }
}

export async function readDeviceInfo() {
    try {
        if (!(await ensureAdb())) return;
        statusText.innerText = "Status: Reading Data...";
        logRaw(`<br><span class="color-blue">[System] Extracting device information...</span>`);

        const props = await execShell(currentAdb, 'getprop');
        const androidId = await execShell(currentAdb, 'settings get secure android_id');
        const hasSu = (await execShell(currentAdb, 'which su')) ? 'YES' : 'NO';
        const magiskVer = (await execShell(currentAdb, 'magisk -v')) || 'NO';
        
        const csc = [
            extractProp(props, 'ro.csc.sales_code'), 
            extractProp(props, 'ril.sales_code'), 
            extractProp(props, 'ro.boot.sales_code'),
            extractProp(props, 'ro.ril.miui.region') // For Xiaomi
        ].find(v => v !== 'N/A') || 'N/A';

        const snPhysical = extractProp(props, 'ril.serialnumber') !== 'N/A' && !/^\d{14,15}$/.test(extractProp(props, 'ril.serialnumber')) ? extractProp(props, 'ril.serialnumber') : extractProp(props, 'ro.serialno');
        
        // خوارزمية البحث العميق (Deep Detection) عن IMEI
        const getDeepImei = async () => {
            const foundImeis = [];
            const addUnique = (val) => {
                if (val && val !== 'N/A' && !foundImeis.includes(val)) foundImeis.push(val);
            };

            // 1. محاولة جلب IMEI عبر Slots (لأجهزة Dual SIM شاومي وسامسونج)
            for (let slot = 0; slot <= 1; slot++) {
                const res = await execShell(currentAdb, `service call iphonesubinfo 1 i32 ${slot}`);
                addUnique(sanitizeValue(res));
            }

            // 2. المسح التقليدي للمؤشرات (لأجهزة أندرويد القديمة)
            const indices = [1, 2, 3, 4, 5, 7, 8, 11, 16];
            for (let idx of indices) {
                if (foundImeis.length >= 2) break;
                addUnique(sanitizeValue(await execShell(currentAdb, `service call iphonesubinfo ${idx}`)));
            }
            
            // 3. الحل النهائي: dumpsys (لأجهزة سامسونج المقفلة تماماً)
            if (foundImeis.length < 2) {
                const dump = await execShell(currentAdb, 'dumpsys telephony.registry | grep -E "mDeviceId|deviceId|mImei"');
                const matches = dump.match(/\d{14,15}/g);
                if (matches) {
                    matches.forEach(m => addUnique(m));
                }
            }
            return foundImeis;
        };

        const foundImeis = await getDeepImei();
        
        // ترتيب النتائج مع فحص الـ Props كخيار أخير
        let imei1 = foundImeis[0] || [extractProp(props, 'ril.imei'), extractProp(props, 'ro.ril.oem.imei'), extractProp(props, 'persist.radio.imei')].find(v => v !== 'N/A' && !/^0+$/.test(v)) || 'N/A';
        let imei2 = foundImeis[1] || [extractProp(props, 'ril.imei2'), extractProp(props, 'ril.serialnumber2'), extractProp(props, 'persist.radio.imei2')].find(v => v !== 'N/A' && !/^0+$/.test(v)) || 'N/A';

        const sepVer = extractProp(props, 'ro.build.version.sep');
        let oneUi = 'N/A';
        if (sepVer !== 'N/A') {
            oneUi = `${Math.floor(parseInt(sepVer) / 10000) - 9}.${Math.floor((parseInt(sepVer) % 10000) / 100)}`;
        }

        // فحص الـ FRP
        const setupWizard = extractProp(props, 'persist.sys.setupwizard.active');
        let frpStatus = (setupWizard === '1') ? 'ON / TRIGGERED' : 'OFF / NONE';

        logRaw(`<br><span class="color-purple">--- Device Information ---</span>`);
        logInfo('Model', `${extractProp(props, 'ro.product.model')} (${extractProp(props, 'ro.product.name')})`);
        logInfo('Brand', extractProp(props, 'ro.product.brand').toUpperCase());
        logInfo('Product code', extractProp(props, 'ril.product_code') || extractProp(props, 'ro.boot.product_code'));
        logInfo('CSC code', csc);
        logInfo('Hardware', extractProp(props, 'ro.soc.model') !== 'N/A' ? extractProp(props, 'ro.soc.model') : extractProp(props, 'ro.board.platform'));
        logInfo('Platform', extractProp(props, 'ro.hardware'));
        logInfo('CPU Arch', extractProp(props, 'ro.product.cpu.abi'));
        logInfo('Physical SN', snPhysical);
        logInfo('IMEI 1', (imei1 !== 'N/A' && !/^0+$/.test(imei1)) ? imei1 : '<span class="color-red">NOT FOUND / LOCKED</span>');
        logInfo('IMEI 2', (imei2 !== 'N/A' && !/^0+$/.test(imei2)) ? imei2 : '<span class="color-red">NOT FOUND / LOCKED</span>');
        logInfo('Unique ID', activeUsbDevice.serialNumber || 'N/A');

        logRaw(`<br><span class="color-purple">--- Software Information ---</span>`);
        logInfo('Build', extractProp(props, 'ro.build.display.id'));
        logInfo('Build date', extractProp(props, 'ro.build.date'));
        logInfo('Fingerprint', extractProp(props, 'ro.build.fingerprint'));
        logInfo('Security patch', extractProp(props, 'ro.build.version.security_patch'));
        logInfo('Android version', extractProp(props, 'ro.build.version.release'));
        logInfo('Android SDK', extractProp(props, 'ro.build.version.sdk'));
        logInfo('Baseband', extractProp(props, 'gsm.version.baseband') || extractProp(props, 'ro.boot.baseband'));
        logInfo('OneUI version', oneUi);

        logRaw(`<br><span class="color-purple">--- Device Status ---</span>`);
        logInfo('Timezone', extractProp(props, 'persist.sys.timezone'));
        logInfo('Language', extractProp(props, 'persist.sys.locale') || extractProp(props, 'ro.product.locale'));
        logInfo('Knox status', extractProp(props, 'ro.boot.warranty_bit'));
        logInfo('SIM operator', extractProp(props, 'gsm.sim.operator.alpha'));
        logInfo('Network type', extractProp(props, 'gsm.network.type'));
        logInfo('Android ID', androidId);
        logInfo('SE Linux', (extractProp(props, 'ro.build.selinux') || extractProp(props, 'selinux.policy_version')) === '1' ? 'Enforcing' : 'Permissive');

        logRaw(`<br><span class="color-purple">--- Root Status ---</span>`);
        logInfo('Shell SU', hasSu);
        logInfo('Magisk Binary', magiskVer);
        logInfo('FRP status', frpStatus);

        logRaw(`<br><span class="color-green">Read Info completed successfully.</span>`);
        statusText.innerText = "Status: Ready";
    } catch (e) {
        logRaw(`<br><span class="color-red">Read Info Error: ${e.message}</span>`);
    } finally {
        await setButtonsState(true);
    }
}

export async function resetFRP() {
    if (!(await ensureAdb())) return;
    await setButtonsState(false);
    try {
        logRaw(`<br><span class="color-purple">--- Starting Samsung FRP Reset Process ---</span>`);
        statusText.innerText = "Status: Searching for FRP Partition...";

        logRaw(`<span class="color-blue">[System] Checking for root access...</span>`);
        await currentAdb.subprocess.spawn('root');

        logRaw(`<span class="color-blue">[System] Scanning blocks by-name...</span>`);
        const lsProc = await currentAdb.subprocess.spawn('ls -al /dev/block/by-name/');
        const lsOutput = await readShellOutput(lsProc);
        const lines = lsOutput.split(/\r?\n/);
        const targetLine = lines.find(l => l.includes('persistent')) || lines.find(l => l.includes('frp'));
        
        if (targetLine) {
            const match = targetLine.match(/\/dev\/block\/\S+/);
            if (match) {
                const blockPath = match[0];
                logRaw(`<span class="color-green">[Found] Partition: ${blockPath}</span>`);
                statusText.innerText = "Status: Erasing FRP Partition...";

                logRaw(`<span class="color-purple">[Action] Erasing partition data...</span>`);
                const eraseProc = await currentAdb.subprocess.spawn(`dd if=/dev/zero of=${blockPath}`);
                const eraseResult = await readShellOutput(eraseProc);
                
                logRaw(`<span class="color-blue">${eraseResult.trim() || "Partition wiped."}</span>`);
                logRaw(`<span class="color-green">[Success] FRP partition erased successfully!</span>`);

                logRaw(`<span class="color-purple">[Action] Rebooting device...</span>`);
                statusText.innerText = "Status: Rebooting...";
                await currentAdb.subprocess.spawn('reboot');
                
                await setButtonsState(false);
                currentAdb = null;
                logRaw(`<br><span class="color-green">Done! Device is restarting.</span>`);
            }
        } else { 
            throw new Error("Could not find FRP/Persistent partition. Device might not be supported or ADB root failed."); 
        }
    } catch (e) { 
        logRaw(`<br><span class="color-red">FRP Reset FAIL: ${e.message}</span>`); 
        statusText.innerText = "Status: FRP Reset Failed";
    } finally {
        await setButtonsState(true);
    }
}

export async function disableKnox() {
    if (!(await ensureAdb())) return;
    await setButtonsState(false);
    const knoxPackages = [
        "com.samsung.android.sm.devicesecurity",
        "com.samsung.klmsagent",
        "com.samsung.android.cmfa.framework",
        "com.android.managedprovisioning",
        "com.sec.android.soagent",
        "com.samsung.android.fmm",
        "com.sec.android.emergencylauncher",
        "com.samsung.android.bbc.bbcagent",
        "com.wssyncmldm",
        "com.sec.epdg",
        "com.samsung.sec.android.application.csc"
    ];
    
    try {
        logRaw(`<br><span class="color-purple">--- Starting Knox/MDM Disable Process ---</span>`);
        statusText.innerText = "Status: Disabling Knox Packages...";

    for (const pkg of knoxPackages) {
        const res = await execShell(currentAdb, `pm disable-user --user 0 ${pkg}`);
            if (res.toLowerCase().includes('new state: disabled')) {
                logRaw(`<span class="color-green">[OK] Disabled: ${pkg}</span>`);
            } else {
                logRaw(`<span class="color-blue">[SKIP/FAIL] ${pkg}: ${res.trim() || 'No response'}</span>`);
            }
        }

        logRaw(`<span class="color-purple">--- Process Finished! Check device status ---</span>`);
        statusText.innerText = "Status: Ready (Knox Process Finished)";
    } catch (err) {
        logRaw(`<br><span class="color-red">Knox Disable FAIL: ${err.message}</span>`);
    } finally {
        await setButtonsState(true);
    }
}

export async function adbReboot(mode = "") {
    if (!(await ensureAdb())) return;
    await setButtonsState(false);
    try {
        logRaw(`<span class="color-green">Sending reboot ${mode} command...</span>`);
        // نستخدم طريقة "spawn" دون انتظار المخرجات لضمان عدم التعليق
        currentAdb.subprocess.spawn(`reboot ${mode}`).catch(() => {});
        
        // تصفير الحالة فوراً
        currentAdb = null;
        statusText.innerText = "Status: Device Rebooting";
    } catch (e) { logRaw(`<span class="color-red">Reboot Error: ${e.message}</span>`); }
    finally {
        setTimeout(() => setButtonsState(true), 3000);
    }
}

export async function refreshAppList() {
    if (!(await ensureAdb())) return;
    const body = document.getElementById('appTableBody');
    body.innerHTML = "<tr><td colspan='4'>Loading...</td></tr>";
    const raw = await execShell(currentAdb, 'pm list packages -f --user 0');
    const disabledRaw = await execShell(currentAdb, 'pm list packages -d --user 0');
    const disabledList = disabledRaw.split(/\r?\n/).map(l => l.replace('package:', '').trim());

    allPackages = raw.split(/\r?\n/).filter(l => l.includes('=')).map(line => {
        const parts = line.split('=');
        const pkg = parts.pop().trim();
        return { name: pkg, isEnabled: !disabledList.includes(pkg), isSystem: !line.includes('/data/app') };
    });
    renderApps();
}

export function renderApps() {
    const searchInput = document.getElementById('appSearch');
    const filterSelect = document.getElementById('appFilter');
    
    const search = searchInput ? searchInput.value.toLowerCase() : '';
    const filter = filterSelect ? filterSelect.value : 'all';
    const body = document.getElementById('appTableBody');
    
    const filtered = allPackages.filter(app => {
        const matches = app.name.toLowerCase().includes(search);
        if (filter === 'enabled') return matches && app.isEnabled;
        if (filter === 'disabled') return matches && !app.isEnabled;
        return matches;
    });

    body.innerHTML = filtered.map(app => `
        <tr>
            <td>${app.name}</td>
            <td class="${app.isEnabled ? 'color-green' : 'color-red'}">${app.isEnabled ? 'On' : 'Off'}</td>
            <td>${app.isSystem ? 'Sys' : 'User'}</td>
            <td>
                <button class="btn-mini" onclick="window.appAction('${app.name}', '${app.isEnabled ? 'disable' : 'enable'}')">Toggle</button>
                <button class="btn-mini" onclick="window.appAction('${app.name}', 'clear')">Clear</button>
                <button class="btn-mini btn-red" onclick="window.appAction('${app.name}', 'uninstall')">Del</button>
            </td>
        </tr>
    `).join('');
}

window.appAction = async (pkg, action) => {
    let cmd = "";
    if (action === 'disable') cmd = `pm disable-user --user 0 ${pkg}`;
    else if (action === 'enable') cmd = `pm enable ${pkg}`;
    else if (action === 'clear') cmd = `pm clear ${pkg}`;
    else if (action === 'uninstall') cmd = `pm uninstall --user 0 ${pkg}`;
    
    logRaw(`<span class="color-purple">[AppMgr] Doing ${action}...</span>`);
    await execShell(currentAdb, cmd);
    await refreshAppList();
};

export async function installApk(file) {
    if (!(await ensureAdb())) return;
    const progressBar = document.getElementById('installProgressBar');
    const progressCont = document.getElementById('installProgressContainer');
    const percentText = document.getElementById('installPercent');
    const apkInput = document.getElementById('apkInput');
    
    // تصفير شريط التقدم
    progressBar.style.width = '0%';
    percentText.innerText = '0%';
    
    progressCont.style.display = 'block';
    const tempPath = `/data/local/tmp/app.apk`;
    let sync = await currentAdb.sync();
    
    let uploaded = 0;
    const progressTransform = new TransformStream({
        transform(chunk, controller) {
            uploaded += chunk.byteLength;
            const p = Math.round((uploaded / file.size) * 100);
            progressBar.style.width = p + '%';
            percentText.innerText = p + '%';
            controller.enqueue(chunk);
        }
    });

    try {
        await sync.write(tempPath, file.stream().pipeThrough(progressTransform), Math.floor(Date.now() / 1000));
        await sync.dispose();
        
        const res = await execShell(currentAdb, `pm install -r -t -g "${tempPath}"`);
        logRaw(`<span class="color-blue">[Install] ${res}</span>`);
        await execShell(currentAdb, `rm "${tempPath}"`);
    } catch (e) {
        logRaw(`<span class="color-red">[Install Error] ${e.message}</span>`);
    } finally {
        setTimeout(() => { progressCont.style.display = 'none'; }, 2000);
        if (apkInput) apkInput.value = '';
        await refreshAppList();
    }
}

export async function executeCustomCommand(command) {
    if (!(await ensureAdb())) return;
    try {
        logRaw(`<span class="color-blue">> adb ${command}</span>`);
        const output = await execShell(currentAdb, command);
        // عرض النتيجة بتنسيق نظيف داخل Terminal
        logRaw(`<div class="color-white" style="background: rgba(255,255,255,0.05); padding: 5px; border-radius: 4px; font-family: monospace; white-space: pre-wrap;">${output || '(No output returned)'}</div>`);
    } catch (e) {
        logRaw(`<span class="color-red">Execution Error: ${e.message}</span>`);
    }
}