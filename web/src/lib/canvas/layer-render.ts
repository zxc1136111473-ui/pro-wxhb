import { nanoid } from "nanoid";

import i18n from "@/i18n";
import type { CanvasImageLayer, CanvasLabelLayer, CanvasLabelStyleId, CanvasLayer, CanvasLayerDoc, CanvasShapeKind, CanvasShapeLayer, CanvasTextLayer } from "@/types/canvas";

type Point = { x: number; y: number };
export type LayerImageGetter = (storageKey: string) => CanvasImageSource | undefined;

/** 标签配色，和工作流 24 的 pro-image 节点一致。 */
export const LABEL_STYLES: Record<CanvasLabelStyleId, { bg: string | null; fg: string; stroke: string | null }> = {
    redWhite: { bg: "#de202c", fg: "#ffffff", stroke: null },
    yellowBlack: { bg: "#ffcf00", fg: "#181818", stroke: null },
    blackGold: { bg: "#161616", fg: "#ffd060", stroke: null },
    blueWhite: { bg: "#185cdc", fg: "#ffffff", stroke: null },
    greenWhite: { bg: "#149848", fg: "#ffffff", stroke: null },
    whiteRed: { bg: "#ffffff", fg: "#de202c", stroke: null },
    outline: { bg: null, fg: "#ffffff", stroke: "#000000" },
};
export const LABEL_STYLE_IDS = Object.keys(LABEL_STYLES) as CanvasLabelStyleId[];
export const SHAPE_KINDS: CanvasShapeKind[] = ["roundRect", "pill", "rect", "circle"];

export const FONT_STACKS = {
    sans: '"PingFang SC","Microsoft YaHei","Noto Sans CJK SC","Helvetica Neue",Arial,sans-serif',
    serif: '"Songti SC","SimSun","Noto Serif CJK SC",Georgia,serif',
    mono: '"SF Mono",Menlo,Consolas,"Noto Sans Mono CJK SC",monospace',
};

const LINE_HEIGHT = 1.25;
let measureContext: CanvasRenderingContext2D | null = null;
const measure = () => (measureContext ||= document.createElement("canvas").getContext("2d")!);

function textFont(layer: CanvasTextLayer | CanvasLabelLayer) {
    const bold = layer.type === "label" || layer.bold;
    return `${bold ? 700 : 400} ${layer.fontSize}px ${FONT_STACKS[layer.type === "text" ? layer.fontFamily : "sans"]}`;
}

function textLines(text: string) {
    return text.split("\n");
}

/** 图层在自身坐标系里的原始尺寸（未乘 scale）。文字和标签按内容量出来。 */
export function layerSize(layer: CanvasLayer): { width: number; height: number } {
    if (layer.type === "image" || layer.type === "shape") return { width: layer.width, height: layer.height };
    const ctx = measure();
    ctx.font = textFont(layer);
    const lines = textLines(layer.text);
    const textWidth = Math.max(1, ...lines.map((line) => ctx.measureText(line).width));
    if (layer.type === "text") return { width: textWidth + layer.strokeWidth, height: lines.length * layer.fontSize * LINE_HEIGHT + layer.strokeWidth };
    const hollow = !LABEL_STYLES[layer.style].bg;
    const width = textWidth + layer.fontSize * (hollow ? 0.3 : 1);
    const height = lines.length * layer.fontSize * LINE_HEIGHT + layer.fontSize * (hollow ? 0.3 : 0.64);
    return layer.shape === "circle" ? { width: Math.max(width, height) * 1.05, height: Math.max(width, height) * 1.05 } : { width, height };
}

function shapePath(ctx: CanvasRenderingContext2D, shape: CanvasShapeKind, w: number, h: number, radius: number) {
    ctx.beginPath();
    if (shape === "circle") ctx.ellipse(0, 0, w / 2, h / 2, 0, 0, Math.PI * 2);
    else {
        const r = shape === "rect" ? 0 : shape === "pill" ? Math.min(w, h) / 2 : Math.min(radius, w / 2, h / 2);
        ctx.moveTo(-w / 2 + r, -h / 2);
        ctx.arcTo(w / 2, -h / 2, w / 2, h / 2, r);
        ctx.arcTo(w / 2, h / 2, -w / 2, h / 2, r);
        ctx.arcTo(-w / 2, h / 2, -w / 2, -h / 2, r);
        ctx.arcTo(-w / 2, -h / 2, w / 2, -h / 2, r);
        ctx.closePath();
    }
}

function drawLines(ctx: CanvasRenderingContext2D, lines: string[], fontSize: number, anchorX: number, top: number, fill: string, stroke: string | null, strokeWidth: number) {
    ctx.textBaseline = "middle";
    lines.forEach((line, index) => {
        const y = top + (index + 0.5) * fontSize * LINE_HEIGHT;
        if (stroke && strokeWidth > 0) {
            ctx.lineJoin = "round";
            ctx.lineWidth = strokeWidth;
            ctx.strokeStyle = stroke;
            ctx.strokeText(line, anchorX, y);
        }
        ctx.fillStyle = fill;
        ctx.fillText(line, anchorX, y);
    });
}

