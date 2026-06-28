import { lstat, mkdir, readFile, readdir, stat, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';

export async function pathExists(filePath: string): Promise<boolean> {
  try {
    await stat(filePath);
    return true;
  } catch {
    return false;
  }
}

export async function isDirectory(filePath: string): Promise<boolean> {
  try {
    return (await stat(filePath)).isDirectory();
  } catch {
    return false;
  }
}

export async function fileSize(filePath: string): Promise<number> {
  return (await stat(filePath)).size;
}

export async function readTextFile(filePath: string): Promise<string | undefined> {
  const bytes = await readFile(filePath);
  if (bytes.includes(0)) return undefined;
  return new TextDecoder('utf-8', { fatal: false }).decode(bytes);
}

export async function* listFilesRecursive(inputPath: string): AsyncGenerator<string> {
  const info = await lstat(inputPath).catch(() => undefined);
  if (!info) return;

  if (info.isSymbolicLink()) {
    const target = await stat(inputPath).catch(() => undefined);
    if (!target?.isDirectory()) yield inputPath;
    return;
  }

  if (!info.isDirectory()) {
    yield inputPath;
    return;
  }

  const entries = await readdir(inputPath);
  for (const entry of entries.sort()) {
    yield* listFilesRecursive(path.join(inputPath, entry));
  }
}

export async function writeTextFile(filePath: string, content: string): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, content);
}

export async function deleteFile(filePath: string): Promise<void> {
  await unlink(filePath);
}
