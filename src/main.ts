import './style.css';
import { App } from './app/App';
import { registerOffline } from './app/offline';

const root = document.querySelector<HTMLElement>('#app');
if (!root) throw new Error('Application root is missing.');
const app = new App(root);
void app.start();
const offlineStatus = root.querySelector<HTMLElement>('#offline-status');
if (import.meta.env.PROD && offlineStatus) void registerOffline(offlineStatus);
if (import.meta.hot) import.meta.hot.dispose(() => app.destroy());