export function drawLayer(ctx: CanvasRenderingContext2D, layer: CanvasLayer, getImage: LayerImageGetter) {
    if (!layer.visible) return;
    const { width: w, height: h } = layerSize(layer);
    ctx.save();
    ctx.globalAlpha = layer.opacity;
    ctx.translate(layer.x, layer.y);
    ctx.rotate((layer.rotation * Math.PI) / 180);
    ctx.scale(layer.scale, layer.scale);
    if (layer.type === "image") {
        const image = getImage(layer.storageKey);
        if (image) ctx.drawImage(image, -w / 2, -h / 2, w, h);
    } else if (layer.type === "shape") {
        shapePath(ctx, layer.shape, w, h, Math.min(w, h) * 0.15);
        ctx.fillStyle = layer.fill;
        ctx.fill();
        if (layer.strokeWidth > 0) {
            ctx.lineWidth = layer.strokeWidth;
            ctx.strokeStyle = layer.strokeColor;
            ctx.stroke();
        }
    } else if (layer.type === "text") {
        ctx.font = textFont(layer);
        ctx.textAlign = layer.align;
        const anchor = layer.align === "left" ? -w / 2 + layer.strokeWidth / 2 : layer.align === "right" ? w / 2 - layer.strokeWidth / 2 : 0;
        drawLines(ctx, textLines(layer.text), layer.fontSize, anchor, -h / 2 + layer.strokeWidth / 2, layer.color, layer.strokeColor, layer.strokeWidth);
    } else {
        const style = LABEL_STYLES[layer.style];
        if (style.bg) {
            shapePath(ctx, layer.shape, w, h, layer.fontSize * 0.35);
            ctx.fillStyle = style.bg;
            ctx.fill();
        }
        ctx.font = textFont(layer);
        ctx.textAlign = "center";
        const lines = textLines(layer.text);
        drawLines(ctx, lines, layer.fontSize, 0, -(lines.length * layer.fontSize * LINE_HEIGHT) / 2, style.fg, style.stroke, style.stroke ? Math.max(2, layer.fontSize / 6) : 0);
    }
    ctx.restore();
}

/** 把整份图层合成到画布上；scale 是预览缩放（导出用 1）。 */
export function renderDoc(ctx: CanvasRenderingContext2D, doc: CanvasLayerDoc, base: CanvasImageSource | undefined, getImage: LayerImageGetter, scale = 1) {
    ctx.save();
    ctx.setTransform(scale, 0, 0, scale, 0, 0);
    ctx.clearRect(0, 0, doc.width, doc.height);
    if (doc.baseVisible && base) ctx.drawImage(base, 0, 0, doc.width, doc.height);
    doc.layers.forEach((layer) => drawLayer(ctx, layer, getImage));
    ctx.restore();
}

export function toLayerLocal(layer: CanvasLayer, point: Point): Point {
    const angle = (-layer.rotation * Math.PI) / 180;
    const dx = point.x - layer.x;
    const dy = point.y - layer.y;
    return { x: (dx * Math.cos(angle) - dy * Math.sin(angle)) / layer.scale, y: (dx * Math.sin(angle) + dy * Math.cos(angle)) / layer.scale };
}

export function hitLayer(layer: CanvasLayer, point: Point) {
    const { width, height } = layerSize(layer);
    const local = toLayerLocal(layer, point);
    return Math.abs(local.x) <= width / 2 && Math.abs(local.y) <= height / 2;
}

const layerName = (key: string) => i18n.t(`canvas.layers.names.${key}`);
const baseLayer = () => ({ id: nanoid(), visible: true, locked: false, rotation: 0, scale: 1, opacity: 1 });

export function createTextLayer(doc: CanvasLayerDoc): CanvasTextLayer {
    return { ...baseLayer(), type: "text", name: layerName("text"), x: doc.width / 2, y: doc.height / 2, text: i18n.t("canvas.layers.defaultText"), fontFamily: "sans", fontSize: Math.round(doc.width * 0.07), bold: true, color: "#ffffff", strokeColor: "#000000", strokeWidth: Math.round(doc.width * 0.006), align: "center" };
}

export function createLabelLayer(doc: CanvasLayerDoc): CanvasLabelLayer {
    return { ...baseLayer(), type: "label", name: layerName("label"), x: doc.width * 0.22, y: doc.height * 0.1, text: i18n.t("canvas.layers.defaultLabel"), shape: "roundRect", style: "redWhite", fontSize: Math.round(doc.width * 0.05) };
}

export function createShapeLayer(doc: CanvasLayerDoc): CanvasShapeLayer {
    const size = Math.round(doc.width * 0.3);
    return { ...baseLayer(), type: "shape", name: layerName("shape"), x: doc.width / 2, y: doc.height / 2, shape: "roundRect", width: size, height: Math.round(size * 0.6), fill: "#ffd060", strokeColor: "#000000", strokeWidth: 0 };
}

export function createImageLayer(doc: CanvasLayerDoc, image: { storageKey: string; width: number; height: number; name?: string; cutout?: boolean }, fit?: "cover"): CanvasImageLayer {
    const scale = fit === "cover" ? Math.max(doc.width / image.width, doc.height / image.height) : Math.min(1, (doc.width * 0.4) / image.width);
    return { ...baseLayer(), type: "image", name: image.name || layerName(image.cutout ? "cutout" : "image"), x: doc.width / 2, y: doc.height / 2, scale, storageKey: image.storageKey, width: image.width, height: image.height, cutout: image.cutout };
}

export function cloneLayer(layer: CanvasLayer, doc: CanvasLayerDoc): CanvasLayer {
    const offset = doc.width * 0.02;
    return { ...layer, id: nanoid(), name: `${layer.name} ${i18n.t("canvas.layers.copySuffix")}`, x: layer.x + offset, y: layer.y + offset, locked: false };
}
