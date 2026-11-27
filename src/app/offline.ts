/** Show readiness only after the worker has finished caching the production build. */
export async function registerOffline(status: HTMLElement): Promise<void> {
  const scriptURL = new URL(import.meta.env.BASE_URL + 'sw.js', document.baseURI).href;
  const ready = 'Ready for offline use';
  const saving = 'Saving for offline use…';
  const failed = 'Offline setup incomplete';

  function show(message: string): void {
    status.hidden = false;
    status.textContent = message;
    status.title = message === failed ? 'Reconnect and reload to retry saving Fluxity.' : '';
  }

  try {
    if (!('serviceWorker' in navigator)) {
      show('Offline use unavailable');
      return;
    }
    const workers = navigator.serviceWorker;
    const hasController = () => workers.controller?.scriptURL === scriptURL;
    show(hasController() ? ready : saving);
    const registration = await workers.register(scriptURL);

    function track(): void {
      const worker = registration.active ?? registration.waiting ?? registration.installing;
      function report(): void {
        if (worker?.state === 'activated' || hasController()) {
          show(ready);
          registration.removeEventListener('updatefound', track);
          worker?.removeEventListener('statechange', report);
        } else if (!worker || worker.state === 'redundant') {
          show(failed);
        } else {
          show(saving);
        }
      }
      worker?.addEventListener('statechange', report);
      report();
    }
    registration.addEventListener('updatefound', track);
    track();
  } catch (error) {
    // Re-registering can fail offline even when an existing worker serves this launch.
    if (status.textContent !== ready) show(failed);
    console.warn('[Fluxity] Could not register the offline worker.', error);
  }
}
