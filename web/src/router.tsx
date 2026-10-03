import type { ComponentType } from "react";
import { createBrowserRouter, Outlet } from "react-router-dom";

import { AnalyticsTracker } from "@/components/layout/analytics-tracker";
import UserLayout from "@/layouts/user-layout";
import CanvasPage from "@/pages/canvas";
import CanvasProjectPage from "@/pages/canvas/project";
import HomePage from "@/pages/home";
import NotFound from "@/pages/not-found";

// 画布和首页是主入口，打在主包里；其余页面第一次访问时才下载。
const lazyPage = (load: () => Promise<{ default: ComponentType }>) => async () => ({ Component: (await load()).default });

export const router = createBrowserRouter([
    {
        element: (
            <UserLayout>
                <AnalyticsTracker />
                <Outlet />
            </UserLayout>
        ),
        // 直接打开按需加载的页面时，下载完成前先显示空白底，不让路由在控制台报没有 HydrateFallback
        HydrateFallback: () => <div className="h-dvh bg-background" />,
        children: [
            { path: "/", element: <HomePage /> },
            { path: "/image", lazy: lazyPage(() => import("@/pages/image")) },
            { path: "/video", lazy: lazyPage(() => import("@/pages/video")) },
            { path: "/assets", lazy: lazyPage(() => import("@/pages/assets")) },
            { path: "/prompts", lazy: lazyPage(() => import("@/pages/prompts")) },
            { path: "/canvas", element: <CanvasPage /> },
            { path: "/canvas/:id", element: <CanvasProjectPage /> },
            { path: "/batch", lazy: lazyPage(() => import("@/pages/batch")) },
            { path: "/voices", lazy: lazyPage(() => import("@/pages/voices")) },
            { path: "/config", lazy: lazyPage(() => import("@/pages/config")) },
        ],
    },
    { path: "*", element: <NotFound /> },
]);
