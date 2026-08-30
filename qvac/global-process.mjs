// Shim for the global `process` used by the QVAC SDK.
//
// Bare doesn't define `process` as a global and the SDK expects it. Lives in
// its own module for an EVALUATION ORDER reason: in ESM, imports get
// evaluated before the body of the module that declares them, so putting the
// assignment in engine.mjs's body would run late —the SDK would have already
// evaluated its references to the global and fails with unhelpful errors—.
// By importing this first, the shim is already in place by the time the SDK
// gets evaluated.
//
// This is the trick that lets engine.mjs use STATIC imports from the SDK.
// That matters: bare-pack resolves the static graph to build the standalone
// binary, and that's where llamacpp's .bare prebuild comes in.

import bareProcess from 'bare-process'

if (!global.process) global.process = bareProcess

export default bareProcess
