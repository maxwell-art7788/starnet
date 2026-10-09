# Personal companion deployment

This directory is a static launch and setup companion for Maxwell's local station. It does not host the Starnet runtime, collect credentials, or claim runtime health. Its original text and CSS use no upstream logos, sprites, or station artwork.

Vercel project settings: root directory `companion`, framework Other, no install or build command, output directory `.`. Deploy from the fork's `feat/harness-backend` branch. Keep production deployments linked to this repository.

The full agent runtime remains local. Start `node sidecar/index.js` from the repository root, open `http://localhost:8787`, and configure your model provider in that local UI. Runtime storage needs writable space and persists independently of this website. A successful website deployment does not prove that a local model or agent run works.
