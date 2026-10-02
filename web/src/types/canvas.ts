export type Position = {
    x: number;
    y: number;
};

export type ViewportTransform = {
    x: number;
    y: number;
    k: number;
};

export enum CanvasNodeType {
    Image = "image",
    Text = "text",
    Config = "config",
    Video = "video",
    Audio = "audio",
    Group = "group",
}

// Node types are open strings: built-ins use CanvasNodeType and plugins use "<pluginId>:<name>".
export type CanvasNodeTypeId = CanvasNodeType | (string & {});

export type CanvasNodeStatus = "idle" | "success" | "loading" | "error";
export type CanvasGenerationMode = "text" | "image" | "video" | "audio";
export type CanvasImageGenerationType = "generation" | "edit";

export type CanvasNodeImage = {
    id: string;
    status: CanvasNodeStatus;
    errorDetails?: string;
    content: string;
    storageKey?: string;
    naturalWidth: number;
    naturalHeight: number;
    bytes: number;
    mimeType: string;
};

export type CanvasNodeText = {
    id: string;
    status: CanvasNodeStatus;
    errorDetails?: string;
    content: string;
};

export type CanvasLayerBase = {
    id: string;
    name: string;
    visible: boolean;
    locked: boolean;
    /** 图层中心，单位是底图像素 */
    x: number;
    y: number;
    rotation: number;
    /** 整体等比缩放（缩放手柄改这个值） */
    scale: number;
    opacity: number;
};

export type CanvasLabelStyleId = "redWhite" | "yellowBlack" | "blackGold" | "blueWhite" | "greenWhite" | "whiteRed" | "outline";
export type CanvasShapeKind = "roundRect" | "pill" | "rect" | "circle";

// 图片类图层（贴图 / 抠图）的 storageKey 必须叫 storageKey：画布导出和未使用图片清理都按这个字段名找图。
export type CanvasImageLayer = CanvasLayerBase & { type: "image"; storageKey: string; width: number; height: number; cutout?: boolean };
export type CanvasTextLayer = CanvasLayerBase & { type: "text"; text: string; fontFamily: "sans" | "serif" | "mono"; fontSize: number; bold: boolean; color: string; strokeColor: string; strokeWidth: number; align: "left" | "center" | "right" };
export type CanvasLabelLayer = CanvasLayerBase & { type: "label"; text: string; shape: CanvasShapeKind; style: CanvasLabelStyleId; fontSize: number };
export type CanvasShapeLayer = CanvasLayerBase & { type: "shape"; shape: CanvasShapeKind; width: number; height: number; fill: string; strokeColor: string; strokeWidth: number };
export type CanvasLayer = CanvasImageLayer | CanvasTextLayer | CanvasLabelLayer | CanvasShapeLayer;

export type CanvasLayerDoc = {
    /** 底图尺寸，也是导出图的尺寸 */
    width: number;
    height: number;
    base: { storageKey: string };
    baseVisible: boolean;
    /** 合成图的 storageKey；节点换过图（和它对不上）就说明这份图层已过期 */
    flatKey: string;
    /** 从下到上 */
    layers: CanvasLayer[];
};

export type CanvasNodeMetadata = {
    content?: string;
    composerContent?: string;
    prompt?: string;
    status?: CanvasNodeStatus;
    errorDetails?: string;
    fontSize?: number;
    generationMode?: CanvasGenerationMode;
    generationType?: CanvasImageGenerationType;
    model?: string;
    reasoningEffort?: "auto" | "low" | "medium" | "high" | "xhigh";
    size?: string;
    quality?: string;
    background?: string;
    count?: number;
    textCount?: number;
    texts?: CanvasNodeText[];
    primaryTextId?: string;
    seconds?: string;
    vquality?: string;
    generateAudio?: string;
    watermark?: string;
    videoMode?: string;
    audioVoice?: string;
    audioFormat?: string;
    audioSpeed?: string;
    audioInstructions?: string;
    references?: string[];
    naturalWidth?: number;
    naturalHeight?: number;
    freeResize?: boolean;
    images?: CanvasNodeImage[];
    primaryImageId?: string;
    storageKey?: string;
    mimeType?: string;
    bytes?: number;
    durationMs?: number;
    videoTaskId?: string;
    videoTaskProvider?: "openai" | "gemini";
    groupId?: string;
    layerDoc?: CanvasLayerDoc;
    interactive?: boolean; // Plugin node interaction/move state; see CanvasNodeDefinition.interactionToggle.
};

export type CanvasNodeData = {
    id: string;
    type: CanvasNodeTypeId;
    title: string;
    position: Position;
    width: number;
    height: number;
    metadata?: CanvasNodeMetadata;
};

export type CanvasConnection = {
    id: string;
    fromNodeId: string;
    toNodeId: string;
};

export type CanvasAssistantReference = {
    id: string;
    type: CanvasNodeTypeId;
    title: string;
    dataUrl?: string;
    storageKey?: string;
    text?: string;
};

export type CanvasAssistantImage = {
    id: string;
    dataUrl: string;
    storageKey?: string;
    prompt: string;
};

export type CanvasAssistantMessage = {
    id: string;
    role: "user" | "assistant" | "system" | "tool" | "error";
    title?: string;
    text: string;
    meta?: string;
    detail?: unknown;
    references?: CanvasAssistantReference[];
};

export type CanvasAssistantSession = {
    id: string;
    title: string;
    messages: CanvasAssistantMessage[];
    createdAt: string;
    updatedAt: string;
};

export type ConnectionHandle = {
    nodeId: string;
    handleType: "source" | "target";
};

export type SelectionBox = {
    startWorldX: number;
    startWorldY: number;
    currentWorldX: number;
    currentWorldY: number;
    additive: boolean;
    initialSelectedNodeIds: string[];
};

export type ContextMenuState =
    | {
          type: "node";
          x: number;
          y: number;
          nodeId: string;
      }
    | {
          type: "connection";
          x: number;
          y: number;
          connectionId: string;
      };
