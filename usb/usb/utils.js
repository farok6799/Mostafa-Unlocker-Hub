export const terminal = document.getElementById('terminal');
export const statusText = document.getElementById('statusText');

export function logRaw(html) {
    if (!terminal) return;
    const entry = document.createElement('div');
    entry.className = 'log-entry';
    entry.innerHTML = html;
    terminal.appendChild(entry);
    terminal.scrollTop = terminal.scrollHeight;
}

export function escapeHtml(value) {
    return String(value ?? '')
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;')
        .replaceAll("'", '&#039;');
}

export function logInfo(label, value) {
    logRaw(`
        <div class="info-row">
            <div class="info-label">${escapeHtml(label)}</div>
            <div class="info-colon">:</div>
            <div class="info-value">${escapeHtml(value)}</div>
        </div>
    `);
}

export function setStatus(text, tone = '') {
    if (!statusText) return;
    statusText.className = tone ? `status-text ${tone}` : 'status-text';
    statusText.textContent = text;
}

export function setButtonsState(enabled) {
    const actionButtons = [
        'btnConnect', 'btnReadInfo', 'btnKnox', 'btnAppManager', 'btnFRP',
        'btnReboot', 'btnDownload', 'btnFastboot', 'btnRecovery',
        'btnMTP', 'btnSendAT', 'btnSerialInfo', 'btnSerialRefresh', 'btnSerialReboot', 'btnSerialAndroidReboot', 'btnSerialDownloadAdb', 'btnSerialDownload', 'btnReadDownloadInfo', 'btnDownloadReboot',
        'btnApple', 'btnEnterRecovery', 'btnExitRecovery',
        'btnFastbootInfo', 'btnFastbootReboot', 'btnHonorInfo', 'btnHonorFRP',
        'btnADBMenu', 'btnRebootMenu', 'btnFastbootMenu',
        'btnDownloadMenu', 'btnAppleMenu', 'btnCustomAdbMenu',
        'btnExecuteCustomAdb', 'btnExecuteCustomFastboot', 'btnClear'
    ];

    actionButtons.forEach(id => {
        const btn = document.getElementById(id);
        if (btn) {
            btn.disabled = !enabled;
            btn.classList.toggle('disabled-link', !enabled);
        }
    });
}

export let activeUsbDevice = null;

export function setActiveUsbDevice(device) {
    activeUsbDevice = device;
}

export function ensureWebUsbSupport() {
    if (!('usb' in navigator)) {
        throw new Error('WebUSB is not supported in this browser. Use the latest Chrome or Edge over HTTPS.');
    }
    if (!window.isSecureContext) {
        throw new Error('WebUSB requires a secure HTTPS page (or localhost).');
    }
}

export async function closeActiveUsbDevice() {
    const device = activeUsbDevice;
    activeUsbDevice = null;
    if (!device) return;

    try {
        if (device.opened) await device.close();
    } catch (error) {
        console.warn('Unable to close the previous USB session:', error);
    }
}

function deviceMatchesFilters(device, filters) {
    return filters.some(filter =>
        filter.vendorId === device.vendorId &&
        (!filter.productId || filter.productId === device.productId)
    );
}

export async function getOrRequestDevice(filters) {
    ensureWebUsbSupport();

    if (activeUsbDevice && deviceMatchesFilters(activeUsbDevice, filters)) {
        return activeUsbDevice;
    }

    await closeActiveUsbDevice();

    const pairedDevices = await navigator.usb.getDevices();
    let device = pairedDevices.find(candidate => deviceMatchesFilters(candidate, filters));

    if (!device) {
        device = await navigator.usb.requestDevice({ filters });
    }

    try {
        if (!device.opened) await device.open();
        activeUsbDevice = device;
        return device;
    } catch (error) {
        activeUsbDevice = null;
        throw error;
    }
}

export async function findInterfaceAndEndpoints(device, type = 'bulk') {
    try {
        if (!device.configuration) await device.selectConfiguration(1);
    } catch (error) {
        console.warn('Unable to select USB configuration:', error);
    }

    if (!device.configuration) return null;

    for (const iface of device.configuration.interfaces) {
        for (const alt of iface.alternates) {
            const outEp = alt.endpoints.find(endpoint => endpoint.direction === 'out' && endpoint.type === type);
            const inEp = alt.endpoints.find(endpoint => endpoint.direction === 'in' && endpoint.type === type);

            if (outEp && inEp) {
                try {
                    if (!iface.claimed) await device.claimInterface(iface.interfaceNumber);
                    if (device.configuration.interfaces[iface.interfaceNumber]?.alternate?.alternateSetting !== alt.alternateSetting) {
                        await device.selectAlternateInterface(iface.interfaceNumber, alt.alternateSetting);
                    }

                    return {
                        interfaceNumber: iface.interfaceNumber,
                        endpointOut: outEp.endpointNumber,
                        endpointIn: inEp.endpointNumber
                    };
                } catch (error) {
                    console.warn(`USB interface ${iface.interfaceNumber} is unavailable:`, error);
                }
            }
        }
    }

    return null;
}

export async function releaseUsbInterface(device, interfaceNumber) {
    if (!device || interfaceNumber === undefined || interfaceNumber === null) return;
    try {
        await device.releaseInterface(interfaceNumber);
    } catch (error) {
        console.warn('Unable to release USB interface:', error);
    }
}

export async function autoDetectTask() {
    try {
        ensureWebUsbSupport();
        const devices = await navigator.usb.getDevices();
        if (devices.length > 0) {
            const device = devices[0];
            const mode = device.opened ? 'Active' : 'Ready';
            setStatus(`${device.productName || 'USB device'} · ${mode}`, 'connected');
        } else if (!/Error|Reading|Searching|Connecting/.test(statusText?.textContent || '')) {
            setStatus('Waiting for device…');
        }
    } catch (error) {
        if (statusText && !window.isSecureContext) setStatus('HTTPS required', 'error');
    }
}

export function describeUsbError(error) {
    const message = error?.message || String(error || 'Unknown USB error');
    const normalized = message.toLowerCase();

    if (normalized.includes('access denied') || normalized.includes('permission')) {
        return {
            title: 'USB access was denied',
            detail: 'The browser can see the device, but the operating system or another Apple utility currently owns its USB interface.'
        };
    }
    if (normalized.includes('no device selected') || normalized.includes('cancel')) {
        return {
            title: 'No device selected',
            detail: 'Open the device picker again and select the intended device while it is still connected in the required mode.'
        };
    }
    return { title: 'USB operation failed', detail: message };
}
