function registerAssemblyAiIpc(options) {
  // Prefer the shared STT IPC registrar; keep this module for import compatibility.
  const { registerSttIpc } = require('../stt/ipc');
  return registerSttIpc({
    ipcMain: options.ipcMain,
    sttService: options.sttService || options.assemblyAiService
  });
}

module.exports = {
  registerAssemblyAiIpc
};
