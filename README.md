# nvidia-media-mcp

A small Model Context Protocol (MCP) server that exposes NVIDIA NIM media endpoints as local agent tools.

The goal is simple: let an AI agent call specialized NVIDIA services for image generation, OCR, and short video understanding through the same MCP interface it uses for the rest of its tool stack.

## What it provides

| Tool | Purpose | Input | Output |
|---|---|---|---|
| `nvidia_flux_generate` | Text-to-image generation through NVIDIA NIM Flux | prompt, width, height, optional output path | local image file path + metadata |
| `nvidia_ocr_extract` | OCR through NVIDIA Nemotron OCR | local image path | extracted text, confidence, bounding boxes |
| `nvidia_video_describe` | Short video understanding through NVIDIA omni-modal models | local video path + question | natural-language description/answer |

## Why this exists

Most agent runtimes are good at text and shell work, but media operations usually become one-off scripts. This repo packages NVIDIA NIM media capabilities as reusable MCP tools so an agent can:

- generate quick creative assets,
- read screenshots and document images,
- inspect short videos,
- save outputs locally for downstream rendering or review,
- keep credentials out of prompts and source control.

## Safety and privacy posture

- No API keys are committed.
- Secrets are read from environment variables or a local `.env` file ignored by git.
- Outputs are written to a local directory by default.
- The server does not post to social media, send messages, or perform public write actions.
- Example config uses placeholders only.

## Requirements

- Node.js 18+
- NVIDIA NIM API key
- MCP-compatible client/runtime

## Install

```bash
git clone https://github.com/DrCrypto911/nvidia-media-mcp.git
cd nvidia-media-mcp
npm install
cp .env.example .env
```

Edit `.env` locally:

```bash
NVIDIA_API_KEY=***
NVIDIA_MEDIA_MCP_OUTPUT_DIR=./outputs
```

`.env` is ignored by git. Do not commit real keys.

## Run

```bash
NVIDIA_API_KEY=*** node server.mjs
```

Or, with a local `.env` file in the repo root:

```bash
node server.mjs
```

## MCP client config example

Use the absolute path to `server.mjs` in your MCP client:

```json
{
  "mcpServers": {
    "nvidia-media": {
      "command": "node",
      "args": ["/absolute/path/to/nvidia-media-mcp/server.mjs"],
      "env": {
        "NVIDIA_API_KEY": "${NVIDIA_API_KEY}"
      }
    }
  }
}
```

If your client does not pass environment variables, keep a local `.env` beside `server.mjs`.

## Tool details

### `nvidia_flux_generate`

Text-to-image via Flux 2 Klein 4B on NVIDIA NIM.

```json
{
  "prompt": "a clean product render of an AI media control room",
  "width": 1024,
  "height": 1024,
  "output_path": "/tmp/flux_render.jpg"
}
```

Returns file path, size, image dimensions, format, and elapsed time.

### `nvidia_ocr_extract`

OCR via Nemotron OCR v1 on NVIDIA NIM.

```json
{
  "image_path": "/absolute/path/to/screenshot.png"
}
```

Returns aggregated text plus per-detection confidence and bounding boxes.

### `nvidia_video_describe`

Short video understanding via NVIDIA omni-modal models.

```json
{
  "video_path": "/absolute/path/to/clip.mp4",
  "question": "What happens in this clip?"
}
```

For best latency and reliability, trim large videos before sending them to the model.

## Local checks

```bash
npm run check
```

This validates that `server.mjs` parses cleanly. Live endpoint tests require a real NVIDIA NIM API key and may incur API usage.

## API notes

### Flux 2 Klein 4B

```text
POST https://ai.api.nvidia.com/v1/genai/black-forest-labs/flux.2-klein-4b
Body: {"prompt": "...", "width": N, "height": N}
Response: {"artifacts": [{"base64": "<JPEG bytes>"}]}
```

### Nemotron OCR v1

```text
POST https://ai.api.nvidia.com/v1/cv/nvidia/nemotron-ocr-v1
Body: {"input": [{"type": "image_url", "url": "data:image/X;base64,..."}]}
```

Important shape detail: `input` is an array, and `url` sits at the top level of each item.

## Roadmap

- Add audio transcription / ASR wrappers.
- Add safer media-size preflight and automatic downscaling.
- Add structured JSON output mode for OCR/video analysis.
- Add fixture-based tests that do not require live API calls.

## License

MIT
