const tokenInput = document.getElementById('token');
const baserowBaseUrlInput = document.getElementById('baserowBaseUrl');
const baserowTokenInput = document.getElementById('baserowToken');
const baserowUsersTableIdInput = document.getElementById('baserowUsersTableId');
const baserowOrdersTableIdInput = document.getElementById('baserowOrdersTableId');
const status = document.getElementById('status');

chrome.storage.local.get(
  ['manychatToken', 'baserowBaseUrl', 'baserowToken', 'baserowUsersTableId', 'baserowOrdersTableId'],
  ({ manychatToken, baserowBaseUrl, baserowToken, baserowUsersTableId, baserowOrdersTableId }) => {
    if (manychatToken) tokenInput.value = manychatToken;
    if (baserowBaseUrl) baserowBaseUrlInput.value = baserowBaseUrl;
    if (baserowToken) baserowTokenInput.value = baserowToken;
    if (baserowUsersTableId) baserowUsersTableIdInput.value = baserowUsersTableId;
    if (baserowOrdersTableId) baserowOrdersTableIdInput.value = baserowOrdersTableId;
  }
);

document.getElementById('save').addEventListener('click', () => {
  chrome.storage.local.set(
    {
      manychatToken: tokenInput.value.trim(),
      baserowBaseUrl: baserowBaseUrlInput.value.trim().replace(/\/+$/, ''),
      baserowToken: baserowTokenInput.value.trim(),
      baserowUsersTableId: baserowUsersTableIdInput.value.trim(),
      baserowOrdersTableId: baserowOrdersTableIdInput.value.trim(),
    },
    () => {
      status.textContent = 'Saved.';
      setTimeout(() => {
        status.textContent = '';
      }, 1500);
    }
  );
});
