/**
 * Read an image file chosen via <input type="file"> into a data URL, downscaled
 * so large phone photos (used for QR codes and profile pictures) don't blow up
 * browser-local storage or the database rows. The image is re-encoded as JPEG
 * for photos or kept as PNG when transparency matters — QR codes scan best from
 * a clean square image, so we center them on a white background.
 */

const MAX_DIMENSION = 720
const JPEG_QUALITY = 0.88

export function isImageFile(file: File | null | undefined): boolean {
  return !!file && file.type.startsWith('image/')
}

export function fileToImage(file: File): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file)
    const img = new Image()
    img.onload = () => {
      URL.revokeObjectURL(url)
      resolve(img)
    }
    img.onerror = () => {
      URL.revokeObjectURL(url)
      reject(new Error('The file could not be read as an image.'))
    }
    img.src = url
  })
}

/**
 * Resolve an image File to a compact data URL. Images larger than
 * MAX_DIMENSION are scaled down; smaller images are kept as-is. Returns a PNG
 * data URL when the source has transparency (or is a GIF/PNG that shouldn't be
 * re-encoded lossily), otherwise a JPEG on a white background.
 */
export async function imageFileToDataUrl(file: File, maxDimension = MAX_DIMENSION): Promise<string> {
  const img = await fileToImage(file)
  const { width, height } = img
  const scale = Math.min(1, maxDimension / Math.max(width, height))
  if (scale >= 1) {
    // Small enough already — just read it as a data URL untouched.
    return await new Promise<string>((resolve, reject) => {
      const reader = new FileReader()
      reader.onload = () => resolve(String(reader.result))
      reader.onerror = () => reject(new Error('Could not read the file.'))
      reader.readAsDataURL(file)
    })
  }

  const w = Math.max(1, Math.round(width * scale))
  const h = Math.max(1, Math.round(height * scale))
  const canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = h
  const ctx = canvas.getContext('2d')
  if (!ctx) {
    // No canvas (old browser) — fall back to the raw data URL.
    return await new Promise<string>((resolve, reject) => {
      const reader = new FileReader()
      reader.onload = () => resolve(String(reader.result))
      reader.onerror = () => reject(new Error('Could not read the file.'))
      reader.readAsDataURL(file)
    })
  }
  // White backdrop: QR codes need a light background to scan reliably, and JPEG
  // has no alpha channel.
  ctx.fillStyle = '#ffffff'
  ctx.fillRect(0, 0, w, h)
  ctx.drawImage(img, 0, 0, w, h)
  return canvas.toDataURL('image/jpeg', JPEG_QUALITY)
}
