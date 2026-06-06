#!/usr/bin/env node
/**
 * nvidia-media-mcp — MCP server wrapping NVIDIA NIM media endpoints.
 *
 * Tools:
 *   - nvidia_flux_generate: text-to-image via Flux 2 Klein 4B
 *   - nvidia_ocr_extract: OCR via Nemotron OCR v1
 *
 * Auth: NVIDIA_API_KEY resolution order:
 *   1. process.env.NVIDIA_API_KEY (preferred — passed by parent)
 *   2. local .env beside server.mjs (for simple local/dev runs)
 *   3. ~/.config/nvidia-media-mcp/.env (for user-level config)
 */
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

function loadEnvFile(envPath, key) {
  try {
    if (!fs.existsSync(envPath)) return null;
    for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
      const trimmed = line.trim();
      if (trimmed.startsWith(`${key}=`)) {
        return trimmed.split('=', 2)[1].replace(/^["']|["']$/g, '');
      }
    }
  } catch {
    return null;
  }
  return null;
}

let NVIDIA_API_KEY = process.env.NVIDIA_API_KEY;
if (!NVIDIA_API_KEY) {
  const candidateEnvPaths = [
    path.join(process.cwd(), '.env'),
    path.join(path.dirname(new URL(import.meta.url).pathname), '.env'),
    path.join(os.homedir(), '.config', 'nvidia-media-mcp', '.env'),
  ];
  for (const envPath of candidateEnvPaths) {
    NVIDIA_API_KEY = loadEnvFile(envPath, 'NVIDIA_API_KEY');
    if (NVIDIA_API_KEY) {
      console.error(`[nvidia-media-mcp] NVIDIA_API_KEY loaded from ${envPath} (process.env was empty)`);
      break;
    }
  }
}
if (!NVIDIA_API_KEY) {
  console.error('[nvidia-media-mcp] FATAL: NVIDIA_API_KEY not found. Set process.env.NVIDIA_API_KEY or create a local .env file.');
  process.exit(1);
}

const FLUX_URL = 'https://ai.api.nvidia.com/v1/genai/black-forest-labs/flux.2-klein-4b';
const OCR_URL = 'https://ai.api.nvidia.com/v1/cv/nvidia/nemotron-ocr-v1';
const CHAT_URL = 'https://integrate.api.nvidia.com/v1/chat/completions';
const DEFAULT_VIDEO_MODEL = 'nvidia/nemotron-3-nano-omni-30b-a3b-reasoning';
const VIDEO_SIZE_CAP_MB = 50;

const DEFAULT_OUTPUT_DIR = process.env.NVIDIA_MEDIA_MCP_OUTPUT_DIR || path.join(os.homedir(), '.cache', 'nvidia-media-mcp', 'output');
fs.mkdirSync(DEFAULT_OUTPUT_DIR, { recursive: true });

const TOOLS = [
  {
    name: 'nvidia_flux_generate',
    description:
      'Generate an image from a text prompt via NVIDIA NIM Flux 2 Klein 4B (black-forest-labs). ' +
      'Saves the image to disk and returns the file path. Default output dir: ~/.cache/nvidia-media-mcp/output/. ' +
      'Use this for production-quality text-to-image renders when ComfyUI workflows are not needed.',
    inputSchema: {
      type: 'object',
      properties: {
        prompt: {
          type: 'string',
          description: 'Text description of the image to generate.',
        },
        width: {
          type: 'integer',
          default: 1024,
          minimum: 64,
          maximum: 2048,
          description: 'Image width in pixels (default 1024).',
        },
        height: {
          type: 'integer',
          default: 1024,
          minimum: 64,
          maximum: 2048,
          description: 'Image height in pixels (default 1024).',
        },
        output_path: {
          type: 'string',
          description:
            'Optional absolute path to save the image. If omitted, saved as ~/.cache/nvidia-media-mcp/output/flux_<timestamp>.jpg.',
        },
      },
      required: ['prompt'],
    },
  },
  {
    name: 'nvidia_ocr_extract',
    description:
      'Extract text from an image via NVIDIA NIM Nemotron OCR v1. ' +
      'Accepts a local image file path. Returns aggregated text plus per-detection confidence + bounding boxes. ' +
      'Use this for screenshot-to-text, document scanning, sign reading, etc.',
    inputSchema: {
      type: 'object',
      properties: {
        image_path: {
          type: 'string',
          description: 'Absolute path to a local image file (PNG/JPEG/etc). Required.',
        },
      },
      required: ['image_path'],
    },
  },
  {
    name: 'nvidia_video_describe',
    description:
      'Describe video content via NVIDIA NIM omni-modal models. ' +
      `Default model: ${DEFAULT_VIDEO_MODEL} (Nemotron 3 Nano Omni 30B, reasoning + omni-modal). ` +
      'Pass a local video file path (MP4/MOV/WebM/M4V/MKV); the file is base64-encoded and sent inline. ' +
      `Soft cap: ${VIDEO_SIZE_CAP_MB} MB per video — trim or downscale longer clips. ` +
      'Use this for short-clip understanding (sign-reading in video, scene description, action summary, etc.).',
    inputSchema: {
      type: 'object',
      properties: {
        video_path: {
          type: 'string',
          description: 'Absolute path to a local video file. Required.',
        },
        prompt: {
          type: 'string',
          default: 'Describe this video in detail, including any visible text, actions, and notable elements.',
          description: 'Custom describing prompt. Default asks for a detailed description.',
        },
        model: {
          type: 'string',
          default: DEFAULT_VIDEO_MODEL,
          description: `NIM model ID. Default: ${DEFAULT_VIDEO_MODEL}. Alternative: nvidia/cosmos-reason2-8b for video-reasoning-specialized output.`,
        },
      },
      required: ['video_path'],
    },
  },
];

const server = new Server(
  { name: 'nvidia-media', version: '0.1.0' },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const name = req.params.name;
  const args = req.params.arguments || {};
  try {
    if (name === 'nvidia_flux_generate') return await handleFlux(args);
    if (name === 'nvidia_ocr_extract') return await handleOcr(args);
    if (name === 'nvidia_video_describe') return await handleVideoDescribe(args);
    return errResult(`Unknown tool: ${name}`);
  } catch (e) {
    return errResult(`Unexpected error: ${e.message}`);
  }
});

