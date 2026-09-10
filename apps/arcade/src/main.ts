// Entry point. The shell does everything; this hands it the page and wires the dev bridge.

import './style.css'
import { registerBridgeContext, startDevBridge } from 'virtual:dev-bridge'
import { Shell } from './Shell'

startDevBridge()

const shell = new Shell(document.getElementById('app')!)

// Dev operator shell handles. Empty function in production builds.
registerBridgeContext(shell.bridge)
