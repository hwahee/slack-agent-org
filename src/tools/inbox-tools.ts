/**
 * Inbox tools — cooperative interruption, from the agent's side.
 *
 * New messages never cut into the agent's work. A short notice rides along on
 * its own tool results (the badge, ./server.ts); at a point where stopping is
 * safe — a message sent, a step finished — the agent may look (inbox_peek),
 * fold a message into what it is doing (inbox_take), or set the task aside
 * with a note and attend to the messages first (inbox_yield).
 */
import { formatMessage } from '../inbox/format';
import { s, toDescribedValidator } from '../validation';
import { defineTool, failure, text } from './types';

const PREVIEW_CHARS = 300;

const peek = defineTool({
  name: 'inbox_peek',
  description:
    '아직 처리하지 않은 Slack 메시지를 봅니다(알림 확인). 보기만 하고 아무것도 바꾸지 않습니다. ' +
    '하던 일을 안전하게 멈출 수 있는 지점에서 확인하세요.',
  input: toDescribedValidator(s.object({})),
  run(_args, { inbox, timeZone }) {
    const waiting = inbox.peek();
    if (waiting.length === 0)
      return Promise.resolve({ content: [text('대기 중인 메시지가 없습니다.')] });
    const list = waiting
      .map((m) => formatMessage(m, { timeZone, maxText: PREVIEW_CHARS }))
      .join('\n\n');
    return Promise.resolve({
      content: [
        text(
          `대기 중 ${waiting.length}건:\n\n${list}\n\n` +
            '- 지금 하는 일과 같은 대화이거나 금방 답할 수 있으면: inbox_take로 가져와 이번 턴에 처리\n' +
            '- 하던 일을 잠시 두고 먼저 답해야 하면: inbox_yield (다음 턴에 이어서 재개됨)\n' +
            '- 아니면 하던 일을 계속하세요. 턴이 끝나면 순서대로 받게 됩니다.',
        ),
      ],
    });
  },
});

const take = defineTool({
  name: 'inbox_take',
  description:
    '대기 중인 메시지를 이번 턴으로 가져옵니다. 가져온 메시지는 이번 턴에서 직접 처리(답장)해야 하며, ' +
    '나중에 다시 전달되지 않습니다.',
  input: toDescribedValidator(
    s.object({ ids: s.array(s.string().check(s.minLength(1))).check(s.minLength(1)) }),
  ),
  run({ ids }, { inbox, timeZone }) {
    const taken = inbox.take(ids);
    if (taken.length === 0) {
      return Promise.resolve(
        failure('해당 id의 대기 메시지가 없습니다. inbox_peek로 다시 확인하세요.'),
      );
    }
    const list = taken.map((m) => formatMessage(m, { timeZone })).join('\n\n');
    return Promise.resolve({ content: [text(`가져온 메시지 ${taken.length}건:\n\n${list}`)] });
  },
});

const yieldTurn = defineTool({
  name: 'inbox_yield',
  description:
    '안전한 지점에서 하던 일을 잠시 멈춥니다. note에 어디까지 했고 다음에 무엇을 할지 적으세요. ' +
    '호출한 뒤에는 더 이상 화면을 조작하지 말고 짧게 상태를 말한 뒤 턴을 끝내세요. ' +
    '대기 메시지를 먼저 처리한 다음, 이 note와 함께 이 일로 돌아오게 됩니다.',
  input: toDescribedValidator(
    s.object({ note: s.string().check(s.minLength(1), s.maxLength(2000)) }),
  ),
  run({ note }, { turn }) {
    if (!turn.requestYield(note)) return Promise.resolve(failure('진행 중인 턴이 없습니다.'));
    return Promise.resolve({
      content: [text('일시정지가 예약되었습니다. 화면 조작을 멈추고 지금 턴을 끝내세요.')],
    });
  },
});

export const INBOX_TOOLS = [peek, take, yieldTurn];
