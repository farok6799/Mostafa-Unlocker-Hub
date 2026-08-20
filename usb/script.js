import { autoDetectTask, logRaw, setActiveUsbDevice, setButtonsState, setStatus, terminal } from './utils.js';
import * as adb from './adb-handler.js';
import * as samsung from './samsung-handler.js';
import * as fastboot from './fastboot-handler.js';
import * as apple from './apple-handler.js';

const byId = id => document.getElementById(id);

function bindAction(id, action) {
    const element = byId(id);
    if (!element) return;
    element.addEventListener('click', async event => {
        event.preventDefault();
        element.classList.add('is-busy');
        try {
            await action();
        } finally {
            element.classList.remove('is-busy');
        }
    });
}

function showSection(targetSection) {
    document.querySelectorAll('.nav-item[data-section]').forEach(item => {
        item.classList.toggle('active', item.dataset.section === targetSection);
    });

    document.querySelectorAll('.card[id^="section-"]').forEach(section => {
        const showAll = targetSection === 'all';
        const shouldShow = showAll || section.id === `section-${targetSection}` || section.classList.contains('terminal-card');
        section.classList.toggle('hidden-section', !shouldShow);
    });

    byId('sidebar')?.classList.remove('open');
}

function bindEnter(inputId, action) {
    const input = byId(inputId);
    if (!input) return;
    input.addEventListener('keydown', async event => {
        if (event.key !== 'Enter') return;
        event.preventDefault();
        const command = input.value.trim();
        if (!command) return;
        await action(command);
        input.value = '';
    });
}

function init() {
    if (typeof lucide !== 'undefined') lucide.createIcons();
    setButtonsState(true);
    showSection('adb');

    if (!('usb' in navigator)) {
        setStatus('WebUSB unavailable', 'error');
        logRaw('<div class="notice notice-warning"><strong>WebUSB is unavailable.</strong><br>Open this page in the latest Chrome or Edge over HTTPS. Safari and Firefox do not expose the required WebUSB API.</div>');
    } else if (!window.isSecureContext) {
        setStatus('HTTPS required', 'error');
        logRaw('<div class="notice notice-warning"><strong>Secure context required.</strong><br>GitHub Pages HTTPS is supported. If testing locally, use localhost rather than opening the HTML file directly.</div>');
    } else {
        setStatus('Waiting for device…');
    }

    document.querySelectorAll('.nav-item[data-section]').forEach(item => {
        item.addEventListener('click', event => {
            event.preventDefault();
            showSection(item.dataset.section);
        });
    });

    byId('menuToggle')?.addEventListener('click', event => {
        event.stopPropagation();
        byId('sidebar')?.classList.toggle('open');
    });

    byId('operationSearch')?.addEventListener('input', event => {
        const query = event.target.value.toLowerCase().trim();
        document.querySelectorAll('.card[id^="section-"]').forEach(card => {
            if (!query) {
                card.classList.toggle('hidden-section', !card.classList.contains('terminal-card') && !card.classList.contains('adb-card'));
                return;
            }
            const matches = card.textContent.toLowerCase().includes(query);
            card.classList.toggle('hidden-section', !matches);
        });
    });

    bindAction('btnConnect', adb.connectADB);
    bindAction('btnReadInfo', adb.readDeviceInfo);
    bindAction('btnFRP', adb.resetFRP);
    bindAction('btnKnox', adb.disableKnox);
    bindAction('btnReboot', () => adb.adbReboot(''));
    bindAction('btnDownload', () => adb.adbReboot('download'));
    bindAction('btnFastboot', () => adb.adbReboot('bootloader'));
    bindAction('btnRecovery', () => adb.adbReboot('recovery'));

    bindAction('btnMTP', samsung.handleMTP);
    bindAction('btnReadDownloadInfo', samsung.readDownloadInfo);
    bindAction('btnDownloadReboot', samsung.odinReboot);

    bindAction('btnApple', apple.readAppleInfo);
    bindAction('btnEnterRecovery', apple.enterAppleRecovery);
    bindAction('btnExitRecovery', apple.exitAppleRecovery);

    bindAction('btnFastbootInfo', fastboot.fastbootInfo);
    bindAction('btnFastbootReboot', fastboot.fastbootReboot);
    bindAction('btnHonorInfo', fastboot.honorInfo);
    bindAction('btnHonorFRP', fastboot.honorFRP);

    bindAction('btnExecuteCustomAdb', async () => {
        const input = byId('customAdbCommandInput');
        const command = input?.value.trim();
        if (command) {
            await adb.executeCustomCommand(command);
            input.value = '';
        } else {
            logRaw('<span class="color-red">Please enter an ADB command to execute.</span>');
        }
    });

    bindAction('btnExecuteCustomFastboot', async () => {
        const input = byId('customFastbootCommandInput');
        const command = input?.value.trim();
        if (command) {
            await fastboot.executeCustomFastbootCommand(command);
            input.value = '';
        } else {
            logRaw('<span class="color-red">Please enter a Fastboot command.</span>');
        }
    });

    bindEnter('customAdbCommandInput', adb.executeCustomCommand);
    bindEnter('customFastbootCommandInput', fastboot.executeCustomFastbootCommand);

    const openAppManager = async () => {
        if (await adb.ensureAdb()) {
            byId('appModal').style.display = 'flex';
            await adb.refreshAppList();
        }
    };
    bindAction('btnAppManager', openAppManager);
    bindAction('btnAppManagerSidebar', openAppManager);

    const appSearch = byId('appSearch');
    if (appSearch) appSearch.addEventListener('input', adb.renderApps);
    const appFilter = byId('appFilter');
    if (appFilter) appFilter.addEventListener('change', adb.renderApps);

    byId('btnInstallApk')?.addEventListener('click', event => {
        event.preventDefault();
        byId('apkInput')?.click();
    });
    byId('apkInput')?.addEventListener('change', event => {
        if (event.target.files?.length) adb.installApk(event.target.files[0]);
    });

    document.addEventListener('click', event => {
        if (event.target.closest('.close-modal')) byId('appModal').style.display = 'none';
        const sidebar = byId('sidebar');
        if (sidebar && !event.target.closest('.sidebar') && !event.target.closest('#menuToggle')) sidebar.classList.remove('open');
    });

    byId('btnClear')?.addEventListener('click', () => {
        terminal.innerHTML = '<div class="terminal-line info">&gt;_ Terminal cleared. System ready.</div>';
    });

    if ('usb' in navigator) {
        navigator.usb.addEventListener('disconnect', event => {
            const name = event.device?.productName || 'USB device';
            logRaw(`<div class="notice notice-warning"><strong>Device disconnected:</strong> ${name}</div>`);
            setStatus('Device disconnected', 'error');
            byId('appModal').style.display = 'none';
            adb.resetAdbState();
            setActiveUsbDevice(null);
        });
        setInterval(autoDetectTask, 2000);
    }
}

document.addEventListener('DOMContentLoaded', init);
