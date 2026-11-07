import { LocalRepository } from './local.js';
import { SharePointRepository } from './sharepoint.js';

export function createRepository(cfg, deps) {
  if (cfg.repository.mode === 'sharepoint') return new SharePointRepository(cfg, deps);
  return new LocalRepository(cfg);
}
