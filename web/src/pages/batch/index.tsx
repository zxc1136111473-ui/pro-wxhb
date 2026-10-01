import { Download, FolderPlus, ImagePlus, ListPlus, Play, Plus, Square, Trash2 } from "lucide-react";
import localforage from "localforage";
import { useEffect, useRef, useState } from "react";
import { App, Button, Empty, Image, Input, InputNumber, Modal, Popconfirm, Select, Table, Tag } from "antd";
import { saveAs } from "file-saver";
import { nanoid } from "nanoid";
import { useTranslation } from "react-i18next";

import { createZip } from "@/lib/zip";
import { defaultTtsOptions, getTtsChoices, hasComfyChannel, runImageTemplate, runTts, type ImageTemplate, type TtsChoices, type TtsOptions } from "@/services/api/comfyui";
import { uploadImage } from "@/services/image-storage";
import { useAssetStore } from "@/stores/use-asset-store";
import { useConfigStore } from "@/stores/use-config-store";

type Kind = ImageTemplate | "tts";
type Row = { id: string; prompt: string; image?: File; src?: string; status: "idle" | "running" | "done" | "error"; saved?: boolean; url?: string; blob?: Blob; error?: string };
type Options = TtsOptions & { ratio: string; level: string };
type Meta = { kind: Kind; options: Options; order: Record<Kind, string[]> };

const kinds: Kind[] = ["hd", "edit", "label", "tts"];
const ratios = ["1:1", "3:4", "4:3", "9:16", "16:9", "2:3", "3:2"];
const defaultOptions: Options = { ...defaultTtsOptions, ratio: "1:1", level: "2K" };
const store = localforage.createInstance({ name: "infinite-canvas", storeName: "batch_state" });
const newRow = (patch: Partial<Row> = {}): Row => ({ id: nanoid(), prompt: "", status: "idle", ...patch });
const withUrls = (row: Row): Row => ({ ...row, src: row.image && URL.createObjectURL(row.image), url: row.blob && URL.createObjectURL(row.blob) });
const revoke = (row: Row) => [row.url, row.src].forEach((url) => url && URL.revokeObjectURL(url));
const storeKey = (id: string) => `row:${id}`;

