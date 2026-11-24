import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { Client } from 'discord.js';
import type { BotEvent, Services } from '../types.js';
import { isModuleFile } from './commands.js';

/** Import every file in src/events and attach it to the client. Each must `export default` a BotEvent. */
export async function loadEvents(
  client: Client,
  services: Services,
  dir: string = fileURLToPath(new URL('../events/', import.meta.url)),
): Promise<string[]> {
  const names: string[] = [];
  for (const file of (await readdir(dir)).filter(isModuleFile).sort()) {
    const mod = (await import(pathToFileURL(join(dir, file)).href)) as { default?: BotEvent };
    const ev = mod.default;
    if (!ev || typeof ev.name !== 'string' || typeof ev.execute !== 'function') throw new Error(`${file} doesn't export a valid event.`);
    const handler = (...args: unknown[]) => {
      Promise.resolve((ev.execute as (s: Services, ...a: unknown[]) => unknown)(services, ...args)).catch((err: unknown) =>
        services.logger.error({ err, event: ev.name }, 'event handler failed'),
      );
    };
    if (ev.once) client.once(ev.name, handler);
    else client.on(ev.name, handler);
    names.push(`${ev.name}${ev.once ? ' (once)' : ''}`);
  }
  return names;
}
