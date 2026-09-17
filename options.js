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
