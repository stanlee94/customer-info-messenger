const tokenInput = document.getElementById('token');
const baserowBaseUrlInput = document.getElementById('baserowBaseUrl');
const baserowTokenInput = document.getElementById('baserowToken');
const baserowUsersTableIdInput = document.getElementById('baserowUsersTableId');
const baserowOrdersTableIdInput = document.getElementById('baserowOrdersTableId');
const aiApiUrlInput = document.getElementById('aiApiUrl');
const aiApiTokenInput = document.getElementById('aiApiToken');
const status = document.getElementById('status');

chrome.storage.local.get(
  ['manychatToken', 'baserowBaseUrl', 'baserowToken', 'baserowUsersTableId', 'baserowOrdersTableId', 'aiApiUrl', 'aiApiToken'],
  ({ manychatToken, baserowBaseUrl, baserowToken, baserowUsersTableId, baserowOrdersTableId, aiApiUrl, aiApiToken }) => {
    if (manychatToken) tokenInput.value = manychatToken;
    if (baserowBaseUrl) baserowBaseUrlInput.value = baserowBaseUrl;
    if (baserowToken) baserowTokenInput.value = baserowToken;
    if (baserowUsersTableId) baserowUsersTableIdInput.value = baserowUsersTableId;
    if (baserowOrdersTableId) baserowOrdersTableIdInput.value = baserowOrdersTableId;
    if (aiApiUrl) aiApiUrlInput.value = aiApiUrl;
    if (aiApiToken) aiApiTokenInput.value = aiApiToken;
  }
);

// Live overlay toggle saves on flip (off by default); background.js
// registers/unregisters the EC2 content script from this key.
const ec2LiveInput = document.getElementById('ec2LiveEnabled');
const liveStatus = document.getElementById('liveStatus');
let liveStatusTimer;
chrome.storage.local.get('ec2LiveEnabled', ({ ec2LiveEnabled }) => {
  ec2LiveInput.checked = ec2LiveEnabled === true;
});
ec2LiveInput.addEventListener('change', () => {
  chrome.storage.local.set({ ec2LiveEnabled: ec2LiveInput.checked }, () => {
    liveStatus.textContent = ec2LiveInput.checked
      ? 'Live features on — reload open EC2 live tabs.'
      : 'Live features off — reload open EC2 live tabs.';
    clearTimeout(liveStatusTimer);
    liveStatusTimer = setTimeout(() => { liveStatus.textContent = ''; }, 4000);
  });
});

// Staff name — signs Balance / Note saves when the Facebook name can't be
// read from the page. Saves on every edit (debounced), like the live toggle.
const staffNameInput = document.getElementById('staffName');
const staffStatus = document.getElementById('staffStatus');
let staffTimer;
chrome.storage.local.get('staffName', ({ staffName }) => {
  if (staffName) staffNameInput.value = staffName;
});
staffNameInput.addEventListener('input', () => {
  clearTimeout(staffTimer);
  staffTimer = setTimeout(() => {
    chrome.storage.local.set({ staffName: staffNameInput.value.trim() }, () => {
      staffStatus.textContent = staffNameInput.value.trim() ? 'Name saved.' : 'Name cleared.';
      setTimeout(() => { staffStatus.textContent = ''; }, 1500);
    });
  }, 400);
});

// Balance / Note preview backend controls (background.js noteMock*).
const notesMockFailInput = document.getElementById('notesMockFail');
const notesStatus = document.getElementById('notesStatus');
function flashNotesStatus(text) {
  notesStatus.textContent = text;
  setTimeout(() => { notesStatus.textContent = ''; }, 2000);
}
chrome.storage.local.get('notesMockFail', ({ notesMockFail }) => {
  notesMockFailInput.value = notesMockFail || '';
});
const threadListSizeInput = document.getElementById('threadListSize');
chrome.storage.local.get('threadListSize', ({ threadListSize }) => {
  threadListSizeInput.value = ['compact', 'extra', 'off'].includes(threadListSize) ? threadListSize : 'compact';
});
threadListSizeInput.addEventListener('change', () => {
  chrome.storage.local.set({ threadListSize: threadListSizeInput.value }, () => {
    flashNotesStatus('List size saved — open inbox tabs update by themselves.');
  });
});
const compactMetaInput = document.getElementById('compactMetaHeaders');
chrome.storage.local.get('compactMetaHeaders', ({ compactMetaHeaders }) => {
  compactMetaInput.checked = compactMetaHeaders !== false;
});
compactMetaInput.addEventListener('change', () => {
  chrome.storage.local.set({ compactMetaHeaders: compactMetaInput.checked }, () => {
    flashNotesStatus(compactMetaInput.checked ? 'Compact headers on.' : 'Compact headers off.');
  });
});
const noteBarPlacementInput = document.getElementById('noteBarPlacement');
chrome.storage.local.get('noteBarPlacement', ({ noteBarPlacement }) => {
  noteBarPlacementInput.value = noteBarPlacement === 'panel' ? 'panel' : 'header';
});
noteBarPlacementInput.addEventListener('change', () => {
  chrome.storage.local.set({ noteBarPlacement: noteBarPlacementInput.value }, () => {
    flashNotesStatus('Placement saved — open inbox tabs update by themselves.');
  });
});
notesMockFailInput.addEventListener('change', () => {
  chrome.storage.local.set({ notesMockFail: notesMockFailInput.value }, () => {
    flashNotesStatus(notesMockFailInput.value ? 'Failure simulation on.' : 'Failure simulation off.');
  });
});
document.getElementById('clearNotesMock').addEventListener('click', () => {
  if (!confirm('Delete every preview balance, note and history entry stored in this browser?')) return;
  chrome.storage.local.get(null, (all) => {
    const keys = Object.keys(all).filter((k) => k.startsWith('noteMock:') || k === 'noteMockLog');
    chrome.storage.local.remove(keys, () => flashNotesStatus(`Cleared ${keys.length} item${keys.length === 1 ? '' : 's'}.`));
  });
});

document.getElementById('save').addEventListener('click', () => {
  chrome.storage.local.set(
    {
      manychatToken: tokenInput.value.trim(),
      baserowBaseUrl: baserowBaseUrlInput.value.trim().replace(/\/+$/, ''),
      baserowToken: baserowTokenInput.value.trim(),
      baserowUsersTableId: baserowUsersTableIdInput.value.trim(),
      baserowOrdersTableId: baserowOrdersTableIdInput.value.trim(),
      aiApiUrl: aiApiUrlInput.value.trim().replace(/\/+$/, ''),
      aiApiToken: aiApiTokenInput.value.trim(),
    },
    () => {
      status.textContent = 'Saved.';
      setTimeout(() => {
        status.textContent = '';
      }, 1500);
    }
  );
});
