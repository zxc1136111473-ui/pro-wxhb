import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

// i18n 在导入时读 localStorage，测试环境没有，垫一个最小的；脚本最后用 FileReader 把结果图转成 dataURL，也垫一个
const memory = new Map<string, string>();
Object.assign(globalThis, {
    localStorage: { getItem: (key: string) => memory.get(key) ?? null, setItem: (key: string, value: string) => void memory.set(key, String(value)), removeItem: (key: string) => void memory.delete(key) },
    FileReader: class {
        result = "";
        onload = () => {};
        readAsDataURL() {
            this.result = "data:,";
            queueMicrotask(() => this.onload());
        }
    },
});
const { imageGraph } = await import("../src/services/api/comfyui");

type Graph = Record<string, { class_type: string; inputs: Record<string, unknown> }>;
const script = readFileSync(new URL("../../docs/scripts/comfyui-model.js", import.meta.url), "utf8");
const PIXEL = "data:image/png;base64,AAAA";
const REFERENCE_PREFIX = "参考图片编号：图片1。请按这些编号理解提示词中的图片引用。\n\n";

/** 在桩环境里跑画布脚本，截获它提交给 ComfyUI 的工作流 */
async function scriptGraph(model: string, prompt: string, images: string[], params: Record<string, unknown> = {}) {
    let graph: Graph | undefined;
    let uploads = 0;
    const request = async (config: { url: string; data?: { prompt: Graph } }) => {
        if (config.url.endsWith("/upload/image")) return { name: `up${uploads++}.png` };
        if (config.url.endsWith("/prompt")) {
            graph = config.data!.prompt;
            return { prompt_id: "p" };
        }
        if (config.url.includes("/history/")) return { p: { status: { completed: true }, outputs: { "90": { images: [{ filename: "o.png" }] } } } };
        return new Blob(["x"]);
    };
    const poll = async (load: () => Promise<unknown>, done: (value: unknown) => unknown) => done(await load());
    const run = new Function("prompt", "images", "params", "model", "baseUrl", "apiKey", "request", "poll", `"use strict"; return (async () => {\n${script}\n})();`);
    await run(prompt, images, params, model, "http://comfy.test", "user:pass", request, poll);
    return graph!;
}

// 随机种子每次不同，不参与比对
const withoutSeed = (graph: Graph) => JSON.parse(JSON.stringify(graph, (key, value) => (key === "seed" ? undefined : value)));

test("高清出图：1K", async () => {
    const page = imageGraph("hd", { prompt: "一杯咖啡", ratio: "3:4", level: "1K" });
    expect(withoutSeed(await scriptGraph("comfy-高清出图", "一杯咖啡", [], { size: "1024x1365" }))).toEqual(withoutSeed(page));
});

test("高清出图：最长边超过 1500 用 2K", async () => {
    const page = imageGraph("hd", { prompt: "一杯咖啡", ratio: "3:4", level: "2K" });
    expect(withoutSeed(await scriptGraph("comfy-高清出图", "一杯咖啡", [], { size: "1536x2048" }))).toEqual(withoutSeed(page));
});

test("商品改图", async () => {
    const page = imageGraph("edit", { prompt: "背景换成纯白色", ratio: "1:1", level: "2K" }, "up0.png");
    expect(withoutSeed(await scriptGraph("comfy-商品改图", "背景换成纯白色", [PIXEL]))).toEqual(withoutSeed(page));
});

test("促销标签", async () => {
    const page = imageGraph("label", { prompt: "限时三天|满199减50", ratio: "1:1", level: "2K" }, "up0.png");
    expect(withoutSeed(await scriptGraph("comfy-促销标签", "限时三天|满199减50", [PIXEL]))).toEqual(withoutSeed(page));
});

test("画布在有参考图时加的「参考图片编号」说明：标签只取最后一段，高清出图去掉这段", async () => {
    const label = imageGraph("label", { prompt: "限时三天|满199减50", ratio: "1:1", level: "2K" }, "up0.png");
    expect(withoutSeed(await scriptGraph("comfy-促销标签", REFERENCE_PREFIX + "限时三天|满199减50", [PIXEL]))).toEqual(withoutSeed(label));
    const hd = imageGraph("hd", { prompt: "一杯咖啡", ratio: "3:4", level: "1K" });
    expect(withoutSeed(await scriptGraph("comfy-高清出图", REFERENCE_PREFIX + "一杯咖啡", [PIXEL], { size: "1024x1365" }))).toEqual(withoutSeed(hd));
});
