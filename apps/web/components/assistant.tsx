'use client';

/**
 * The assistant launcher and panel. ADR-0020.
 *
 * NON-MODAL, DELIBERATELY. The plan said Radix Dialog, for the focus trap `DocumentViewer`
 * lacks. On building it that is the wrong control here: a document preview is modal because you
 * are looking at one thing, whereas the commonest use of an assistant is reading the answer
 * against the screen behind it - "who is off next week" while looking at the team page. Trapping
 * focus would make that impossible and would be worse accessibility, not better. So it is
 * `role="dialog"` with `aria-modal="false"`, Escape closes it, focus moves to the input on open
 * and returns to the launcher on close - which is the correct pattern for a non-modal panel and
 * needs no library.
 *
 * THE ANSWER IS PROSE, AND THERE IS NOTHING ELSE ON SCREEN (DEC-141). Two changes got here. The
 * model could not see a value at all until DEC-140, so the sentence could only introduce a table;
 * then it could, so the sentence led and the table folded behind a toggle; now the table is gone
 * from the panel entirely, because that is what was asked for.
 *
 * SAY WHAT THAT COSTS, because it is not visible in this file. The table was the CHECK on the
 * answer - rendered from Postgres, never derived from the model's output, so a wrong sentence sat
 * beside right numbers. A reader now has only the prose. The standing caveat that said so was
 * REMOVED on request (DEC-157), so nothing on screen marks the answer as machine-written - the
 * panel title and subtitle are the only remaining context. The `rows` event still arrives and
 * the API is unchanged; this component simply does not keep the values or draw them.
 *
 * THE PANEL IS A FIXED HEIGHT, not a max-height. A panel sized to its content grows as each turn
 * lands - which reads as the window jumping every time a question is asked, and moves the input
 * out from under the cursor mid-sentence.
 *
 * POSITION: `bottom-6 end-6`, never `right-6`. `i18n:test` check R1 bans physical-direction
 * utilities, and the logical property is also correct: in Arabic the launcher belongs at the
 * bottom-LEFT, which is where `end-6` puts it.
 */

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { api, ApiError } from '@/lib/api';
import { useT } from '@/lib/i18n';
import type { MessageKey } from '@/lib/i18n/dictionary';
import { Button, inputCls } from './ui';

/**
 * What survives of the `rows` event once the table is gone.
 *
 * The columns and the values are DELIBERATELY NOT KEPT. They arrive, they are counted, and they
 * are dropped on the floor - so the panel holds no personal data it does not draw, and a future
 * change that renders `turn.result` cannot leak a column by accident.
 */
interface ResultMeta {
  note: string | null;
  rowCount: number;
}

interface Turn {
  id: number;
  question: string;
  sentence: string | null;
  result: ResultMeta | null;
  refusal: { code: string; message: string } | null;
  tool: string | null;
  pending: boolean;
}

/*
 * A DELIBERATELY TINY MARKDOWN SUBSET: `**bold**` and "- " bullets. Nothing else (DEC-151).
 *
 * WHY ANY AT ALL. Four people of attendance written as one paragraph is a wall of numbers -
 * "Vishnu Ravi was present for 5 days, late 1 day, worked from home 1 day, and absent 0 days.
 * Priya Menon was present for..." - and nobody reads it. One bullet per person is scannable,
 * and it is a PRESENTATION change: every figure still comes from the masked rows.
 *
 * WHY SO LITTLE. This renders MODEL OUTPUT, so the parser is a trust boundary. It builds REACT
 * ELEMENTS from strings and never touches `dangerouslySetInnerHTML`, so there is no HTML
 * injection path at all - the worst a hostile string can do is look odd. A full markdown
 * library would be a dependency (CLAUDE.md: record why) and a much larger surface for one
 * panel. Headings, tables, links and images are all deliberately absent; the answer prompt asks
 * for the same two constructs, so what arrives and what renders match.
 *
 * Anything unrecognised falls through as literal text rather than being swallowed, which is the
 * honest failure mode: a stray `#` shows as `#` instead of silently vanishing.
 */
type Block = { kind: 'p'; text: string } | { kind: 'ul'; items: string[] };