function errResult(msg) {
  return { isError: true, content: [{ type: 'text', text: msg }] };
}

async function handleFlux({ prompt, width = 1024, height = 1024, output_path }) {
  if (!prompt || typeof prompt !== 'string') return errResult('prompt is required (string).');

  const t0 = Date.now();
  const response = await fetch(FLUX_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${NVIDIA_API_KEY}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify({ prompt, width, height }),
  });

  if (!response.ok) {
    const text = await response.text();
    return errResult(`Flux NIM error HTTP ${response.status}: ${text.slice(0, 500)}`);
  }
  const data = await response.json();
  const b64 = data?.artifacts?.[0]?.base64;
  if (!b64) {
    return errResult(
      `Flux returned no artifact. Raw response: ${JSON.stringify(data).slice(0, 500)}`
    );
  }

  const buffer = Buffer.from(b64, 'base64');
  // Detect format from magic bytes (NIM returns JPEG by default)
  const isJpeg = buffer[0] === 0xff && buffer[1] === 0xd8;
  const isPng = buffer[0] === 0x89 && buffer[1] === 0x50;
  const ext = isJpeg ? 'jpg' : isPng ? 'png' : 'bin';

  const outPath =
    output_path ||
    path.join(DEFAULT_OUTPUT_DIR, `flux_${Date.now()}.${ext}`);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, buffer);
  const elapsed = ((Date.now() - t0) / 1000).toFixed(2);

  return {
    content: [
      {
        type: 'text',
        text:
          `Image generated successfully.\n` +
          `  path: ${outPath}\n` +
          `  size: ${buffer.length.toLocaleString()} bytes\n` +
          `  dims: ${width}x${height}\n` +
          `  format: ${ext}\n` +
          `  elapsed: ${elapsed}s\n` +
          `  prompt: ${prompt.slice(0, 200)}${prompt.length > 200 ? '...' : ''}`,
      },
    ],
  };
}

