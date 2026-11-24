import { readdir } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { join } from 'node:path';
import type { Command } from '../types.js';

/** Files in the commands folder that are commands: .js (built) or .ts (tsx / tests), not helpers or maps. */
export function isModuleFile(file: string): boolean {
  return /\.(js|ts)$/.test(file) && !file.endsWith('.d.ts') && !file.includes('.test.') && !file.startsWith('_');
}

function isCommand(x: unknown): x is Command {
  const c = x as Command;
  return (
    !!c &&
    typeof c.execute === 'function' &&
    typeof c.data?.name === 'string' &&
    typeof c.data.toJSON === 'function' &&
    typeof c.tier === 'number' &&
    c.tier >= 0 &&
    c.tier <= 5
  );
}

/** Import every file in src/commands (dist/commands once built). Each must `export default` a Command. */
export async function loadCommands(dir: string = fileURLToPath(new URL('../commands/', import.meta.url))): Promise<Map<string, Command>> {
  const commands = new Map<string, Command>();
  const files = (await readdir(dir)).filter(isModuleFile).sort();
  for (const file of files) {
    const mod = (await import(pathToFileURL(join(dir, file)).href)) as { default?: unknown };
    if (!isCommand(mod.default)) throw new Error(`${file} doesn't export a valid command (default export with data, tier and execute).`);
    const name = mod.default.data.name;
    if (commands.has(name)) throw new Error(`Two commands are called /${name} (${file}).`);
    commands.set(name, mod.default);
  }
  return commands;
}
