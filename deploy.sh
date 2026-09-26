#!/usr/bin/env bash
# ============================================================================
# 无限画布 (infinite-canvas) 一键部署脚本（交互式）
#
# 在你的 VPS 上跑这一个脚本，它把「README 的 Docker 部署」那一串手工步骤做完：
#   装 Docker（可选）→ 拉官方镜像 / 本地构建 → 起服务 → 可选 HTTPS → 体检
#
# 用法（在 VPS 上）：
#   curl -fsSL <这个文件的地址> -o deploy.sh && bash deploy.sh
#   或者：git clone 仓库后  bash deploy.sh
#
# ★ 最要紧的一条：无限画布的所有数据（画布、素材、生成记录、API Key）
#   都保存在**浏览器本地**（localStorage / IndexedDB），服务器上没有任何
#   持久数据卷。所以：
#     · 更新 / 重装 / 卸载 都不会丢任何用户数据 —— 用户数据不在服务器上
#     · 重复跑这个脚本不会毁掉任何东西，可以放心
#     · 「备份」= 教用户在浏览器里导出画布，不是备份服务器文件
# ============================================================================
set -euo pipefail

RED=$'\033[31m'; GRN=$'\033[32m'; YLW=$'\033[33m'; BLD=$'\033[1m'; RST=$'\033[0m'
say()  { printf '%s\n' "$*"; }
ok()   { printf '%s✓%s %s\n' "$GRN" "$RST" "$*"; }
warn() { printf '%s!%s %s\n' "$YLW" "$RST" "$*"; }
die()  {
  if [ "${ZFC_JSON:-0}" = "1" ]; then
    printf '{"ok":false,"error":"%s"}\n' "$(printf '%s' "$*" | tr -d '"' | tr '\n' ' ')"
  fi
  printf '%s✗ %s%s\n' "$RED" "$*" "$RST" >&2; exit 1; }
hr()   { printf '%s\n' "------------------------------------------------------------"; }

# ── 非交互 / 机器可读 ──────────────────────────────────────────────────────
# 从 ansible / CI / 别的脚本里调的时候没有终端，read </dev/tty 会永远挂住。
ZFC_YES=0            # 1 = 所有确认自动取肯定值，不问
ZFC_JSON=0           # 1 = 末尾输出一行 JSON，给调用方解析
ZFC_ACTION=""        # install|update|uninstall|check|port|https|analytics|mirror|logs|restart|data|menu
ZFC_DIR=""           # --dir：安装目录（默认 /opt/infinite-canvas）
ZFC_PORT=""          # --port：监听端口（默认 3000）
ZFC_MODE=""          # --mode image|build：官方镜像 或 本地源码构建
ZFC_MIRROR=""        # --mirror <前缀>：ghcr.io 拉不动时用镜像加速前缀
ZFC_DOMAIN=""        # --domain：配 HTTPS 的域名
ZFC_HTTPS_MODE=""    # --https-mode 1|2：直连 A 记录 / 中转 DNS-01
ZFC_GA4=""           # --analytics-ga4 <id>
ZFC_BAIDU=""         # --analytics-baidu <id>
PURGE=0              # --purge：卸载时连目录一起删

json_out() {
  [ "$ZFC_JSON" = "1" ] || return 0
  printf '{"ok":true,"action":"%s","detail":"%s"}\n' "${1:-}" "${2:-}"
}

# 没有终端就自动转非交互 —— 不然 read </dev/tty 会直接挂死
if [ ! -r /dev/tty ]; then ZFC_YES=1; fi