async function handleOcr({ image_path }) {
  if (!image_path || typeof image_path !== 'string') return errResult('image_path is required (string).');
  if (!fs.existsSync(image_path)) return errResult(`Image not found: ${image_path}`);

  const ext = path.extname(image_path).toLowerCase().replace('.', '') || 'png';
  const mime =
    ext === 'jpg' || ext === 'jpeg'
      ? 'image/jpeg'
      : ext === 'png'
        ? 'image/png'
        : ext === 'webp'
          ? 'image/webp'
          : ext === 'gif'
            ? 'image/gif'
            : 'application/octet-stream';

  const b64 = fs.readFileSync(image_path).toString('base64');
  const t0 = Date.now();
  const response = await fetch(OCR_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${NVIDIA_API_KEY}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify({
      input: [{ type: 'image_url', url: `data:${mime};base64,${b64}` }],
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    return errResult(`OCR NIM error HTTP ${response.status}: ${text.slice(0, 500)}`);
  }

  const data = await response.json();
  const detections = data?.data?.[0]?.text_detections || [];
  const elapsed = ((Date.now() - t0) / 1000).toFixed(2);

  if (detections.length === 0) {
    return {
      content: [{ type: 'text', text: `No text detected in ${image_path} (elapsed ${elapsed}s).` }],
    };
  }

  const texts = detections.map((d) => d?.text_prediction?.text).filter(Boolean);
  const aggregated = texts.join('\n');

  const detail = detections.map((d, i) => ({
    index: i,
    text: d?.text_prediction?.text || null,
    confidence: d?.text_prediction?.confidence ?? null,
    bounding_box: d?.bounding_box || null,
  }));

  return {
    content: [
      {
        type: 'text',
        text:
          `OCR extracted ${detections.length} text region(s) from ${path.basename(image_path)}.\n` +
          `Elapsed: ${elapsed}s\n\n` +
          `--- aggregated text ---\n${aggregated}\n\n` +
          `--- per-detection detail ---\n${JSON.stringify(detail, null, 2)}`,
      },
    ],
  };
}

async function handleVideoDescribe({
  video_path,
  prompt = 'Describe this video in detail, including any visible text, actions, and notable elements.',
  model = DEFAULT_VIDEO_MODEL,
}) {
  if (!video_path || typeof video_path !== 'string') {
    return errResult('video_path is required (string).');
  }
  if (!fs.existsSync(video_path)) return errResult(`Video not found: ${video_path}`);

  const stat = fs.statSync(video_path);
  const sizeMB = stat.size / (1024 * 1024);
  if (sizeMB > VIDEO_SIZE_CAP_MB) {
    return errResult(
      `Video ${sizeMB.toFixed(1)} MB exceeds soft cap of ${VIDEO_SIZE_CAP_MB} MB. ` +
        `Trim or downscale via ffmpeg first: \`ffmpeg -i ${video_path} -t 30 -vf scale=640:-1 -c:v libx264 trimmed.mp4\``
    );
  }

  const ext = path.extname(video_path).toLowerCase().replace('.', '') || 'mp4';
  const mime =
    {
      mp4: 'video/mp4',
      m4v: 'video/mp4',
      mov: 'video/quicktime',
      webm: 'video/webm',
      mkv: 'video/x-matroska',
      avi: 'video/x-msvideo',
    }[ext] || 'video/mp4';

  const b64 = fs.readFileSync(video_path).toString('base64');
  const t0 = Date.now();

  const response = await fetch(CHAT_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${NVIDIA_API_KEY}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify({
      model,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: prompt },
            { type: 'video_url', video_url: { url: `data:${mime};base64,${b64}` } },
          ],
        },
      ],
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    return errResult(`Video describe NIM error HTTP ${response.status}: ${text.slice(0, 500)}`);
  }

  const data = await response.json();
  const text = data?.choices?.[0]?.message?.content;
  const usage = data?.usage || {};
  const elapsed = ((Date.now() - t0) / 1000).toFixed(2);

  if (!text) {
    return errResult(`No content in response. Raw: ${JSON.stringify(data).slice(0, 500)}`);
  }

  return {
    content: [
      {
        type: 'text',
        text:
          `Video described (${path.basename(video_path)}, ${sizeMB.toFixed(2)} MB, ${mime}).\n` +
          `Model: ${model}\n` +
          `Elapsed: ${elapsed}s\n` +
          `Tokens: prompt=${usage.prompt_tokens ?? '?'} completion=${usage.completion_tokens ?? '?'}\n\n` +
          `--- description ---\n${text}`,
      },
    ],
  };
}

const transport = new StdioServerTransport();
await server.connect(transport);
console.error('[nvidia-media-mcp] Server started on stdio');
