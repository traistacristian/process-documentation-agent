# Deploying the browser extension to company devices

The extension is in `extension/`. The pipeline (`.github/workflows/ci.yml`) zips it as
`pda-extension-<version>.zip` on every build.

## 1. Publish it (once per version)

Pick one:

- **Microsoft Edge Add-ons, hidden listing** (recommended): Partner Center → Edge → *Create new extension* →
  upload the zip → Visibility: *Hidden*. Edge gives it an extension id and an update URL
  (`https://edge.microsoft.com/extensionwebstorebase/v1/crx`). Updates are automatic.
- **Chrome Web Store, unlisted / private to your Google Workspace** if your users are on Chrome.
- **Self-hosted CRX**: pack with `msedge --pack-extension=extension --pack-extension-key=key.pem`, host the
  `.crx` and an `update.xml` on an internal HTTPS site. Keep `key.pem` in Key Vault, it fixes the extension id.

## 2. Force-install it and lock it to your server (Intune)

Intune → Devices → Configuration → *Create* → Windows 10 and later → **Settings catalog**:

1. *Microsoft Edge → Extensions → Control which extensions are installed silently*
   (`ExtensionInstallForcelist`): `<extension-id>;https://edge.microsoft.com/extensionwebstorebase/v1/crx`
2. *Microsoft Edge → Extensions → Configure extension management settings* (`ExtensionSettings`): paste
   `edge-extension-settings.json` from this folder with your extension id. It pins the toolbar icon so the
   `REC` badge is always visible and limits the extension to http(s) pages.
3. The extension's own policy (which server it may pair with) is set through the registry with a custom
   OMA-URI or a PowerShell platform script, see `set-extension-policy.ps1`.

Group Policy works the same way with the Edge ADMX templates.

`allowedServers` makes the extension refuse to pair with any other site, so a phishing page cannot start
a capture. Leave it empty only on test machines.
