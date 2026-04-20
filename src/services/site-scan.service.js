'use strict';

const os = require('os');

/**
 * Site Scan Service — 一次性扫描主机上的所有 Web 服务器配置和证书
 *
 * 核心思路：
 * 1. 构建一个 one-shot shell 脚本，用 ===SECTION=== 分隔各部分输出
 * 2. 通过 bridgeService.execOnHost() 一次性执行
 * 3. 解析各 section，返回结构化 JSON
 *
 * 优势：
 * - 从 6-10 次 SSH 调用降低到 1 次
 * - nginx -T 展开所有 include，覆盖 BaoTa/1Panel/自定义路径
 * - apache2ctl -S 直接列出所有 VirtualHost
 * - 批量 openssl x509 解析证书信息
 */

function buildScanScript() {
  return `
# 兼容 1Panel 的 openresty 路径（优先 PATH，找不到则回落到 1Panel 安装位置）
ONEPANEL_OR=/opt/1panel/apps/openresty/openresty/sbin/openresty
NGX_BIN=""
if command -v openresty >/dev/null 2>&1; then NGX_BIN=openresty
elif command -v nginx >/dev/null 2>&1; then NGX_BIN=nginx
elif [ -x "$ONEPANEL_OR" ]; then NGX_BIN="$ONEPANEL_OR"
fi

echo '===WEBSERVER_DETECT==='
(openresty -v 2>&1 || true); (nginx -v 2>&1 || true); (caddy version 2>&1 || true); (apache2ctl -v 2>&1 || httpd -v 2>&1 || true)
[ -x "$ONEPANEL_OR" ] && "$ONEPANEL_OR" -v 2>&1 || true

echo '===WEBSERVER_STATUS==='
systemctl is-active nginx openresty caddy apache2 httpd 2>/dev/null || true
# 1Panel 的 openresty 通常以容器或直接进程运行，补充一次进程检测
pgrep -f 'openresty|nginx' >/dev/null 2>&1 && echo 'active' || true

echo '===NGINX_T==='
if [ -n "$NGX_BIN" ]; then
  timeout -k 2 15 "$NGX_BIN" -T 2>/dev/null || echo '__NGINX_T_FAIL__'
else
  echo '__NGINX_T_FAIL__'
fi

echo '===NGINX_CONF_RAW==='
# 兜底：直接拼接常见路径下的 *.conf 内容（文件之间加分隔），
# 用于 1Panel / 宝塔等把 openresty 放进容器导致 -T 抓不到的场景
for d in \\
  /etc/nginx/conf.d \\
  /etc/nginx/sites-enabled \\
  /opt/1panel/apps/openresty/openresty/conf/conf.d \\
  /www/server/panel/vhost/nginx \\
  /usr/local/openresty/nginx/conf/conf.d; do
  [ -d "$d" ] || continue
  for f in "$d"/*.conf; do
    [ -f "$f" ] || continue
    # 先打一个空行保证与前一个 cat 输出隔断（某些 conf 末尾无换行）
    printf '\\n---CONF:%s\\n' "$f"
    cat "$f" 2>/dev/null
    # 再补一个换行防止下一段紧贴
    printf '\\n'
  done
done

echo '===CADDY_CONFIG==='
cat /etc/caddy/Caddyfile 2>/dev/null || true
find /etc/caddy/conf.d/ -name '*.caddy' -exec cat {} \\; 2>/dev/null || true

echo '===APACHE_S==='
apache2ctl -S 2>/dev/null || httpd -S 2>/dev/null || true

echo '===CERT_INFO==='
timeout -k 2 10 find /etc/ssl/1shell/ /root/.acme.sh/ /etc/letsencrypt/live/ \\
     /opt/1panel/apps/openresty/openresty/www/sites/ \\
     /opt/1panel/data/ssl/ \\
     /www/server/panel/vhost/cert/ \\
     -maxdepth 6 \\( -name 'fullchain.pem' -o -name 'cert.pem' -o -name 'fullchain.cer' -o -name '*.crt' \\) 2>/dev/null | while read f; do
  echo "---CERT:$f"
  openssl x509 -noout -subject -issuer -dates -in "$f" 2>/dev/null || true
done

echo '===ACME_LIST==='
(timeout -k 1 5 ~/.acme.sh/acme.sh --list 2>/dev/null || true)

echo '===CERT_RENEW==='
(crontab -l 2>/dev/null | grep -i acme || true)
(systemctl is-enabled certbot.timer 2>/dev/null || true)

echo '===END==='
`.trim();
}

