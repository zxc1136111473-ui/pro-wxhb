#!/usr/bin/env bash
# 本机构建前端，只把成品传到服务器打成镜像并重启容器。
# 适用：不是用 deploy.sh 装的机器，或服务器配置低、不想在上面装依赖打包
# （实测 2 核服务器上整个镜像构建约 9 分钟，本机 vite 构建约 10 秒）。
# 服务器上不需要源码和 git，只要有 docker；本机需要 bun、ssh、tar。
# 新容器 15 秒内没应答 200 会自动换回上一版镜像（infinite-canvas:prev）。
#
# 用法：DEPLOY_HOST=root@服务器地址 bash deploy-remote.sh
# 可选环境变量（都有默认值）：
#   DEPLOY_SSH        ssh 命令，默认 ssh；要额外参数就写进来，如 "ssh -p 2222 -i ~/.ssh/key"
#   DEPLOY_IMAGE      镜像名，默认 infinite-canvas
#   DEPLOY_CONTAINER  容器名，默认 infinite-canvas
#   DEPLOY_PORT       服务器上的端口，默认 3000
#   DEPLOY_BIND       绑定地址，默认 127.0.0.1（前面有 Caddy/nginx 反代）；要直接对外访问写 0.0.0.0
#   DEPLOY_RUN_ARGS   额外的 docker run 参数，如 "-e ANALYTICS_GA4_ID=G-XXXX"（重建容器不会沿用旧的环境变量）
set -euo pipefail
cd "$(dirname "$0")"

HOST="${DEPLOY_HOST:?请先设置 DEPLOY_HOST，如 DEPLOY_HOST=root@1.2.3.4 bash deploy-remote.sh}"
read -r -a SSH <<<"${DEPLOY_SSH:-ssh}"
IMAGE="${DEPLOY_IMAGE:-infinite-canvas}"
CONTAINER="${DEPLOY_CONTAINER:-infinite-canvas}"
PORT="${DEPLOY_PORT:-3000}"
BIND="${DEPLOY_BIND:-127.0.0.1}"
RUN_ARGS="${DEPLOY_RUN_ARGS:-}"

remote() { "${SSH[@]}" "$HOST" "$@"; }

# nginx 的访问日志写在容器标准输出里，不限制会一直涨；和 deploy.sh、服务器上其它容器一致：单个文件 10MB，最多 3 个。
run_container() { # $1 = 镜像 tag
    remote "docker rm -f $CONTAINER >/dev/null 2>&1 || true; docker run -d --name $CONTAINER --restart unless-stopped --log-opt max-size=10m --log-opt max-file=3 -p $BIND:$PORT:3000 $RUN_ARGS $IMAGE:$1 >/dev/null"
}

wait_ok() { # 15 秒内应答 200
    remote "for i in \$(seq 15); do [ \"\$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:$PORT/)\" = 200 ] && exit 0; sleep 1; done; exit 1"
}

echo "==> 本机构建前端"
[ -d web/node_modules ] || (cd web && bun install --frozen-lockfile)
(cd web && bun run build)

echo "==> 传到服务器并构建镜像 $IMAGE:local"
ctx="$(mktemp -d)"
trap 'rm -rf "$ctx"' EXIT
mkdir -p "$ctx/web"
cp -R web/dist "$ctx/web/dist"
cp web/docker-entrypoint.sh "$ctx/web/"
cp nginx.conf Dockerfile.static "$ctx/"
old_prev="$(remote "docker images -q $IMAGE:prev" || true)"
remote "docker tag $IMAGE:local $IMAGE:prev 2>/dev/null || true" # 上一版留作回退
# 用 gzip 压缩的 tar：Docker 靠开头几个字节判断标准输入是不是构建上下文，不压缩时 macOS 的 tar 会被误判成 Dockerfile
COPYFILE_DISABLE=1 tar -C "$ctx" -czf - . | remote "docker build -q -f Dockerfile.static -t $IMAGE:local -"

echo "==> 重建容器 ${CONTAINER}（${BIND}:${PORT}）"
# 旧容器是先删再起的：新容器起不来（端口被占、没有应答 200）都要换回上一版，不能让站点停着
if ! run_container local || ! wait_ok; then
    echo "!! 新容器没有起来或 15 秒内没有应答 200，换回上一版 $IMAGE:prev" >&2
    run_container prev
    exit 1
fi

# 只删被换下来的旧回退镜像，不动服务器上别的镜像
new_prev="$(remote "docker images -q $IMAGE:prev" || true)"
if [ -n "$old_prev" ] && [ "$old_prev" != "$new_prev" ]; then
    remote "docker rmi $old_prev >/dev/null 2>&1 || true"
fi

echo "==> 验证"
js="$(basename "$(ls -S web/dist/assets/*.js | head -1)")" # 最大的文件才是主包；拆包后有几百字节的小块，不到 gzip 的下限，不会压缩
remote "curl -s -D - -o /dev/null -H 'Accept-Encoding: gzip' http://127.0.0.1:$PORT/assets/$js | grep -iE '^(HTTP|content-encoding|cache-control)'"
echo "完成。要回退：在服务器上 docker rm -f ${CONTAINER}，再用 ${IMAGE}:prev 按同样参数 docker run。"