const parseAnswer = (text: string): Block[] => {
  const blocks: Block[] = [];
  let items: string[] = [];

  const flush = () => {
    if (items.length) { blocks.push({ kind: 'ul', items }); items = []; }
  };

  for (const raw of text.split('\n')) {
    const line = raw.trimEnd();
    // `-`, `*` and `•` all start a bullet: models mix them, and the alternative is a stray
    // asterisk in the middle of an answer.
    const bullet = /^\s*[-*\u2022]\s+(.*)$/.exec(line);
    if (bullet) { items.push(bullet[1]); continue; }

    flush();
    if (line.trim()) blocks.push({ kind: 'p', text: line });
  }
  flush();
  return blocks;
};

/**
 * Inline `**bold**`, as elements. Never HTML.
 *
 * ANY SURVIVING `**` IS STRIPPED, NOT SHOWN. A pair that this regex cannot match - three
 * asterisks, a pair spanning a line break, an asterisk inside the bolded run - would otherwise
 * reach the reader as literal characters, and `**Total records found: 5**` on screen is a bug
 * to them however defensible it is to us. Bold is a nicety; leaking punctuation is not, so the
 * unparsed case degrades to plain text rather than to noise.
 *
 * A SINGLE asterisk is left alone: it is a footnote mark, a multiplication sign, or part of a
 * value, and removing it would corrupt content rather than tidy it.
 */
const stripStars = (text: string): string => text.split("**").join("");

const inlineNodes = (text: string, key: string): ReactNode[] => {
  const out: ReactNode[] = [];
  const re = /\*\*([^*]+)\*\*/g;
  let last = 0;
  let n = 0;
  let m: RegExpExecArray | null = re.exec(text);

  while (m !== null) {
    if (m.index > last) out.push(stripStars(text.slice(last, m.index)));
    out.push(
      <strong key={key + "-b" + n} className="font-semibold text-ink-900">{m[1]}</strong>,
    );
    n += 1;
    last = m.index + m[0].length;
    m = re.exec(text);
  }
  if (last < text.length) out.push(stripStars(text.slice(last)));
  return out;
};

/**
 * Hide an UNCLOSED `**` while the answer is still streaming.
 *
 * Counting matters. The obvious form - strip a trailing `**...` with a regex - removes the
 * CLOSING pair of a completed bold instead, so `- **Vishnu Ravi** - 6 days` renders as
 * `- **Vishnu Ravi - 6 days` with the asterisks showing. Only an ODD number of pairs means one
 * is still open, and then it is the LAST one that has no partner.
 */
const hideOpenBold = (text: string): string => {
  const pairs = text.match(/\*\*/g);
  if (!pairs || pairs.length % 2 === 0) return text;
  const i = text.lastIndexOf('**');
  return text.slice(0, i) + text.slice(i + 2);
};

const Caret = () => (
  <span
    aria-hidden
    className="ms-0.5 inline-block h-[1em] w-[2px] translate-y-[0.15em] animate-pulse bg-ink-400 align-baseline"
  />
);

/**
 * The caret rides the LAST block, so it trails the text being written rather than sitting on a
 * line of its own under a bullet list.
 */
const renderAnswer = (text: string, pending: boolean): ReactNode[] => {
  const blocks = parseAnswer(text);
  return blocks.map((block, i) => {
    const last = i === blocks.length - 1;
    if (block.kind === 'ul') {
      return (
        <ul key={"u" + i} className="my-1 space-y-1 ps-1">
          {block.items.map((item, j) => (
            <li key={"u" + i + "i" + j} className="flex gap-2">
              <span aria-hidden className="mt-[0.55em] h-1 w-1 shrink-0 rounded-full bg-ink-300" />
              <span>
              {inlineNodes(item, "u" + i + "i" + j)}
              {pending && last && j === block.items.length - 1 && <Caret />}
              </span>
            </li>
          ))}
        </ul>
      );
    }
    return (
      <p key={"p" + i} className="mb-1.5 last:mb-0">
        {inlineNodes(block.text, "p" + i)}
        {pending && last && <Caret />}
      </p>
    );
  });
};

