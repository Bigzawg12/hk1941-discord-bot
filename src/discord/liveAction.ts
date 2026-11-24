import type { ChatInputCommandInteraction } from 'discord.js';
import { describeResult } from '../bridge/client.js';
import { BROADCAST, type ActionArgs, type BridgeAction } from '../bridge/schema.js';
import type { RobloxUser } from '../roblox/users.js';
import type { CommandContext } from '../types.js';
import { UserFacingError } from '../util/errors.js';
import { requireActor } from './helpers.js';

/**
 * Send one live action to the game through the bridge, tell the staff member how it went, and
 * write the audit entry. Shared by /announce, /kick, /ban, /unban, /release, /points, /award, /event.
 */
export async function runLiveAction<A extends BridgeAction>(
  ctx: CommandContext<ChatInputCommandInteraction>,
  act: A,
  args: ActionArgs[A],
  opts: { target?: RobloxUser; label: string; detail?: string; noAckHint?: string },
): Promise<{ ok: boolean; text: string; eventId?: string }> {
  const { interaction, services } = ctx;
  const actor = requireActor(ctx);
  if (opts.target && opts.target.id === actor.r && actor.t < 5 && act !== 'announce') {
    throw new UserFacingError("You can't do that to your own account.");
  }
  if (!interaction.deferred && !interaction.replied) await interaction.deferReply();

  const res = await services.bridge.send(act, actor, args, opts.target?.id);
  const acks = services.config.bridge.acksEnabled;
  let text = describeResult(res, acks, BROADCAST.has(act));
  if (acks && !res.ack && opts.noAckHint) text += `\n${opts.noAckHint}`;
  const ok = !acks || res.ack?.ok !== false;

  await services.audit.record({
    actorId: interaction.user.id,
    actorName: `${interaction.user.username} / ${actor.n}`,
    action: opts.label,
    target: opts.target ? `${opts.target.name} (${opts.target.id})` : undefined,
    detail: [opts.detail, `Result: ${text}`, `Bridge id: ${res.id}`].filter(Boolean).join('\n'),
    ok,
    guildId: interaction.guildId,
  });
  return { ok, text, eventId: res.ack?.eventId };
}
