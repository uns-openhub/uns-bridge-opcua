import { randomUUID } from 'node:crypto';
import { access, mkdir, readFile, open, rename, unlink } from 'node:fs/promises';
import path from 'node:path';
import { runtimeConfigSnapshotSchema, type RuntimeConfigSnapshot } from '../config/runtime-config.js';

export class RuntimeConfigStore {
  constructor(private readonly filePath: string) {}

  get resolvedPath(): string {
    return path.resolve(this.filePath);
  }

  async exists(): Promise<boolean> {
    try {
      await access(this.resolvedPath);
      return true;
    } catch {
      return false;
    }
  }

  async read(): Promise<RuntimeConfigSnapshot | null> {
    if (!(await this.exists())) {
      return null;
    }

    const content = await readFile(this.resolvedPath, 'utf8');
    return runtimeConfigSnapshotSchema.parse(JSON.parse(content));
  }

  async write(snapshot: RuntimeConfigSnapshot): Promise<void> {
    const directory = path.dirname(this.resolvedPath);
    await mkdir(directory, { recursive: true });
    const temporary = `${this.resolvedPath}.${randomUUID()}.pending`;
    try {
      const handle = await open(temporary, 'wx', 0o600);
      try {
        await handle.writeFile(JSON.stringify(snapshot, null, 2), 'utf8');
        await handle.sync();
      } finally {
        await handle.close();
      }
      await rename(temporary, this.resolvedPath);
      const parent = await open(directory, 'r');
      try {
        await parent.sync();
      } finally {
        await parent.close();
      }
    } finally {
      await unlink(temporary).catch(() => {});
    }
  }
}
