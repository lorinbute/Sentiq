// FD-PAPER: a Paper Trading profile as the trading service sees a platform (TD-TRADING §3): every call goes to the paper
// engine, nothing leaves Sentiq.
import type { InstrumentInfo, ModifyResult, ModifyTicket, OrderPreview, OrderResult, OrderTicket, ReverseTicket, TradeMarket, TradeSymbol } from '../../shared/trading.ts';
import type { CancelInput, ModifyPlan, ReversePlan, Trader } from '../exchange/trading/types.ts';
import type { PaperService } from './service.ts';

export class PaperTrader implements Trader {
  private readonly paper: PaperService;
  private readonly accountId: number;

  constructor(paper: PaperService, accountId: number) {
    this.paper = paper;
    this.accountId = accountId;
  }

  /** The pairs are the chart exchange's (typed, as at a broker): no list. */
  async symbols(_market: TradeMarket): Promise<TradeSymbol[]> {
    return [];
  }

  instrument(market: TradeMarket, symbol: string): Promise<InstrumentInfo> {
    return this.paper.instrument(this.accountId, market, symbol);
  }

  normalize(ticket: OrderTicket): Promise<OrderPreview> {
    return this.paper.normalize(this.accountId, ticket);
  }

  place(preview: OrderPreview): Promise<OrderResult> {
    return this.paper.place(this.accountId, preview);
  }

  cancel(input: CancelInput): Promise<OrderResult> {
    return this.paper.cancel(this.accountId, input);
  }

  normalizeModify(ticket: ModifyTicket): Promise<ModifyPlan> {
    return this.paper.normalizeModify(this.accountId, ticket);
  }

  modify(plan: ModifyPlan): Promise<ModifyResult> {
    return this.paper.modify(this.accountId, plan);
  }

  normalizeReverse(ticket: ReverseTicket): Promise<ReversePlan> {
    return this.paper.normalizeReverse(this.accountId, ticket);
  }

  reverse(plan: ReversePlan): Promise<ModifyResult> {
    return this.paper.reverse(this.accountId, plan);
  }
}
