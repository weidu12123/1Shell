'use strict';

/**
 * Site Delete Service — 删除网站/证书并清理所有残留
 *
 * 两阶段：
 *   1. previewResidue(hostId, domain, confPath) — 扫描所有候选路径，返回存在的项和大小
 *   2. executeDelete(hostId, domain, confPath, options, flags) — 按选项执行删除，先备份再删
 *
 * 覆盖的残留位置：
 *   - nginx/openresty conf 文件
 *   - 站点目录（1Panel / 普通 /www/sites）
 *   - acme.sh 条目与目录
 *   - Let's Encrypt live/archive/renewal
 *   - 宝塔 vhost cert 目录
 *   - Web 服务 reload（1Panel 走 docker exec）
 *
 * 所有被删内容会打 tar.gz 备份到 /tmp/1shell-backup-<ts>-<domain>/
 */

function shq(s) {
  return `'${String(s).replace(/'/g, "'\\''")}'`;
}

function isValidDomain(d) {
  return typeof d === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9.\-*]{0,252}$/.test(d) && !d.includes('..');
}

function isValidPath(p) {
  // 只接受绝对路径，不能包含 .. 或 shell 元字符
  return typeof p === 'string' && p.startsWith('/') && !/[$`\n\r;&|<>]/.test(p) && !p.includes('..');
}

function buildPreviewScript(domain, confPath) {
  const D = shq(domain);
  const CP = confPath ? shq(confPath) : "''";
  return `
set +e
DOMAIN=${D}
CONF=${CP}

emit() { printf '%s|%s|%s\\n' "$1" "$2" "\${3:-0}"; }

probe() {
  local p="$1"
  [ -z "$p" ] && return
  if [ -e "$p" ]; then
    local sz=0 kind
    if [ -L "$p" ]; then
      kind=link
      sz=$(stat -c%s "$p" 2>/dev/null || echo 0)
    elif [ -d "$p" ]; then
      kind=dir
      sz=$(timeout -k 1 2 find "$p" -maxdepth 0 -printf '%s' 2>/dev/null || echo 0)
      sz=\${sz:-0}
    else
      kind=file
      sz=$(stat -c%s "$p" 2>/dev/null || echo 0)
    fi
    emit "$p" "$kind" "\${sz:-0}"
  fi
}

[ -n "$CONF" ] && probe "$CONF"
probe "/opt/1panel/apps/openresty/openresty/www/sites/$DOMAIN"
probe "/www/sites/$DOMAIN"
probe "$HOME/.acme.sh/$DOMAIN"
probe "$HOME/.acme.sh/\${DOMAIN}_ecc"
probe "/etc/letsencrypt/live/$DOMAIN"
probe "/etc/letsencrypt/archive/$DOMAIN"
probe "/etc/letsencrypt/renewal/\${DOMAIN}.conf"
probe "/www/server/panel/vhost/cert/$DOMAIN"
probe "/opt/1panel/data/ssl/$DOMAIN"

# 也扫描 conf.d 下同域名的 conf（用户可能手动改名）
for d in /opt/1panel/apps/openresty/openresty/conf/conf.d /etc/nginx/conf.d /etc/nginx/sites-enabled /usr/local/openresty/nginx/conf/conf.d; do
  [ -d "$d" ] || continue
  for f in "$d"/"$DOMAIN"*.conf; do
    [ -f "$f" ] || continue
    [ "$f" = "$CONF" ] && continue
    probe "$f"
  done
done

# acme.sh 注册状态
if [ -x "$HOME/.acme.sh/acme.sh" ]; then
  if timeout -k 1 4 "$HOME/.acme.sh/acme.sh" --list 2>/dev/null | awk -v d="$DOMAIN" 'NR>1 && $1==d {f=1} END{exit !f}'; then
    echo "FLAG|acme_registered"
  fi
fi

# certbot 注册状态
if command -v certbot >/dev/null 2>&1; then
  if timeout -k 1 4 certbot certificates --cert-name "$DOMAIN" 2>/dev/null | grep -qE "Certificate Name:"; then
    echo "FLAG|certbot_registered"
  fi
fi

# 1Panel openresty 容器（用于 reload）
# docker 仅宿主机可用，容器内可能没有；加 timeout 防止脚本阻塞
CID=$(timeout -k 1 4 docker ps --format '{{.Names}}' 2>/dev/null | grep -iE '1Panel-openresty|openresty' | head -1 || true)
[ -n "$CID" ] && echo "FLAG|onepanel_container=$CID"

echo "__END__"
`.trim();
}

function buildDeleteScript(domain, confPath, options, flags) {
  const D = shq(domain);
  const CP = confPath ? shq(confPath) : "''";
  const CID = flags?.onepanelContainer ? shq(flags.onepanelContainer) : "''";
  const {
    removeConf = true,
    removeWebRoot = true,
    removeCert = true,
    removeAcme = true,
    removeLetsEncrypt = true,
    reloadServer = true,
    backup = true,
  } = options || {};

  const bk = backup
    ? `BK="/tmp/1shell-backup-$(date +%s)-\${DOMAIN//[^a-zA-Z0-9.-]/_}"; mkdir -p "$BK"`
    : 'BK=""';
  const safeBackup = backup
    ? `if [ -n "$BK" ] && [ -e "$1" ]; then tar -czf "$BK/$(echo "$1" | tr '/' '_').tgz" -C "$(dirname "$1")" "$(basename "$1")" 2>/dev/null; fi`
    : ':';

  return `
set +e
DOMAIN=${D}
CONF=${CP}
CID=${CID}

log() { echo "[delete] $*"; }
${bk}
bak() { ${safeBackup}; }

${removeConf ? `
if [ -n "$CONF" ] && [ -f "$CONF" ]; then
  bak "$CONF" && rm -f "$CONF" && log "removed conf: $CONF"
fi
# 同域名的其他 conf
for d in /opt/1panel/apps/openresty/openresty/conf/conf.d /etc/nginx/conf.d /etc/nginx/sites-enabled /usr/local/openresty/nginx/conf/conf.d; do
  [ -d "$d" ] || continue
  for f in "$d"/"$DOMAIN".conf "$d"/"$DOMAIN"_*.conf; do
    [ -f "$f" ] && [ "$f" != "$CONF" ] && bak "$f" && rm -f "$f" && log "removed conf: $f"
  done
done
` : '# keep conf'}

${removeWebRoot ? `
for wr in "/opt/1panel/apps/openresty/openresty/www/sites/$DOMAIN" "/www/sites/$DOMAIN"; do
  [ -d "$wr" ] && bak "$wr" && rm -rf "$wr" && log "removed web root: $wr"
done
` : '# keep web root'}

${removeAcme ? `
if [ -x "$HOME/.acme.sh/acme.sh" ]; then
  "$HOME/.acme.sh/acme.sh" --remove -d "$DOMAIN" >/dev/null 2>&1 && log "acme.sh unregistered: $DOMAIN"
fi
for d in "$HOME/.acme.sh/$DOMAIN" "$HOME/.acme.sh/\${DOMAIN}_ecc"; do
  [ -d "$d" ] && bak "$d" && rm -rf "$d" && log "removed acme dir: $d"
done
` : '# keep acme'}

${removeLetsEncrypt ? `
if command -v certbot >/dev/null 2>&1; then
  certbot delete --cert-name "$DOMAIN" --non-interactive >/dev/null 2>&1 && log "certbot removed: $DOMAIN"
fi
for p in "/etc/letsencrypt/live/$DOMAIN" "/etc/letsencrypt/archive/$DOMAIN" "/etc/letsencrypt/renewal/\${DOMAIN}.conf"; do
  [ -e "$p" ] && bak "$p" && rm -rf "$p" && log "removed letsencrypt: $p"
done
` : '# keep letsencrypt'}

${removeCert ? `
# 1Panel / 宝塔 独立 cert 目录
for p in "/opt/1panel/data/ssl/$DOMAIN" "/www/server/panel/vhost/cert/$DOMAIN"; do
  [ -d "$p" ] && bak "$p" && rm -rf "$p" && log "removed cert dir: $p"
done
` : '# keep cert dir'}

${reloadServer ? `
# Reload
if [ -n "$CID" ]; then
  docker exec "$CID" openresty -s reload 2>/dev/null && log "reloaded 1Panel openresty ($CID)"
elif command -v openresty >/dev/null 2>&1; then
  openresty -s reload 2>/dev/null && log "reloaded openresty"
elif command -v nginx >/dev/null 2>&1; then
  nginx -s reload 2>/dev/null && log "reloaded nginx"
fi
` : '# skip reload'}

[ -n "$BK" ] && log "backup at: $BK"
echo "__DONE__"
`.trim();
}

function createSiteDeleteService({ bridgeService }) {
  async function previewResidue(hostId, domain, confPath) {
    if (!isValidDomain(domain)) {
      throw Object.assign(new Error('域名格式不合法'), { status: 400 });
    }
    if (confPath && !isValidPath(confPath)) {
      throw Object.assign(new Error('配置路径不合法'), { status: 400 });
    }

    const script = buildPreviewScript(domain, confPath || '');
    const res = await bridgeService.execOnHost(hostId, script, 60000, { source: 'site_delete_preview' });

    const targets = [];
    const flags = { acmeRegistered: false, certbotRegistered: false, onepanelContainer: null };

    for (const line of (res.stdout || '').split('\n')) {
      const l = line.trim();
      if (!l || l === '__END__') continue;
      if (l.startsWith('FLAG|')) {
        const body = l.slice(5);
        if (body === 'acme_registered') flags.acmeRegistered = true;
        else if (body === 'certbot_registered') flags.certbotRegistered = true;
        else if (body.startsWith('onepanel_container=')) flags.onepanelContainer = body.slice('onepanel_container='.length);
        continue;
      }
      const [path, kind, size] = l.split('|');
      if (path && kind) targets.push({ path, kind, size: Number(size || 0) });
    }

    return { ok: true, targets, flags };
  }

  async function executeDelete(hostId, domain, confPath, options, flags) {
    if (!isValidDomain(domain)) {
      throw Object.assign(new Error('域名格式不合法'), { status: 400 });
    }
    if (confPath && !isValidPath(confPath)) {
      throw Object.assign(new Error('配置路径不合法'), { status: 400 });
    }
    if (flags?.onepanelContainer && !/^[a-zA-Z0-9_.-]+$/.test(flags.onepanelContainer)) {
      throw Object.assign(new Error('容器名不合法'), { status: 400 });
    }

    const script = buildDeleteScript(domain, confPath || '', options || {}, flags || {});
    const res = await bridgeService.execOnHost(hostId, script, 120000, { source: 'site_delete' });

    return {
      ok: res.exitCode === 0 && (res.stdout || '').includes('__DONE__'),
      exitCode: res.exitCode,
      stdout: res.stdout,
      stderr: res.stderr,
    };
  }

  return { previewResidue, executeDelete };
}

module.exports = { createSiteDeleteService };