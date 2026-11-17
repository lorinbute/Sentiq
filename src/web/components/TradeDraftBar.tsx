// FD-ORDEREDIT: "Confirmă" / "Renunță" on a trade's line once its SL / TP (or an order's level) was dragged. Confirmă
// checks the changes on the server: errors stay next to the buttons (the lines stay dragged, to correct them); warnings
// open the confirmation; otherwise the changes go out and the result is told.
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { overlayRoot } from '../chart/fullscreen.ts';
import { clsx } from 'clsx';
import { Loader2 } from 'lucide-react';
import type { AccountView } from '../../shared/api-types.ts';
import type { BotLevel, BotLevelMove } from '../../shared/bot.ts';
import type { ModifyPreview, ModifyResult, ModifyStepPlan, ModifyTicket as Ticket } from '../../shared/trading.ts';
import { api, ApiError, errorMessage } from '../api.ts';
import { Modal } from './Modal.tsx';
import { ModifyConfirm, useModifySend } from './ModifyTicket.tsx';
import { DemoBadge } from './OrderTicket.tsx';

/**
 * As TradingView draws them: two boxes like the trade's box beside them (20 px, 12 px text, 3 px corners), "Renunță"
 * outlined and "Confirmă" in the position's blue; taller on a touch screen (a finger's target).
 */
export const BOX = 'relative inline-flex h-5 items-center justify-center rounded-[3px] border px-[7px] text-[12px] leading-none whitespace-nowrap transition-colors pointer-coarse:h-7 pointer-coarse:px-2.5';
const DISCARD = `${BOX} border-line-strong bg-chart text-text hover:bg-hover disabled:opacity-60`;
const CONFIRM = `${BOX} border-[#2962FF] bg-[#2962FF] text-white hover:border-[#1E53E5] hover:bg-[#1E53E5] disabled:cursor-wait`;

export function TradeDraftBar({
  account,
  ticket,
  impact,
  onDiscard,
  onSent,
}: {
  account: AccountView;
  ticket: Omit<Ticket, 'idemKey'>;
  impact?: (s: ModifyStepPlan) => string | null;
  onDiscard: () => void;
  /** The changes went out (all, some or with an unknown outcome): the drafts end, the result is told. */
  onSent: (result: ModifyResult | null, message: string) => void;
}) {
  const { check, send, fresh } = useModifySend(account.id);
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<ModifyPreview | null>(null);
  const busy = check.isPending || send.isPending;
  // A line dragged again: what was said about the previous levels no longer holds.
  const sig = JSON.stringify(ticket);
  useEffect(() => setError(null), [sig]);
  const sigNow = useRef(sig);
  sigNow.current = sig;

  const go = (p: ModifyPreview) => {
    send.mutate(p.ticket, {
      onSuccess: (r) => {
        setConfirming(null);
        fresh();
        // Nothing changed: the lines stay dragged, with why next to the buttons.
        if (r.status === 'failed') {
          setError(r.steps.map((s) => s.message ?? s.what).join(' '));
          return;
        }
        onSent(r, r.status === 'done' ? 'Modificat.' : r.status === 'partial' ? 'Modificat în parte: vezi pașii în Tranzacții, la jurnal.' : 'Rezultat necunoscut: verifică ordinele deschise.');
      },
      onError: (err) => {
        setConfirming(null);
        if (err instanceof ApiError && err.code === 'UNKNOWN_OUTCOME') {
          fresh();
          onSent(null, errorMessage(err));
          return;
        }
        setError(errorMessage(err));
      },
    });
  };
  const confirm = () => {
    setError(null);
    const asked = sig;
    check.mutate(ticket, {
      onSuccess: (p) => {
        // A line dragged again while it was being checked: these levels are no longer the ones shown.
        if (sigNow.current !== asked) return;
        if (p.errors.length) setError(p.errors.join(' '));
        else if (p.warnings.length) setConfirming(p);
        else go(p);
      },
      onError: (err) => setError(errorMessage(err)),
    });
  };

  return (
    <DraftButtons sending={send.isPending} busy={busy} error={error} onDiscard={onDiscard} onConfirm={confirm}>
      {confirming &&
        // On the page (the chart's overlays move with the chart): the warnings, then Confirm.
        createPortal(
          <Modal
            title={
              <span className="inline-flex items-center gap-2">
                Confirmă modificarea
                <DemoBadge env={account.env} />
              </span>
            }
            onClose={() => setConfirming(null)}
            locked={send.isPending}
          >
            <div className="flex flex-col gap-3.5">
              <ModifyConfirm preview={confirming} impact={impact} />
              <div className="flex flex-wrap gap-2 pt-1">
                <button className="btn btn-primary" disabled={send.isPending} onClick={() => go(confirming)}>
                  {send.isPending && <Loader2 size={15} className="animate-spin" aria-hidden />}
                  Confirmă și trimite
                </button>
                <button className="btn" disabled={send.isPending} onClick={() => setConfirming(null)}>
                  Înapoi
                </button>
              </div>
            </div>
          </Modal>,
          overlayRoot(),
        )}
    </DraftButtons>
  );
}

