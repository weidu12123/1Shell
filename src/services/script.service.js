'use strict';

/**
 * Script Service
 *
 * 脚本库的业务逻辑层：
 *   - 列表 / 查询 / 创建 / 更新 / 删除
 *   - 参数渲染（{{var}} 占位符替换 + 必填校验 + 类型转换）
 *   - 风险检查（danger 需显式 confirmed=true；confirm 需 confirmed=true）
 *   - 执行编排：创建 run 记录 → 调用 bridgeService（远程）或 child_process（本机）→ 更新 run → 写审计日志
 *
 * 执行结果会写入 audit_logs，action='script_run'。
 */

const os = require('os');
const { spawn } = require('child_process');

const LOCAL_HOST_ID = 'local';
const DEFAULT_TIMEOUT_MS = 120000;

// 危险关键词（启发式，仅用于提示，不是强约束）
const DANGER_KEYWORDS = [
  'rm -rf /',
  'rm -rf /*',
  'mkfs',
  'dd if=',
  ':(){ :|:& };:',
  '> /dev/sda',
  'chmod -R 777 /',
  'chown -R',
  'shutdown',
  'reboot',
  'init 0',
  'init 6',
  'halt',
];

function createScriptService({ scriptRepository, hostService, bridgeService, auditService }) {

  // 本机 shell 类型：Windows → powershell, 其他 → bash
  // 影响参数的 shellQuote 风格。远程主机一律按 POSIX bash 处理。
  const LOCAL_SHELL_STYLE = os.platform() === 'win32' ? 'powershell' : 'bash';
  // ─── 列表 / 查询 ─────────────────────────────────────────────────────
  function listScripts({ category, keyword } = {}) {
    return scriptRepository.listScripts({ category, keyword });
  }

  function getScript(id) {
    return scriptRepository.findScript(id);
  }

  // ─── CRUD ────────────────────────────────────────────────────────────
  function createScript(validatedPayload) {
    return scriptRepository.createScript(validatedPayload);
  }

  function updateScript(id, validatedPayload) {
    return scriptRepository.updateScript(id, validatedPayload);
  }

  function deleteScript(id) {
    return scriptRepository.deleteScript(id);
  }

  // ─── 参数渲染 ────────────────────────────────────────────────────────
  /**
   * 将 {{var}} 占位符替换为用户提供的参数值。
   * - 必填缺失 → 抛 400
   * - 类型转换（number/boolean）
   * - select 值必须在 options 中
   * - 参数值做 shell 转义，防止命令注入
   *
   * @param {object} script - 脚本对象
   * @param {object} rawParams - 前端传来的原始参数
   * @param {object} [opts]
   * @param {string} [opts.hostId] - 目标主机 ID，用于选择 shell 转义风格
   */
  function renderContent(script, rawParams, { hostId } = {}) {
    const params = { ...rawParams };
    const defs = script.parameters || [];

    // 选择 shell 风格：local 按本机平台，远程按 POSIX bash
    const shellStyle = hostId === LOCAL_HOST_ID ? LOCAL_SHELL_STYLE : 'bash';

    // 归一化 / 校验
    for (const def of defs) {
      const raw = params[def.name];
      const hasValue = raw != null && raw !== '';

      if (!hasValue) {
        if (def.required) {
          throw validationError(`参数 ${def.label || def.name} 必填`);
        }
        params[def.name] = def.default != null ? def.default : '';
        continue;
      }

      if (def.type === 'number') {
        const n = Number(raw);
        if (!Number.isFinite(n)) {
          throw validationError(`参数 ${def.label || def.name} 必须是数字`);
        }
        params[def.name] = String(n);
      } else if (def.type === 'boolean') {
        params[def.name] = raw === true || raw === 'true' || raw === '1' || raw === 1 ? 'true' : 'false';
      } else if (def.type === 'select') {
        const opts = def.options || [];
        const match = opts.find((o) => String(o.value) === String(raw));
        if (!match) {
          throw validationError(`参数 ${def.label || def.name} 不在可选列表中`);
        }
        params[def.name] = String(match.value);
      } else {
        // string
        params[def.name] = String(raw);
      }
    }

    // 渲染：{{name}} → shellQuote(value)
    // 只替换参数定义中存在的占位符，未定义的保持原样
    let rendered = script.content;
    for (const def of defs) {
      const placeholder = new RegExp(`\\{\\{\\s*${escapeRegExp(def.name)}\\s*\\}\\}`, 'g');
      rendered = rendered.replace(placeholder, shellQuote(params[def.name], shellStyle));
    }

    return { rendered, normalizedParams: params };
  }

  // ─── 风险检查 ────────────────────────────────────────────────────────
  function checkRisk(script, renderedContent, { confirmed }) {
    // safe：任意执行
    // confirm：必须 confirmed=true
    // danger：必须 confirmed=true，并且会在返回中附带一条强提示
    if (script.riskLevel === 'safe') {
      return { ok: true, warnings: [] };
    }
    if (!confirmed) {
      return {
        ok: false,
        needConfirm: true,
        message: script.riskLevel === 'danger'
          ? '该脚本标记为"危险"，请在前端显式确认后传入 confirmed=true'
          : '该脚本需要确认后执行，请传入 confirmed=true',
      };
    }
    const warnings = [];
    if (script.riskLevel === 'danger') {
      warnings.push('脚本标记为 danger，请谨慎确认执行目标主机');
    }
    const lower = String(renderedContent || '').toLowerCase();
    for (const kw of DANGER_KEYWORDS) {
      if (lower.includes(kw.toLowerCase())) {
        warnings.push(`检测到高危命令关键词: ${kw}`);
      }
    }
    return { ok: true, warnings };
  }

  // ─── 执行脚本 ────────────────────────────────────────────────────────
  async function runScript(id, { hostId, params, confirmed, timeoutMs }, { clientIp } = {}) {
    const script = scriptRepository.findScript(id);
    if (!script) {
      throw notFoundError('脚本不存在');
    }

    // 目标主机存在性校验
    const host = hostService.findHost(hostId);
    if (!host && hostId !== LOCAL_HOST_ID) {
      throw validationError('目标主机不存在');
    }
    const hostName = host?.name || (hostId === LOCAL_HOST_ID ? '本机' : hostId);

    // 参数渲染
    let renderResult;
    try {
      renderResult = renderContent(script, params || {}, { hostId });
    } catch (err) {
      throw err;
    }
    const { rendered, normalizedParams } = renderResult;

    // 风险检查
    const risk = checkRisk(script, rendered, { confirmed });
    if (!risk.ok) {
      const err = new Error(risk.message);
      err.status = 409; // Conflict: 需要确认
      err.code = 'NEED_CONFIRM';
      err.riskLevel = script.riskLevel;
      throw err;
    }

    // 创建 run 记录
    const runId = scriptRepository.createRun({
      scriptId: script.id,
      scriptName: script.name,
      hostId,
      hostName,
      params: normalizedParams,
      renderedCommand: rendered,
    });

    const startAt = Date.now();
    try {
      const result = hostId === LOCAL_HOST_ID
        ? await execLocal(rendered, timeoutMs || DEFAULT_TIMEOUT_MS)
        : await bridgeService.execOnHost(
            hostId,
            rendered,
            timeoutMs || DEFAULT_TIMEOUT_MS,
            { source: 'script_run', clientIp },
          );

      const status = result.exitCode === 0 ? 'success' : 'failed';
      scriptRepository.updateRun(runId, {
        status,
        exitCode: result.exitCode,
        durationMs: result.durationMs,
        stdout: result.stdout,
        stderr: result.stderr,
        error: null,
      });
      scriptRepository.incrementRunCount(script.id);

      auditService?.log({
        action: 'script_run',
        source: 'web_ui',
        hostId,
        hostName,
        command: `[${script.name}] ${rendered}`.substring(0, 2000),
        exitCode: result.exitCode,
        durationMs: result.durationMs,
        clientIp,
        details: JSON.stringify({ scriptId: script.id, runId, riskLevel: script.riskLevel }),
      });

      return {
        runId,
        status,
        exitCode: result.exitCode,
        durationMs: result.durationMs,
        stdout: result.stdout,
        stderr: result.stderr,
        renderedCommand: rendered,
        warnings: risk.warnings,
      };
    } catch (err) {
      const durationMs = Date.now() - startAt;
      scriptRepository.updateRun(runId, {
        status: 'failed',
        exitCode: null,
        durationMs,
        stdout: null,
        stderr: null,
        error: err.message,
      });

      auditService?.log({
        action: 'script_run',
        source: 'web_ui',
        hostId,
        hostName,
        command: `[${script.name}] ${rendered}`.substring(0, 2000),
        error: err.message,
        durationMs,
        clientIp,
        details: JSON.stringify({ scriptId: script.id, runId, riskLevel: script.riskLevel }),
      });

      throw err;
    }
  }

  // ─── 批量执行 ────────────────────────────────────────────────────────
  /**
   * 在多台主机上并发执行同一脚本。
   * concurrency 控制并发数（默认 5），避免同时打爆几十台 SSH。
   * 每台主机独立生成 run 记录，任何单台失败不影响其他。
   * 返回 results 数组，与 hostIds 等长。
   */
  async function runScriptBatch(id, { hostIds, params, confirmed, timeoutMs, concurrency = 5 }, { clientIp } = {}) {
    const script = scriptRepository.findScript(id);
    if (!script) throw notFoundError('脚本不存在');

    if (!Array.isArray(hostIds) || hostIds.length === 0) {
      throw validationError('hostIds 不能为空');
    }
    if (hostIds.length > 50) {
      throw validationError('单次批量执行不能超过 50 台主机');
    }

    // 风险检查：取一个 hostId 做渲染（参数在所有主机上相同）
    const { rendered } = renderContent(script, params || {}, { hostId: hostIds[0] });
    const risk = checkRisk(script, rendered, { confirmed });
    if (!risk.ok) {
      const err = new Error(risk.message);
      err.status = 409;
      err.code = 'NEED_CONFIRM';
      err.riskLevel = script.riskLevel;
      throw err;
    }

    const limit = Math.max(1, Math.min(concurrency, 20));
    const results = [];
    const pending = [...hostIds];

    // 并发限流执行
    async function runOne(hostId) {
      try {
        const result = await runScript(id, { hostId, params, confirmed: true, timeoutMs }, { clientIp });
        return { hostId, ...result, ok: true };
      } catch (err) {
        return { hostId, ok: false, error: err.message, status: 'failed' };
      }
    }

    // 简单的池化并发
    while (pending.length > 0) {
      const batch = pending.splice(0, limit);
      const batchResults = await Promise.all(batch.map(runOne));
      results.push(...batchResults);
    }

    return {
      total: hostIds.length,
      success: results.filter((r) => r.ok && r.status === 'success').length,
      failed: results.filter((r) => !r.ok || r.status === 'failed').length,
      results,
      warnings: risk.warnings,
    };
  }

  // ─── 执行历史 ────────────────────────────────────────────────────────
  function getRun(runId) {
    return scriptRepository.findRun(runId);
  }

  function listRunsByScript(scriptId, opts) {
    return scriptRepository.listRunsByScript(scriptId, opts);
  }

  function listAllRuns(opts) {
    return scriptRepository.listAllRuns(opts);
  }

  return {
    listScripts,
    getScript,
    createScript,
    updateScript,
    deleteScript,
    renderContent, // 暴露用于"命令预览"接口
    checkRisk,
    runScript,
    runScriptBatch,
    getRun,
    listRunsByScript,
    listAllRuns,
  };
}

