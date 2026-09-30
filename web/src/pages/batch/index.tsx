import { Download, FolderPlus, ImagePlus, Play, Plus, Square, Trash2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { App, Button, Empty, Image, Input, Select, Table, Tag } from "antd";
import { saveAs } from "file-saver";
import { nanoid } from "nanoid";
import { useTranslation } from "react-i18next";

import { createZip } from "@/lib/zip";
import { hasComfyChannel, runImageTemplate, type ImageTemplate } from "@/services/api/comfyui";
import { uploadImage } from "@/services/image-storage";
import { useAssetStore } from "@/stores/use-asset-store";
import { useConfigStore } from "@/stores/use-config-store";

type Row = { id: string; prompt: string; image?: File; src?: string; status: "idle" | "running" | "done" | "error"; saved?: boolean; url?: string; blob?: Blob; error?: string };

const templates: ImageTemplate[] = ["hd", "edit", "label"];
const ratios = ["1:1", "3:4", "4:3", "9:16", "16:9", "2:3", "3:2"];
const newRow = (patch: Partial<Row> = {}): Row => ({ id: nanoid(), prompt: "", status: "idle", ...patch });

export default function BatchPage() {
    const { message } = App.useApp();
    const { t } = useTranslation();
    const addAsset = useAssetStore((state) => state.addAsset);
    const ready = useConfigStore((state) => hasComfyChannel(state.config.channels));
    const [template, setTemplate] = useState<ImageTemplate>("label");
    const [ratio, setRatio] = useState("1:1");
    const [level, setLevel] = useState("2K");
    const [rows, setRows] = useState<Row[]>([newRow()]);
    const [running, setRunning] = useState(false);
    const abortRef = useRef<AbortController | null>(null);
    const filesRef = useRef<HTMLInputElement>(null);
    const rowsRef = useRef(rows);
    rowsRef.current = rows;
    const needImage = template !== "hd";

    useEffect(() => () => rowsRef.current.forEach((row) => [row.url, row.src].forEach((url) => url && URL.revokeObjectURL(url))), []);

    const patch = (id: string, data: Partial<Row>) => setRows((items) => items.map((item) => (item.id === id ? { ...item, ...data } : item)));

    const addImages = (files: FileList | null) => {
        if (!files?.length) return;
        setRows((items) => [...items.filter((item) => item.prompt || item.image), ...Array.from(files).map((image) => newRow({ image, src: URL.createObjectURL(image) }))]);
    };

    const start = async () => {
        const todo = rowsRef.current.filter((row) => row.status !== "done" && (row.prompt.trim() || row.image));
        if (!todo.length) return;
        const controller = new AbortController();
        abortRef.current = controller;
        setRunning(true);
        for (const row of todo) {
            if (controller.signal.aborted) break;
            patch(row.id, { status: "running", error: undefined });
            try {
                const blob = await runImageTemplate(template, { prompt: row.prompt, image: row.image, ratio, level }, controller.signal);
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
                addAsset({ kind: "image", title: row.prompt.trim().slice(0, 30) || t(`batch.templates.${template}`), coverUrl: image.url, tags: [], source: t("batch.title"), data: { dataUrl: image.url, storageKey: image.storageKey, width: image.width, height: image.height, bytes: image.bytes, mimeType: image.mimeType } });
                patch(row.id, { saved: true });
            }
            message.success(t("batch.addedToAssets", { count: done.length }));
        } catch (error) {
            message.error(error instanceof Error ? error.message : String(error));
        }
    };

    const downloadAll = async () => {
        const done = rows.filter((row) => row.blob);
        if (!done.length) return message.info(t("batch.nothingDone"));
        saveAs(await createZip(done.map((row, index) => ({ name: `${String(index + 1).padStart(2, "0")}.png`, data: row.blob! }))), "batch.zip");
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
                                <Select className="w-44" value={template} disabled={running} onChange={setTemplate} options={templates.map((value) => ({ value, label: t(`batch.templates.${value}`) }))} />
                                {template === "hd" ? (
                                    <>
                                        <Select className="w-24" value={ratio} disabled={running} onChange={setRatio} options={ratios.map((value) => ({ value, label: value }))} />
                                        <Select className="w-20" value={level} disabled={running} onChange={setLevel} options={["1K", "2K"].map((value) => ({ value, label: value }))} />
                                    </>
                                ) : null}
                                <span className="text-xs text-stone-500 dark:text-stone-400">{t(`batch.hints.${template}`)}</span>
                            </div>
                            <div className="mt-4 flex flex-wrap gap-3">
                                <input ref={filesRef} type="file" accept="image/*" multiple hidden onChange={(event) => { addImages(event.target.files); event.target.value = ""; }} />
                                {needImage ? (
                                    <Button icon={<ImagePlus className="size-4" />} disabled={running} onClick={() => filesRef.current?.click()}>
                                        {t("batch.addImages")}
                                    </Button>
                                ) : (
                                    <Button icon={<Plus className="size-4" />} disabled={running} onClick={() => setRows((items) => [...items, newRow()])}>
                                        {t("batch.addRow")}
                                    </Button>
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
                                <Button icon={<FolderPlus className="size-4" />} onClick={() => void addToAssets(rows)}>
                                    {t("batch.addAllToAssets")}
                                </Button>
                            </div>
                            <Table<Row>
                                className="mt-4"
                                rowKey="id"
                                dataSource={rows}
                                pagination={false}
                                columns={[
                                    ...(needImage ? [{ title: t("batch.source"), width: 96, render: (_: unknown, row: Row) => (row.image ? <Image width={64} height={64} className="object-cover" src={row.src} /> : null) }] : []),
                                    { title: t(template === "label" ? "batch.labels" : "batch.prompt"), render: (_: unknown, row: Row) => <Input.TextArea autoSize={{ minRows: 1, maxRows: 4 }} disabled={running} value={row.prompt} placeholder={t(`batch.placeholders.${template}`)} onChange={(event) => patch(row.id, { prompt: event.target.value })} /> },
                                    { title: t("batch.status"), width: 200, render: (_: unknown, row: Row) => (row.status === "error" ? <span className="text-xs text-red-500">{row.error}</span> : <Tag color={{ idle: "default", running: "processing", done: "success" }[row.status]}>{t(`batch.statuses.${row.status}`)}</Tag>) },
                                    { title: t("batch.result"), width: 96, render: (_: unknown, row: Row) => (row.url ? <Image width={64} height={64} className="object-cover" src={row.url} /> : null) },
                                    { title: "", width: 88, render: (_: unknown, row: Row) => <><Button type="text" size="small" title={t("common.addToAssets")} disabled={!row.blob || row.saved} icon={<FolderPlus className="size-4" />} onClick={() => void addToAssets([row])} /><Button type="text" size="small" danger disabled={running} icon={<Trash2 className="size-4" />} onClick={() => setRows((items) => items.filter((item) => item.id !== row.id))} /></> },
                                ]}
                            />
                        </>
                    )}
                </div>
            </main>
        </div>
    );
}
