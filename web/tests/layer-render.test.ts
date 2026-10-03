import { expect, test } from "bun:test";

import type { CanvasLayerDoc, CanvasShapeLayer } from "../src/types/canvas";

// i18n 在导入时读 localStorage，测试环境没有，垫一个最小的
const memory = new Map<string, string>();
Object.assign(globalThis, {
    localStorage: { getItem: (key: string) => memory.get(key) ?? null, setItem: (key: string, value: string) => void memory.set(key, String(value)), removeItem: (key: string) => void memory.delete(key) },
});
const { cloneLayer, createImageLayer, createShapeLayer, hitLayer, layerSize, toLayerLocal } = await import("../src/lib/canvas/layer-render");

const doc: CanvasLayerDoc = { width: 1000, height: 800, base: { storageKey: "image:base" }, baseVisible: true, flatKey: "", layers: [] };
/** 中心在 (500, 400)、200×100 的形状图层 */
const shape = (patch: Partial<CanvasShapeLayer> = {}): CanvasShapeLayer => ({ ...createShapeLayer(doc), x: 500, y: 400, width: 200, height: 100, rotation: 0, scale: 1, ...patch });

test("未旋转的图层：命中区域就是它的矩形", () => {
    const layer = shape();
    expect(hitLayer(layer, { x: 590, y: 400 })).toBe(true);
    expect(hitLayer(layer, { x: 500, y: 445 })).toBe(true);
    expect(hitLayer(layer, { x: 610, y: 400 })).toBe(false);
    expect(hitLayer(layer, { x: 500, y: 460 })).toBe(false);
});

test("旋转 90° 后命中区域的长宽对调", () => {
    const layer = shape({ rotation: 90 });
    expect(hitLayer(layer, { x: 500, y: 460 })).toBe(true);
    expect(hitLayer(layer, { x: 590, y: 400 })).toBe(false);
});

test("缩放会放大命中区域", () => {
    expect(hitLayer(shape({ scale: 1 }), { x: 690, y: 400 })).toBe(false);
    expect(hitLayer(shape({ scale: 2 }), { x: 690, y: 400 })).toBe(true);
});

test("toLayerLocal 把画布坐标换到图层自己的坐标系（含旋转和缩放）", () => {
    const local = toLayerLocal(shape({ rotation: 90, scale: 2 }), { x: 500, y: 440 });
    expect(local.x).toBeCloseTo(20);
    expect(local.y).toBeCloseTo(0);
});

test("layerSize：形状和图片直接用自己的宽高", () => {
    expect(layerSize(shape())).toEqual({ width: 200, height: 100 });
    expect(layerSize(createImageLayer(doc, { storageKey: "image:s", width: 300, height: 150 }))).toEqual({ width: 300, height: 150 });
});

test("createImageLayer：默认最宽占画布 40% 且不放大，cover 铺满画布，都居中", () => {
    const wide = createImageLayer(doc, { storageKey: "image:a", width: 1000, height: 500 });
    expect(wide.scale).toBeCloseTo(0.4);
    expect([wide.x, wide.y]).toEqual([500, 400]);
    expect(createImageLayer(doc, { storageKey: "image:b", width: 100, height: 100 }).scale).toBe(1);
    expect(createImageLayer(doc, { storageKey: "image:c", width: 500, height: 500 }, "cover").scale).toBe(2);
});

test("cloneLayer：新 id、向右下错开画布宽的 2%、不继承锁定", () => {
    const original = shape({ locked: true });
    const copy = cloneLayer(original, doc);
    expect(copy.id).not.toBe(original.id);
    expect([copy.x, copy.y]).toEqual([original.x + 20, original.y + 20]);
    expect(copy.locked).toBe(false);
    expect(copy.name).toContain(original.name);
});
