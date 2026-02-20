import path from 'node:path';
import { fileURLToPath } from 'node:url';

export function getImportMetaDirname(meta: ImportMeta): string {
  const maybeDirname = (meta as any).dirname;
  if (typeof maybeDirname === 'string' && maybeDirname.length > 0) return maybeDirname;
  return path.dirname(fileURLToPath(meta.url));
}
