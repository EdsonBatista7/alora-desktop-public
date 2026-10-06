const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('aloraDesktop', {
  state: () => ipcRenderer.invoke('alora:state'),
  pair: (code) => ipcRenderer.invoke('alora:pair', code),
  signIn: () => ipcRenderer.invoke('alora:signin'),
  signOut: () => ipcRenderer.invoke('alora:signout'),
  model: (slug) => ipcRenderer.invoke('alora:model', slug),
  enable: (enabled) => ipcRenderer.invoke('alora:enable', enabled),
  onState: (callback) => {
    const listener = (_event, value) => callback(value);
    ipcRenderer.on('alora:state-changed', listener);
    return () => ipcRenderer.removeListener('alora:state-changed', listener);
  },
});