export default function BatchPage() {
    const { message } = App.useApp();
    const { t } = useTranslation();
    const addAsset = useAssetStore((state) => state.addAsset);
    const ready = useConfigStore((state) => hasComfyChannel(state.config.channels));
    const [kind, setKind] = useState<Kind>("label");
    const [options, setOptions] = useState<Options>(defaultOptions);
    const [tables, setTables] = useState(() => Object.fromEntries(kinds.map((item) => [item, [newRow()]])) as Record<Kind, Row[]>);
    const [loaded, setLoaded] = useState(false);
    const [running, setRunning] = useState(false);
    const [choices, setChoices] = useState<TtsChoices | null>(null);
    const [pasteText, setPasteText] = useState<string | null>(null);
    const abortRef = useRef<AbortController | null>(null);
    const filesRef = useRef<HTMLInputElement>(null);
    const saved = useRef(new Map<string, Row>());
    const tablesRef = useRef(tables);
    tablesRef.current = tables;
    const rows = tables[kind];
    const isTts = kind === "tts";
    const needImage = kind === "edit" || kind === "label";
    const instruct = options.model.includes("instruct");

    const setRows = (update: (items: Row[]) => Row[]) => setTables((prev) => ({ ...prev, [kind]: update(prev[kind]) }));
    const patch = (id: string, data: Partial<Row>) => setRows((items) => items.map((item) => (item.id === id ? { ...item, ...data } : item)));
    const setOption = (data: Partial<Options>) => setOptions((prev) => ({ ...prev, ...data }));

    useEffect(() => {
        (async () => {
            const meta = await store.getItem<Meta>("meta");
            if (!meta) return;
            const entries = await Promise.all(
                kinds.map(async (item) => {
                    const loadedRows = await Promise.all((meta.order[item] || []).map((id) => store.getItem<Row>(storeKey(id))));
                    const hydrated = loadedRows.filter((row): row is Row => !!row).map((row) => withUrls({ ...row, status: row.status === "running" ? "idle" : row.status }));
                    hydrated.forEach((row) => saved.current.set(row.id, row));
                    return [item, hydrated.length ? hydrated : [newRow()]] as const;
                }),
            );
            setKind(meta.kind);
            setOptions({ ...defaultOptions, ...meta.options });
            setTables(Object.fromEntries(entries) as Record<Kind, Row[]>);
        })()
            .catch(() => undefined)
            .finally(() => setLoaded(true));
        return () => Object.values(tablesRef.current).flat().forEach(revoke);
    }, []);

    // 只写变过的行（行对象每次修改都会换新），避免改一个字就把所有图片重写一遍
    useEffect(() => {
        if (!loaded) return;
        const timer = setTimeout(() => {
            const all = kinds.flatMap((item) => tables[item]);
            const ids = new Set(all.map((row) => row.id));
            const fail = () => undefined;
            all.forEach((row) => {
                if (saved.current.get(row.id) === row) return;
                saved.current.set(row.id, row);
                void store.setItem(storeKey(row.id), { ...row, src: undefined, url: undefined, status: row.status === "running" ? "idle" : row.status }).catch(fail);
            });
            saved.current.forEach((_, id) => {
                if (ids.has(id)) return;
                saved.current.delete(id);
                void store.removeItem(storeKey(id)).catch(fail);
            });
            void store.setItem("meta", { kind, options, order: Object.fromEntries(kinds.map((item) => [item, tables[item].map((row) => row.id)])) }).catch(fail);
        }, 400);
        return () => clearTimeout(timer);
    }, [loaded, kind, options, tables]);

    useEffect(() => {
        if (isTts && ready && !choices) getTtsChoices().then(setChoices).catch((error) => message.error(error instanceof Error ? error.message : String(error)));
    }, [isTts, ready, choices, message]);

    const addImages = (files: FileList | null) => {
        if (!files?.length) return;
        setRows((items) => [...items.filter((item) => item.prompt || item.image), ...Array.from(files).map((image) => newRow({ image, src: URL.createObjectURL(image) }))]);
    };

    const addLines = () => {
        const lines = (pasteText || "").split("\n").map((line) => line.trim()).filter(Boolean);
        if (lines.length) setRows((items) => [...items.filter((item) => item.prompt || item.image), ...lines.map((prompt) => newRow({ prompt }))]);
        setPasteText(null);
    };

    const clearTable = () => {
        rows.forEach(revoke);
        setRows(() => [newRow()]);
    };

    const start = async () => {
        const todo = rows.filter((row) => row.status !== "done" && (row.prompt.trim() || (!isTts && row.image)));
        if (!todo.length) return;
        const controller = new AbortController();
        abortRef.current = controller;
        setRunning(true);
        for (const row of todo) {
            if (controller.signal.aborted) break;
            if (row.url) URL.revokeObjectURL(row.url);
            patch(row.id, { status: "running", error: undefined, saved: false, url: undefined, blob: undefined });
            try {
                const blob = isTts ? await runTts({ ...options, text: row.prompt }, controller.signal) : await runImageTemplate(kind, { prompt: row.prompt, image: row.image, ratio: options.ratio, level: options.level }, controller.signal);
                patch(row.id, { status: "done", blob, url: URL.createObjectURL(blob) });
            } catch (error) {
                if (controller.signal.aborted) {
                    patch(row.id, { status: "idle" });
                    break;
                }
                patch(row.id, { status: "error", error: error instanceof Error ? error.message : String(error) });
            }
        }
        setRunning(false);
    };

    const addToAssets = async (targets: Row[]) => {
        const done = targets.filter((row) => row.blob && !row.saved);
        if (!done.length) return message.info(t("batch.nothingDone"));
        try {
            for (const row of done) {
                const image = await uploadImage(row.blob!);
                addAsset({ kind: "image", title: row.prompt.trim().slice(0, 30) || t(`batch.templates.${kind}`), coverUrl: image.url, tags: [], source: t("batch.title"), data: { dataUrl: image.url, storageKey: image.storageKey, width: image.width, height: image.height, bytes: image.bytes, mimeType: image.mimeType } });
                patch(row.id, { saved: true });
            }
            message.success(t("batch.addedToAssets", { count: done.length }));
        } catch (error) {
            message.error(error instanceof Error ? error.message : String(error));
        }
    };

    const downloadAll = async () => {
        const done = rows.map((row, index) => ({ row, index })).filter(({ row }) => row.blob);
        if (!done.length) return message.info(t("batch.nothingDone"));
        saveAs(await createZip(done.map(({ row, index }) => ({ name: `${String(index + 1).padStart(2, "0")}.${isTts ? "mp3" : "png"}`, data: row.blob! }))), "batch.zip");
    };

    return (
        <div className="flex h-full flex-col overflow-hidden bg-background text-stone-900 dark:text-stone-100">
            <main className="min-h-0 flex-1 overflow-y-auto px-6 py-8">
                <div className="mx-auto max-w-6xl">
                    <h1 className="text-3xl font-semibold tracking-tight text-stone-950 dark:text-stone-100">{t("batch.title")}</h1>
                    <p className="mt-2 text-sm text-stone-500 dark:text-stone-400">{t("batch.description")}</p>
                    {!ready ? (
                        <Empty className="mt-16" description={t("comfyui.noChannel")} />
                    ) : (
                        <>
                            <div className="mt-6 flex flex-wrap items-center gap-3">
                                <Select className="w-44" value={kind} disabled={running} onChange={setKind} options={kinds.map((value) => ({ value, label: t(`batch.templates.${value}`) }))} />
                                {kind === "hd" ? (
                                    <>
                                        <Select className="w-24" value={options.ratio} disabled={running} onChange={(ratio) => setOption({ ratio })} options={ratios.map((value) => ({ value, label: value }))} />
                                        <Select className="w-20" value={options.level} disabled={running} onChange={(level) => setOption({ level })} options={["1K", "2K"].map((value) => ({ value, label: value }))} />
                                    </>
                                ) : null}
                                <span className="text-xs text-stone-500 dark:text-stone-400">{t(`batch.hints.${kind}`)}</span>
                            </div>
                            {isTts ? (
                                <div className="mt-3 flex flex-wrap items-center gap-3">
                                    <Select className="w-40" showSearch placeholder={t("batch.voice")} value={options.voice} disabled={running || !!options.customVoice.trim()} loading={!choices} onChange={(voice) => setOption({ voice })} options={(choices?.voices || [options.voice]).map((value) => ({ value, label: value }))} />
                                    <Select className="w-56" value={options.model} disabled={running || !!options.customVoice.trim()} onChange={(model) => setOption({ model })} options={(choices?.models || [options.model]).map((value) => ({ value, label: value }))} />
                                    <Select className="w-32" value={options.language} disabled={running} onChange={(language) => setOption({ language })} options={(choices?.languages || [options.language]).map((value) => ({ value, label: value }))} />
                                    <label className="flex items-center gap-2 text-xs text-stone-500 dark:text-stone-400">{t("batch.speed")}<InputNumber className="w-24" min={0.5} max={2} step={0.05} value={options.speed} disabled={running} onChange={(speed) => setOption({ speed: speed ?? 1 })} /></label>
                                    <label className="flex items-center gap-2 text-xs text-stone-500 dark:text-stone-400">{t("batch.volume")}<InputNumber className="w-24" min={-20} max={12} step={0.5} value={options.volumeDb} disabled={running} onChange={(volumeDb) => setOption({ volumeDb: volumeDb ?? 0 })} /></label>
                                    <Input className="w-72" allowClear placeholder={t("batch.customVoice")} value={options.customVoice} disabled={running} onChange={(event) => setOption({ customVoice: event.target.value })} />
                                    {instruct && !options.customVoice.trim() ? <Input className="w-96" allowClear placeholder={t("batch.instructions")} value={options.instructions} disabled={running} onChange={(event) => setOption({ instructions: event.target.value })} /> : null}
                                </div>
                            ) : null}
                            <div className="mt-4 flex flex-wrap gap-3">
                                <input ref={filesRef} type="file" accept="image/*" multiple hidden onChange={(event) => { addImages(event.target.files); event.target.value = ""; }} />
                                {needImage ? (
                                    <Button icon={<ImagePlus className="size-4" />} disabled={running} onClick={() => filesRef.current?.click()}>
                                        {t("batch.addImages")}
                                    </Button>
                                ) : (
                                    <>
                                        <Button icon={<Plus className="size-4" />} disabled={running} onClick={() => setRows((items) => [...items, newRow()])}>
                                            {t("batch.addRow")}
                                        </Button>
                                        <Button icon={<ListPlus className="size-4" />} disabled={running} onClick={() => setPasteText("")}>
                                            {t("batch.pasteLines")}
                                        </Button>
                                    </>
                                )}
                                {running ? (
                                    <Button danger icon={<Square className="size-4" />} onClick={() => abortRef.current?.abort()}>
                                        {t("batch.stop")}
                                    </Button>
                                ) : (
                                    <Button type="primary" icon={<Play className="size-4" />} onClick={() => void start()}>
                                        {t("batch.run")}
                                    </Button>
                                )}
                                <Button icon={<Download className="size-4" />} onClick={() => void downloadAll()}>
                                    {t("batch.downloadAll")}
                                </Button>
                                {!isTts ? (
                                    <Button icon={<FolderPlus className="size-4" />} onClick={() => void addToAssets(rows)}>
                                        {t("batch.addAllToAssets")}
                                    </Button>
                                ) : null}
                                <Popconfirm title={t("batch.clearConfirm")} okText={t("batch.clear")} cancelText={t("common.cancel")} okButtonProps={{ danger: true }} disabled={running} onConfirm={clearTable}>
                                    <Button danger disabled={running} icon={<Trash2 className="size-4" />}>
                                        {t("batch.clear")}
                                    </Button>
                                </Popconfirm>
                            </div>
                            <Table<Row>
                                className="mt-4"
                                rowKey="id"
                                dataSource={rows}
                                pagination={false}
                                columns={[
                                    ...(needImage ? [{ title: t("batch.source"), width: 96, render: (_: unknown, row: Row) => (row.image ? <Image width={64} height={64} className="object-cover" src={row.src} /> : null) }] : []),
                                    { title: t(kind === "label" ? "batch.labels" : isTts ? "batch.text" : "batch.prompt"), render: (_: unknown, row: Row) => <Input.TextArea autoSize={{ minRows: 1, maxRows: 4 }} disabled={running} value={row.prompt} placeholder={t(`batch.placeholders.${kind}`)} onChange={(event) => patch(row.id, { prompt: event.target.value, ...(row.status === "done" ? { status: "idle" as const } : {}) })} /> },
                                    { title: t("batch.status"), width: 200, render: (_: unknown, row: Row) => (row.status === "error" ? <span className="text-xs text-red-500">{row.error}</span> : <Tag color={{ idle: "default", running: "processing", done: "success" }[row.status]}>{t(`batch.statuses.${row.status}`)}</Tag>) },
                                    { title: t("batch.result"), width: isTts ? 280 : 96, render: (_: unknown, row: Row) => (row.url ? isTts ? <audio controls className="h-8 w-64" src={row.url} /> : <Image width={64} height={64} className="object-cover" src={row.url} /> : null) },
                                    {
                                        title: "",
                                        width: 88,
                                        render: (_: unknown, row: Row) => (
                                            <>
                                                {!isTts ? <Button type="text" size="small" title={t("common.addToAssets")} disabled={!row.blob || row.saved} icon={<FolderPlus className="size-4" />} onClick={() => void addToAssets([row])} /> : null}
                                                <Button type="text" size="small" danger disabled={running} icon={<Trash2 className="size-4" />} onClick={() => { revoke(row); setRows((items) => items.filter((item) => item.id !== row.id)); }} />
                                            </>
                                        ),
                                    },
                                ]}
                            />
                        </>
                    )}
                </div>
            </main>

            <Modal open={pasteText !== null} title={t("batch.pasteLines")} okText={t("batch.addRows")} cancelText={t("common.cancel")} onCancel={() => setPasteText(null)} onOk={addLines}>
                <p className="mb-2 text-xs text-stone-500 dark:text-stone-400">{t("batch.pasteHint")}</p>
                <Input.TextArea rows={8} value={pasteText || ""} onChange={(event) => setPasteText(event.target.value)} />
            </Modal>
        </div>
    );
}
