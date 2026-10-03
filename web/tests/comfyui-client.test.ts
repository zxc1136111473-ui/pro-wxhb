import { afterAll, expect, test } from "bun:test";

// i18n 和配置 store 在导入时读 localStorage，测试环境没有，垫一个最小的
const memory = new Map<string, string>();
Object.assign(globalThis, {
    localStorage: { getItem: (key: string) => memory.get(key) ?? null, setItem: (key: string, value: string) => void memory.set(key, String(value)), removeItem: (key: string) => void memory.delete(key) },
});
const { default: i18n } = await import("../src/i18n");
const { runComfyGraph } = await import("../src/services/api/comfyui");
const { useConfigStore } = await import("../src/stores/use-config-store");

// 本机起一个假的 ComfyUI：校验 Basic 认证，按 mode 返回不同的提交 / 历史结果
let mode: "ok" | "slow" | "pending" | "failed" | "validation" | "badGateway" = "ok";
let expectedAuth = "";
let historyCalls = 0;
const OUTPUTS = { "90": { images: [{ filename: "a.png" }] } };
const history = (entry: unknown) => Response.json({ p: entry });

const server = Bun.serve({
    port: 0,
    fetch(request) {
        const { pathname } = new URL(request.url);
        if (request.headers.get("authorization") !== expectedAuth) return new Response("denied", { status: 401 });
        if (pathname === "/prompt") {
            if (mode === "validation") return Response.json({ error: { message: "Prompt outputs failed validation" }, node_errors: { "2": { errors: [{ message: "Value not in list", details: "voice: 'x' not in ['Cherry']" }] } } }, { status: 400 });
            if (mode === "badGateway") return new Response("<html>bad gateway</html>", { status: 502 });
            return Response.json({ prompt_id: "p" });
        }
        if (pathname === "/history/p") {
            historyCalls++;
            if (mode === "pending" || (mode === "slow" && historyCalls === 1)) return Response.json({});
            if (mode === "failed")
                return history({
                    status: {
                        completed: false,
                        status_str: "error",
                        messages: [
                            ["execution_start", {}],
                            ["execution_error", { exception_message: "boom" }],
                        ],
                    },
                });
            return history({ status: { completed: true, status_str: "success" }, outputs: OUTPUTS });
        }
        return new Response("not found", { status: 404 });
    },
});
afterAll(() => server.stop(true));

const graph = { "2": { class_type: "Any", inputs: {} } };
const auth = (credential: string) => `Basic ${Buffer.from(credential).toString("base64")}`;

/** 只看渠道配置用得到的字段：地址和「账号:密码」 */
function setup(next: typeof mode, { baseUrl = `http://127.0.0.1:${server.port}`, apiKey = "user:pass", accepted = apiKey } = {}) {
    mode = next;
    historyCalls = 0;
    expectedAuth = auth(accepted);
    const { config } = useConfigStore.getState();
    useConfigStore.setState({ config: { ...config, channels: [{ id: "c", name: "comfy", baseUrl, apiKey, apiFormat: "openai", models: [{ name: "comfy-test", capability: "image" }] }] } });
}

const failure = async (promise: Promise<unknown>) =>
    (
        (await promise.then(
            () => undefined,
            (error) => error,
        )) as Error | undefined
    )?.message;

test("提交后轮询到完成，返回各节点的输出", async () => {
    setup("ok");
    expect(await runComfyGraph(graph)).toEqual(OUTPUTS);
});

test("渠道地址末尾的 /v1/ 会去掉，账号密码按 UTF-8 做 Basic 认证", async () => {
    setup("ok", { baseUrl: `http://127.0.0.1:${server.port}/v1/`, apiKey: "账号:密码" });
    expect(await runComfyGraph(graph)).toEqual(OUTPUTS);
});

test("还没完成就继续轮询，直到完成", async () => {
    setup("slow");
    expect(await runComfyGraph(graph)).toEqual(OUTPUTS);
    expect(historyCalls).toBe(2);
}, 10000);

test("一直没完成，超过等待时间就报超时", async () => {
    setup("pending");
    expect(await failure(runComfyGraph(graph, { timeoutMs: -1 }))).toBe(i18n.t("comfyui.timeout"));
});

test("任务在 ComfyUI 里运行失败，抛出它给的原因", async () => {
    setup("failed");
    expect(await failure(runComfyGraph(graph))).toBe("boom");
});

test("工作流校验失败，报错带上 ComfyUI 指出的具体原因", async () => {
    setup("validation");
    expect(await failure(runComfyGraph(graph))).toBe("Prompt outputs failed validation；Value not in list: voice: 'x' not in ['Cherry']");
});

test("账号或密码不对，提示去填「账号:密码」", async () => {
    setup("ok", { apiKey: "user:wrong", accepted: "user:pass" });
    expect(await failure(runComfyGraph(graph))).toBe(i18n.t("comfyui.unauthorized"));
});

test("其它 HTTP 错误带上状态码，不再是 axios 的 status code 502", async () => {
    setup("badGateway");
    expect(await failure(runComfyGraph(graph))).toBe(i18n.t("comfyui.httpError", { status: 502 }));
});

test("连不上服务，提示检查地址和跨域", async () => {
    const closed = Bun.serve({ port: 0, fetch: () => new Response("") });
    const port = closed.port;
    closed.stop(true);
    setup("ok", { baseUrl: `http://127.0.0.1:${port}` });
    expect(await failure(runComfyGraph(graph))).toBe(i18n.t("comfyui.networkError"));
});

test("没有配置 ComfyUI 渠道，提示先去添加", async () => {
    const { config } = useConfigStore.getState();
    useConfigStore.setState({ config: { ...config, channels: [] } });
    expect(await failure(runComfyGraph(graph))).toBe(i18n.t("comfyui.noChannel"));
});
