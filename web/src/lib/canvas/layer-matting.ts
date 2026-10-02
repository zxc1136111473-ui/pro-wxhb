/**
 * 双底差分抠图：同一商品在纯黑、纯白背景上各重绘一张，
 *   白版 = a·F + (1-a)·255，黑版 = a·F  →  a = 1 - (白-黑)/255，F = 黑 / a
 * 半透明（玻璃、投影）也能得到真实的透明度。两张图要对得准，所以依赖改图模型「商品原样不动」。
 */
async function readPixels(blob: Blob, width: number, height: number) {
    const bitmap = await createImageBitmap(blob);
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
    ctx.drawImage(bitmap, 0, 0, width, height);
    bitmap.close();
    return ctx.getImageData(0, 0, width, height);
}

export async function diffMatte(black: Blob, white: Blob) {
    const size = await createImageBitmap(black);
    const { width, height } = size;
    size.close();
    const [dark, light] = await Promise.all([readPixels(black, width, height), readPixels(white, width, height)]);
    const out = new ImageData(width, height);
    for (let i = 0; i < out.data.length; i += 4) {
        const diff = (light.data[i] - dark.data[i] + (light.data[i + 1] - dark.data[i + 1]) + (light.data[i + 2] - dark.data[i + 2])) / 3;
        let alpha = 1 - diff / 255;
        alpha = alpha < 0.03 ? 0 : alpha > 0.97 ? 1 : alpha;
        if (alpha === 0) continue;
        out.data[i] = Math.min(255, dark.data[i] / alpha);
        out.data[i + 1] = Math.min(255, dark.data[i + 1] / alpha);
        out.data[i + 2] = Math.min(255, dark.data[i + 2] / alpha);
        out.data[i + 3] = Math.round(alpha * 255);
    }
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    canvas.getContext("2d")!.putImageData(out, 0, 0);
    return new Promise<Blob>((resolve, reject) => canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error("toBlob failed"))), "image/png"));
}
