import { randomBytes } from 'node:crypto';
import { MESSAGE_LIMIT_BYTES } from '../roblox/messaging.js';

/**
 * Wire format between the bot and roblox/DiscordBridge.server.luau.
 *
 * Transport: MessagingService topic BRIDGE_TOPIC (default "HK1941Discord"), one JSON string per message.
 * Results:   the bridge writes an acknowledgement to MemoryStore sorted map BRIDGE_ACK_MAP
 *            (default "HK1941_DiscordBridge") under key "msg_<id>", which the bot polls.
 *
 * Bump BRIDGE_VERSION (here AND in the Luau file) when the shape changes; the bridge ignores other versions.
 */
export const BRIDGE_VERSION = 1;

export const BRIDGE_ACTIONS = [
  'announce',
  'kick',
  'ban',
  'unban',
  'release',
  'points',
  'award',
  'certify',
  'event_add',
  'event_cancel',
] as const;
export type BridgeAction = (typeof BRIDGE_ACTIONS)[number];

/** Who asked. The bridge uses `r` (the staff member's linked Roblox account) to filter text and `t` for tier checks. */
export interface BridgeActor {
  /** Discord user ID (audit only) */
  d: string;
  /** linked Roblox user ID */
  r: number;
  /** linked Roblox username (shown in game; already moderated by Roblox) */
  n: string;
  /** staff tier 0-5 */
  t: number;
}

/** Arguments per action. Keep names short: the whole message must fit in 1 kB. */
export interface ActionArgs {
  /** every server shows the text (HKAdmin Notify "announce") */
  announce: { text: string };
  kick: { reason: string };
  /** secs 0 = permanent; written to HK1941_Global "HK1941_Bans/u<id>" like ;ban */
  ban: { secs: number; reason: string };
  unban: Record<string, never>;
  /** MPControl "release", or a queued profile message if the prisoner is offline */
  release: Record<string, never>;
  /** ServiceControl "adjust" (n may be negative) */
  points: { n: number; reason: string };
  /** MedalControl "award" / "revoke" */
  award: { medal: string; cite: string; remove: boolean };
  /** MedalControl "certify" / "uncertify" */
  certify: { tab: string; remove: boolean };
  /** HK1941_Global "HK1941_Events/list", then publish HK1941Events "changed" so HKAdmin reloads */
  event_add: { start: number; title: string; detail: string };
  event_cancel: { eventId: string };
}

/** Actions aimed at one Roblox user; `tgt` is required for these. */
export const TARGETED: ReadonlySet<BridgeAction> = new Set(['kick', 'ban', 'unban', 'release', 'points', 'award', 'certify']);

/** Actions every server carries out (each server adds 1 to the ack's `n`). */
export const BROADCAST: ReadonlySet<BridgeAction> = new Set(['announce']);

export interface BridgeMessage<A extends BridgeAction = BridgeAction> {
  v: typeof BRIDGE_VERSION;
  /** unique id; also the ack key "msg_<id>" */
  id: string;
  /** sent at (unix seconds) */
  ts: number;
  /** servers ignore the message after this (unix seconds) */
  exp: number;
  act: A;
  by: BridgeActor;
  tgt?: number;
  a: ActionArgs[A];
}

/** What the bridge writes back. */
export interface BridgeAck {
  /** "claimed" while a server is working on it, "done" when finished */
  s: 'claimed' | 'done';
  ok?: boolean;
  /** result text, already filtered in game */
  m?: string;
  /** JobId of the server that handled it */
  job?: string;
  t?: number;
  /** broadcast actions: number of servers that carried it out */
  n?: number;
  /** event_add: the new event's id */
  eventId?: string;
}

export function newMessageId(): string {
  return randomBytes(9).toString('base64url'); // 12 chars of [A-Za-z0-9_-]
}

export function buildMessage<A extends BridgeAction>(
  act: A,
  by: BridgeActor,
  args: ActionArgs[A],
  opts: { tgt?: number; nowSec: number; ttlSec: number; id?: string },
): BridgeMessage<A> {
  if (!BRIDGE_ACTIONS.includes(act)) throw new Error(`Unknown bridge action ${act}`);
  if (TARGETED.has(act) && !(typeof opts.tgt === 'number' && opts.tgt > 0)) throw new Error(`${act} needs a target user id`);
  if (!(by.r > 0)) throw new Error('The acting staff member needs a linked Roblox account');
  const msg: BridgeMessage<A> = {
    v: BRIDGE_VERSION,
    id: opts.id ?? newMessageId(),
    ts: opts.nowSec,
    exp: opts.nowSec + opts.ttlSec,
    act,
    by: { d: by.d, r: by.r, n: by.n.slice(0, 40), t: Math.max(0, Math.min(5, Math.floor(by.t))) },
    a: args,
  };
  if (opts.tgt !== undefined) msg.tgt = opts.tgt;
  return msg;
}

/** JSON-encode and check the 1 kB MessagingService limit (with a little headroom). */
export function encodeMessage(msg: BridgeMessage): string {
  const json = JSON.stringify(msg);
  const size = Buffer.byteLength(json, 'utf8');
  if (size > MESSAGE_LIMIT_BYTES - 24) {
    throw new Error(`Bridge message is ${size} bytes, over the ${MESSAGE_LIMIT_BYTES - 24} byte budget. Shorten the text.`);
  }
  return json;
}

export const ackKey = (id: string) => `msg_${id}`;
