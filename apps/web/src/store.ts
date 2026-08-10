import type {
  Candle,
  DepthSnapshot,
  FeedStatus,
  PriceTick,
  ServerMessage,
  Trade,
} from '@sol-warzone/protocol';

/** Trades kept for display; the battle sim consumes them as they arrive. */
const TRADE_HISTORY = 60;

export interface MarketState {
  status: FeedStatus | null;
  pair: string;
  protocol: number | null;
  price: PriceTick | null;
  depth: DepthSnapshot | null;
  candles: readonly Candle[];
  /** Newest first. */
  trades: readonly Trade[];
  counts: Record<'tick' | 'trade' | 'depth' | 'snapshot' | 'status', number>;
  buyUsd: number;
  sellUsd: number;
  lastMessageAt: number | null;
}

const emptyState = (): MarketState => ({
  status: null,
  pair: 'SOL/USDC',
  protocol: null,
  price: null,
  depth: null,
  candles: [],
  trades: [],
  counts: { tick: 0, trade: 0, depth: 0, snapshot: 0, status: 0 },
  buyUsd: 0,
  sellUsd: 0,
  lastMessageAt: null,
});

/**
 * Accumulates wire messages into the state the UI reads.
 *
 * Deliberately free of DOM and timers so it can be driven straight from a
 * recorded message log in tests.
 */
export class MarketStore {
  #state = emptyState();

  get state(): MarketState {
    return this.#state;
  }

  /** Net USD pressure since connect: positive means buyers. */
  get netUsd(): number {
    return this.#state.buyUsd - this.#state.sellUsd;
  }

  reset(): void {
    this.#state = emptyState();
  }

  apply(message: ServerMessage, receivedAt = Date.now()): void {
    const state = this.#state;
    state.lastMessageAt = receivedAt;

    switch (message.type) {
      case 'hello':
        state.pair = message.pair;
        state.protocol = message.protocol;
        state.status = message.status;
        break;

      case 'status':
        state.status = message.status;
        state.counts.status++;
        break;

      case 'snapshot':
        state.status = message.status;
        state.price = message.price;
        state.depth = message.depth;
        state.candles = message.candles;
        // The snapshot replays history; it must not be counted as live flow,
        // otherwise the pressure totals start with a phantom imbalance.
        state.trades = [...message.recentTrades].reverse().slice(0, TRADE_HISTORY);
        state.counts.snapshot++;
        break;

      case 'tick':
        state.price = message;
        state.counts.tick++;
        break;

      case 'depth':
        state.depth = message;
        state.counts.depth++;
        break;

      case 'trade':
        state.trades = [message, ...state.trades].slice(0, TRADE_HISTORY);
        state.counts.trade++;
        if (message.side === 'buy') state.buyUsd += message.usd;
        else state.sellUsd += message.usd;
        break;

      case 'round':
        break;
    }
  }
}