/*
 * The assistant side of the conversation: one surface, four states (thinking, answer, refusal,
 * nothing-matched). Defined once because four copies of a class list drift, and a reply that
 * changes shape as it resolves reads as a glitch.
 *
 * `rounded-es-sm` is the LOGICAL corner - start-end - so the clipped edge sits against the
 * assistant's side of the panel and moves with `dir` in Arabic. `ring` rather than `border`,
 * so the outline costs no layout and the bubble keeps its exact height while text streams in.
 */
const ASSISTANT_BUBBLE =
  'max-w-[92%] rounded-2xl rounded-es-sm bg-ink-50 px-3.5 py-2.5 text-[13.5px] ' +
  'leading-relaxed ring-1 ring-inset ring-ink-100';

const ChatIcon = () => (
  <svg width="20" height="20" viewBox="0 0 20 20" fill="none" aria-hidden>
    <path
      d="M17 9.5c0 3-3.1 5.5-7 5.5-.8 0-1.6-.1-2.3-.3L3 16l1.2-2.8C3.4 12.2 3 10.9 3 9.5 3 6.5 6.1 4 10 4s7 2.5 7 5.5Z"
      stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"
    />
  </svg>
);

const CloseIcon = () => (
  <svg width="20" height="20" viewBox="0 0 20 20" fill="none" aria-hidden>
    <path d="M5 5l10 10M15 5L5 15" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
  </svg>
);

