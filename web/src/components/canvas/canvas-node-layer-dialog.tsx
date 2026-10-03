import { useCallback, useEffect, useReducer, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { App, Button, Empty, Input, Modal, Spin, Tooltip } from "antd";
import { ArrowDown, ArrowUp, Check, Copy, Eye, EyeOff, ImagePlus, Lock, LockOpen, Redo2, Shapes, Sparkles, Tag, Trash2, Type, Undo2, Upload, X, ZoomIn, ZoomOut } from "lucide-react";
import { useTranslation } from "react-i18next";

import { AssetPickerModal, type InsertAssetPayload } from "@/components/canvas/asset-picker-modal";
import { LayerProperties } from "@/components/canvas/canvas-layer-properties";
import { useImageEditorViewport } from "@/components/canvas/use-image-editor-viewport";
import { cloneLayer, createImageLayer, createLabelLayer, createShapeLayer, createTextLayer, hitLayer, layerSize, renderDoc } from "@/lib/canvas/layer-render";
import { cutoutSubject, hasComfyChannel } from "@/services/api/comfyui";
import { getImageBlob, resolveImageUrl, uploadImage } from "@/services/image-storage";
import { useConfigStore } from "@/stores/use-config-store";
import type { CanvasLayer, CanvasLayerDoc } from "@/types/canvas";

export type LayerEditorResult = { blob: Blob; doc: Omit<CanvasLayerDoc, "flatKey"> };
type Snapshot = Pick<CanvasLayerDoc, "layers" | "baseVisible">;
type DragMode = "move" | "scale" | "rotate";
type Corner = { x: 0 | 1; y: 0 | 1 };

const corners: Corner[] = [
    { x: 0, y: 0 },
    { x: 1, y: 0 },
    { x: 1, y: 1 },
    { x: 0, y: 1 },
];
const PREVIEW_LONG_EDGE = 1600;
const HISTORY_LIMIT = 100;
const checkerboard = { backgroundImage: "conic-gradient(#d4d4d4 25%, #fff 0 50%, #d4d4d4 0 75%, #fff 0)", backgroundSize: "16px 16px" };

const loadImage = (url: string) =>
    new Promise<HTMLImageElement>((resolve, reject) => {
        const image = new Image();
        image.onload = () => resolve(image);
        image.onerror = () => reject(new Error("image load failed"));
        image.src = url;
    });

const snapshotOf = (doc: CanvasLayerDoc): Snapshot => ({ layers: doc.layers, baseVisible: doc.baseVisible });
const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

type Props = {
    open: boolean;
    /** 节点当前显示的图片 */
    dataUrl: string;
    storageKey?: string;
    /** 节点上保存的图层；只有和当前图片对得上（flatKey 一致）才会恢复 */
    layerDoc?: CanvasLayerDoc;
    onClose: () => void;
    onConfirm: (result: LayerEditorResult) => Promise<void> | void;
};

export function CanvasNodeLayerDialog({ open, dataUrl, storageKey, layerDoc, onClose, onConfirm }: Props) {
    const { t } = useTranslation();
    const { message, modal } = App.useApp();
    const hasComfy = useConfigStore((state) => hasComfyChannel(state.config.channels));
    const [doc, setDoc] = useState<CanvasLayerDoc | null>(null);
    const [baseImage, setBaseImage] = useState<HTMLImageElement | null>(null);
    const [selectedId, setSelectedId] = useState<string | null>(null);
    const [busy, setBusy] = useState<"" | "apply" | "cutout" | "insert">("");
    const [pickerOpen, setPickerOpen] = useState(false);
    const [renamingId, setRenamingId] = useState<string | null>(null);
    const [imageVersion, bumpImages] = useReducer((value: number) => value + 1, 0);
    const [, bumpHistory] = useReducer((value: number) => value + 1, 0);
    const docRef = useRef<CanvasLayerDoc | null>(null);
    const images = useRef(new Map<string, HTMLImageElement>());
    const past = useRef<Snapshot[]>([]);
    const future = useRef<Snapshot[]>([]);
    const lastEdit = useRef({ key: "", time: 0 });
    const canvasRef = useRef<HTMLCanvasElement>(null);
    const fileRef = useRef<HTMLInputElement>(null);
    const dragRef = useRef<AbortController | null>(null);
    const jobRef = useRef<AbortController | null>(null);
    docRef.current = doc;
    const viewport = useImageEditorViewport(doc ? { width: doc.width, height: doc.height } : null, open);
    const stageScale = viewport.imageScale;
    const selected = doc?.layers.find((layer) => layer.id === selectedId) || null;

    const registerImage = useCallback(async (key: string) => {
        const image = await loadImage(await resolveImageUrl(key));
        images.current.set(key, image);
        bumpImages();
        return image;
    }, []);

    // 打开：读底图和已有图层的图片
    useEffect(() => {
        if (!open) return;
        let canceled = false;
        setDoc(null);
        setBaseImage(null);
        setSelectedId(null);
        past.current = [];
        future.current = [];
        images.current.clear();
        (async () => {
            const restore = layerDoc && layerDoc.flatKey === storageKey ? layerDoc : null;
            const base = await loadImage(restore ? await resolveImageUrl(restore.base.storageKey, dataUrl) : dataUrl);
            if (restore) await Promise.all(restore.layers.filter((layer) => layer.type === "image").map((layer) => registerImage(layer.storageKey)));
            if (canceled) return;
            setBaseImage(base);
            setDoc(restore ? { ...restore, width: base.naturalWidth, height: base.naturalHeight } : { width: base.naturalWidth, height: base.naturalHeight, base: { storageKey: storageKey || "" }, baseVisible: true, flatKey: "", layers: [] });
        })().catch(() => message.error(t("canvas.layers.loadFailed")));
        return () => {
            canceled = true;
            dragRef.current?.abort();
            jobRef.current?.abort();
        };
    }, [open, dataUrl, storageKey, layerDoc, message, registerImage, t]);

    // 预览：和导出走同一个绘制函数，所见即所得
    useEffect(() => {
        const canvas = canvasRef.current;
        if (!canvas || !doc || !baseImage) return;
        const scale = Math.min(1, PREVIEW_LONG_EDGE / Math.max(doc.width, doc.height));
        const width = Math.round(doc.width * scale);
        const height = Math.round(doc.height * scale);
        if (canvas.width !== width || canvas.height !== height) {
            canvas.width = width;
            canvas.height = height;
        }
        renderDoc(canvas.getContext("2d")!, doc, baseImage, (key) => images.current.get(key), scale);
    }, [doc, baseImage, imageVersion]);

    const pushHistory = useCallback(() => {
        const current = docRef.current;
        if (!current) return;
        past.current.push(snapshotOf(current));
        if (past.current.length > HISTORY_LIMIT) past.current.shift();
        future.current = [];
        bumpHistory();
    }, []);

    const undo = useCallback(() => {
        const previous = past.current.pop();
        const current = docRef.current;
        if (!previous || !current) return;
        future.current.push(snapshotOf(current));
        setDoc({ ...current, ...previous });
        bumpHistory();
    }, []);

    const redo = useCallback(() => {
        const next = future.current.pop();
        const current = docRef.current;
        if (!next || !current) return;
        past.current.push(snapshotOf(current));
        setDoc({ ...current, ...next });
        bumpHistory();
    }, []);

    const patchLayer = useCallback((id: string, patch: Partial<CanvasLayer>) => {
        setDoc((current) => (current ? { ...current, layers: current.layers.map((layer) => (layer.id === id ? ({ ...layer, ...patch } as CanvasLayer) : layer)) } : current));
    }, []);

    /** 面板里的修改：同一个图层同一个字段 0.8 秒内的连续修改只记一次撤销 */
    const editLayer = (id: string, patch: Partial<CanvasLayer>, key = "") => {
        const now = Date.now();
        const token = `${id}:${key}`;
        if (!key || lastEdit.current.key !== token || now - lastEdit.current.time > 800) pushHistory();
        lastEdit.current = { key: token, time: now };
        patchLayer(id, patch);
    };

    const addLayer = (layer: CanvasLayer) => {
        pushHistory();
        setDoc((current) => (current ? { ...current, layers: [...current.layers, layer] } : current));
        setSelectedId(layer.id);
    };

    const removeLayer = useCallback(
        (id: string) => {
            pushHistory();
            setDoc((current) => (current ? { ...current, layers: current.layers.filter((layer) => layer.id !== id) } : current));
            setSelectedId((current) => (current === id ? null : current));
        },
        [pushHistory],
    );

    const moveLayer = (id: string, direction: 1 | -1) => {
        if (!doc) return;
        const index = doc.layers.findIndex((layer) => layer.id === id);
        const target = index + direction;
        if (index < 0 || target < 0 || target >= doc.layers.length) return;
        pushHistory();
        const layers = [...doc.layers];
        [layers[index], layers[target]] = [layers[target], layers[index]];
        setDoc({ ...doc, layers });
    };

    // 弹窗打开时拦住画布本身的快捷键（Delete 会删掉选中的节点），并接管撤销 / 重做 / 删除 / 微调
    useEffect(() => {
        if (!open) return;
        const handleKeyDown = (event: KeyboardEvent) => {
            if (event.target instanceof Element && event.target.closest("input,textarea,select,[contenteditable='true']")) return;
            const key = event.key.toLowerCase();
            const modifier = (event.metaKey || event.ctrlKey) && !event.altKey;
            const isArrow = key.startsWith("arrow");
            if (!modifier && !isArrow && key !== "delete" && key !== "backspace") return;
            event.stopPropagation();
            event.stopImmediatePropagation();
            if (modifier && key === "z") {
                event.preventDefault();
                if (event.shiftKey) redo();
                else undo();
            } else if (modifier && key === "y") {
                event.preventDefault();
                redo();
            } else if (selected && !selected.locked && (key === "delete" || key === "backspace")) {
                event.preventDefault();
                removeLayer(selected.id);
            } else if (selected && !selected.locked && isArrow && !modifier) {
                event.preventDefault();
                const step = event.shiftKey ? 10 : 1;
                const dx = key === "arrowleft" ? -step : key === "arrowright" ? step : 0;
                const dy = key === "arrowup" ? -step : key === "arrowdown" ? step : 0;
                editLayer(selected.id, { x: selected.x + dx, y: selected.y + dy }, "nudge");
            }
        };
        window.addEventListener("keydown", handleKeyDown, true);
        return () => window.removeEventListener("keydown", handleKeyDown, true);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [open, selected, undo, redo, removeLayer]);

    const pointerToBase = (event: { clientX: number; clientY: number }) => {
        const rect = viewport.stageRef.current?.getBoundingClientRect();
        if (!rect || !stageScale) return null;
        return { x: (event.clientX - rect.left) / stageScale, y: (event.clientY - rect.top) / stageScale };
    };

    const startDrag = (mode: DragMode, layer: CanvasLayer, event: ReactPointerEvent) => {
        const start = pointerToBase(event);
        if (!start) return;
        event.preventDefault();
        event.stopPropagation();
        dragRef.current?.abort();
        const controller = new AbortController();
        dragRef.current = controller;
        pushHistory();
        const origin = { ...layer };
        const startDistance = Math.max(1, Math.hypot(start.x - origin.x, start.y - origin.y));
        const startAngle = Math.atan2(start.y - origin.y, start.x - origin.x);
        const move = (moveEvent: PointerEvent) => {
            const point = pointerToBase(moveEvent);
            if (!point) return;
            if (mode === "move") patchLayer(origin.id, { x: origin.x + point.x - start.x, y: origin.y + point.y - start.y });
            else if (mode === "scale") patchLayer(origin.id, { scale: clamp((origin.scale * Math.hypot(point.x - origin.x, point.y - origin.y)) / startDistance, 0.02, 60) });
            else {
                let rotation = origin.rotation + ((Math.atan2(point.y - origin.y, point.x - origin.x) - startAngle) * 180) / Math.PI;
                const nearest = Math.round(rotation / 15) * 15;
                if (Math.abs(rotation - nearest) < 3) rotation = nearest;
                patchLayer(origin.id, { rotation: ((((rotation + 180) % 360) + 360) % 360) - 180 });
            }
        };
        const stop = () => controller.abort();
        document.addEventListener("pointermove", move, { signal: controller.signal });
        document.addEventListener("pointerup", stop, { signal: controller.signal });
        document.addEventListener("pointercancel", stop, { signal: controller.signal });
    };

    const handleStagePointerDown = (event: ReactPointerEvent) => {
        if (event.button !== 0 || !doc) return;
        const point = pointerToBase(event);
        if (!point) return;
        const hit = [...doc.layers].reverse().find((layer) => layer.visible && !layer.locked && hitLayer(layer, point));
        setSelectedId(hit?.id || null);
        if (hit) startDrag("move", hit, event);
    };

    const insertImage = async (source: { storageKey: string; name?: string }) => {
        if (!doc) return;
        const image = await registerImage(source.storageKey);
        addLayer(createImageLayer(doc, { storageKey: source.storageKey, width: image.naturalWidth, height: image.naturalHeight, name: source.name }));
    };

    const handleInsertAsset = async (payload: InsertAssetPayload) => {
        if (payload.kind !== "image") return;
        setPickerOpen(false);
        setBusy("insert");
        try {
            const key = payload.storageKey || (await uploadImage(payload.dataUrl)).storageKey;
            if (!key) throw new Error(t("canvas.layers.loadFailed"));
            await insertImage({ storageKey: key, name: payload.title });
        } catch (error) {
            message.error(error instanceof Error ? error.message : String(error));
        } finally {
            setBusy("");
        }
    };

    const handleUploadFile = async (file?: File) => {
        if (!file) return;
        setBusy("insert");
        try {
            const key = (await uploadImage(file)).storageKey;
            if (!key) throw new Error(t("canvas.layers.loadFailed"));
            await insertImage({ storageKey: key, name: file.name.replace(/\.[^.]+$/, "") });
        } catch (error) {
            message.error(error instanceof Error ? error.message : String(error));
        } finally {
            setBusy("");
        }
    };

    const runCutout = async () => {
        if (!doc || !baseImage) return;
        const source = selected?.type === "image" ? selected : null;
        const controller = new AbortController();
        jobRef.current = controller;
        setBusy("cutout");
        try {
            const blob = source ? await getImageBlob(source.storageKey) : await (await fetch(dataUrl)).blob();
            if (!blob) throw new Error(t("canvas.layers.loadFailed"));
            const matte = await cutoutSubject(blob, controller.signal);
            const uploaded = await uploadImage(matte);
            if (!uploaded.storageKey) throw new Error(t("canvas.layers.loadFailed"));
            await registerImage(uploaded.storageKey);
            const layer = createImageLayer(doc, { storageKey: uploaded.storageKey, width: uploaded.width, height: uploaded.height, name: t("canvas.layers.names.cutout"), cutout: true }, "cover");
            if (source) Object.assign(layer, { x: source.x, y: source.y, rotation: source.rotation, scale: (source.scale * source.width) / uploaded.width });
            addLayer(layer);
            message.success(t("canvas.layers.cutoutDone"));
        } catch (error) {
            if (!controller.signal.aborted) message.error(error instanceof Error ? error.message : String(error));
        } finally {
            setBusy("");
        }
    };

    const apply = async () => {
        if (!doc || !baseImage) return;
        setBusy("apply");
        try {
            const canvas = document.createElement("canvas");
            canvas.width = doc.width;
            canvas.height = doc.height;
            renderDoc(canvas.getContext("2d")!, doc, baseImage, (key) => images.current.get(key), 1);
            const blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob((result) => (result ? resolve(result) : reject(new Error("toBlob failed"))), "image/png"));
            const baseKey = doc.base.storageKey || (await uploadImage(dataUrl)).storageKey;
            if (!baseKey) throw new Error(t("canvas.layers.loadFailed"));
            await onConfirm({ blob, doc: { width: doc.width, height: doc.height, base: { storageKey: baseKey }, baseVisible: doc.baseVisible, layers: doc.layers } });
        } catch (error) {
            message.error(error instanceof Error ? error.message : String(error));
        } finally {
            setBusy("");
        }
    };

    const reset = () => {
        if (!doc || (!doc.layers.length && doc.baseVisible)) return;
        pushHistory();
        setDoc({ ...doc, layers: [], baseVisible: true });
        setSelectedId(null);
    };

    // 有改动时关闭先确认：抠图要调两次接口，别因为误按 Esc 白白丢掉
    const requestClose = () => {
        if (!past.current.length) return onClose();
        modal.confirm({ title: t("canvas.layers.discardTitle"), content: t("canvas.layers.discardContent"), okText: t("canvas.layers.discardOk"), cancelText: t("canvas.layers.keepEditing"), okButtonProps: { danger: true }, onOk: onClose });
    };

    const size = selected ? layerSize(selected) : null;
    const update = (patch: Partial<CanvasLayer>, key = "") => selected && editLayer(selected.id, patch, key);

    return (
        <Modal title={t("canvas.layers.title")} open={open && Boolean(dataUrl)} onCancel={requestClose} footer={null} width="min(1320px, 96vw)" centered destroyOnHidden mask={{ closable: false }} transitionName="" maskTransitionName="">
            <Spin spinning={busy !== "" || !doc} description={busy === "cutout" ? t("canvas.layers.cutoutBusy") : undefined}>
                <div className="flex h-[min(78vh,780px)] min-h-[520px] gap-3">
                    <aside className="flex w-56 shrink-0 flex-col rounded-lg border">
                        <div className="min-h-0 flex-1 overflow-y-auto p-1">
                            {[...(doc?.layers || [])].reverse().map((layer) => (
                                <div key={layer.id} className={`group flex items-center gap-1 rounded px-1 py-1 text-xs ${layer.id === selectedId ? "bg-blue-500/15" : "hover:bg-black/5 dark:hover:bg-white/10"}`} onClick={() => setSelectedId(layer.id)}>
                                    <button
                                        type="button"
                                        className="p-1 opacity-70 hover:opacity-100"
                                        title={t(layer.visible ? "canvas.layers.hide" : "canvas.layers.show")}
                                        onClick={(event) => {
                                            event.stopPropagation();
                                            editLayer(layer.id, { visible: !layer.visible });
                                        }}
                                    >
                                        {layer.visible ? <Eye className="size-3.5" /> : <EyeOff className="size-3.5" />}
                                    </button>
                                    <button
                                        type="button"
                                        className="p-1 opacity-70 hover:opacity-100"
                                        title={t(layer.locked ? "canvas.layers.unlock" : "canvas.layers.lock")}
                                        onClick={(event) => {
                                            event.stopPropagation();
                                            editLayer(layer.id, { locked: !layer.locked });
                                        }}
                                    >
                                        {layer.locked ? <Lock className="size-3.5" /> : <LockOpen className="size-3.5" />}
                                    </button>
                                    {renamingId === layer.id ? (
                                        <Input
                                            size="small"
                                            autoFocus
                                            defaultValue={layer.name}
                                            onClick={(event) => event.stopPropagation()}
                                            onBlur={(event) => {
                                                editLayer(layer.id, { name: event.target.value.trim() || layer.name });
                                                setRenamingId(null);
                                            }}
                                            onPressEnter={(event) => event.currentTarget.blur()}
                                        />
                                    ) : (
                                        <span className="min-w-0 flex-1 truncate" onDoubleClick={() => setRenamingId(layer.id)} title={t("canvas.layers.renameHint")}>
                                            {layer.name}
                                        </span>
                                    )}
                                </div>
                            ))}
                            {doc ? (
                                <div className="flex items-center gap-1 rounded px-1 py-1 text-xs opacity-80">
                                    <button
                                        type="button"
                                        className="p-1 hover:opacity-100"
                                        title={t(doc.baseVisible ? "canvas.layers.hide" : "canvas.layers.show")}
                                        onClick={() => {
                                            pushHistory();
                                            setDoc({ ...doc, baseVisible: !doc.baseVisible });
                                        }}
                                    >
                                        {doc.baseVisible ? <Eye className="size-3.5" /> : <EyeOff className="size-3.5" />}
                                    </button>
                                    <span className="p-1">
                                        <Lock className="size-3.5" />
                                    </span>
                                    <span className="flex-1 truncate">{t("canvas.layers.base")}</span>
                                </div>
                            ) : null}
                        </div>
                        <div className="flex items-center justify-center gap-1 border-t p-1">
                            <Tooltip title={t("canvas.layers.moveUp")}>
                                <Button type="text" size="small" disabled={!selected} icon={<ArrowUp className="size-4" />} onClick={() => selected && moveLayer(selected.id, 1)} />
                            </Tooltip>
                            <Tooltip title={t("canvas.layers.moveDown")}>
                                <Button type="text" size="small" disabled={!selected} icon={<ArrowDown className="size-4" />} onClick={() => selected && moveLayer(selected.id, -1)} />
                            </Tooltip>
                            <Tooltip title={t("canvas.layers.duplicate")}>
                                <Button type="text" size="small" disabled={!selected} icon={<Copy className="size-4" />} onClick={() => doc && selected && addLayer(cloneLayer(selected, doc))} />
                            </Tooltip>
                            <Tooltip title={t("canvas.layers.delete")}>
                                <Button type="text" size="small" danger disabled={!selected || selected.locked} icon={<Trash2 className="size-4" />} onClick={() => selected && removeLayer(selected.id)} />
                            </Tooltip>
                        </div>
                    </aside>

                    <section className="flex min-w-0 flex-1 flex-col gap-2">
                        <div className="flex flex-wrap items-center gap-1">
                            <Button size="small" icon={<Type className="size-4" />} disabled={!doc} onClick={() => doc && addLayer(createTextLayer(doc))}>
                                {t("canvas.layers.add.text")}
                            </Button>
                            <Button size="small" icon={<Tag className="size-4" />} disabled={!doc} onClick={() => doc && addLayer(createLabelLayer(doc))}>
                                {t("canvas.layers.add.label")}
                            </Button>
                            <Button size="small" icon={<Shapes className="size-4" />} disabled={!doc} onClick={() => doc && addLayer(createShapeLayer(doc))}>
                                {t("canvas.layers.add.shape")}
                            </Button>
                            <Button size="small" icon={<ImagePlus className="size-4" />} disabled={!doc} onClick={() => setPickerOpen(true)}>
                                {t("canvas.layers.add.asset")}
                            </Button>
                            <Button size="small" icon={<Upload className="size-4" />} disabled={!doc} onClick={() => fileRef.current?.click()}>
                                {t("canvas.layers.add.upload")}
                            </Button>
                            <input
                                ref={fileRef}
                                type="file"
                                accept="image/*"
                                hidden
                                onChange={(event) => {
                                    void handleUploadFile(event.target.files?.[0]);
                                    event.target.value = "";
                                }}
                            />
                            <Tooltip title={hasComfy ? t("canvas.layers.cutoutHint") : t("comfyui.noChannel")}>
                                <span>
                                    <Button size="small" icon={<Sparkles className="size-4" />} disabled={!doc || !hasComfy} onClick={() => void runCutout()}>
                                        {selected?.type === "image" ? t("canvas.layers.cutoutLayer") : t("canvas.layers.cutoutBase")}
                                    </Button>
                                </span>
                            </Tooltip>
                            <span className="mx-1 h-4 w-px bg-current opacity-20" />
                            <Button size="small" type="text" icon={<Undo2 className="size-4" />} disabled={!past.current.length} onClick={undo} title={t("canvas.layers.undo")} />
                            <Button size="small" type="text" icon={<Redo2 className="size-4" />} disabled={!future.current.length} onClick={redo} title={t("canvas.layers.redo")} />
                            <span className="mx-1 h-4 w-px bg-current opacity-20" />
                            <Button size="small" type="text" icon={<ZoomOut className="size-4" />} disabled={!viewport.canZoomOut} onClick={viewport.zoomOut} />
                            <button type="button" className="min-w-12 text-center text-xs font-semibold tabular-nums opacity-70" onClick={viewport.resetZoom}>
                                {Math.round(viewport.zoom * 100)}%
                            </button>
                            <Button size="small" type="text" icon={<ZoomIn className="size-4" />} disabled={!viewport.canZoomIn} onClick={viewport.zoomIn} />
                            <span className="ml-auto text-xs opacity-55">{doc ? `${doc.width} x ${doc.height}` : ""}</span>
                        </div>
                        <div
                            ref={viewport.viewportRef}
                            {...viewport.panHandlers}
                            className={`relative min-h-0 flex-1 rounded-lg bg-black/5 ${viewport.scrollClassName} ${viewport.isPanning ? "cursor-grabbing" : viewport.spacePressed ? "cursor-grab" : ""}`}
                        >
                            <div className="relative" style={viewport.contentStyle}>
                                <div ref={viewport.stageRef} className="absolute isolate select-none rounded-lg shadow" style={{ ...viewport.stageStyle, ...checkerboard }} onPointerDown={handleStagePointerDown}>
                                    <canvas ref={canvasRef} className="absolute inset-0 block h-full w-full rounded-lg" />
                                    {selected && size && selected.visible ? (
                                        <div
                                            className="pointer-events-none absolute border border-blue-500"
                                            style={{
                                                left: selected.x * stageScale,
                                                top: selected.y * stageScale,
                                                width: size.width * selected.scale * stageScale,
                                                height: size.height * selected.scale * stageScale,
                                                transform: `translate(-50%, -50%) rotate(${selected.rotation}deg)`,
                                            }}
                                        >
                                            {!selected.locked ? (
                                                <>
                                                    {corners.map((corner) => (
                                                        <button
                                                            key={`${corner.x}${corner.y}`}
                                                            type="button"
                                                            className="pointer-events-auto absolute size-3 -translate-x-1/2 -translate-y-1/2 cursor-nwse-resize rounded-sm border border-blue-500 bg-white"
                                                            style={{ left: `${corner.x * 100}%`, top: `${corner.y * 100}%` }}
                                                            onPointerDown={(event) => startDrag("scale", selected, event)}
                                                            aria-label={t("canvas.layers.scale")}
                                                        />
                                                    ))}
                                                    <span className="absolute left-1/2 top-0 h-5 w-px -translate-y-full bg-blue-500" />
                                                    <button
                                                        type="button"
                                                        className="pointer-events-auto absolute left-1/2 top-0 size-3 -translate-x-1/2 -translate-y-[calc(100%+20px)] cursor-grab rounded-full border border-blue-500 bg-white"
                                                        onPointerDown={(event) => startDrag("rotate", selected, event)}
                                                        aria-label={t("canvas.layers.rotate")}
                                                    />
                                                </>
                                            ) : null}
                                        </div>
                                    ) : null}
                                </div>
                            </div>
                        </div>
                        <p className="text-xs opacity-55">{t("canvas.layers.hint")}</p>
                    </section>

                    <aside className="w-64 shrink-0 overflow-y-auto rounded-lg border p-3">
                        {selected && doc ? <LayerProperties layer={selected} canvas={doc} onChange={update} /> : <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t("canvas.layers.empty")} />}
                    </aside>
                </div>
                <div className="mt-3 flex items-center justify-end gap-2">
                    <Button onClick={reset}>{t("canvas.layers.reset")}</Button>
                    <Button icon={<X className="size-4" />} onClick={requestClose}>
                        {t("canvas.editors.cancel")}
                    </Button>
                    <Button type="primary" icon={<Check className="size-4" />} disabled={!doc} onClick={() => void apply()}>
                        {t("canvas.layers.apply")}
                    </Button>
                </div>
            </Spin>
            <AssetPickerModal open={pickerOpen} onInsert={(payload) => void handleInsertAsset(payload)} onClose={() => setPickerOpen(false)} />
        </Modal>
    );
}
