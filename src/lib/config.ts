import fs from 'node:fs';
import { getConfigPath } from './paths.js';
import { parseYaml } from './yaml.js';
import { type Config, validateConfig } from './validators.js';

export function loadConfig(): Config {
  const configPath = getConfigPath();
  if (!fs.existsSync(configPath)) {
    throw new Error(
      `Config not found at ${configPath}`,
    );
  }
  const raw: unknown = parseYaml(fs.readFileSync(configPath, 'utf-8'), configPath);
  return validateConfig(raw);
}

