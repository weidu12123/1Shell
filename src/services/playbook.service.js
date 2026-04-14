'use strict';

/**
 * Playbook Service
 *
 * 编排层：将多个脚本步骤按顺序串联执行。
 * 每一步调用 scriptService.runScript，如果某步失败则终止后续步骤。
 */

function createPlaybookService({ playbookRepository, scriptService, auditService }) {

  function listPlaybooks() {
    return playbookRepository.listPlaybooks();
  }

  function getPlaybook(id) {
    return playbookRepository.findPlaybook(id);
  }

  function createPlaybook(payload) {
    return playbookRepository.createPlaybook(payload);
  }

  function updatePlaybook(id, payload) {
    return playbookRepository.updatePlaybook(id, payload);
  }

  function deletePlaybook(id) {
    return playbookRepository.deletePlaybook(id);
  }

  function listRuns(opts) {
    return playbookRepository.listRuns(opts);
  }

  function getRun(id) {
    return playbookRepository.findRun(id);
  }

  /**
   * 执行 Playbook：按步骤顺序逐一调用 scriptService.runScript。
   * 某步失败时立即终止。
   *
   * @param {string} playbookId
   * @param {object} options
   * @param {string} [options.clientIp]
   * @returns {Promise<object>} run result
   */
  async function runPlaybook(playbookId, { clientIp } = {}) {
    const playbook = playbookRepository.findPlaybook(playbookId);
    if (!playbook) {
      const err = new Error('Playbook 不存在');
      err.status = 404;
      throw err;
    }

    const steps = playbook.steps || [];
    if (!steps.length) {
      const err = new Error('Playbook 没有任何步骤');
      err.status = 400;
      throw err;
    }

    const runId = playbookRepository.createRun({
      playbookId: playbook.id,
      playbookName: playbook.name,
      totalSteps: steps.length,
    });

    const stepResults = [];
    let failedStep = null;

    for (let i = 0; i < steps.length; i += 1) {
      const step = steps[i];
      try {
        const result = await scriptService.runScript(step.scriptId, {
          hostId: step.hostId || 'local',
          params: step.params || {},
          confirmed: true,
          timeoutMs: step.timeoutMs || undefined,
        }, { clientIp });

        stepResults.push({
          stepIndex: i,
          scriptId: step.scriptId,
          scriptName: step.scriptName || '',
          hostId: step.hostId || 'local',
          status: result.status,
          exitCode: result.exitCode,
          durationMs: result.durationMs,
          error: null,
        });

        playbookRepository.updateRun(runId, {
          status: 'running',
          completedSteps: i + 1,
          results: stepResults,
          error: null,
        });

        if (result.status !== 'success' && step.stopOnFail !== false) {
          failedStep = i;
          break;
        }
      } catch (err) {
        stepResults.push({
          stepIndex: i,
          scriptId: step.scriptId,
          scriptName: step.scriptName || '',
          hostId: step.hostId || 'local',
          status: 'error',
          exitCode: null,
          durationMs: null,
          error: err.message,
        });

        failedStep = i;

        playbookRepository.updateRun(runId, {
          status: 'failed',
          completedSteps: i + 1,
          results: stepResults,
          error: `步骤 ${i + 1} 执行失败: ${err.message}`,
        });

        break;
      }
    }

    const finalStatus = failedStep !== null ? 'failed' : 'success';
    playbookRepository.updateRun(runId, {
      status: finalStatus,
      completedSteps: stepResults.length,
      results: stepResults,
      error: failedStep !== null ? `步骤 ${failedStep + 1} 失败` : null,
    });

    auditService?.log({
      action: 'playbook_run',
      source: 'web_ui',
      command: `[Playbook] ${playbook.name}`.substring(0, 2000),
      details: JSON.stringify({ playbookId: playbook.id, runId, totalSteps: steps.length, completedSteps: stepResults.length, status: finalStatus }),
      clientIp,
    });

    return playbookRepository.findRun(runId);
  }

  return {
    listPlaybooks,
    getPlaybook,
    createPlaybook,
    updatePlaybook,
    deletePlaybook,
    runPlaybook,
    listRuns,
    getRun,
  };
}

module.exports = { createPlaybookService };