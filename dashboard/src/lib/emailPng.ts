/**
 * Any image the browser can draw, as a PNG small enough for mail: at most
 * 600 by 240, which is twice the largest size a template shows it at. SVG
 * included, which is what most brands have and no mail client displays.
 */
export async function toEmailPng(file: File): Promise<Blob> {
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    // An SVG without width and height reports zero; give it a usable size.
    const w = img.naturalWidth || 600;
    const h = img.naturalHeight || 240;
    // A vector has no native size worth keeping, so it is drawn as large as allowed.
    const fit = Math.min(600 / w, 240 / h);
    const scale = file.type === "image/svg+xml" ? fit : Math.min(1, fit);
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(w * scale));
    canvas.height = Math.max(1, Math.round(h * scale));
    canvas.getContext("2d")!.drawImage(img, 0, 0, canvas.width, canvas.height);
    return await new Promise((resolve, reject) =>
      canvas.toBlob(
        (b) => (b ? resolve(b) : reject(new Error("Could not convert the image."))),
        "image/png",
      ),
    );
  } catch {
    throw new Error("That file could not be read as an image.");
  } finally {
    URL.revokeObjectURL(url);
  }
}