export function Assistant() {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [question, setQuestion] = useState('');
  const [turns, setTurns] = useState<Turn[]>([]);
  const [busy, setBusy] = useState(false);

  const panelRef = useRef<HTMLDivElement>(null);
  const launcherRef = useRef<HTMLButtonElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const logRef = useRef<HTMLDivElement>(null);
  const nextId = useRef(1);

  // Escape closes, and focus goes back where it came from - a panel that dumps focus at the top
  // of the document is how a keyboard user loses their place.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { setOpen(false); launcherRef.current?.focus(); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  /*
   * CLICK OUTSIDE CLOSES IT.
   *
   * Note the tension with the panel being non-modal, which the header explains: it is
   * deliberately readable ALONGSIDE the page, so somebody can check an answer against the
   * screen behind it. Dismiss-on-outside-click means any interaction with that page - a
   * scroll on a scrollbar, selecting a figure to compare - now closes the panel. That is the
   * behaviour that was asked for, and nothing is lost when it happens: the conversation lives
   * in component state, so reopening shows every previous turn.
   *
   * `pointerdown`, not `click`. A click fires after the button up, by which time a control
   * inside the panel may already have unmounted and the target would test as outside.
   *
   * THE LAUNCHER IS EXCLUDED, or clicking it while open would close the panel here and then
   * the button own handler would toggle it straight back open.
   */
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: PointerEvent) => {
      const target = e.target as Node | null;
      if (!target) return;
      if (panelRef.current?.contains(target)) return;
      if (launcherRef.current?.contains(target)) return;
      setOpen(false);
    };
    document.addEventListener('pointerdown', onPointerDown);
    return () => document.removeEventListener('pointerdown', onPointerDown);
  }, [open]);

  useEffect(() => { if (open) inputRef.current?.focus(); }, [open]);

  /*
   * Follow the answer as it types itself out - but ONLY if the reader is already at the bottom.
   *
   * Before streaming, a turn produced one state change and pinning to the bottom was always
   * right. An answer now lands over a second or two in a dozen updates, so an unconditional
   * scroll would yank the view back down every fragment while somebody is reading an earlier
   * turn. The threshold is generous: anywhere within a line and a half of the end counts as
   * "at the bottom", so the common case still follows.
   */
  const stickToBottom = useRef(true);
  const onLogScroll = useCallback(() => {
    const el = logRef.current;
    if (el) stickToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
  }, []);

  useEffect(() => {
    if (stickToBottom.current && logRef.current) {
      logRef.current.scrollTop = logRef.current.scrollHeight;
    }
  }, [turns]);

  const send = useCallback(async () => {
    const q = question.trim();
    if (!q || busy) return;

    const id = nextId.current++;
    setTurns((prev) => [...prev, {
      id, question: q, sentence: null, result: null, refusal: null, tool: null, pending: true,
    }]);
    setQuestion('');
    setBusy(true);
    stickToBottom.current = true;   // asking always returns you to the newest turn

    const patch = (fn: (turn: Turn) => Turn) =>
      setTurns((prev) => prev.map((x) => (x.id === id ? fn(x) : x)));

    try {
      await api.stream('/assistant/ask', { question: q }, (event, data: any) => {
        if (event === 'tool') patch((x) => ({ ...x, tool: data?.name ?? null }));
        else if (event === 'rows') {
          // The values are not stored - see ResultMeta. Only how many there were, and any note
          // the tool attached (k-anonymity suppression, an applied default).
          patch((x) => ({
            ...x,
            result: { note: data?.note ?? null, rowCount: data?.rowCount ?? 0 },
          }));
        } else if (event === 'token') {
          // APPEND, never replace. The answer arrives one fragment at a time now, so assigning
          // would leave only the last word of every sentence on screen.
          const text = typeof data?.text === 'string' ? data.text : '';
          if (text) patch((x) => ({ ...x, sentence: (x.sentence ?? '') + text }));
        }
        else if (event === 'refusal') {
          patch((x) => ({ ...x, refusal: { code: data?.code ?? 'no_tool', message: data?.message ?? '' } }));
        } else if (event === 'done') patch((x) => ({ ...x, pending: false }));
      });
    } catch (e) {
      const message = e instanceof ApiError ? e.message : t('chat.error');
      patch((x) => ({ ...x, refusal: { code: 'provider_error', message }, pending: false }));
    } finally {
      patch((x) => ({ ...x, pending: false }));
      setBusy(false);
    }
  }, [question, busy, t]);

  return (
    <>
      <button
        ref={launcherRef}
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-controls="hrm-assistant-panel"
        aria-label={open ? t('chat.close') : t('chat.open')}
        className="fixed bottom-6 end-6 z-50 flex h-12 w-12 items-center justify-center rounded-full bg-ink-900 text-white shadow-lg transition-colors hover:bg-ink-800 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink-900"
      >
        {open ? <CloseIcon /> : <ChatIcon />}
      </button>

      {open && (
        <div
          ref={panelRef}
          id="hrm-assistant-panel"
          role="dialog"
          aria-modal="false"
          aria-label={t('chat.title')}
          className="fixed bottom-24 end-6 z-50 flex h-[min(34rem,calc(100dvh-9rem))] w-[min(26rem,calc(100vw-3rem))] flex-col overflow-hidden rounded-2xl border border-ink-200/70 bg-white shadow-2xl"
        >
          <div className="flex shrink-0 items-start justify-between gap-3 border-b border-ink-100 px-4 py-3">
            <div className="min-w-0">
              <h2 className="text-[15px] font-semibold text-ink-900">{t('chat.title')}</h2>
              <p className="mt-0.5 text-[12.5px] text-ink-500">{t('chat.subtitle')}</p>
            </div>
            {turns.length > 0 && (
              <Button size="sm" variant="ghost" onClick={() => setTurns([])}>
                {t('chat.clear')}
              </Button>
            )}
          </div>

          <div
            ref={logRef}
            onScroll={onLogScroll}
            className="min-h-0 flex-1 overflow-y-auto px-4 py-3"
          >
            {turns.length === 0 && (
              <div className="py-2">
                <p className="text-[13.5px] font-medium text-ink-800">{t('chat.emptyTitle')}</p>
                <p className="mt-1 text-[13px] text-ink-500">{t('chat.emptyHint')}</p>
                <ul className="mt-3 space-y-1.5">
                  {(['chat.eg1', 'chat.eg2'] as MessageKey[]).map((k) => (
                    <li key={k}>
                      <button
                        type="button"
                        onClick={() => setQuestion(t(k))}
                        className="w-full rounded-full bg-ink-50 px-3.5 py-2 text-start text-[13px] text-ink-600 ring-1 ring-inset ring-ink-100 transition-colors hover:bg-ink-100 hover:text-ink-800"
                      >
                        {t(k)}
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {turns.map((turn) => (
              <div key={turn.id} className="mb-5 flex flex-col gap-1.5 last:mb-0">
                {/*
                  * THE ASKED QUESTION, on the asker's side.
                  *
                  * `justify-end` and the logical radius `rounded-ee-sm` are both DIRECTION-AWARE:
                  * in Arabic the bubble moves to the left edge and the clipped corner follows it,
                  * with no second rule. A physical `mr-`/`text-right` would not, which is what
                  * `i18n:test` check R1 exists to stop.
                  *
                  * `max-w` under 100% is what makes it read as a message rather than a banner -
                  * the ragged edge is the signal that somebody said it.
                  */}
                <div className="flex justify-end">
                  <p className="max-w-[85%] whitespace-pre-wrap rounded-2xl rounded-ee-sm bg-ink-900 px-3.5 py-2 text-[13px] leading-snug text-white">
                    {turn.question}
                  </p>
                </div>

                {/*
                  * The waiting state lasts until the FIRST FRAGMENT, not until the rows arrive.
                  * Keying it off `result` would clear the indicator the moment the lookup
                  * finished and leave a blank gap for the length of the model call.
                  *
                  * It sits in the SAME bubble the answer will occupy, so the reply grows in place
                  * instead of the layout jumping when the first token lands.
                  */}
                {turn.pending && !turn.sentence && !turn.refusal && (
                  <div className="flex justify-start">
                    <p className={ASSISTANT_BUBBLE + ' text-ink-400'}>
                      <span className="inline-flex items-center gap-1">
                        <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-ink-300" />
                        <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-ink-300 [animation-delay:150ms]" />
                        <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-ink-300 [animation-delay:300ms]" />
                        <span className="ms-1">{t('chat.thinking')}</span>
                      </span>
                    </p>
                  </div>
                )}

                {turn.refusal && (
                  <div className="flex justify-start">
                    <div className="max-w-[92%] rounded-2xl rounded-es-sm bg-amber-50 px-3.5 py-2.5 ring-1 ring-inset ring-amber-200">
                      <p className="text-[13px] leading-relaxed text-ink-800">{turn.refusal.message}</p>
                    </div>
                  </div>
                )}

                {/*
                  * The answer, growing a fragment at a time, in the two-construct subset
                  * `renderAnswer` understands (DEC-151).
                  *
                  * A HALF-WRITTEN `**` IS HIDDEN WHILE STREAMING. The fragments arrive mid-token,
                  * so an opening `**` lands before its closing pair and would flash as literal
                  * asterisks on every bolded name. Dropping a trailing unmatched pair costs
                  * nothing - the next fragment brings it back as real bold.
                  */}
                {turn.sentence && (
                  <div className="flex justify-start">
                    <div
                      className={ASSISTANT_BUBBLE + ' text-ink-800'}
                      aria-live="polite"
                      aria-atomic="false"
                    >
                      {renderAnswer(
                        turn.pending ? hideOpenBold(turn.sentence) : turn.sentence,
                        turn.pending,
                      )}
                    </div>
                  </div>
                )}

                {/* Nothing matched, and the model said nothing either. */}
                {turn.result && turn.result.rowCount === 0 && !turn.refusal && !turn.sentence && (
                  <div className="flex justify-start">
                    <p className={ASSISTANT_BUBBLE + ' text-ink-500'}>{t('chat.noRows')}</p>
                  </div>
                )}

                {/*
                  * The note is NOT in a bubble. It is the system talking about the answer - the
                  * period covered, whose records these are, what was suppressed - and giving it
                  * the same surface as the answer would make it read as more of the reply.
                  */}
                {turn.result?.note && (
                  <p className="px-1 text-[11.5px] leading-relaxed text-ink-400">{turn.result.note}</p>
                )}
              </div>
            ))}
          </div>

          <form
            onSubmit={(e) => { e.preventDefault(); void send(); }}
            className="shrink-0 border-t border-ink-100 px-4 py-3"
          >
            <div className="flex items-end gap-2">
              <label htmlFor="hrm-assistant-input" className="sr-only">{t('chat.inputLabel')}</label>
              <input
                id="hrm-assistant-input"
                ref={inputRef}
                value={question}
                onChange={(e) => setQuestion(e.target.value)}
                maxLength={2000}
                placeholder={t('chat.placeholder')}
                className={`${inputCls} mt-0`}
              />
              <Button type="submit" size="sm" busy={busy} disabled={!question.trim()}>
                {t('chat.send')}
              </Button>
            </div>
          </form>
        </div>
      )}
    </>
  );
}
