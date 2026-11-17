import './style.css';
import { App } from './app/App';

const root = document.querySelector<HTMLElement>('#app');
if (!root) throw new Error('Application root is missing.');
const app = new App(root);
void app.start();
if (import.meta.hot) import.meta.hot.dispose(() => app.destroy());
