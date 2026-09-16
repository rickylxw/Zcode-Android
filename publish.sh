#!/usr/bin/env bash
# ZCode Android 一键发布：推送代码 + 配置 Actions Secrets + 推标签触发 CI + 等待 Release 产物
# 用法：bash publish.sh   （需要 GitHub 可达：直连或本地代理；代理地址改 PROXY 变量）
set -euo pipefail
cd "$(dirname "$0")"

REPO="rickylxw/Zcode-Android"
TAG="v0.2.0"
PROXY="http://127.0.0.1:7897"          # Clash Verge 本地代理端口，变了改这里
KS_PASS="${KS_PASS:-zcode-update-2026}"
KEY_ALIAS="${KEY_ALIAS:-zcode}"
KEY_PASS="${KEY_PASS:-zcode-update-2026}"

step() { printf '\n==> %s\n' "$*"; }

TOKEN=$(printf "protocol=https\nhost=github.com\n" | git credential fill 2>/dev/null | grep "^password=" | cut -d= -f2)
[ -n "$TOKEN" ] || { echo "未找到 GitHub 凭据（git credential manager）"; exit 1; }
export TOKEN

step "1/6 探测 GitHub 访问方式（直连 → 本地代理）"
if curl -s -o /dev/null --max-time 8 https://api.github.com; then
  CURL=(curl -s --max-time 120); GIT_PROXY=(); echo "  直连可用"
elif curl -s -o /dev/null --max-time 8 -x "$PROXY" https://api.github.com; then
  CURL=(curl -s --max-time 120 -x "$PROXY"); GIT_PROXY=(-c "http.proxy=$PROXY"); echo "  走代理 $PROXY"
else
  echo "  ✗ GitHub 不可达：请在 Clash Verge 里换一个可用节点后重试"; exit 1
fi

step "2/6 确认仓库 $REPO（不存在则创建为 Public）"
CODE=$("${CURL[@]}" -o /dev/null -w "%{http_code}" -H "Authorization: token $TOKEN" "https://api.github.com/repos/$REPO")
if [ "$CODE" = "200" ]; then
  echo "  仓库已存在"
elif [ "$CODE" = "404" ]; then
  echo "  仓库不存在，创建中…"
  "${CURL[@]}" -X POST -H "Authorization: token $TOKEN" -H "Content-Type: application/json" \
    -d '{"name":"Zcode-Android","private":false,"description":"ZCode 手机伴侣客户端：连接电脑上的 ZCode，下发任务、跟进进度","has_issues":true,"has_wiki":false}' \
    "https://api.github.com/user/repos" -o /dev/null -w "  创建结果 HTTP %{http_code}\n" | grep -q "201" \
    || { echo "  ✗ 创建失败（token 需要 repo 权限，或同名仓库已存在但为 Private）"; exit 1; }
else
  echo "  ✗ 查询仓库异常 HTTP $CODE"; exit 1
fi

step "3/6 推送 main + 标签 $TAG"
git "${GIT_PROXY[@]}" push -u origin main 2>&1 | tail -2
git "${GIT_PROXY[@]}" push origin "$TAG" 2>&1 | tail -2

step "4/6 配置 Actions Secrets（keystore + 密码）"
SECRETS_DIR=$(mktemp -d)
trap 'rm -rf "$SECRETS_DIR"' EXIT
npm --prefix "$SECRETS_DIR" install libsodium-wrappers --silent --no-fund --no-audit
cd "$SECRETS_DIR" && npm link libsodium-wrappers >/dev/null 2>&1; cd - >/dev/null
export NODE_PATH="$SECRETS_DIR/node_modules"

PUBKEY_JSON=$("${CURL[@]}" -H "Authorization: token $TOKEN" -H "User-Agent: zcode-publish" "https://api.github.com/repos/$REPO/actions/secrets/public-key")
KEY_ID=$(node -e "console.log(JSON.parse(process.argv[1]).key_id)" "$PUBKEY_JSON")
PUBKEY=$(node -e "console.log(JSON.parse(process.argv[1]).key)" "$PUBKEY_JSON")
[ -n "$KEY_ID" ] && [ -n "$PUBKEY" ] || { echo "  ✗ 获取仓库公钥失败：$PUBKEY_JSON"; exit 1; }

put_secret() { # $1=name $2=plaintext（明文字符串，按 UTF-8 字节加密）
  local enc
  enc=$(PLAIN="$2" PK="$PUBKEY" node -e "
    const s=require('libsodium-wrappers');
    (async()=>{await s.ready;
      const pk=s.from_hex(process.env.PK);
      const msg=s.from_string(process.env.PLAIN);
      console.log(Buffer.from(s.crypto_box_seal(msg,pk)).toString('base64'));
    })();")
  local code
  code=$("${CURL[@]}" -o /dev/null -w "%{http_code}" -X PUT \
    -H "Authorization: token $TOKEN" -H "Content-Type: application/json" \
    -d "{\"encrypted_value\":\"$enc\",\"key_id\":\"$KEY_ID\"}" \
    "https://api.github.com/repos/$REPO/actions/secrets/$1")
  echo "  $1 → HTTP $code"
  [ "$code" = "201" ] || [ "$code" = "204" ] || exit 1
}

put_secret KEYSTORE_PASSWORD "$KS_PASS"
put_secret KEY_ALIAS "$KEY_ALIAS"
put_secret KEY_PASSWORD "$KEY_PASS"
put_secret KEYSTORE_BASE64 "$(base64 -w0 app/release.jks)"

step "5/6 确认标签已触发构建"
sleep 5
RUN_ID=""
for i in $(seq 1 12); do
  RUN_ID=$("${CURL[@]}" -H "Authorization: token $TOKEN" "https://api.github.com/repos/$REPO/actions/runs?per_page=5" \
    | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{try{const j=JSON.parse(d);const r=(j.workflow_runs||[]).find(r=>r.head_branch==='$TAG');console.log(r?r.id:'')}catch(e){console.log('')}})")
  [ -n "$RUN_ID" ] && break
  sleep 5
done
[ -n "$RUN_ID" ] || { echo "  ⚠ 未捕获到构建（可到 Actions 页手动查看）"; exit 0; }
echo "  构建 run_id=$RUN_ID，等待完成（约 3-6 分钟）…"

step "6/6 等待构建结果"
for i in $(seq 1 60); do
  STATUS_JSON=$("${CURL[@]}" -H "Authorization: token $TOKEN" "https://api.github.com/repos/$REPO/actions/runs/$RUN_ID")
  STATUS=$(node -e "const j=JSON.parse(process.argv[1]);console.log(j.status+'/'+(j.conclusion||''))" "$STATUS_JSON")
  printf '  [%02d] %s\n' "$i" "$STATUS"
  case "$STATUS" in
    *completed) break ;;
  esac
  sleep 20
done
case "$STATUS" in
  *success)
    echo "  ✓ 构建成功！"
    "${CURL[@]}" -H "Authorization: token $TOKEN" "https://api.github.com/repos/$REPO/releases/tags/$TAG" \
      | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{const j=JSON.parse(d);console.log('  Release:',j.html_url);(j.assets||[]).forEach(a=>console.log('  附件:',a.name,'('+Math.round(a.size/1024/1024*10)/10+' MB)'))})"
    ;;
  *failure) echo "  ✗ 构建失败，去 Actions 页看日志（常见原因：Secrets 没配对/keystore 不对）"; exit 1 ;;
  *) echo "  ⚠ 超时未结束，稍后到 Actions 页查看"; exit 0 ;;
esac
