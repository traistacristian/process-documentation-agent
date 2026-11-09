import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.jsx';
import HumanCheckGate from './components/HumanCheck.jsx';
import { loadConfig } from './api.js';
import './styles.css';

loadConfig().then(() => createRoot(document.getElementById('root')).render(<HumanCheckGate><App /></HumanCheckGate>))
  .catch((e) => { document.getElementById('root').textContent = `The application could not start: ${e.message}`; });
