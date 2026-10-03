import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Routes, Route, Link } from 'react-router-dom';
import './app.css';
import Portada from './paginas/Portada.jsx';
import Ring from './paginas/Ring.jsx';
import Mesa from './paginas/Mesa.jsx';

function NoExiste() {
  return (
    <main className="portada">
      <div className="wrap">
        <h1>Esa página no existe</h1>
        <p className="pie"><Link to="/">Ver todas las pistas</Link></p>
      </div>
    </main>
  );
}

createRoot(document.getElementById('raiz')).render(
  <StrictMode>
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<Portada />} />
        <Route path="/ring/:ringId" element={<Ring />} />
        <Route path="/mesa/:ringId" element={<Mesa />} />
        <Route path="*" element={<NoExiste />} />
      </Routes>
    </BrowserRouter>
  </StrictMode>
);

// Sólo en producción: en desarrollo el service worker cachearía los módulos de
// Vite y la recarga en caliente dejaría de verse.
if ('serviceWorker' in navigator && import.meta.env.PROD) {
  navigator.serviceWorker.register('/sw.js').catch(() => {});
}
