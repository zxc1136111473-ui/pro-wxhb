import { Button, ColorPicker, Input, InputNumber, Segmented, Select, Slider, Switch } from "antd";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";

import { LABEL_STYLES, LABEL_STYLE_IDS, SHAPE_KINDS } from "@/lib/canvas/layer-render";
import type { CanvasLayer } from "@/types/canvas";

type Props = {
    layer: CanvasLayer;
    /** 底图尺寸，居中、铺满画布要用 */
    canvas: { width: number; height: number };
    /** key 相同的连续修改只记一次撤销（见编辑器里的 editLayer） */
    onChange: (patch: Partial<CanvasLayer>, key?: string) => void;
};

/** 图层编辑器右侧的属性面板：按图层类型显示各自的内容、样式，最后是通用的透明度、旋转、居中。 */
export function LayerProperties({ layer, canvas, onChange }: Props) {
    const { t } = useTranslation();

    return (
        <div className="space-y-3 text-xs">
            {layer.type === "text" ? (
                <>
                    <Field label={t("canvas.layers.props.content")}>
                        <Input.TextArea rows={3} value={layer.text} onChange={(event) => onChange({ text: event.target.value }, "text")} />
                    </Field>
                    <div className="flex items-center gap-2">
                        <Select
                            className="flex-1"
                            size="small"
                            value={layer.fontFamily}
                            onChange={(fontFamily) => onChange({ fontFamily })}
                            options={(["sans", "serif", "mono"] as const).map((value) => ({ value, label: t(`canvas.layers.props.fonts.${value}`) }))}
                        />
                        <Switch size="small" checked={layer.bold} onChange={(bold) => onChange({ bold })} />
                        <span>{t("canvas.layers.props.bold")}</span>
                    </div>
                    <Field label={t("canvas.layers.props.fontSize")}>
                        <InputNumber size="small" min={8} max={1000} value={layer.fontSize} onChange={(value) => onChange({ fontSize: value ?? layer.fontSize }, "fontSize")} />
                    </Field>
                    <div className="flex items-center gap-3">
                        <Field label={t("canvas.layers.props.color")}>
                            <ColorPicker size="small" disabledAlpha value={layer.color} onChange={(color) => onChange({ color: color.toHexString() }, "color")} />
                        </Field>
                        <Field label={t("canvas.layers.props.strokeColor")}>
                            <ColorPicker size="small" disabledAlpha value={layer.strokeColor} onChange={(color) => onChange({ strokeColor: color.toHexString() }, "strokeColor")} />
                        </Field>
                        <Field label={t("canvas.layers.props.strokeWidth")}>
                            <InputNumber className="w-16" size="small" min={0} max={200} value={layer.strokeWidth} onChange={(value) => onChange({ strokeWidth: value ?? 0 }, "strokeWidth")} />
                        </Field>
                    </div>
                    <Segmented
                        size="small"
                        block
                        value={layer.align}
                        onChange={(align) => onChange({ align: align as "left" | "center" | "right" })}
                        options={(["left", "center", "right"] as const).map((value) => ({ value, label: t(`canvas.layers.props.aligns.${value}`) }))}
                    />
                </>
            ) : null}
            {layer.type === "label" ? (
                <>
                    <Field label={t("canvas.layers.props.content")}>
                        <Input.TextArea rows={2} value={layer.text} onChange={(event) => onChange({ text: event.target.value }, "text")} />
                    </Field>
                    <Field label={t("canvas.layers.props.style")}>
                        <Select
                            size="small"
                            className="w-full"
                            value={layer.style}
                            onChange={(style) => onChange({ style })}
                            options={LABEL_STYLE_IDS.map((value) => ({
                                value,
                                label: (
                                    <span className="flex items-center gap-2">
                                        <i className="inline-block size-3 rounded-sm border" style={{ background: LABEL_STYLES[value].bg || LABEL_STYLES[value].stroke || "#fff" }} />
                                        {t(`canvas.layers.props.styles.${value}`)}
                                    </span>
                                ),
                            }))}
                        />
                    </Field>
                    <Field label={t("canvas.layers.props.shape")}>
                        <Select size="small" className="w-full" value={layer.shape} onChange={(shape) => onChange({ shape })} options={SHAPE_KINDS.map((value) => ({ value, label: t(`canvas.layers.props.shapes.${value}`) }))} />
                    </Field>
                    <Field label={t("canvas.layers.props.fontSize")}>
                        <InputNumber size="small" min={8} max={1000} value={layer.fontSize} onChange={(value) => onChange({ fontSize: value ?? layer.fontSize }, "fontSize")} />
                    </Field>
                </>
            ) : null}
            {layer.type === "shape" ? (
                <>
                    <Field label={t("canvas.layers.props.shape")}>
                        <Select size="small" className="w-full" value={layer.shape} onChange={(shape) => onChange({ shape })} options={SHAPE_KINDS.map((value) => ({ value, label: t(`canvas.layers.props.shapes.${value}`) }))} />
                    </Field>
                    <div className="flex items-center gap-2">
                        <Field label={t("canvas.layers.props.width")}>
                            <InputNumber className="w-24" size="small" min={1} max={20000} value={Math.round(layer.width)} onChange={(value) => onChange({ width: value ?? layer.width }, "width")} />
                        </Field>
                        <Field label={t("canvas.layers.props.height")}>
                            <InputNumber className="w-24" size="small" min={1} max={20000} value={Math.round(layer.height)} onChange={(value) => onChange({ height: value ?? layer.height }, "height")} />
                        </Field>
                    </div>
                    <Button size="small" block onClick={() => onChange({ shape: "rect", x: canvas.width / 2, y: canvas.height / 2, rotation: 0, scale: 1, width: canvas.width, height: canvas.height })}>
                        {t("canvas.layers.props.fitCanvas")}
                    </Button>
                    <div className="flex items-center gap-3">
                        <Field label={t("canvas.layers.props.fill")}>
                            <ColorPicker size="small" disabledAlpha value={layer.fill} onChange={(color) => onChange({ fill: color.toHexString() }, "fill")} />
                        </Field>
                        <Field label={t("canvas.layers.props.strokeColor")}>
                            <ColorPicker size="small" disabledAlpha value={layer.strokeColor} onChange={(color) => onChange({ strokeColor: color.toHexString() }, "strokeColor")} />
                        </Field>
                        <Field label={t("canvas.layers.props.strokeWidth")}>
                            <InputNumber className="w-16" size="small" min={0} max={400} value={layer.strokeWidth} onChange={(value) => onChange({ strokeWidth: value ?? 0 }, "strokeWidth")} />
                        </Field>
                    </div>
                </>
            ) : null}
            <Field label={t("canvas.layers.props.opacity")}>
                <Slider min={0} max={100} value={Math.round(layer.opacity * 100)} onChange={(value) => onChange({ opacity: value / 100 }, "opacity")} />
            </Field>
            <Field label={t("canvas.layers.props.rotation")}>
                <InputNumber size="small" min={-180} max={180} value={Math.round(layer.rotation)} onChange={(value) => onChange({ rotation: value ?? 0 }, "rotation")} />
            </Field>
            <div className="flex gap-2">
                <Button size="small" className="flex-1" onClick={() => onChange({ x: canvas.width / 2 })}>
                    {t("canvas.layers.props.centerH")}
                </Button>
                <Button size="small" className="flex-1" onClick={() => onChange({ y: canvas.height / 2 })}>
                    {t("canvas.layers.props.centerV")}
                </Button>
            </div>
        </div>
    );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
    return (
        <label className="block space-y-1">
            <span className="block opacity-60">{label}</span>
            {children}
        </label>
    );
}
