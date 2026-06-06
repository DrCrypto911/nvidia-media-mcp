#!/usr/bin/env node
/**
 * Local smoke test for nvidia-media-mcp using stdio MCP requests.
 * Spawns server.mjs, sends MCP requests via stdin, reads responses from stdout.
 *
 * Usage: NVIDIA_API_KEY=$NVIDIA_API_KEY node test-local.mjs
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVER = path.join(__dirname, 'server.mjs');

if (!process.env.NVIDIA_API_KEY) {
  console.error('FATAL: NVIDIA_API_KEY not set in environment');
  process.exit(1);
}

const child = spawn('node', [SERVER], {
  stdio: ['pipe', 'pipe', 'pipe'],
  env: { ...process.env },
});

child.stderr.on('data', (d) => process.stderr.write(`[mcp-stderr] ${d}`));

let buffer = '';
const pending = new Map();
let nextId = 1;

child.stdout.on('data', (chunk) => {
  buffer += chunk.toString();
  let idx;
  while ((idx = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, idx).trim();
    buffer = buffer.slice(idx + 1);
    if (!line) continue;
    try {
      const msg = JSON.parse(line);
      if (msg.id != null && pending.has(msg.id)) {
        pending.get(msg.id)(msg);
        pending.delete(msg.id);
      }
    } catch (e) {
      console.error('[parse] could not parse:', line);
    }
  }
});

function send(method, params) {
  return new Promise((resolve) => {
    const id = nextId++;
    pending.set(id, resolve);
    const msg = JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n';
    child.stdin.write(msg);
  });
}

async function main() {
  // Initialize
  const init = await send('initialize', {
    protocolVersion: '2025-03-26',
    capabilities: {},
    clientInfo: { name: 'test-local', version: '0.1.0' },
  });
  console.log('=== initialize response ===');
  console.log(JSON.stringify(init, null, 2).slice(0, 500));

  // List tools
  const tools = await send('tools/list', {});
  console.log('\n=== tools/list ===');
  console.log(JSON.stringify(tools.result?.tools?.map((t) => t.name), null, 2));

  // Test OCR with the tmp test image
  console.log('\n=== nvidia_ocr_extract: /tmp/ocr_test.png ===');
  const ocrResult = await send('tools/call', {
    name: 'nvidia_ocr_extract',
    arguments: { image_path: '/tmp/ocr_test.png' },
  });
  console.log(JSON.stringify(ocrResult, null, 2).slice(0, 1500));

  // Test Flux with a tiny prompt
  console.log('\n=== nvidia_flux_generate: small render ===');
  const fluxResult = await send('tools/call', {
    name: 'nvidia_flux_generate',
    arguments: {
      prompt: 'a tiny red apple on white background',
      width: 512,
      height: 512,
    },
  });
  console.log(JSON.stringify(fluxResult, null, 2).slice(0, 800));

  // Test video describe (requires /tmp/video_test.mp4 — generate via ffmpeg)
  console.log('\n=== nvidia_video_describe: /tmp/video_test.mp4 ===');
  const videoResult = await send('tools/call', {
    name: 'nvidia_video_describe',
    arguments: {
      video_path: '/tmp/video_test.mp4',
      prompt: 'Describe what is shown in this video in one sentence.',
    },
  });
  console.log(JSON.stringify(videoResult, null, 2).slice(0, 1200));

  child.kill();
  process.exit(0);
}

main().catch((e) => {
  console.error('test failed:', e);
  child.kill();
  process.exit(1);
});
