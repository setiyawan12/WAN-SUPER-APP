// Desktop re-implementation of the extension's vscodeApi.ts. Same exported
// function names/signatures, so the pages that import them (Providers, the
// old Sidebar) are untouched -- but there is no VS Code webview host here, so
// each one now goes through the window.wan bridge (handbook Tahap 5.3).

/** Bring the dashboard window forward (was: open the editor-tab panel). */
export function postOpenDashboardPanel(_page?: string) {
  void window.wan.focus();
}

/** Trigger a VS Code model sync now. */
export function postSyncModels() {
  void window.wan.syncNow();
}

/** Copy the proxy API key to the clipboard. */
export function postCopyApiKey() {
  void window.wan.copyApiKey();
}

/** Open a URL in the real system browser (OAuth login buttons need this). */
export function postOpenExternal(url: string) {
  void window.wan.openExternal(url);
}
