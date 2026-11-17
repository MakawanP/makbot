"use client";

// Shrinks images in the browser before upload so requests stay small and fast.
// full  -> sent to Gemini for the current message (max 1600px, JPEG)
// thumb -> saved in chat history and re-sent for context later (max 384px)

const FULL_MAX = 1600;
const THUMB_MAX = 384;
export const MAX_IMAGES = 4;

function loadImage(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve(img);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error(`Couldn't read ${file.name || "that image"}.`));
    };
    img.src = url;
  });
}

function toJpegDataUrl(img, maxSide, quality) {
  const scale = Math.min(1, maxSide / Math.max(img.width, img.height));
  const w = Math.max(1, Math.round(img.width * scale));
  const h = Math.max(1, Math.round(img.height * scale));
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#fff"; // flatten transparent PNGs onto white
  ctx.fillRect(0, 0, w, h);
  ctx.drawImage(img, 0, 0, w, h);
  return canvas.toDataURL("image/jpeg", quality);
}

export function dataUrlToPart(dataUrl) {
  const [head, data] = dataUrl.split(",");
  const mimeType = head.match(/data:(.*?);/)?.[1] || "image/jpeg";
  return { mimeType, data };
}

export async function prepareImage(file) {
  if (!file.type.startsWith("image/")) throw new Error("Only image files are supported.");
  const img = await loadImage(file);
  return {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    full: toJpegDataUrl(img, FULL_MAX, 0.85),
    thumb: toJpegDataUrl(img, THUMB_MAX, 0.7),
  };
}
