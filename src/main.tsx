import {StrictMode} from 'react';
import {createRoot} from 'react-dom/client';
import AppV2 from './v2/AppV2';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <AppV2 />
  </StrictMode>,
);
