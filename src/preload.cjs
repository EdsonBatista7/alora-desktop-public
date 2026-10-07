const { contextBridge, ipcRenderer } = require('electron');

const invoke = (channel, ...args) => ipcRenderer.invoke(channel, ...args).catch((error) => {
  const message = String(error?.message ?? 'Não foi possível concluir a ação.')
    .replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '');
  throw new Error(message);
});

contextBridge.exposeInMainWorld('aloraDesktop', {
  state: () => invoke('alora:state'),
  pair: (code) => invoke('alora:pair', code),
  signIn: () => invoke('alora:signin'),
  signOut: () => invoke('alora:signout'),
  fallback: (slug) => invoke('alora:fallback', slug),
  effort: (effort) => invoke('alora:effort', effort),
  enable: (enabled) => invoke('alora:enable', enabled),
  onState: (callback) => {
    const listener = (_event, value) => callback(value);
    ipcRenderer.on('alora:state-changed', listener);
    return () => ipcRenderer.removeListener('alora:state-changed', listener);
  },
});
