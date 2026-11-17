const sections = new Set(['start', 'consultation-history', 'report-history', 'explore', 'profile']);
const dialogs = new Set(['none', 'end', 'exit']);
const requests = new Set(['idle', 'sending', 'aborting']);

export function createConsultationState() {
  let value = { visibility: 'closed', section: 'start', dialog: 'none', requestStatus: 'idle' };
  const listeners = new Set();
  const emit = () => listeners.forEach(/** @param {(value: any) => void} listener */ listener => listener({ ...value }));
  /** @param {any} change */ const set = change => { value = { ...value, ...change }; emit(); };
  function requireOpen() {
    if (value.visibility !== 'open') throw new Error('Cannot change consultation state without an open consultation');
  }
  return {
    get: () => ({ ...value }),
    /** @param {(value: any) => void} listener */ subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    openAtStart() { set({ visibility: 'open', section: 'start', dialog: 'none', requestStatus: 'idle' }); },
    openConversation(section = 'explore') { requireOpen(); if (!sections.has(section)) throw new Error('Invalid consultation section'); set({ section, dialog: 'none' }); },
    openEndDialog() { requireOpen(); set({ dialog: 'end' }); },
    openExitDialog() { requireOpen(); set({ dialog: 'exit' }); },
    closeDialog() { requireOpen(); set({ dialog: 'none' }); },
    /** @param {string} requestStatus */ setRequestStatus(requestStatus) {
      if (!requests.has(requestStatus)) throw new Error('Invalid request status');
      requireOpen();
      if (requestStatus === 'aborting' && value.requestStatus !== 'sending') throw new Error('Cannot abort without a sending request');
      if (requestStatus === 'sending' && value.requestStatus !== 'idle') throw new Error('Cannot start while a request is active');
      set({ requestStatus });
    },
    close() { set({ visibility: 'closed', dialog: 'none', requestStatus: 'idle' }); },
  };
}
