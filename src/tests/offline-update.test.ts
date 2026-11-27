import { afterEach, expect, it, vi } from 'vitest';
import { registerOffline } from '../app/offline';

function worker(state: ServiceWorkerState) {
  return Object.assign(new EventTarget(), { state, scriptURL: 'https://example.com/sw.js', postMessage: vi.fn() });
}

function installedApp() {
  const active = worker('activated');
  const registration = Object.assign(new EventTarget(), {
    active,
    installing: null as ReturnType<typeof worker> | null,
    waiting: null as ReturnType<typeof worker> | null,
    update: vi.fn().mockResolvedValue(undefined),
  });
  const workers = Object.assign(new EventTarget(), {
    controller: active, getRegistration: vi.fn().mockResolvedValue(registration),
  });
  const reload = vi.fn();
  vi.stubGlobal('navigator', { serviceWorker: workers, onLine: true });
  vi.stubGlobal('document', Object.assign(new EventTarget(), { baseURI: 'https://example.com/', hidden: false }));
  vi.stubGlobal('location', { reload });
  vi.stubGlobal('window', Object.assign(new EventTarget(), { location }));

  const status = { hidden: true, textContent: '' } as HTMLElement;
  const button = Object.assign(new EventTarget(), { hidden: true }) as HTMLButtonElement;
  return { registration, workers, reload, status, button, start: () => registerOffline(status, button) };
}

afterEach(() => vi.unstubAllGlobals());

it('offers a completed update to a running app and applies it on request', async () => {
  const { registration, workers, reload, status, button, start } = installedApp();
  await start();
  const next = worker('installing');
  registration.installing = next;
  registration.dispatchEvent(new Event('updatefound'));
  expect(button.hidden).toBe(true);

  registration.installing = null;
  registration.waiting = next;
  next.state = 'installed';
  next.dispatchEvent(new Event('statechange'));
  expect(status.textContent).toBe('Update available');
  expect(button.hidden).toBe(false);
  expect(next.postMessage).not.toHaveBeenCalled();
  expect(reload).not.toHaveBeenCalled();

  button.dispatchEvent(new Event('click'));
  expect(next.postMessage).toHaveBeenCalledWith({ type: 'apply-update' });
  registration.waiting = null;
  registration.active = next;
  workers.controller = next;
  next.state = 'activated';
  workers.dispatchEvent(new Event('controllerchange'));
  expect(reload).toHaveBeenCalledTimes(1);
});

it('offers an update already waiting on launch without reloading when another window applies it', async () => {
  const { registration, workers, reload, status, button, start } = installedApp();
  const next = worker('installed');
  registration.waiting = next;
  await start();
  expect(status.textContent).toBe('Update available');
  expect(button.hidden).toBe(false);

  registration.waiting = null;
  registration.active = next;
  workers.controller = next;
  next.state = 'activated';
  workers.dispatchEvent(new Event('controllerchange'));
  expect(reload).not.toHaveBeenCalled();
});

it('keeps the installed release available when an update check fails', async () => {
  const { registration, status, button, reload, start } = installedApp();
  registration.update.mockRejectedValue(new TypeError('Failed to fetch'));
  await start();
  registration.update.mockClear();
  window.dispatchEvent(new Event('online'));
  await vi.waitFor(() => expect(registration.update).toHaveBeenCalled());
  expect(status.textContent).toBe('Ready for offline use');
  expect(button.hidden).toBe(true);
  expect(reload).not.toHaveBeenCalled();
});
