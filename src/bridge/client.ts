import type { BotConfig } from '../config.js';
import type { Logger } from '../logger.js';
import type { MessagingPublisher } from '../roblox/messaging.js';
import type { SortedMapReader } from '../roblox/memoryStore.js';
import { sleep as realSleep } from '../util/cache.js';
import {
  ackKey,
  BROADCAST,
  buildMessage,
  encodeMessage,
  type ActionArgs,
  type BridgeAck,
  type BridgeAction,
  type BridgeActor,
} from './schema.js';

export interface BridgeResult {
  id: string;
  /** null when acks are off, or nothing answered in time (no live server, or the bridge isn't installed) */
  ack: BridgeAck | null;
  waitedMs: number;
}

export interface BridgeDeps {
  publisher: MessagingPublisher;
  acks?: SortedMapReader;
  config: BotConfig['bridge'];
  logger?: Logger;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  pollMs?: number;
  /** how long to keep counting servers for a broadcast after the first answer */
  broadcastSettleMs?: number;
}

/** Sends live actions to the game and waits (briefly) for a server to say how it went. */
export class BridgeClient {
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly pollMs: number;
  private readonly settleMs: number;

  constructor(private readonly deps: BridgeDeps) {
    this.now = deps.now ?? Date.now;
    this.sleep = deps.sleep ?? realSleep;
    this.pollMs = deps.pollMs ?? 1500;
    this.settleMs = deps.broadcastSettleMs ?? 4000;
  }

  async send<A extends BridgeAction>(act: A, by: BridgeActor, args: ActionArgs[A], tgt?: number): Promise<BridgeResult> {
    const { config } = this.deps;
    const msg = buildMessage(act, by, args, { tgt, nowSec: Math.floor(this.now() / 1000), ttlSec: config.messageTtlSec });
    await this.deps.publisher.publish(config.topic, encodeMessage(msg));
    this.deps.logger?.info({ id: msg.id, act, tgt, by: { d: by.d, r: by.r, t: by.t } }, 'bridge message published');

    if (!config.acksEnabled || !this.deps.acks) return { id: msg.id, ack: null, waitedMs: 0 };
    const started = this.now();
    const ack = await this.waitForAck(msg.id, BROADCAST.has(act));
    return { id: msg.id, ack, waitedMs: this.now() - started };
  }

  /** Poll the ack map until the action is done (or, for broadcasts, until the server count settles). */
  async waitForAck(id: string, broadcast: boolean): Promise<BridgeAck | null> {
    const { config } = this.deps;
    const deadline = this.now() + config.ackTimeoutMs;
    let last: BridgeAck | null = null;
    let firstDoneAt: number | null = null;
    while (this.now() < deadline) {
      await this.sleep(this.pollMs);
      try {
        const item = await this.deps.acks!.getItem<BridgeAck>(config.ackMap, ackKey(id));
        if (item?.value && typeof item.value === 'object') last = item.value;
      } catch (err) {
        this.deps.logger?.warn({ err, id }, 'reading bridge ack failed');
      }
      if (last?.s === 'done') {
        if (!broadcast) return last;
        firstDoneAt ??= this.now();
        if (this.now() - firstDoneAt >= this.settleMs) return last;
      }
    }
    return last;
  }
}

/** One line for staff describing a bridge result. */
export function describeResult(res: BridgeResult, acksEnabled: boolean, broadcast = false): string {
  if (!acksEnabled) return 'Sent to the game. (Acknowledgements are off, so there is no confirmation.)';
  const a = res.ack;
  if (!a) {
    return 'Sent, but no game server answered. Either no server is running, or the Discord bridge script is not installed.';
  }
  if (a.s === 'claimed') return 'A server picked this up but did not report back in time. Check in game.';
  const where = a.job ? ` (server ${a.job.slice(0, 8)})` : '';
  if (broadcast) return `${a.ok === false ? 'Failed' : 'Done'} on ${a.n ?? 1} server${(a.n ?? 1) === 1 ? '' : 's'}.${a.m ? ` ${a.m}` : ''}`;
  return `${a.ok === false ? '✗' : '✓'} ${a.m ?? (a.ok === false ? 'Failed.' : 'Done.')}${where}`;
}
