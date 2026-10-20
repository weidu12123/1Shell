'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const { createIdeService } = require('../src/ide/ide.service');
const { createIdeSessionRepository } = require('../src/repositories/ide-session.repository');

const tmpDir = path.join(os.tmpdir(), `1shell-ide-session-projection-${crypto.randomBytes(4).toString('hex')}`);
fs.mkdirSync(tmpDir, { recursive: true });

try {
  const repo = createIdeSessionRepository(null, { dataDir: tmpDir });
  const ideService = createIdeService({ ideSessionRepository: repo });

  const beforeTool = [
    'Found two `www.microsoft.com` entries:',
    '- `server_name`',
    '- `handshake.server`',
  ].join('\n');
  const afterTool = 'I will change them to `www.apple.com`, then back up and write.';

  repo.upsertSession({
    id: 'agent-projection',
    title: 'projection',
    entry: 'core',
    hostId: 'example-hk',
    messages: [
      { role: 'user', content: 'Check sing-box config' },
      {
        role: 'assistant',
        content: [
          { type: 'text', text: beforeTool },
          { type: 'tool_use', id: 'toolu_read', name: 'read_remote_file', input: { path: '/etc/sing-box/config.json' }, locations: [{ path: '/etc/sing-box/config.json' }] },
          { type: 'text', text: afterTool },
        ],
      },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_read', content: 'ok' }] },
    ],
    preview: afterTool,
    files: [{ path: '/etc/sing-box/config.json' }],
  });

  const detail = ideService.getSessionDetail('agent-projection');
  assert.ok(detail, 'session detail should be readable');
  assert.strictEqual(detail.timeline.length, 4, 'timeline should keep user, assistant, tool, assistant order');
  assert.strictEqual(detail.timeline[1].kind, 'assistant');
  assert.strictEqual(detail.timeline[1].text, beforeTool, 'assistant text before tool must preserve newlines and backticks');
  assert.strictEqual(detail.timeline[2].kind, 'tool', 'tool call must stay between text blocks');
  assert.strictEqual(detail.timeline[2].result, 'ok', 'tool_result must fill the matching tool card');
  assert.deepStrictEqual(detail.timeline[2].locations, [{ path: '/etc/sing-box/config.json' }], 'tool_use locations must project onto the tool card');
  assert.strictEqual(detail.timeline[3].kind, 'assistant');
  assert.strictEqual(detail.timeline[3].text, afterTool, 'assistant text after tool must stay after the tool call');
  assert.deepStrictEqual(detail.files, [{ path: '/etc/sing-box/config.json' }], 'session detail must expose touched files');

  // 文件反查会话：命中触碰过该文件的会话，路径分隔符归一化（Windows 反斜杠也能查）
  repo.upsertSession({
    id: 'agent-projection-2',
    title: 'projection 2',
    entry: 'core',
    hostId: '',
    messages: [{ role: 'user', content: 'touch same file' }],
    files: [{ path: '/etc/sing-box/config.json' }, { path: '/tmp/other.txt' }],
  });
  repo.upsertSession({
    id: 'agent-projection-3',
    title: 'projection 3',
    entry: 'core',
    hostId: '',
    messages: [{ role: 'user', content: 'unrelated' }],
    files: [{ path: '/tmp/unrelated.txt' }],
  });

  const hits = repo.findSessionsByFile('/etc/sing-box/config.json').map((s) => s.id).sort();
  assert.deepStrictEqual(hits, ['agent-projection', 'agent-projection-2'], 'findSessionsByFile must return sessions touching the file');
  const hitsBackslash = repo.findSessionsByFile('\\etc\\sing-box\\config.json').map((s) => s.id).sort();
  assert.deepStrictEqual(hitsBackslash, ['agent-projection', 'agent-projection-2'], 'backslash path must normalize to the same key');
  assert.deepStrictEqual(repo.findSessionsByFile('/nope/none.txt'), [], 'unknown file must return empty');
  const serviceHits = ideService.findSessionsByFile('/tmp/other.txt').map((s) => s.id);
  assert.deepStrictEqual(serviceHits, ['agent-projection-2'], 'ideService.findSessionsByFile must delegate to the repository');

  // 附件元数据投影：user 消息的 attachments 透出到时间线；服务注入的附件
  // 摘要块 / 精确文本块不进气泡（前端以缩略图/文件卡呈现附件）
  repo.upsertSession({
    id: 'agent-projection-att',
    title: 'attachments',
    entry: 'core',
    hostId: '',
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: '看看这张图' },
          { type: 'text', text: '\n\n用户随消息发送了以下附件：\n- shot.png (图片, image/png, 1.0 KB)' },
          { type: 'text', text: '\n\n<attachment name="notes.txt" mime="text/plain" exactHandle="att_0_abc" bytes=5 sha256="x">\nhello\n</attachment>' },
          { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'aGk=' } },
        ],
        attachments: [
          { path: '/data/agent-attachments/s1/x-1-shot.png', name: 'shot.png', mime: 'image/png', kind: 'image', size: 1024 },
        ],
      },
      { role: 'assistant', content: [{ type: 'text', text: '好的' }] },
    ],
  });
  const attDetail = ideService.getSessionDetail('agent-projection-att');
  const attUser = attDetail.timeline[0];
  assert.strictEqual(attUser.kind, 'user');
  assert.strictEqual(attUser.text, '看看这张图', '服务注入的附件摘要/精确文本块不应进用户气泡');
  assert.deepStrictEqual(attUser.attachments, [
    { path: '/data/agent-attachments/s1/x-1-shot.png', name: 'shot.png', mime: 'image/png', kind: 'image', size: 1024 },
  ], '附件元数据应投影到时间线 user 项');

  // 纯附件消息（无正文）也要出现在时间线上
  repo.upsertSession({
    id: 'agent-projection-att-only',
    title: 'attachments only',
    entry: 'core',
    hostId: '',
    messages: [
      {
        role: 'user',
        content: [{ type: 'text', text: '\n\n用户随消息发送了以下附件：\n- a.png' }],
        attachments: [{ path: '/tmp/a.png', name: 'a.png', mime: 'image/png', kind: 'image', size: 10 }],
      },
    ],
  });
  const attOnlyDetail = ideService.getSessionDetail('agent-projection-att-only');
  assert.strictEqual(attOnlyDetail.timeline.length, 1, '纯附件消息应保留时间线项');
  assert.strictEqual(attOnlyDetail.timeline[0].kind, 'user');
  assert.strictEqual(attOnlyDetail.timeline[0].text, '', '纯附件消息气泡文本为空');
  assert.strictEqual(attOnlyDetail.timeline[0].attachments.length, 1);

  // 用户原始多行结构与配置字段（如 private_key / password）保真，且剥离旧版注入头与运行时内部观察块
  const rawConfigInput = [
    '  {',
    '    "private_key": "reality-private-key-placeholder",',
    '    "password": "my-ss-password"',
    '  }',
    '帮我按上面配置搭建节点',
  ].join('\n');
  repo.upsertSession({
    id: 'agent-projection-user-fidelity',
    title: 'fidelity',
    entry: 'core',
    hostId: 'example-hk',
    messages: [
      {
        role: 'user',
        content: `**目标主机**：\n  - id=host_1 · hk (root@1.2.3.4:22) · OS: Debian GNU/Linux 12\n\n${rawConfigInput}`,
      },
      {
        role: 'user',
        content: [
          {
            type: 'text',
            text: 'RUNTIME_EMPTY_MODEL_RESPONSE\nattempt=1\nThe previous provider response contained no assistant text.',
          },
        ],
      },
    ],
  });
  const fidelityDetail = ideService.getSessionDetail('agent-projection-user-fidelity');
  assert.strictEqual(fidelityDetail.timeline.length, 1, '运行时内部重试观察块不应渲染为用户气泡');
  assert.strictEqual(
    fidelityDetail.timeline[0].text,
    rawConfigInput,
    '用户气泡应剥离旧版目标主机前缀并完整保留首行缩进、换行与原始字段内容',
  );

  console.log('ide-session-projection checks passed');
} finally {
  fs.rmSync(tmpDir, { recursive: true, force: true });
}
