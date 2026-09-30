import axios, { type AxiosRequestConfig } from "axios";

import i18n from "@/i18n";
import { useConfigStore, withLocalProxy } from "@/stores/use-config-store";

type Graph = Record<string, { class_type: string; inputs: Record<string, unknown> }>;
type OutputFile = { filename: string; subfolder?: string; type?: string };
export type ComfyOutputs = Record<string, { images?: OutputFile[]; audio?: OutputFile[]; text?: string[] }>;
type RunOptions = { signal?: AbortSignal; timeoutMs?: number };

const DEFAULT_TIMEOUT_MS = 600000;
const POLL_MS = 2500;
/** 阿里百炼 Settings 节点：服务器 relay_config.json 里按节点 id 31 取 Key，所以图里必须叫 31。 */
export const ALI_SETTINGS: Graph[string] = {
    class_type: "RelayAPISettings",
    inputs: { task_type: "text", platform: "OpenaiText", api_format: "v1/chat/completions", api_base: "https://www.runninghub.cn", model: "claude-opus-4-6", apikey: "", custom_api_base: "https://dashscope.aliyuncs.com", custom_model: "qwen3.8-flash" },
};

const text = (key: string, options?: Record<string, unknown>) => i18n.t(`comfyui.${key}`, options);

/** ComfyUI 渠道：第一个带 comfy- 前缀模型的渠道；baseUrl 是地址，apiKey 填「账号:密码」（Caddy basic_auth）。 */
function comfyChannel() {
    const channel = useConfigStore.getState().config.channels.find((item) => item.models.some((model) => model.name.startsWith("comfy-")));
    if (!channel) throw new Error(text("noChannel"));
    return channel;
}

export const hasComfyChannel = (channels: { models: { name: string }[] }[]) => channels.some((item) => item.models.some((model) => model.name.startsWith("comfy-")));

function client() {
    const channel = comfyChannel();
    const base = channel.baseUrl.replace(/\/+$/, "").replace(/\/v1$/, "");
    const headers = { Authorization: "Basic " + btoa(unescape(encodeURIComponent(channel.apiKey))) };
    return (config: AxiosRequestConfig & { url: string }) => axios.request({ ...config, url: withLocalProxy(base + config.url), headers }).then((response) => response.data);
}

export async function uploadToComfy(file: Blob, name: string, signal?: AbortSignal) {
    const form = new FormData();
    form.append("image", file, name);
    return (await client()({ method: "post", url: "/upload/image", data: form, signal })).name as string;
}

