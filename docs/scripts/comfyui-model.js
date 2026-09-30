// 画布「图片」脚本模型：直连 ComfyUI，同一段脚本按模型名区分三个工作流。
// 用法：设置 → 渠道 → 新建渠道
//   baseUrl = ComfyUI 地址（如 https://cfy.wqyhr.com，不要带 /v1）
//   apiKey  = 账号:密码（ComfyUI 前面 Caddy basic_auth 的账号密码）
//   模型（能力选「图片」，都粘贴这段脚本）：
//     comfy-高清出图   文生图，阿里 qwen-image-2.0-pro，尺寸/比例取画布设置（最长边 >1500 用 2K，否则 1K）
//     comfy-商品改图   需连一张参考图，prompt 写怎么改（换背景、去水印、改字等），阿里 qwen-image-edit-max
//     comfy-促销标签   需连一张参考图，prompt 写标签文字，用 | 分隔，最多 3 个，如「限时三天|满199减50」
// 服务端要求：ComfyUI 已部署 pro-cui（阿里 Key 在服务器 Settings 节点 31），Caddy 已放行本站点 CORS。
const base = baseUrl.replace(/\/+$/, "").replace(/\/v1$/, "");
const headers = { Authorization: "Basic " + btoa(unescape(encodeURIComponent(apiKey))) };
const mode = /标签/.test(model) ? "label" : /改图/.test(model) ? "edit" : "hd";
const RATIOS = { "1:1": 1, "3:4": 3 / 4, "4:3": 4 / 3, "9:16": 9 / 16, "16:9": 16 / 9, "2:3": 2 / 3, "3:2": 3 / 2 };
const ALI = { inputs: { task_type: "text", platform: "OpenaiText", api_format: "v1/chat/completions", api_base: "https://www.runninghub.cn", model: "claude-opus-4-6", apikey: "", custom_api_base: "https://dashscope.aliyuncs.com", custom_model: "qwen3.8-flash" }, class_type: "RelayAPISettings" };

const toBlob = async (dataUrl) => (await fetch(dataUrl)).blob();
const toDataUrl = (blob) => new Promise((ok, no) => { const r = new FileReader(); r.onload = () => ok(r.result); r.onerror = no; r.readAsDataURL(blob); });

async function upload(dataUrl, i) {
    const form = new FormData();
    form.append("image", await toBlob(dataUrl), `canvas_${Date.now()}_${i}.png`);
    return (await request({ method: "post", url: `${base}/upload/image`, data: form, headers })).name;
}

function buildGraph(prompt, files) {
    const seed = Math.floor(Math.random() * 2 ** 31);
    if (mode === "hd") {
        const [w, h] = (params.size || "1024x1024").split("x").map(Number);
        const ratio = Object.keys(RATIOS).reduce((a, b) => (Math.abs(RATIOS[b] - w / h) < Math.abs(RATIOS[a] - w / h) ? b : a));
        return { 2: { class_type: "ProAliImage", inputs: { prompt, model: "qwen-image-2.0-pro", ratio, level: Math.max(w, h) > 1500 ? "2K" : "1K", seed, info: ["31", 0] } }, 31: ALI, 90: { class_type: "SaveImage", inputs: { filename_prefix: "canvas/hd", images: ["2", 0] } }, 91: { class_type: "PreviewAny", inputs: { source: ["2", 1] } } };
    }
    if (!files.length) throw new Error("需要连一张参考图");
    const load = files.map((f, i) => [`${10 + i}`, { class_type: "LoadImage", inputs: { image: f } }]);
    if (mode === "edit") {
        const images = Object.fromEntries(files.slice(0, 3).map((_, i) => [`image${i + 1}`, [`${10 + i}`, 0]]));
        return { ...Object.fromEntries(load), 2: { class_type: "ProAliImageEdit", inputs: { prompt, model: "qwen-image-edit-max", seed, info: ["31", 0], ...images } }, 31: ALI, 90: { class_type: "SaveImage", inputs: { filename_prefix: "canvas/edit", images: ["2", 0] } }, 91: { class_type: "PreviewAny", inputs: { source: ["2", 1] } } };
    }
    const labels = prompt.split("|").map((s) => s.trim());
    const pos = ["左上", "右下", "左下"], style = ["红底白字", "黄底黑字", "黑底金字"], size = [5, 6, 4.5];
    const lab = { shape: "圆角矩形", margin_pct: 3, image: ["10", 0] };
    [0, 1, 2].forEach((i) => Object.assign(lab, { [`text${i + 1}`]: labels[i] || "", [`position${i + 1}`]: pos[i], [`style${i + 1}`]: style[i], [`size${i + 1}_pct`]: size[i] }));
    return { 10: load[0][1], 3: { class_type: "ProLabels", inputs: lab }, 90: { class_type: "SaveImage", inputs: { filename_prefix: "canvas/label", images: ["3", 0] } } };
}

async function runOne(files) {
    const graph = buildGraph(prompt, files);
    const { prompt_id: id } = await request({ method: "post", url: `${base}/prompt`, data: { prompt: graph }, headers });
    const entry = await poll(
        () => request({ url: `${base}/history/${id}`, headers }),
        (h) => {
            const e = h[id];
            if (!e?.status?.completed && e?.status?.status_str !== "error") return null;
            return e;
        },
        { intervalMs: 2500, timeoutMs: 600000 },
    );
    const out = entry.outputs || {};
    const img = (out["90"]?.images || [])[0];
    if (!img) throw new Error(out["91"]?.text?.join("\n") || JSON.stringify(entry.status?.messages?.slice(-1)) || "ComfyUI 没有返回图片");
    const q = new URLSearchParams({ filename: img.filename, subfolder: img.subfolder || "", type: img.type || "output" });
    const blob = await request({ url: `${base}/view?${q}`, headers, responseType: "blob" });
    return toDataUrl(blob);
}

const files = [];
for (let i = 0; i < images.length; i++) files.push(await upload(images[i], i));
return Promise.all(Array.from({ length: params.count || 1 }, () => runOne(files)));
