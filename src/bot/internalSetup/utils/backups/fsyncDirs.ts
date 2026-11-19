import { syncFolder, type ChainAnswer } from '../folderChain';

/** Each folder synced in the order given, one at a time; the first failed answer is the answer. */
export async function fsyncDirs(paths: readonly string[]): Promise<ChainAnswer> {
  for (const p of paths) {
    const answer = await syncFolder(p);
    if (answer.failed) return answer;
  }
  return { failed: false };
}
