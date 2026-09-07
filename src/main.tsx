import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { startDevBridge } from 'virtual:dev-bridge'
import './index.css'
import App from './App.tsx'

// Dev operator shell. This resolves to an empty no-op unless the dev server
// was started with APEX_BRIDGE set (`just bridge-dev`), and never exists in a
// production build at all. See dev/bridge-plugin.ts.
startDevBridge()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