/** 提交工作流并轮询到结束，返回各节点输出；出错时抛出 ComfyUI 的报错。 */
export async function runComfyGraph(graph: Graph, options: RunOptions = {}): Promise<ComfyOutputs> {
    const request = client();
    const { prompt_id: id } = await request({ method: "post", url: "/prompt", data: { prompt: graph }, signal: options.signal });
    const deadline = Date.now() + (options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    for (;;) {
        const entry = (await request({ url: `/history/${id}`, signal: options.signal }))[id];
        if (entry?.status?.completed || entry?.status?.status_str === "error") {
            if (entry.status.status_str === "error") {
                const last = entry.status.messages?.slice(-1)[0]?.[1];
                throw new Error(last?.exception_message || text("runFailed"));
            }
            return entry.outputs || {};
        }
        if (Date.now() > deadline) throw new Error(text("timeout"));
        await new Promise((resolve) => setTimeout(resolve, POLL_MS));
    }
}

export async function fetchComfyFile(file: OutputFile, signal?: AbortSignal) {
    const params = new URLSearchParams({ filename: file.filename, subfolder: file.subfolder || "", type: file.type || "output" });
    return (await client()({ url: `/view?${params}`, responseType: "blob", signal })) as Blob;
}

const aliGraph = (nodes: Graph): Graph => ({ "31": ALI_SETTINGS, ...nodes });
const saveAudio = (source: string, prefix: string, slot = 0) => ({ class_type: "SaveAudioAdvanced", inputs: { filename_prefix: prefix, format: "mp3", "format.quality": "V0", audio: [source, slot] } });

export type CustomVoice = { voice: string; language?: string; gmt_create?: string; target_model: string; voice_prompt?: string; preview_text?: string };
export type VoiceList = { design: CustomVoice[]; clone: CustomVoice[] };

export async function listVoices(signal?: AbortSignal): Promise<VoiceList> {
    const out = await runComfyGraph(aliGraph({ "2": { class_type: "ProAliVoiceAdmin", inputs: { action: "列出", voice: "", info: ["31", 0] } } }), { signal });
    return JSON.parse(out["2"].text?.[0] || "{}");
}

export async function deleteVoice(voice: string, signal?: AbortSignal) {
    await runComfyGraph(aliGraph({ "2": { class_type: "ProAliVoiceAdmin", inputs: { action: "删除", voice, info: ["31", 0] } } }), { signal });
}

/** 用某个自定义音色合成一句话，返回 mp3；ProAliTTS 会按音色 id 前缀自动选 vd / vc 模型。 */
export async function previewVoice(voice: string, sample: string, signal?: AbortSignal) {
    const out = await runComfyGraph(
        aliGraph({
            "2": { class_type: "ProAliTTS", inputs: { text: sample, voice: "Cherry", model: "qwen3-tts-flash", language: "Chinese", instructions: "", speed: 1, volume_db: 0, custom_voice: voice, info: ["31", 0] } },
            "3": saveAudio("2", "voices/preview"),
        }),
        { signal },
    );
    return fetchComfyFile(out["3"].audio![0], signal);
}

export async function designVoice(input: { prompt: string; previewText: string; name: string; language: string }, signal?: AbortSignal) {
    const out = await runComfyGraph(
        aliGraph({
            "2": { class_type: "ProAliVoiceDesign", inputs: { voice_prompt: input.prompt, preview_text: input.previewText, name: input.name, language: input.language, info: ["31", 0] } },
            "3": saveAudio("2", "voices/design", 1),
            "4": { class_type: "PreviewAny", inputs: { source: ["2", 0] } },
        }),
        { signal },
    );
    return { voice: out["4"].text?.[0] || "", preview: await fetchComfyFile(out["3"].audio![0], signal) };
}

export async function cloneVoice(sample: File, name: string, signal?: AbortSignal) {
    const file = await uploadToComfy(sample, `voice_${Date.now()}_${sample.name}`, signal);
    const out = await runComfyGraph(
        aliGraph({
            "5": { class_type: "LoadAudio", inputs: { audio: file } },
            "2": { class_type: "ProAliVoiceClone", inputs: { audio: ["5", 0], name, info: ["31", 0] } },
            "4": { class_type: "PreviewAny", inputs: { source: ["2", 0] } },
        }),
        { signal },
    );
    return out["4"].text?.[0] || "";
}

export type ImageTemplate = "hd" | "edit" | "label";
export type ImageJob = { prompt: string; image?: File; ratio: string; level: string };

const LABEL_LAYOUT = [
    { position: "左上", style: "红底白字", size: 5 },
    { position: "右下", style: "黄底黑字", size: 6 },
    { position: "左下", style: "黑底金字", size: 4.5 },
];

function imageGraph(template: ImageTemplate, job: ImageJob, file?: string): Graph {
    const seed = Math.floor(Math.random() * 2 ** 31);
    const save = (source: string, prefix: string) => ({ "90": { class_type: "SaveImage", inputs: { filename_prefix: prefix, images: [source, 0] } }, "91": { class_type: "PreviewAny", inputs: { source: [source, 1] } } });
    if (template === "hd") {
        return aliGraph({ "2": { class_type: "ProAliImage", inputs: { prompt: job.prompt, model: "qwen-image-2.0-pro", ratio: job.ratio, level: job.level, seed, info: ["31", 0] } }, ...save("2", "canvas/hd") });
    }
    if (!file) throw new Error(text("needImage"));
    if (template === "edit") {
        return aliGraph({ "10": { class_type: "LoadImage", inputs: { image: file } }, "2": { class_type: "ProAliImageEdit", inputs: { prompt: job.prompt, model: "qwen-image-edit-max", seed, image1: ["10", 0], info: ["31", 0] } }, ...save("2", "canvas/edit") });
    }
    const labels = job.prompt.split("|").map((item) => item.trim());
    const inputs: Record<string, unknown> = { shape: "圆角矩形", margin_pct: 3, image: ["10", 0] };
    LABEL_LAYOUT.forEach((item, index) => Object.assign(inputs, { [`text${index + 1}`]: labels[index] || "", [`position${index + 1}`]: item.position, [`style${index + 1}`]: item.style, [`size${index + 1}_pct`]: item.size }));
    return { "10": { class_type: "LoadImage", inputs: { image: file } }, "3": { class_type: "ProLabels", inputs }, "90": { class_type: "SaveImage", inputs: { filename_prefix: "canvas/label", images: ["3", 0] } } };
}

/** 跑一个图片任务（高清出图 / 商品改图 / 促销标签），返回结果图；出错时抛出阿里或 ComfyUI 的原因。 */
export async function runImageTemplate(template: ImageTemplate, job: ImageJob, signal?: AbortSignal) {
    const file = job.image ? await uploadToComfy(job.image, `batch_${Date.now()}_${job.image.name}`, signal) : undefined;
    const out = await runComfyGraph(imageGraph(template, job, file), { signal });
    const image = out["90"]?.images?.[0];
    if (!image) throw new Error(out["91"]?.text?.join("\n") || text("runFailed"));
    return fetchComfyFile(image, signal);
}
