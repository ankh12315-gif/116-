/**
 * React 挂载入口
 */

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './app/App';
import './styles/global.css';

const container = document.getElementById('root');
if (!container) {
  throw new Error('挂载点 #root 未找到（检查 index.html）');
}

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);