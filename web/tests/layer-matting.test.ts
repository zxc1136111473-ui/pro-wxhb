import { expect, test } from "bun:test";

import { matteFromPair } from "../src/lib/canvas/layer-matting";

/** 一个像素：黑底版、白底版（都是不透明的 RGB）→ 算出的 RGBA */
const matte = (dark: number[], light: number[]) => Array.from(matteFromPair([...dark, 255], [...light, 255]));

test("背景像素（黑底版是黑、白底版是白）完全透明", () => {
    expect(matte([0, 0, 0], [255, 255, 255])).toEqual([0, 0, 0, 0]);
});

test("实心商品像素（两版一样）保留原色、完全不透明", () => {
    expect(matte([200, 30, 30], [200, 30, 30])).toEqual([200, 30, 30, 255]);
});

test("半透明像素（玻璃、投影）还原出原色和一半左右的透明度", () => {
    // 原色 (100,200,50)、透明度 0.5：黑版 = a·F，白版 = a·F + (1-a)·255
    const [r, g, b, a] = matte([50, 100, 25], [178, 228, 153]);
    expect([r, g, b].map((value, index) => Math.abs(value - [100, 200, 50][index])).every((gap) => gap <= 2)).toBe(true);
    expect(Math.abs(a - 127.5)).toBeLessThanOrEqual(1);
});

test("透明度低于 3% 当全透明、高于 97% 当不透明，压掉渲染噪点", () => {
    expect(matte([0, 0, 0], [250, 250, 250])).toEqual([0, 0, 0, 0]);
    expect(matte([100, 100, 100], [105, 105, 105])).toEqual([100, 100, 100, 255]);
});

test("白底版比黑底版还暗（两张图没对齐的噪点）按不透明处理", () => {
    expect(matte([100, 100, 100], [90, 90, 90])).toEqual([100, 100, 100, 255]);
});

test("按像素独立计算，输出长度和输入一致", () => {
    const out = matteFromPair([0, 0, 0, 255, 200, 30, 30, 255], [255, 255, 255, 255, 200, 30, 30, 255]);
    expect(Array.from(out)).toEqual([0, 0, 0, 0, 200, 30, 30, 255]);
});
