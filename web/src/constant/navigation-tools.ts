import { FileText, ImagePlus, Images, Layers, Maximize2, Mic, Settings2, Video } from "lucide-react";

export const navigationTools = [
    {
        slug: "canvas",
        icon: Maximize2,
    },
    {
        slug: "image",
        icon: ImagePlus,
    },
    {
        slug: "video",
        icon: Video,
    },
    {
        slug: "prompts",
        icon: FileText,
    },
    {
        slug: "assets",
        icon: Images,
    },
    {
        slug: "batch",
        icon: Layers,
    },
    {
        slug: "voices",
        icon: Mic,
    },
    {
        slug: "config",
        icon: Settings2,
    },
] as const;

export type NavigationToolSlug = (typeof navigationTools)[number]["slug"];