/** "Renunță", then "Confirmă" next to the trade's box (TradingView's order), and why a change was refused under them. */
function DraftButtons({ sending, busy, error, onDiscard, onConfirm, children }: { sending: boolean; busy: boolean; error: string | null; onDiscard: () => void; onConfirm: () => void; children?: ReactNode }) {
  return (
    // Not positioned: its message is placed against the whole overlay (the chart's data-* and variables).
    <div>
      <div className="flex items-center gap-1.5">
        <button type="button" className={DISCARD} disabled={sending} onClick={onDiscard} aria-label="Renunță la modificare">
          Renunță
        </button>
        <button type="button" className={CONFIRM} disabled={busy} onClick={onConfirm} aria-label="Confirmă modificarea" aria-busy={busy}>
          {/* While it is checked / sent: a spinner in its place, the box keeping its width. */}
          <span className={clsx(busy && 'invisible')}>Confirmă</span>
          {busy && <Loader2 size={12} className="absolute animate-spin" aria-hidden />}
        </button>
      </div>
      {error && (
        // Over the chart (nothing moves): under the buttons (above them in the pane's lower half), right-aligned with them,
        // or from the pane's left when there is not enough room on their left (a phone). The chart places it (data-*).
        <div
          role="alert"
          className="absolute top-full mt-1 w-max rounded-lg border border-bear/50 bg-panel-2 px-2.5 py-1.5 text-[12px] text-bear shadow-pop in-data-[msg=left]:left-(--overlay-from) in-data-[msg=left]:max-w-(--overlay-span) in-data-[msg=right]:right-0 in-data-[msg=right]:max-w-[min(340px,var(--overlay-room))] in-data-[open=up]:top-auto in-data-[open=up]:bottom-full in-data-[open=up]:mt-0 in-data-[open=up]:mb-1"
        >
          {error}
        </div>
      )}
      {children}
    </div>
  );
}

/**
 * FIX-BOTDRAG: "Renunță" / "Confirmă" on a bot's stop loss / take profit once dragged. Confirmă sends the new levels to
 * the bot (no order leaves: the bot applies them at its next look); a refusal stays next to the buttons, the lines stay
 * dragged. Sent, the chart has the new levels at once.
 */
export function BotDraftBar({ botId, move, onDiscard, onSent }: { botId: number; move: BotLevelMove; onDiscard: () => void; onSent: (message: string) => void }) {
  const qc = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const send = useMutation({ mutationFn: (m: BotLevelMove) => api.post<BotLevel[]>(`/api/bots/${botId}/levels`, m) });
  // A line dragged again: what was said about the previous levels no longer holds.
  const sig = JSON.stringify(move);
  useEffect(() => setError(null), [sig]);
  const sigNow = useRef(sig);
  sigNow.current = sig;
  const confirm = () => {
    setError(null);
    const asked = sig;
    send.mutate(move, {
      onSuccess: (levels) => {
        qc.setQueryData(['bot-levels'], levels);
        void qc.invalidateQueries({ queryKey: ['bots'] });
        // Dragged again meanwhile: that drag stays, to confirm.
        if (sigNow.current !== asked) return;
        onSent('Modificat: botul folosește noul nivel de la următoarea verificare.');
      },
      onError: (err) => setError(errorMessage(err)),
    });
  };
  return <DraftButtons sending={send.isPending} busy={send.isPending} error={error} onDiscard={onDiscard} onConfirm={confirm} />;
}
