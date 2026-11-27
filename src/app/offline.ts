/** Track offline readiness and let the user choose when to restart into a saved update. */
export async function registerOffline(status: HTMLElement, updateButton: HTMLButtonElement): Promise<void> {
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
    const current = hasController() ? await workers.getRegistration(scriptURL) : undefined;
    const registration = current ?? await workers.register(scriptURL, { updateViaCache: 'none' });
    let requested: ServiceWorker | null = null;

    function render(): void {
      const usable = hasController() || registration.active?.state === 'activated';
      updateButton.hidden = !(usable && registration.waiting);
      if (!updateButton.hidden) show('Update available');
      else if (registration.installing && usable) show('Downloading update…');
      else if (usable) show(ready);
      else if (registration.installing || registration.waiting || registration.active) show(saving);
      else show(failed);
    }

    function track(): void {
      const worker = registration.installing ?? registration.waiting ?? registration.active;
      worker?.addEventListener('statechange', render);
      render();
    }

    function checkForUpdate(): void {
      if (document.hidden || !registration.active || registration.installing || registration.waiting) return;
      // A disconnected launch can continue to use the active release.
      void registration.update().catch(() => {});
    }
    registration.addEventListener('updatefound', track);
    updateButton.addEventListener('click', () => {
      requested = registration.waiting;
      requested?.postMessage({ type: 'apply-update' });
    });
    workers.addEventListener('message', event => {
      if (requested && event.source === requested && event.data?.type === 'other-windows-open') {
        requested = null;
        show('Close other Fluxity windows and retry');
      }
    });
    workers.addEventListener('controllerchange', () => {
      if (requested && workers.controller === requested) window.location.reload();
      else render();
    });
    document.addEventListener('visibilitychange', checkForUpdate);
    window.addEventListener('online', checkForUpdate);
    track();
    checkForUpdate();
  } catch (error) {
    if (status.textContent !== ready) show(failed);
    console.warn('[Fluxity] Could not register the offline worker.', error);
  }
}