function parseNginxT(section) {
  if (!section || section.includes('__NGINX_T_FAIL__')) {
    return [];
  }

  // 防御：某些 conf 末尾无换行，导致 `}---CONF:...` / `};---CONF:...` 粘连
  const normalized = section.replace(/---CONF:/g, '\n---CONF:');

  const sites = [];
  let currentFile = null;
  let buf = [];
  let depth = 0;
  let inServer = false;
  let blockFile = null;

  const flush = () => {
    if (!inServer || buf.length === 0) return;
    const block = buf.join('\n');
    const file = blockFile;
    buf = [];
    inServer = false;
    blockFile = null;
    depth = 0;

    const serverNameMatch = block.match(/server_name\s+([^;]+);/);
    if (!serverNameMatch) return;

    const listenMatches = [...block.matchAll(/listen\s+([^;]+);/g)];
    const sslMatch = block.match(/ssl_certificate\s+([^;]+);/);
    const rootMatch = block.match(/root\s+([^;]+);/);

    const domains = serverNameMatch[1].trim().split(/\s+/).filter((d) => d && d !== '_');
    const ports = listenMatches.map((m) => {
      const parts = m[1].trim().split(/\s+/);
      const port = parts[0].replace(/\[.*?\]:/, '').split(':').pop();
      const ssl = parts.includes('ssl');
      return { port, ssl };
    });

    const hasSsl = ports.some((p) => p.ssl) || !!sslMatch;

    for (const domain of domains) {
      sites.push({
        domain,
        server: 'nginx',
        ssl: hasSsl,
        certPath: sslMatch ? sslMatch[1].trim() : null,
        root: rootMatch ? rootMatch[1].trim() : null,
        ports: ports.map((p) => p.port),
        configPath: file || null,
      });
    }
  };

  for (const line of normalized.split('\n')) {
    // CONF_RAW 兜底模式：我们插入的 ---CONF:<path> 标记
    const confMark = line.match(/^---CONF:(.+)$/);
    if (confMark) {
      flush();
      currentFile = confMark[1].trim();
      continue;
    }
    // nginx -T 的原生标记：# configuration file /path/to.conf:
    const nginxMark = line.match(/^#\s*configuration file\s+(.+?):\s*$/);
    if (nginxMark) {
      flush();
      currentFile = nginxMark[1].trim();
      continue;
    }

    if (!inServer) {
      if (/^\s*server\s*\{/.test(line)) {
        inServer = true;
        buf = [line];
        blockFile = currentFile;
        depth = 0;
        for (const c of line) {
          if (c === '{') depth++;
          else if (c === '}') depth--;
        }
        if (depth === 0) flush();
      }
      continue;
    }

    buf.push(line);
    for (const c of line) {
      if (c === '{') depth++;
      else if (c === '}') depth--;
    }
    if (depth === 0) flush();
  }
  flush();

  return sites;
}

function parseApacheS(section) {
  if (!section || !section.trim()) {
    return [];
  }

  const sites = [];
  const lines = section.split('\n');

  for (const line of lines) {
    // VirtualHost configuration:
    // *:80                   example.com (/etc/apache2/sites-enabled/example.conf:1)
    // *:443                  example.com (/etc/apache2/sites-enabled/example-ssl.conf:1)
    const match = line.match(/\*:(\d+)\s+(\S+)\s+\(([^)]+)\)/);
    if (!match) continue;

    const [, port, domain, configPath] = match;
    const ssl = port === '443';

    sites.push({
      domain,
      server: 'apache',
      ssl,
      certPath: null, // Apache -S 不直接显示证书路径，需要读配置文件
      root: null,
      ports: [port],
      configPath,
    });
  }

  return sites;
}

function parseCaddyConfig(section) {
  if (!section || !section.trim()) {
    return [];
  }

  const sites = [];
  const lines = section.split('\n');

  for (const line of lines) {
    // Caddyfile 格式：example.com {
    const match = line.match(/^([a-zA-Z0-9.-]+(?:\.[a-zA-Z]{2,})?)\s*\{/);
    if (!match) continue;

    const domain = match[1];
    sites.push({
      domain,
      server: 'caddy',
      ssl: true, // Caddy 默认自动 HTTPS
      certPath: null,
      root: null,
      ports: ['443'],
    });
  }

  return sites;
}

function parseCertInfo(section) {
  if (!section || !section.trim()) {
    return [];
  }

  const certs = [];
  const blocks = section.split('---CERT:').filter(b => b.trim());

  for (const block of blocks) {
    const lines = block.split('\n');
    const path = lines[0].trim();

    let domain = null;
    let issuer = null;
    let notBefore = null;
    let notAfter = null;

    for (const line of lines.slice(1)) {
      if (line.includes('subject=')) {
        const cnMatch = line.match(/CN\s*=\s*([^,\s]+)/);
        if (cnMatch) domain = cnMatch[1];
      }
      if (line.includes('issuer=')) {
        const issuerMatch = line.match(/O\s*=\s*([^,]+)/);
        if (issuerMatch) issuer = issuerMatch[1].trim();
      }
      if (line.includes('notBefore=')) {
        notBefore = line.split('notBefore=')[1].trim();
      }
      if (line.includes('notAfter=')) {
        notAfter = line.split('notAfter=')[1].trim();
      }
    }

    if (domain) {
      certs.push({
        domain,
        path,
        issuer: issuer || 'Unknown',
        notBefore,
        notAfter,
        daysLeft: notAfter ? Math.floor((new Date(notAfter) - new Date()) / 86400000) : null,
      });
    }
  }

  return certs;
}

function parseAcmeList(section) {
  if (!section || !section.trim()) {
    return [];
  }

  const domains = [];
  const lines = section.split('\n');

  for (const line of lines) {
    // acme.sh --list 输出格式：
    // Main_Domain  KeyLength  SAN_Domains  Created  Renew
    // example.com  "ec-256"   no           2024-01-01  2024-03-01
    const match = line.match(/^([a-zA-Z0-9.-]+)\s+/);
    if (match && !line.includes('Main_Domain')) {
      domains.push(match[1]);
    }
  }

  return domains;
}

function createSiteScanService({ bridgeService, hostService }) {
  async function scanHost(hostId) {
    try {
      // Windows 本机无法执行 bash 脚本，直接返回空结果
      const host = hostService?.findHost(hostId);
      if (host?.type === 'local' && os.platform() === 'win32') {
        return { ok: true, servers: [], sites: [], certs: [], acmeDomains: [], renewConfig: '' };
      }

      const script = buildScanScript();
      const timeout = 60000; // 60s

      let result;
      try {
        result = await bridgeService.execOnHost(hostId, script, timeout, { source: 'site_scan' });
      } catch (err) {
        throw new Error(`扫描失败: ${err.message}`);
      }

      if (!result) {
        throw new Error('命令执行失败: 无返回结果');
      }

      const output = result.stdout || '';
      // 脚本中部分命令（systemctl、nginx -T 等）可能返回非零，
      // 只要输出包含 ===END=== 就说明脚本跑完了
      if (!output.includes('===END===') && result.exitCode !== 0) {
        const errMsg = result.stderr?.trim() || `exitCode=${result.exitCode}`;
        throw new Error(`命令执行失败: ${errMsg}`);
      }

      const sections = {};

    // 按 ===SECTION=== 分割
    const sectionNames = [
      'WEBSERVER_DETECT',
      'WEBSERVER_STATUS',
      'NGINX_T',
      'NGINX_CONF_RAW',
      'CADDY_CONFIG',
      'APACHE_S',
      'CERT_INFO',
      'ACME_LIST',
      'CERT_RENEW',
    ];

    for (let i = 0; i < sectionNames.length; i++) {
      const name = sectionNames[i];
      const start = output.indexOf(`===${name}===`);
      if (start === -1) continue;

      const contentStart = start + `===${name}===`.length;
      const nextSection = sectionNames[i + 1];
      const end = nextSection ? output.indexOf(`===${nextSection}===`, contentStart) : output.indexOf('===END===', contentStart);

      sections[name] = output.slice(contentStart, end === -1 ? undefined : end).trim();
    }

    // 解析各部分
    // nginx -T 抓不到（1Panel/宝塔把 openresty 放进容器）时，用 NGINX_CONF_RAW 兜底
    let nginxSites = parseNginxT(sections.NGINX_T || '');
    if (nginxSites.length === 0 && sections.NGINX_CONF_RAW) {
      nginxSites = parseNginxT(sections.NGINX_CONF_RAW);
    }
    const apacheSites = parseApacheS(sections.APACHE_S || '');
    const caddySites = parseCaddyConfig(sections.CADDY_CONFIG || '');
    const certs = parseCertInfo(sections.CERT_INFO || '');
    const acmeDomains = parseAcmeList(sections.ACME_LIST || '');

    // 检测已安装的 Web 服务器
    const detectSection = sections.WEBSERVER_DETECT || '';
    const statusSection = sections.WEBSERVER_STATUS || '';
    const servers = [];

    if (detectSection.includes('nginx') || detectSection.includes('openresty')) {
      const statusLines = statusSection.split('\n').map(l => l.trim()).filter(Boolean);
      const running = statusLines.some(l => l === 'active');
      servers.push({
        name: detectSection.includes('openresty') ? 'openresty' : 'nginx',
        version: detectSection.match(/nginx[\/\s]+([\d.]+)/)?.[1] || 'unknown',
        running,
      });
    }
    if (detectSection.includes('caddy')) {
      const running = statusSection.split('\n').some(l => l.includes('caddy') && l.includes('active'));
      servers.push({
        name: 'caddy',
        version: detectSection.match(/v([\d.]+)/)?.[1] || 'unknown',
        running,
      });
    }
    if (detectSection.includes('Apache') || detectSection.includes('httpd')) {
      const running = statusSection.split('\n').some(l => (l.includes('apache2') || l.includes('httpd')) && l.includes('active'));
      servers.push({
        name: 'apache',
        version: detectSection.match(/Apache[\/\s]+([\d.]+)/)?.[1] || 'unknown',
        running,
      });
    }

    // 合并所有站点
    const allSites = [...nginxSites, ...apacheSites, ...caddySites];

    // 关联证书信息
    for (const site of allSites) {
      const cert = certs.find(c => c.domain === site.domain || site.domain.endsWith(c.domain));
      if (cert) {
        site.certIssuer = cert.issuer;
        site.certExpiry = cert.notAfter;
        site.certDaysLeft = cert.daysLeft;
      }
    }

    return {
      ok: true,
      servers,
      sites: allSites,
      certs,
      acmeDomains,
      renewConfig: sections.CERT_RENEW || '',
    };
    } catch (err) {
      // Log the actual error for debugging
      console.error('[site-scan] Error:', err);
      throw new Error(err.message || 'Unknown error');
    }
  }

  return { scanHost };
}

module.exports = { createSiteScanService };