import { Copy, Mic, Play, Plus, RefreshCw, Trash2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { App, Button, Empty, Form, Input, Modal, Popconfirm, Select, Table, Tag } from "antd";
import { useTranslation } from "react-i18next";

import { useCopyText } from "@/hooks/use-copy-text";
import { cloneVoice, deleteVoice, designVoice, hasComfyChannel, listVoices, previewVoice, type CustomVoice } from "@/services/api/comfyui";
import { useConfigStore } from "@/stores/use-config-store";

type Row = CustomVoice & { kind: "design" | "clone" };
type DesignValues = { prompt: string; previewText: string; name: string; language: string };
type CloneValues = { name: string };

const languages = ["zh", "en", "ja", "ko", "de", "fr", "es", "it", "pt", "ru"];

export default function VoicesPage() {
    const { message } = App.useApp();
    const { t } = useTranslation();
    const copyText = useCopyText();
    const ready = useConfigStore((state) => hasComfyChannel(state.config.channels));
    const [rows, setRows] = useState<Row[]>([]);
    const [loading, setLoading] = useState(false);
    const [busy, setBusy] = useState("");
    const [modal, setModal] = useState<"design" | "clone" | null>(null);
    const [designForm] = Form.useForm<DesignValues>();
    const [cloneForm] = Form.useForm<CloneValues>();
    const sampleRef = useRef<File | null>(null);
    const audioRef = useRef<HTMLAudioElement | null>(null);

    const play = (blob: Blob) => {
        audioRef.current?.pause();
        const audio = new Audio(URL.createObjectURL(blob));
        audioRef.current = audio;
        audio.play().catch(() => undefined);
    };

    const run = async (key: string, action: () => Promise<void>) => {
        setBusy(key);
        try {
            await action();
        } catch (error) {
            message.error(error instanceof Error ? error.message : String(error));
        } finally {
            setBusy("");
        }
    };

    const refresh = async () => {
        setLoading(true);
        try {
            const list = await listVoices();
            setRows([...list.design.map((item) => ({ ...item, kind: "design" as const })), ...list.clone.map((item) => ({ ...item, kind: "clone" as const }))]);
        } catch (error) {
            message.error(error instanceof Error ? error.message : String(error));
        } finally {
            setLoading(false);
        }
    };

    useEffect(() => {
        if (ready) void refresh();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [ready]);

    const submitDesign = (values: DesignValues) =>
        run("design", async () => {
            const { voice, preview } = await designVoice(values);
            play(preview);
            message.success(t("voices.created", { voice }));
            setModal(null);
            await refresh();
        });

    const submitClone = (values: CloneValues) =>
        run("clone", async () => {
            if (!sampleRef.current) throw new Error(t("voices.needSample"));
            await cloneVoice(sampleRef.current, values.name);
            message.success(t("voices.cloned"));
            setModal(null);
            await refresh();
        });

    return (
        <div className="flex h-full flex-col overflow-hidden bg-background text-stone-900 dark:text-stone-100">
            <main className="min-h-0 flex-1 overflow-y-auto px-6 py-8">
                <div className="mx-auto max-w-6xl">
                    <h1 className="text-3xl font-semibold tracking-tight text-stone-950 dark:text-stone-100">{t("voices.title")}</h1>
                    <p className="mt-2 text-sm text-stone-500 dark:text-stone-400">{t("voices.description")}</p>
                    {!ready ? (
                        <Empty className="mt-16" description={t("comfyui.noChannel")} />
                    ) : (
                        <>
                            <div className="mt-6 flex flex-wrap gap-3">
                                <Button type="primary" icon={<Plus className="size-4" />} onClick={() => setModal("design")}>
                                    {t("voices.design")}
                                </Button>
                                <Button icon={<Mic className="size-4" />} onClick={() => setModal("clone")}>
                                    {t("voices.clone")}
                                </Button>
                                <Button icon={<RefreshCw className="size-4" />} loading={loading} onClick={() => void refresh()}>
                                    {t("voices.refresh")}
                                </Button>
                            </div>
                            <Table<Row>
                                className="mt-4"
                                rowKey="voice"
                                loading={loading}
                                dataSource={rows}
                                pagination={false}
                                locale={{ emptyText: t("voices.empty") }}
                                columns={[
                                    { title: t("voices.kind"), dataIndex: "kind", width: 90, render: (kind: Row["kind"]) => <Tag color={kind === "design" ? "blue" : "green"}>{t(`voices.kinds.${kind}`)}</Tag> },
                                    { title: t("voices.detail"), render: (_, row) => <span className="text-stone-600 dark:text-stone-300">{row.voice_prompt || t("voices.cloneDetail")}</span> },
                                    { title: "ID", dataIndex: "voice", render: (voice: string) => <code className="text-xs break-all">{voice}</code> },
                                    { title: t("voices.createdAt"), dataIndex: "gmt_create", width: 170 },
                                    {
                                        title: "",
                                        width: 150,
                                        render: (_, row) => (
                                            <div className="flex gap-1">
                                                <Button
                                                    type="text"
                                                    size="small"
                                                    title={t("voices.preview")}
                                                    loading={busy === `play:${row.voice}`}
                                                    icon={<Play className="size-4" />}
                                                    onClick={() => void run(`play:${row.voice}`, async () => play(await previewVoice(row.voice, t("voices.previewSentence"))))}
                                                />
                                                <Button type="text" size="small" title={t("common.copy")} icon={<Copy className="size-4" />} onClick={() => copyText(row.voice)} />
                                                <Popconfirm
                                                    title={t("voices.deleteConfirm")}
                                                    okText={t("common.delete")}
                                                    cancelText={t("common.cancel")}
                                                    okButtonProps={{ danger: true }}
                                                    onConfirm={() =>
                                                        void run(`del:${row.voice}`, async () => {
                                                            await deleteVoice(row.voice);
                                                            setRows((items) => items.filter((item) => item.voice !== row.voice));
                                                        })
                                                    }
                                                >
                                                    <Button type="text" size="small" danger title={t("common.delete")} loading={busy === `del:${row.voice}`} icon={<Trash2 className="size-4" />} />
                                                </Popconfirm>
                                            </div>
                                        ),
                                    },
                                ]}
                            />
                        </>
                    )}
                </div>
            </main>

            <Modal open={modal === "design"} title={t("voices.design")} okText={t("voices.create")} cancelText={t("common.cancel")} confirmLoading={busy === "design"} onCancel={() => setModal(null)} onOk={() => designForm.submit()}>
                <Form form={designForm} layout="vertical" initialValues={{ prompt: t("voices.defaultPrompt"), previewText: t("voices.defaultPreview"), name: "myvoice", language: "zh" }} onFinish={submitDesign}>
                    <Form.Item name="prompt" label={t("voices.prompt")} rules={[{ required: true }]}>
                        <Input.TextArea rows={3} />
                    </Form.Item>
                    <Form.Item name="previewText" label={t("voices.previewText")} rules={[{ required: true }]}>
                        <Input.TextArea rows={2} />
                    </Form.Item>
                    <Form.Item name="name" label={t("voices.name")} rules={[{ required: true, pattern: /^\w+$/, message: t("voices.nameRule") }]}>
                        <Input />
                    </Form.Item>
                    <Form.Item name="language" label={t("voices.language")}>
                        <Select options={languages.map((value) => ({ value, label: value }))} />
                    </Form.Item>
                </Form>
            </Modal>

            <Modal
                open={modal === "clone"}
                title={t("voices.clone")}
                okText={t("voices.create")}
                cancelText={t("common.cancel")}
                confirmLoading={busy === "clone"}
                onCancel={() => setModal(null)}
                onOk={() => cloneForm.submit()}
                afterClose={() => (sampleRef.current = null)}
            >
                <Form form={cloneForm} layout="vertical" initialValues={{ name: "myclone" }} onFinish={submitClone}>
                    <p className="mb-3 text-xs text-stone-500 dark:text-stone-400">{t("voices.cloneHint")}</p>
                    <Form.Item label={t("voices.sampleFile")}>
                        <input type="file" accept="audio/*" onChange={(event) => (sampleRef.current = event.target.files?.[0] || null)} />
                    </Form.Item>
                    <Form.Item name="name" label={t("voices.name")} rules={[{ required: true, pattern: /^\w+$/, message: t("voices.nameRule") }]}>
                        <Input />
                    </Form.Item>
                </Form>
            </Modal>
        </div>
    );
}
