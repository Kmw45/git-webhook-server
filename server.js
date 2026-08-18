const express = require('express');
const axios = require('axios');
require('dotenv').config();

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;
const DISCORD_WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL;

// ★ 알림을 보낼 PR action 목록
//   opened          : 새 PR 생성
//   reopened        : 닫혔던 PR 다시 열림
//   ready_for_review: 드래프트(초안) → 리뷰 준비 상태로 전환
const NOTIFY_ACTIONS = ['opened', 'reopened', 'ready_for_review'];

// ★ 특정 브랜치로 향하는 PR만 받고 싶다면 여기에 base 브랜치를 넣으세요.
//   비워두면([]) 모든 PR에 대해 알림이 옵니다.
//   예: ['main', 'develop']
const TARGET_BASE_BRANCHES = [];

// ─────────────────────────────────────────────────────────
// 디스코드 전송 큐 + 429(레이트리밋) 재시도
//   - 디스코드 웹훅은 URL당 대략 2초에 5회 정도의 요청 제한이 있음
//   - 여러 PR 이벤트가 짧은 시간에 몰려도 순서대로, 최소 간격을 두고 전송
//   - 429가 오면 응답의 retry_after(초)만큼 대기 후 자동 재시도
// ─────────────────────────────────────────────────────────
const MIN_SEND_INTERVAL_MS = 500; // 전송 사이 최소 간격 (약 초당 2회로 제한)
const MAX_RETRIES = 5;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let sendQueue = Promise.resolve();

async function sendToDiscordWithRetry(message, retriesLeft = MAX_RETRIES) {
  try {
    await axios.post(DISCORD_WEBHOOK_URL, message);
  } catch (err) {
    const status = err.response ? err.response.status : null;

    if (status === 429 && retriesLeft > 0) {
      const retryAfterSec =
        (err.response.data && err.response.data.retry_after) || 1;
      const waitMs = Math.ceil(retryAfterSec * 1000) + 250; // 여유 250ms 추가
      console.warn(
        `[429] 디스코드 레이트리밋. ${waitMs}ms 후 재시도합니다. (남은 재시도: ${retriesLeft})`
      );
      await sleep(waitMs);
      return sendToDiscordWithRetry(message, retriesLeft - 1);
    }

    // 429가 아니거나 재시도를 모두 소진한 경우 그대로 에러를 던짐
    throw err;
  }
}

// 모든 디스코드 전송을 하나의 큐로 직렬화 + 최소 간격 보장
function enqueueDiscordSend(message) {
  const task = sendQueue.then(() => sendToDiscordWithRetry(message));

  // 다음 작업은 이번 작업의 성공/실패와 무관하게 최소 간격 후 진행
  sendQueue = task.catch(() => {}).then(() => sleep(MIN_SEND_INTERVAL_MS));

  return task;
}

app.get('/', (req, res) => {
  res.status(200).send('Server is alive!');
});

app.post('/webhook', async (req, res) => {
  const event = req.headers['x-github-event'];

  // 1. Pull Request 이벤트가 아니면 무시 (push 알림은 더 이상 보내지 않음)
  if (event !== 'pull_request') {
    return res.status(200).send('Ignored non-PR event');
  }

  const payload = req.body;
  const action = payload.action;
  const pr = payload.pull_request;

  if (!pr) {
    return res.status(200).send('No pull_request payload');
  }

  const baseBranch = pr.base ? pr.base.ref : '';
  const headBranch = pr.head ? pr.head.ref : '';

  // 2. base 브랜치 필터 (설정된 경우에만 동작)
  if (TARGET_BASE_BRANCHES.length > 0 && !TARGET_BASE_BRANCHES.includes(baseBranch)) {
    console.log(`[무시됨] base 브랜치 '${baseBranch}' 는 알림 대상이 아닙니다.`);
    return res.status(200).send('Ignored base branch');
  }

  // PR 작성자 / 이 이벤트를 실제로 발생시킨 사람(머지·닫기를 누른 사람)
  const author = pr.user ? pr.user.login : 'unknown';
  const actor = payload.sender ? payload.sender.login : author;

  // 3. action 종류에 따라 알림 유형 결정
  //    ↓↓↓ 머지/닫힘 알림이 필요 없으면 아래 closed 분기를 지우면 됩니다 ↓↓↓
  let heading;
  let color;

  if (NOTIFY_ACTIONS.includes(action)) {
    heading = `🔀 ${author} 님이 Pull Request 요청을 보냈습니다`;
    color = 0x2ECC71; // 초록색
  } else if (action === 'closed' && pr.merged) {
    heading = `✅ ${actor} 님이 Pull Request를 머지했습니다`;
    color = 0x8E44AD; // 보라색
  } else if (action === 'closed' && !pr.merged) {
    heading = `❌ ${actor} 님이 Pull Request를 닫았습니다`;
    color = 0xE74C3C; // 빨간색
  } else {
    // 그 외 action(assigned, labeled, synchronize 등)은 무시
    console.log(`[무시됨] '${action}' action 은 알림 대상이 아닙니다.`);
    return res.status(200).send('Ignored PR action');
  }
  // ↑↑↑ 여기까지 ↑↑↑

  const repoName = payload.repository.full_name;
  const prNumber = pr.number;
  const prTitle = pr.title || 'No title';

  // PR 본문(Description) 가공 — Discord 필드 값은 최대 1024자
  let bodyText = (pr.body || '').trim();
  if (bodyText.length > 1000) {
    bodyText = bodyText.substring(0, 1000) + '\n...(생략)';
  }
  if (!bodyText) {
    bodyText = '(설명 없음)';
  }

  // 디스코드 메시지 양식
  const discordMessage = {
    embeds: [
      {
        title: `${heading}  #${prNumber}`,
        description: `**${prTitle}**`,
        url: pr.html_url,
        color: color,
        fields: [
          {
            name: '작성자',
            value: author,
            inline: true,
          },
          {
            name: '브랜치',
            value: `\`${headBranch}\` → \`${baseBranch}\``,
            inline: true,
          },
          {
            name: '설명',
            value: bodyText,
          },
        ],
        footer: {
          text: repoName,
        },
        timestamp: new Date().toISOString(),
      },
    ],
  };

  // 4. 디스코드로 전송 (큐 + 429 재시도 적용)
  try {
    await enqueueDiscordSend(discordMessage);
    console.log(`[성공] PR #${prNumber} (${action}) 알림을 디스코드로 보냈습니다.`);
    res.status(200).send('OK');
  } catch (err) {
    console.error('[에러] 디스코드 전송 실패:', err.message);
    res.status(500).send('Error');
  }
});

app.listen(PORT, () => {
  console.log(`웹훅 서버가 ${PORT}번 포트에서 실행 중입니다.`);
});