# 「再跑一次这个脚本」的命令怎么写（不能直接用 $0，一句话安装时 $0 是 /dev/fd/*）
SELF_PATH=""
self_cmd() {
  local p="${SELF_PATH:-}"
  if [ -z "$p" ]; then
    case "${BASH_SOURCE[0]:-}" in
      /dev/fd/*|/proc/*|"") : ;;
      *) [ -r "${BASH_SOURCE[0]}" ] && p="${BASH_SOURCE[0]}" ;;
    esac
  fi
  if [ -n "$p" ]; then printf 'bash %s' "$p"
  else printf 'bash %s/deploy.sh' "${APP_DIR:-/opt/infinite-canvas}"; fi
}

ask() {  # ask 变量名 提示 默认值
  local __var="$1" __prompt="$2" __def="${3:-}" __ans
  if [ "${ZFC_YES:-0}" = "1" ]; then
    [ -n "$__def" ] || die "非交互模式下缺少必填项：${__prompt}（用参数或环境变量给出来）"
    printf -v "$__var" '%s' "$__def"; return 0
  fi
  if [ -n "$__def" ]; then printf '%s [%s]: ' "$__prompt" "$__def"; else printf '%s: ' "$__prompt"; fi
  read -r __ans </dev/tty || true
  printf -v "$__var" '%s' "${__ans:-$__def}"
}
askyn() {  # askyn 提示 默认(y/n) —— 返回 0=是
  local __p="$1" __d="${2:-n}" __a
  if [ "${ZFC_YES:-0}" = "1" ]; then return 0; fi
  printf '%s (y/n) [%s]: ' "$__p" "$__d"
  read -r __a </dev/tty || true
  __a="${__a:-$__d}"
  [ "${__a,,}" = "y" ] || [ "${__a,,}" = "yes" ]
}
ask_opt() {  # ask_opt 变量名 提示 默认 —— 和 ask 一样，但允许空默认值（可选字段）
  local __var="$1" __prompt="$2" __def="${3:-}" __ans
  if [ "${ZFC_YES:-0}" = "1" ]; then
    printf -v "$__var" '%s' "$__def"; return 0
  fi
  if [ -n "$__def" ]; then printf '%s [%s]: ' "$__prompt" "$__def"; else printf '%s（留空 = 不开）: ' "$__prompt"; fi
  read -r __ans </dev/tty || true
  printf -v "$__var" '%s' "${__ans:-$__def}"
}

# ── Docker 相关 ────────────────────────────────────────────────────────────
SUDO=""
[ "$(id -u)" -eq 0 ] || SUDO="sudo"
DOCKER=""
docker_ok() {
  if command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1; then
    DOCKER="docker"
  elif $SUDO docker info >/dev/null 2>&1; then
    DOCKER="$SUDO docker"
  else
    return 1
  fi
  return 0
}
DCOMPOSE=""   # docker compose 子命令（compose v2 内置于 docker）
compose_ok() {
  if $DOCKER compose version >/dev/null 2>&1; then
    DCOMPOSE="compose"
  elif command -v docker-compose >/dev/null 2>&1; then
    DCOMPOSE=""
  else
    return 1
  fi
  return 0
}

install_docker() {
  say "正在装 Docker（系统包管理器，不添第三方源）…"
  if [ -f /etc/debian_version ]; then
    $SUDO apt-get update -y >/dev/null 2>&1 || true
    $SUDO apt-get install -y docker.io docker-compose-v2 >/dev/null 2>&1 \
      || $SUDO apt-get install -y docker.io >/dev/null 2>&1 \
      || die "apt 装 Docker 失败。手动装：https://docs.docker.com/engine/install/"
  elif [ -f /etc/redhat-release ] || [ -f /etc/centos-release ]; then
    $SUDO yum install -y docker >/dev/null 2>&1 \
      || $SUDO dnf install -y docker >/dev/null 2>&1 \
      || die "yum/dnf 装 Docker 失败。手动装：https://docs.docker.com/engine/install/"
  else
    die "认不出这个发行版，请手动装 Docker：https://docs.docker.com/engine/install/"
  fi
  $SUDO systemctl enable --now docker >/dev/null 2>&1 || true
  sleep 2
  docker_ok || die "Docker 装上了但起不来（docker info 失败）。看看：$SUDO systemctl status docker"
  ok "Docker 装好了：$($DOCKER --version)"
}

port_busy() {
  local p="$1"
  if command -v ss >/dev/null 2>&1; then
    grep -qE "[:.]${p}\$" <<<"$(ss -ltn 2>/dev/null | awk '{print $4}' || true)" && return 0
  elif command -v netstat >/dev/null 2>&1; then
    netstat -ltn 2>/dev/null | grep -qE "[:.]${p}[[:space:]]" && return 0
  fi
  return 1
}
port_check() {
  local p="$1"
  [[ "$p" =~ ^[0-9]+$ ]] || die "端口要是数字（你填的是 $p）"
  [ "$p" -ge 1 ] && [ "$p" -le 65535 ] || die "端口要在 1~65535 之间（你填的是 $p）"
  if [ "$p" -lt 1024 ] && [ "$(id -u)" -ne 0 ]; then
    warn "$p 是特权端口（<1024），普通用户绑不上"
  fi
  return 0
}

# ── 安装状态文件 ───────────────────────────────────────────────────────────
# 记录装在哪、什么端口、什么模式，菜单据此识别「已装过」并读回配置。
STATE_FILE=""
state_load() { STATE_FILE="$APP_DIR/.install.conf"; }
state_read() {  # state_read 键 默认
  local k="$1" d="${2:-}"
  [ -f "$STATE_FILE" ] || { printf '%s' "$d"; return; }
  # 文件在但缺这个键时 sed 也返回 0，不能靠 || 给默认值
  local v
  v="$(sed -n "s/^$k=//p" "$STATE_FILE" | tail -1 | sed 's/^"//;s/"$//')"
  printf '%s' "${v:-$d}"
}
state_write() {  # state_write 键 值
  local k="$1" v="$2"
  [ -f "$STATE_FILE" ] || touch "$STATE_FILE"
  if grep -q "^$k=" "$STATE_FILE" 2>/dev/null; then
    sed -i.bak "s|^$k=.*|$k=\"$v\"|" "$STATE_FILE" && rm -f "$STATE_FILE.bak"
  else
    printf '%s="%s"\n' "$k" "$v" >> "$STATE_FILE"
  fi
}

# ── 容器管理 ───────────────────────────────────────────────────────────────
CONTAINER="infinite-canvas"
# 共享机上占着 80/443 的香水商城 Caddy 容器，及它访问宿主机用的网关地址（和 comfyui-deploy 一致）
CADDY_CONTAINER="perfume-shop-caddy-1"
CADDY_GW="172.18.0.1"
PROBE_TIMEOUT=5      # 共享 Caddy 自检的探测超时（秒），只提示不改动
LOG_MAX_SIZE="10m"   # 容器日志轮转：单个文件上限 ×
LOG_MAX_FILE=3       #               文件数（最多 30MB，只作用于本容器，不改 daemon.json）
# 本地构建模式没有源码时 clone 的仓库：本仓库（fork），带着本仓库的改动；官方镜像里没有这些改动
CANVAS_GIT="https://github.com/zxc1136111473-ui/pro-wxhb.git"
# 一条命令重建容器：读状态文件里的 port/mode/mirror/analytics，全量重起。
run_container() {
  docker_ok || die "Docker 没就绪。先装：$(self_cmd) 里选「装 Docker」，或 apt install docker.io"
  local port mode mirror ga4 baidu
  port="$(state_read port 3000)"
  mode="$(state_read mode image)"
  mirror="$(state_read mirror '')"
  ga4="$(state_read analytics_ga4 '')"
  baidu="$(state_read analytics_baidu '')"

  # 先备好镜像再删旧容器 —— 构建/拉取失败时旧服务不停
  # ZFC_NO_PULL=1（改端口 / 改统计 / 重启兜底）：本地已有镜像就直接用，不重新拉取或构建，
  #   免得 image 模式每次悄悄升级到上游 latest、ghcr.io 拉不动时连改端口都失败
  local img=""
  if [ "$mode" = "build" ]; then
    img="infinite-canvas:local"
    if [ "${ZFC_NO_PULL:-0}" = "1" ] && $DOCKER image inspect "$img" >/dev/null 2>&1; then
      say "用已有镜像 ${img}（不重建）"
    else
      # 本地构建：从仓库源码构建（不依赖 ghcr.io）
      [ -f "$APP_DIR/Dockerfile" ] || die "本地构建需要源码在 ${APP_DIR}（有 Dockerfile 吗？没有就先 clone 仓库过来）"
      say "本地构建镜像（用仓库里的 Dockerfile）…"
      # 构建失败时旧容器还没删，服务照旧；ZFC_ON_BUILD_FAIL（更新时）负责把源码退回
      $DOCKER build -t "$img" "$APP_DIR" \
        || { [ -z "${ZFC_ON_BUILD_FAIL:-}" ] || "$ZFC_ON_BUILD_FAIL"; die "构建失败。看上面的报错；也可能是网络拉不动 oven/bun 基础镜像"; }
    fi
  else
    local base="ghcr.io/basketikun/infinite-canvas"
    [ -n "$mirror" ] && base="$mirror"
    img="$base:latest"
    if [ "${ZFC_NO_PULL:-0}" = "1" ] && $DOCKER image inspect "$img" >/dev/null 2>&1; then
      say "用已有镜像 ${img}（不重新拉取）"
    else
      say "拉取官方镜像 $img …"
      $DOCKER pull "$img" >/dev/null 2>&1 \
        || die "拉镜像失败：${img}（ghcr.io 在国内经常拉不动，菜单里选 7 换镜像来源，或选 1 时用本地构建模式）"
    fi
  fi

  # 镜像就绪，才停旧容器
  $DOCKER rm -f "$CONTAINER" >/dev/null 2>&1 || true

  local envs=()
  [ -n "$ga4" ]   && envs+=( -e "ANALYTICS_GA4_ID=$ga4" )
  [ -n "$baidu" ] && envs+=( -e "ANALYTICS_BAIDU_ID=$baidu" )

  # nginx 的访问日志走 stdout：公网站点不轮转会一直涨，同机还有别的项目
  $DOCKER run -d --name "$CONTAINER" --restart unless-stopped \
    --log-driver json-file --log-opt max-size="$LOG_MAX_SIZE" --log-opt max-file="$LOG_MAX_FILE" \
    -p "$port:3000" ${envs[@]+"${envs[@]}"} "$img" >/dev/null \
    || die "容器起不来。看上面报错（端口被占？用菜单 4 换端口）"

  # 等它就绪（nginx 起来 + HTTP 200）
  local tries=0
  while [ $tries -lt 15 ]; do
    if curl -fsS -o /dev/null --max-time 3 "http://127.0.0.1:$port/" 2>/dev/null; then
      ok "服务就绪：http://127.0.0.1:$port/（镜像 $img）"
      json_out "install" "port=$port mode=$mode"
      return 0
    fi
    tries=$((tries + 1)); sleep 1
  done
  warn "容器起了但 15 秒内没等到 HTTP 200 —— 看看日志：$(self_cmd) 里选 l"
  json_out "install" "port=$port mode=$mode (slow-start)"
  return 0
}

ask_secret() {  # ask_secret 变量名 提示 —— 和 ask 一样，但不回显
  local __var="$1" __prompt="$2" __ans
  if [ "${ZFC_YES:-0}" = "1" ]; then
    die "非交互模式下缺少必填项：${__prompt}（用参数传进来）"
  fi
  printf '%s: ' "$__prompt"
  read -r -s __ans </dev/tty || true
  printf '\n'
  printf -v "$__var" '%s' "$__ans"
}

# ── 统计开关 ───────────────────────────────────────────────────────────────
do_analytics() {
  docker_ok || die "Docker 没就绪"
  say ""
  say "  ${BLD}统计开关${RST} —— 现在：GA4=$(state_read analytics_ga4 无) · 百度=$(state_read analytics_baidu 无)"
  say "  留空 = 关。只填一个也行。改完自动重启容器。"
  ask_opt GA4 "GA4 衡量 ID" "$(state_read analytics_ga4 '')"
  ask_opt BAIDU "百度统计 ID" "$(state_read analytics_baidu '')"
  state_write analytics_ga4 "$GA4"
  state_write analytics_baidu "$BAIDU"
  ZFC_NO_PULL=1 run_container
  ok "统计设置已生效"
  json_out "analytics" "ga4=$GA4 baidu=$BAIDU"
}

# ── 换镜像来源 ─────────────────────────────────────────────────────────────
do_mirror() {
  docker_ok || die "Docker 没就绪"
  say ""
  say "  ${BLD}镜像来源${RST} —— 现在：$(state_read mode image)（前缀：$(state_read mirror 无)）"
  say ""
  say "  1) 官方镜像 ghcr.io/basketikun/infinite-canvas"
  say "  2) 加速镜像前缀（ghcr.io 拉不动时，填比如 ghcr.nju.edu.cn / ghcr.m.daocloud.io）"
  say "  3) 本地源码构建（不依赖 ghcr.io，用仓库 Dockerfile 构建）"
  ask M2 "选哪个" "1"
  case "$M2" in
    2) ask MP "镜像前缀（如 ghcr.nju.edu.cn）" ""
       [ -n "$MP" ] || die "没给前缀"
       state_write mode "image"; state_write mirror "$MP" ;;
    3) state_write mode "build"; state_write mirror "" ;;
    *) state_write mode "image"; state_write mirror "" ;;
  esac
  run_container
  ok "镜像来源已切换"
  json_out "mirror" "mode=$(state_read mode) mirror=$(state_read mirror)"
}

# ── HTTPS：共享机（80/443 已被别的程序占着）──────────────────────────────────
# 不装系统 Caddy：apt 装的 caddy 默认开机自启，服务器一重启就和占着 80/443 的程序（香水商城的
# Caddy 容器）抢端口，挂在那边的站点会全掉线。改为打印站点片段贴到那边，脚本不改别人的 Caddyfile。
https_shared() {
  local domain="$1" port="$2" code
  warn "80/443 已被别的程序占着 —— 不装系统 Caddy（装了会开机自启，重启时和它抢端口）"
  if [ -z "$($DOCKER ps -q --filter "name=^${CADDY_CONTAINER}\$" 2>/dev/null || true)" ]; then
    say "  请在占着 80/443 的那个程序里加反代：$domain → 本机 $port 端口"
    return 0
  fi
  say ""
  say "  在香水商城的 Caddyfile 里追加（纯静态站，不用加密码）："
  say ""
  say "    $domain {"
  say "        reverse_proxy $CADDY_GW:$port"
  say "    }"
  say ""
  say "  然后热加载（注意是容器里的 Caddy）："
  say "    docker exec $CADDY_CONTAINER caddy reload --config /etc/caddy/Caddyfile"
  say ""
  # 只读自检：Caddy 容器能不能经网关访问到画布
  if $DOCKER exec "$CADDY_CONTAINER" wget -q -O /dev/null -T "$PROBE_TIMEOUT" "http://$CADDY_GW:$port/" >/dev/null 2>&1; then
    ok "Caddy 容器能访问 $CADDY_GW:$port"
  else
    warn "Caddy 容器访问不到 $CADDY_GW:${port}（容器没跑 / 防火墙挡了容器网段 / 容器里没有 wget）"
  fi
  if askyn "已经贴好并 reload？现在测一下域名" "n"; then
    code="$(curl -s -o /dev/null -w '%{http_code}' --max-time "$PROBE_TIMEOUT" \
      --resolve "$domain:443:127.0.0.1" "https://$domain/" 2>/dev/null || true)"
    if [ "$code" = "200" ]; then
      ok "HTTPS 通了：https://$domain/"; state_write domain "$domain"
    else
      warn "域名返回 ${code:-连不上}（没 reload / 站点没生效 / 证书还没签好，稍等再测）"
    fi
  fi
  if systemctl is-enabled --quiet caddy 2>/dev/null; then
    warn "这台机器还装着系统 Caddy 且开机自启：重启时可能和 $CADDY_CONTAINER 抢 80/443"
    say "  要停用：sudo systemctl disable --now caddy（会不会影响别的站点，你来确认）"
  fi
}

# ── HTTPS（Caddy 反代 + 自动证书）──────────────────────────────────────────
# 无限画布是纯静态站，套一层 Caddy 反代到本地端口即可自动申请/续期证书。
# 直连（A 记录指本机）走 HTTP-01；走中转/大陆前置的走 DNS-01（要 CF token）。
https_wizard() {
  docker_ok || die "Docker 没就绪，先装好再说 HTTPS"
  local port domain mode
  port="$(state_read port 3000)"
  say ""
  say "  ${BLD}配 HTTPS${RST} —— 填你的域名，自动申请证书并续期。"
  say "  前提：域名已经解析到这台机器（或中转入口）。"
  if [ -n "$ZFC_DOMAIN" ]; then domain="$ZFC_DOMAIN"; else ask domain "域名（比如 canvas.example.com）" ""; fi
  [ -n "$domain" ] || die "没给域名，不配了"
  # 共享机：80/443 被别的程序占着、系统 Caddy 又没在跑 → 不装系统 Caddy，走共享片段
  if { port_busy 443 || port_busy 80; } && ! systemctl is-active --quiet caddy 2>/dev/null; then
    https_shared "$domain" "$port"
    json_out "https" "domain=$domain shared"
    return 0
  fi
  if [ -n "$ZFC_HTTPS_MODE" ]; then mode="$ZFC_HTTPS_MODE"; else
    say ""
    say "  ${BLD}1) 不加中转${RST}：域名 A 记录直接指这台机器，80/443 都通"
    say "  ${BLD}2) 加中转 / 大陆前置${RST}：域名指到中转入口，80 过不了备案墙，用 DNS 验证"
    ask mode "怎么解析" "1"
  fi

  # Caddy 有没有
  if ! command -v caddy >/dev/null 2>&1; then
    if askyn "装 Caddy（apt 官方源，反代 + 自动证书就靠它）" "y"; then
      if [ -f /etc/debian_version ]; then
        $SUDO apt-get install -y debian-keyring debian-archive-keyring apt-transport-https curl >/dev/null 2>&1 || true
        curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | $SUDO gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg 2>/dev/null || true
        curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | $SUDO tee /etc/apt/sources.list.d/caddy-stable.list >/dev/null 2>&1 || true
        $SUDO apt-get update -y >/dev/null 2>&1 || true
        $SUDO apt-get install -y caddy >/dev/null 2>&1 || die "装 Caddy 失败"
      else
        die "这个发行版装 Caddy 麻烦，手动装：https://caddyserver.com/docs/install"
      fi
    else
      die "那就先不配 HTTPS —— 随时回菜单选 5 再配"
    fi
  fi
  ok "Caddy 就绪：$(caddy version 2>/dev/null | head -1)"

  local caddyfile="/etc/caddy/Caddyfile"
  local block=""
  if [ "$mode" = "2" ]; then
    local cftok=""
    ask_secret cftok "Cloudflare API token（DNS 验证用，不会回显）"
    [ -n "$cftok" ] || die "没有 CF token 没法做 DNS 验证。去 Cloudflare → My Profile → API Tokens 建一个 Zone:DNS:Edit"
    block="$domain {
  reverse_proxy 127.0.0.1:$port
  tls {
    dns cloudflare $cftok
  }
}"
  else
    block="$domain {
  reverse_proxy 127.0.0.1:$port
}"
  fi

  # 只改我们管的这段：用 marker 包起来，重复跑不叠。
  # marker 行本身也要原样保留（print），否则第二次替换时匹配不到开始标记。
  if [ -f "$caddyfile" ] && grep -q "# zfc-infinite-canvas" "$caddyfile"; then
    $SUDO awk -v b="$block" '
      /# zfc-infinite-canvas/ {p=1}
      p==0 {print}
      p==1 && /# \/zfc-infinite-canvas/ {print b; print; p=0}
    ' "$caddyfile" > /tmp/caddyfile.new
    $SUDO mv /tmp/caddyfile.new "$caddyfile"
  else
    printf '\n# zfc-infinite-canvas\n%s\n# /zfc-infinite-canvas\n' "$block" | $SUDO tee -a "$caddyfile" >/dev/null
  fi

  # 让 Caddy 加载新配置。★ 用 restart 而不是 reload：caddy 的 systemd unit
  # 很多发行版没配 ExecReload，reload 会静默失败（"Unit cannot be reloaded"），
  # 配置就永远不生效。restart 一定重新读配置。失败必须报出来，不许吞。
  if ! $SUDO systemctl restart caddy 2>/dev/null; then
    # systemd 起不来时退回直接跑 caddy（前台验证，错误可见）
    if ! $SUDO caddy start --config "$caddyfile" 2>/tmp/zfc-caddy.err; then
      warn "Caddy 起不来："; $SUDO cat /tmp/zfc-caddy.err 2>/dev/null | tail -10 || true
      die "Caddy 配置没生效，先把上面的报错解决（多半是 Caddyfile 或端口占用）"
    fi
  fi
  sleep 3

  # 等证书签发（Let's Encrypt 一般十几秒，最多等 90 秒）
  local tries=0
  while [ $tries -lt 30 ]; do
    if curl -fsS -o /dev/null --max-time 8 "https://$domain/" 2>/dev/null; then
      break
    fi
    tries=$((tries + 1)); sleep 3
  done

  # 验一下
  if curl -fsS -o /dev/null --max-time 15 "https://$domain/" 2>/dev/null; then
    ok "HTTPS 通了：https://$domain/"
    state_write domain "$domain"
  else
    warn "https://$domain/ 还没通。证书申请一般十几秒，等一会儿再试；"
    warn "DNS 没解析好 / 中转没转发 / 80 没放开都会这样。Caddy 日志：journalctl -u caddy -n 30"
  fi
  json_out "https" "domain=$domain"
}

# ── 体检 ───────────────────────────────────────────────────────────────────
do_check() {
  docker_ok || { warn "Docker 没就绪"; return 1; }
  local port domain
  port="$(state_read port 3000)"
  domain="$(state_read domain '')"
  say ""
  say "  容器："
  $DOCKER ps --filter "name=$CONTAINER" --format '    {{.Names}}  {{.Status}}  {{.Ports}}' || true
  local running=""
  running="$($DOCKER ps -q --filter "name=$CONTAINER" 2>/dev/null || true)"
  if [ -n "$running" ]; then
    say "  镜像：$($DOCKER inspect "$CONTAINER" --format '{{.Config.Image}}' 2>/dev/null || echo '?')"
    [ "$(state_read mode image)" = "build" ] \
      || say "  （官方镜像模式：不含本仓库的改动；要用本仓库的改动，菜单 7 → 3 改成本地构建）"
    say "  版本：$(curl -fsS --max-time 5 "http://127.0.0.1:$port/" 2>/dev/null | grep -oE 'infinite-canvas|无限画布' | head -1 || echo '（页面未含版本标识）')"
  fi
  say ""
  say "  访问地址："
  local ips=""
  ips="$(hostname -I 2>/dev/null | awk '{print $1}')"
  [ -z "$ips" ] && ips="$(ip -4 addr show 2>/dev/null | grep -oE 'inet [0-9.]+' | awk '{print $2}' | grep -v '^127\.' | head -1)"
  say "    http://${ips:-<本机IP>}:$port/"
  [ -n "$domain" ] && say "    https://$domain/"
  [ -z "$domain" ] && say "    （还没配 HTTPS，菜单选 5 补上）"
  say ""
  say "  状态检查："
  if [ -n "$running" ]; then
    if curl -fsS -o /dev/null --max-time 5 "http://127.0.0.1:$port/" 2>/dev/null; then
      ok "HTTP 200 —— 服务正常"
    else
      warn "容器在跑但页面没响应 —— 菜单选 l 看日志"
    fi
  else
    warn "容器没在跑 —— 菜单选 2 部署/更新"
  fi
  json_out "check" "port=$port domain=$domain running=$([ -n "$running" ] && echo yes || echo no)"
}

# ── 数据说明 ───────────────────────────────────────────────────────────────
do_data_info() {
  say ""
  say "  ${BLD}数据都在哪里？${RST}"
  say "  无限画布的【画布项目、素材、生成记录、API Key、Base URL】"
  say "  全部保存在访问它的那个【浏览器】里（localStorage / IndexedDB）。"
  say "  ${BLD}服务器上没有任何持久数据卷${RST} —— 这是它和一般服务最大的区别。"
  say ""
  say "  所以："
  say "  · ${GRN}更新 / 重装 / 卸载${RST} 都不会丢任何人的数据（数据不在服务器上）"
  say "  · ${YLW}换浏览器 / 换电脑${RST} 等于换了个空画布 —— 需要在旧浏览器里导出"
  say ""
  say "  ${BLD}用户怎么备份 / 迁移：${RST}"
  say "  1) 在画布页里，把要留的项目【导出】成文件（画布节点 → 导出）"
  say "  2) 新浏览器里打开同一个地址，【导入】这个文件即可"
  say "  3) 提示词库、API Key 等配置在右上角设置里手动重填"
  say ""
  say "  想让多台电脑共用同一份数据：右上角「配置」→「WebDAV 同步」，填你自己的 WebDAV 服务"
  say "  （同步画布、我的资产、生成记录和本地媒体，不含 API Key；WebDAV 服务要自备）。"
}

# ── 更新 ───────────────────────────────────────────────────────────────────
# 本地构建模式：先 git pull 本仓库（失败就停，不动容器），构建失败把源码退回原来的 commit；
# 官方镜像模式：拉上游最新镜像（不含本仓库的改动）
UPD_OLD=""
update_build_failed() {
  [ -n "$UPD_OLD" ] || return 0
  warn "构建失败，把源码退回更新前的版本 …"
  git -C "$APP_DIR" reset -q --keep "$UPD_OLD" 2>/dev/null \
    || warn "  退回失败（本地改动冲突？进 $APP_DIR 看 git status）"
  say "  旧容器没动，服务仍是更新前的版本"
  return 0
}
do_update() {
  local mode out new
  mode="$(state_read mode image)"
  UPD_OLD=""
  if [ "$mode" = "build" ] && [ -d "$APP_DIR/.git" ]; then
    UPD_OLD="$(git -C "$APP_DIR" rev-parse HEAD 2>/dev/null || true)"
    say "拉取本仓库源码（git pull）…"
    if ! out="$(git -C "$APP_DIR" pull --ff-only 2>&1)"; then
      printf '%s\n' "$out" | sed 's/^/    /'
      die "源码没更新成功（原因见上），容器没动"
    fi
    printf '%s\n' "$out" | tail -2
  elif [ "$mode" = "build" ]; then
    warn "$APP_DIR 不是 git 仓库，拉不了新代码：只按现有源码重建"
  else
    say "  官方镜像模式：拉的是上游最新镜像，不含本仓库的改动（要用本仓库的改动：菜单 7 → 3 本地构建）"
  fi
  say "更新到最新版 —— 拉新镜像 / 重建，重启容器。用户浏览器里的数据不受影响。"
  ZFC_ON_BUILD_FAIL=update_build_failed run_container
  new="$(git -C "$APP_DIR" rev-parse HEAD 2>/dev/null || true)"
  if [ -n "$UPD_OLD" ] && [ "$new" != "$UPD_OLD" ]; then
    say "  源码：${UPD_OLD:0:7} → ${new:0:7}（VERSION $(cat "$APP_DIR/VERSION" 2>/dev/null || echo '?')）"
    git -C "$APP_DIR" diff --quiet "$UPD_OLD" "$new" -- comfyui-deploy/ \
      || warn "ComfyUI 部署套件（comfyui-deploy/）也有变化：去那边跑菜单 2 更新，或菜单 1 只重建镜像"
  fi
  ok "更新完成"
}

# ── 卸载 ───────────────────────────────────────────────────────────────────
do_uninstall() {
  docker_ok || { warn "Docker 都没就绪，没什么可卸的"; return 0; }
  local wipe="${1:-0}"
  say ""
  if [ "$wipe" = "1" ]; then
    say "  ${RED}卸载并删掉安装目录${RST}（$APP_DIR）。"
  else
    say "  卸载：停容器，保留安装目录和状态文件。"
  fi
  askyn "确认卸载？（服务停掉后这个地址就打不开了）" "n" || { say "取消"; return 0; }
  $DOCKER rm -f "$CONTAINER" >/dev/null 2>&1 || true
  ok "容器已删除"
  if [ "$wipe" = "1" ]; then
    rm -rf "$APP_DIR"
    ok "安装目录已删除：$APP_DIR"
  else
    say "安装目录保留：$APP_DIR（以后想再起，回这里跑 deploy.sh 选 1）"
  fi
  json_out "uninstall" "wipe=$wipe"
}

# ── 主流程 ─────────────────────────────────────────────────────────────────
# 参数解析
while [ $# -gt 0 ]; do
  case "$1" in
    --install)        ZFC_ACTION="install" ;;
    --update)         ZFC_ACTION="update" ;;
    --uninstall)      ZFC_ACTION="uninstall" ;;
    --purge)          PURGE=1 ;;
    --check)          ZFC_ACTION="check" ;;
    --port)           ZFC_PORT="${2:?--port 后面要给个端口}"; shift ;;
    --dir)            ZFC_DIR="${2:?--dir 后面要给个目录}"; shift ;;
    --mode)           ZFC_MODE="${2:?--mode 后面要 image 或 build}"; shift ;;
    --mirror)         ZFC_MIRROR="${2:?--mirror 后面要给镜像前缀}"; shift ;;
    --domain)         ZFC_DOMAIN="${2:?--domain 后面要给域名}"; shift ;;
    --https-mode)     ZFC_HTTPS_MODE="${2:?--https-mode 后面要 1 或 2}"; shift ;;
    --analytics-ga4)  ZFC_GA4="${2:?--analytics-ga4 后面要给 ID}"; shift ;;
    --analytics-baidu) ZFC_BAIDU="${2:?--analytics-baidu 后面要给 ID}"; shift ;;
    -y)               ZFC_YES=1 ;;
    --json)           ZFC_JSON=1 ;;
    --menu)           ZFC_ACTION="menu" ;;
    -h|--help)
      say "用法: $(self_cmd) [动作] [选项]"
      say ""
      say "动作："
      say "  （不带参数）        交互菜单"
      say "  --install           全新安装 / 重新部署"
      say "  --update            更新到最新版（重新拉镜像/重建）"
      say "  --check             体检 + 看访问地址"
      say "  --uninstall         卸载（加 --purge 连目录一起删）"
      say "  --port <n>          换监听端口"
      say "  --domain <域名>     配 HTTPS"
      say "  --menu              强制进菜单"
      say ""
      say "安装选项："
      say "  --dir <目录>        安装目录（默认 /opt/infinite-canvas）"
      say "  --port <n>          监听端口（默认 3000）"
      say "  --mode image|build  官方镜像 / 本地源码构建（默认 image）"
      say "  --mirror <前缀>     ghcr.io 拉不动时用镜像加速前缀"
      say "  --analytics-ga4 <id>   开启 GA4 统计"
      say "  --analytics-baidu <id> 开启百度统计"
      say "  -y                  所有确认自动取肯定值（非交互）"
      say "  --json              末尾输出一行 JSON"
      exit 0 ;;
    -*) die "不认识的参数：$1（--help 看用法）" ;;
    *)  die "多余的参数：$1（--help 看用法）" ;;
  esac
  shift
done

# 安装目录（状态文件所在处）
if [ -n "$ZFC_DIR" ]; then
  APP_DIR="$ZFC_DIR"
else
  # 脚本自己就躺在仓库里 → 默认装在原地
  case "${BASH_SOURCE[0]:-}" in
    /dev/fd/*|/proc/*|"") APP_DIR="/opt/infinite-canvas" ;;
    *) APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" 2>/dev/null && pwd -P || echo /opt/infinite-canvas)" ;;
  esac
fi
[ -f "$APP_DIR/deploy.sh" ] && SELF_PATH="$APP_DIR/deploy.sh"
state_load

say "${BLD}无限画布 部署脚本${RST}"
hr

# ── 显式动作：不弹菜单，直接执行 ───────────────────────────────────────────
# uninstall / check / update 直接跑完退出；port/domain 仅作安装预设，不触发独立动作。
if [ "$ZFC_ACTION" = "uninstall" ]; then
  do_uninstall "$PURGE"; exit 0
fi
if [ "$ZFC_ACTION" = "check" ]; then
  do_check && exit 0 || exit $?
fi
# --update 非交互（--install -y 同理）→ 直接走更新/安装流程，不弹菜单。
# --update 已装时等效「重新拉镜像重建」。
if [ "$ZFC_ACTION" = "update" ]; then
  if ! docker_ok || [ "$($DOCKER ps -aq --filter "name=$CONTAINER" 2>/dev/null | wc -l | tr -d ' ')" -lt 1 ]; then
    die "没有找到容器 $CONTAINER —— 先全新安装，而不是更新"
  fi
  do_update
  exit 0
fi

# ── 已装过的话，先问一句要干什么 ───────────────────────────────────────────
INSTALLED=0
docker_ok && [ "$($DOCKER ps -aq --filter "name=$CONTAINER" 2>/dev/null | wc -l | tr -d ' ')" -ge 1 ] && INSTALLED=1

if [ "$INSTALLED" = "1" ] && [ "$ZFC_ACTION" != "install" ]; then
  say "这台机器上${BLD}已经装过${RST}了（容器 $CONTAINER，端口 $(state_read port 3000)）"
  say ""
  say "  1) ${BLD}全新安装${RST} / 重新部署（容器只有一个，换目录会替换现有这套）"
  say "  2) ${BLD}更新到最新版${RST}（本地构建先 git pull 再重建 / 官方镜像重新拉 —— 浏览器里的数据不受影响）"
  say "  3) 体检 + 看访问地址"
  say "  4) 改监听端口"
  say "  5) ${BLD}配 HTTPS${RST}（填域名，自动申请并续期证书）"
  say "  6) 开 / 关统计（GA4 / 百度统计）"
  say "  7) 换镜像来源（ghcr.io 拉不动时：本地构建 / 加速镜像）"
  say "  8) 数据说明（数据都在浏览器，怎么备份迁移）"
  say "  9) ${RED}卸载${RST}"
  say "  l) 看容器日志"
  say "  r) 重启容器（docker restart，不重新拉镜像）"
  say "  0) 退出"
  ask WHAT "选一个" "1"
  case "$WHAT" in
    1) : ;;  # 往下走部署流程
    2) ZFC_ACTION="update" ;;
    3) do_check; exit 0 ;;
    4) ask NP "改成哪个端口" "$(state_read port 3000)"
       port_check "$NP"
       port_busy "$NP" && die "端口 $NP 被别的进程占着"
       state_write port "$NP"
       ZFC_NO_PULL=1 run_container
       ok "端口已改为 $NP"
       [ -z "$(state_read domain '')" ] \
         || warn "域名的反代还指着旧端口：菜单 5 重新配一次（共享 Caddy 要手动把 Caddyfile 里的端口改成 $NP 并 reload）"
       exit 0 ;;
    5) https_wizard; exit 0 ;;
    6) do_analytics; exit 0 ;;
    7) do_mirror; exit 0 ;;
    8) do_data_info; exit 0 ;;
    9) say ""
       say "  a) 卸载但${GRN}保留目录${RST}（容器停掉，目录和状态文件留着）"
       say "  b) 卸载并${RED}删掉整个目录${RST}（源码/状态全没了）"
       ask UW "选一个" "a"
       do_uninstall "$([ "$UW" = "b" ] && echo 1 || echo 0)"; exit 0 ;;
    l|L) $DOCKER logs --tail 50 "$CONTAINER" 2>&1 || true; exit 0 ;;
    r|R) if $DOCKER restart "$CONTAINER" >/dev/null 2>&1; then ok "已重启"; else ZFC_NO_PULL=1 run_container; fi
         exit 0 ;;
    0) exit 0 ;;
    *) hr ;;   # 随手回车 → 往下走部署流程
  esac
fi

# ── 更新（菜单选 2 / 非交互 --update） ───────────────────────────────────
if [ "$ZFC_ACTION" = "update" ]; then
  INSTALLED=1
fi

if [ "$INSTALLED" = "1" ] && [ "$ZFC_ACTION" = "update" ]; then
  do_update
  exit 0
fi

# 没装过的机器 / 选了全新安装
if [ "$INSTALLED" = "0" ] && [ "$ZFC_ACTION" != "install" ]; then
  say "这台机器上${BLD}还没装过${RST} —— 下面开始${BLD}全新安装${RST}，问几个问题就好。"
  say "（想直接一条命令装完：${BLD}$(self_cmd) --install -y --port 3000${RST}，看 --help 有哪些参数）"
  hr
fi

# ── 0. 前置：Docker ────────────────────────────────────────────────────────
if ! docker_ok; then
  warn "这台机器上没有可用的 Docker"
  if askyn "现在自动装一个（系统包管理器，不添第三方源）" "y"; then
    install_docker
  else
    die "那就先自己装 Docker 再来：https://docs.docker.com/engine/install/"
  fi
fi
compose_ok || true
ok "Docker 就绪"

say "  这台机器： $(uname -s) $(uname -r 2>/dev/null) · $(uname -m) · $($DOCKER --version 2>/dev/null | sed 's/Docker version //')"

# ── 1. 问清楚装哪、什么端口、什么模式 ──────────────────────────────────────
if [ -n "$ZFC_DIR" ]; then
  INSTALL_DIR="$ZFC_DIR"
else
  ask INSTALL_DIR "装到哪个目录" "$APP_DIR"
fi
mkdir -p "$INSTALL_DIR"
INSTALL_DIR="$(cd "$INSTALL_DIR" && pwd -P)"
# 容器名只有一个（$CONTAINER）：已经装过又换了目录，等于停掉并替换现有这套，不是「再装一套」
if [ "$INSTALLED" = "1" ] && [ "$INSTALL_DIR" != "$(cd "$APP_DIR" 2>/dev/null && pwd -P || printf '%s' "$APP_DIR")" ]; then
  warn "这台机器上已经有一套在跑（${APP_DIR}）。装到 $INSTALL_DIR 会停掉并替换它，原来的端口也会失效"
  askyn "确定替换？" "n" || { say "取消"; exit 1; }
fi
APP_DIR="$INSTALL_DIR"
state_load

if [ -n "$ZFC_PORT" ]; then PORT="$ZFC_PORT"; else PORT="$(state_read port 3000)"; fi
ask PORT "服务监听端口" "$PORT"
port_check "$PORT"
# 自家容器占着同一个端口（重新部署这一套）不算冲突，run_container 会先删旧容器
if [ "$INSTALLED" = "0" ] || [ "$PORT" != "$(state_read port '')" ]; then
  port_busy "$PORT" && die "端口 $PORT 被别的进程占着（换一个，或先停掉占用的进程）"
fi

if [ -n "$ZFC_MODE" ]; then MODE="$ZFC_MODE"; else MODE="$(state_read mode image)"; fi
say ""
say "  镜像来源："
say "  1) ${BLD}官方镜像${RST}（ghcr.io/basketikun/infinite-canvas:latest —— 最快，但国内常拉不动）"
say "  2) ${BLD}本地源码构建${RST}（用这台机器上的仓库 Dockerfile 构建 —— 不依赖 ghcr.io，但需要源码）"
if [ "$MODE" = "build" ]; then
  ask MODE2 "选哪个 [2]" "2"
else
  ask MODE2 "选哪个 [1]" "1"
fi
MODE="$([ "$MODE2" = "2" ] && echo build || echo image)"
if [ "$MODE" = "build" ]; then
  if [ ! -f "$INSTALL_DIR/Dockerfile" ]; then
    say "当前目录没有源码（没有 Dockerfile）。"
    if askyn "现在把源码 clone 到 ${INSTALL_DIR}（本仓库 ${CANVAS_GIT}，只拉最新版）" "y"; then
      git clone --depth 1 "$CANVAS_GIT" "$INSTALL_DIR/repo" 2>/dev/null \
        || die "clone 源码失败（网络？）。可以手动 clone 后放在 $INSTALL_DIR/repo，再重跑"
      # 把 deploy.sh 也放进去一份，方便以后在 repo 里直接跑
      cp "$0" "$INSTALL_DIR/repo/deploy.sh" 2>/dev/null || true
      INSTALL_DIR="$INSTALL_DIR/repo"
      APP_DIR="$INSTALL_DIR"
      state_load
    else
      warn "没有源码就用不了本地构建。改用官方镜像（可能拉不动）"
      MODE="image"
    fi
  fi
fi
[ -n "$ZFC_MIRROR" ] && state_write mirror "$ZFC_MIRROR"

say ""
say "  统计（可选，默认全关）："
ask_opt GA4 "GA4 衡量 ID" "$(state_read analytics_ga4 '')"
ask_opt BAIDU "百度统计 ID" "$(state_read analytics_baidu '')"

state_write port "$PORT"
state_write mode "$MODE"
state_write analytics_ga4 "$GA4"
state_write analytics_baidu "$BAIDU"

say ""
say "  确认一下："
say "    目录：$APP_DIR"
say "    端口：$PORT"
say "    模式：$([ "$MODE" = "build" ] && echo 本地构建 || echo 官方镜像)"
say "    统计：$([ -n "$GA4" ] || [ -n "$BAIDU" ] && echo 开 || echo 关)"
askyn "开始部署？" "y" || { say "取消"; exit 1; }

run_container

say ""
ok "完事。访问地址：http://<这台机器的IP>:$PORT/"
say ""
say "${BLD}以后要更新：回这个菜单选 2（一条命令：$(self_cmd) --update）${RST}"
say "用户数据都在浏览器里，服务器上没有任何持久数据 —— 怎么备份迁移看菜单 8。"
say ""
if [ "$ZFC_YES" = "1" ]; then
  # 非交互：只给过 --domain 才自动配 HTTPS，否则跳过
  if [ -n "$ZFC_DOMAIN" ]; then
    https_wizard
  else
    say "（非交互模式：没给 --domain，跳过 HTTPS —— 以后回菜单选 5 再配）"
  fi
elif askyn "现在配 HTTPS（填域名自动申请证书）？也可以以后菜单选 5" "n"; then
  https_wizard
fi
json_out "install" "port=$PORT mode=$MODE"
