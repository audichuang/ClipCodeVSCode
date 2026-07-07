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

export async function* listFilesRecursive(
  inputPath: string,
  // 目錄級剪枝（回傳 false 就整棵子樹不走）。被 PATH exclude 規則命中的目錄，
  // 其下所有檔案必然也被同一規則排除，走完再逐檔過濾是純浪費 —
  // node_modules 這種大樹要在這裡就剪掉（對齊 IntelliJ 端 processDirectory 的行為）。
  shouldEnterDirectory?: (dirPath: string) => boolean
): AsyncGenerator<string> {
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

  if (shouldEnterDirectory && !shouldEnterDirectory(inputPath)) return;

  const entries = await readdir(inputPath);
  for (const entry of entries.sort()) {
    yield* listFilesRecursive(path.join(inputPath, entry), shouldEnterDirectory);
  }
}

export async function writeTextFile(filePath: string, content: string): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, content);
}

export async function deleteFile(filePath: string): Promise<void> {
  await unlink(filePath);
}