// ─── helpers ───────────────────────────────────────────────────────────

/**
 * 在 1Shell 进程所在的本机执行脚本。
 * - Linux/macOS：通过 stdin 把脚本内容喂给 /bin/bash
 * - Windows：通过 -Command 参数把脚本内容喂给 powershell.exe
 *
 * 使用 stdin 管道喂脚本的好处：不用再做 shell 转义，{{var}} 替换后的内容
 * 直接作为 bash/powershell 的标准输入，是"真正的脚本"而不是一行命令。
 *
 * 返回结构与 bridgeService.execOnHost 一致：{stdout, stderr, exitCode, durationMs}
 */
function execLocal(command, timeoutMs) {
  return new Promise((resolve) => {
    const startAt = Date.now();
    const isWindows = os.platform() === 'win32';
    const timeout = Math.max(timeoutMs || DEFAULT_TIMEOUT_MS, 1000);

    let child;
    try {
      if (isWindows) {
        // PowerShell：支持单引号字符串、分号分隔符，语义接近 bash 的简单脚本
        child = spawn('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', '-'], {
          windowsHide: true,
          env: process.env,
        });
      } else {
        child = spawn('/bin/bash', ['-s'], {
          env: process.env,
        });
      }
    } catch (err) {
      return resolve({
        stdout: '',
        stderr: `无法启动本地 shell: ${err.message}`,
        exitCode: 1,
        durationMs: Date.now() - startAt,
      });
    }

    let stdout = '';
    let stderr = '';
    let killedByTimeout = false;
    const MAX_BUFFER = 8 * 1024 * 1024;

    child.stdout.on('data', (chunk) => {
      if (stdout.length < MAX_BUFFER) stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk) => {
      if (stderr.length < MAX_BUFFER) stderr += chunk.toString();
    });

    const timer = setTimeout(() => {
      killedByTimeout = true;
      try { child.kill('SIGKILL'); } catch { /* ignore */ }
    }, timeout);

    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({
        stdout,
        stderr: stderr || err.message,
        exitCode: 1,
        durationMs: Date.now() - startAt,
      });
    });

    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({
        stdout,
        stderr: killedByTimeout ? (stderr + '\n（执行超时，已强制终止）') : stderr,
        exitCode: code != null ? code : (killedByTimeout ? 124 : 1),
        durationMs: Date.now() - startAt,
      });
    });

    // 将脚本内容通过 stdin 发送
    try {
      child.stdin.write(command);
      child.stdin.end();
    } catch { /* ignore */ }
  });
}

function shellQuote(value, style = 'bash') {
  const s = String(value ?? '');
  if (style === 'powershell') {
    // PowerShell 单引号字符串：单引号字面量用 '' 表示
    return `'${s.replace(/'/g, "''")}'`;
  }
  // POSIX bash：'foo' → "'foo'"，嵌入的单引号 → '\''
  return `'${s.replace(/'/g, "'\\''")}'`;
}

function escapeRegExp(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function validationError(message) {
  const err = new Error(message);
  err.status = 400;
  return err;
}

function notFoundError(message) {
  const err = new Error(message);
  err.status = 404;
  return err;
}

module.exports = { createScriptService };
