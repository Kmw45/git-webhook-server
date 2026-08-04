const express = require('express');
const axios = require('axios');
require('dotenv').config();

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;
const DISCORD_WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL;

// ★ 알림을 받을 메인 브랜치 이름 (필요 시 'dev' 추가 가능)
const TARGET_BRANCHES = ['main', 'master']; 

app.post('/webhook', async (req, res) => {
  const event = req.headers['x-github-event'];

  // 1. Push 이벤트가 아니면 무시
  if (event !== 'push') {
    return res.status(200).send('Ignored non-push event');
  }

  const payload = req.body;
  // refs/heads/main -> main 문자열만 추출
  const branch = payload.ref ? payload.ref.replace('refs/heads/', '') : '';

  // 2. main(또는 master) 브랜치가 아니면 알림 안 보내고 무시!
  if (!TARGET_BRANCHES.includes(branch)) {
    console.log(`[무시됨] '${branch}' 브랜치 푸시는 디스코드로 보내지 않습니다.`);
    return res.status(200).send('Ignored branch');
  }

  // 3. 디스코드로 보낼 알림 내용 가공
  const pusher = payload.pusher.name; // 푸시한 사람
  const repoName = payload.repository.full_name; // 레포 이름
  const commits = payload.commits || [];

  if (commits.length === 0) {
    return res.status(200).send('No commits');
  }

  // 커밋 메시지 요약
  const commitListText = commits
    .slice(0, 5) // 최대 5개까지만 표시
    .map(c => `• [${c.id.substring(0, 7)}] ${c.message.split('\n')[0]} (${c.author.name})`)
    .join('\n');

  const extraCount = commits.length > 5 ? `\n...외 ${commits.length - 5}개 커밋` : '';

  // 디스코드 메시지 양식
  const discordMessage = {
    embeds: [
      {
        title: `🚨 [${repoName}] '${branch}' 브랜치에 푸쉬가 발생하였습니다`,
        url: payload.compare,
        color: 0x2ECC71, // 초록색
        fields: [
          {
            name: '작업자',
            value: pusher,
            inline: true,
          },
          {
            name: `포함된 커밋 (${commits.length}개)`,
            value: `${commitListText}${extraCount}`,
          },
        ],
        timestamp: new Date().toISOString(),
      },
    ],
  };

  // 4. 디스코드로 전송
  try {
    await axios.post(DISCORD_WEBHOOK_URL, discordMessage);
    console.log(`[성공] '${branch}' 브랜치 푸시 알림을 디스코드로 보냈습니다.`);
    res.status(200).send('OK');
  } catch (err) {
    console.error('[에러] 디스코드 전송 실패:', err.message);
    res.status(500).send('Error');
  }
});

app.listen(PORT, () => {
  console.log(`웹훅 서버가 ${PORT}번 포트에서 실행 중입니다.`);
});