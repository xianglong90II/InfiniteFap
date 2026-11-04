import React from 'react';
import ReactDOM from 'react-dom/client';
import GameApp from './GameApp';
import './game.css';
import './layers-menu.css';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <GameApp />
  </React.StrictMode>,
);
